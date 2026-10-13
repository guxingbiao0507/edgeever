import { MarkdownManager } from "@tiptap/markdown";
import {
  createEdgeEverDocumentExtensions,
  type CreateEdgeEverDocumentExtensionsOptions,
} from "./document-extensions";
import { MergeDivider, MERGE_DIVIDER_NODE_TYPE } from "./merge-divider";
import { PdfAttachment, PDF_ATTACHMENT_NODE_TYPE, upgradeStandalonePdfLinks } from "./pdf-attachment";
import { FileAttachment, FILE_ATTACHMENT_NODE_TYPE, upgradeStandaloneFileLinks } from "./file-attachment";
import {
  BLOCK_MATH_NODE_TYPE,
  createEdgeEverMarkdownMathematics,
  INLINE_MATH_NODE_TYPE,
} from "./mathematics-markdown";
import { projectNativeUnknownContentForMarkdown } from "./mobile-content-compatibility";
import { PluginEmbed, PLUGIN_EMBED_NODE_TYPE } from "./plugin-embed";
import { ImageGallery, IMAGE_GALLERY_NODE_TYPE, normalizeImageGalleries } from "./image-gallery";
import {
  emptyDoc,
  type TiptapDoc,
  type TiptapMark,
  type TiptapNode,
  type TiptapTextNode,
} from "./content-text";

// The TipTap-free document primitives (createExcerpt, normalizeTags, emptyDoc, …)
// are exported by the package barrel directly from "./content-text". They are NOT
// re-exported here: routing those bindings through this module would pull its heavy
// TipTap import graph into any consumer that only wanted the lightweight helpers.
// Only the shared document types are re-exported, for existing relative
// `import type { … } from "./content"` call sites (types are erased at build time).
export type { TiptapDoc, TiptapMark, TiptapNode, TiptapTextNode } from "./content-text";

export { PluginEmbed, PLUGIN_EMBED_NODE_TYPE, pluginEmbedToMarkdown, normalizePluginEmbedAttributes } from "./plugin-embed";
export type { PluginEmbedAttributes } from "./plugin-embed";

export {
  BLOCK_MATH_NODE_TYPE,
  INLINE_MATH_NODE_TYPE,
} from "./mathematics-markdown";

export {
  MergeDivider,
  MERGE_DIVIDER_MARKDOWN_MARKER,
  MERGE_DIVIDER_NODE_TYPE,
  mergeMemoDocs,
  createMergeDividerNode,
} from "./merge-divider";

export const createEdgeEverMarkdownManager = (
  options: CreateEdgeEverDocumentExtensionsOptions,
) => new MarkdownManager({
  extensions: createEdgeEverDocumentExtensions({
    ...options,
    markdown: true,
  }),
});

// Instantiating the MarkdownManager builds the full TipTap / ProseMirror schema
// (StarterKit, Table, Image, TaskList, Markdown, and every custom node). That is
// the dominant cold-start CPU cost for the Cloudflare Worker, so defer it until a
// Markdown parse/serialize is actually requested instead of running it at module
// evaluation time.
let markdownManagerSingleton: ReturnType<typeof createEdgeEverMarkdownManager> | null = null;

const getMarkdownManager = () => {
  if (!markdownManagerSingleton) {
    markdownManagerSingleton = createEdgeEverMarkdownManager({
      mathematics: createEdgeEverMarkdownMathematics(),
    });
  }
  return markdownManagerSingleton;
};

const PROTECTED_MARKDOWN_SEGMENT = /(```[\s\S]*?```|~~~[\s\S]*?~~~|\$\$[\s\S]*?\$\$)/g;

/**
 * CommonMark treats one or more blank lines as a single paragraph break, so two
 * visual blank lines disappear on parse. Expand those extra newlines into the
 * empty-paragraph spacing TipTap already understands, without touching fenced
 * code or display-math blocks.
 */
const expandExtraBlankLinesForParse = (markdown: string) =>
  markdown.split(PROTECTED_MARKDOWN_SEGMENT).map((segment) => {
    if (segment.startsWith("```") || segment.startsWith("~~~") || segment.startsWith("$$")) {
      return segment;
    }
    return segment.replace(/\n{3,}/g, (run) => "\n\n".repeat(run.length - 1));
  }).join("");

export const markdownToDoc = (markdown: string): TiptapDoc => {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  if (!normalized) {
    return emptyDoc();
  }

  return getMarkdownManager().parse(expandExtraBlankLinesForParse(normalized)) as TiptapDoc;
};

const docContainsNodeType = (doc: TiptapDoc, nodeType: string): boolean => {
  const visit = (nodes: TiptapNode[]): boolean => nodes.some((node) =>
    node.type === nodeType || (node.content ? visit(node.content as TiptapNode[]) : false)
  );

  return visit(doc.content);
};

