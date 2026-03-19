# PRD — ClaudeVault: File Pipeline & Session Continuity System

**Version:** 0.4.0
**Status:** Draft
**Owner:** TBD
**Last Updated:** 2026-03-18
**Changes from v0.3.0:** Adopted compact 4-tab IA (`SESSION | FILES | TRACK | OPS`) while preserving all existing capabilities. TRACK groups ACCTS + CHATS and OPS groups ACTIONS + HANDOFF.

---

## 1. Problem Statement

Claude.ai conversations have a hard context limit. When that limit is approached or hit, users lose continuity — files they uploaded, context they built, and work state they established are all severed. There is no native mechanism for:

- Carrying files across sessions
- Knowing which files were used in a session
- Avoiding re-upload friction at session start
- Auditing what happened in past sessions

Power users running multiple Claude.ai accounts also have no mechanism for:

- Knowing which accounts are currently rate-limited and which are available
- Tracking when a 5-hour, daily, or weekly limit will reset per account
- Deciding which account to switch to without guessing

This system solves all of the above. It does not extend Claude's context window. It builds a **persistent, local layer** that tracks files, links them to sessions, tracks per-account usage limits, and re-surfaces files intelligently when a new session starts.

---

## 2. Goals

| Goal | Priority |
|------|----------|
| Automatically detect and ingest files downloaded during a Claude session | P0 |
| Link ingested files to the correct session deterministically | P0 |
| Store file metadata in a queryable local database | P0 |
| Track per-account usage limits (5HR / DAILY / WEEKLY) with live reset countdowns | P0 |
| Parse a structured Claude summary into a ready-to-copy handoff template | P0 |
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
- Automatically detecting when an account has hit a limit — limits are **manually logged** by the user; the system only tracks countdowns from the logged timestamp
- Linking sessions to specific accounts (accounts and sessions are independent in v1)
- Calling the Anthropic API for any purpose — this is a fully local tool with no outbound network calls
- Multi-user or collaborative access

---

## 4. Users

**Primary user:** A single developer or power user running Claude heavily — multiple sessions per day, across multiple projects, with frequent file uploads (CSVs, code, images, documents). May own 2–5 Claude.ai accounts across Free, Pro, and Max plans and rotate between them as limits are hit.

**Secondary user:** A technical team where one person manages the tool on behalf of the team. Multi-user is out of scope for v1.

---

## 5. Core User Stories

### 5.1 File Ingestion

> As a user, when I download a file during a Claude session, I want it automatically captured and stored — so I don't lose track of it.

**Acceptance criteria:**
- File watcher detects the file within 5 seconds of it stabilizing (no partial downloads)
- File is hashed, renamed to a stable format, and moved to the correct project directory (`~/Downloads/claudevault/projects/<project_id>/sessions/<session_id>/files`) or unlinked directory (`~/Downloads/claudevault/unlinked/<date>`)
- Metadata is written to the DB immediately
- Duplicate files (same hash) are not stored twice — the existing record is linked instead

---

### 5.2 Files Tab (Unified)

> As a user, I want to see both suggested files for my session and recently downloaded files in one unified list — so I can manage my session context without redundancy.

**Acceptance criteria:**
- One tab labeled **FILES** replaces the separate "FILES" and "SUGGEST" tabs.
- The tab features a single scrollable list of files.
- **Suggested** files are prioritized and appear at the top of the list.
- Redundant entries (files that are both suggested and recent) are deduplicated into a single row.
- A badge on the tab header shows the count of suggested files.
- Suggested files are visually highlighted (e.g., coral text, "SUGG" label).
- User can select any file via checkboxes and click "UPLOAD SELECTED" to link them to the active session.
- "UPLOAD SELECTED" is disabled when no files are selected or no session is active.
- The latest file in the list is visually highlighted with a left border.
- Metadata (timestamp, session alias, or extension) is shown for each file.
- If a file is already linked to a session, it shows the session's alias or hash.

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

### 5.6 Account Limit Tracking

> As a user who owns multiple Claude.ai accounts, I want to log when an account hits a usage limit and see a live countdown to its reset — so I always know which accounts are available and can switch without guessing.

