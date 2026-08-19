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
      const newIn = Math.round(p.tin * share);
      const tokensOut = Math.round(p.tout * share);
      // Cache replay dwarfs real work in practice, roughly 20-100x. The demo
      // keeps that ratio so the screenshots don't imply a tidier picture than
      // the tool actually shows.
      const cacheRead = newIn * 42;
      rows.push({
        project: p.project,
        day,
        agentRuns: runs,
        tasks: Math.round(p.tasks * share),
        tokensIn: Math.round(newIn * 0.01),
        cacheCreation: Math.round(newIn * 0.99),
        newIn,
        cacheRead,
        tokensOut,
        totalTokens: newIn + tokensOut,
        processedTokens: newIn + cacheRead + tokensOut,
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
  const tools = TOOLS.map((t) => ({
    tool: t.tool,
    count: Math.round(t.count * scale),
    tokens: Math.round(t.count * scale * 1850),
  })).filter((t) => t.count > 0);

  const totalWork = rows.reduce((a, r) => a + r.totalTokens, 0);
  const agents = [
    { sessionId: "a41f9c2e-checkout-refactor", isSubagent: false, share: 0.34, tasks: 412 },
    { sessionId: "c77b0d15-schema-migration", isSubagent: false, share: 0.24, tasks: 288 },
    { sessionId: "agent-explore-b3d9", isSubagent: true, share: 0.18, tasks: 205 },
    { sessionId: "e903a7f4-landing-copy", isSubagent: false, share: 0.14, tasks: 161 },
    { sessionId: "agent-review-1a2c", isSubagent: true, share: 0.1, tasks: 118 },
  ].map((a) => ({
    ...a,
    tasks: Math.max(1, Math.round(a.tasks * scale)),
    totalTokens: Math.round(totalWork * a.share),
  }));

  // Timesheet rows, in the shape buildTimesheet() returns. Hours are derived
  // from the day's task count at a plausible few minutes per task, so the
  // screenshots show a believable working day rather than a rounded fiction.
  const WORK_ITEMS = {
    "acme-checkout-api": [
      { label: "api/checkout", weight: 0.34, files: ["session.py", "webhooks.py", "refunds.py"] },
      { label: "pytest commands", weight: 0.24, files: [] },
      { label: "api/models", weight: 0.18, files: ["order.py", "payment.py"] },
      { label: "git commands", weight: 0.13, files: [] },
      { label: "shell commands", weight: 0.11, files: [] },
    ],
    "marketing-site": [
      { label: "site/pages", weight: 0.42, files: ["pricing.tsx", "index.tsx"] },
      { label: "npm commands", weight: 0.31, files: [] },
      { label: "site/components", weight: 0.27, files: ["Hero.tsx", "Nav.tsx"] },
    ],
    "data-pipeline": [
      { label: "pipeline/jobs", weight: 0.48, files: ["ingest.py", "transform.py"] },
      { label: "docker commands", weight: 0.29, files: [] },
      { label: "searching the codebase", weight: 0.23, files: [] },
    ],
  };
  const DEFAULT_ITEMS = [
    { label: "shell commands", weight: 0.55, files: [] },
    { label: "searching the codebase", weight: 0.45, files: [] },
  ];

  const sheet = rows.map((r) => {
    const activeMs = Math.round(r.tasks * 2.4 * 60_000);
    const items = (WORK_ITEMS[r.project] || DEFAULT_ITEMS).map((it) => ({
      label: it.label,
      ms: Math.round(activeMs * it.weight),
      calls: Math.max(1, Math.round(r.tasks * it.weight)),
      files: it.files,
    }));
    return {
      day: r.day,
      project: r.project,
      activeMs,
      overlapMs: 0,
      tasks: r.tasks,
      sessions: r.agentRuns,
      firstTs: `${r.day}T09:12:00.000Z`,
      lastTs: `${r.day}T17:48:00.000Z`,
      totalTokens: r.totalTokens,
      items,
    };
  });

  return { rows, daily, tools, agents, sheet };
}
