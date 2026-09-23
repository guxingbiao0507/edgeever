#!/usr/bin/env bun

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { homedir } from "node:os";
import { XMLParser } from "fast-xml-parser";
import TurndownService from "turndown";
import { createHash } from "node:crypto";
import sharp from "sharp";

const CONFIG_PATH = process.env.EDGEEVER_CONFIG || join(homedir(), ".edgeever", "config.json");
const DEFAULT_URL = "http://127.0.0.1:8787";
const options = parseOptions(process.argv.slice(2));

const usage = `Import Evernote ENEX files into EdgeEver through MCP.

Usage:
  EDGEEVER_URL=https://your.edgeever.host EDGEEVER_TOKEN=... \\
    bun scripts/import-evernote-enex-via-mcp.mjs --input ./evernote-export

  bun scripts/import-evernote-enex-via-mcp.mjs --profile prod --input ./evernote-export --dry-run

Options:
  --input <path>       ENEX file or a directory containing one ENEX file per notebook.
  --profile <name>    Read URL and token from ~/.edgeever/config.json.
  --dry-run           Parse and print the plan without writing to EdgeEver.
  --yes               Import all notebooks without interactive confirmations.
  --include <names>   Comma-separated notebook/stack names to import (only these).
  --exclude <names>   Comma-separated notebook/stack names to exclude.
  --include-tag <tag> Only import notes containing this tag.
  --exclude-tag <tag> Exclude notes containing this tag.
`;

if (options.help || options.h) {
  console.log(usage);
  process.exit(0);
}

const inputPath = requireValue(options.input, "--input");
const dryRun = Boolean(options["dry-run"]);
const assumeYes = Boolean(options.yes);
const readline = assumeYes ? null : createInterface({ input, output });

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
} finally {
  readline?.close();
}

