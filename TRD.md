# TRD — ClaudeVault: File Pipeline & Session Continuity System

**Version:** 0.3.0
**Status:** Draft
**Depends on:** PRD v0.3.0
**Last Updated:** 2026-03-18
**Changes from v0.2.0:** Added TABLE: handoff_drafts to §5. Added §6b Handoff Parser (client-side regex, no API). Added handoff-related edge cases to §8. Updated tech stack §9. All other content is unchanged from v0.2.0.

---

## 1. System Overview

ClaudeVault is a **local, event-driven file pipeline** that runs as a background service on macOS. It watches a target directory (typically `~/Downloads`), ingests stabilized files, hashes and moves them into a structured project store, links them to Claude sessions, tracks per-account usage limit windows, parses user-pasted Claude summaries into handoff templates, and surfaces files as suggestions when a new session begins.

It does not interact with Claude's API. It does not modify the Claude web interface. It makes no outbound network calls of any kind. It is a fully local utility.

---

## 2. Architecture

```
┌────────────────────────────────────────────────────────┐
│                      ClaudeVault                       │
│                                                        │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────┐  │
│  │  FileWatcher │───▶│  Ingestion   │───▶│    DB    │  │
│  │  (chokidar)  │    │   Pipeline   │    │ (SQLite) │  │
│  └──────────────┘    └──────┬───────┘    └────┬─────┘  │
│                             │                 │         │
│                    ┌────────▼───────┐  ┌──────▼──────┐ │
│                    │ Session Linker │  │   Cleanup   │ │
│                    └────────┬───────┘  │  Scheduler  │ │
│                             │          └─────────────┘ │
│          ┌──────────────────┼──────────────────┐        │
│          │                  │                  │        │
│ ┌────────▼───────┐ ┌────────▼────────┐ ┌───────▼─────┐ │
│ │   Suggestion   │ │ Account Manager │ │  Handoff    │ │
│ │    Engine      │ │ (limit tracking)│ │  Parser     │ │
│ └────────────────┘ └─────────────────┘ └─────────────┘ │
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

**Verdict:** Do not build on this. It will break and it is not a solution.

---

### Option B: User-triggered state signal (Pragmatic)

The user explicitly triggers `NEAR_LIMIT` state via a hotkey, tray menu action, or CLI command.

```bash
claudevault session set-state NEAR_LIMIT
```

**Verdict:** Acceptable as a v1 fallback only. Must be documented as a limitation, not a feature.

---

### Option C: Message-count heuristic (Reasonable approximation)

After M messages (configurable, default 20), state = `NEAR_LIMIT`. After P messages (default 30), state = `FINAL_WINDOW`.

**Verdict:** Better than Option A. Acceptable only if thresholds are configurable and the user is shown the current state at all times.

---

### Option D: File-download burst as proxy signal

When multiple files are downloaded in a short time window, infer the session is concluding.

**Verdict:** A useful secondary signal. Not sufficient on its own.

---

### ⚠️ Decision Required Before Build

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

### TABLE: accounts

```sql
CREATE TABLE accounts (
  account_id   TEXT PRIMARY KEY,
  -- Generated locally: short hash, e.g. "ACC-3F7A"
  alias        TEXT NOT NULL,
  email        TEXT,
  plan         TEXT NOT NULL DEFAULT 'PRO',
  -- FREE | PRO | MAX | TEAM — enforced at application layer
  created_at   INTEGER NOT NULL,
  is_active    INTEGER NOT NULL DEFAULT 1
  -- 1 = shown in ACCTS tab, 0 = soft-deleted (hidden but history preserved)
);
```

---

### TABLE: account_limit_events

Mostly append-only log of every limit hit. The only user-reversible exception is the ACCTS `X` undo, which deletes the most recent active row for a `(account_id, limit_type)` where `reset_at > now()`. Current limit state is always derived by querying the most recent event per `(account_id, limit_type)` — never cached.

```sql
CREATE TABLE account_limit_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   TEXT NOT NULL,
  limit_type   TEXT NOT NULL,  -- 5HR | DAILY | WEEKLY
  hit_at       INTEGER NOT NULL,
  reset_at     INTEGER NOT NULL,
  -- Computed at insert: hit_at + window_ms from config.limit_windows[limit_type]
  notes        TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id)
);

