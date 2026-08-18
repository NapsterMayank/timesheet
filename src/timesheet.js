import chalk from "chalk";
import { getRawEvents, getSummary } from "./db.js";

// ---------------------------------------------------------------------------
// The timesheet view: what got worked on, and roughly for how long.
//
// Everything else in this tool counts things. This file estimates time, which
// is a different kind of claim and deserves to be read sceptically:
//
//   - Wall clock from first to last event of a day is useless. A session left
//     open over lunch would bill the lunch. So time is summed gap by gap
//     between consecutive events, and any gap longer than the idle threshold
//     is dropped entirely rather than counted or clamped.
//   - What's left is *agent-active* time, not your time. The gaps that survive
//     include you reading a diff or thinking, which is usually what you want on
//     a timesheet, and also include you glancing at another window, which
//     isn't. Treat it as a well-grounded estimate to review, not a stopwatch.
//   - Time is attributed to the work item that was in flight when the gap
//     started, so a 4-minute pause after opening a file lands on that file.
// ---------------------------------------------------------------------------

const DEFAULT_IDLE_MINUTES = 15;

// Credit for the final event of a day, which has no following event to measure
// against. One minute is arbitrary but small enough not to distort a real day,
// and stops a single-event day from reporting 0m.
const TAIL_MS = 60_000;

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "NotebookRead"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "LS"]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell", "BashOutput", "KillShell"]);
const AGENT_TOOLS = new Set(["Agent", "Task", "Workflow", "Skill"]);

function toPosix(p) {
  return String(p).replace(/\\/g, "/");
}

function dirOf(p) {
  const n = toPosix(p);
  const i = n.lastIndexOf("/");
  return i === -1 ? "." : n.slice(0, i) || "/";
}

function baseOf(p) {
  const n = toPosix(p);
  const i = n.lastIndexOf("/");
  return i === -1 ? n : n.slice(i + 1);
}

// Session ids, temp dirs and content hashes carry no meaning on a timesheet
// and crowd out the segment that does, so they're dropped from the label.
const OPAQUE_SEGMENT = /^[0-9a-f]{8,}$|^[0-9a-f-]{16,}$/i;

// Keep the tail of a path, which is the part that identifies the work.
// "D:/personal/timesheet/src" -> "timesheet/src"
function shortDir(dir, segments = 2) {
  const parts = toPosix(dir)
    .split("/")
    .filter(Boolean)
    .filter((p) => !OPAQUE_SEGMENT.test(p));
  if (parts.length === 0) return toPosix(dir);
  if (parts.length <= segments) return parts.join("/");
  return parts.slice(-segments).join("/");
}

// A whole day collapsing into one "shell commands" line is technically true and
// practically worthless, so shell work splits by the program being run: git,
// npm, pytest. Wrappers and a leading `cd` are stepped over to reach the verb
// that actually describes the work.
const SHELL_WRAPPERS = new Set(["sudo", "npx", "uv", "uvx", "poetry", "pnpm", "yarn", "time", "env"]);

// Only verbs that describe work get their own line. `cat`, `ls`, `rm` and
// friends are how you get somewhere, not what you did, and breaking them out
// turns a day into twenty meaningless rows; they fall back to one shell line.
const SIGNAL_VERBS = new Set([
  "git", "npm", "pnpm", "yarn", "make", "docker", "docker-compose", "kubectl", "helm",
  "terraform", "ansible", "node", "deno", "bun", "python", "python3", "pip", "pytest",
  "vitest", "jest", "mocha", "playwright", "cypress", "cargo", "go", "rustc", "gradle",
  "mvn", "dotnet", "ruby", "rails", "bundle", "php", "composer", "psql", "mysql",
  "sqlite3", "redis-cli", "aws", "gcloud", "az", "fly", "vercel", "ssh", "curl",
]);

function shellVerb(command) {
  if (!command) return null;
  // "cd foo && npm test" is npm work, not cd work.
  const segments = String(command).split(/&&|\|\||;|\|/);
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && (tokens[i] === "cd" || SHELL_WRAPPERS.has(tokens[i]))) {
      i += tokens[i] === "cd" ? 2 : 1; // `cd` eats its argument, wrappers don't
    }
    const token = tokens[i];
    if (!token || token.startsWith("-")) continue;
    // Strip quoting and redirect debris so `>api.log"` never becomes a verb.
    const cleaned = token.replace(/^["'(]+/, "").replace(/["')]+$/, "");
    if (!cleaned || cleaned.includes("=")) continue;
    const verb = baseOf(cleaned).replace(/\.(exe|cmd|sh|ps1)$/i, "").toLowerCase();
    if (SIGNAL_VERBS.has(verb)) return verb;
  }
  return null;
}

