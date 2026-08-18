#!/usr/bin/env node
import { scan } from "../src/scanner.js";
import { printReport } from "../src/report.js";
import { startDashboard } from "../src/dashboard.js";
import { startTui } from "../src/tui.js";
import { printTimesheet, timesheetCsv } from "../src/timesheet.js";

function getFlag(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const val = args[i + 1];
  return val !== undefined ? val : fallback;
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
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

    case "timesheet": {
      scan();
      const day = getFlag(rest, "day", null);
      const opts = {
        sinceDay: day || daysAgo(Number(getFlag(rest, "days", "1")) - 1),
        untilDay: day || undefined,
        project: getFlag(rest, "project", undefined),
        idleMinutes: Number(getFlag(rest, "idle", "15")),
      };
      if (hasFlag(rest, "csv")) console.log(timesheetCsv(opts));
      else printTimesheet(opts);
      break;
    }

    case "tui": {
      scan();
      startTui({ range: getFlag(rest, "range", "7") });
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
  aitimesheet tui [--range 1|7|3]  live dashboard in this terminal (default 7 days)
  aitimesheet scan                 scan ~/.claude/projects for new activity
  aitimesheet report [--days N]    print a table for the last N days (default 1)
  aitimesheet timesheet [options]  time and tasks per project per day
  aitimesheet dashboard [--port P] start the local web dashboard (default port 4848)

timesheet options:
  --day YYYY-MM-DD   a single day (default: today)
  --days N           the last N days instead of one
  --project NAME     only this project
  --idle M           gaps longer than M minutes count as breaks (default 15)
  --csv              emit CSV instead of a table

Everything is read from ~/.claude/projects and stored in ~/.aitimesheet/db.sqlite
on this machine only. Nothing is sent anywhere.`);
      // Asking for help is not an error. Anything else reaching here is.
      const askedForHelp = !cmd || cmd === "help" || cmd === "--help" || cmd === "-h";
      if (!askedForHelp) process.exitCode = 1;
    }
  }
}

main();
