import { describe, expect, test } from "bun:test";
import {
  isMemoTitleTooLongApiError,
  LEGACY_MEMO_TITLE_MAX_LENGTH,
  MAX_MEMO_TITLE_LENGTH,
  normalizeMemoTitleForApi,
} from "./src/memo-title-limits.ts";

describe("memo title limits", () => {
  test("normalizes whitespace and enforces max length", () => {
    expect(normalizeMemoTitleForApi("  hello   world  ", "fallback", 5)).toBe("hello");
    expect(normalizeMemoTitleForApi("", "fallback", MAX_MEMO_TITLE_LENGTH)).toBe("fallback");
  });

  test("detects Zod too_big errors for memo title", () => {
    const message = JSON.stringify([{
      origin: "string",
      code: "too_big",
      maximum: LEGACY_MEMO_TITLE_MAX_LENGTH,
      path: ["title"],
    }]);
    expect(isMemoTitleTooLongApiError(message)).toBe(true);
    expect(isMemoTitleTooLongApiError("unrelated error")).toBe(false);
  });
});
