import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename, relative, sep } from "node:path";
import { claudeProjectsDir } from "./paths.js";
import {
  getFileOffset,
  setFileOffset,
  insertUsageEvent,
  insertToolEvent,
  insertSession,
} from "./db.js";

// Prompt capture is the one place this tool would store prose rather than
// counts, so it's off unless you ask for it. A timesheet is a summary of what
// was done, not a transcript of how it was asked for, and by default the
// database holds nothing but paths and numbers.
const CAPTURE_PROMPTS = process.env.AITIMESHEET_PROMPTS === "1";

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

// The most useful single field from a tool call: which file, which command,
// which pattern. Kept short, and never the whole input blob.
function describeTarget(name, input) {
  if (!input || typeof input !== "object") return null;
  const first = (v) => (typeof v === "string" ? v.split("\n")[0].slice(0, 200) : null);

  if (input.file_path) return first(input.file_path);
  if (input.command) return first(input.command);
  if (input.pattern) return first(input.pattern);
  if (input.url) return first(input.url);
  if (input.query) return first(input.query);
  if (input.path) return first(input.path);
  if (name === "Agent" || name === "Task") return first(input.description);
  return null;
}

// A `user` line is not always something a person typed. Tool results come back
// on user lines, and so do hook output, slash-command expansions and injected
// reminders. Only genuine prose is a useful session title.
const NOISE_PREFIX =
  /^(caveat:|<command|<local-command|<user-prompt|<system-reminder|<bash-input|<bash-stdout)/i;

function userPrompt(entry) {
  if (entry.isMeta) return null;

  const content = entry.message?.content;
  let text = null;

  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    // tool_result blocks live here too; only text blocks are the person talking.
    const parts = content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text);
    if (parts.length) text = parts.join(" ");
  }
  if (!text) return null;

  const cleaned = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned || NOISE_PREFIX.test(cleaned)) return null;
  // Long enough to mean something, short enough to sit on one line of a report.
  if (cleaned.length < 3) return null;
  return cleaned.slice(0, 120);
}

function processLine(raw, ctx) {
  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    return; // partial or malformed line, skip it
  }

  if (entry.type === "user" && entry.message) {
    if (!CAPTURE_PROMPTS) return;
    const title = userPrompt(entry);
    if (!title) return;
    const ts = entry.timestamp || null;
    insertSession({
      session_id: ctx.sessionId,
      project: ctx.project,
      day: dayOf(ts),
      ts,
      title,
      is_subagent: ctx.isSubagent ? 1 : 0,
    });
    return;
  }

  if (entry.type !== "assistant" || !entry.message) return;

  const ts = entry.timestamp || entry.message?.timestamp;
  const day = dayOf(ts);

  // Claude Code splits one API message across several transcript lines, one per
  // content block, and repeats the identical usage object on every one of them.
  // message.id identifies the real message; the primary key on it means the
  // repeats collapse into a single row instead of multiplying the token count.
  const messageId = entry.message.id;
  const usage = entry.message.usage;
  if (usage && messageId) {
    insertUsageEvent({
      message_id: messageId,
      project: ctx.project,
      session_id: ctx.sessionId,
      day,
      ts: ts || null,
      model: entry.message.model || null,
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
      if (block.type !== "tool_use") continue;
      // Same story as usage: a repeated line repeats its tool_use blocks, and
      // tool_use.id is stable across those repeats.
      if (!block.id) continue;
      insertToolEvent({
        tool_use_id: block.id,
        message_id: messageId || null,
        project: ctx.project,
        session_id: ctx.sessionId,
        day,
        ts: ts || null,
        tool_name: block.name || "unknown",
        target: describeTarget(block.name, block.input),
        subagent_type: block.input?.subagent_type || null,
        is_subagent: ctx.isSubagent ? 1 : 0,
      });
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
