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

## Supported versions

Only the latest released version receives fixes.
