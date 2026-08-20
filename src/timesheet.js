import chalk from "chalk";
import { getRawEvents, getSummary, getSessionTitles, getProjectPaths } from "./db.js";
import { commitsInRange } from "./git.js";

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

// What kind of work a file belongs to, judged by where it lives and what it is.
// Order matters: a test file under components/ is testing, not frontend, and a
// .yml under .github/ is deployment, not config.
//
// Paths are strong evidence and this stays deliberately on the safe side of
// them. Nothing here guesses at *intent* — a transcript cannot tell a new
// endpoint from a fixed one, and a timesheet that confidently mislabels work is
// worse than one that says "Code changes".
const LAYERS = [
  {
    key: "tests",
    label: "Testing",
    test: (p) => /(^|\/)(__tests__|tests?|spec|e2e)\//i.test(p) || /\.(test|spec)\.[a-z]+$/i.test(p),
  },
  {
    key: "docs",
    label: "Documentation",
    test: (p) => /\.(md|mdx|rst|adoc)$/i.test(p) || /(^|\/)docs?\//i.test(p),
  },
  {
    key: "infra",
    label: "Infrastructure & deployment",
    test: (p) =>
      /(^|\/)(\.github|\.gitlab|k8s|kubernetes|deploy|infra|terraform|ansible|helm)\//i.test(p) ||
      /(dockerfile[^/]*|docker-compose\.ya?ml|\.tf|\.tfvars|jenkinsfile)$/i.test(p),
  },
  {
    key: "db",
    label: "Database & migrations",
    test: (p) => /(^|\/)(migrations?|prisma|seeds?)\//i.test(p) || /\.(sql|prisma)$/i.test(p),
  },
  {
    key: "frontend",
    label: "Frontend work",
    test: (p) =>
      /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html)$/i.test(p) ||
      /(^|\/)(components?|pages|views|screens|styles|ui)\//i.test(p),
  },
  {
    key: "backend",
    label: "Backend work",
    test: (p) =>
      /\.(py|go|rb|php|java|rs|cs|ex|exs|scala|kt|swift)$/i.test(p) ||
      /(^|\/)(api|server|routes?|controllers?|models?|services?|handlers?|middleware|jobs?|workers?)\//i.test(
        p
      ),
  },
  {
    key: "config",
    label: "Project configuration",
    test: (p) =>
      /(package\.json|package-lock\.json|tsconfig[^/]*\.json|\.eslintrc[^/]*|\.prettierrc[^/]*|\.env[^/]*|\.ya?ml|\.toml|\.ini|\.cfg)$/i.test(
        p
      ),
  },
];

function classifyPath(path) {
  const p = toPosix(path);
  for (const layer of LAYERS) if (layer.test(p)) return layer;
  return { key: "code", label: "Code changes" };
}

// Shell verbs, grouped into activities a non-engineer can read. `npm` and `pip`
// are the same line on a timesheet even though they aren't the same tool.
const SHELL_ACTIVITY = {
  "Version control": ["git"],
  "Builds & dependencies": [
    "npm", "pnpm", "yarn", "make", "pip", "bundle", "composer", "cargo", "go",
    "mvn", "gradle", "dotnet",
  ],
  "Running tests": ["pytest", "vitest", "jest", "mocha", "playwright", "cypress"],
  "Infrastructure & deployment": [
    "docker", "docker-compose", "kubectl", "helm", "terraform", "ansible",
    "aws", "gcloud", "az", "fly", "vercel",
  ],
  "Database & migrations": ["psql", "mysql", "sqlite3", "redis-cli"],
  "Running the app": ["node", "deno", "bun", "python", "python3", "ruby", "rails", "php", "rustc"],
  "API calls & debugging": ["curl", "ssh"],
};

const VERB_ACTIVITY = new Map();
for (const [label, verbs] of Object.entries(SHELL_ACTIVITY)) {
  for (const v of verbs) VERB_ACTIVITY.set(v, label);
}

