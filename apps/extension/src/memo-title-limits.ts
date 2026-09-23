/** Matches `packages/shared/src/memo-limits.ts` on deployed EdgeEver instances. */
export const MAX_MEMO_TITLE_LENGTH = 50_000;

/** Older instances (before memo title limit increase) still enforce this cap. */
export const LEGACY_MEMO_TITLE_MAX_LENGTH = 160;

export const normalizeMemoTitleForApi = (title: string, fallback: string, maxLength: number) => {
  const compact = title.replace(/\s+/g, " ").trim();
  return compact.slice(0, maxLength) || fallback;
};

export const isMemoTitleTooLongApiError = (message: string) => {
  const trimmed = message.trim();
  if (!trimmed.startsWith("[")) {
    return /"code"\s*:\s*"too_big"[\s\S]*"path"\s*:\s*\[\s*"title"/.test(trimmed);
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return false;
    return parsed.some((issue) =>
      issue
      && typeof issue === "object"
      && (issue as { code?: string }).code === "too_big"
      && Array.isArray((issue as { path?: unknown }).path)
      && (issue as { path: unknown[] }).path[0] === "title");
  } catch {
    return false;
  }
};
