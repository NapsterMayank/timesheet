import Database from "better-sqlite3";
import { dbPath } from "./paths.js";

// Bump when the schema changes. Everything here is derived from transcripts on
// disk, so a mismatch just drops the tables and rescans from scratch rather
// than migrating: the source of truth is never the database.
const SCHEMA_VERSION = 4;

let _db = null;

export function getDb() {
  if (_db) return _db;
  _db = new Database(dbPath());
  _db.pragma("journal_mode = WAL");

  _db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
  const row = _db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const current = row ? Number(row.value) : 0;

  if (current !== SCHEMA_VERSION) {
    _db.exec(`
      DROP TABLE IF EXISTS usage_events;
      DROP TABLE IF EXISTS tool_events;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS scanned_files;
    `);
    _db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION)
    );
  }

  _db.exec(`
    CREATE TABLE IF NOT EXISTS scanned_files (
      path TEXT PRIMARY KEY,
      offset INTEGER NOT NULL DEFAULT 0
    );

    -- One row per API message, NOT per transcript line. Claude Code splits a
    -- single message across several lines (one per content block) and repeats
    -- the same usage object on each, so a naive per-line insert counts the same
    -- tokens two or three times. UNIQUE(message_id) + INSERT OR IGNORE makes
    -- that impossible, and makes rescanning the same bytes harmless.
    CREATE TABLE IF NOT EXISTS usage_events (
      message_id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      session_id TEXT NOT NULL,
      day TEXT NOT NULL,
      ts TEXT,
      model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      is_subagent INTEGER NOT NULL DEFAULT 0
    );

    -- One row per tool call. message_id joins back to the usage row that paid
    -- for it. tool_index/tool_count describe how many tool calls shared that
    -- one message, so per-task cost can be split fairly.
    CREATE TABLE IF NOT EXISTS tool_events (
      tool_use_id TEXT PRIMARY KEY,
      message_id TEXT,
      project TEXT NOT NULL,
      session_id TEXT NOT NULL,
      day TEXT NOT NULL,
      ts TEXT,
      tool_name TEXT,
      target TEXT,
      subagent_type TEXT,
      is_subagent INTEGER NOT NULL DEFAULT 0
    );

    -- What you actually asked for, taken from the first real message you typed
    -- in a session. This is the only part of a transcript's prose that gets
    -- stored, it never leaves this machine, and AITIMESHEET_NO_PROMPTS=1 turns
    -- it off entirely.
    -- cwd is the real working directory, taken from the transcript rather than
    -- decoded from the project folder name. That name has had its separators
    -- flattened to dashes, so "D--personal-my-app" cannot be turned back into a
    -- path unambiguously. The transcript just tells us.
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      day TEXT NOT NULL,
      ts TEXT,
      title TEXT,
      cwd TEXT,
      branch TEXT,
      is_subagent INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_day ON sessions(day);
    CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_events(day);
    CREATE INDEX IF NOT EXISTS idx_usage_project ON usage_events(project);
    CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_day ON tool_events(day);
    CREATE INDEX IF NOT EXISTS idx_tool_project ON tool_events(project);
    CREATE INDEX IF NOT EXISTS idx_tool_message ON tool_events(message_id);
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
      `INSERT OR IGNORE INTO usage_events
       (message_id, project, session_id, day, ts, model, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, is_subagent)
       VALUES (@message_id, @project, @session_id, @day, @ts, @model, @input_tokens,
               @output_tokens, @cache_read_tokens, @cache_creation_tokens, @is_subagent)`
    )
    .run(ev);
}

export function insertToolEvent(ev) {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO tool_events
       (tool_use_id, message_id, project, session_id, day, ts, tool_name, target,
        subagent_type, is_subagent)
       VALUES (@tool_use_id, @message_id, @project, @session_id, @day, @ts, @tool_name,
               @target, @subagent_type, @is_subagent)`
    )
    .run(ev);
}

