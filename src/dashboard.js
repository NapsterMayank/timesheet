import express from "express";
import { getSummary } from "./db.js";
import { scan } from "./scanner.js";

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>aitimesheet</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f1115; color: #e6e6e6; margin: 0; padding: 32px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
  p.sub { color: #9aa0a6; margin: 0 0 24px; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #23262e; }
  th { color: #9aa0a6; font-weight: 500; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; }
  tr:hover td { background: #171a21; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .empty { color: #9aa0a6; padding: 40px 0; text-align: center; }
  .refresh { background: #23262e; border: none; color: #e6e6e6; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; }
  .refresh:hover { background: #2c303a; }
  .bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
</style>
</head>
<body>
  <div class="bar">
    <div>
      <h1>aitimesheet</h1>
      <p class="sub">Local Claude Code activity, read from ~/.claude/projects. Nothing leaves this machine.</p>
    </div>
    <button class="refresh" onclick="load()">Rescan</button>
  </div>
  <div id="root">Loading...</div>

<script>
async function load() {
  document.getElementById('root').textContent = 'Scanning...';
  const res = await fetch('/api/summary?days=14');
  const data = await res.json();
  render(data);
}

function render(rows) {
  const root = document.getElementById('root');
  if (!rows.length) {
    root.innerHTML = '<div class="empty">No Claude Code activity found yet.</div>';
    return;
  }
  const head = ['Day','Project','Agent Runs','Tasks','Tokens In','Tokens Out','Total Tokens'];
  const html = [
    '<table><thead><tr>' + head.map(h => '<th>'+h+'</th>').join('') + '</tr></thead><tbody>',
    rows.map(r => (
      '<tr>' +
      '<td>' + r.day + '</td>' +
      '<td>' + r.project + '</td>' +
      '<td class="num">' + r.agentRuns.toLocaleString() + '</td>' +
      '<td class="num">' + r.tasks.toLocaleString() + '</td>' +
      '<td class="num">' + r.tokensIn.toLocaleString() + '</td>' +
      '<td class="num">' + r.tokensOut.toLocaleString() + '</td>' +
      '<td class="num">' + r.totalTokens.toLocaleString() + '</td>' +
      '</tr>'
    )).join(''),
    '</tbody></table>'
  ].join('');
  root.innerHTML = html;
}

load();
</script>
</body>
</html>`;

export function startDashboard({ port = 4848 } = {}) {
  const app = express();

  app.get("/", (req, res) => {
    res.type("html").send(PAGE);
  });

  app.get("/api/summary", (req, res) => {
    scan(); // pick up anything new before answering
    const days = Number(req.query.days) || 14;
    const since = new Date();
    since.setDate(since.getDate() - (days - 1));
    const sinceDay = since.toISOString().slice(0, 10);
    res.json(getSummary({ sinceDay }));
  });

  const server = app.listen(port, "127.0.0.1", () => {
    console.log(`aitimesheet dashboard running at http://localhost:${port} (local only)`);
  });

  return server;
}
