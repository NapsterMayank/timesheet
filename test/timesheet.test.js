import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the whole tool at a throwaway home before anything opens the database.
process.env.AITIMESHEET_HOME = mkdtempSync(join(tmpdir(), "aitimesheet-test-"));

const { insertUsageEvent, insertToolEvent } = await import("../src/db.js");
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

test("file work groups by directory and lists the files touched", () => {
  const src = row.items.find((i) => i.label.endsWith("repo/src"));
  assert.ok(src, "expected a work item for the src directory");
  assert.equal(src.calls, 3);
  assert.deepEqual(src.files.sort(), ["db.js", "scanner.js"]);
});

test("shell work splits by the program being run", () => {
  const labels = row.items.map((i) => i.label);
  assert.ok(labels.includes("git commands"));
  assert.ok(labels.includes("npm commands"));
});

test("time between tool calls is attributed to the work in flight", () => {
  const src = row.items.find((i) => i.label.endsWith("repo/src"));
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
  assert.equal(lines[0], "date,project,day_hours,task,task_hours,tool_calls,files");
  assert.equal(lines.length - 1, row.items.length);
  for (const line of lines.slice(1)) assert.ok(line.startsWith(`${DAY},demo,`));
});

test("an empty range yields no rows rather than throwing", () => {
  assert.deepEqual(buildTimesheet({ sinceDay: "2019-01-01", untilDay: "2019-01-02" }), []);
});
