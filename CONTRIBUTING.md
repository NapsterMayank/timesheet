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

## Running the tests

```bash
npm test
```

Plain `node --test`, no framework. The tests seed a throwaway database via
`AITIMESHEET_HOME` and never read your real transcripts.

The time-estimation logic in `src/timesheet.js` is the part that most needs
tests: it makes a claim about *hours*, and a wrong number there is worse than
no number at all. If you change how gaps, overlaps or classification work, the
PR needs a test that would fail without it.

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

## Releasing (maintainers)

Publishing is manual and deliberately not automated: an npm release can't be
taken back after 72 hours, and the package name is claimed forever.

```bash
# 1. Everything green and committed
npm test
git status                      # must be clean
git push origin main

# 2. Check what will actually ship
npm publish --dry-run
```

The dry-run output matters more than it looks. Confirm:

- **`bin` is not mentioned in any warning.** npm silently drops an invalid bin
  entry and publishes anyway, which produces a package that installs no
  command at all. This has happened once already.
- The file list carries `bin/`, `src/`, `README.md`, `LICENSE` and nothing
  else — no tests, no `docs/`, no `node_modules`.

```bash
# 3. Prove the tarball works before trusting it
npm pack
mkdir /tmp/pack-test && mv aitimesheet-*.tgz /tmp/pack-test/
cd /tmp/pack-test && npm init -y && npm install ./aitimesheet-*.tgz
./node_modules/.bin/aitimesheet --help
./node_modules/.bin/aitimesheet timesheet --days 1

# 4. Version, tag, publish
cd -                            # back to the repo
npm version patch               # or minor / major; this commits and tags
git push origin main --follow-tags
npm publish
```

`npm publish` prompts for a one-time password if the account has 2FA set to
`auth-and-writes` (check with `npm profile get`). The code comes from whichever
authenticator app was enrolled — npm never sends codes by SMS or email. To
publish non-interactively, pass it inline: `npm publish --otp=123456`.

Choosing the version bump:

- **patch** — bug fix that doesn't change any reported number
- **minor** — new command, new flag, new column
- **major** — reported hours or totals change for the same input. Users may be
  billing from these numbers; a total that moves is not a patch.

After publishing, check the npm page renders the README screenshots. They live
in `docs/` and are excluded from the tarball, so npm has to resolve the relative
paths against the GitHub repo. If they're broken, switch the README to absolute
`raw.githubusercontent.com` URLs.

## Reporting bugs

Include your OS, Node version, the command you ran, and the full error.
Please scrub file paths and source snippets from anything you paste.

For security issues, see [SECURITY.md](SECURITY.md) instead of opening a
public issue.
