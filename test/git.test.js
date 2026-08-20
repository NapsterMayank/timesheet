import { test } from "node:test";
import assert from "node:assert/strict";

import { parseGitLog, parseCommitType, commitsInRange } from "../src/git.js";

const RECORD = "\x1e";
const FIELD = "\x1f";

function logEntry(hash, date, subject, files) {
  return `${RECORD}${hash}${FIELD}${date}${FIELD}${subject}\n${files.join("\n")}`;
}

test("parses commits, dates and the files each one touched", () => {
  const raw =
    logEntry("a1b2c3d4e5f6", "2026-08-18T14:03:00+05:30", "fix: null deref in checkout", [
      "api/checkout.py",
      "api/models/order.py",
    ]) +
    "\n" +
    logEntry("99887766aabb", "2026-08-18T16:40:00+05:30", "feat: add cart badge", [
      "src/components/Cart.tsx",
    ]);

  const commits = parseGitLog(raw);
  assert.equal(commits.length, 2);

  assert.equal(commits[0].hash, "a1b2c3d4"); // shortened for display
  assert.equal(commits[0].subject, "fix: null deref in checkout");
  assert.equal(commits[0].type, "bug fix");
  assert.equal(commits[0].day, "2026-08-18");
  assert.deepEqual(commits[0].files, ["api/checkout.py", "api/models/order.py"]);

  assert.equal(commits[1].type, "new feature");
  assert.deepEqual(commits[1].files, ["src/components/Cart.tsx"]);
});

test("a commit with no files listed still parses", () => {
  const commits = parseGitLog(logEntry("deadbeef1234", "2026-08-18T09:00:00Z", "chore: bump", []));
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].files, []);
  assert.equal(commits[0].type, "chore");
});

test("empty or malformed output yields no commits rather than throwing", () => {
  assert.deepEqual(parseGitLog(""), []);
  assert.deepEqual(parseGitLog(null), []);
  assert.deepEqual(parseGitLog(RECORD + "garbage-with-no-fields"), []);
});

test("conventional commit prefixes become plain words", () => {
  assert.equal(parseCommitType("feat: x"), "new feature");
  assert.equal(parseCommitType("fix(api): x"), "bug fix");
  assert.equal(parseCommitType("feat!: breaking"), "new feature");
  assert.equal(parseCommitType("docs: x"), "documentation");
});

test("a subject that isn't a conventional commit gets no invented label", () => {
  // Better to show the subject alone than to guess at a category for it.
  assert.equal(parseCommitType("made the thing work again"), null);
  assert.equal(parseCommitType("WIP"), null);
  assert.equal(parseCommitType(""), null);
  assert.equal(parseCommitType("nonsense: x"), null);
});

test("a path that is not a repository returns no commits, not an error", () => {
  assert.deepEqual(commitsInRange("/definitely/not/a/repo/anywhere", { sinceDay: "2026-01-01" }), []);
  assert.deepEqual(commitsInRange(null, {}), []);
});