**Acceptance criteria:**
- Accounts are manually registered in the TRACK tab (ACCTS section) with: alias (required), email (optional), plan (FREE / PRO / MAX / TEAM)
- Each account independently tracks three limit types: `5HR`, `DAILY`, `WEEKLY`
- Logging a hit on a `(account, limit_type)` pair records `hit_at` and computes `reset_at = hit_at + window_ms` from config
- A live countdown shows time remaining until reset for each active limit — updated every second in the UI
- When `reset_at <= now()`, the limit clears automatically on the next read — no user action required
- Three indicator dots on each account row (left to right: `5HR`, `DAILY`, `WEEKLY`) show status at a glance: coral pulsing = currently hit, muted grey = clear
- Clicking an account row expands it to show one row per limit type: type label, OK/HIT status, countdown or 'NOT LOGGED', and a LOG HIT button
- LOG HIT is disabled when that limit is already active (hit and not yet reset)
- When a limit is currently in HIT state, the expanded row also shows a compact `X` icon button to undo a mistaken hit; the `X` is hidden when the row is `NOT LOGGED` or `OK`
- Clicking `X` revokes the most recent active limit hit for that `(account, limit_type)` by removing the latest matching `account_limit_events` row, then immediately refreshes status and countdown in the UI
- An account that currently has an active session shows an `ACTIVE` badge on its row

---

### 5.8 Chat History Tracking

> As a user, I want to manually record the names of the Claude conversations I start and associate them with my current session — so I can easily find the exact chat that corresponds to a set of ingested files later.

**Acceptance criteria:**
- The TRACK tab includes a **CHATS** section.
- The CHATS section displays the currently focused session's alias or hash at the top.
- A form allows inputting a **Chat Name** (required) and **Notes** (optional).
- Clicking **+ ADD** saves the entry with the current session ID and a timestamp.
- The **Chat History** section shows a list of all chats associated with the active session, sorted by recency (newest first).
- The latest chat entry is visually highlighted with a red vertical bar and a "LATEST" badge.
- Each entry shows: **Chat Name · Account Alias**, Timestamp, Session ID ~ Alias, and any Notes (prefixed with '↳').
- Users can delete any chat entry with a confirmation prompt.
- The list updates automatically when switching sessions or adding new entries.

### 5.7 Handoff Summary & Template

> As a user nearing a session's context limit, I want to ask Claude for a structured summary, paste it into the widget, and get a ready-to-copy handoff prompt — so the next chat (on any account) picks up exactly where this one left off.

**Acceptance criteria:**
- The OPS tab (HANDOFF section) stores the summary prompt (§5.7.1) and presents it with a one-click COPY button — the user never has to type or remember it
- After pasting Claude's structured response into the widget textarea, clicking PARSE → BUILD TEMPLATE produces the filled handoff template (§5.7.2) with no API call, no network request — parsing is a client-side regex operation
- The `FILES USED` section from Claude's output is shown in the widget as a reference checklist only (it does not appear as text in the copied template)
- The copied handoff template's `FILES:` section contains only `(Re-upload the required files now)` on the following line
- The filled template is shown in a scrollable monospace block and can be copied to the clipboard with one click
- If Claude's response is missing any of the six required sections, the widget shows an inline error naming the exact missing section — the template is not produced until all six sections are present
- The most recently parsed template is saved to the DB (`handoff_drafts` table) immediately after a successful parse — if the user closes the widget before copying, the draft can be restored on the next open
- The PARSE button is disabled when the textarea is empty

---

### 5.7.1 Summary Prompt (User Pastes Into Claude)

This exact prompt is stored in the widget (OPS → HANDOFF section) and copyable with one click. It is not configurable.

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

---

### 5.7.2 Handoff Template (Copied Into New Chat)

After the widget parses Claude's structured response, it fills this exact template. The section content is mapped directly from Claude's output. The template `FILES:` section contains only the re-upload instruction; the verbatim `4. FILES USED:` content is shown separately in the widget for reference and is not included in the copied template. The template structure — headers, spacing, and closing lines — is immutable.

```
We were working on the following:

OBJECTIVE:
{OBJECTIVE}

CURRENT STATE:
{CURRENT_STATE}

KEY DECISIONS:
{KEY_DECISIONS}

IMPORTANT CONTEXT:
{IMPORTANT_CONTEXT}

FILES:
(Re-upload the required files now)

NEXT STEPS:
{NEXT_STEPS}

Continue exactly from NEXT STEPS.
Do not restart or reinterpret the problem.
```

