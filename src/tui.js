import chalk from "chalk";
import { getSummary, getDailyTotals, getToolBreakdown } from "./db.js";
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
      acc.tokensIn += r.tokensIn;
      acc.tokensOut += r.tokensOut;
      return acc;
    },
    { runs: 0, tasks: 0, tokensIn: 0, tokensOut: 0 }
  );

  const cells = [
    [fmtNum(t.runs), "agent runs"],
    [fmtNum(t.tasks), "tasks"],
    [fmtCompact(t.tokensIn), "tokens in"],
    [fmtCompact(t.tokensOut), "tokens out"],
    [fmtCompact(t.tokensIn + t.tokensOut), "total tokens"],
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

function projectsPanel(rows, width) {
  // Collapse project-day rows into one row per project.
  const byProject = new Map();
  for (const r of rows) {
    const cur = byProject.get(r.project) || { project: r.project, runs: 0, tasks: 0, tokens: 0 };
    cur.runs += r.agentRuns;
    cur.tasks += r.tasks;
    cur.tokens += r.totalTokens;
    byProject.set(r.project, cur);
  }
  const list = [...byProject.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 10);
  if (list.length === 0) return [];

  const max = list[0].tokens;
  const inner = width - 2;
  const nameW = Math.min(26, Math.max(12, Math.floor(inner * 0.28)));
  const statsW = 30; // 8 (tokens) + 10 (runs) + 12 (tasks)
  const barW = Math.max(6, inner - nameW - statsW - 4);

  const lines = [""];
  list.forEach((p, i) => {
    const color = BAR_COLORS[i % BAR_COLORS.length];
    const name = padEnd(c.value(truncate(p.project, nameW)), nameW);
    const b = padEnd(bar(p.tokens, max, barW, color), barW);
    const stats =
      padStart(c.cyan(fmtCompact(p.tokens)), 8) +
      padStart(c.dim(`${fmtNum(p.runs)} runs`), 10) +
      padStart(c.dim(`${fmtNum(p.tasks)} tasks`), 12);
    lines.push(` ${name} ${b} ${stats}`);
  });
  lines.push("");

  return box("PROJECTS", lines, width);
}

function toolsPanel(tools, width) {
  if (tools.length === 0) return [];

  const max = tools[0].count;
  const inner = width - 2;
  const nameW = Math.min(20, Math.max(10, Math.floor(inner * 0.22)));
  const countW = 9;
  const barW = Math.max(6, inner - nameW - countW - 4);

  const lines = [""];
  tools.forEach((t, i) => {
    const color = BAR_COLORS[i % BAR_COLORS.length];
    const name = padEnd(c.value(truncate(t.tool, nameW)), nameW);
    const b = padEnd(bar(t.count, max, barW, color), barW);
    const count = padStart(c.cyan(fmtNum(t.count)), countW);
    lines.push(` ${name} ${b} ${count}`);
  });
  lines.push("");

  return box("TOOLS THE AGENTS REACHED FOR", lines, width);
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

  if (state.rows.length === 0) {
    lines.push(...emptyPanel(width));
  } else {
    lines.push(...totalsPanel(state.rows, width));
    lines.push("");
    if (range.days > 1) {
      lines.push(...trendPanel(state.daily, width));
      lines.push("");
    }
    lines.push(...projectsPanel(state.rows, width));
    lines.push("");
    lines.push(...toolsPanel(state.tools, width));
  }

  lines.push("");
  const keys = [
    `${c.accent("[q]")}${c.dim(" quit")}`,
    `${c.accent("[r]")}${c.dim(" rescan")}`,
    `${c.accent("[1]")}${c.dim(" today")}`,
    `${c.accent("[7]")}${c.dim(" 7 days")}`,
    `${c.accent("[3]")}${c.dim(" 30 days")}`,
  ].join(c.dim("   "));
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
}

// Renders one frame and returns it as a plain string, without touching the
// terminal. Used by scripts/screenshot.js to generate the README images from
// real data through the exact same code path the live TUI uses.
export function captureFrame({ range = "7", width = 100, data = null } = {}) {
  const rangeKey = RANGES[range] ? range : "7";
  const state = { rangeKey, rows: [], daily: [], tools: [], scanning: false, ...(data || {}) };
  if (!data) loadData(state);
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
  const state = { rangeKey, rows: [], daily: [], tools: [], scanning: false };

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
  process.stdin.on("data", (key) => {
    if (key === "q" || key === "\x03" || key === "\x1b") {
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