// Upsert rather than plain ignore, because the two things a session row holds
// arrive on different lines: cwd shows up on the first line that has it, the
// title only on the first thing you typed. COALESCE keeps whichever came first
// and lets the other fill in later.
export function insertSession(ev) {
  getDb()
    .prepare(
      `INSERT INTO sessions (session_id, project, day, ts, title, cwd, branch, is_subagent)
       VALUES (@session_id, @project, @day, @ts, @title, @cwd, @branch, @is_subagent)
       ON CONFLICT(session_id) DO UPDATE SET
         title  = COALESCE(title, excluded.title),
         cwd    = COALESCE(cwd, excluded.cwd),
         branch = COALESCE(branch, excluded.branch)`
    )
    .run({ title: null, cwd: null, branch: null, ...ev });
}

// Where each project actually lives on disk, so git can be asked about it.
// Most recent session wins if a project was ever opened from two places.
export function getProjectPaths() {
  return new Map(
    getDb()
      .prepare(
        `SELECT project, cwd FROM sessions
         WHERE cwd IS NOT NULL
         GROUP BY project
         HAVING ts = MAX(ts)`
      )
      .all()
      .map((r) => [r.project, r.cwd])
  );
}

// Session titles for a range, so a day can say what was asked for rather than
// only which directories were touched.
export function getSessionTitles({ sinceDay, untilDay, project } = {}) {
  const db = getDb();
  const { where, params } = whereDays({ sinceDay, untilDay });
  let filter = where;
  if (project) {
    filter += " AND project = @project";
    params.project = project;
  }

  return db
    .prepare(
      `SELECT session_id, project, day, ts, title, is_subagent
       FROM sessions
       WHERE ${filter} AND title IS NOT NULL AND title <> ''
       ORDER BY ts`
    )
    .all(params)
    .map((r) => ({
      sessionId: r.session_id,
      project: r.project,
      day: r.day,
      ts: r.ts,
      title: r.title,
      isSubagent: !!r.is_subagent,
    }));
}

// ---------------------------------------------------------------------------
// token accounting
//
// input_tokens is only the uncached sliver of the context. The bulk arrives as
// cache_read (context replayed from cache) and cache_creation (context written
// to cache). Reporting input_tokens alone understates what the model actually
// read by orders of magnitude, so "context in" sums all three.
// ---------------------------------------------------------------------------

function whereDays({ sinceDay, untilDay }, prefix = "") {
  const params = {};
  let where = "1=1";
  if (sinceDay) {
    where += ` AND ${prefix}day >= @sinceDay`;
    params.sinceDay = sinceDay;
  }
  if (untilDay) {
    where += ` AND ${prefix}day <= @untilDay`;
    params.untilDay = untilDay;
  }
  return { where, params };
}

// Token vocabulary, because the raw fields are easy to misread:
//
//   tokensIn       uncached input, usually tiny
//   cacheCreation  context written to cache, i.e. genuinely new input
//   cacheRead      context replayed from cache on every single turn. Enormous,
//                  and mostly the same bytes over and over.
//   tokensOut      what the model actually wrote
//
// newIn/newTotal describe real work and are what the UI leads with. processed
// adds cacheRead for the full billed volume, shown separately so a 12M-token
// week doesn't get reported as 681M.
function shapeUsageRow(u, tasks = 0) {
  const tokensIn = u.tokens_in || 0;
  const cacheRead = u.cache_read || 0;
  const cacheCreation = u.cache_creation || 0;
  const tokensOut = u.tokens_out || 0;
  const newIn = tokensIn + cacheCreation;
  return {
    agentRuns: u.agent_runs || 0,
    tasks,
    tokensIn,
    cacheRead,
    cacheCreation,
    newIn,
    tokensOut,
    totalTokens: newIn + tokensOut,
    processedTokens: newIn + cacheRead + tokensOut,
  };
}

