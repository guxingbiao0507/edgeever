const INTERNAL_IMAGE_PREFIXES = [
  "/api/v1/resources/",
  "edgeever-resource://",
  "edgeever-staged://",
  "data:",
  "blob:",
];
const MAX_PUBLIC_BYTES = 2_000_000;
const STORAGE_LAST_AUTO = "lastAutoSyncAt";
const STORAGE_URL_CACHE = "urlResourceCache";
const SUPPORTED_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);
const FETCH_ACCEPT = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
const RESOURCE_BLOB_PATH = /\/api\/v1\/resources\/([A-Za-z0-9_]+)\/blob/i;

const decodeHtmlEntities = (value) => value
  .replace(/&amp;/gi, "&")
  .replace(/&quot;/gi, "\"")
  .replace(/&#39;/gi, "'")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">");

const extractPageBaseUrl = (markdown) => {
  const md = markdown || "";
  const labeled = md.match(/(?:来源|Source)[：:]\s*\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/i);
  if (labeled?.[1]) return labeled[1];
  const earlyLink = md.match(/^#[^\n]+\n+\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/m);
  if (earlyLink?.[1]) return earlyLink[1];
  const any = md.match(/\((https?:\/\/[^)\s]+)\)/);
  return any?.[1];
};

const toRelativeResourceUrl = (raw) => {
  const value = String(raw || "").trim();
  if (value.startsWith("/api/v1/resources/")) return value;
  const match = value.match(RESOURCE_BLOB_PATH);
  return match ? `/api/v1/resources/${match[1]}/blob` : null;
};

const repairMislinkedResourceUrls = (markdown) => {
  let next = markdown || "";
  next = next.replace(
    /https?:\/\/[^/)\s"']+\/api\/v1\/resources\/([A-Za-z0-9_]+)\/blob/gi,
    "/api/v1/resources/$1/blob",
  );
  return next;
};

const NON_IMAGE_PATH = /\.(?:html?|php|asp|aspx|jsp|htm)(\?|#|$)/i;
const DATA_IMAGE_PREFIX = /^data:image\//i;
const LAZY_SRC_ATTRS = ["data-src", "data-original", "data-lazy-src", "data-url", "data-actualsrc"];

const looksLikeNonImageUrl = (url) => {
  try {
    return NON_IMAGE_PATH.test(new URL(url).pathname);
  } catch {
    return NON_IMAGE_PATH.test(url);
  }
};

/** Fixes clip patterns like `[![alt](img)](page)` broken by inner image replacement. */
const repairBrokenLinkWrappedImages = (markdown) => {
  let next = markdown || "";
  const finalize = (alt, localUrl, pageUrl, originalUrl) => {
    let out = `![${alt}](${localUrl})`;
    if (originalUrl && originalUrl !== localUrl) out += `\n\n[原图](${originalUrl})`;
    if (pageUrl && pageUrl !== localUrl && pageUrl !== originalUrl) out += `\n\n[链接](${pageUrl})`;
    return out;
  };

  next = next.replace(
    /\[\s*\!\[([^\]]*)\]\((\/api\/v1\/resources\/[^)\s]+)\)\s*(?:\n+\[原图\]\([^)]+\))?\s*\n?\]\(([^)]+)\)/g,
    (_, alt, local, page) => finalize(alt, local, page, ""),
  );

  next = next.replace(
    /\[\s*\!\[([^\]]*)\]\(([^)\s]+)\)\s*\n+\[原图\]\(([^)]+)\)\s*\]\(([^)]+)\)/g,
    (_, alt, imgUrl, originalUrl, page) => finalize(alt, imgUrl, page, originalUrl),
  );

  next = next.replace(
    /\[\s*\!\[([^\]]*)\]\(([^)\s]+)\)\s*\]\(([^)]+)\)/g,
    (_, alt, imgUrl, page) => {
      if (!RESOURCE_BLOB_PATH.test(imgUrl) && !/^https?:\/\//i.test(imgUrl)) return _;
      if (imgUrl === page) return `![${alt}](${imgUrl})`;
      return finalize(alt, imgUrl, page, imgUrl);
    },
  );

  return next;
};

