# Changelog

Notable changes per release. Dates are the publish date on npm.

The rule this project follows for version bumps: if the **hours or totals it
reports change for the same input**, that's a major or minor bump, never a
patch. People may be billing from these numbers, and a total that silently
moves is not a bug fix.

## 0.2.0 — 2026-08-20

The release that turned a token counter into an actual timesheet.

### Added

- **`aitimesheet timesheet`** — time and tasks per project per day, the thing
  you'd copy onto a real timesheet. `--day`, `--days`, `--project`, `--idle`,
  `--overlap`, `--no-git`, `--prompts`, `--csv`.
- **Time attribution.** Reconstructed gap by gap between consecutive events.
  Gaps longer than `--idle` (default 15 minutes) are dropped whole rather than
  clamped, because clamping invents time every time you step away.
- **Work classification.** Files and commands are grouped into work anyone can
  read — Backend work, Frontend work, Testing, Database & migrations,
  Infrastructure & deployment, Documentation, Version control — with the files
  and commands kept as evidence. Intent is never guessed: nothing in a
  transcript separates writing a new endpoint from fixing a broken one.
- **Git commit correlation.** Commits in the range are read with a local
  read-only `git log` and hung off the work items whose files they touched, so
  a line reads `Backend work ↳ fix: null deref in checkout`. Only your own
  commits, matched on the repository's `user.email`. `--no-git` skips it.
- **Tokens per task**, not just per day. A message's tokens are split across
  the tool calls it fired — an allocation, not a measurement, since the API
  bills per message.
- **CSV export** via `--csv`, one row per work item with day totals repeated.
- **TUI drill-down.** Arrow keys select a project, enter opens its timesheet as
  a table, escape backs out. The projects list gained a time column.
- **Optional prompt capture.** Off by default: `AITIMESHEET_PROMPTS=1` to
  record the first message of each session, `--prompts` to display it.
- **Tests** (`npm test`) and a CI workflow covering three platforms and three
  Node versions, plus a job that installs the packed tarball and runs it.

### Fixed

- **Time worked on two projects at once was counted twice.** Each project-day
  had its own timeline, so an hour spent switching between two projects was
  billed to both. Overlapping time is now shared out evenly by a sweep line, so
  per-project rows add up to the day instead of exceeding it. On three days of
  real data this moved a total from 10h36m to 9h28m. `--overlap keep` restores
  the old behaviour.
- **`--project` crashed with a SQL syntax error.** Table aliases were applied by
  rewriting the finished `WHERE` clause, which also mangled the `@project`
  placeholder into `@t.project`.
- **`--help` exited 1**, so it read as a failure to shells and CI.
- Work items under a minute displayed as `0m`; they now show seconds.

### Changed

- Session titles are keyed by session rather than by date, so a session running
  past midnight still explains the work on the far side of it.
- The "reads only `~/.claude/projects`" claim in the README now also mentions
  the local `git log`, since that is no longer strictly true.

### Notes

Database schema moved to v4. There is no migration by design — the schema is
dropped and rebuilt from the transcripts, which are the source of truth. First
run after upgrading rescans everything.

## 0.1.0 — 2026-08-19

First public release.

- `scan`, `report`, `dashboard`, and a live `tui`.
- Incremental transcript scanning, keyed on `message.id` and `tool_use.id` so
  rescans and Claude Code's multi-line messages can't double count.
- Token accounting that separates genuinely new input from cache replay,
  instead of reporting a 12M-token week as 680M.
- Per-task and per-agent cost.

### Fixed before publish

- `bin` was declared as `./bin/aitimesheet.js`, which npm silently drops at
  publish time. The published package would have installed no command at all.
