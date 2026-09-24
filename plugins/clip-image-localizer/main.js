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

const isExternalImageUrl = (raw) => {
  const src = raw.trim().replace(/^<|>$/g, "");
  if (!src) return false;
  if (INTERNAL_IMAGE_PREFIXES.some((prefix) => src.startsWith(prefix))) return false;
  try {
    const parsed = new URL(src, "https://edgeever.invalid");
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const collectExternalImageUrls = (markdown) => {
  const urls = new Set();
  const md = markdown || "";
  const markdownPattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match = markdownPattern.exec(md);
  while (match) {
    if (isExternalImageUrl(match[1])) urls.add(match[1].trim().replace(/^<|>$/g, ""));
    match = markdownPattern.exec(md);
  }
  const htmlPattern = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  match = htmlPattern.exec(md);
  while (match) {
    if (isExternalImageUrl(match[1])) urls.add(match[1].trim());
    match = htmlPattern.exec(md);
  }
  return [...urls];
};

const filenameFromUrl = (url) => {
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split("/").pop() || "image";
    const cleaned = base.replace(/[^\w.\-()+]/g, "_").slice(0, 120);
    if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(cleaned)) return cleaned;
    return `${cleaned || "image"}.jpg`;
  } catch {
    return "image.jpg";
  }
};

const guessMime = (url, headerType) => {
  const type = (headerType || "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) return type;
  const lower = url.toLowerCase();
  if (lower.includes(".png")) return "image/png";
  if (lower.includes(".webp")) return "image/webp";
  if (lower.includes(".gif")) return "image/gif";
  if (lower.includes(".svg")) return "image/svg+xml";
  return "image/jpeg";
};

const readSettings = async (context) => ({
  clipTag: String((await context.settings.get("clipTag")) || "web-clip").trim() || "web-clip",
  autoSyncDaily: (await context.settings.get("autoSyncDaily")) !== false,
  dailyCron: String((await context.settings.get("dailyCron")) || "0 3 * * *").trim() || "0 3 * * *",
  maxImagesPerRun: Math.min(Math.max(Number(await context.settings.get("maxImagesPerRun")) || 80, 1), 500),
  localizeOnClip: (await context.settings.get("localizeOnClip")) === true,
});

const readUrlCache = async (context) => {
  const raw = await context.storage.get(STORAGE_URL_CACHE);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  return {};
};

const writeUrlCache = async (context, cache) => {
  await context.storage.set(STORAGE_URL_CACHE, cache);
};

const downloadImage = async (context, url) => {
  const attempts = ["direct", "public"];
  let lastError = null;
  for (const transport of attempts) {
    try {
      const response = await context.network.fetch(url, {
        transport,
        method: "GET",
        credentials: "omit",
        redirect: "follow",
      });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      const buffer = await response.arrayBuffer();
      if (!buffer.byteLength) {
        lastError = new Error("Empty response");
        continue;
      }
      if (buffer.byteLength > MAX_PUBLIC_BYTES) {
        throw new Error(`Image exceeds ${MAX_PUBLIC_BYTES} bytes`);
      }
      const mimeType = guessMime(url, response.headers.get("content-type"));
      return { buffer, mimeType };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (transport === "public") break;
    }
  }
  throw lastError ?? new Error("Download failed");
};

const localizeNoteImages = async (context, noteId, options = {}) => {
  const { maxImages = 80, quiet = false } = options;
  const stats = { scanned: 0, uploaded: 0, skipped: 0, failed: 0, updated: false };
  const note = await context.notes.get(noteId);
  let markdown = note.contentMarkdown || "";
  const urls = collectExternalImageUrls(markdown);
  stats.scanned = urls.length;
  if (!urls.length) return stats;

  const cache = await readUrlCache(context);
  let budget = maxImages;

  for (const url of urls) {
    if (budget <= 0) {
      stats.skipped += 1;
      continue;
    }
    const cacheKey = `${noteId}\u0000${url}`;
    let localUrl = cache[cacheKey];
    if (!localUrl) {
      try {
        const { buffer, mimeType } = await downloadImage(context, url);
        const file = new File([buffer], filenameFromUrl(url), { type: mimeType });
        const resource = await context.resources.upload(noteId, file);
        localUrl = resource.url;
        cache[cacheKey] = localUrl;
        stats.uploaded += 1;
        budget -= 1;
      } catch (error) {
        stats.failed += 1;
        if (!quiet) {
          console.warn("[clip-image-localizer]", url, error);
        }
        continue;
      }
    } else {
      stats.skipped += 1;
    }
    if (markdown.includes(url)) {
      markdown = markdown.split(url).join(localUrl);
    }
  }

  if (markdown !== note.contentMarkdown) {
    await context.notes.update(noteId, { contentMarkdown: markdown });
    stats.updated = true;
  }
  await writeUrlCache(context, cache);
  return stats;
};

const runBatchSync = async (context, options = {}) => {
  const settings = await readSettings(context);
  const quiet = options.quiet === true;
  let offset = 0;
  let totals = { notes: 0, uploaded: 0, failed: 0, updated: 0 };
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
        quiet,
      });
      totals.uploaded += stats.uploaded;
      totals.failed += stats.failed;
      if (stats.updated) totals.updated += 1;
    }

    if (page.nextOffset == null) break;
    offset = page.nextOffset;
  }

  const message = quiet
    ? `Image sync: ${totals.updated} notes updated, ${totals.uploaded} uploaded, ${totals.failed} failed.`
    : `Synced clip images — ${totals.updated} notes updated, ${totals.uploaded} images uploaded${totals.failed ? `, ${totals.failed} failed` : ""}.`;
  if (!quiet || totals.uploaded || totals.updated) {
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