async function main() {
  const client = dryRun ? null : await createMcpClient(options.profile);
  let files = await listEnexFiles(inputPath);

  const includeList = options.include ? options.include.split(",").map((s) => s.trim().toLowerCase()) : null;
  const excludeList = options.exclude ? options.exclude.split(",").map((s) => s.trim().toLowerCase()) : null;

  if (includeList) {
    files = files.filter(
      (file) =>
        includeList.includes(notebookNameFromFile(file.filePath).toLowerCase()) ||
        (file.stackName && includeList.includes(file.stackName.toLowerCase()))
    );
  }

  if (excludeList) {
    files = files.filter(
      (file) =>
        !excludeList.includes(notebookNameFromFile(file.filePath).toLowerCase()) &&
        (!file.stackName || !excludeList.includes(file.stackName.toLowerCase()))
    );
  }

  if (files.length === 0) {
    throw new Error(`No .enex files found: ${inputPath}`);
  }

  console.log("Analyzing Evernote export files...");
  const notebooksInfo = await getNotebooksPlanInfo(files);
  printPlan(notebooksInfo);

  if (dryRun) {
    process.exit(0);
  }

  if (!assumeYes) {
    await confirmOrExit("Start importing the first notebook? Type yes to continue: ");
  }

  let importedNotebookCount = 0;
  let importedMemoCount = 0;

  for (const [index, fileInfo] of notebooksInfo.entries()) {
    const stackPrefix = fileInfo.stackName ? `[${fileInfo.stackName}] ` : "";
    console.log(`\n[${index + 1}/${notebooksInfo.length}] Importing notebook: ${stackPrefix}${fileInfo.name}`);

    // Parse the notes for this notebook only (releasing memory afterwards)
    let notes = await parseEnex(fileInfo.filePath);

    const excludeTag = options["exclude-tag"] ? options["exclude-tag"].toLowerCase() : null;
    const includeTag = options["include-tag"] ? options["include-tag"].toLowerCase() : null;

    if (excludeTag) {
      notes = notes.filter((note) => !note.tags.map((t) => t.toLowerCase()).includes(excludeTag));
    }

    if (includeTag) {
      notes = notes.filter((note) => note.tags.map((t) => t.toLowerCase()).includes(includeTag));
    }

    const before = await mcpCall(client, "list_notebooks", {});

    let parentId = null;
    if (fileInfo.stackName) {
      const parentNotebook = await findOrCreateNotebook(client, before.notebooks || [], fileInfo.stackName, index, null);
      parentId = parentNotebook.id;
    }

    const targetNotebook = await findOrCreateNotebook(client, before.notebooks || [], fileInfo.name, index, parentId);
    const beforeMemoCount = Number(targetNotebook.memoCount || 0);

    const createdMemoIds = [];
    let skippedMemoCount = 0;

    await mapLimit(notes, 5, async (note, memoIndex) => {
      const result = await mcpCall(client, "import_memos", {
        source: "evernote",
        notebookId: targetNotebook.id,
        items: [{
          externalId: note.externalId,
          title: note.title,
          contentMarkdown: note.markdown,
          tags: note.tags,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        }],
      });
      const imported = result.results?.[0];
      if (!imported || imported.status === "failed") {
        throw new Error(imported?.error || `No result returned while importing ${note.title || note.externalId}`);
      }
      if (imported.status === "skipped") {
        skippedMemoCount += 1;
        console.log(`  ${memoIndex + 1}/${notes.length} Skipped (already imported): ${note.title || "Untitled"}`);
        return;
      }
      if (imported.status !== "created" || !imported.memo) {
        throw new Error(`Unexpected import status "${imported.status}" for ${note.title || note.externalId}`);
      }

      assertImportedMemoTimestamps(imported.memo, note);

      // Handle resources (images / attachments) in parallel!
      let updatedMarkdown = note.markdown;
      let hasUploadedResources = false;

      if (note.resources && note.resources.length > 0) {
        const uploadPromises = note.resources.map(async (res) => {
          try {
            const processedRes = await compressImageLocal(res);
            console.log(`    Uploading resource: ${processedRes.filename} (${processedRes.mimeType})`);
            const resource = await uploadResource(client, imported.memo.id, processedRes);
            return { md5: res.md5, url: resource.url };
          } catch (err) {
            console.warn(`    [Warning] Failed to upload resource ${res.filename}: ${err.message}`);
            return null;
          }
        });

        const uploaded = (await Promise.all(uploadPromises)).filter(Boolean);
        for (const item of uploaded) {
          const placeholder = `evernote-resource:${item.md5}`;
          if (updatedMarkdown.includes(placeholder)) {
            updatedMarkdown = updatedMarkdown.replaceAll(placeholder, item.url);
            hasUploadedResources = true;
          }
        }
      }

      // Update markdown if placeholders were replaced
      if (hasUploadedResources) {
        try {
          await mcpCall(client, "update_memo", {
            memoId: imported.memo.id,
            contentMarkdown: updatedMarkdown,
            createdAt: note.createdAt,
            updatedAt: note.updatedAt,
          });
        } catch (err) {
          console.warn(`    [Warning] Failed to update memo content with resource URLs: ${err.message}`);
        }
      }

      createdMemoIds.push(imported.memo.id);
      console.log(`  ${memoIndex + 1}/${notes.length} ${note.title || "Untitled"}`);
    });

    const after = await mcpCall(client, "list_notebooks", {});
    const verifiedNotebook = (after.notebooks || []).find((item) => item.id === targetNotebook.id);
    const afterMemoCount = Number(verifiedNotebook?.memoCount || 0);
    const delta = afterMemoCount - beforeMemoCount;

    importedNotebookCount += 1;
    importedMemoCount += createdMemoIds.length;

    console.log(`\nNotebook imported: ${fileInfo.name}`);
    console.log(`  Created memos: ${createdMemoIds.length}`);
    console.log(`  Skipped memos: ${skippedMemoCount}`);
    console.log(`  Notebook memo count before: ${beforeMemoCount}`);
    console.log(`  Notebook memo count after:  ${afterMemoCount}`);

    if (delta !== createdMemoIds.length) {
      console.log(`  Warning: memo count delta is ${delta}, expected ${createdMemoIds.length}. Check for concurrent edits or retries.`);
    }

    if (!assumeYes && index < notebooksInfo.length - 1) {
      const answer = await readline.question("Review the result in EdgeEver. Continue with the next notebook? Type yes, or anything else to stop: ");

      if (answer.trim().toLowerCase() !== "yes") {
        console.log("Stopped by user confirmation.");
        break;
      }
    }
  }

  console.log(`\nDone. Imported notebooks: ${importedNotebookCount}; imported memos: ${importedMemoCount}.`);
}

