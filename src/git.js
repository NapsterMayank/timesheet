import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Reading what actually shipped.
//
// Classification can say a day was "Backend work". Only the commit message can
// say it was "fix: null deref in checkout". That line is written by a person,
// about the work, at the time of the work, so it needs no inference at all —
// which makes it the best label this tool can put on a timesheet.
//
// Everything here is a local, read-only `git log`. Arguments are passed as an
// array, never through a shell, so a branch or path containing a quote or a
// semicolon is data rather than something to execute. Any failure — git not
// installed, not a repository, a path that no longer exists — degrades to no
// commits rather than an error, because a timesheet is still useful without
// them.
// ---------------------------------------------------------------------------

const RECORD = "\x1e"; // between commits
const FIELD = "\x1f"; // between fields of one commit

// Conventional-commit prefixes, mapped to what they mean in plain words.
// Anything else keeps its subject and gets no activity label, rather than
// being force-fitted into a category it may not belong in.
const COMMIT_TYPES = {
  feat: "new feature",
  fix: "bug fix",
  perf: "performance",
  refactor: "refactor",
  test: "testing",
  docs: "documentation",
  build: "build",
  ci: "CI",
  chore: "chore",
  style: "styling",
  revert: "revert",
};

export function parseCommitType(subject) {
  const m = /^(\w+)(\([^)]*\))?!?:\s*/.exec(subject || "");
  if (!m) return null;
  return COMMIT_TYPES[m[1].toLowerCase()] || null;
}

// Parse the raw `git log` output. Split out from the command itself so the
// parsing can be tested without needing a repository on disk.
export function parseGitLog(raw) {
  if (!raw) return [];

  return raw
    .split(RECORD)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [header, ...fileLines] = chunk.split("\n");
      const [hash, isoDate, subject] = header.split(FIELD);
      if (!hash || !subject) return null;
      return {
        hash: hash.slice(0, 8),
        date: isoDate || null,
        day: (isoDate || "").slice(0, 10),
        subject: subject.trim(),
        type: parseCommitType(subject),
        files: fileLines.map((f) => f.trim()).filter(Boolean),
      };
    })
    .filter(Boolean);
}

function git(repoPath, args) {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
}

// Commits in a date range, by default only the ones you wrote. On a shared
// branch, a colleague's commits are their timesheet, not yours.
export function commitsInRange(repoPath, { sinceDay, untilDay, mine = true } = {}) {
  if (!repoPath) return [];

  let author = null;
  if (mine) {
    try {
      author = git(repoPath, ["config", "user.email"]).trim() || null;
    } catch {
      author = null; // unset, or not a repository; fall through to all authors
    }
  }

  const args = [
    "log",
    "--no-merges",
    `--pretty=format:${RECORD}%H${FIELD}%aI${FIELD}%s`,
    "--name-only",
  ];
  if (sinceDay) args.push(`--since=${sinceDay}T00:00:00`);
  // `--until` is exclusive of anything later in the day, so push it to the end
  // of the day rather than dropping every commit made after midnight-plus-one.
  if (untilDay) args.push(`--until=${untilDay}T23:59:59`);
  if (author) args.push(`--author=${author}`);

  try {
    return parseGitLog(git(repoPath, args));
  } catch {
    return []; // no git, no repo, no history: the timesheet survives without it
  }
}
