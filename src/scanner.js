import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename, relative, sep } from "node:path";
import { claudeProjectsDir } from "./paths.js";
import { getFileOffset, setFileOffset, insertUsageEvent, insertToolEvent } from "./db.js";

function walkJsonlFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // ~/.claude/projects doesn't exist yet, e.g. Claude Code never run
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkJsonlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

// ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
// ~/.claude/projects/<encoded-project-path>/<session-id>/subagents/<sub-id>.jsonl
function describeFile(projectsRoot, filePath) {
  const rel = relative(projectsRoot, filePath);
  const parts = rel.split(sep);
  const project = parts[0];
  const isSubagent = parts.includes("subagents");
  const sessionId = basename(filePath, ".jsonl");
  return { project, isSubagent, sessionId };
}

// Reads only the bytes appended since last scan, and only up through the
// last complete newline, so a line still being written is picked up next run.
function readNewLines(filePath, sinceOffset) {
  const size = statSync(filePath).size;
  if (size <= sinceOffset) return { lines: [], newOffset: sinceOffset };

  const fd = openSync(filePath, "r");
  const length = size - sinceOffset;
  const buf = Buffer.alloc(length);
  readSync(fd, buf, 0, length, sinceOffset);
  closeSync(fd);

  const text = buf.toString("utf8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) return { lines: [], newOffset: sinceOffset };

  const usable = text.slice(0, lastNewline);
  const lines = usable.split("\n").filter((l) => l.trim().length > 0);
  const newOffset = sinceOffset + Buffer.byteLength(text.slice(0, lastNewline + 1), "utf8");
  return { lines, newOffset };
}

function dayOf(ts) {
  if (!ts) return new Date().toISOString().slice(0, 10);
  return String(ts).slice(0, 10);
}

function processLine(raw, ctx) {
  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    return; // partial or malformed line, skip it
  }

  if (entry.type !== "assistant" || !entry.message) return;

  const ts = entry.timestamp || entry.message?.timestamp;
  const day = dayOf(ts);

  const usage = entry.message.usage;
  if (usage) {
    insertUsageEvent({
      project: ctx.project,
      session_id: ctx.sessionId,
      day,
      ts: ts || null,
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_read_tokens: usage.cache_read_input_tokens || 0,
      cache_creation_tokens: usage.cache_creation_input_tokens || 0,
      is_subagent: ctx.isSubagent ? 1 : 0,
    });
  }

  const content = entry.message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "tool_use") {
        insertToolEvent({
          project: ctx.project,
          session_id: ctx.sessionId,
          day,
          ts: ts || null,
          tool_name: block.name || "unknown",
          is_subagent: ctx.isSubagent ? 1 : 0,
        });
      }
    }
  }
}

export function scan() {
  const projectsRoot = claudeProjectsDir();
  const files = walkJsonlFiles(projectsRoot);
  let filesScanned = 0;
  let linesProcessed = 0;

  for (const filePath of files) {
    const sinceOffset = getFileOffset(filePath);
    const { lines, newOffset } = readNewLines(filePath, sinceOffset);
    if (lines.length === 0) continue;

    const ctx = describeFile(projectsRoot, filePath);
    for (const line of lines) {
      processLine(line, ctx);
      linesProcessed++;
    }
    setFileOffset(filePath, newOffset);
    filesScanned++;
  }

  return { filesFound: files.length, filesScanned, linesProcessed };
}
