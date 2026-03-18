# TRD — ClaudeVault: File Pipeline & Session Continuity System

**Version:** 0.1.0  
**Status:** Draft  
**Depends on:** PRD v0.1.0  
**Last Updated:** 2026-03-18

---

## 1. System Overview

ClaudeVault is a **local, event-driven file pipeline** that runs as a background service on macOS. It watches a target directory (typically `~/Downloads`), ingests stabilized files, hashes and moves them into a structured project store, links them to Claude sessions, and surfaces them as suggestions when a new session begins.

It does not interact with Claude's API. It does not modify the Claude web interface. It is a local utility.

---

## 2. Architecture

```
┌────────────────────────────────────────────────────────┐
│                      ClaudeVault                    │
│                                                        │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────┐ │
│  │  FileWatcher │───▶│  Ingestion   │───▶│    DB    │ │
│  │  (chokidar)  │    │   Pipeline   │    │ (SQLite) │ │
│  └──────────────┘    └──────┬───────┘    └────┬─────┘ │
│                             │                 │        │
│                    ┌────────▼───────┐  ┌──────▼─────┐ │
│                    │ Session Linker │  │  Cleanup   │ │
│                    └────────┬───────┘  │  Scheduler │ │
│                             │          └────────────┘ │
│                    ┌────────▼───────┐                  │
│                    │  Suggestion    │                  │
│                    │    Engine      │                  │
│                    └────────────────┘                  │
└────────────────────────────────────────────────────────┘
```

---

## 3. File Pipeline — Stage-by-Stage

### Stage 1: Detection

**Implementation:** `chokidar` (not `fs.watch`)

**Why not `fs.watch`:**
- `fs.watch` on macOS wraps FSEvents but does not debounce reliably
- `fs.watch` does not detect renames correctly in all cases
- `chokidar` handles partial download detection, symlinks, and network volumes correctly
- `chokidar` has a stable `awaitWriteFinish` option — critical for this use case

```js
const watcher = chokidar.watch(WATCH_DIR, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 2000,  // 2s of no size change
    pollInterval: 500
  },
  ignored: [
    /\.crdownload$/,   // Chrome partial downloads
    /\.part$/,         // Firefox partial downloads
    /\.download$/,     // Safari partial downloads
    /(^|[\/\\])\../   // Hidden files
  ]
});
```

**Stabilization check (belt-and-suspenders, run after `add` event fires):**

```js
async function isFileStable(filePath, checkIntervalMs = 500, requiredStableChecks = 3) {
  let lastSize = -1;
  let stableCount = 0;

  while (stableCount < requiredStableChecks) {
    await sleep(checkIntervalMs);
    const { size } = await fs.stat(filePath);
    if (size === lastSize) {
      stableCount++;
    } else {
      stableCount = 0;
      lastSize = size;
    }
  }
  return true;
}
```

---

### Stage 2: Validation

Before any move or DB write:

1. File exists and is readable
2. File size > 0
3. Extension is in the configured allowlist (or allowlist is disabled)
4. File is not already tracked (check hash against DB)

If any check fails: log to `file_events` with event type `REJECTED` + reason. Never silently discard.

---

### Stage 3: Hashing

**Algorithm:** SHA-256 (not MD5 — MD5 has known collisions; not acceptable for deduplication logic)

```js
const crypto = require('crypto');
const fs = require('fs');

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
```

**Deduplication check:**

```js
const existing = db.prepare('SELECT file_id FROM files WHERE hash = ?').get(fileHash);
if (existing) {
  linkExistingFile(existing.file_id, currentSessionId);
  logEvent(existing.file_id, 'DEDUPLICATED');
  return; // Do not copy the file again
}
```

---

### Stage 4: Move & Rename

**Target path structure:**

```
~/Downloads/claudevault/
  projects/
    {project_id}/
      sessions/
        {session_id}/
          files/
          images/
          summary.txt
          metadata.json
  unlinked/
    {YYYY-MM-DD}/
  logs/
  archive/
```

**Rename format:**

```
{original_stem}_{YYYYMMDD_HHmmss}_{8char_hash_prefix}{ext}
```

Example: `model_results_20260318_142301_a3f9c1b2.csv`

**Why:** Prevents collisions. Makes files sortable. Preserves original name for suggestion matching.

**Use `fs.rename` only if same filesystem. Otherwise `fs.copyFile` + `fs.unlink`:**

```js
async function moveFile(src, dest) {
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if (err.code === 'EXDEV') {
      // Cross-device move
      await fs.copyFile(src, dest);
      await fs.unlink(src);
    } else {
      throw err;
    }
  }
}
```

---

### Stage 5: DB Write

Two writes, in order. Both must succeed or both are rolled back.