// Which work item an event belongs to. File edits and reads group by directory,
// because a timesheet line is "worked on the scanner", not "opened db.js, then
// opened db.js again". Everything else groups by the kind of work it is.
function bucketOf(ev) {
  const name = ev.toolName;
  if (!name) return null; // usage-only event, inherits the current bucket

  if (FILE_TOOLS.has(name) && ev.target) {
    return { key: `dir:${dirOf(ev.target)}`, label: shortDir(dirOf(ev.target)), file: ev.target };
  }
  if (SHELL_TOOLS.has(name)) {
    const verb = shellVerb(ev.target);
    return verb
      ? { key: `shell:${verb}`, label: `${verb} commands` }
      : { key: "shell", label: "shell commands" };
  }
  if (SEARCH_TOOLS.has(name)) return { key: "search", label: "searching the codebase" };
  if (WEB_TOOLS.has(name)) return { key: "web", label: "web research" };
  if (AGENT_TOOLS.has(name)) {
    const what = ev.target ? ` (${ev.target.slice(0, 40)})` : "";
    return { key: "agent", label: `delegated work${what}` };
  }
  return { key: `tool:${name}`, label: name };
}

function fmtDuration(ms) {
  const totalMinutes = Math.round(ms / 60_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function fmtHours(ms) {
  return (ms / 3_600_000).toFixed(2);
}

function fmtClock(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Build one timesheet row per project per day.
 *
 * @returns rows of { day, project, activeMs, tasks, sessions, firstTs, lastTs,
 *                    totalTokens, items: [{ label, ms, calls, files }] }
 */
export function buildTimesheet({
  sinceDay,
  untilDay,
  project,
  idleMinutes = DEFAULT_IDLE_MINUTES,
} = {}) {
  const events = getRawEvents({ sinceDay, untilDay, project });
  const idleMs = Math.max(1, idleMinutes) * 60_000;

  // Tokens are already computed per project-day elsewhere; reuse rather than
  // re-aggregate so the timesheet can never disagree with the report.
  const tokenMap = new Map(
    getSummary({ sinceDay, untilDay }).map((r) => [`${r.day}::${r.project}`, r])
  );

  const groups = new Map();
  for (const ev of events) {
    const key = `${ev.day}::${ev.project}`;
    let g = groups.get(key);
    if (!g) {
      g = { day: ev.day, project: ev.project, events: [] };
      groups.set(key, g);
    }
    g.events.push(ev);
  }

  const rows = [];
  for (const g of groups.values()) {
    g.events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

    const items = new Map();
    const sessions = new Set();
    let activeMs = 0;
    let tasks = 0;
    let current = null; // last bucket seen, inherited by usage-only events

    const credit = (bucket, ms) => {
      if (!bucket) return;
      let item = items.get(bucket.key);
      if (!item) {
        item = { key: bucket.key, label: bucket.label, ms: 0, calls: 0, files: new Map() };
        items.set(bucket.key, item);
      }
      item.ms += ms;
    };

    for (let i = 0; i < g.events.length; i++) {
      const ev = g.events[i];
      sessions.add(ev.sessionId);

      const bucket = bucketOf(ev) || current;
      if (bucket) current = bucket;

      if (ev.toolName) {
        tasks++;
        if (bucket) {
          credit(bucket, 0); // make sure the item exists even with no time yet
          const item = items.get(bucket.key);
          item.calls++;
          if (bucket.file) {
            const name = baseOf(bucket.file);
            item.files.set(name, (item.files.get(name) || 0) + 1);
          }
        }
      }

      const next = g.events[i + 1];
      const gap = next
        ? new Date(next.ts).getTime() - new Date(ev.ts).getTime()
        : TAIL_MS;
      // A gap longer than the threshold is a break, not work. Dropped whole:
      // clamping it to the threshold would silently invent 15 minutes every
      // time you stepped away, which across a week is hours of fiction.
      if (Number.isFinite(gap) && gap >= 0 && gap <= idleMs) {
        activeMs += gap;
        credit(bucket, gap);
      }
    }

    const tokens = tokenMap.get(`${g.day}::${g.project}`);
    rows.push({
      day: g.day,
      project: g.project,
      activeMs,
      tasks,
      sessions: sessions.size,
      firstTs: g.events[0]?.ts || null,
      lastTs: g.events[g.events.length - 1]?.ts || null,
      totalTokens: tokens ? tokens.totalTokens : 0,
      items: [...items.values()]
        .sort((a, b) => b.ms - a.ms || b.calls - a.calls)
        .map((it) => ({
          label: it.label,
          ms: it.ms,
          calls: it.calls,
          files: [...it.files.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([name]) => name),
        })),
    });
  }

  return rows.sort((a, b) =>
    a.day < b.day ? 1 : a.day > b.day ? -1 : b.activeMs - a.activeMs
  );
}

export function printTimesheet(opts = {}) {
  const rows = buildTimesheet(opts);
  const idleMinutes = opts.idleMinutes ?? DEFAULT_IDLE_MINUTES;
  const maxItems = opts.maxItems ?? 8;

  if (rows.length === 0) {
    console.log(chalk.yellow("No Claude Code activity found for this range."));
    console.log(
      chalk.dim("Widen the range with --days N, or drop --project to see everything.")
    );
    return;
  }

  let grandMs = 0;
  let lastDay = null;

  for (const row of rows) {
    if (row.day !== lastDay) {
      if (lastDay !== null) console.log("");
      console.log(chalk.bold(row.day));
      lastDay = row.day;
    }
    grandMs += row.activeMs;

    const window =
      row.firstTs && row.lastTs ? chalk.dim(` ${fmtClock(row.firstTs)}-${fmtClock(row.lastTs)}`) : "";
    console.log(
      "  " +
        chalk.cyan(row.project.padEnd(28)) +
        chalk.bold(fmtDuration(row.activeMs).padStart(8)) +
        chalk.dim(`  ${row.tasks} tasks, ${row.sessions} runs`) +
        window
    );

    // Long days have a long tail of one-off work items. Showing every one of
    // them buries the lines that matter, so the tail is folded into a single
    // row. The CSV keeps the full breakdown.
    const shown = row.items.filter((it) => it.ms >= 30_000 || it.calls >= 3);
    const head = shown.slice(0, maxItems);
    const tail = shown.slice(maxItems);

    for (const item of head) {
      const files = item.files.length ? chalk.dim(`  ${item.files.join(", ")}`) : "";
      console.log(
        "    " +
          chalk.dim("- ") +
          fmtDuration(item.ms).padStart(6) +
          "  " +
          item.label +
          files
      );
    }
    if (tail.length) {
      const tailMs = tail.reduce((sum, it) => sum + it.ms, 0);
      console.log(
        "    " +
          chalk.dim("- ") +
          fmtDuration(tailMs).padStart(6) +
          "  " +
          chalk.dim(`${tail.length} smaller items`)
      );
    }
  }

  console.log("");
  console.log(
    chalk.dim(
      `${fmtDuration(grandMs)} of agent-active time across ${rows.length} project-day rows. ` +
        `Gaps over ${idleMinutes}m treated as breaks and excluded.`
    )
  );
  console.log(
    chalk.dim(
      "This is an estimate reconstructed from transcript timestamps, not a stopwatch. " +
        "Review before billing it to anyone."
    )
  );
}

// CSV, one line per work item, with the day/project total repeated on each so
// the file pivots cleanly in a spreadsheet.
export function timesheetCsv(opts = {}) {
  const rows = buildTimesheet(opts);
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const out = [
    ["date", "project", "day_hours", "task", "task_hours", "tool_calls", "files"].join(","),
  ];

  for (const row of rows) {
    if (row.items.length === 0) {
      out.push(
        [row.day, row.project, fmtHours(row.activeMs), "", "", 0, ""].map(esc).join(",")
      );
      continue;
    }
    for (const item of row.items) {
      out.push(
        [
          row.day,
          row.project,
          fmtHours(row.activeMs),
          item.label,
          fmtHours(item.ms),
          item.calls,
          item.files.join(" "),
        ]
          .map(esc)
          .join(",")
      );
    }
  }

  return out.join("\n");
}