async function getNotebooksPlanInfo(files) {
  const info = [];
  for (const file of files) {
    const xml = await readFile(file.filePath, "utf8");
    assertReadableEvernoteXml(xml, file.filePath);
    const noteCount = (xml.match(/<note[\s>]/ig) || []).length;

    info.push({
      name: notebookNameFromFile(file.filePath),
      stackName: file.stackName,
      filePath: file.filePath,
      noteCount,
    });
  }
  return info;
}

async function listEnexFiles(path) {
  if (path.toLowerCase().endsWith(".enex")) {
    return [{ filePath: path, stackName: null }];
  }

  if ((await stat(path)).isFile()) {
    throw new Error(`${path} is not an .enex file.`);
  }

  const files = await scanEnexFiles(path, path);
  return files.sort((a, b) => a.filePath.localeCompare(b.filePath, "zh-Hans-CN"));
}

async function scanEnexFiles(dir, baseDir) {
  const entries = await readdir(dir, { withFileTypes: true });
  let files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(await scanEnexFiles(fullPath, baseDir));
    } else if (entry.isFile() && isSupportedExportFile(entry.name)) {
      const relDir = relative(baseDir, dir);
      files.push({
        filePath: fullPath,
        stackName: relDir ? basename(relDir) : null,
      });
    }
  }

  return files;
}

async function parseEnex(filePath) {
  const xml = await readFile(filePath, "utf8");
  assertReadableEvernoteXml(xml, filePath);

  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: false,
    cdataPropName: "__cdata",
    isArray: (_, jpath) =>
      jpath === "en-export.note" ||
      jpath === "en-export.note.tag" ||
      jpath === "en-export.note.resource",
  });
  const parsed = parser.parse(xml);
  const notes = parsed?.["en-export"]?.note || [];

  return notes.map((note, index) => normalizeNote(note, index));
}

function isSupportedExportFile(filePath) {
  const normalized = filePath.toLowerCase();
  return normalized.endsWith(".enex");
}

