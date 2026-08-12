#!/usr/bin/env node
import { scan } from "../src/scanner.js";
import { printReport } from "../src/report.js";
import { startDashboard } from "../src/dashboard.js";

function getFlag(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const val = args[i + 1];
  return val !== undefined ? val : fallback;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;

  switch (cmd) {
    case "scan": {
      const result = scan();
      console.log(
        `scanned ${result.filesScanned}/${result.filesFound} files, ${result.linesProcessed} new lines processed`
      );
      break;
    }

    case "report": {
      scan();
      const days = Number(getFlag(rest, "days", "1"));
      printReport({ days });
      break;
    }

    case "dashboard": {
      scan();
      const port = Number(getFlag(rest, "port", "4848"));
      startDashboard({ port });
      break;
    }

    default: {
      console.log(`aitimesheet - local, private usage tracker for Claude Code

Usage:
  aitimesheet scan                 scan ~/.claude/projects for new activity
  aitimesheet report [--days N]    print a table for the last N days (default 1)
  aitimesheet dashboard [--port P] start the local dashboard (default port 4848)

Everything is read from ~/.claude/projects and stored in ~/.aitimesheet/db.sqlite
on this machine only. Nothing is sent anywhere.`);
      if (cmd) process.exitCode = 1;
    }
  }
}

main();
