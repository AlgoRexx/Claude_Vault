1|# TRD — ClaudeVault: File Pipeline & Session Continuity System
2|
3|**Version:** 0.1.0  
4|**Status:** Draft  
5|**Depends on:** PRD v0.1.0  
6|**Last Updated:** 2026-03-18
7|
8|---
9|
10|## 1. System Overview
11|
12|ClaudeVault is a **local, event-driven file pipeline** that runs as a background service on macOS. It watches a target directory (typically `~/Downloads`), ingests stabilized files, hashes and moves them into a structured project store, links them to Claude sessions, and surfaces them as suggestions when a new session begins.
13|
14|It does not interact with Claude's API. It does not modify the Claude web interface. It is a local utility.
15|
16|---
17|
18|## 2. Architecture
19|
20|```
21|┌────────────────────────────────────────────────────────┐
22|│                      ClaudeVault                      │
23|│                                                        │
24|│  ┌──────────────┐    ┌──────────────┐    ┌──────────┐ │
25|│  │  FileWatcher │───▶│  Ingestion   │───▶│    DB    │ │
26|│  │  (chokidar)  │    │   Pipeline   │    │ (SQLite) │ │
27|│  └──────────────┘    └──────┬───────┘    └────┬─────┘ │
28|│                             │                 │        │
29|│                    ┌────────▼───────┐  ┌──────▼─────┐ │
30|│                    │ Session Linker │  │  Cleanup   │ │
31|│                    └────────┬───────┘  │  Scheduler │ │
32|│                             │          └────────────┘ │
33|│                    ┌────────▼───────┐                  │
34|│                    │  Suggestion    │                  │
35|│                    │    Engine      │                  │
36|│                    └────────────────┘                  │
37|└────────────────────────────────────────────────────────┘
38|```
39|
40|---
41|
42|## 3. File Pipeline — Stage-by-Stage
43|
44|### Stage 1: Detection
45|
46|**Implementation:** `chokidar` (not `fs.watch`)
47|
48|**Why not `fs.watch`:**
49|- `fs.watch` on macOS wraps FSEvents but does not debounce reliably
50|- `fs.watch` does not detect renames correctly in all cases
51|- `chokidar` handles partial download detection, symlinks, and network volumes correctly
52|- `chokidar` has a stable `awaitWriteFinish` option — critical for this use case
53|
54|```js
55|const watcher = chokidar.watch(WATCH_DIR, {
56|  persistent: true,
57|  ignoreInitial: true,
58|  awaitWriteFinish: {
59|    stabilityThreshold: 2000,  // 2s of no size change
60|    pollInterval: 500
61|  },
62|  ignored: [
63|    /\.crdownload$/,   // Chrome partial downloads
64|    /\.part$/,         // Firefox partial downloads
65|    /\.download$/,     // Safari partial downloads
66|    /(^|[\/\\])\../   // Hidden files
67|  ]
68|});
69|```
70|
71|**Stabilization check (belt-and-suspenders, run after `add` event fires):**
72|
73|```js
74|async function isFileStable(filePath, checkIntervalMs = 500, requiredStableChecks = 3) {
75|  let lastSize = -1;
76|  let stableCount = 0;
77|
78|  while (stableCount < requiredStableChecks) {
79|    await sleep(checkIntervalMs);
80|    const { size } = await fs.stat(filePath);
81|    if (size === lastSize) {
82|      stableCount++;
83|    } else {
84|      stableCount = 0;
85|      lastSize = size;
86|    }
87|  }
88|  return true;
89|}
90|```
91|
92|---
93|
94|### Stage 2: Validation
95|
96|Before any move or DB write:
97|
98|1. File exists and is readable
99|2. File size > 0
100|3. Extension is in the configured allowlist (or allowlist is disabled)
101|4. File is not already tracked (check hash against DB)
102|
103|If any check fails: log to `file_events` with event type `REJECTED` + reason. Never silently discard.
104|
105|---
106|
107|### Stage 3: Hashing
108|
109|**Algorithm:** SHA-256 (not MD5 — MD5 has known collisions; not acceptable for deduplication logic)
110|
111|```js
112|const crypto = require('crypto');
113|const fs = require('fs');
114|
115|function hashFile(filePath) {
116|  return new Promise((resolve, reject) => {
117|    const hash = crypto.createHash('sha256');
118|    const stream = fs.createReadStream(filePath);
119|    stream.on('data', chunk => hash.update(chunk));
120|    stream.on('end', () => resolve(hash.digest('hex')));
121|    stream.on('error', reject);
122|  });
123|}
124|```
125|
126|**Deduplication check:**
127|
128|```js
129|const existing = db.prepare('SELECT file_id FROM files WHERE hash = ?').get(fileHash);
130|if (existing) {
131|  linkExistingFile(existing.file_id, currentSessionId);
132|  logEvent(existing.file_id, 'DEDUPLICATED');
133|  return; // Do not copy the file again
134|}
135|```
136|
137|---
138|
139|### Stage 4: Move & Rename
140|
141|**Target path structure:**
142|
143|```
144|~/Downloads/claude-vault/
145|  projects/
146|    {project_id}/
147|      sessions/
148|        {session_id}/
149|          files/
150|          images/
151|          summary.txt
152|          metadata.json
153|  unlinked/
154|    {YYYY-MM-DD}/
155|  logs/
156|  archive/
157|```
158|
159|**Rename format:**
160|
161|```
162|{original_stem}_{YYYYMMDD_HHmmss}_{8char_hash_prefix}{ext}
163|```
164|
165|Example: `model_results_20260318_142301_a3f9c1b2.csv`
166|
167|**Why:** Prevents collisions. Makes files sortable. Preserves original name for suggestion matching.
168|
169|**Use `fs.rename` only if same filesystem. Otherwise `fs.copyFile` + `fs.unlink`:**
170|
171|```js
172|async function moveFile(src, dest) {
173|  try {
174|    await fs.rename(src, dest);
175|  } catch (err) {
176|    if (err.code === 'EXDEV') {
177|      // Cross-device move
178|      await fs.copyFile(src, dest);
179|      await fs.unlink(src);
180|    } else {
181|      throw err;
182|    }
183|  }
184|}
185|```
186|
187|---
188|
189|### Stage 5: DB Write
190|
191|Two writes, in order. Both must succeed or both are rolled back.
192|
193|```js
194|db.transaction(() => {
195|  db.prepare(`
196|    INSERT INTO files (file_id, file_name, file_path, hash, file_type, created_at, linked_session_id, project_id)
197|    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
198|  `).run(fileId, fileName, filePath, hash, fileType, Date.now(), sessionId ?? null, projectId ?? null);
199|
200|  db.prepare(`
201|    INSERT INTO file_events (file_id, event_type, timestamp)
202|    VALUES (?, 'CREATED', ?)
203|  `).run(fileId, Date.now());
204|})();
205|```
206|
207|---
208|
209|## 4. Session State Detection — CRITICAL OPEN PROBLEM
210|
211|**This is the most architecturally unresolved part of the system.**
212|
213|The source document states that files should be linked to a session when its state is `NEAR_LIMIT` or `FINAL_WINDOW`. But it does not specify how those states are detected.
214|
215|**Claude has no public API that exposes session token count.**  
216|There is no webhook. There is no polling endpoint.
217|
218|### Option A: Playwright-based DOM scraping (High risk)
219|
220|Read the Claude web UI's message count or a UI indicator if one exists.
221|
222|**Problems:**
223|- Claude's UI has no stable public indicator of context usage
224|- Breaks on any UI update
225|- Requires a running browser process
226|- Brittle by definition
227|
228|**Verdict:** Do not build on this. It will break and it is not a solution.
229|
230|---
231|
232|### Option B: User-triggered state signal (Pragmatic)
233|
234|The user explicitly triggers `NEAR_LIMIT` state via a hotkey, tray menu action, or CLI command.
235|
236|```bash
237|claudevault session set-state NEAR_LIMIT
238|```
239|
240|**Problems:**
241|- Requires user awareness and action
242|- Defeats the goal of automation
243|
244|**Verdict:** Acceptable as a v1 fallback only. Must be documented as a limitation, not a feature.
245|
246|---
247|
248|### Option C: Message-count heuristic (Reasonable approximation)
249|
250|The system counts user-initiated uploads and messages within a session window, and applies a threshold.
251|
252|**Heuristic:**
253|- Session starts when user opens `claude.ai`
254|- Every N minutes of activity = session still active
255|- After M messages (configurable, default 20), state = `NEAR_LIMIT`
256|- After P messages (configurable, default 30), state = `FINAL_WINDOW`
257|
258|**Problems:**
259|- Message count ≠ token count
260|- Different conversations hit limits at different message counts depending on file size
261|- Will produce false positives and false negatives
262|
263|**Verdict:** Better than Option A. Acceptable only if thresholds are configurable and the user is shown the current state at all times.
264|
265|---
266|
267|### Option D: File-download burst as proxy signal (Interesting heuristic)
268|
269|When multiple files are downloaded in a short time window (e.g., 3 files in 5 minutes), infer the session is concluding and auto-link recent files.
270|
271|**Verdict:** A useful secondary signal. Not sufficient on its own.
272|
273|---
274|
275|### ⚠️ Decision Required Before Build
276|
277|This problem must be solved before writing session-linking code. Proceeding without a resolved detection mechanism produces a system that links files to sessions incorrectly — which corrupts the entire value proposition.
278|
279|**Recommendation:** Implement Option B (manual signal) for v1 with Option C as a configurable overlay. Revisit when/if Claude exposes session metadata.
280|
281|---
282|
283|## 5. Database Schema
284|
285|**Engine:** SQLite via `better-sqlite3` (synchronous API — do not use `sqlite3` async driver for this use case; the synchronous model is safer inside an event pipeline)
286|
287|---
288|
289|### TABLE: sessions
290|
291|```sql
292|CREATE TABLE sessions (
293|  session_id   TEXT PRIMARY KEY,
294|  project_id   TEXT NOT NULL,
295|  started_at   INTEGER NOT NULL,
296|  ended_at     INTEGER,
297|  state        TEXT NOT NULL DEFAULT 'ACTIVE',
298|  -- ACTIVE | NEAR_LIMIT | FINAL_WINDOW | CLOSED
299|  summary_path TEXT,
300|  alias        TEXT,  -- User-provided readable name, max 32 chars, alphanumeric + hyphens + underscores
301|  focused_at   INTEGER -- Epoch milliseconds of last time this session was set as the active focus
302|);
303|```
304|
305|---
306|
307|### TABLE: files
308|
309|```sql
310|CREATE TABLE files (
311|  file_id          TEXT PRIMARY KEY,
312|  file_name        TEXT NOT NULL,
313|  original_name    TEXT NOT NULL,       -- preserved for suggestion matching
314|  file_path        TEXT NOT NULL,
315|  hash             TEXT NOT NULL UNIQUE,
316|  file_type        TEXT,
317|  size_bytes       INTEGER,
318|  created_at       INTEGER NOT NULL,
319|  linked_session_id TEXT,               -- NULL = unlinked
320|  project_id       TEXT,
321|  FOREIGN KEY (linked_session_id) REFERENCES sessions(session_id)
322|);
323|
324|CREATE INDEX idx_files_hash ON files(hash);
325|CREATE INDEX idx_files_session ON files(linked_session_id);
326|CREATE INDEX idx_files_project ON files(project_id);
327|```
328|
329|---
330|
331|### TABLE: file_events
332|
333|```sql
334|CREATE TABLE file_events (
335|  id          INTEGER PRIMARY KEY AUTOINCREMENT,
336|  file_id     TEXT NOT NULL,
337|  event_type  TEXT NOT NULL,
338|  -- CREATED | MOVED | LINKED | DEDUPLICATED | REJECTED | REASSIGNED | ARCHIVED | DELETED
339|  detail      TEXT,                     -- JSON blob for extra context
340|  timestamp   INTEGER NOT NULL,
341|  FOREIGN KEY (file_id) REFERENCES files(file_id)
342|);
343|
344|CREATE INDEX idx_events_file ON file_events(file_id);
345|CREATE INDEX idx_events_time ON file_events(timestamp);
346|```
347|
348|---
349|
350|### TABLE: projects
351|
352|```sql
353|CREATE TABLE projects (
354|  project_id   TEXT PRIMARY KEY,
355|  name         TEXT NOT NULL,
356|  created_at   INTEGER NOT NULL,
357|  last_active  INTEGER
358|);
359|```
360|
361|---
362|
363|### TABLE: cleanup_log
364|
365|```sql
366|CREATE TABLE cleanup_log (
367|  id          INTEGER PRIMARY KEY AUTOINCREMENT,
368|  project_id  TEXT NOT NULL,
369|  action      TEXT NOT NULL,  -- DELETED | ARCHIVED | KEPT | SKIPPED
370|  triggered_at INTEGER NOT NULL,
371|  resolved_at  INTEGER
372|);
373|```
374|
375|---
376|
377|## 6. File Suggestion Engine
378|
379|### Input
380|
381|- Current project context (project_id if known)
382|- Last session's summary (parsed for filenames)
383|- DB query: files linked to sessions in the same project
384|
385|### Scoring
386|
387|```js
388|function scoreFile(candidate, context) {
389|  const filenameSim = jaccardSimilarity(
390|    tokenize(candidate.original_name),
391|    tokenize(context.recentFileNames)
392|  );
393|
394|  const recencyScore = 1 / (1 + hoursAgo(candidate.created_at));
395|
396|  const sessionOverlapScore = candidate.sharedSessionCount / context.totalSessions;
397|
398|  return (
399|    0.5 * filenameSim +
400|    0.3 * recencyScore +
401|    0.2 * sessionOverlapScore
402|  );
403|}
404|```
405|
406|**Tokenization:** Split on `_`, `-`, `.`, spaces. Lowercase. Remove stopwords (`old`, `backup`, `v1`, `copy`, `final`).
407|
408|### Output contract
409|
410|```ts
411|interface FileSuggestion {
412|  file_id: string;
413|  original_name: string;
414|  file_path: string;
415|  score: number;           // 0.0–1.0
416|  confidence: 'high' | 'medium' | 'low';
417|  last_used_session: string;
418|  hours_since_used: number;
419|}
420|```
421|
422|**Confidence thresholds:**
423|- `>= 0.7` → high
424|- `>= 0.4` → medium
425|- `< 0.4` → low
426|
427|Low-confidence files are shown collapsed/unchecked by default.
428|
429|---
430|
431|## 7. Cleanup Scheduler
432|
433|**Schedule:** Once per day, on process start if last run > 23 hours ago.
434|
435|**Eligible files query:**
436|
437|```sql
438|SELECT 
439|  f.project_id,
440|  COUNT(f.file_id) AS file_count,
441|  SUM(f.size_bytes) AS total_bytes,
442|  MIN(f.created_at) AS oldest_file
443|FROM files f
444|WHERE f.created_at < ?  -- NOW - 30 days in epoch ms
445|  AND f.project_id NOT IN (
446|    SELECT project_id FROM cleanup_log
447|    WHERE action = 'SKIPPED' AND triggered_at > ?  -- within last 30 days
448|  )
449|GROUP BY f.project_id
450|HAVING COUNT(f.file_id) > 0;
451|```
452|
453|**Archive implementation:**
454|
455|```js
456|const archiver = require('archiver');
457|
458|async function archiveProject(projectId, projectDir, archiveDir) {
459|  const timestamp = new Date().toISOString().slice(0, 7).replace('-', '_');
460|  const archiveName = `${projectId}_${timestamp}.zip`;
461|  const archivePath = path.join(archiveDir, archiveName);
462|
463|  const output = fs.createWriteStream(archivePath);
464|  const archive = archiver('zip', { zlib: { level: 6 } });
465|
466|  archive.pipe(output);
467|  archive.directory(projectDir, false);
468|  await archive.finalize();
469|
470|  return archivePath;
471|}
472|```
473|
474|**Hard rule:** No file is deleted without explicit user action. The cleanup prompt is informational until a user makes a choice.
475|
476|---
477|
478|## 8. Edge Case Handling
479|
480|| Case | Detection | Resolution |
481||------|-----------|------------|
482|| Partial download | `.crdownload`, `.part`, `.download` extensions OR `awaitWriteFinish` not yet satisfied | Ignored by watcher. Not ingested. |
483|| Duplicate file (same content) | Hash match in DB | Skip file copy. Link existing `file_id` to current session. Log `DEDUPLICATED`. |
484|| File renamed manually | Hash match despite different path/name | Update `file_name` and `file_path` in DB. Keep same `file_id`. Log `MOVED`. |
485|| Unrelated download | File ingested but session is `ACTIVE` (not near limit) | Store as `unlinked`. Never silently drop. |
486|| Multiple sessions active simultaneously | Race condition on `linked_session_id` | Enforce one `active_session_id` in the session manager. Reject ambiguous linking. Prompt user to select. |
487|| Wrong session linked | User reports via UI | `REASSIGNED` event written. `linked_session_id` updated. Original preserved in event log. |
488|| Filesystem full | `ENOSPC` on write | Log critical error. Do not partially write. Alert user immediately. |
489|| File deleted before ingestion completes | `ENOENT` on hash/move | Log `REJECTED` with reason `FILE_DISAPPEARED`. No retry. |
490|
491|---
492|
493|## 9. Technology Stack
494|
495|| Component | Choice | Rationale |
496||-----------|--------|-----------|
497|| Runtime | Node.js 20+ | Cross-platform, good fs support, chokidar ecosystem |
498|| File watcher | chokidar 3.x | Superior to `fs.watch` on macOS; stable `awaitWriteFinish` |
499|| Database | SQLite via `better-sqlite3` | Synchronous, zero-server, reliable, battle-tested |
500|| Hashing | Node.js `crypto` (built-in) | No dependency; SHA-256 |
501|| Archiving | `archiver` npm package | Streaming zip; handles large directories |
502|| Similarity | Custom Jaccard on tokens | No ML dependency; interpretable; fast |
503|| IPC / UI | Electron or CLI+tray | TBD — depends on UI decision (see §10) |
504|
505|---
506|
507|## 10. Open Technical Decisions
508|
509|| # | Decision | Options | Recommendation |
510||---|----------|---------|----------------|
511|| 1 | Session state detection | Manual signal / Message heuristic / DOM scrape | Manual signal for v1; heuristic overlay |
512|| 2 | UI surface | Electron tray app / CLI / Web UI on localhost | CLI first; tray app in v2 |
513|| 3 | Project definition | User-created / Auto-inferred from domain/tab title | User-created for v1 |
514|| 4 | File type allowlist | Hardcoded / Configurable / Off | Configurable via `config.json`; default: csv, json, pdf, png, jpg, txt, py, js, ts, md |
515|| 5 | Suggestion delivery mechanism | Push (notification) / Pull (on demand) | Pull — user opens suggestion panel before new session |
516|
517|---
518|
519|## 11. Multi-Session Support
520|
521|### 11.1 Schema Changes
522|
523|**Updated TABLE: sessions**
524|
525|```sql
526|ALTER TABLE sessions ADD COLUMN alias TEXT;
527|-- alias: user-chosen display name, max 32 chars, nullable
528|-- constraint: [a-zA-Z0-9_-]+ only, enforced at application layer not DB layer
529|
530|ALTER TABLE sessions ADD COLUMN focused_at INTEGER;
531|-- focused_at: epoch ms of last time this session was set as the active focus
532|-- used for sorting the session switcher (most recently focused first)
533|```
534|
535|**New TABLE: session_focus**
536|
537|```sql
538|CREATE TABLE session_focus (
539|  id          INTEGER PRIMARY KEY AUTOINCREMENT,
540|  session_id  TEXT NOT NULL,
541|  focused_at  INTEGER NOT NULL,
542|  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
543|);
544|```
545|
546|This table provides a full audit trail of focus switches. The current focus is always the row with the highest `focused_at` value. Do not store "current focus" as a global variable — derive it from this table. This prevents state corruption on crash.
547|
548|---
549|
550|### 11.2 Multi-Session Manager
551|
552|**Rules:**
553|- Any number of sessions can be ACTIVE simultaneously (capped by config `max_concurrent_sessions`, default 5)
554|- Only one session is **focused** at a time — this is the session that receives new file links during ingestion
555|- Switching focus is a write to `session_focus` only — no state change on the session itself
556|- The widget header always shows the currently focused session
557|
558|**Focus switch logic:**
559|
560|```js
561|function switchFocus(newSessionId) {
562|  const existing = db.prepare(
563|    'SELECT session_id FROM sessions WHERE session_id = ? AND state = ?'
564|  ).get(newSessionId, 'ACTIVE');
565|
566|  if (!existing) throw new Error(`Session ${newSessionId} is not ACTIVE`);
567|
568|  db.prepare(
569|    'INSERT INTO session_focus (session_id, focused_at) VALUES (?, ?)'
570|  ).run(newSessionId, Date.now());
571|}
572|
573|function getCurrentFocus() {
574|  return db.prepare(
575|    'SELECT session_id FROM session_focus ORDER BY focused_at DESC LIMIT 1'
576|  ).get();
577|}
578|```
579|
580|**File ingestion uses focused session:**
581|
582|```js
583|function ingestFile(file) {
584|  const focus = getCurrentFocus();
585|  const sessionId = focus ? focus.session_id : null;
586|  // ... rest of ingestion pipeline
587|  linkFileToSession(file.file_id, sessionId);
588|}
589|```
590|
591|---
592|
593|### 11.3 Session Alias
594|
595|**Validation (application layer):**
596|
597|```js
598|const ALIAS_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;
599|
600|function setAlias(sessionId, alias) {
601|  if (alias && !ALIAS_PATTERN.test(alias)) {
602|    throw new Error(`ALIAS_INVALID: must match [a-zA-Z0-9_-], max 32 chars`);
603|  }
604|  db.prepare('UPDATE sessions SET alias = ? WHERE session_id = ?')
605|    .run(alias ?? null, sessionId);
606|  db.prepare(
607|    'INSERT INTO file_events (file_id, event_type, detail, timestamp) VALUES (?, ?, ?, ?)'
608|  ).run(sessionId, 'ALIAS_SET', JSON.stringify({ alias }), Date.now());
609|}
610|```
611|
612|**Display format (enforced everywhere in UI and CLI):**
613|
614|```js
615|function displaySession(session) {
616|  return session.alias
617|    ? `${session.session_id} ~ ${session.alias}`
618|    : session.session_id;
619|}
620|// Output examples:
621|// "TRD-A1B2 ~ trading-dashboard"
622|// "TRD-9F1C"  (no alias set)
623|```
624|
625|This format is non-negotiable. The hash always leads. The alias always follows a ` ~ ` separator (space-tilde-space). Never show alias alone without the hash. Never abbreviate the hash.
626|
627|---
628|
629|### 11.4 Session Close Recovery
630|
631|**Closing a session is a state change — never a deletion:**
632|
633|```js
634|function closeSession(sessionId) {
635|  db.transaction(() => {
636|    db.prepare(
637|      'UPDATE sessions SET state = ?, ended_at = ? WHERE session_id = ?'
638|    ).run('CLOSED', Date.now(), sessionId);
639|
640|    db.prepare(
641|      'INSERT INTO file_events (file_id, event_type, detail, timestamp) VALUES (?, ?, ?, ?)'
642|    ).run(sessionId, 'SESSION_CLOSED', null, Date.now());
643|  })();
644|}
645|```
646|
647|**Reopening a closed session:**
648|
649|```js
650|function reopenSession(sessionId) {
651|  const session = db.prepare(
652|    'SELECT * FROM sessions WHERE session_id = ? AND state = ?'
653|  ).get(sessionId, 'CLOSED');
654|
655|  if (!session) throw new Error(`Session ${sessionId} is not CLOSED`);
656|
657|  // Check concurrent session limit
658|  const activeCount = db.prepare(
659|    'SELECT COUNT(*) as n FROM sessions WHERE state = ?'
660|  ).get('ACTIVE').n;
661|
662|  const maxConcurrent = config.max_concurrent_sessions ?? 5;
663|  if (activeCount >= maxConcurrent) {
664|    throw new Error(`MAX_SESSIONS_REACHED: ${activeCount}/${maxConcurrent} active`);
665|  }
666|
667|  db.transaction(() => {
668|    db.prepare(
669|      'UPDATE sessions SET state = ?, ended_at = NULL WHERE session_id = ?'
670|    ).run('ACTIVE', sessionId);
671|
672|    db.prepare(
673|      'INSERT INTO file_events (file_id, event_type, detail, timestamp) VALUES (?, ?, ?, ?)'
674|    ).run(sessionId, 'SESSION_REOPENED', null, Date.now());
675|
676|    // Set reopened session as focused
677|    db.prepare(
678|      'INSERT INTO session_focus (session_id, focused_at) VALUES (?, ?)'
679|    ).run(sessionId, Date.now());
680|  })();
681|}
682|```
683|
684|**History query (SESSION tab, HISTORY section):**
685|
686|```sql
687|SELECT
688|  s.session_id,
689|  s.alias,
690|  s.project_id,
691|  s.ended_at,
692|  s.state,
693|  COUNT(f.file_id) AS file_count
694|FROM sessions s
695|LEFT JOIN files f ON f.linked_session_id = s.session_id
696|WHERE s.state = 'CLOSED'
697|ORDER BY s.ended_at DESC;
698|```
699|
700|---
701|
702|### 11.5 Session Deletion (Permanent)
703|
704|When a session is deleted from the UI (e.g., via the widget), it triggers a **permanent removal of all associated data**, both from the database and the file system.
705|
706|**Process:**
707|- **Database Transaction:** All steps below are wrapped in a single database transaction to ensure atomicity. If any step fails, the entire deletion is rolled back (for DB operations).
708|- **File System Deletion (Immediate):**
709|  - All individual files (e.g., `~/Downloads/claude-vault/projects/<project_id>/sessions/<session_id>/files/...`) previously linked to the session are *permanently deleted from disk* using `fs.remove()`. Errors during file deletion are logged but do not block the subsequent database cleanup.
710|  - The entire session directory (`~/Downloads/claude-vault/projects/<project_id>/sessions/<session_id>`) is then *permanently deleted from disk*.
711|  - If the session's parent project directory (`~/Downloads/claude-vault/projects/<project_id>`) becomes empty after session deletion, that project directory is also deleted.
712|- **Database Cleanup:**
713|  - All records in `session_focus` related to the `session_id` are deleted.
714|  - The `sessions` table entry for the `session_id` is deleted.
715|  - *Note:* Files are NOT unlinked or moved to `unlinked` storage during deletion; they are permanently removed if they reside within the session's directory.
716|- A "Reveal in Finder" function is exposed via IPC (`reveal-session-folder`), which uses `electron.shell.showItemInFolder()` to open the session's directory in the macOS Finder.
717|  - The function takes `session_id` as an argument, constructs the full path to the session's directory within the `projectStore`, and then invokes the shell command.
718|
719|**User Confirmation:** Deletion requires an explicit confirmation prompt in the UI (e.g., `⚠ PERMANENT DELETE\n\nThis will remove the session info, file links, *and all associated files/folders on disk* forever. This action cannot be undone.\n\nAre you sure?`).
720|
721|---
722|
723|### 12. Updated config.json Fields
724|
725|```json
726|{
727|  "max_concurrent_sessions": 5
728|}
729|```
730|