/**
 * Recovers Markdown features that an older editor schema could not persist in
 * contentJson. The stored Markdown remains the compatibility source in that
 * case; otherwise the richer JSON document (for example image sizing attrs)
 * keeps precedence.
 */
export const resolveMemoContentDoc = (
  contentJson: TiptapDoc | null | undefined,
  contentMarkdown: string | null | undefined
): TiptapDoc => {
  const currentDoc = contentJson && Array.isArray(contentJson.content)
    ? normalizeImageGalleries(
        upgradeStandaloneFileLinks(upgradeStandalonePdfLinks(upgradeLegacyAttachmentLinks(contentJson))),
      )
    : emptyDoc();
  if (
    !contentMarkdown?.trim() ||
    docContainsNodeType(currentDoc, "table") ||
    docContainsNodeType(currentDoc, "taskList") ||
    docContainsNodeType(currentDoc, "edgeeverThemeBlock") ||
    docContainsNodeType(currentDoc, IMAGE_GALLERY_NODE_TYPE) ||
    docContainsNodeType(currentDoc, MERGE_DIVIDER_NODE_TYPE) ||
    docContainsNodeType(currentDoc, PLUGIN_EMBED_NODE_TYPE) ||
    docContainsNodeType(currentDoc, BLOCK_MATH_NODE_TYPE) ||
    docContainsNodeType(currentDoc, INLINE_MATH_NODE_TYPE)
    || docContainsNodeType(currentDoc, PDF_ATTACHMENT_NODE_TYPE)
    || docContainsNodeType(currentDoc, FILE_ATTACHMENT_NODE_TYPE)
  ) {
    return currentDoc;
  }

  const markdownDoc = markdownToDoc(contentMarkdown);
  // Some older saves left an empty JSON document behind while retaining the
  // real body in Markdown. Treat that as a compatibility case too; otherwise
  // the editor can show the Markdown body while list excerpts see an empty
  // JSON document. Also recover task lists and merge dividers when only Markdown
  // still retains their semantics.
  return docContainsNodeType(markdownDoc, "table")
    || docContainsNodeType(markdownDoc, "taskList")
    || docContainsNodeType(markdownDoc, MERGE_DIVIDER_NODE_TYPE)
    || docContainsNodeType(markdownDoc, BLOCK_MATH_NODE_TYPE)
    || docContainsNodeType(markdownDoc, INLINE_MATH_NODE_TYPE)
    || !docToText(currentDoc)
    ? markdownDoc
    : currentDoc;
};

const LEGACY_ATTACHMENT_PATTERN = /^(附件：|Attachment:\s*)(.+?)\s+(\/api\/v1\/resources\/\S+|https?:\/\/\S+)$/;

const isTiptapTextNode = (node: TiptapNode | TiptapTextNode): node is TiptapTextNode =>
  node.type === "text" && "text" in node;

/** Convert the first-generation plain-text attachment insertion into a link mark. */
const upgradeLegacyAttachmentLinks = (doc: TiptapDoc): TiptapDoc => {
  let changed = false;
  const visit = (node: TiptapNode | TiptapTextNode): TiptapNode | TiptapTextNode => {
    if (isTiptapTextNode(node)) {
      const match = node.text.match(LEGACY_ATTACHMENT_PATTERN);
      if (!match) {
        return node;
      }

      const existingMarks = node.marks ?? [];
      if (existingMarks.some((mark) => mark.type === "link")) {
        return node;
      }

      changed = true;
      return {
        ...node,
        text: `${match[1]}${match[2]}`,
        marks: [
          ...existingMarks,
          { type: "link", attrs: { href: match[3], target: "_blank", class: "edgeever-attachment-link" } },
        ],
      };
    }

    return node.content
      ? { ...node, content: node.content.map((child: TiptapNode | TiptapTextNode) => visit(child)) }
      : node;
  };

  const upgradedDoc = visit(doc) as TiptapDoc;
  return changed ? upgradedDoc : doc;
};

export const docToText = (doc: unknown): string => {
  const pieces: string[] = [];

  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") {
      return;
    }

    const current = node as { type?: unknown; text?: unknown; attrs?: Record<string, unknown>; content?: unknown };

    if (typeof current.text === "string") {
      pieces.push(current.text);
    }

    if (current.type === "image") {
      const label =
        getStringAttr(current.attrs, "alt") ||
        getStringAttr(current.attrs, "title") ||
        getStringAttr(current.attrs, "filename");

      if (label) {
        pieces.push(label);
      }
    }

    if (current.type === PDF_ATTACHMENT_NODE_TYPE || current.type === FILE_ATTACHMENT_NODE_TYPE) {
      const label = getStringAttr(current.attrs, "label");
      if (label) pieces.push(label);
    }

    if (current.type === BLOCK_MATH_NODE_TYPE || current.type === INLINE_MATH_NODE_TYPE) {
      const latex = getStringAttr(current.attrs, "latex");
      if (latex) {
        pieces.push(latex);
      }
    }

    if (Array.isArray(current.content)) {
      for (const child of current.content) {
        walk(child);
      }
    }
  };

  walk(doc);

  return pieces.join(" ").replace(/\s+/g, " ").trim();
};

