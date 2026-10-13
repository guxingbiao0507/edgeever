/**
 * TipTap-free attachment detection helpers.
 *
 * The node-type constants, display-mode resolvers, and the pure
 * `isPdfAttachment` / `isFileAttachmentLink` predicates live here, apart from the
 * `@tiptap/core`-backed Node definitions in `./pdf-attachment` and
 * `./file-attachment`. This lets request handlers (for example the Cloudflare
 * Worker's resource and share routes) detect attachment kinds without pulling the
 * TipTap / ProseMirror graph into their startup bundle. The TipTap node modules
 * re-export these so existing import paths keep working.
 */
import { resolveAttachmentKind } from "./attachment-kind";
import { getAttachmentFilenameFromLabel } from "./resource-links";

export const PDF_ATTACHMENT_NODE_TYPE = "edgeeverPdfAttachment" as const;
export const PDF_DISPLAY_MODES = ["compact", "inline"] as const;
export type PdfDisplayMode = (typeof PDF_DISPLAY_MODES)[number];

export const resolvePdfDisplayMode = (value: unknown): PdfDisplayMode =>
  value === "inline" ? "inline" : "compact";

export const isPdfAttachment = (mimeType: string | null | undefined, filename: string | null | undefined) =>
  mimeType?.toLowerCase() === "application/pdf" || filename?.trim().toLowerCase().endsWith(".pdf") === true;

export const FILE_ATTACHMENT_NODE_TYPE = "edgeeverFileAttachment" as const;
export const FILE_DISPLAY_MODES = ["compact", "inline"] as const;
export type FileDisplayMode = (typeof FILE_DISPLAY_MODES)[number];

/** Video preview defaults to expanded so notes open ready to play. */
export const resolveFileDisplayMode = (value: unknown): FileDisplayMode =>
  value === "compact" ? "compact" : "inline";

const ATTACHMENT_LABEL_PATTERN = /^\s*(?:附件[：:]|Attachment:)\s*/i;
const RESOURCE_URL_PATTERN = /(?:\/api\/v1\/resources\/|edgeever-(?:resource|staged):\/\/)/i;

export const isFileAttachmentLink = (label: string, url: string) => {
  const filename = getAttachmentFilenameFromLabel(label) || label || url;
  if (resolveAttachmentKind(null, filename) === "pdf" || resolveAttachmentKind(null, url) === "pdf") {
    return false;
  }
  return ATTACHMENT_LABEL_PATTERN.test(label) || RESOURCE_URL_PATTERN.test(url) || resolveAttachmentKind(null, filename) !== "file";
};
