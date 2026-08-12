import Table from "cli-table3";
import chalk from "chalk";
import { getSummary } from "./db.js";

function fmtNum(n) {
  return n.toLocaleString("en-US");
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export function printReport({ days = 1 } = {}) {
  const sinceDay = daysAgo(days - 1);
  const rows = getSummary({ sinceDay });

  if (rows.length === 0) {
    console.log(chalk.yellow("No Claude Code activity found for this range."));
    console.log(chalk.dim("Run `aitimesheet scan` after using Claude Code, or widen the range with --days."));
    return;
  }

  const table = new Table({
    head: ["Day", "Project", "Agent Runs", "Tasks", "New Input", "Output", "Real Work", "Cache Replay"].map(
      (h) => chalk.bold(h)
    ),
    style: { head: [], border: [] },
  });

  let totalRuns = 0;
  let totalTasks = 0;
  let totalTokens = 0;
  let totalCache = 0;

  for (const r of rows) {
    table.push([
      r.day,
      r.project,
      fmtNum(r.agentRuns),
      fmtNum(r.tasks),
      fmtNum(r.newIn),
      fmtNum(r.tokensOut),
      fmtNum(r.totalTokens),
      fmtNum(r.cacheRead),
    ]);
    totalRuns += r.agentRuns;
    totalTasks += r.tasks;
    totalTokens += r.totalTokens;
    totalCache += r.cacheRead;
  }

  console.log(table.toString());
  console.log(
    chalk.dim(
      `${rows.length} project-day rows, ${fmtNum(totalRuns)} agent runs, ${fmtNum(totalTasks)} tasks, ` +
        `${fmtNum(totalTokens)} tokens of real work.`
    )
  );
  console.log(
    chalk.dim(
      `Plus ${fmtNum(totalCache)} cache-replay tokens: context re-read every turn, billed at the ` +
        `cache rate, mostly the same bytes over and over.`
    )
  );
}