// Which work item an event belongs to. File work groups by what kind of work it
// is rather than by directory, so a timesheet line reads "Backend work" instead
// of "repo/src/api". The files and commands themselves survive as evidence in
// the detail column, so an engineer can still see exactly what was touched.
function bucketOf(ev) {
  const name = ev.toolName;
  if (!name) return null; // usage-only event, inherits the current bucket

  if (FILE_TOOLS.has(name) && ev.target) {
    const layer = classifyPath(ev.target);
    return { key: `layer:${layer.key}`, label: layer.label, evidence: baseOf(ev.target) };
  }
  if (SHELL_TOOLS.has(name)) {
    const verb = shellVerb(ev.target);
    const label = verb ? VERB_ACTIVITY.get(verb) : null;
    if (label) return { key: `act:${label}`, label, evidence: verb };
    return { key: "shell", label: "Shell commands", evidence: verb || null };
  }
  if (SEARCH_TOOLS.has(name)) return { key: "search", label: "Reading & investigating" };
  if (WEB_TOOLS.has(name)) return { key: "web", label: "Research" };
  if (AGENT_TOOLS.has(name)) {
    return { key: "agent", label: "Delegated to sub-agents", evidence: ev.target || null };
  }
  return { key: `tool:${name}`, label: name };
}

