# Security Policy

## Reporting a vulnerability

Do not open a public issue for a security problem.

Report it privately through GitHub Security Advisories:
https://github.com/NapsterMayank/timesheet/security/advisories/new

Expect an initial reply within 7 days.

## What counts as a vulnerability here

This tool reads Claude Code session transcripts, which can contain source
code, file paths, command output, and secrets. Anything that causes that
data to leave the user's machine or become readable by another user or
process is in scope. Specifically:

- any outbound network request
- the dashboard becoming reachable from outside `127.0.0.1`
- the database or its directory being created with permissions that let
  other local users read it
- transcript content leaking into logs, error messages, or crash output
- a malicious `.jsonl` file causing code execution during a scan

## Subprocess execution

Since 0.2.0 the tool runs `git log` in your project directories to label work
with the commits it produced. Two things about that are worth stating plainly,
because they are the parts most likely to be got wrong:

- **Arguments are passed as an array, never through a shell.** A branch name,
  filename or author string containing a quote, semicolon or backtick is data,
  not something to execute. A report that this can be escaped is in scope.
- **The directory comes from the `cwd` field of a transcript.** That is a file
  on your disk written by Claude Code, but this tool does not verify it, so a
  hand-edited or planted `.jsonl` can point `git -C` at any path the user can
  already read. The consequence is running `git log` somewhere unintended, not
  running arbitrary code. If you find a way to turn it into more than that,
  report it.

`--no-git` disables the whole path.

## Stored prompts

Prompt capture (`AITIMESHEET_PROMPTS=1`) stores the first message of each
session in the local database. It is off by default, and everything else stored
is paths and numbers. Any way to make that data leave the machine, or to make
it readable by another local user, is in scope.

## Supported versions

Only the latest released version receives fixes.