**Rules enforced at the widget level:**
- The copied template does not include the verbatim `4. FILES USED:` content; it contains only `(Re-upload the required files now)` under `FILES:`
- No section is omitted even if Claude's content is brief
- The closing two lines are immutable

---

## 6. Out-of-Scope for v1

- Multi-project file deduplication across projects
- Natural language search across file contents
- Integration with external storage (S3, Google Drive, Dropbox)
- Collaborative or multi-user access
- Automated Playwright file upload (flagged for v2)
- Automatic detection of account limit state (no API or DOM access to this data exists)
- Calling any external API for any purpose — the handoff parser is a local regex splitter
- Linking file ingestion events to a specific account

---

## 7. Success Metrics

| Metric | Target |
|--------|--------|
| File detection latency | < 5s from stabilization |
| False positive rate (unrelated downloads ingested) | < 5% |
| User confirmation rate on suggestions (engagement) | > 60% |
| Zero silent data loss events | Hard requirement — 0 tolerance |
| Account limit state accuracy | 100% — state is always derived from DB at read time, never stored as mutable in-memory state |
| Handoff parse success rate on well-formed Claude summaries | > 99% — regex on a fixed format is deterministic |

---

## 8. Constraints

- **Fully local — no network calls of any kind:** All data stays on-device. No outbound requests for file storage, account limit detection, or handoff parsing. The handoff parser is a client-side regex splitter operating on the user's pasted text.
- **macOS-first:** v1 targets macOS. Linux is secondary. Windows is not in scope.
- **No Claude API dependency:** This tool does not call Claude's API. The handoff summary is produced by the user pasting a prompt into Claude manually — the widget only parses the structured response that comes back.
- **SQLite only:** No Postgres, no external DB. Must work without a running server.
- **Manual limit logging only:** Claude.ai exposes no programmatic data about account usage limits. All limit events are user-initiated. The system tracks countdowns from the logged timestamp — nothing more.

---

## 9. Open Questions

| # | Question | Owner | Status |
|---|----------|-------|--------|
| 1 | How is session state (`NEAR_LIMIT`, `FINAL_WINDOW`) detected without Claude API access? | Eng | **UNRESOLVED — blocks P0** |
| 2 | What is the exact token/message threshold for `NEAR_LIMIT`? | Product | Unresolved |
| 3 | Should the watcher track all file types or a configurable allowlist? | Product | Resolved: Configurable via allowlist (default: .txt, .pdf, .py, .js, .csv, .json, .md, .png, .jpg, .html, .docx, .xlsx, .tsv, .java, .cpp, .jpeg) |
| 4 | Who defines "project"? Is it user-created or auto-inferred? | Product | Unresolved |
| 5 | Should `unlinked` files have a separate TTL from project-linked files? | Product | Unresolved |
| 6 | What is the max concurrent active sessions limit? | Product | Default 5, configurable |
| 7 | Should alias changes propagate to already-exported summaries? | Product | Unresolved |
| 8 | When a closed session is reopened, does it inherit the original session's state or start as ACTIVE? | Eng | Start as ACTIVE |
| 9 | Should alias be searchable/filterable in the session history list? | Product | Unresolved |
| 10 | Should weekly limit reset be rolling 7 days from `hit_at`, or pinned to Monday 00:00 local time? | Product | Default rolling 7 days — configurable |
| 11 | Should ACCTS tab show a warning banner when all registered accounts have an active hit on the same limit type simultaneously? | Product | Unresolved |
| 12 | Should the widget store the last-used handoff template so the user can retrieve it if they close the widget before copying? | Product | Yes — saved to `handoff_drafts` table on successful parse |

---

