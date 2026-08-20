import chalk from "chalk";
import { getSummary, getDailyTotals, getToolBreakdown, getAgentRuns } from "./db.js";
import { buildTimesheet, fmtDuration } from "./timesheet.js";
import { scan } from "./scanner.js";

// ---------------------------------------------------------------------------
// This is a hand-rolled ANSI dashboard, deliberately. A TUI framework would be
// a native dependency with a large trust surface, and this tool's whole pitch
// is that you can read the source and verify it never touches the network.
// Everything below is string building plus a handful of escape codes.
// ---------------------------------------------------------------------------

const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const CURSOR_HOME = "\x1b[H";
const CLEAR_BELOW = "\x1b[J";
const CLEAR_LINE_END = "\x1b[K";

const UNICORN = "🦄";
const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const BAR_PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

const c = {
  frame: chalk.hex("#6b5b95"),
  title: chalk.hex("#c792ea").bold,
  label: chalk.hex("#7f8c9a"),
  value: chalk.hex("#e6e6e6").bold,
  accent: chalk.hex("#ff79c6"),
  cyan: chalk.hex("#8be9fd"),
  green: chalk.hex("#50fa7b"),
  amber: chalk.hex("#f1fa8c"),
  dim: chalk.hex("#5a6272"),
};

// Bars cycle through these so adjacent rows stay distinguishable.
const BAR_COLORS = [
  chalk.hex("#ff79c6"),
  chalk.hex("#bd93f9"),
  chalk.hex("#8be9fd"),
  chalk.hex("#50fa7b"),
  chalk.hex("#f1fa8c"),
];

const RANGES = {
  1: { days: 1, label: "today" },
  7: { days: 7, label: "last 7 days" },
  3: { days: 30, label: "last 30 days" },
};

// ---------------------------------------------------------------------------
// width helpers
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*m/g;

// Visible width of a string: strip colour codes, and count astral-plane
// characters (our emoji) as double width, which is how terminals render them.
function vlen(str) {
  const plain = str.replace(ANSI_RE, "");
  let width = 0;
  for (const ch of plain) width += ch.codePointAt(0) > 0xffff ? 2 : 1;
  return width;
}

function padEnd(str, width) {
  const diff = width - vlen(str);
  return diff > 0 ? str + " ".repeat(diff) : str;
}

function padStart(str, width) {
  const diff = width - vlen(str);
  return diff > 0 ? " ".repeat(diff) + str : str;
}

