# aitimesheet

A local, private timesheet for Claude Code agents. Answers: how many agent
sessions ran today, how many tasks they did, how many tokens they used.

Everything is read from `~/.claude/projects` (where Claude Code already
stores session transcripts on your machine) and stored in
`~/.aitimesheet/db.sqlite`, also on your machine. Nothing is sent anywhere.
No server, no signup, no OTel setup.

## Install

```bash
npm install -g aitimesheet
```

Or run without installing globally:

```bash
npx aitimesheet report
```

Or from source:

```bash
git clone https://github.com/NapsterMayank/timesheet.git
cd timesheet
npm install
node bin/aitimesheet.js report
```

Requires Node 18+. `better-sqlite3` is a native module: on most systems npm
downloads a prebuilt binary, but if your platform or Node version has no
prebuild it compiles from source and needs a build toolchain (on Windows,
Visual Studio Build Tools with the C++ workload; on Linux, `build-essential`
and `python3`).

## Usage

```bash
aitimesheet scan                 # scan ~/.claude/projects for new activity
aitimesheet report                # table for today
aitimesheet report --days 7       # table for the last 7 days
aitimesheet dashboard              # local web dashboard at localhost:4848
aitimesheet dashboard --port 5050  # custom port
```

`scan` runs automatically before `report` and `dashboard`, so you usually
don't need to call it directly. It's incremental: only new lines since the
last run are read, so it stays fast even with a large session history.

## What counts as what

- **Agent run**: one Claude Code session file (`<session-id>.jsonl`).
  Subagent transcripts under a session's `subagents/` folder count as their
  own runs too, so a session that spun up 3 subagents shows as 4 runs.
- **Task**: one tool call (`tool_use` block) anywhere in the transcript,
  Read, Edit, Bash, Grep, whatever the agent invoked.
- **Tokens**: summed straight from each assistant message's `usage` field,
  input and output tracked separately. Cache read/creation tokens are
  captured too but not shown in the terminal table (visible in the sqlite
  db if you want them).

## Why local-only

Session transcripts can contain source code, file paths, and command
output. A tool that phones this home to a third-party server is a hard
sell for most teams, and shouldn't be trusted by default.

Concretely, `aitimesheet`:

- reads only `~/.claude/projects/**/*.jsonl`
- writes only `~/.aitimesheet/db.sqlite`
- makes no network requests of any kind
- binds the dashboard to `127.0.0.1` only, so it isn't reachable from
  other machines on your network

It's a few hundred lines. Read `src/` and verify all of the above yourself.

## Roadmap (not in this version)

- A small importable logger for agents built directly on the Claude
  Agent SDK / API (which don't write to `~/.claude/projects`), so
  usage from custom agents lands in the same local database.
- Per-model and per-cost breakdowns.
- CSV export.

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
