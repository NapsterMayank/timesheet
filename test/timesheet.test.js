import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the whole tool at a throwaway home before anything opens the database.
process.env.AITIMESHEET_HOME = mkdtempSync(join(tmpdir(), "aitimesheet-test-"));

const { insertUsageEvent, insertToolEvent, insertSession } = await import("../src/db.js");
const { buildTimesheet, timesheetCsv } = await import("../src/timesheet.js");

const DAY = "2026-01-15";
let seq = 0;

function at(minutes) {
  return new Date(Date.UTC(2026, 0, 15, 9, minutes, 0)).toISOString();
}

function tool(minutes, toolName, target, project = "demo") {
  insertToolEvent({
    tool_use_id: `tool-${seq++}`,
    message_id: `msg-${seq}`,
    project,
    session_id: "session-a",
    day: DAY,
    ts: at(minutes),
    tool_name: toolName,
    target,
    subagent_type: null,
    is_subagent: 0,
  });
}

function usage(minutes, project = "demo") {
  insertUsageEvent({
    message_id: `usage-${seq++}`,
    project,
    session_id: "session-a",
    day: DAY,
    ts: at(minutes),
    model: "claude-opus-5",
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    is_subagent: 0,
  });
}

// A day with a deliberate 90-minute hole in the middle of it.
tool(0, "Read", "/repo/src/scanner.js");
tool(5, "Edit", "/repo/src/scanner.js");
usage(9);
tool(10, "Edit", "/repo/src/db.js");
// ... long break here, 10:10 -> 11:40 ...
tool(100, "Bash", "git commit -m wip");
tool(104, "Bash", "npm test");

const rows = buildTimesheet({ sinceDay: DAY, untilDay: DAY });
const row = rows[0];

test("a break longer than the idle threshold is excluded, not clamped", () => {
  // 0->5->9->10 is 10 minutes, 100->104 is 4, plus a 1 minute tail credit.
  // The 90 minute gap contributes nothing at all.
  assert.equal(Math.round(row.activeMs / 60_000), 15);
});

test("the idle threshold is what decides a break", () => {
  const tight = buildTimesheet({ sinceDay: DAY, untilDay: DAY, idleMinutes: 3 })[0];
  // With a 3 minute threshold the 0->5 and 5->9 gaps also become breaks.
  assert.ok(tight.activeMs < row.activeMs);

  const loose = buildTimesheet({ sinceDay: DAY, untilDay: DAY, idleMinutes: 120 })[0];
  // With a 120 minute threshold the long hole counts as work again.
  assert.equal(Math.round(loose.activeMs / 60_000), 105);
});

test("file work is classified and lists the files as evidence", () => {
  const code = row.items.find((i) => i.label === "Code changes");
  assert.ok(code, "expected a work item for the edited source files");
  assert.equal(code.calls, 3);
  assert.deepEqual(code.files.sort(), ["db.js", "scanner.js"]);
});

test("shell work is grouped into activities a non-engineer can read", () => {
  const labels = row.items.map((i) => i.label);
  assert.ok(labels.includes("Version control"), "git should read as version control");
  assert.ok(labels.includes("Builds & dependencies"), "npm should read as builds");
});

test("time between tool calls is attributed to the work in flight", () => {
  const src = row.items.find((i) => i.label === "Code changes");
  // The 10 minutes of file work land on the directory, not on a catch-all.
  assert.equal(Math.round(src.ms / 60_000), 10);
});

test("counts and totals line up with the row", () => {
  assert.equal(row.tasks, 5);
  assert.equal(row.sessions, 1);
  assert.equal(row.project, "demo");
  assert.equal(row.day, DAY);
});

test("csv escapes and carries every item", () => {
  const csv = timesheetCsv({ sinceDay: DAY, untilDay: DAY });
  const lines = csv.trim().split("\n");
  assert.equal(
    lines[0],
    "date,project,day_hours,day_tokens,task,task_hours,task_tokens,tool_calls,detail"
  );
  assert.equal(lines.length - 1, row.items.length);
  for (const line of lines.slice(1)) assert.ok(line.startsWith(`${DAY},demo,`));
});

test("an empty range yields no rows rather than throwing", () => {
  assert.deepEqual(buildTimesheet({ sinceDay: "2019-01-01", untilDay: "2019-01-02" }), []);
});