function assertReadableEvernoteXml(xml, filePath) {
  if (/encoding\s*=\s*["']base64:aes["']/i.test(xml)) {
    throw new Error(
      `${filePath} is not a supported ENEX file. Export or convert your notes to .enex before importing.`
    );
  }

  if (!/<en-export[\s>]/i.test(xml) || !/<note[\s>]/i.test(xml)) {
    throw new Error(`${filePath} does not look like a readable Evernote XML export.`);
  }
}

function normalizeNote(note, index) {
  const title = getText(note.title)?.trim() || `Untitled ${index + 1}`;
  const content = getText(note.content) || "";
  const createdAt = enexDateToIso(getText(note.created));
  const updatedAt = enexDateToIso(getText(note.updated));
  const tags = Array.isArray(note.tag)
    ? note.tag.map((tag) => getText(tag)?.trim()).filter(Boolean)
    : [];

  if (!createdAt || !updatedAt) {
    throw new Error(`Note "${title}" is missing a valid Evernote created/updated timestamp.`);
  }

  const externalId = getText(note.guid)?.trim()
    || createHash("sha256").update([title, createdAt, updatedAt, content].join("\0")).digest("hex");

  let markdown = enexContentToMarkdown(content);
  const MAX_MARKDOWN_LENGTH = 400000; // Safe limit to prevent exceeding D1 1MB SQLITE_TOOBIG limit
  if (markdown.length > MAX_MARKDOWN_LENGTH) {
    markdown = markdown.slice(0, MAX_MARKDOWN_LENGTH) + "\n\n*(Note truncated during migration due to Cloudflare D1 1MB database limit)*";
    console.warn(`\n  [Warning] Note "${title}" truncated to ${MAX_MARKDOWN_LENGTH} chars (exceeded D1 limits).`);
  }

  const resources = [];
  if (note.resource) {
    const rawResources = Array.isArray(note.resource) ? note.resource : [note.resource];
    for (const res of rawResources) {
      const mimeType = getText(res.mime)?.trim() || "application/octet-stream";
      const dataBase64 = getText(res.data)?.replace(/\s+/g, "") || "";
      if (!dataBase64) continue;

      const attrs = res["resource-attributes"];
      const filename = getText(attrs?.["file-name"])?.trim() || `file_${resources.length}`;
      const md5 = createHash("md5").update(Buffer.from(dataBase64, "base64")).digest("hex");

      resources.push({
        dataBase64,
        mimeType,
        filename,
        md5,
      });
    }
  }

  return {
    externalId,
    title: title.slice(0, 50_000),
    markdown,
    tags,
    createdAt,
    updatedAt,
    resources,
  };
}

function assertImportedMemoTimestamps(memo, note) {
  if (memo.createdAt !== note.createdAt || memo.updatedAt !== note.updatedAt) {
    throw new Error(
      `Timestamp mismatch for "${note.title}". Expected createdAt=${note.createdAt}, updatedAt=${note.updatedAt}; got createdAt=${memo.createdAt}, updatedAt=${memo.updatedAt}.`
    );
  }
}

function enexContentToMarkdown(content) {
  let body = content
    .replace(/<\?xml[\s\S]*?\?>/i, "")
    .replace(/<!DOCTYPE[\s\S]*?>/i, "")
    .trim();

  // Prevent Turndown from stripping empty en-media elements
  body = body.replace(/<en-media([^>]*?)(?:\/>|>\s*<\/en-media>)/g, '<en-media$1>_</en-media>');

  const turndown = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
  });

  turndown.addRule("evernoteTodo", {
    filter: "en-todo",
    replacement: (_, node) => {
      const checked = node.getAttribute("checked") === "true" || node.getAttribute("checked") === "checked";
      return checked ? "[x] " : "[ ] ";
    },
  });

  turndown.addRule("evernoteCrypt", {
    filter: "en-crypt",
    replacement: () => "[Encrypted Evernote content]",
  });

  turndown.addRule("evernoteMedia", {
    filter: "en-media",
    replacement: (_, node) => {
      const type = node.getAttribute("type") || "attachment";
      const hash = node.getAttribute("hash") || "unknown";
      return type.startsWith("image/")
        ? `\n\n![Evernote image ${hash}](evernote-resource:${hash})\n\n`
        : `\n\n[Evernote attachment ${hash}](evernote-resource:${hash})\n\n`;
    },
  });

  return turndown
    .turndown(body || "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function findOrCreateNotebook(client, notebooks, name, index, parentId = null) {
  const existing = notebooks.find((notebook) => notebook.parentId === parentId && notebook.name === name);

  if (existing) {
    console.log(`Using existing notebook: ${name}`);
    return existing;
  }

  const result = await mcpCall(client, "create_notebook", {
    name: name.slice(0, 80),
    parentId,
    sortOrder: 1000 + index,
  });

  console.log(`Created notebook: ${result.notebook.name}`);
  return result.notebook;
}

async function createMcpClient(profileName) {
  const config = await readConfig();
  const profile = profileName ? config.profiles?.[profileName] : undefined;
  const baseUrl = (process.env.EDGEEVER_URL || profile?.url || DEFAULT_URL).replace(/\/+$/, "");
  const token = process.env.EDGEEVER_TOKEN || profile?.token;

  if (!token) {
    throw new Error("EDGEEVER_TOKEN is required, or configure a profile with `bun run cli -- profile set`.");
  }

  return { baseUrl, token, nextId: 1 };
}

