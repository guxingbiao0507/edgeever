import { describe, expect, test } from "bun:test";
import { MAX_MEMO_TITLE_LENGTH } from "@edgeever/shared";
import {
  getMarkdownFileTitle,
  isMarkdownFile,
  readMarkdownFile,
} from "./markdown-file-import.ts";

describe("Markdown file import", () => {
  test("accepts Markdown extensions case-insensitively", () => {
    expect(isMarkdownFile({ name: "notes.md" })).toBe(true);
    expect(isMarkdownFile({ name: "notes.MARKDOWN" })).toBe(true);
    expect(isMarkdownFile({ name: "notes.txt" })).toBe(false);
  });

  test("uses the filename without its extension as the note title", () => {
    expect(getMarkdownFileTitle(" docker install - setup.md ")).toBe("docker install - setup");
    expect(getMarkdownFileTitle(`${"a".repeat(MAX_MEMO_TITLE_LENGTH + 50)}.md`)).toHaveLength(MAX_MEMO_TITLE_LENGTH);
  });

  test("preserves Markdown content while removing a UTF-8 BOM", async () => {
    const result = await readMarkdownFile({
      name: "setup.md",
      text: async () => "\uFEFF# Setup\n\nKeep **all** Markdown.",
    });

    expect(result).toEqual({
      title: "setup",
      contentMarkdown: "# Setup\n\nKeep **all** Markdown.",
    });
  });
});