// Cut a string to a visible width, never mid-escape-code.
function truncate(str, width) {
  if (vlen(str) <= width) return str;
  const plain = str.replace(ANSI_RE, "");
  let out = "";
  let used = 0;
  for (const ch of plain) {
    const w = ch.codePointAt(0) > 0xffff ? 2 : 1;
    if (used + w > width - 1) break;
    out += ch;
    used += w;
  }
  return out + "…";
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

function fmtCompact(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 10_000) return (n / 1000).toFixed(0) + "K";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

function fmtNum(n) {
  return n.toLocaleString("en-US");
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function clockNow() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

// ---------------------------------------------------------------------------
// drawing primitives
// ---------------------------------------------------------------------------

// A rounded box. `lines` are already-coloured strings; we pad them to fit.
function box(title, lines, width, { badge = "" } = {}) {
  const inner = width - 2;
  const head = title ? ` ${title} ` : "";
  const badgeStr = badge ? ` ${badge} ` : "";
  const fillLen = Math.max(0, inner - vlen(head) - vlen(badgeStr));

  const out = [];
  out.push(
    c.frame("╭") +
      c.title(head) +
      c.frame("─".repeat(fillLen)) +
      badgeStr +
      c.frame("╮")
  );
  for (const line of lines) {
    out.push(c.frame("│") + padEnd(truncate(line, inner), inner) + c.frame("│"));
  }
  out.push(c.frame("╰") + c.frame("─".repeat(inner)) + c.frame("╯"));
  return out;
}

// Horizontal bar scaled against `max`, using eighth-block partials so short
// bars stay visible instead of rounding away to nothing.
function bar(value, max, width, colorFn) {
  if (max <= 0 || width <= 0) return "";
  const exact = (value / max) * width;
  const full = Math.floor(exact);
  const rem = Math.floor((exact - full) * 8);
  let s = "█".repeat(Math.min(full, width));
  if (full < width && rem > 0) s += BAR_PARTIALS[rem];
  if (value > 0 && s === "") s = BAR_PARTIALS[1];
  return colorFn(s);
}

// Each day becomes a group of `groupW` columns, so a 6-day range still draws a
// chart with some presence instead of six lonely characters.
function sparkline(values, colorFn, { groupW = 1 } = {}) {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  return colorFn(
    values
      .map((v) => {
        if (v <= 0 || max <= 0) return " ".repeat(groupW);
        const idx = Math.min(SPARK.length - 1, Math.max(0, Math.round((v / max) * (SPARK.length - 1))));
        return SPARK[idx].repeat(groupW);
      })
      .join("")
  );
}

// ---------------------------------------------------------------------------
// panels
// ---------------------------------------------------------------------------

function totalsPanel(rows, width) {
  const t = rows.reduce(
    (acc, r) => {
      acc.runs += r.agentRuns;
      acc.tasks += r.tasks;
      acc.newIn += r.newIn;
      acc.tokensOut += r.tokensOut;
      acc.cacheRead += r.cacheRead;
      return acc;
    },
    { runs: 0, tasks: 0, newIn: 0, tokensOut: 0, cacheRead: 0 }
  );

  const cells = [
    [fmtNum(t.runs), "agent runs"],
    [fmtNum(t.tasks), "tasks"],
    [fmtCompact(t.newIn), "new input"],
    [fmtCompact(t.tokensOut), "output"],
    [fmtCompact(t.newIn + t.tokensOut), "real work"],
    [fmtCompact(t.cacheRead), "cache replay"],
  ];

  const inner = width - 2;
  const colWidth = Math.floor((inner - 2) / cells.length);

  const valueRow = "  " + cells.map(([v]) => padEnd(c.value(v), colWidth)).join("");
  const labelRow = "  " + cells.map(([, l]) => padEnd(c.label(l), colWidth)).join("");

  // The unicorn is deliberately left uncoloured: applying an SGR colour to an
  // emoji makes some renderers fall back to its monochrome text presentation.
  return box("TOTALS", ["", valueRow, labelRow, ""], width, { badge: UNICORN });
}

function trendPanel(daily, width) {
  if (daily.length === 0) return [];

  const values = daily.map((d) => d.totalTokens);
  const peak = daily.reduce((a, b) => (b.totalTokens > a.totalTokens ? b : a));
  const chartW = Math.floor((width - 2) * 0.4);
  const groupW = Math.max(1, Math.min(4, Math.floor(chartW / values.length)));
  const spark = sparkline(values, c.cyan, { groupW });
  const caption = c.dim(
    `   ${daily[0].day} → ${daily[daily.length - 1].day}   peak ${fmtCompact(peak.totalTokens)} on ${peak.day}`
  );

  return box("TOKENS / DAY", ["", "  " + spark + caption, ""], width);
}

function projectsPanel(list, width, selected) {
  if (list.length === 0) return [];

  const max = list[0].tokens || 1;
  const inner = width - 2;
  const nameW = Math.min(26, Math.max(12, Math.floor(inner * 0.28)));
  const statsW = 32; // 9 (time) + 8 (tokens) + 15 (tasks)
  const barW = Math.max(6, inner - nameW - statsW - 6);

  const lines = [""];
  list.forEach((p, i) => {
    const color = BAR_COLORS[i % BAR_COLORS.length];
    const active = i === selected;
    // A caret rather than a background highlight: reverse video is the one
    // thing that looks different in every terminal theme.
    const cursor = active ? c.accent("▸ ") : "  ";
    const name = padEnd((active ? c.accent : c.value)(truncate(p.project, nameW)), nameW);
    const b = padEnd(bar(p.tokens, max, barW, color), barW);
    const stats =
      padStart(c.green(fmtDuration(p.activeMs)), 9) +
      padStart(c.cyan(fmtCompact(p.tokens)), 8) +
      padStart(c.dim(`${fmtNum(p.tasks)} tasks`), 15);
    lines.push(`${cursor}${name} ${b} ${stats}`);
  });
  lines.push("");

  return box("PROJECTS", lines, width, { badge: c.dim("↑↓ select · ⏎ open") });
}

// The drill-down: one project, laid out as the table you'd actually put on a
// timesheet. Days are section headers, work items are rows, and the share bar
// is scaled within each day so the shape of that day is readable on its own.
function projectDetailPanel(project, sheet, width) {
  const rows = sheet.filter((r) => r.project === project);
  const inner = width - 2;

  if (rows.length === 0) {
    return box(`TIMESHEET · ${project}`, ["", c.dim("   Nothing recorded in this range."), ""], width);
  }

  const totalMs = rows.reduce((s, r) => s + r.activeMs, 0);
  const totalTasks = rows.reduce((s, r) => s + r.tasks, 0);
  const totalTokens = rows.reduce((s, r) => s + r.totalTokens, 0);
  const totalOverlap = rows.reduce((s, r) => s + r.overlapMs, 0);

  // Column layout, fixed first so every day's rows line up with each other and
  // with the header. Files take whatever is left.
  const timeW = 8;
  const workW = Math.min(30, Math.max(18, Math.floor(inner * 0.26)));
  const shareW = Math.min(14, Math.max(8, Math.floor(inner * 0.12)));
  const tokensW = 9;
  const callsW = 7;
  const filesW = Math.max(10, inner - timeW - workW - shareW - tokensW - callsW - 6);

  const lines = [""];

  // Summary strip, same cell-over-label shape as the TOTALS panel up top.
  const cells = [
    [fmtDuration(totalMs), "tracked"],
    [fmtNum(totalTasks), "tasks"],
    [fmtCompact(totalTokens), "tokens"],
    [String(rows.length), rows.length === 1 ? "day" : "days"],
  ];
  // Capped so four cells don't drift to the far corners of a wide terminal.
  const colW = Math.min(18, Math.floor((inner - 4) / cells.length));
  lines.push("  " + cells.map(([v]) => padEnd(c.value(v), colW)).join(""));
  lines.push("  " + cells.map(([, l]) => padEnd(c.label(l), colW)).join(""));
  lines.push("");

  // Column header, printed once.
  lines.push(
    "  " +
      padStart(c.label("TIME"), timeW) +
      "  " +
      padEnd(c.label("WORK"), workW) +
      padEnd(c.label("SHARE"), shareW + 2) +
      padStart(c.label("TOKENS"), tokensW) +
      padStart(c.label("CALLS"), callsW) +
      "  " +
      c.label("DETAIL")
  );
  lines.push("  " + c.frame("─".repeat(Math.max(0, inner - 4))));

  for (const row of rows) {
    // Day header: date on the left, that day's totals right-aligned.
    const shared =
      row.overlapMs >= 60_000 ? c.amber(` ⇄ ${fmtDuration(row.overlapMs)} shared`) : "";
    const left = c.cyan(row.day) + shared;
    const right =
      c.green(fmtDuration(row.activeMs)) +
      c.dim(` · ${fmtNum(row.tasks)} tasks · ${row.sessions} ${row.sessions === 1 ? "run" : "runs"}`);
    const gap = Math.max(1, inner - 4 - vlen(left) - vlen(right));
    lines.push("  " + left + " ".repeat(gap) + right);


    const shown = row.items.filter((it) => it.ms >= 30_000 || it.calls >= 3).slice(0, 7);
    const dayMax = shown.reduce((m, it) => Math.max(m, it.ms), 0);

    if (shown.length === 0) {
      lines.push("  " + c.dim("   nothing above the noise floor"));
    }

    shown.forEach((item, i) => {
      const color = BAR_COLORS[i % BAR_COLORS.length];
      lines.push(
        "  " +
          padStart(c.green(fmtDuration(item.ms)), timeW) +
          "  " +
          padEnd(c.value(truncate(item.label, workW - 1)), workW) +
          padEnd(bar(item.ms, dayMax, shareW, color), shareW + 2) +
          padStart(item.tokens ? c.cyan(fmtCompact(item.tokens)) : c.dim("–"), tokensW) +
          padStart(c.dim(fmtNum(item.calls)), callsW) +
          "  " +
          // A commit message beats a file list: it says what the work was, not
          // just where it happened.
          (item.commits?.length
            ? c.green(truncate(item.commits[0], filesW))
            : c.dim(truncate(item.files.join(", "), filesW)))
      );
    });

    lines.push("");
  }

  if (totalOverlap >= 60_000) {
    lines.push(
      c.dim(`  ⇄ ${fmtDuration(totalOverlap)} of this was shared with another project and split evenly.`)
    );
    lines.push("");
  }

  return box(`TIMESHEET · ${project}`, lines, width, { badge: c.dim("esc back") });
}

function toolsPanel(tools, width) {
  if (tools.length === 0) return [];

  const max = tools[0].count;
  const inner = width - 2;
  const nameW = Math.min(20, Math.max(10, Math.floor(inner * 0.22)));
  const statsW = 22; // 8 (calls) + 14 (tokens)
  const barW = Math.max(6, inner - nameW - statsW - 4);

  const lines = [""];
  tools.forEach((t, i) => {
    const color = BAR_COLORS[i % BAR_COLORS.length];
    const name = padEnd(c.value(truncate(t.tool, nameW)), nameW);
    const b = padEnd(bar(t.count, max, barW, color), barW);
    const stats =
      padStart(c.cyan(fmtNum(t.count)), 8) + padStart(c.dim(fmtCompact(t.tokens) + " tok"), 14);
    lines.push(` ${name} ${b} ${stats}`);
  });
  lines.push("");

  return box("TOOLS THE AGENTS REACHED FOR", lines, width);
}

function agentsPanel(agents, width) {
  if (agents.length === 0) return [];

  const max = agents[0].totalTokens;
  const inner = width - 2;
  const nameW = Math.min(24, Math.max(14, Math.floor(inner * 0.26)));
  const statsW = 24;
  const barW = Math.max(6, inner - nameW - statsW - 4);

  const lines = [""];
  agents.forEach((a, i) => {
    const color = BAR_COLORS[i % BAR_COLORS.length];
    const kind = a.isSubagent ? c.amber("sub ") : c.dim("main");
    const label = `${kind} ${c.value(truncate(a.sessionId, nameW - 5))}`;
    const b = padEnd(bar(a.totalTokens, max, barW, color), barW);
    const stats =
      padStart(c.cyan(fmtCompact(a.totalTokens)), 8) + padStart(c.dim(`${fmtNum(a.tasks)} tasks`), 16);
    lines.push(` ${padEnd(label, nameW)} ${b} ${stats}`);
  });
  lines.push("");

  return box("AGENT RUNS BY COST", lines, width);
}

function emptyPanel(width) {
  return box(
    "NOTHING YET",
    [
      "",
      `   ${UNICORN}  No Claude Code activity in this range.`,
      "",
      c.dim("   The unicorn is idle. Widen the range with [7] or [3],"),
      c.dim("   or go use an agent and press [r] to rescan."),
      "",
    ],
    width
  );
}

// ---------------------------------------------------------------------------
// frame assembly
// ---------------------------------------------------------------------------

function buildFrame(state, width) {
  const range = RANGES[state.rangeKey];
  const lines = [];

  const title = `${UNICORN} ${c.title("aitimesheet")}`;
  const subtitle = c.dim(` · ${range.label} · local only, nothing sent anywhere`);
  const right = c.dim(state.scanning ? "scanning…" : clockNow());
  const headLeft = title + subtitle;
  const gap = Math.max(1, width - vlen(headLeft) - vlen(right));

  lines.push("");
  lines.push(headLeft + " ".repeat(gap) + right);
  lines.push("");

  const detailProject = state.view === "detail" ? state.projects[state.selected]?.project : null;

  if (state.rows.length === 0) {
    lines.push(...emptyPanel(width));
  } else if (detailProject) {
    lines.push(...projectDetailPanel(detailProject, state.sheet, width));
  } else {
    lines.push(...totalsPanel(state.rows, width));
    lines.push("");
    if (range.days > 1) {
      lines.push(...trendPanel(state.daily, width));
      lines.push("");
    }
    lines.push(...projectsPanel(state.projects, width, state.selected));
    lines.push("");
    lines.push(...agentsPanel(state.agents, width));
    lines.push("");
    lines.push(...toolsPanel(state.tools, width));
  }

  lines.push("");
  const keys = (
    detailProject
      ? [
          `${c.accent("[esc]")}${c.dim(" back")}`,
          `${c.accent("[↑↓]")}${c.dim(" other project")}`,
          `${c.accent("[r]")}${c.dim(" rescan")}`,
          `${c.accent("[1]")}${c.dim(" today")}`,
          `${c.accent("[7]")}${c.dim(" 7 days")}`,
          `${c.accent("[3]")}${c.dim(" 30 days")}`,
        ]
      : [
          `${c.accent("[q]")}${c.dim(" quit")}`,
          `${c.accent("[↑↓]")}${c.dim(" select")}`,
          `${c.accent("[⏎]")}${c.dim(" timesheet")}`,
          `${c.accent("[r]")}${c.dim(" rescan")}`,
          `${c.accent("[1]")}${c.dim(" today")}`,
          `${c.accent("[7]")}${c.dim(" 7 days")}`,
          `${c.accent("[3]")}${c.dim(" 30 days")}`,
        ]
  ).join(c.dim("   "));
  lines.push(" " + keys);

  return lines;
}

// ---------------------------------------------------------------------------
// data + loop
// ---------------------------------------------------------------------------

function loadData(state) {
  const range = RANGES[state.rangeKey];
  const sinceDay = daysAgo(range.days - 1);
  state.rows = getSummary({ sinceDay });
  state.daily = getDailyTotals({ sinceDay });
  state.tools = getToolBreakdown({ sinceDay, limit: 8 });
  state.agents = getAgentRuns({ sinceDay, limit: 6 });
  state.sheet = buildTimesheet({ sinceDay });
  deriveProjects(state);
}

// One row per project, carrying both what it cost and how long it took, so the
// list can be selected through and drilled into. Split out from loadData so the
// screenshot path, which injects its own data instead of reading the database,
// gets an identical project list.
function deriveProjects(state) {
  const byProject = new Map();
  for (const r of state.rows) {
    const cur = byProject.get(r.project) || {
      project: r.project,
      runs: 0,
      tasks: 0,
      tokens: 0,
      activeMs: 0,
    };
    cur.runs += r.agentRuns;
    cur.tasks += r.tasks;
    cur.tokens += r.totalTokens;
    byProject.set(r.project, cur);
  }
  for (const r of state.sheet || []) {
    const cur = byProject.get(r.project);
    if (cur) cur.activeMs += r.activeMs;
  }

  state.projects = [...byProject.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 10);

  // A rescan can shrink the list under the cursor.
  if (state.selected >= state.projects.length) state.selected = Math.max(0, state.projects.length - 1);
}

// Renders one frame and returns it as a plain string, without touching the
// terminal. Used by scripts/screenshot.js to generate the README images from
// real data through the exact same code path the live TUI uses.
export function captureFrame({
  range = "7",
  width = 100,
  data = null,
  view = "overview",
  selected = 0,
} = {}) {
  const rangeKey = RANGES[range] ? range : "7";
  const state = {
    rangeKey,
    rows: [],
    daily: [],
    tools: [],
    agents: [],
    sheet: [],
    projects: [],
    selected,
    view,
    scanning: false,
    ...(data || {}),
  };
  if (data) deriveProjects(state);
  else loadData(state);
  return buildFrame(state, width).join("\n");
}

export function startTui({ range = "7" } = {}) {
  const out = process.stdout;

  // Piping the TUI somewhere isn't meaningful — send people to the table.
  if (!out.isTTY) {
    console.error("aitimesheet tui needs an interactive terminal. Use `aitimesheet report` instead.");
    process.exitCode = 1;
    return;
  }

  const rangeKey = RANGES[range] ? range : "7";
  const state = {
    rangeKey,
    rows: [],
    daily: [],
    tools: [],
    agents: [],
    sheet: [],
    projects: [],
    selected: 0,
    view: "overview",
    scanning: false,
  };

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(renderTimer);
    clearInterval(scanTimer);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    out.write(CURSOR_SHOW + ALT_SCREEN_OFF);
  };

  const render = () => {
    if (closed) return;
    const width = Math.max(60, Math.min(out.columns || 100, 120));
    const frame = buildFrame(state, width);
    // Redraw in place rather than clearing first: no flicker, no scrollback spam.
    out.write(CURSOR_HOME + frame.map((l) => l + CLEAR_LINE_END).join("\n") + "\n" + CLEAR_BELOW);
  };

  const rescan = () => {
    state.scanning = true;
    render();
    try {
      scan();
    } catch {
      // A scan failure shouldn't kill a running dashboard; the next tick retries.
    }
    state.scanning = false;
    loadData(state);
    render();
  };

  out.write(ALT_SCREEN_ON + CURSOR_HIDE);
  loadData(state);
  render();

  // Cheap: re-reads sqlite only, so the clock and any outside writes stay current.
  const renderTimer = setInterval(() => {
    loadData(state);
    render();
  }, 2000);

  // Expensive: walks the transcript directory. Incremental, so still fast.
  const scanTimer = setInterval(rescan, 15000);

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  const move = (delta) => {
    if (state.projects.length === 0) return;
    const next = state.selected + delta;
    // Clamped rather than wrapped: holding a key shouldn't teleport you to the
    // other end of the list.
    state.selected = Math.max(0, Math.min(state.projects.length - 1, next));
    render();
  };

  process.stdin.on("data", (key) => {
    // Arrow keys arrive as escape sequences, so they have to be matched before
    // the bare-escape case below or every Up would quit the dashboard.
    if (key === "\x1b[A" || key === "k") return move(-1);
    if (key === "\x1b[B" || key === "j") return move(1);

    if (key === "\r" || key === "\n" || key === "\x1b[C") {
      if (state.projects.length) {
        state.view = "detail";
        render();
      }
      return;
    }

    if (key === "\x1b" || key === "\x1b[D") {
      // Escape backs out of the drill-down first, and only quits from the top.
      if (state.view === "detail") {
        state.view = "overview";
        render();
        return;
      }
      cleanup();
      process.exit(0);
      return;
    }

    if (key === "q" || key === "\x03") {
      cleanup();
      process.exit(0);
    } else if (key === "r") {
      rescan();
    } else if (RANGES[key]) {
      state.rangeKey = key;
      loadData(state);
      render();
    }
  });

  out.on("resize", render);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("uncaughtException", (err) => {
    cleanup();
    console.error(err);
    process.exit(1);
  });
}
