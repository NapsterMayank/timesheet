import Database from "better-sqlite3";
import { dbPath } from "./paths.js";

let _db = null;

export function getDb() {
  if (_db) return _db;
  _db = new Database(dbPath());
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS scanned_files (
      path TEXT PRIMARY KEY,
      offset INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      session_id TEXT NOT NULL,
      day TEXT NOT NULL,
      ts TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      is_subagent INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tool_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      session_id TEXT NOT NULL,
      day TEXT NOT NULL,
      ts TEXT,
      tool_name TEXT,
      is_subagent INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_events(day);
    CREATE INDEX IF NOT EXISTS idx_usage_project ON usage_events(project);
    CREATE INDEX IF NOT EXISTS idx_tool_day ON tool_events(day);
    CREATE INDEX IF NOT EXISTS idx_tool_project ON tool_events(project);
  `);
  return _db;
}

export function getFileOffset(path) {
  const row = getDb().prepare("SELECT offset FROM scanned_files WHERE path = ?").get(path);
  return row ? row.offset : 0;
}

export function setFileOffset(path, offset) {
  getDb()
    .prepare(
      `INSERT INTO scanned_files (path, offset) VALUES (?, ?)
       ON CONFLICT(path) DO UPDATE SET offset = excluded.offset`
    )
    .run(path, offset);
}

export function insertUsageEvent(ev) {
  getDb()
    .prepare(
      `INSERT INTO usage_events
       (project, session_id, day, ts, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, is_subagent)
       VALUES (@project, @session_id, @day, @ts, @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens, @is_subagent)`
    )
    .run(ev);
}

export function insertToolEvent(ev) {
  getDb()
    .prepare(
      `INSERT INTO tool_events (project, session_id, day, ts, tool_name, is_subagent)
       VALUES (@project, @session_id, @day, @ts, @tool_name, @is_subagent)`
    )
    .run(ev);
}

// One row per day across all projects, oldest first. Feeds the TUI sparkline.
export function getDailyTotals({ sinceDay } = {}) {
  const db = getDb();
  const params = sinceDay ? { sinceDay } : {};
  const where = sinceDay ? "day >= @sinceDay" : "1=1";

  const usage = db
    .prepare(
      `SELECT day,
              COUNT(DISTINCT session_id) AS agent_runs,
              SUM(input_tokens) AS tokens_in,
              SUM(output_tokens) AS tokens_out
       FROM usage_events
       WHERE ${where}
       GROUP BY day`
    )
    .all(params);

  const tools = db
    .prepare(
      `SELECT day, COUNT(*) AS tasks
       FROM tool_events
       WHERE ${where}
       GROUP BY day`
    )
    .all(params);

  const taskMap = new Map(tools.map((t) => [t.day, t.tasks]));

  return usage
    .map((u) => ({
      day: u.day,
      agentRuns: u.agent_runs,
      tasks: taskMap.get(u.day) || 0,
      totalTokens: (u.tokens_in || 0) + (u.tokens_out || 0),
    }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

// Which tools the agents actually reached for, most-used first.
export function getToolBreakdown({ sinceDay, limit = 8 } = {}) {
  const db = getDb();
  const params = { limit };
  let where = "tool_name IS NOT NULL";
  if (sinceDay) {
    where += " AND day >= @sinceDay";
    params.sinceDay = sinceDay;
  }

  return db
    .prepare(
      `SELECT tool_name AS tool, COUNT(*) AS count
       FROM tool_events
       WHERE ${where}
       GROUP BY tool_name
       ORDER BY count DESC
       LIMIT @limit`
    )
    .all(params)
    .map((r) => ({ tool: r.tool, count: r.count }));
}

// Summary: one row per project per day, for the report table and dashboard grid.
export function getSummary({ sinceDay, untilDay } = {}) {
  const db = getDb();
  const params = {};
  let where = "1=1";
  if (sinceDay) {
    where += " AND day >= @sinceDay";
    params.sinceDay = sinceDay;
  }
  if (untilDay) {
    where += " AND day <= @untilDay";
    params.untilDay = untilDay;
  }

  const usage = db
    .prepare(
      `SELECT project, day,
              COUNT(DISTINCT session_id) AS agent_runs,
              SUM(CASE WHEN is_subagent = 1 THEN 1 ELSE 0 END) > 0 AS has_subagents,
              SUM(input_tokens) AS tokens_in,
              SUM(output_tokens) AS tokens_out,
              SUM(cache_read_tokens) AS cache_read,
              SUM(cache_creation_tokens) AS cache_creation
       FROM usage_events
       WHERE ${where}
       GROUP BY project, day`
    )
    .all(params);

  const tools = db
    .prepare(
      `SELECT project, day, COUNT(*) AS tasks
       FROM tool_events
       WHERE ${where}
       GROUP BY project, day`
    )
    .all(params);

  const taskMap = new Map(tools.map((t) => [`${t.project}::${t.day}`, t.tasks]));

  return usage
    .map((u) => ({
      project: u.project,
      day: u.day,
      agentRuns: u.agent_runs,
      tasks: taskMap.get(`${u.project}::${u.day}`) || 0,
      tokensIn: u.tokens_in || 0,
      tokensOut: u.tokens_out || 0,
      cacheRead: u.cache_read || 0,
      cacheCreation: u.cache_creation || 0,
      totalTokens: (u.tokens_in || 0) + (u.tokens_out || 0),
    }))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.project.localeCompare(b.project)));
}
