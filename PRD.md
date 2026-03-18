# PRD — ClaudeVault: File Pipeline & Session Continuity System

**Version:** 0.1.0  
**Status:** Draft  
**Owner:** TBD  
**Last Updated:** 2026-03-18

---

## 1. Problem Statement

Claude.ai conversations have a hard context limit. When that limit is approached or hit, users lose continuity — files they uploaded, context they built, and work state they established are all severed. There is no native mechanism for:

- Carrying files across sessions
- Knowing which files were used in a session
- Avoiding re-upload friction at session start
- Auditing what happened in past sessions

This system solves that. It does not extend Claude's context window. It builds a **persistent, local layer** that tracks files, links them to sessions, and re-surfaces them intelligently when a new session starts.

---

## 2. Goals

| Goal | Priority |
|------|----------|
| Automatically detect and ingest files downloaded during a Claude session | P0 |
| Link ingested files to the correct session deterministically | P0 |
| Store file metadata in a queryable local database | P0 |
| Surface relevant files when a new session begins (suggestions, not auto-upload) | P1 |
| Provide a safe, confirmed cleanup process for old project files | P1 |
| Allow manual reassignment of incorrectly linked files | P2 |

---

## 3. Non-Goals

This PRD explicitly does not cover:

- Syncing files to the cloud or any remote server
- Uploading files to Claude automatically without user confirmation
- Modifying Claude's interface or injecting into the Claude web app directly (no scraping, no DOM injection)
- Managing conversation text content — only **files**
- Replacing session summaries or prompt engineering workflows

---

## 4. Users

**Primary user:** A single developer or power user running Claude heavily — multiple sessions per day, across multiple projects, with frequent file uploads (CSVs, code, images, documents).

**Secondary user:** A technical team where one person manages the tool on behalf of the team. Multi-user is out of scope for v1.

---

## 5. Core User Stories

### 5.1 File Ingestion

> As a user, when I download a file during a Claude session, I want it automatically captured and stored — so I don't lose track of it.

**Acceptance criteria:**
- File watcher detects the file within 5 seconds of it stabilizing (no partial downloads)
- File is hashed, renamed to a stable format, and moved to the correct project directory (`~/Downloads/claude-vault/projects/<project_id>/sessions/<session_id>/files`) or unlinked directory (`~/Downloads/claude-vault/unlinked/<date>`)
- Metadata is written to the DB immediately
- Duplicate files (same hash) are not stored twice — the existing record is linked instead

---

### 5.2 Session Linking

> As a user, when my session approaches its context limit, I want files from that session linked to it — so I know what belongs where.

**Acceptance criteria:**
- Session state must be externally trackable (see TRD §4 for how this is detected)
- Files ingested while session is in `NEAR_LIMIT` or `FINAL_WINDOW` state are linked to that session's ID
- Files ingested outside those states are stored as `unlinked`
- No file is ever silently dropped — all files land somewhere

---

### 5.3 File Suggestion on New Session

> As a user, starting a new Claude session, I want to see which files from my last session are relevant — so I can re-upload with one click instead of hunting through Downloads.

**Acceptance criteria:**
- Suggestions are shown before the user sends their first message in a new session
- Suggestions are ranked by filename similarity, recency, and session overlap score
- User must explicitly confirm before any file is prepared for upload
- "Auto-upload" mode is opt-in, off by default, and requires explicit toggle

---

### 5.4 Cleanup

> As a user, I want to be reminded to clean up old project files after 30 days — but I want to decide what happens to each project, not have the system decide for me.

**Acceptance criteria:**
- Cleanup check runs once per day, silently
- Prompt appears once per eligible project, not repeatedly
- User can choose: Delete / Archive (zip) / Keep for each project independently
- Archive is stored at a predictable path with a datestamped filename
- Nothing is deleted without an explicit user confirmation action

---

### 5.5 Manual Reassignment

> As a user, if a file was linked to the wrong session, I want to reassign it — so my records stay accurate.

**Acceptance criteria:**
- Any file can be reassigned to any session via the UI
- Reassignment is logged in `file_events` with event type `REASSIGNED`
- The original link is preserved in the event log (not overwritten)

---

## 6. Out-of-Scope for v1

- Multi-project file deduplication across projects
- Natural language search across file contents
- Integration with external storage (S3, Google Drive, Dropbox)
- Collaborative or multi-user access
- Automated Playwright file upload (flagged for v2)

---

## 7. Success Metrics

| Metric | Target |
|--------|--------|
| File detection latency | < 5s from stabilization |
| False positive rate (unrelated downloads ingested) | < 5% |
| User confirmation rate on suggestions (engagement) | > 60% |
| Zero silent data loss events | Hard requirement — 0 tolerance |

---

## 8. Constraints

- **Local-only:** All data stays on-device. No network calls for file storage.
- **macOS-first:** v1 targets macOS. Linux is secondary. Windows is not in scope.
- **No Claude API dependency:** This tool does not call Claude's API. It is a local file management layer.
- **SQLite only:** No Postgres, no external DB. Must work without a running server.