```js
db.transaction(() => {
  db.prepare(`
    INSERT INTO files (file_id, file_name, file_path, hash, file_type, created_at, linked_session_id, project_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(fileId, fileName, filePath, hash, fileType, Date.now(), sessionId ?? null, projectId ?? null);

  db.prepare(`
    INSERT INTO file_events (file_id, event_type, timestamp)
    VALUES (?, 'CREATED', ?)
  `).run(fileId, Date.now());
})();
```

---

## 4. Session State Detection — CRITICAL OPEN PROBLEM

**This is the most architecturally unresolved part of the system.**

The source document states that files should be linked to a session when its state is `NEAR_LIMIT` or `FINAL_WINDOW`. But it does not specify how those states are detected.

**Claude has no public API that exposes session token count.**  
There is no webhook. There is no polling endpoint.

### Option A: Playwright-based DOM scraping (High risk)

Read the Claude web UI's message count or a UI indicator if one exists.

**Problems:**
- Claude's UI has no stable public indicator of context usage
- Breaks on any UI update
- Requires a running browser process
- Brittle by definition

**Verdict:** Do not build on this. It will break and it is not a solution.

---

### Option B: User-triggered state signal (Pragmatic)

The user explicitly triggers `NEAR_LIMIT` state via a hotkey, tray menu action, or CLI command.

```bash
claudevault session set-state NEAR_LIMIT
```

**Problems:**
- Requires user awareness and action
- Defeats the goal of automation

**Verdict:** Acceptable as a v1 fallback only. Must be documented as a limitation, not a feature.

---

### Option C: Message-count heuristic (Reasonable approximation)

The system counts user-initiated uploads and messages within a session window, and applies a threshold.

**Heuristic:**
- Session starts when user opens `claude.ai`
- Every N minutes of activity = session still active
- After M messages (configurable, default 20), state = `NEAR_LIMIT`
- After P messages (configurable, default 30), state = `FINAL_WINDOW`

**Problems:**
- Message count ≠ token count
- Different conversations hit limits at different message counts depending on file size
- Will produce false positives and false negatives

**Verdict:** Better than Option A. Acceptable only if thresholds are configurable and the user is shown the current state at all times.

---

### Option D: File-download burst as proxy signal (Interesting heuristic)

When multiple files are downloaded in a short time window (e.g., 3 files in 5 minutes), infer the session is concluding and auto-link recent files.

**Verdict:** A useful secondary signal. Not sufficient on its own.

---

### ⚠️ Decision Required Before Build

This problem must be solved before writing session-linking code. Proceeding without a resolved detection mechanism produces a system that links files to sessions incorrectly — which corrupts the entire value proposition.

**Recommendation:** Implement Option B (manual signal) for v1 with Option C as a configurable overlay. Revisit when/if Claude exposes session metadata.

---

## 5. Database Schema

**Engine:** SQLite via `better-sqlite3` (synchronous API — do not use `sqlite3` async driver for this use case; the synchronous model is safer inside an event pipeline)

---

### TABLE: sessions

```sql
CREATE TABLE sessions (
  session_id   TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  state        TEXT NOT NULL DEFAULT 'ACTIVE',
  -- ACTIVE | NEAR_LIMIT | FINAL_WINDOW | CLOSED
  summary_path TEXT
);
```

---

### TABLE: files

```sql
CREATE TABLE files (
  file_id          TEXT PRIMARY KEY,
  file_name        TEXT NOT NULL,
  original_name    TEXT NOT NULL,       -- preserved for suggestion matching
  file_path        TEXT NOT NULL,
  hash             TEXT NOT NULL UNIQUE,
  file_type        TEXT,
  size_bytes       INTEGER,
  created_at       INTEGER NOT NULL,
  linked_session_id TEXT,               -- NULL = unlinked
  project_id       TEXT,
  FOREIGN KEY (linked_session_id) REFERENCES sessions(session_id)
);

CREATE INDEX idx_files_hash ON files(hash);
CREATE INDEX idx_files_session ON files(linked_session_id);
CREATE INDEX idx_files_project ON files(project_id);
```

---

### TABLE: file_events

```sql
CREATE TABLE file_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  -- CREATED | MOVED | LINKED | DEDUPLICATED | REJECTED | REASSIGNED | ARCHIVED | DELETED
  detail      TEXT,                     -- JSON blob for extra context
  timestamp   INTEGER NOT NULL,
  FOREIGN KEY (file_id) REFERENCES files(file_id)
);