async function mcpCall(client, toolName, args, retries = 5, delay = 1000) {
  const id = client.nextId++;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`${client.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${client.token}`,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args,
          },
        }),
      });

      const body = await response.json().catch(() => null);

      if (!response.ok || body?.error || body?.result?.isError) {
        const toolError = body?.result?.structuredContent?.error?.message
          || body?.result?.content?.find((item) => item.type === "text")?.text;
        throw new Error(toolError || body?.error?.message || `${response.status} ${response.statusText}`);
      }

      return parseMcpToolResult(body.result);
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      console.warn(`\n  [MCP Warning] Attempt ${attempt} failed: ${error.message}. Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2; // Exponential backoff
    }
  }
}

function parseMcpToolResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }

  const text = result?.content?.find((item) => item.type === "text")?.text;

  if (!text) {
    return result;
  }

  return JSON.parse(text);
}

async function compressImageLocal(res) {
  if (!res.mimeType.startsWith("image/") || res.mimeType === "image/gif") {
    return res;
  }

  try {
    const inputBuffer = Buffer.from(res.dataBase64, "base64");
    const pipeline = sharp(inputBuffer);
    const metadata = await pipeline.metadata();

    let needsResize = false;
    const maxEdge = 2560;
    let width = metadata.width;
    let height = metadata.height;

    if (width && height) {
      const currentMax = Math.max(width, height);
      if (currentMax > maxEdge) {
        needsResize = true;
        const scale = maxEdge / currentMax;
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
    }

    if (needsResize) {
      pipeline.resize(width, height, { fit: "inside" });
    }

    const outputBuffer = await pipeline.webp({ quality: 82 }).toBuffer();

    if (outputBuffer.byteLength < inputBuffer.byteLength) {
      const compressedBase64 = outputBuffer.toString("base64");
      const origExt = extname(res.filename);
      const newFilename = origExt
        ? res.filename.slice(0, -origExt.length) + ".webp"
        : res.filename + ".webp";

      console.log(`    [Local Compress] ${res.filename} (${(inputBuffer.byteLength / 1024).toFixed(1)}KB) -> ${newFilename} (${(outputBuffer.byteLength / 1024).toFixed(1)}KB)`);

      return {
        ...res,
        dataBase64: compressedBase64,
        mimeType: "image/webp",
        filename: newFilename,
      };
    }
  } catch (err) {
    console.warn(`    [Local Compress Warning] Failed to compress image ${res.filename}: ${err.message}`);
  }

  return res;
}

async function uploadResource(client, memoId, res, retries = 5, delay = 1000) {
  const formData = new FormData();
  const fileBlob = new Blob([Buffer.from(res.dataBase64, "base64")], { type: res.mimeType });
  formData.append("file", fileBlob, res.filename);

  const url = `${client.baseUrl}/api/v1/memos/${memoId}/resources`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${client.token}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${response.status} ${response.statusText} - ${errorText}`);
      }

      const body = await response.json();
      return body.resource;
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      console.warn(`\n  [Upload Warning] Attempt ${attempt} failed to upload ${res.filename}: ${error.message}. Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2; // Exponential backoff
    }
  }
}

async function readConfig() {
  try {
    const value = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

async function confirmOrExit(question) {
  const answer = await readline.question(question);

  if (answer.trim().toLowerCase() !== "yes") {
    console.log("Canceled.");
    process.exit(0);
  }
}

function printPlan(notebooksInfo) {
  const total = notebooksInfo.reduce((sum, item) => sum + item.noteCount, 0);

  console.log("Evernote import plan:");
  console.log(`  Notebooks: ${notebooksInfo.length}`);
  console.log(`  Notes:     ${total}`);

  for (const item of notebooksInfo) {
    const stackPrefix = item.stackName ? `[${item.stackName}] ` : "";
    console.log(`  - ${stackPrefix}${item.name}: ${item.noteCount} notes (${item.filePath})`);
  }
}

function getText(value) {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object") {
    return value.__cdata || value["#text"] || "";
  }

  return String(value);
}

function enexDateToIso(value) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value || "");

  if (!match) {
    return undefined;
  }

  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`;
}

function notebookNameFromFile(filePath) {
  return basename(filePath, extname(filePath)).trim().slice(0, 80) || "Evernote Import";
}

function parseOptions(args) {
  const parsed = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const next = args[index + 1];

    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }

    parsed[key] = next;
    index += 1;
  }

  return parsed;
}

function requireValue(value, name) {
  if (!value) {
    console.error(`${name} is required.\n`);
    console.error(usage);
    process.exit(1);
  }

  return value;
}

async function mapLimit(array, limit, fn) {
  const results = [];
  const executing = new Set();
  for (let i = 0; i < array.length; i++) {
    const item = array[i];
    const p = Promise.resolve().then(() => fn(item, i));
    results.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}