CREATE INDEX idx_ale_account_type ON account_limit_events(account_id, limit_type);
CREATE INDEX idx_ale_reset ON account_limit_events(reset_at);
```

---

### TABLE: handoff_drafts

Stores the most recent parsed handoff draft so the user can retrieve it if the widget is closed before copying. Append-only for audit purposes; the UI always loads the row with the highest `created_at`.

```sql
CREATE TABLE handoff_drafts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT,
  -- NULL if no session is focused when the handoff is created
  raw_input      TEXT NOT NULL,
  -- Verbatim text the user pasted (Claude's 6-section output)
  parsed_json    TEXT NOT NULL,
  -- JSON object: { objective, current_state, key_decisions,
  --               files_used, important_context, next_steps }
  built_template TEXT NOT NULL,
  -- Final filled template string, ready to copy
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
```

---

### Multi-session schema additions

```sql
ALTER TABLE sessions ADD COLUMN alias TEXT;
-- alias: user-chosen display name, max 32 chars, nullable
-- constraint: [a-zA-Z0-9_-]+ only, enforced at application layer

ALTER TABLE sessions ADD COLUMN focused_at INTEGER;
-- epoch ms of last time this session was set as the active focus

CREATE TABLE session_focus (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  focused_at  INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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
  return (0.5 * filenameSim) + (0.3 * recencyScore) + (0.2 * sessionOverlapScore);
}
```

**Confidence thresholds:** `>= 0.7` → high, `>= 0.4` → medium, `< 0.4` → low. Low-confidence files shown collapsed/unchecked by default.

---

## 6a. Account Manager

### getLimitState

```js
function getLimitState(accountId, limitType) {
  const now = Date.now();
  const row = db.prepare(`
    SELECT reset_at FROM account_limit_events
    WHERE account_id = ? AND limit_type = ?
    ORDER BY hit_at DESC LIMIT 1
  `).get(accountId, limitType);

  if (!row) return { hit: false, reset_at: null, remaining_ms: 0 };
  if (row.reset_at <= now) return { hit: false, reset_at: row.reset_at, remaining_ms: 0 };
  return { hit: true, reset_at: row.reset_at, remaining_ms: row.reset_at - now };
}
```

### logLimitHit

```js
function logLimitHit(accountId, limitType, notes = null) {
  const now = Date.now();
  const current = getLimitState(accountId, limitType);
  if (current.hit) throw new Error(`LIMIT_ALREADY_ACTIVE: ${accountId} · ${limitType} resets in ${current.remaining_ms}ms`);

  const windowMs = config.limit_windows[limitType];
  if (!windowMs) throw new Error(`UNKNOWN_LIMIT_TYPE: ${limitType}`);

  db.prepare(`
    INSERT INTO account_limit_events (account_id, limit_type, hit_at, reset_at, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(accountId, limitType, now, now + windowMs, notes ?? null);
}
```

### undoLimitHit (ACCTS `X`)

```js
function undoLimitHit(accountId, limitType) {
  const now = Date.now();
  const row = db.prepare(`
    SELECT id FROM account_limit_events
    WHERE account_id = ? AND limit_type = ? AND reset_at > ?
    ORDER BY id DESC LIMIT 1
  `).get(accountId, limitType, now);

  if (!row) throw new Error(`NO_HIT_TO_UNDO: ${accountId} · ${limitType}`);
  db.prepare('DELETE FROM account_limit_events WHERE id = ?').run(row.id);
}
```

### getAllAccountStates

```js
function getAllAccountStates() {
  const accounts = db.prepare(
    'SELECT * FROM accounts WHERE is_active = 1 ORDER BY created_at ASC'
  ).all();
  return accounts.map(acct => ({
    ...acct,
    limits: {
      '5HR':    getLimitState(acct.account_id, '5HR'),
      'DAILY':  getLimitState(acct.account_id, 'DAILY'),
      'WEEKLY': getLimitState(acct.account_id, 'WEEKLY'),
    }
  }));
}
```

### registerAccount

```js
function registerAccount(alias, email = null, plan = 'PRO') {
  const VALID_PLANS = ['FREE', 'PRO', 'MAX', 'TEAM'];
  if (!alias || alias.trim().length === 0) throw new Error('ACCOUNT_ALIAS_REQUIRED');
  if (!VALID_PLANS.includes(plan)) throw new Error(`INVALID_PLAN: must be one of ${VALID_PLANS.join(', ')}`);

  const accountId = generateAccountId(); // e.g. "ACC-3F7A"
  db.prepare(`
    INSERT INTO accounts (account_id, alias, email, plan, created_at, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(accountId, alias.trim(), email ?? null, plan, Date.now());
  return accountId;
}
```

### softDeleteAccount

```js
function softDeleteAccount(accountId) {
  const acct = db.prepare('SELECT account_id FROM accounts WHERE account_id = ?').get(accountId);
  if (!acct) throw new Error(`ACCOUNT_NOT_FOUND: ${accountId}`);
  db.prepare('UPDATE accounts SET is_active = 0 WHERE account_id = ?').run(accountId);
}
```

---

## 6b. Handoff Parser

The handoff parser converts the verbatim text the user pastes from Claude's 6-section summary into a filled handoff template ready to copy into the new chat. **It makes no network calls. It uses no external API. It is a client-side regex splitter.**

### Why regex and not an API call

Claude's summary is produced by a fixed, deterministic prompt that enforces a strict numbered format. The output is structured and predictable. A regex on numbered section headers is a complete and correct solution. Adding an API call would introduce a network dependency, latency, an API key requirement, and a failure mode — for a problem that requires none of those.

---

### The summary prompt (hardcoded in widget, copyable with one click)

```
Summarize the entire conversation in this STRICT format:

1. OBJECTIVE:
2. CURRENT STATE:
3. KEY DECISIONS:
4. FILES USED:
5. IMPORTANT CONTEXT:
6. NEXT STEPS:

Do not write anything outside this structure.
```

This string is hardcoded. It is not configurable. The numbered format and section labels are load-bearing — the parser depends on them exactly.

---

### parseHandoffSummary

```js
/**
 * Splits Claude's structured 6-section summary into a parsed object.
 *
 * Input:  verbatim text from Claude's summary response
 * Output: { objective, current_state, key_decisions, files_used,
 *           important_context, next_steps }
 * Throws: HANDOFF_PARSE_ERROR · Missing or empty section: {LABEL}
 */
function parseHandoffSummary(rawText) {
  const SECTIONS = [
    { key: 'objective',         label: 'OBJECTIVE' },
    { key: 'current_state',     label: 'CURRENT STATE' },
    { key: 'key_decisions',     label: 'KEY DECISIONS' },
    { key: 'files_used',        label: 'FILES USED' },
    { key: 'important_context', label: 'IMPORTANT CONTEXT' },
    { key: 'next_steps',        label: 'NEXT STEPS' },
  ];

  // Split on numbered section headers, keeping the delimiter
  const parts = rawText.split(/(?=^\s*\d+\.\s)/m).map(p => p.trim()).filter(Boolean);

  const result = {};

  for (const part of parts) {
    for (const { key, label } of SECTIONS) {
      const headerRe = new RegExp(`^\\d+\\.\\s*${label}:?\\s*`, 'i');
      if (headerRe.test(part)) {
        result[key] = part.replace(headerRe, '').trim();
        break;
      }
    }
  }

  // Validate all six sections are present and non-empty
  for (const { key, label } of SECTIONS) {
    if (!result[key] || result[key].length === 0) {
      throw new Error(`HANDOFF_PARSE_ERROR · Missing or empty section: ${label}`);
    }
  }

  return result;
}
```

---

### buildHandoffTemplate

```js
/**
 * Produces the final template string from the parsed summary.
 * FILES section: contains only the re-upload instruction.
 * (The verbatim FILES USED content is shown separately in the widget as a reference and
 * is not included in the copied template.)
 */
function buildHandoffTemplate(parsed) {
  return `We were working on the following:

OBJECTIVE:
${parsed.objective}

CURRENT STATE:
${parsed.current_state}

KEY DECISIONS:
${parsed.key_decisions}

IMPORTANT CONTEXT:
${parsed.important_context}

FILES:
(Re-upload the required files now)

NEXT STEPS:
${parsed.next_steps}

Continue exactly from NEXT STEPS.
Do not restart or reinterpret the problem.`;
}
```

**Template rules — enforced here, not in the UI layer:**
- `files_used` is parsed and available, but the copied template's `FILES:` section contains only the fixed re-upload instruction
- `(Re-upload the required files now)` is always present under `FILES:`
- Section headers are immutable
- The closing two lines are immutable
- No section is omitted regardless of content length

---

### saveHandoffDraft

```js
function saveHandoffDraft(rawInput, parsed, builtTemplate, sessionId = null) {
  db.prepare(`
    INSERT INTO handoff_drafts (session_id, raw_input, parsed_json, built_template, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    sessionId ?? null,
    rawInput,
    JSON.stringify(parsed),
    builtTemplate,
    Date.now()
  );
}
```

Called immediately after `buildHandoffTemplate` succeeds. Allows draft recovery if the widget is closed before the user copies.

---

### getLatestHandoffDraft

```js
function getLatestHandoffDraft(sessionId = null) {
  const row = sessionId
    ? db.prepare(`SELECT * FROM handoff_drafts WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`).get(sessionId)
    : db.prepare(`SELECT * FROM handoff_drafts ORDER BY created_at DESC LIMIT 1`).get();

  if (!row) return null;
  return {
    rawInput:      row.raw_input,
    parsed:        JSON.parse(row.parsed_json),
    builtTemplate: row.built_template,
    createdAt:     row.created_at,
  };
}
```

---

### Error handling

If `parseHandoffSummary` throws:
1. Show the error inline below the textarea with the exact missing section name
2. Do not call `buildHandoffTemplate`
3. Do not write to `handoff_drafts`
4. Leave the textarea editable for correction and re-submission

The most common cause of a parse error is Claude adding a preamble sentence before `1. OBJECTIVE:`. The user can fix by removing the extra text and clicking PARSE again.

---

## 7. Cleanup Scheduler

**Schedule:** Once per day, on process start if last run > 23 hours ago.

```sql
SELECT
  f.project_id,
  COUNT(f.file_id) AS file_count,
  SUM(f.size_bytes) AS total_bytes,
  MIN(f.created_at) AS oldest_file
FROM files f
WHERE f.created_at < ?
  AND f.project_id NOT IN (
    SELECT project_id FROM cleanup_log
    WHERE action = 'SKIPPED' AND triggered_at > ?
  )
GROUP BY f.project_id
HAVING COUNT(f.file_id) > 0;
```

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

**Hard rule:** No file is deleted without explicit user action.

---

## 8. Edge Case Handling

| Case | Detection | Resolution |
|------|-----------|------------|
| Partial download | `.crdownload`, `.part`, `.download` OR `awaitWriteFinish` not satisfied | Ignored by watcher. Not ingested. |
| Duplicate file | Hash match in DB | Skip copy. Link existing `file_id`. Log `DEDUPLICATED`. |
| File renamed manually | Hash match, different path/name | Update `file_name` and `file_path`. Keep `file_id`. Log `MOVED`. |
| Unrelated download | File ingested, session is ACTIVE | Store as `unlinked`. Never silently drop. |
| Multiple sessions active | Race on `linked_session_id` | Enforce one `active_session_id`. Reject ambiguous linking. Prompt user. |
| Wrong session linked | User reports via UI | `REASSIGNED` event written. Original preserved in event log. |
| Filesystem full | `ENOSPC` on write | Log critical error. Do not partially write. Alert user immediately. |
| File deleted before ingestion | `ENOENT` on hash/move | Log `REJECTED · FILE_DISAPPEARED`. No retry. |
| LOG HIT when limit already active | `getLimitState()` returns `hit: true` | Throw `LIMIT_ALREADY_ACTIVE`. UI disables LOG HIT button. |
| UNDO HIT when no active hit | No row with `reset_at > now()` | Throw `NO_HIT_TO_UNDO`. UI hides `X` button when row is `NOT LOGGED` or `OK`. |
| App restarted while limit active | `reset_at` still in future in DB | `getLimitState()` reads DB on mount — countdown resumes correctly. |
| Wrong limit type string | `config.limit_windows[limitType]` undefined | Throw `UNKNOWN_LIMIT_TYPE` before any DB write. |
| Account soft-deleted while limit active | `is_active = 0`, event still in DB | Account hidden from UI. Limit state still queryable directly if needed. |
| Handoff paste has preamble before section 1 | Header regex fails to match at expected position | `parseHandoffSummary` throws `HANDOFF_PARSE_ERROR · Missing or empty section: {LABEL}`. Error shown inline. Textarea stays editable. |
| Handoff paste missing a section entirely | Parsed result object missing the key | Same as above — exact missing label shown. |
| Widget closed before copying template | Template saved to `handoff_drafts` on parse success | On next open, HANDOFF tab shows "Restore last draft?" with timestamp. |
| Claude adds text outside the numbered format | Unmatched text ignored by splitter | If a required section ends up empty as a result, parse error fires with section name. |

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
| Handoff parser | Client-side regex (built-in) | No dependency, no network, deterministic on fixed-format input |
| IPC / UI | Electron tray app | macOS menu bar widget |

---

## 10. Open Technical Decisions

| # | Decision | Options | Recommendation |
|---|----------|---------|----------------|
| 1 | Session state detection | Manual signal / Message heuristic / DOM scrape | Manual signal for v1; heuristic overlay |
| 2 | UI surface | Electron tray app / CLI / Web UI on localhost | CLI first; tray app in v2 |
| 3 | Project definition | User-created / Auto-inferred from domain/tab title | User-created for v1 |
| 4 | File type allowlist | Hardcoded / Configurable / Off | Configurable via `config.json`; default: csv, json, pdf, png, jpg, txt, py, js, ts, md |
| 5 | Suggestion delivery mechanism | Push (notification) / Pull (on demand) | Pull — user opens suggestion panel before new session |
| 6 | Weekly limit reset | Rolling 7 days from hit_at / Pin to Monday 00:00 | Rolling 7 days (default) — configurable |

---

## 11. Multi-Session Support

### 11.1 Schema Changes

See TABLE: sessions additions in §5 above.

---

### 11.2 Multi-Session Manager

```js
function switchFocus(newSessionId) {
  const existing = db.prepare(
    'SELECT session_id FROM sessions WHERE session_id = ? AND state = ?'
  ).get(newSessionId, 'ACTIVE');
  if (!existing) throw new Error(`Session ${newSessionId} is not ACTIVE`);
  db.prepare('INSERT INTO session_focus (session_id, focused_at) VALUES (?, ?)').run(newSessionId, Date.now());
}

function getCurrentFocus() {
  return db.prepare('SELECT session_id FROM session_focus ORDER BY focused_at DESC LIMIT 1').get();
}

function ingestFile(file) {
  const focus = getCurrentFocus();
  const sessionId = focus ? focus.session_id : null;
  linkFileToSession(file.file_id, sessionId);
}
```

---

### 11.3 Session Alias

```js
const ALIAS_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

function setAlias(sessionId, alias) {
  if (alias && !ALIAS_PATTERN.test(alias)) throw new Error(`ALIAS_INVALID: must match [a-zA-Z0-9_-], max 32 chars`);
  db.prepare('UPDATE sessions SET alias = ? WHERE session_id = ?').run(alias ?? null, sessionId);
  db.prepare('INSERT INTO file_events (file_id, event_type, detail, timestamp) VALUES (?, ?, ?, ?)')
    .run(sessionId, 'ALIAS_SET', JSON.stringify({ alias }), Date.now());
}

function displaySession(session) {
  return session.alias ? `${session.session_id} ~ ${session.alias}` : session.session_id;
}
```

---

### 11.4 Session Close Recovery

```js
function closeSession(sessionId) {
  db.transaction(() => {
    db.prepare('UPDATE sessions SET state = ?, ended_at = ? WHERE session_id = ?').run('CLOSED', Date.now(), sessionId);
    db.prepare('INSERT INTO file_events (file_id, event_type, detail, timestamp) VALUES (?, ?, ?, ?)').run(sessionId, 'SESSION_CLOSED', null, Date.now());
  })();
}

function reopenSession(sessionId) {
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ? AND state = ?').get(sessionId, 'CLOSED');
  if (!session) throw new Error(`Session ${sessionId} is not CLOSED`);
  const activeCount = db.prepare('SELECT COUNT(*) as n FROM sessions WHERE state = ?').get('ACTIVE').n;
  const maxConcurrent = config.max_concurrent_sessions ?? 5;
  if (activeCount >= maxConcurrent) throw new Error(`MAX_SESSIONS_REACHED: ${activeCount}/${maxConcurrent} active`);
  db.transaction(() => {
    db.prepare('UPDATE sessions SET state = ?, ended_at = NULL WHERE session_id = ?').run('ACTIVE', sessionId);
    db.prepare('INSERT INTO file_events (file_id, event_type, detail, timestamp) VALUES (?, ?, ?, ?)').run(sessionId, 'SESSION_REOPENED', null, Date.now());
    db.prepare('INSERT INTO session_focus (session_id, focused_at) VALUES (?, ?)').run(sessionId, Date.now());
  })();
}
```

**History query:**

```sql
SELECT
  s.session_id,
  s.alias,
  s.project_id,
  s.ended_at,
  s.state,
  COUNT(f.file_id) AS file_count
FROM sessions s
LEFT JOIN files f ON f.linked_session_id = s.session_id
WHERE s.state = 'CLOSED'
ORDER BY s.ended_at DESC;
```

---

### 11.5 Full Session Deletion (Permanent)

- Widget shows explicit warning confirmation with "This action cannot be undone."
- DB transaction: remove `session_focus` rows and the `sessions` row
- Filesystem: permanently delete all files under `~/Downloads/claude-vault/projects/<project_id>/sessions/<session_id>/`
- If parent project directory becomes empty, delete it too
- Filesystem errors are logged but do not block DB cleanup

---

### 11.6 Reveal in Finder

- Frontend calls IPC `reveal-session-folder` with `session_id`
- Main process constructs the session folder path and opens via `electron.shell.showItemInFolder()`

---

## 12. config.json

```json
{
  "watch_dir": "~/Downloads",
  "vault_dir": "~/Downloads/claudevault",
  "db_path": "~/Downloads/claudevault/vault.db",
  "archive_dir": "~/Downloads/claudevault/archive",
  "file_type_allowlist": ["csv", "json", "pdf", "png", "jpg", "txt", "py", "js", "ts", "md"],
  "stabilization_threshold_ms": 2000,
  "near_limit_message_count": 20,
  "final_window_message_count": 30,
  "cleanup_ttl_days": 30,
  "max_concurrent_sessions": 5,
  "limit_windows": {
    "5HR":    18000000,
    "DAILY":  86400000,
    "WEEKLY": 604800000
  }
}
```

All fields required. `limit_windows` must contain all three keys. Values in milliseconds. No API keys — this tool makes no outbound network calls.