// Summary: one row per project per day, for the report table and dashboard grid.
export function getSummary({ sinceDay, untilDay } = {}) {
  const db = getDb();
  const { where, params } = whereDays({ sinceDay, untilDay });

  const usage = db
    .prepare(
      `SELECT project, day,
              COUNT(DISTINCT session_id) AS agent_runs,
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
      ...shapeUsageRow(u, taskMap.get(`${u.project}::${u.day}`) || 0),
    }))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.project.localeCompare(b.project)));
}

// One row per day across all projects, oldest first. Feeds the TUI sparkline.
export function getDailyTotals({ sinceDay } = {}) {
  const db = getDb();
  const { where, params } = whereDays({ sinceDay });

  const usage = db
    .prepare(
      `SELECT day,
              COUNT(DISTINCT session_id) AS agent_runs,
              SUM(input_tokens) AS tokens_in,
              SUM(output_tokens) AS tokens_out,
              SUM(cache_read_tokens) AS cache_read,
              SUM(cache_creation_tokens) AS cache_creation
       FROM usage_events
       WHERE ${where}
       GROUP BY day`
    )
    .all(params);

  const tools = db
    .prepare(`SELECT day, COUNT(*) AS tasks FROM tool_events WHERE ${where} GROUP BY day`)
    .all(params);
  const taskMap = new Map(tools.map((t) => [t.day, t.tasks]));

  return usage
    .map((u) => ({ day: u.day, ...shapeUsageRow(u, taskMap.get(u.day) || 0) }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

// Which tools the agents reached for, and what each one cost.
//
// A single message can emit several tool calls, and its usage covers all of
// them, so the cost is divided evenly across the tool calls that shared it.
// That's an allocation, not a measurement: the API doesn't bill per tool call.
export function getToolBreakdown({ sinceDay, untilDay, project, limit = 8 } = {}) {
  const db = getDb();
  const { where, params } = whereDays({ sinceDay, untilDay }, "t.");
  let filter = where;
  if (project) {
    filter += " AND t.project = @project";
    params.project = project;
  }
  params.limit = limit;

  return db
    .prepare(
      `WITH shares AS (
         SELECT message_id, COUNT(*) AS n FROM tool_events GROUP BY message_id
       )
       SELECT t.tool_name AS tool,
              COUNT(*) AS count,
              COALESCE(SUM(
                (u.input_tokens + u.cache_creation_tokens + u.output_tokens) * 1.0 / s.n
              ), 0) AS tokens
       FROM tool_events t
       LEFT JOIN usage_events u ON u.message_id = t.message_id
       LEFT JOIN shares s ON s.message_id = t.message_id
       WHERE ${filter} AND t.tool_name IS NOT NULL
       GROUP BY t.tool_name
       ORDER BY count DESC
       LIMIT @limit`
    )
    .all(params)
    .map((r) => ({ tool: r.tool, count: r.count, tokens: Math.round(r.tokens || 0) }));
}

// One row per session (a main agent run or a single subagent transcript).
export function getAgentRuns({ sinceDay, untilDay, project, limit = 10 } = {}) {
  const db = getDb();
  const { where, params } = whereDays({ sinceDay, untilDay });
  let filter = where;
  if (project) {
    filter += " AND project = @project";
    params.project = project;
  }

  const usage = db
    .prepare(
      `SELECT session_id, project, is_subagent,
              MIN(ts) AS started, MAX(ts) AS ended, MAX(model) AS model,
              SUM(input_tokens) AS tokens_in,
              SUM(output_tokens) AS tokens_out,
              SUM(cache_read_tokens) AS cache_read,
              SUM(cache_creation_tokens) AS cache_creation
       FROM usage_events
       WHERE ${filter}
       GROUP BY session_id`
    )
    .all(params);

  const tools = db
    .prepare(`SELECT session_id, COUNT(*) AS tasks FROM tool_events WHERE ${filter} GROUP BY session_id`)
    .all(params);
  const taskMap = new Map(tools.map((t) => [t.session_id, t.tasks]));

  return usage
    .map((u) => ({
      sessionId: u.session_id,
      project: u.project,
      isSubagent: !!u.is_subagent,
      model: u.model,
      started: u.started,
      ended: u.ended,
      ...shapeUsageRow(u, taskMap.get(u.session_id) || 0),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, limit);
}

// Every timestamped event in one ordered stream, which is what the timesheet
// needs to reconstruct a working day. Tool events carry what was worked on;
// usage events carry no target but still mark "the agent was busy here", so
// they keep the timeline dense between tool calls and stop a long thinking
// stretch from looking like idle time.
export function getRawEvents({ sinceDay, untilDay, project } = {}) {
  const db = getDb();
  // Two aliased copies of the same conditions. Prefixing the column names by
  // hand rather than rewriting the finished clause, because a find-and-replace
  // over the SQL also mangles the @project placeholder into @t.project.
  const t = whereDays({ sinceDay, untilDay }, "t.");
  const u = whereDays({ sinceDay, untilDay }, "u.");
  const params = { ...t.params };
  let toolFilter = t.where;
  let usageFilter = u.where;
  if (project) {
    toolFilter += " AND t.project = @project";
    usageFilter += " AND u.project = @project";
    params.project = project;
  }

  // Tokens ride along with the events so a work item can report what it cost as
  // well as how long it took.
  //
  // A message's tokens are split evenly across the tool calls it fired, exactly
  // as getToolBreakdown does. That's an allocation, not a measurement: the API
  // bills per message, not per tool call. Messages that fired no tools carry
  // their tokens on the usage row instead, and the CASE below is what stops
  // those two paths from counting the same tokens twice.
  return db
    .prepare(
      `WITH shares AS (
         SELECT message_id, COUNT(*) AS n FROM tool_events GROUP BY message_id
       )
       SELECT t.day, t.project, t.session_id, t.ts, t.tool_name, t.target, t.is_subagent,
              COALESCE(
                (u.input_tokens + u.cache_creation_tokens + u.output_tokens) * 1.0 / s.n, 0
              ) AS tokens
       FROM tool_events t
       LEFT JOIN usage_events u ON u.message_id = t.message_id
       LEFT JOIN shares s ON s.message_id = t.message_id
       WHERE ${toolFilter} AND t.ts IS NOT NULL

       UNION ALL

       SELECT u.day, u.project, u.session_id, u.ts, NULL AS tool_name, NULL AS target,
              u.is_subagent,
              CASE WHEN s.n IS NULL
                   THEN (u.input_tokens + u.cache_creation_tokens + u.output_tokens)
                   ELSE 0 END AS tokens
       FROM usage_events u
       LEFT JOIN shares s ON s.message_id = u.message_id
       WHERE ${usageFilter} AND u.ts IS NOT NULL

       ORDER BY ts`
    )
    .all(params)
    .map((e) => ({
      day: e.day,
      project: e.project,
      sessionId: e.session_id,
      ts: e.ts,
      toolName: e.tool_name,
      target: e.target,
      tokens: e.tokens || 0,
      isSubagent: !!e.is_subagent,
    }));
}

// Tokens grouped by model, which is what a cost breakdown needs.
export function getModelBreakdown({ sinceDay, untilDay, project } = {}) {
  const db = getDb();
  const { where, params } = whereDays({ sinceDay, untilDay });
  let filter = where;
  if (project) {
    filter += " AND project = @project";
    params.project = project;
  }

  return db
    .prepare(
      `SELECT COALESCE(model, 'unknown') AS model,
              COUNT(*) AS messages,
              SUM(input_tokens) AS tokens_in,
              SUM(output_tokens) AS tokens_out,
              SUM(cache_read_tokens) AS cache_read,
              SUM(cache_creation_tokens) AS cache_creation
       FROM usage_events
       WHERE ${filter}
       GROUP BY model`
    )
    .all(params)
    .map((m) => ({ model: m.model, messages: m.messages, ...shapeUsageRow(m) }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}