let memoCharacterSegmenter: Intl.Segmenter | null | undefined;

const getMemoCharacterSegmenter = () => {
  if (memoCharacterSegmenter !== undefined) {
    return memoCharacterSegmenter;
  }

  memoCharacterSegmenter = typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

  return memoCharacterSegmenter;
};

/**
 * Counts visible memo-body characters while excluding whitespace. Formatting,
 * titles, tags, and image labels are intentionally not part of the count.
 */
export const countMemoCharacters = (doc: unknown): number => {
  const pieces: string[] = [];

  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") {
      return;
    }

    const current = node as { type?: unknown; text?: unknown; attrs?: Record<string, unknown>; content?: unknown };

    if (typeof current.text === "string") {
      pieces.push(current.text);
    }

    if (current.type === PDF_ATTACHMENT_NODE_TYPE || current.type === FILE_ATTACHMENT_NODE_TYPE) {
      const label = getStringAttr(current.attrs, "label");
      if (label) pieces.push(label);
    }

    if (Array.isArray(current.content)) {
      for (const child of current.content) {
        walk(child);
      }
    }
  };

  walk(doc);
  const text = pieces.join("");
  const segmenter = getMemoCharacterSegmenter();
  const characters = segmenter ? Array.from(segmenter.segment(text), ({ segment }) => segment) : Array.from(text);

  return characters.reduce((count, character) => count + (/^\s+$/u.test(character) ? 0 : 1), 0);
};

export const docToMarkdown = (doc: unknown): string => {
  if (!doc || typeof doc !== "object") {
    return "";
  }

  const root = doc as { content?: unknown };

  if (!Array.isArray(root.content)) {
    return "";
  }

  const serializableDoc = protectLiteralDollarPairs(projectNativeUnknownContentForMarkdown(
    stripEditorOnlyNodes(doc) as TiptapDoc
  ));
  const manager = getMarkdownManager();
  return manager
    .serialize(serializableDoc as Parameters<typeof manager.serialize>[0])
    .replaceAll(LITERAL_DOLLAR_PLACEHOLDER, "\\$");
};

const LITERAL_DOLLAR_PLACEHOLDER = "\uE000edgeever-dollar\uE001";

/** Preserve dollar pairs that are text rather than inline-math nodes. */
const protectLiteralDollarPairs = (value: unknown): unknown => {
  if (!value || typeof value !== "object") {
    return value;
  }

  const node = value as { type?: unknown; text?: unknown; content?: unknown };
  if (node.type === "text" && typeof node.text === "string") {
    const dollarCount = Array.from(node.text).filter((character) => character === "$").length;
    return dollarCount >= 2
      ? { ...node, text: node.text.replaceAll("$", LITERAL_DOLLAR_PLACEHOLDER) }
      : value;
  }

  return Array.isArray(node.content)
    ? { ...node, content: node.content.map(protectLiteralDollarPairs) }
    : value;
};

/**
 * Returns the best complete Markdown representation available for a memo.
 * Some older rich-editor saves populated contentJson while leaving the
 * Markdown compatibility copy empty, so merge/export callers must not trust
 * contentMarkdown alone.
 */
export const resolveMemoContentMarkdown = (
  contentJson: TiptapDoc | null | undefined,
  contentMarkdown: string | null | undefined,
) => docToMarkdown(resolveMemoContentDoc(contentJson, contentMarkdown));

/**
 * Theme blocks are richer editor-only nodes. Markdown has no portable equivalent,
 * so exports keep their text as a quoted section instead of silently dropping it.
 */
const stripEditorOnlyNodes = (doc: unknown): unknown => {
  if (!doc || typeof doc !== "object") {
    return doc;
  }

  const node = doc as { type?: unknown; attrs?: Record<string, unknown>; content?: unknown };
  if (node.type === "edgeeverThemeBlock") {
    const label = getStringAttr(node.attrs, "kind");
    const content = Array.isArray(node.content) ? node.content : [];
    return {
      type: "blockquote",
      content: [
        { type: "paragraph", content: [{ type: "text", text: label ? `[${label}]` : "[主题化组件]" }] },
        ...content.map(stripEditorOnlyNodes),
      ],
    };
  }

  if (!Array.isArray(node.content)) {
    return doc;
  }

  return { ...node, content: node.content.map(stripEditorOnlyNodes) };
};

const getStringAttr = (attrs: Record<string, unknown> | undefined, key: string) => {
  const value = attrs?.[key];
  return typeof value === "string" ? value.trim() : "";
};

