# Contributing

Thanks for taking a look.

## Setup

```bash
git clone https://github.com/NapsterMayank/timesheet.git
cd timesheet
npm install
node bin/aitimesheet.js report
```

Node 18 or newer.

## Testing against fake data

Don't test against your real `~/.claude` if you can avoid it. Point the tool
at a scratch directory instead:

```bash
AITIMESHEET_HOME=/tmp/ts-test AITIMESHEET_CLAUDE_DIR=/tmp/ts-test/.claude/projects \
  node bin/aitimesheet.js report
```

`AITIMESHEET_HOME` moves both the database and the default read path.
`AITIMESHEET_CLAUDE_DIR` overrides just the read path.

## Ground rules

- **No network calls.** This is the core promise of the project. A PR that
  adds any outbound request, telemetry, or update check will be closed.
- **No new dependencies** without a reason in the PR description. Every dep
  is code a user has to trust with their transcripts.
- The dashboard binds `127.0.0.1` deliberately. Don't change it to `0.0.0.0`.
- Match the surrounding style: ES modules, 2-space indent, no build step.

## Pull requests

- One change per PR.
- Say what you tested and on which OS + Node version.
- If you change how a transcript is parsed, include a sample line (with any
  real code or paths scrubbed) that motivated the change.

## Reporting bugs

Include your OS, Node version, the command you ran, and the full error.
Please scrub file paths and source snippets from anything you paste.

For security issues, see [SECURITY.md](SECURITY.md) instead of opening a
public issue.