## 10. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Session state cannot be reliably detected externally | High | Must be resolved before P0 build starts. No workaround is acceptable. |
| File watcher misses partial downloads | Medium | Enforce stabilization check (size + extension) before ingestion |
| Hash collision causes incorrect deduplication | Low | Use SHA-256; document the assumption |
| User accidentally deletes active project files via cleanup prompt | Medium | Require typed confirmation for delete; archive is the default action |
| Anthropic changes account limit windows, breaking countdown accuracy | Low | Windows are configurable in `config.json` — user updates them manually; no code change required |
| Claude produces a malformed summary (missing sections) | Low | Widget detects missing sections and shows an inline error per field — does not silently produce a partial template |

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
- Display format everywhere in the UI: `HASH ~ alias` (e.g. `TRD-A1B2 ~ trading-dashboard`)
- If no alias is set, display shows only the hash: `TRD-A1B2`
- The alias can be set or changed at any time, including after a session is closed
- Alias is limited to 32 characters, alphanumeric + hyphens + underscores only
- Renaming is inline — no separate modal. Double-click or pencil icon on the session name
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

> As a user, when I delete a session from the widget, I want all associated files and the session folder permanently removed from disk so my Downloads stay clean.

**Acceptance criteria:**
- Active and history session rows include a compact `DELETE` icon button
- Clicking `DELETE` prompts a permanent deletion warning that explicitly states the action cannot be undone
- On confirmation: the session row and its linked file associations are removed from the database, and the entire session directory under `~/Downloads/claude-vault/projects/<project_id>/sessions/<session_id>` is permanently deleted from disk
- If the session's parent project folder becomes empty after session deletion, that project folder is also deleted

---

### 11.5 Reveal in Finder (Quick Access)

> As a user, I want a `REVEAL in Finder` icon button on each session row so I can locate the exact folder immediately.

**Acceptance criteria:**
- `REVEAL` is available on both active session rows and session history rows
- Clicking `REVEAL` opens the session directory in macOS Finder

---

## 12. Updated Open Questions

| # | Question | Owner | Status |
|---|----------|-------|--------|
| 6 | What is the max concurrent active sessions limit? | Product | Default 5, configurable |
| 7 | Should alias changes propagate to already-exported summaries? | Product | Unresolved |
| 8 | When a closed session is reopened, does it inherit the original session's state or start as ACTIVE? | Eng | Start as ACTIVE |
| 9 | Should alias be searchable/filterable in the session history list? | Product | Unresolved |

---

## 13. Account Tracking

### 13.1 What is tracked and why

Claude.ai enforces per-account usage limits: a 5-hour rolling window, a daily cap, and a weekly cap. The exact thresholds vary by plan and are not exposed programmatically. When a user hits a limit on one account, they switch to another. Without a tracking layer, they have no visibility into which accounts are available and when blocked ones will reset.

ClaudeVault tracks this manually. The user logs a hit — the system records `hit_at`, computes `reset_at = hit_at + window_ms`, and counts down. When the window expires, the limit clears automatically on the next read. No scraping, no API calls, no heuristics.

### 13.2 Limit types

| Type | Default window | Notes |
|------|---------------|-------|
| `5HR` | 5 hours (18,000,000 ms) | Rolling from time of hit |
| `DAILY` | 24 hours (86,400,000 ms) | Rolling from time of hit |
| `WEEKLY` | 7 days (604,800,000 ms) | Rolling from time of hit. Pin-to-Monday option configurable |

All windows are set in `config.json` under `limit_windows`. If Anthropic changes their reset policy, the user updates config — no code change required.

### 13.3 Account registration

Accounts are registered manually in the ACCTS tab. Required: alias. Optional: email, plan. There is no sync with Claude.ai — registration is purely local bookkeeping. Accounts support soft-delete (hidden from ACCTS tab, `is_active = 0`) but not hard-delete, to preserve the limit event history in `account_limit_events`.

### 13.4 Relationship to sessions and handoff

In v1, accounts and sessions are independent. Sessions track file ingestion context. Accounts track rate limit windows. There is no foreign key linking a session to an account.

The handoff flow (§5.7) is how the user manually bridges a limit hit — they paste a prompt into Claude, get a structured summary, paste that into the widget, and the widget produces a ready-to-copy template for the new chat. This flow involves no API calls and no automation beyond client-side text parsing.

### 13.5 Out of scope for account tracking in v1

- Automatic limit detection of any kind
- Calling any API as part of the handoff flow
- Linking sessions to specific accounts
- Push notifications when a limit resets
- Importing or syncing account data from Claude.ai