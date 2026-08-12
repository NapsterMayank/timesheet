// Synthetic data for the README screenshots.
//
// The images in the README are generated from this, not from a real machine,
// so publishing them can't leak anyone's project or client names. The shapes
// are identical to what src/db.js returns, so the screenshots still show the
// real layout with realistic numbers.

const PROJECTS = [
  { project: "acme-checkout-api", runs: 41, tasks: 1284, tin: 402_000, tout: 2_640_000 },
  { project: "marketing-site", runs: 18, tasks: 517, tin: 151_000, tout: 890_000 },
  { project: "data-pipeline", runs: 12, tasks: 388, tin: 98_000, tout: 512_000 },
  { project: "mobile-app", runs: 9, tasks: 241, tin: 61_000, tout: 318_000 },
  { project: "infra-terraform", runs: 6, tasks: 132, tin: 34_000, tout: 171_000 },
  { project: "docs", runs: 3, tasks: 44, tin: 9_000, tout: 46_000 },
];

const DAYS = ["2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09", "2026-08-10", "2026-08-11"];
const DAY_WEIGHT = [0.42, 0.61, 0.55, 0.88, 1.0, 0.34, 0.72];

const TOOLS = [
  { tool: "Bash", count: 2140 },
  { tool: "Edit", count: 1663 },
  { tool: "Read", count: 1189 },
  { tool: "Write", count: 604 },
  { tool: "Grep", count: 331 },
  { tool: "Agent", count: 188 },
  { tool: "Glob", count: 141 },
  { tool: "WebFetch", count: 62 },
];

export function demoData({ days = 7 } = {}) {
  const dayList = DAYS.slice(-days);
  const weights = DAY_WEIGHT.slice(-days);
  // Always divide by the full-week weight, so a 1-day view shows one day's
  // slice of the totals rather than re-scaling to the whole week.
  const weightSum = DAY_WEIGHT.reduce((a, b) => a + b, 0);

  const rows = [];
  dayList.forEach((day, di) => {
    const share = weights[di] / weightSum;
    for (const p of PROJECTS) {
      const runs = Math.round(p.runs * share);
      if (runs === 0) continue;
      const tokensIn = Math.round(p.tin * share);
      const tokensOut = Math.round(p.tout * share);
      rows.push({
        project: p.project,
        day,
        agentRuns: runs,
        tasks: Math.round(p.tasks * share),
        tokensIn,
        tokensOut,
        cacheRead: 0,
        cacheCreation: 0,
        totalTokens: tokensIn + tokensOut,
      });
    }
  });

  const daily = dayList.map((day) => {
    const dayRows = rows.filter((r) => r.day === day);
    return {
      day,
      agentRuns: dayRows.reduce((a, r) => a + r.agentRuns, 0),
      tasks: dayRows.reduce((a, r) => a + r.tasks, 0),
      totalTokens: dayRows.reduce((a, r) => a + r.totalTokens, 0),
    };
  });

  const scale = days / DAYS.length;
  const tools = TOOLS.map((t) => ({ tool: t.tool, count: Math.round(t.count * scale) })).filter(
    (t) => t.count > 0
  );

  return { rows, daily, tools };
}
