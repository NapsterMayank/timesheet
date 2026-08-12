import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

// AITIMESHEET_HOME lets you point the whole tool at a fake home dir, mainly for
// testing. In real use it's always the real homedir.
function base() {
  return process.env.AITIMESHEET_HOME || homedir();
}

export function claudeProjectsDir() {
  // Claude Code always writes session transcripts here. This is the only
  // thing aitimesheet reads from.
  return process.env.AITIMESHEET_CLAUDE_DIR || join(base(), ".claude", "projects");
}

export function timesheetDir() {
  const dir = join(base(), ".aitimesheet");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbPath() {
  return join(timesheetDir(), "db.sqlite");
}
