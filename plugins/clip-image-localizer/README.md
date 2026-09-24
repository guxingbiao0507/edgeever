# Clip Image Localizer

Downloads **external images** referenced in clipped notes into your EdgeEver instance **R2 storage**, then rewrites Markdown/HTML image URLs to local `/api/v1/resources/…/blob` paths so notes keep rendering when hotlinks break or block hotlinking.

## Features

- **Batch manual sync**: command *Sync clip images to storage* — scans notes with the `web-clip` tag (configurable).
- **Current note**: command *Sync images in current note* — only the open editor note.
- **Daily auto sync**:
  - **Desktop**: plugin schedule (default cron `0 3 * * *` UTC).
  - **Web**: about once per 24h while EdgeEver stays open.
- **Optional**: localize images in the background when a new clipped note is created.

Public-network downloads are capped at about **2 MB** per image (EdgeEver plugin policy).

## Install

1. In EdgeEver **Plugin Marketplace** or **Settings → Plugins**, choose install from manifest URL.
2. Point to an HTTPS `manifest.json` with CORS, for example:
   ```text
   https://raw.githubusercontent.com/<you>/edgeever/main/plugins/clip-image-localizer/manifest.json
   ```
3. Enable **Clip Image Localizer** and review settings (tag, schedule).

For local development, serve the `plugins/clip-image-localizer/` folder over HTTPS and use that manifest URL.

## Web Clipper

The browser clipper saves remote image URLs as-is; this plugin post-processes note content after clipping.

See [README.zh-CN.md](./README.zh-CN.md) for the Chinese guide.