// Path classification, which is what lets a timesheet say "Frontend work"
// instead of naming a directory nobody outside the team recognises.
const CLASSIFY_DAY = "2026-03-10";

function classifyEvent(minutes, target) {
  insertToolEvent({
    tool_use_id: `cl-${seq++}`,
    message_id: `cl-msg-${seq}`,
    project: "layers",
    session_id: "session-layers",
    day: CLASSIFY_DAY,
    ts: new Date(Date.UTC(2026, 2, 10, 10, minutes, 0)).toISOString(),
    tool_name: "Edit",
    target,
    subagent_type: null,
    is_subagent: 0,
  });
}

classifyEvent(0, "/repo/src/components/Cart.tsx");
classifyEvent(1, "/repo/src/api/checkout.py");
classifyEvent(2, "/repo/src/api/__tests__/checkout.test.py");
classifyEvent(3, "/repo/migrations/0004_add_orders.sql");
classifyEvent(4, "/repo/.github/workflows/deploy.yml");
classifyEvent(5, "/repo/docs/architecture.md");

test("files are classified into work a non-engineer recognises", () => {
  const r = buildTimesheet({ sinceDay: CLASSIFY_DAY, untilDay: CLASSIFY_DAY })[0];
  const labels = r.items.map((i) => i.label);

  assert.ok(labels.includes("Frontend work"));
  assert.ok(labels.includes("Backend work"));
  assert.ok(labels.includes("Testing"));
  assert.ok(labels.includes("Database & migrations"));
  assert.ok(labels.includes("Infrastructure & deployment"));
  assert.ok(labels.includes("Documentation"));
});

test("a test file under components counts as testing, not frontend", () => {
  const r = buildTimesheet({ sinceDay: CLASSIFY_DAY, untilDay: CLASSIFY_DAY })[0];
  const testing = r.items.find((i) => i.label === "Testing");
  assert.deepEqual(testing.files, ["checkout.test.py"]);

  const frontend = r.items.find((i) => i.label === "Frontend work");
  assert.deepEqual(frontend.files, ["Cart.tsx"]);
});

// Session titles: what was asked for, needing no inference at all.
const TITLE_DAY = "2026-04-02";

test("a day carries the prompts that started its sessions", () => {
  insertSession({
    session_id: "titled-session",
    project: "titled",
    day: TITLE_DAY,
    ts: `${TITLE_DAY}T09:00:00.000Z`,
    title: "fix the login redirect bug",
    is_subagent: 0,
  });
  insertToolEvent({
    tool_use_id: `ti-${seq++}`,
    message_id: `ti-msg-${seq}`,
    project: "titled",
    session_id: "titled-session",
    day: TITLE_DAY,
    ts: `${TITLE_DAY}T09:00:00.000Z`,
    tool_name: "Edit",
    target: "/repo/src/components/Login.tsx",
    subagent_type: null,
    is_subagent: 0,
  });

  const r = buildTimesheet({ sinceDay: TITLE_DAY, untilDay: TITLE_DAY })[0];
  assert.deepEqual(r.titles, ["fix the login redirect bug"]);
  assert.equal(r.items[0].label, "Frontend work");
});

test("prompts stay out of the CSV unless asked for", () => {
  assert.ok(!timesheetCsv({ sinceDay: TITLE_DAY, untilDay: TITLE_DAY }).includes("login redirect"));
  assert.ok(
    timesheetCsv({ sinceDay: TITLE_DAY, untilDay: TITLE_DAY, prompts: true }).includes(
      "login redirect"
    )
  );
});

// Tokens per work item: the API bills per message, so a message that fires
// several tool calls has its cost divided between them.
const COST_DAY = "2026-05-05";