CREATE INDEX idx_events_file ON file_events(file_id);
CREATE INDEX idx_events_time ON file_events(timestamp);
```

---

### TABLE: projects

```sql
CREATE TABLE projects (
  project_id   TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_active  INTEGER
);
```

---

### TABLE: cleanup_log

```sql
CREATE TABLE cleanup_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL,
  action      TEXT NOT NULL,  -- DELETED | ARCHIVED | KEPT | SKIPPED
  triggered_at INTEGER NOT NULL,
  resolved_at  INTEGER
);
```

---

## 6. File Suggestion Engine

### Input

- Current project context (project_id if known)
- Last session's summary (parsed for filenames)
- DB query: files linked to sessions in the same project

### Scoring

```js
function scoreFile(candidate, context) {
  const filenameSim = jaccardSimilarity(
    tokenize(candidate.original_name),
    tokenize(context.recentFileNames)
  );

  const recencyScore = 1 / (1 + hoursAgo(candidate.created_at));

  const sessionOverlapScore = candidate.sharedSessionCount / context.totalSessions;

  return (
    0.5 * filenameSim +
    0.3 * recencyScore +
    0.2 * sessionOverlapScore
  );
}
```

**Tokenization:** Split on `_`, `-`, `.`, spaces. Lowercase. Remove stopwords (`old`, `backup`, `v1`, `copy`, `final`).

### Output contract

```ts
interface FileSuggestion {
  file_id: string;
  original_name: string;
  file_path: string;
  score: number;           // 0.0–1.0
  confidence: 'high' | 'medium' | 'low';
  last_used_session: string;
  hours_since_used: number;
}
```

**Confidence thresholds:**
- `>= 0.7` → high
- `>= 0.4` → medium
- `< 0.4` → low

Low-confidence files are shown collapsed/unchecked by default.

---

## 7. Cleanup Scheduler

**Schedule:** Once per day, on process start if last run > 23 hours ago.

**Eligible files query:**

```sql
SELECT 
  f.project_id,
  COUNT(f.file_id) AS file_count,
  SUM(f.size_bytes) AS total_bytes,
  MIN(f.created_at) AS oldest_file
FROM files f
WHERE f.created_at < ?  -- NOW - 30 days in epoch ms
  AND f.project_id NOT IN (
    SELECT project_id FROM cleanup_log
    WHERE action = 'SKIPPED' AND triggered_at > ?  -- within last 30 days
  )
GROUP BY f.project_id
HAVING COUNT(f.file_id) > 0;
```

**Archive implementation:**

```js
const archiver = require('archiver');

async function archiveProject(projectId, projectDir, archiveDir) {
  const timestamp = new Date().toISOString().slice(0, 7).replace('-', '_');
  const archiveName = `${projectId}_${timestamp}.zip`;
  const archivePath = path.join(archiveDir, archiveName);

  const output = fs.createWriteStream(archivePath);
  const archive = archiver('zip', { zlib: { level: 6 } });

  archive.pipe(output);
  archive.directory(projectDir, false);
  await archive.finalize();

  return archivePath;
}
```

**Hard rule:** No file is deleted without explicit user action. The cleanup prompt is informational until a user makes a choice.

---

## 8. Edge Case Handling

| Case | Detection | Resolution |
|------|-----------|------------|
| Partial download | `.crdownload`, `.part`, `.download` extensions OR `awaitWriteFinish` not yet satisfied | Ignored by watcher. Not ingested. |
| Duplicate file (same content) | Hash match in DB | Skip file copy. Link existing `file_id` to current session. Log `DEDUPLICATED`. |
| File renamed manually | Hash match despite different path/name | Update `file_name` and `file_path` in DB. Keep same `file_id`. Log `MOVED`. |
| Unrelated download | File ingested but session is `ACTIVE` (not near limit) | Store as `unlinked`. Never silently drop. |
| Multiple sessions active simultaneously | Race condition on `linked_session_id` | Enforce one `active_session_id` in the session manager. Reject ambiguous linking. Prompt user to select. |
| Wrong session linked | User reports via UI | `REASSIGNED` event written. `linked_session_id` updated. Original preserved in event log. |
| Filesystem full | `ENOSPC` on write | Log critical error. Do not partially write. Alert user immediately. |
| File deleted before ingestion completes | `ENOENT` on hash/move | Log `REJECTED` with reason `FILE_DISAPPEARED`. No retry. |

---

## 9. Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Node.js 20+ | Cross-platform, good fs support, chokidar ecosystem |
| File watcher | chokidar 3.x | Superior to `fs.watch` on macOS; stable `awaitWriteFinish` |
| Database | SQLite via `better-sqlite3` | Synchronous, zero-server, reliable, battle-tested |
| Hashing | Node.js `crypto` (built-in) | No dependency; SHA-256 |
| Archiving | `archiver` npm package | Streaming zip; handles large directories |
| Similarity | Custom Jaccard on tokens | No ML dependency; interpretable; fast |
| IPC / UI | Electron or CLI+tray | TBD — depends on UI decision (see §10) |

---

## 10. Open Technical Decisions

| # | Decision | Options | Recommendation |
|---|----------|---------|----------------|
| 1 | Session state detection | Manual signal / Message heuristic / DOM scrape | Manual signal for v1; heuristic overlay |
| 2 | UI surface | Electron tray app / CLI / Web UI on localhost | CLI first; tray app in v2 |
| 3 | Project definition | User-created / Auto-inferred from domain/tab title | User-created for v1 |
| 4 | File type allowlist | Hardcoded / Configurable / Off | Configurable via `config.json`; default: csv, json, pdf, png, jpg, txt, py, js, ts, md |
| 5 | Suggestion delivery mechanism | Push (notification) / Pull (on demand) | Pull — user opens suggestion panel before new session |