---

## 9. Open Questions

| # | Question | Owner | Status |
|---|----------|-------|--------|
| 1 | How is session state (`NEAR_LIMIT`, `FINAL_WINDOW`) detected without Claude API access? | Eng | **UNRESOLVED — blocks P0** |
| 2 | What is the exact token/message threshold for `NEAR_LIMIT`? | Product | Unresolved |
| 3 | Should the watcher track all file types or a configurable allowlist? | Product | Unresolved |
| 4 | Who defines "project"? Is it user-created or auto-inferred? | Product | Unresolved |
| 5 | Should `unlinked` files have a separate TTL from project-linked files? | Product | Unresolved |

---

## 10. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Session state cannot be reliably detected externally | High | Must be resolved before P0 build starts. No workaround is acceptable. |
| File watcher misses partial downloads | Medium | Enforce stabilization check (size + extension) before ingestion |
| Hash collision causes incorrect deduplication | Low | Use SHA-256; document the assumption |
| User accidentally deletes active project files via cleanup prompt | Medium | Require typed confirmation for delete; archive is the default action |

---

## 11. Multi-Session & Session History (v1.1 Addition)

### 11.1 Multi-Session Switching

> As a user working across multiple projects simultaneously, I want to switch between active sessions from the menu bar widget — so I don't lose context when moving between projects.

**Acceptance criteria:**
- Multiple sessions can be ACTIVE at the same time (one per project)
- The widget header shows the **currently focused** session
- A session switcher in the SESSION tab lists all active sessions
- Switching focus does not close or modify any session — it only changes which session new file ingestions are linked to
- The focused session is persisted across widget close/open
- Maximum concurrent active sessions: configurable (default: 5)

---

### 11.2 Session Alias (Readable Name)

> As a user, I want to give each session a readable name I choose — so I can identify sessions at a glance without reading hash IDs.

**Acceptance criteria:**
- Every session has an optional `alias` field set by the user
- The alias is display-only — the backend always uses the hash session_id as the primary key
- Display format everywhere in the UI: **Alias (Primary, Orange)** on top, **Hash (Secondary, Grey)** below. Action buttons are compact icons.
- If no alias is set, display shows only the hash: `TRD-A1B2`
- The alias can be set or changed at any time, including after a session is closed
- Alias is limited to 32 characters, alphanumeric + hyphens + underscores only
- Renaming is inline and discoverable via double-click and a text-cursor hover (no separate modal).
- The alias is stored in the `sessions` table alongside the hash ID — never replaces it

---

### 11.3 Accidental Session Close Recovery

> As a user, if I close a session accidentally, I want to find it in session history and reopen it — so I don't lose the file links and context I built.

**Acceptance criteria:**
- All sessions regardless of state (ACTIVE, CLOSED, FINAL_WINDOW) are accessible in session history
- Closed sessions appear in a HISTORY section below active sessions in the SESSION tab
- Reopening a closed session sets its state back to ACTIVE and restores all linked file associations
- No data is lost when a session is closed — closing is a state change, not a deletion
- The history list shows: `HASH ~ alias`, project name, closed timestamp, file count
- History is sorted by `ended_at` descending (most recently closed first)
- History is not paginated in v1 — all closed sessions for the current project are shown

---

### 11.4 Full Session Deletion (Permanent)

> As a user, when I delete a session, I want all associated files and its dedicated session folder to be permanently removed from disk — so my file system remains clean and organized.

**Acceptance criteria:**
- Deleting a session from the widget triggers a **permanent deletion** warning requiring explicit confirmation.
- All files previously linked to the session (within `~/Downloads/claude-vault/projects/<project_id>/sessions/<session_id>/files`) are deleted from disk.
- The entire session directory (`~/Downloads/claude-vault/projects/<project_id>/sessions/<session_id>`) is deleted from disk.
- All database entries for the session and its file links are removed.
- If the session's project folder becomes empty after session deletion, the project folder itself is deleted (e.g., `~/Downloads/claude-vault/projects/<project_id>`).
- Files initially ingested as `unlinked` and later linked to a session, upon session deletion, are **not** moved back to `unlinked` but are instead permanently deleted if they reside within the session's folder.
- A "Reveal in Finder" button is present on each session row, allowing users to quickly locate the session's folder on disk.
- Any errors during file system deletion are logged but do not prevent database cleanup.

---

## 12. Updated Open Questions

| # | Question | Owner | Status |
|---|----------|-------|--------|
| 6 | What is the max concurrent active sessions limit? | Product | Default 5, configurable |
| 7 | Should alias changes propagate to already-exported summaries? | Product | Unresolved |
| 8 | When a closed session is reopened, does it inherit the original session's state or start as ACTIVE? | Eng | Start as ACTIVE |
| 9 | Should alias be searchable/filterable in the session history list? | Product | Unresolved |