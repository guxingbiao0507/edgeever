/**
 * Lightweight, TipTap-free document helpers.
 *
 * These functions and types are intentionally kept free of any `@tiptap/*`
 * import so that consumers on hot code paths (for example the Cloudflare
 * Worker's request handlers) can use them without pulling the heavy
 * ProseMirror / TipTap graph — and its expensive module-load MarkdownManager
 * instantiation — into their startup bundle. Anything that needs to parse or
 * serialize Markdown (and therefore TipTap) lives in `./content` instead.
 */

export type TiptapTextNode = {
  type: "text";
  text: string;
  marks?: TiptapMark[];
};

export type TiptapMark = {
  type: string;
  attrs?: Record<string, unknown>;
};

export type TiptapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Array<TiptapNode | TiptapTextNode>;
};

export type TiptapDoc = {
  type: "doc";
  content: TiptapNode[];
};

export const DEFAULT_MEMO_TITLE = "无标题笔记";

export const resolveMergedMemoTitle = (
  inputTitle: string | null | undefined,
  sourceMemos: Array<{ title: string | null | undefined }>,
  date = new Date(),
) => {
  const explicitTitle = inputTitle?.trim();
  if (explicitTitle) {
    return explicitTitle;
  }

  const customTitle = sourceMemos
    .map((memo) => memo.title?.trim())
    .find((title): title is string => Boolean(title && title !== DEFAULT_MEMO_TITLE));
  return customTitle ?? `合并笔记 ${date.toLocaleDateString("zh-CN")}`;
};

export const emptyDoc = (): TiptapDoc => ({
  type: "doc",
  content: [{ type: "paragraph" }],
});

export const createExcerpt = (text: string, maxLength = 30): string => {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
};

export const normalizeTags = (tags: unknown): string[] => {
  if (!Array.isArray(tags)) {
    return [];
  }

  return Array.from(
    new Set(
      tags
        .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
        .filter(Boolean)
        .map((tag) => tag.replace(/^#/, ""))
    )
  ).slice(0, 24);
};