const isDataImageUrl = (value) => DATA_IMAGE_PREFIX.test(String(value || "").trim());

const readHtmlAttr = (attrs, name) => {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([^"']*)\\1`, "i"));
  return match ? match[2] : "";
};

const parseDataImageUrl = (dataUrl) => {
  const trimmed = String(dataUrl || "").trim();
  const headerMatch = trimmed.match(/^data:(image\/[^;,]+)(?:;charset=[^;,]+)?(?:;(base64))?,(.*)$/is);
  if (!headerMatch) return null;
  const mimeType = headerMatch[1].toLowerCase();
  const isBase64 = Boolean(headerMatch[2]);
  const payload = headerMatch[3];
  try {
    let bytes;
    if (isBase64) {
      const binary = atob(payload.replace(/\s/g, ""));
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(payload));
    }
    if (!bytes.byteLength) return null;
    if (bytes.byteLength > MAX_PUBLIC_BYTES) throw new Error(`Image exceeds ${MAX_PUBLIC_BYTES} bytes`);
    return { buffer: bytes.buffer, mimeType };
  } catch (error) {
    if (error instanceof Error && error.message.includes("exceeds")) throw error;
    return null;
  }
};

const isIgnorablePlaceholderDataImage = (buffer, mimeType) => {
  if (!buffer?.byteLength || buffer.byteLength > 4096) return false;
  const lowerMime = (mimeType || "").toLowerCase();
  if (!lowerMime.includes("svg")) return buffer.byteLength < 120;
  const text = new TextDecoder().decode(new Uint8Array(buffer).slice(0, 2500)).toLowerCase();
  const tiny =
    /width=['"]1(px)?['"]/.test(text)
    && /height=['"]1(px)?['"]/.test(text);
  const hidden =
    /fill-opacity=['"]0['"]/.test(text)
    || /opacity=['"]0['"]/.test(text)
    || /viewbox=['"]0 0 1 1['"]/.test(text);
  return tiny || (hidden && buffer.byteLength < 2800);
};

const isIgnorableDataImageUrl = (dataUrl) => {
  const parsed = parseDataImageUrl(dataUrl);
  if (!parsed) return false;
  return isIgnorablePlaceholderDataImage(parsed.buffer, parsed.mimeType);
};

/** Promote lazy-load real URLs; drop 1×1 data: SVG placeholders. */
const prepareDataAndLazyImages = (markdown) => {
  let next = markdown || "";

  next = next.replace(/<img\b([^>]*?)>/gi, (full, attrs) => {
    const src = readHtmlAttr(attrs, "src");
    const lazy = LAZY_SRC_ATTRS.map((name) => readHtmlAttr(attrs, name)).find((value) => /^https?:\/\//i.test(value));
    if (lazy) {
      const alt = readHtmlAttr(attrs, "alt");
      if (!src || isDataImageUrl(src) || isIgnorableDataImageUrl(src)) {
        return `\n\n![${alt}](${lazy})\n\n`;
      }
    }
    if (isDataImageUrl(src) && isIgnorableDataImageUrl(src)) return "";
    return full;
  });

  next = next.replace(/!\[([^\]]*)\]\((data:image[^)\s]+)\)/gi, (full, alt, dataUrl) => {
    if (isIgnorableDataImageUrl(dataUrl)) return "";
    return full;
  });

  return next;
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeImageUrl = (raw, pageBaseUrl) => {
  let value = decodeHtmlEntities(String(raw || "").trim().replace(/^<|>$/g, ""));
  if (!value) return "";
  const relativeResource = toRelativeResourceUrl(value);
  if (relativeResource) return relativeResource;
  if (value.startsWith("//")) value = `https:${value}`;
  try {
    if (pageBaseUrl && !/^https?:\/\//i.test(value) && !value.startsWith("/api/")) {
      value = new URL(value, pageBaseUrl).href;
    }
    const parsed = new URL(value);
    if (parsed.protocol === "http:") {
      parsed.protocol = "https:";
      value = parsed.href;
    }
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? value : "";
  } catch {
    return "";
  }
};

const isExternalImageUrl = (raw) => {
  const src = raw.trim();
  if (!src) return false;
  if (toRelativeResourceUrl(src)) return false;
  if (INTERNAL_IMAGE_PREFIXES.some((prefix) => src.startsWith(prefix))) return false;
  if (RESOURCE_BLOB_PATH.test(src)) return false;
  try {
    const parsed = new URL(src);
    if (RESOURCE_BLOB_PATH.test(parsed.pathname)) return false;
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const canUsePublicTransport = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (!parsed.port || parsed.port === "443");
  } catch {
    return false;
  }
};

const collectExternalImages = (markdown) => {
  const pageBaseUrl = extractPageBaseUrl(markdown);
  const md = markdown || "";
  const items = [];
  const seenRaw = new Set();

  const pushMatch = (raw) => {
    const trimmed = raw.trim().replace(/^<|>$/g, "");
    if (!trimmed || seenRaw.has(trimmed)) return;
    const normalized = normalizeImageUrl(trimmed, pageBaseUrl);
    if (!isExternalImageUrl(normalized)) return;
    if (looksLikeNonImageUrl(normalized)) return;
    seenRaw.add(trimmed);
    items.push({ raw: trimmed, normalized });
  };

  const markdownPattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match = markdownPattern.exec(md);
  while (match) {
    pushMatch(match[1]);
    match = markdownPattern.exec(md);
  }
  const htmlPattern = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  match = htmlPattern.exec(md);
  while (match) {
    pushMatch(match[1]);
    match = htmlPattern.exec(md);
  }
  return items;
};

const collectDataImages = (markdown) => {
  const items = [];
  const seenRaw = new Set();
  const md = markdown || "";

  const pushData = (raw) => {
    const trimmed = raw.trim();
    if (!trimmed || seenRaw.has(trimmed) || !isDataImageUrl(trimmed)) return;
    if (isIgnorableDataImageUrl(trimmed)) return;
    seenRaw.add(trimmed);
    items.push({ raw: trimmed, normalized: trimmed, source: "data" });
  };

  const markdownPattern = /!\[[^\]]*\]\((data:image[^)\s]+)\)/gi;
  let match = markdownPattern.exec(md);
  while (match) {
    pushData(match[1]);
    match = markdownPattern.exec(md);
  }
  const htmlPattern = /<img\b[^>]*\bsrc=["'](data:image[^"']+)["'][^>]*>/gi;
  match = htmlPattern.exec(md);
  while (match) {
    pushData(match[1]);
    match = htmlPattern.exec(md);
  }
  return items;
};

const filenameFromUrl = (url) => {
  if (isDataImageUrl(url)) {
    const parsed = parseDataImageUrl(url);
    if (parsed?.mimeType.includes("png")) return "embedded.png";
    if (parsed?.mimeType.includes("gif")) return "embedded.gif";
    if (parsed?.mimeType.includes("webp")) return "embedded.webp";
    if (parsed?.mimeType.includes("svg")) return "embedded.svg";
    return "embedded.jpg";
  }
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split("/").pop() || "image";
    const cleaned = base.replace(/[^\w.\-()+]/g, "_").slice(0, 120);
    if (/\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(cleaned)) return cleaned;
    return `${cleaned || "image"}.jpg`;
  } catch {
    return "image.jpg";
  }
};

const sniffImageMime = (buffer, url, headerType) => {
  const type = (headerType || "").split(";")[0].trim().toLowerCase();
  if (SUPPORTED_IMAGE_MIME.has(type)) return type;
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp";
  const lower = url.toLowerCase();
  if (lower.includes(".png")) return "image/png";
  if (lower.includes(".webp")) return "image/webp";
  if (lower.includes(".gif")) return "image/gif";
  if (lower.includes(".avif")) return "image/avif";
  return "image/jpeg";
};

const readSettings = async (context) => ({
  clipTag: String((await context.settings.get("clip-tag")) || "web-clip").trim() || "web-clip",
  autoSyncDaily: (await context.settings.get("auto-sync-daily")) !== false,
  dailyCron: String((await context.settings.get("daily-cron")) || "0 3 * * *").trim() || "0 3 * * *",
  maxImagesPerRun: Math.min(Math.max(Number(await context.settings.get("max-images-per-run")) || 80, 1), 500),
  localizeOnClip: (await context.settings.get("localize-on-clip")) === true,
  compressOverKb: Math.min(Math.max(Number(await context.settings.get("compress-over-kb")) || 600, 64), 1900),
  maxEdgePx: Math.min(Math.max(Number(await context.settings.get("max-edge-px")) || 2048, 640), 4096),
  keepOriginalLink: (await context.settings.get("keep-original-link")) !== false,
});

const readUrlCache = async (context) => {
  const raw = await context.storage.get(STORAGE_URL_CACHE);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  return {};
};

const writeUrlCache = async (context, cache) => {
  await context.storage.set(STORAGE_URL_CACHE, cache);
};

const fetchImageResponse = async (context, startUrl, transport) => {
  let url = startUrl;
  for (let hop = 0; hop < 8; hop += 1) {
    const response = await context.network.fetch(url, {
      transport,
      method: "GET",
      credentials: "omit",
      redirect: "manual",
      headers: { Accept: FETCH_ACCEPT },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") || response.headers.get("Location");
      if (!location) throw new Error(`HTTP ${response.status} redirect without Location`);
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { response, url };
  }
  throw new Error("Too many redirects");
};

const downloadImage = async (context, url) => {
  const transports = canUsePublicTransport(url) ? ["public", "direct"] : ["direct", "public"];
  let lastError = null;
  for (const transport of transports) {
    if (transport === "public" && !canUsePublicTransport(url)) continue;
    try {
      const { response } = await fetchImageResponse(context, url, transport);
      const buffer = await response.arrayBuffer();
      if (!buffer.byteLength) {
        lastError = new Error("Empty response");
        continue;
      }
      if (buffer.byteLength > MAX_PUBLIC_BYTES) {
        throw new Error(`Image exceeds ${MAX_PUBLIC_BYTES} bytes`);
      }
      const mimeType = sniffImageMime(buffer, url, response.headers.get("content-type"));
      if (!SUPPORTED_IMAGE_MIME.has(mimeType)) {
        throw new Error(`Unsupported type ${mimeType || "unknown"}`);
      }
      const preview = new TextDecoder().decode(new Uint8Array(buffer).slice(0, 200)).toLowerCase();
      if (preview.includes("<!doctype html") || preview.includes("<html")) {
        throw new Error("Received HTML instead of an image (hotlink or auth block)");
      }
      return { buffer, mimeType };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("Download failed");
};

const compressImageIfNeeded = async (buffer, mimeType, settings) => {
  const thresholdBytes = settings.compressOverKb * 1024;
  if (buffer.byteLength <= thresholdBytes && buffer.byteLength <= MAX_PUBLIC_BYTES) {
    return { buffer, mimeType };
  }
  if (mimeType === "image/gif") {
    if (buffer.byteLength <= MAX_PUBLIC_BYTES) return { buffer, mimeType };
    throw new Error("Animated GIF exceeds size limit; compress manually");
  }
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    if (buffer.byteLength <= MAX_PUBLIC_BYTES) return { buffer, mimeType };
    throw new Error(`Image exceeds ${MAX_PUBLIC_BYTES} bytes`);
  }
  const bitmap = await createImageBitmap(new Blob([buffer], { type: mimeType }));
  let width = bitmap.width;
  let height = bitmap.height;
  const maxEdge = settings.maxEdgePx;
  if (width > maxEdge || height > maxEdge) {
    if (width >= height) {
      height = Math.round((height * maxEdge) / width);
      width = maxEdge;
    } else {
      width = Math.round((width * maxEdge) / height);
      height = maxEdge;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("Canvas is unavailable for compression");
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const outputType = "image/jpeg";
  const qualities = [0.9, 0.82, 0.74, 0.66, 0.58];
  let best = null;
  for (const quality of qualities) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, outputType, quality));
    if (!blob) continue;
    if (!best || blob.size < best.size) best = { blob, mimeType: outputType };
    if (blob.size <= thresholdBytes && blob.size <= MAX_PUBLIC_BYTES) break;
  }
  if (!best) throw new Error("Compression failed");
  const outBuffer = await best.blob.arrayBuffer();
  if (outBuffer.byteLength > MAX_PUBLIC_BYTES) {
    throw new Error(`Image still exceeds ${MAX_PUBLIC_BYTES} bytes after compression`);
  }
  return { buffer: outBuffer, mimeType: best.mimeType };
};

const buildLocalizedImageBlock = (alt, localUrl, originalUrl, keepOriginalLink, outerHref) => {
  let out = `![${alt}](${localUrl})`;
  if (keepOriginalLink && originalUrl && originalUrl !== localUrl) out += `\n\n[原图](${originalUrl})`;
  if (outerHref && outerHref !== originalUrl && outerHref !== localUrl) out += `\n\n[链接](${outerHref})`;
  return out;
};

const applyLocalizedImage = (markdown, raw, localUrl, originalUrl, keepOriginalLink) => {
  const escaped = escapeRegExp(raw);
  const linkWrapped = new RegExp(
    `\\[\\s*(\\!\\[([^\\]]*)\\]\\(${escaped}(?:\\s+"[^"]*")?\\))\\s*\\]\\(([^)\\s]+)(?:\\s+"[^"]*")?\\)`,
    "g",
  );
  if (linkWrapped.test(markdown)) {
    linkWrapped.lastIndex = 0;
    return markdown.replace(linkWrapped, (_, _inner, alt, outerHref) =>
      buildLocalizedImageBlock(alt, localUrl, originalUrl, keepOriginalLink, outerHref),
    );
  }

  const markdownImage = new RegExp(`!\\[([^\\]]*)\\]\\(${escaped}(?:\\s+"[^"]*")?\\)`, "g");
  if (markdownImage.test(markdown)) {
    markdownImage.lastIndex = 0;
    return markdown.replace(markdownImage, (_, alt) =>
      buildLocalizedImageBlock(alt, localUrl, originalUrl, keepOriginalLink, ""),
    );
  }
  const htmlImage = new RegExp(`(<img\\b[^>]*\\bsrc=["'])${escaped}(["'][^>]*>)`, "gi");
  if (htmlImage.test(markdown)) {
    htmlImage.lastIndex = 0;
    return markdown.replace(
      htmlImage,
      `$1${localUrl}$2${keepOriginalLink && originalUrl ? `\n\n[原图](${originalUrl})` : ""}`,
    );
  }
  if (raw.startsWith("data:") && markdown.includes(raw)) {
    return markdown.split(raw).join(localUrl);
  }
  return markdown;
};

const loadImageBytes = async (context, item) => {
  if (item.source === "data") {
    const parsed = parseDataImageUrl(item.normalized);
    if (!parsed) throw new Error("Invalid data: image URL");
    let { buffer, mimeType } = parsed;
    if (!SUPPORTED_IMAGE_MIME.has(mimeType) && !mimeType.includes("svg")) {
      throw new Error(`Unsupported type ${mimeType || "unknown"}`);
    }
    if (mimeType.includes("svg")) {
      const text = new TextDecoder().decode(new Uint8Array(buffer).slice(0, 500)).toLowerCase();
      if (text.includes("<svg") && isIgnorablePlaceholderDataImage(buffer, mimeType)) {
        throw new Error("Tracking pixel SVG skipped");
      }
    }
    return { buffer, mimeType: mimeType.includes("svg") ? "image/svg+xml" : mimeType };
  }
  return downloadImage(context, item.normalized);
};

const localizeNoteImages = async (context, noteId, options = {}) => {
  const settings = options.settings ?? await readSettings(context);
  const { maxImages = settings.maxImagesPerRun, quiet = false } = options;
  const stats = { scanned: 0, uploaded: 0, skipped: 0, failed: 0, repaired: 0, updated: false, samples: [] };
  const note = await context.notes.get(noteId);
  let markdown = note.contentMarkdown || "";
  const prepared = prepareDataAndLazyImages(
    repairBrokenLinkWrappedImages(repairMislinkedResourceUrls(markdown)),
  );
  if (prepared !== markdown) {
    markdown = prepared;
    stats.repaired += 1;
  }
  const images = [
    ...collectExternalImages(markdown).map((item) => ({ ...item, source: "http" })),
    ...collectDataImages(markdown),
  ];
  stats.scanned = images.length;
  if (!images.length && !stats.repaired) return stats;

  const cache = await readUrlCache(context);
  let budget = maxImages;

  for (const item of images) {
    const { raw, normalized } = item;
    if (budget <= 0) {
      stats.skipped += 1;
      continue;
    }
    const cacheKey = `${noteId}\u0000${item.source}\u0000${normalized.slice(0, 120)}\u0000${normalized.length}`;
    let localUrl = cache[cacheKey];
    if (!localUrl) {
      try {
        let { buffer, mimeType } = await loadImageBytes(context, item);
        if (!mimeType.includes("svg")) {
          ({ buffer, mimeType } = await compressImageIfNeeded(buffer, mimeType, settings));
        }
        const file = new File([buffer], filenameFromUrl(normalized), { type: mimeType });
        const resource = await context.resources.upload(noteId, file);
        localUrl = resource.url;
        cache[cacheKey] = localUrl;
        stats.uploaded += 1;
        budget -= 1;
      } catch (error) {
        stats.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (stats.samples.length < 3) stats.samples.push(`${normalized.slice(0, 80)}: ${message}`);
        if (!quiet) console.warn("[clip-image-localizer]", normalized, error);
        continue;
      }
    } else {
      stats.skipped += 1;
    }
    markdown = applyLocalizedImage(
      markdown,
      raw,
      localUrl,
      normalized,
      item.source === "data" ? false : settings.keepOriginalLink,
    );
  }

  if (markdown !== note.contentMarkdown) {
    await context.notes.update(noteId, { contentMarkdown: markdown });
    stats.updated = true;
  }
  await writeUrlCache(context, cache);
  return stats;
};

const formatSyncSummary = (totals, statsSample) => {
  const base = `Synced clip images — ${totals.updated} notes updated, ${totals.uploaded} images uploaded`;
  if (!totals.failed) return `${base}.`;
  const hint = "Tip: use HTTPS sources, stay under 2MB, and open DevTools (F12) for details.";
  const sample = statsSample?.length ? ` Examples: ${statsSample.join("; ")}` : "";
  return `${base}, ${totals.failed} failed. ${hint}${sample}`;
};

const runBatchSync = async (context, options = {}) => {
  const settings = await readSettings(context);
  const quiet = options.quiet === true;
  let offset = 0;
  let totals = { notes: 0, uploaded: 0, failed: 0, updated: 0 };
  const failureSamples = [];
  const tag = settings.clipTag;

  while (true) {
    const page = await context.notes.queryContent({
      tags: [tag],
      limit: 50,
      offset,
      sort: "updated-desc",
    });
    if (!page.notes.length) break;

    for (const summary of page.notes) {
      totals.notes += 1;
      const stats = await localizeNoteImages(context, summary.id, {
        settings,
        maxImages: settings.maxImagesPerRun,
        quiet: true,
      });
      totals.uploaded += stats.uploaded;
      totals.failed += stats.failed;
      if (stats.updated) totals.updated += 1;
      for (const sample of stats.samples) {
        if (failureSamples.length < 3) failureSamples.push(sample);
      }
    }

    if (page.nextOffset == null) break;
    offset = page.nextOffset;
  }

  const message = quiet
    ? `Image sync: ${totals.updated} notes updated, ${totals.uploaded} uploaded, ${totals.failed} failed.`
    : formatSyncSummary(totals, failureSamples);
  if (!quiet || totals.uploaded || totals.updated || totals.failed) {
    context.ui.showNotice(message);
  }
  await context.storage.set(STORAGE_LAST_AUTO, String(Date.now()));
  return totals;
};

export default {
  async activate(context) {
    const settings = await readSettings(context);
    let webInterval = null;
    let running = false;

    const guardRun = async (runner) => {
      if (running) {
        context.ui.showNotice("Image sync is already running.");
        return;
      }
      running = true;
      try {
        await runner();
      } finally {
        running = false;
      }
    };

    context.commands.register({
      id: "sync-clip-images",
      title: "Sync clip images to storage",
      async run() {
        await guardRun(() => runBatchSync(context, { quiet: false }));
      },
    });

    context.commands.register({
      id: "sync-current-note-images",
      title: "Sync images in current note",
      async run() {
        await guardRun(async () => {
          const doc = await context.editor.getDocument();
          if (!doc?.noteId) {
            context.ui.showNotice("Open a note in the editor first.");
            return;
          }
          const currentSettings = await readSettings(context);
          const stats = await localizeNoteImages(context, doc.noteId, {
            settings: currentSettings,
            maxImages: currentSettings.maxImagesPerRun,
            quiet: false,
          });
          if (stats.updated) {
            context.ui.showNotice(`Localized ${stats.uploaded} image(s) in this note.`);
          } else if (stats.scanned === 0) {
            context.ui.showNotice("No external images found in this note.");
          } else if (stats.failed && !stats.uploaded) {
            context.ui.showNotice(formatSyncSummary(
              { updated: 0, uploaded: 0, failed: stats.failed },
              stats.samples,
            ));
          } else {
            context.ui.showNotice(`Done — ${stats.failed ? `${stats.failed} failed, ` : ""}${stats.skipped} skipped.`);
          }
        });
      },
    });

    if (settings.localizeOnClip) {
      context.events.on("note.created", async ({ note }) => {
        if (!note?.tags?.includes(settings.clipTag)) return;
        await guardRun(async () => {
          const currentSettings = await readSettings(context);
          return localizeNoteImages(context, note.id, {
            settings: currentSettings,
            maxImages: currentSettings.maxImagesPerRun,
            quiet: true,
          });
        });
      });
    }

    if (settings.autoSyncDaily) {
      try {
        await context.schedules.upsert({
          key: "daily-clip-image-sync",
          name: "Daily clip image localization",
          commandId: "sync-clip-images",
          cronExpression: settings.dailyCron,
          missedRunPolicy: "run-once",
        });
      } catch {
        const dayMs = 24 * 60 * 60 * 1000;
        const tick = async () => {
          const current = await readSettings(context);
          if (!current.autoSyncDaily) return;
          const last = Number(await context.storage.get(STORAGE_LAST_AUTO)) || 0;
          if (Date.now() - last < dayMs - 60_000) return;
          await guardRun(() => runBatchSync(context, { quiet: true }));
        };
        webInterval = setInterval(() => {
          void tick();
        }, 15 * 60 * 1000);
        void tick();
      }
    }

    return () => {
      if (webInterval) clearInterval(webInterval);
    };
  },
};
