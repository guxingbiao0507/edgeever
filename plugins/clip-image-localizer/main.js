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

const normalizeImageUrl = (raw, pageBaseUrl) => {
  let value = decodeHtmlEntities(String(raw || "").trim().replace(/^<|>$/g, ""));
  if (!value) return "";
  if (value.startsWith("//")) value = `https:${value}`;
  try {
    if (pageBaseUrl && !/^https?:\/\//i.test(value)) {
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
  if (INTERNAL_IMAGE_PREFIXES.some((prefix) => src.startsWith(prefix))) return false;
  try {
    const parsed = new URL(src);
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

const filenameFromUrl = (url) => {
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

const localizeNoteImages = async (context, noteId, options = {}) => {
  const { maxImages = 80, quiet = false } = options;
  const stats = { scanned: 0, uploaded: 0, skipped: 0, failed: 0, updated: false, samples: [] };
  const note = await context.notes.get(noteId);
  let markdown = note.contentMarkdown || "";
  const images = collectExternalImages(markdown);
  stats.scanned = images.length;
  if (!images.length) return stats;

  const cache = await readUrlCache(context);
  let budget = maxImages;

  for (const { raw, normalized } of images) {
    if (budget <= 0) {
      stats.skipped += 1;
      continue;
    }
    const cacheKey = `${noteId}\u0000${normalized}`;
    let localUrl = cache[cacheKey];
    if (!localUrl) {
      try {
        const { buffer, mimeType } = await downloadImage(context, normalized);
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
    if (markdown.includes(raw)) {
      markdown = markdown.split(raw).join(localUrl);
    }
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
          const stats = await localizeNoteImages(context, doc.noteId, {
            maxImages: (await readSettings(context)).maxImagesPerRun,
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
        await guardRun(() => localizeNoteImages(context, note.id, { maxImages: settings.maxImagesPerRun, quiet: true }));
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