export function fmtDuration(ms) {
  // Under a minute, show seconds. Rounding a 40 second item to "0m" makes a
  // real piece of work look like nothing happened.
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalMinutes = Math.round(ms / 60_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function fmtHours(ms) {
  return (ms / 3_600_000).toFixed(2);
}

function fmtTokens(n) {
  if (!n) return "";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M tok";
  if (n >= 1000) return Math.round(n / 1000) + "K tok";
  return n + " tok";
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
  overlap = "split",
  git = true,
} = {}) {
  const events = getRawEvents({ sinceDay, untilDay, project });
  const idleMs = Math.max(1, idleMinutes) * 60_000;

  // Tokens are already computed per project-day elsewhere; reuse rather than
  // re-aggregate so the timesheet can never disagree with the report.
  const tokenMap = new Map(
    getSummary({ sinceDay, untilDay }).map((r) => [`${r.day}::${r.project}`, r])
  );

  // What was asked for, in your own words. Classification says what kind of
  // work it was; this says what the work was actually about, and it's the one
  // part that needs no inference at all.
  //
  // Keyed by session rather than by date: a session that runs past midnight is
  // still about the same thing on the far side of it, and keying on the day it
  // started would leave the next morning blank.
  // Deliberately unfiltered by date: a session that started before the range
  // still explains the work inside it. One row per session, so it stays cheap.
  const titleMap = new Map(getSessionTitles({ project }).map((s) => [s.sessionId, s.title]));

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

  // Pass one: turn each project-day into intervals of worked time. Nothing is
  // totalled yet, because a minute's worth depends on what the other projects
  // were doing at the same moment.
  for (const g of groups.values()) {
    g.events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

    g.items = new Map();
    g.intervals = [];
    g.sessions = new Set();
    g.tasks = 0;
    let current = null; // last bucket seen, inherited by usage-only events

    const itemFor = (bucket) => {
      let item = g.items.get(bucket.key);
      if (!item) {
        item = {
          key: bucket.key,
          label: bucket.label,
          ms: 0,
          tokens: 0,
          calls: 0,
          files: new Map(),
          commits: [],
        };
        g.items.set(bucket.key, item);
      }
      return item;
    };

    for (let i = 0; i < g.events.length; i++) {
      const ev = g.events[i];
      g.sessions.add(ev.sessionId);

      const bucket = bucketOf(ev) || current;
      if (bucket) current = bucket;

      // Tokens attach to the work item the same way time does, including the
      // tokens of a message that fired no tools at all — those land on whatever
      // was in flight, rather than vanishing from the breakdown.
      if (ev.tokens && bucket) itemFor(bucket).tokens += ev.tokens;

      if (ev.toolName) {
        g.tasks++;
        if (bucket) {
          const item = itemFor(bucket);
          item.calls++;
          if (bucket.evidence) {
            item.files.set(bucket.evidence, (item.files.get(bucket.evidence) || 0) + 1);
          }
        }
      }

      const start = new Date(ev.ts).getTime();
      const next = g.events[i + 1];
      const gap = next ? new Date(next.ts).getTime() - start : TAIL_MS;
      // A gap longer than the threshold is a break, not work. Dropped whole:
      // clamping it to the threshold would silently invent 15 minutes every
      // time you stepped away, which across a week is hours of fiction.
      if (!Number.isFinite(start) || !Number.isFinite(gap) || gap < 0 || gap > idleMs) continue;
      if (bucket) itemFor(bucket); // exists even if it ends up with no time
      g.intervals.push({
        start,
        end: start + gap,
        group: g,
        itemKey: bucket ? bucket.key : null,
        credited: 0,
      });
    }
  }

  // Pass two: share out any wall-clock minute that two projects both claim.
  //
  // Within a project this can't happen, because every session and subagent for
  // that project merges into one sorted timeline first. Across projects it very
  // much can: work on two clients in the same hour and, counted naively, that
  // hour bills twice. A six hour day reporting nine hours is worse than useless
  // to the exact person this command is for, so overlapping time is divided
  // evenly between the projects holding it.
  const splitOverlap = overlap === "split";
  const byDay = new Map();
  for (const g of groups.values()) {
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push(...g.intervals);
  }
  for (const intervals of byDay.values()) {
    if (!splitOverlap) {
      for (const iv of intervals) iv.credited = iv.end - iv.start;
      continue;
    }
    shareOverlappingTime(intervals);
  }

  // Commits that landed in the range, per project, keyed by day. Asked for once
  // per project rather than once per day, because spawning git is the expensive
  // part and one log covers the whole window.
  const commitsByDay = new Map();
  if (git !== false) {
    const paths = getProjectPaths();
    const days = [...groups.values()].map((g) => g.day).sort();
    for (const [proj, repoPath] of paths) {
      if (project && proj !== project) continue;
      if (![...groups.values()].some((g) => g.project === proj)) continue;
      for (const commit of commitsInRange(repoPath, {
        sinceDay: days[0],
        untilDay: days[days.length - 1],
      })) {
        const key = `${commit.day}::${proj}`;
        if (!commitsByDay.has(key)) commitsByDay.set(key, []);
        commitsByDay.get(key).push(commit);
      }
    }
  }

  const rows = [];
  for (const g of groups.values()) {
    let activeMs = 0;
    let rawMs = 0;
    for (const iv of g.intervals) {
      activeMs += iv.credited;
      rawMs += iv.end - iv.start;
      if (iv.itemKey !== null) g.items.get(iv.itemKey).ms += iv.credited;
    }

    // Hang each commit off the work items its files belong to, so "Backend
    // work" can carry "fix: null deref in checkout". A commit touching both
    // API and UI files legitimately shows up on both lines: it was both.
    const dayCommits = commitsByDay.get(`${g.day}::${g.project}`) || [];
    for (const commit of dayCommits) {
      const layers = new Set(commit.files.map((f) => `layer:${classifyPath(f).key}`));
      for (const key of layers) {
        const item = g.items.get(key);
        if (item) item.commits.push(commit);
      }
    }

    const tokens = tokenMap.get(`${g.day}::${g.project}`);
    rows.push({
      day: g.day,
      project: g.project,
      activeMs,
      // How much of this row was shared with another project running at the
      // same time. Zero on a normal single-project day.
      overlapMs: rawMs - activeMs,
      tasks: g.tasks,
      sessions: g.sessions.size,
      firstTs: g.events[0]?.ts || null,
      lastTs: g.events[g.events.length - 1]?.ts || null,
      totalTokens: tokens ? tokens.totalTokens : 0,
      titles: [...g.sessions].map((id) => titleMap.get(id)).filter(Boolean),
      commits: dayCommits,
      items: [...g.items.values()]
        .sort((a, b) => b.ms - a.ms || b.calls - a.calls)
        .map((it) => ({
          label: it.label,
          ms: it.ms,
          tokens: Math.round(it.tokens),
          calls: it.calls,
          commits: it.commits.map((c) => c.subject),
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

// Sweep the day's intervals and give each slice of time to whoever holds it,
// divided by how many projects hold it at once. Intervals belonging to the same
// project never overlap each other, so the number of live intervals over a
// slice is the number of projects competing for it.
function shareOverlappingTime(intervals) {
  const bounds = [...new Set(intervals.flatMap((iv) => [iv.start, iv.end]))].sort((a, b) => a - b);
  const byStart = [...intervals].sort((a, b) => a.start - b.start);

  let next = 0;
  const live = new Set();

  for (let i = 0; i < bounds.length - 1; i++) {
    const from = bounds[i];
    const to = bounds[i + 1];

    while (next < byStart.length && byStart[next].start <= from) live.add(byStart[next++]);
    for (const iv of live) if (iv.end <= from) live.delete(iv);
    if (live.size === 0) continue;

    const share = (to - from) / live.size;
    for (const iv of live) iv.credited += share;
  }
}

export function printTimesheet(opts = {}) {
  const rows = buildTimesheet(opts);
  const idleMinutes = opts.idleMinutes ?? DEFAULT_IDLE_MINUTES;
  const maxItems = opts.maxItems ?? 8;
  const showPrompts = opts.prompts === true;

  if (rows.length === 0) {
    console.log(chalk.yellow("No Claude Code activity found for this range."));
    console.log(
      chalk.dim("Widen the range with --days N, or drop --project to see everything.")
    );
    return;
  }

  let grandMs = 0;
  let lastDay = null;
  const overlapDays = new Set();

  for (const row of rows) {
    if (row.day !== lastDay) {
      if (lastDay !== null) console.log("");
      console.log(chalk.bold(row.day));
      lastDay = row.day;
    }
    grandMs += row.activeMs;

    const window =
      row.firstTs && row.lastTs ? chalk.dim(` ${fmtClock(row.firstTs)}-${fmtClock(row.lastTs)}`) : "";
    if (row.overlapMs >= 60_000) overlapDays.add(row.day);
    console.log(
      "  " +
        chalk.cyan(row.project.padEnd(28)) +
        chalk.bold(fmtDuration(row.activeMs).padStart(8)) +
        chalk.dim(fmtTokens(row.totalTokens).padStart(10)) +
        chalk.dim(`  ${row.tasks} tasks, ${row.sessions} runs`) +
        window
    );

    // The prompts you typed are off by default: a timesheet is a summary of
    // what was done, not a transcript of how it was asked for. --prompts brings
    // them back for anyone who wants the raw ask alongside the summary.
    if (showPrompts) {
      for (const title of row.titles.slice(0, 4)) {
        console.log("    " + chalk.dim("“") + title + chalk.dim("”"));
      }
      if (row.titles.length > 4) {
        console.log("    " + chalk.dim(`+ ${row.titles.length - 4} more sessions`));
      }
      if (row.titles.length) console.log("");
    }

    // Long days have a long tail of one-off work items. Showing every one of
    // them buries the lines that matter, so the tail is folded into a single
    // row. The CSV keeps the full breakdown.
    const shown = row.items.filter((it) => it.ms >= 30_000 || it.calls >= 3);
    const head = shown.slice(0, maxItems);
    const tail = shown.slice(maxItems);

    for (const item of head) {
      console.log(
        "    " +
          chalk.dim("- ") +
          fmtDuration(item.ms).padStart(7) +
          chalk.dim(fmtTokens(item.tokens).padStart(9)) +
          "  " +
          item.label.padEnd(28) +
          (item.files.length ? chalk.dim(item.files.join(", ")) : "")
      );
      // A commit message is a person describing the work, so it outranks any
      // label this tool could derive. It goes on its own line underneath.
      for (const subject of item.commits.slice(0, 3)) {
        console.log("      " + chalk.dim("↳ ") + chalk.green(subject));
      }
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
  if (overlapDays.size) {
    console.log(
      chalk.dim(
        `${overlapDays.size} day(s) had projects running at the same time. Shared minutes were ` +
          `split between them, so the per-project rows add up to the day rather than exceeding it. ` +
          `Use --overlap keep to see each project's unshared time instead.`
      )
    );
  }
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

  // The prompt column only appears when explicitly asked for, so a file you
  // hand to someone else carries no prose from your sessions by accident.
  const withPrompts = opts.prompts === true;
  const header = ["date", "project", "day_hours", "day_tokens"];
  if (withPrompts) header.push("worked_on");
  header.push("task", "task_hours", "task_tokens", "tool_calls", "detail", "commits");
  const out = [header.join(",")];

  const line = (row, item) => {
    const cols = [row.day, row.project, fmtHours(row.activeMs), row.totalTokens];
    if (withPrompts) cols.push(row.titles.join(" · "));
    if (item) {
      cols.push(
        item.label,
        fmtHours(item.ms),
        item.tokens,
        item.calls,
        item.files.join(" "),
        item.commits.join(" · ")
      );
    } else {
      cols.push("", "", "", 0, "", "");
    }
    return cols.map(esc).join(",");
  };

  for (const row of rows) {
    if (row.items.length === 0) out.push(line(row, null));
    else for (const item of row.items) out.push(line(row, item));
  }

  return out.join("\n");
}