test("a message's tokens are split across the tool calls it fired", () => {
  insertUsageEvent({
    message_id: "cost-msg",
    project: "costed",
    session_id: "cost-session",
    day: COST_DAY,
    ts: `${COST_DAY}T10:00:00.000Z`,
    model: "claude-opus-5",
    input_tokens: 100,
    output_tokens: 700,
    cache_read_tokens: 50_000, // cache replay is excluded from the work total
    cache_creation_tokens: 200,
    is_subagent: 0,
  });
  for (let i = 0; i < 2; i++) {
    insertToolEvent({
      tool_use_id: `cost-tool-${i}`,
      message_id: "cost-msg",
      project: "costed",
      session_id: "cost-session",
      day: COST_DAY,
      ts: `${COST_DAY}T10:0${i}:00.000Z`,
      tool_name: "Edit",
      target: "/repo/api/orders.py",
      subagent_type: null,
      is_subagent: 0,
    });
  }

  const r = buildTimesheet({ sinceDay: COST_DAY, untilDay: COST_DAY })[0];
  const backend = r.items.find((i) => i.label === "Backend work");
  // 100 + 200 + 700 = 1000, shared by two tool calls, both landing on the same
  // work item, so the item reports the message's full cost exactly once.
  assert.equal(backend.tokens, 1000);
});

// Two clients worked in the same half hour. Counted naively that half hour
// bills twice, which is the difference between an honest timesheet and fraud.
const OVERLAP_DAY = "2026-02-20";

function overlapEvent(minutes, project, toolName = "Bash", target = "npm test") {
  insertToolEvent({
    tool_use_id: `ov-${seq++}`,
    message_id: `ov-msg-${seq}`,
    project,
    session_id: `session-${project}`,
    day: OVERLAP_DAY,
    ts: new Date(Date.UTC(2026, 1, 20, 13, minutes, 0)).toISOString(),
    tool_name: toolName,
    target,
    subagent_type: null,
    is_subagent: 0,
  });
}

// Each project's last event earns a one minute tail, so:
//   client-a covers 13:00-13:11, client-b covers 13:04-13:15.
//   They overlap for 7 minutes, 13:04-13:11.
const MIN = 60_000;
for (const m of [0, 2, 4, 6, 8, 10]) overlapEvent(m, "client-a");
for (const m of [4, 6, 8, 10, 12, 14]) overlapEvent(m, "client-b");

test("time worked on two projects at once is split, not double counted", () => {
  const split = buildTimesheet({ sinceDay: OVERLAP_DAY, untilDay: OVERLAP_DAY });
  const a = split.find((r) => r.project === "client-a");
  const b = split.find((r) => r.project === "client-b");

  // Real elapsed time is 13:00-13:15. The projects together must never claim
  // more than that, which is the whole point of the exercise.
  assert.equal(a.activeMs + b.activeMs, 15 * MIN);

  // 7 shared minutes halved: a keeps 4 alone + 3.5, b keeps 4 alone + 3.5.
  assert.equal(a.activeMs, 7.5 * MIN);
  assert.equal(b.activeMs, 7.5 * MIN);
  assert.equal(a.overlapMs, 3.5 * MIN);
  assert.equal(b.overlapMs, 3.5 * MIN);
});

test("--overlap keep reports each project's time in full", () => {
  const kept = buildTimesheet({
    sinceDay: OVERLAP_DAY,
    untilDay: OVERLAP_DAY,
    overlap: "keep",
  });
  const a = kept.find((r) => r.project === "client-a");
  const b = kept.find((r) => r.project === "client-b");

  // 11 minutes each, and 22 minutes claimed out of a 15 minute day: correct
  // per project, nonsense as a day total. That's why it isn't the default.
  assert.equal(a.activeMs, 11 * MIN);
  assert.equal(b.activeMs, 11 * MIN);
  assert.equal(a.overlapMs, 0);
});

test("splitting moves time between projects without inventing or losing any", () => {
  const kept = buildTimesheet({ sinceDay: OVERLAP_DAY, untilDay: OVERLAP_DAY, overlap: "keep" });
  const split = buildTimesheet({ sinceDay: OVERLAP_DAY, untilDay: OVERLAP_DAY });
  const keptTotal = kept.reduce((s, r) => s + r.activeMs, 0);
  const splitTotal = split.reduce((s, r) => s + r.activeMs, 0);
  const overlapTotal = split.reduce((s, r) => s + r.overlapMs, 0);
  assert.equal(splitTotal + overlapTotal, keptTotal);
});

test("a single project day is unaffected by overlap handling", () => {
  const single = buildTimesheet({ sinceDay: DAY, untilDay: DAY })[0];
  assert.equal(single.overlapMs, 0);
  assert.equal(single.activeMs, row.activeMs);
});
