// State management
let currentStatus = null;
let currentTab = 'session';
let editingAliasForSessionId = null;
let selectedFileIds = new Set();

/**
 * Tab Switching (DG-043)
 */
function switchTab(tabId) {
    console.log(`[POPOVER] Switching to tab: ${tabId}`);
    currentTab = tabId;
    
    document.querySelectorAll('.tab-item').forEach(el => {
        const isTarget = el.id === `tab-${tabId}`;
        el.classList.toggle('active', isTarget);
    });
    
    document.querySelectorAll('.panel').forEach(el => {
        const isTarget = el.id === `panel-${tabId}`;
        el.classList.toggle('active', isTarget);
    });

    try {
        if (tabId === 'session') loadSessions();
        if (tabId === 'files') {
            loadFilesTab();
        }
        if (tabId === 'track') {
            loadAccounts();
            loadChats();
        }
        if (tabId === 'ops') loadHandoff();
    } catch (err) {
        console.error(`[POPOVER] Load Tab Error: ${err.message}`);
    }
}

/**
 * UI Updates
 */
async function updateStatus() {
    try {
        currentStatus = await window.electronAPI.getStatus();
        if (!currentStatus) return;

        const { activeSession, watcherState, watchDir, activeSessions, sessionHistory } = currentStatus;
        
        // Popover Header (DG-062 Updated)
        const headerStateLabel = document.getElementById('header-state-label');
        const headerStateDot = document.getElementById('header-state-dot');
        
        if (activeSession) {
            // Updated: Header title becomes the active session name (alias or project)
            const hash = activeSession.session_id.slice(0, 8);
            const alias = activeSession.alias || activeSession.project_name || hash;
            const headerTitleEl = document.querySelector('.header-title');
            if (headerTitleEl) {
                headerTitleEl.textContent = alias.toUpperCase();
            }

            // Subtitle: Hash small below
            headerStateLabel.innerHTML = `
                <div class="session-name-stack" style="align-items: flex-end;">
                    <span class="session-hash-secondary">${hash} · ${activeSession.state}</span>
                </div>
            `;
            
            const color = activeSession.state === 'ACTIVE' ? '#9CA3AF' : 
                         (activeSession.state === 'NEAR_LIMIT' ? 'rgba(255, 75, 53, 0.7)' : '#FF4B35');
            if (headerStateDot) headerStateDot.style.backgroundColor = color;

            // Update Detail Section
            setElText('sess-id', hash);
            setElText('sess-proj', activeSession.project_id.slice(0, 12));
            setElText('sess-start', new Date(activeSession.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }));
            setElText('sess-state', activeSession.state);
            const stateEl = document.getElementById('sess-state');
            if (stateEl) stateEl.style.color = color;
            
            setElText('sess-files', currentStatus.activeSessionFileCount || 0);
            
            const msgCount = 0; 
            const limit = 30;
            setElText('sess-msg', `${msgCount} / ${limit}`);
            const progress = document.getElementById('sess-progress');
            if (progress) progress.style.width = `${(msgCount / limit) * 100}%`;
        } else {
            const headerTitleEl = document.querySelector('.header-title');
            if (headerTitleEl) {
                headerTitleEl.textContent = 'CLAUDEVAULT';
            }
            headerStateLabel.textContent = 'NO ACTIVE SESSION';
            if (headerStateDot) headerStateDot.style.backgroundColor = '#555555';
            
            setElText('sess-id', 'NONE');
            setElText('sess-proj', 'NONE');
            setElText('sess-state', 'IDLE');
            setElText('sess-files', '0');
            setElText('sess-start', '--:--');
            setElText('sess-msg', '0 / 30');
            const progress = document.getElementById('sess-progress');
            if (progress) progress.style.width = '0%';
        }

        if (currentTab === 'session') {
            if (!editingAliasForSessionId) {
                renderActiveSessions(activeSessions);
                renderSessionHistory(sessionHistory);
            }
        } else if (currentTab === 'files') {
            loadFilesTab();
        } else if (currentTab === 'track') {
            loadAccounts();
            loadChats();
        } else if (currentTab === 'ops') {
            loadHandoff();
        }

        // Bottom status bar sync
        setElText('status-watcher-text', watcherState);
        const statusWatcher = document.getElementById('status-watcher-container');
        const statusPulse = document.getElementById('status-pulse');
        if (statusWatcher) {
            const color = watcherState === 'WATCHING' ? 'var(--accent)' : (watcherState === 'ERROR' ? 'var(--accent)' : '#555555');
            statusWatcher.style.color = color;
            if (statusPulse) statusPulse.style.backgroundColor = color;
        }

        setElText('status-last', '--:--');
        setElText('status-db', '1.2 MB');
    } catch (err) {
        console.error(`[POPOVER] Status Update Error: ${err.message}`);
    }
}

function setElText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

/**
 * Render Active Sessions (DG-060 Updated)
 */
function renderActiveSessions(sessions) {
    const list = document.getElementById('active-sessions-list');
    const warning = document.getElementById('active-sessions-warning');
    if (!list) return;

    list.innerHTML = '';
    
    const maxSessions = 5;
    if (sessions.length >= maxSessions) {
        warning.classList.remove('hidden');
        warning.textContent = `⚠ MAX SESSIONS REACHED · ${sessions.length}/${maxSessions}`;
    } else {
        warning.classList.add('hidden');
    }

    sessions.forEach(s => {
        const row = document.createElement('div');
        row.className = `session-switcher-row ${s.isFocused ? 'focused' : ''}`;
        row.onclick = () => window.electronAPI.switchFocus(s.session_id);

        const hash = s.session_id.slice(0, 8);
        const alias = s.alias || "UNNAMED SESSION";
        
        row.innerHTML = `
            <div class="session-name-stack">
                <span class="session-alias-primary" id="alias-display-${s.session_id}" style="${!s.alias ? 'opacity:0.4;' : ''}" title="Double-click to rename">${alias.toUpperCase()}</span>
                <span class="session-hash-secondary">${hash} · ${s.project_name}</span>
            </div>
            <div class="action-btns-compact">
                ${s.isFocused ? '<span class="focused-label" style="margin-right:8px;">FOCUSED</span>' : ''}
                <button class="icon-btn warn delete-btn" data-id="${s.session_id}" title="Delete Session">
                    <div class="icon-pixel icon-delete"></div>
                </button>
                <button class="icon-btn reveal-btn" data-id="${s.session_id}" title="Reveal in Finder">
                    <div class="icon-pixel icon-reveal"></div>
                </button>
            </div>
        `;

        // Handle Inline Rename
        const aliasSpan = row.querySelector(`#alias-display-${s.session_id}`);
        aliasSpan.ondblclick = (e) => {
            e.stopPropagation();
            startEditingAlias(s.session_id, s.alias || '', aliasSpan);
        };

        // Handle Delete
        row.querySelector('.delete-btn').onclick = (e) => {
            e.stopPropagation();
            handleAction('delete-session', s.session_id);
        };

        // Handle Reveal in Finder
        row.querySelector('.reveal-btn').onclick = (e) => {
            e.stopPropagation();
            window.electronAPI.revealSessionFolder(s.session_id);
        };

        list.appendChild(row);
    });
}

function startEditingAlias(sessionId, currentAlias, spanEl) {
    if (editingAliasForSessionId) return;
    editingAliasForSessionId = sessionId;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'alias-input';
    input.value = currentAlias;
    input.maxLength = 32;

    const commit = async () => {
        const val = input.value.trim().replace(/[^a-zA-Z0-9_-]/g, '');
        await window.electronAPI.setAlias(sessionId, val);
        editingAliasForSessionId = null;
        updateStatus();
    };

    input.onkeydown = (e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
            editingAliasForSessionId = null;
            updateStatus();
        }
    };
    input.onblur = commit;

    spanEl.parentNode.replaceChild(input, spanEl);
    input.focus();
}

/**
 * Render Session History (DG-061 Updated)
 */
function renderSessionHistory(history) {
    const container = document.getElementById('session-history-container');
    const list = document.getElementById('session-history-list');
    if (!list || !container) return;

    if (history.length === 0) {
        container.classList.add('hidden');
        return;
    } else {
        container.classList.remove('hidden');
    }

    list.innerHTML = '';
    history.forEach(s => {
        const row = document.createElement('div');
        row.className = 'history-row';
        
        const hash = s.session_id.slice(0, 8);
        const alias = s.alias || "UNNAMED SESSION";
        const timeStr = new Date(s.ended_at).toLocaleDateString([], { month: 'short', day: 'numeric' });

        row.innerHTML = `
            <div class="session-name-stack">
                <span class="session-alias-primary" id="alias-display-${s.session_id}" style="${!s.alias ? 'opacity:0.4;' : ''}" title="Double-click to rename">${alias.toUpperCase()}</span>
                <span class="session-hash-secondary">${hash} · ${s.project_name} · ${s.file_count} FILES · ${timeStr}</span>
            </div>
            <div class="action-btns-compact">
                <button class="icon-btn reopen-btn" title="Reopen Session">
                    <div class="icon-pixel icon-reopen"></div>
                </button>
                <button class="icon-btn warn delete-btn" title="Delete Permanent">
                    <div class="icon-pixel icon-delete"></div>
                </button>
                <button class="icon-btn reveal-btn" title="Reveal in Finder">
                    <div class="icon-pixel icon-reveal"></div>
                </button>
            </div>
        `;
        
        // Handlers
        const aliasSpan = row.querySelector(`#alias-display-${s.session_id}`);
        aliasSpan.ondblclick = (e) => {
            e.stopPropagation();
            startEditingAlias(s.session_id, s.alias || '', aliasSpan);
        };

        row.querySelector('.reopen-btn').onclick = (e) => {
            e.stopPropagation();
            window.electronAPI.reopenSession(s.session_id);
        };

        row.querySelector('.delete-btn').onclick = (e) => {
            e.stopPropagation();
            handleAction('delete-session', s.session_id);
        };

        row.querySelector('.reveal-btn').onclick = (e) => {
            e.stopPropagation();
            window.electronAPI.revealSessionFolder(s.session_id);
        };

        list.appendChild(row);
    });
}

/**
 * ACTIONS Logic
 */
async function handleAction(action, value) {
    console.log(`[POPOVER] Action triggered: ${action} ${value || ''}`);
    try {
        if (action === 'set-state') {
            const active = currentStatus?.activeSession;
            if (active) {
                if (value === 'CLOSED') await window.electronAPI.stopSession();
                else await window.electronAPI.setSessionState(value);
            }
        } else if (action === 'new-session') {
            let projects = await window.electronAPI.listProjects();
            if (projects.length === 0) {
                await window.electronAPI.createProject('CLAUDE_VAULT');
                projects = await window.electronAPI.listProjects();
            }
            if (projects.length > 0) {
                await window.electronAPI.startSession(projects[0].project_id);
                switchTab('session');
            }
        } else if (action === 'open-vault') {
            window.electronAPI.showMain();
        } else if (action === 'suggest-files') {
            switchTab('files');
        } else if (action === 'unlinked-files') {
            switchTab('files');
        } else if (action === 'run-cleanup') {
            await checkCleanup();
            window.electronAPI.showMain();
        } else if (action === 'pause-watcher') {
            const isPausedNow = await window.electronAPI.toggleWatcher();
            const btn = document.getElementById('btn-pause-watcher');
            if (btn) btn.textContent = isPausedNow ? 'RESUME WATCHER' : 'PAUSE WATCHER';
        } else if (action === 'delete-session') {
            const confirmed = confirm("⚠ PERMANENT DELETE\n\nThis will remove the session info, file links, and all associated files/folders on disk forever.\n\nThis action cannot be undone. Are you sure?");
            if (confirmed) {
                await window.electronAPI.deleteSession(value);
            }
        }
        await updateStatus();
    } catch (err) {
        console.error(`[POPOVER] Action Error: ${err.message}`);
    }
}

function switchTrackSubtab(mode) {
    const acctsBtn = document.getElementById('track-sub-accts');
    const chatsBtn = document.getElementById('track-sub-chats');
    const acctsSection = document.getElementById('track-section-accts');
    const chatsSection = document.getElementById('track-section-chats');

    if (!acctsBtn || !chatsBtn || !acctsSection || !chatsSection) return;

    const showAccts = mode === 'accts';
    acctsBtn.classList.toggle('active', showAccts);
    chatsBtn.classList.toggle('active', !showAccts);
    acctsSection.classList.toggle('hidden', !showAccts);
    chatsSection.classList.toggle('hidden', showAccts);

    if (showAccts) {
        loadAccounts();
    } else {
        loadChats();
    }
}

/**
 * FILES, SUGGEST, LOG loading functions
 */
async function checkCleanup() { 
    try {
        const projects = await window.electronAPI.getCleanupEligible();
        const banner = document.getElementById('cleanup-banner');
        if (projects && projects.length > 0) {
            banner.classList.remove('hidden');
            setElText('cleanup-proj', projects[0].project_name);
            setElText('cleanup-count', projects[0].file_count);
        } else {
            banner.classList.add('hidden');
        }
    } catch (err) {
        console.error(`[POPOVER] Cleanup Check Error: ${err.message}`);
    }
}

async function loadSessions() {
    // Handled in updateStatus polling
}

async function loadFilesTab() {
    const container = document.getElementById('files-list');
    const uploadBtn = document.getElementById('btn-upload-suggested');
    const suggestCountEl = document.getElementById('suggest-count');
    if (!container) return;
    container.innerHTML = '';
    
    try {
        const activeSession = currentStatus?.activeSession;
        const activeSessionId = activeSession?.session_id || null;
        
        let suggestions = [];
        if (activeSession) {
            suggestions = await window.electronAPI.getSuggestions(activeSession.project_id) || [];
        }
        
        const files = await window.electronAPI.listRecentFiles(null) || [];
        
        // Update Suggest count in header
        if (suggestCountEl) suggestCountEl.textContent = suggestions.length;
        
        // Merge and Deduplicate by file_id
        // We prioritize suggestions in the final list
        const suggestSet = new Set(suggestions.map(s => s.file_id));
        const finalFiles = [...suggestions.map(s => ({ ...s, isSuggested: true }))];
        
        files.forEach(f => {
            if (!suggestSet.has(f.file_id)) {
                finalFiles.push({ ...f, isSuggested: false });
            }
        });

        if (finalFiles.length === 0) {
            container.innerHTML = '<div class="mono-small" style="padding:14px; color:var(--text-muted); text-align:center;">NO FILES FOUND</div>';
            return;
        }

        finalFiles.forEach((f, idx) => {
            const isLinkedToActive = f.linked_session_id === activeSessionId;
            const row = document.createElement('div');
            const isSelected = selectedFileIds.has(f.file_id);
            
            row.className = `file-row ${idx === 0 ? 'latest' : ''} ${isSelected ? 'selected' : ''}`;
            
            const timeStr = f.created_at ? new Date(f.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '--:--';
            const ext = (f.file_type || (f.original_name?.split('.').pop() || '')).toString().toUpperCase();
            
            const sessionDisplay = f.session_alias || (f.linked_session_id ? f.linked_session_id.slice(0, 8) : null);
            let statusText = f.isSuggested ? 'SUGG' : ext;
            let statusColor = f.isSuggested ? 'var(--accent)' : 'var(--accent-70)';

            if (isLinkedToActive) {
                statusText = 'LINKED';
                statusColor = '#4ADE80';
            } else if (sessionDisplay && !f.isSuggested) {
                statusText = sessionDisplay.toUpperCase();
                statusColor = '#9CA3AF';
            }

            row.innerHTML = `
              <div class="file-checkbox" style="${isLinkedToActive ? 'background-color:rgba(74, 222, 128, 0.1); border-color:#4ADE80; position:relative;' : ''}">
                ${isLinkedToActive ? '<div style="position:absolute; width:6px; height:6px; background:#4ADE80; top:2px; left:2px;"></div>' : ''}
              </div>
              <div class="file-name-cell"><span style="${f.isSuggested ? 'color:var(--accent); font-weight:600;' : ''}">${f.original_name || 'UNKNOWN'}</span></div>
              <div class="file-meta-cell">
                <span class="mono-small" style="color:#555555; font-size:7px;">${timeStr}</span>
                <span class="mono-small" style="color: ${statusColor}; font-size:6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 52px; text-align: right;">${statusText}</span>
              </div>
            `;

            row.onclick = () => {
                if (selectedFileIds.has(f.file_id)) {
                    selectedFileIds.delete(f.file_id);
                    row.classList.remove('selected');
                } else {
                    selectedFileIds.add(f.file_id);
                    row.classList.add('selected');
                }
                if (uploadBtn) {
                    uploadBtn.disabled = selectedFileIds.size === 0;
                    const countText = selectedFileIds.size > 0 ? `UPLOAD (${selectedFileIds.size})` : 'UPLOAD SELECTED';
                    uploadBtn.textContent = countText;
                }
            };

            container.appendChild(row);
        });
    } catch (err) { 
        console.error(err);
        container.innerHTML = `<div class="mono-small" style="padding:14px; color:var(--accent); text-align:center;">LOAD ERROR</div>`;
    }
}

function formatRemainingMs(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const hh = Math.floor(seconds / 3600);
    const mm = Math.floor((seconds % 3600) / 60);
    const ss = seconds % 60;

    const pad2 = (n) => String(n).padStart(2, '0');
    if (hh > 0) return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
    return `${pad2(mm)}:${pad2(ss)}`;
}

let accountTickTimer = null;

function tickAccountCountdowns() {
    const now = Date.now();
    const resetNodes = document.querySelectorAll('[data-acct-reset-at]');
    resetNodes.forEach(node => {
        const resetAt = Number(node.dataset.acctResetAt);
        if (!Number.isFinite(resetAt)) return;

        const remaining = resetAt - now;
        const statusEl = node.querySelector('.acct-status');
        const dotEl = node.querySelector('.limit-dot');
        const countdownEl = node.querySelector('.acct-countdown');
        const limitRow = node.closest('.acct-limit-row');
        const undoBtn = limitRow ? limitRow.querySelector('.acct-undo-hit') : null;

        if (remaining > 0) {
            if (statusEl) statusEl.textContent = 'HIT';
            if (countdownEl) countdownEl.textContent = formatRemainingMs(remaining);
            if (dotEl) {
                dotEl.classList.add('hit');
                dotEl.classList.remove('ok');
            }
            if (undoBtn) undoBtn.style.display = '';
        } else {
            if (statusEl) statusEl.textContent = 'OK';
            if (countdownEl) countdownEl.textContent = '--:--';
            if (dotEl) {
                dotEl.classList.remove('hit');
                dotEl.classList.add('ok');
            }
            if (undoBtn) undoBtn.style.display = 'none';
        }
    });
}

async function loadAccounts() {
    const container = document.getElementById('accounts-list');
    if (!container) return;

    try {
        const errEl = document.getElementById('accounts-form-error');
        if (errEl) errEl.classList.add('hidden');
        container.innerHTML = '';
        const accounts = await window.electronAPI.listAccounts();
        if (!accounts || accounts.length === 0) {
            container.innerHTML = '<div class="mono-small" style="padding:10px 14px;color:var(--text-secondary);">NO ACCOUNTS</div>';
            return;
        }

        renderAccounts(accounts);

        if (!accountTickTimer) {
            accountTickTimer = setInterval(() => tickAccountCountdowns(), 1000);
        }
    } catch (err) {
        console.error(`[POPOVER] Accounts Load Error: ${err.message}`);
        container.innerHTML = '<div class="mono-small" style="padding:10px 14px;color:var(--accent);">ACCOUNTS ERROR</div>';
    }
}

function renderAccounts(accounts) {
    const container = document.getElementById('accounts-list');
    container.innerHTML = '';

    const focusId = accounts.find(a => a.isFocused)?.account_id || null;

    accounts.forEach(a => {
        const row = document.createElement('div');
        row.className = `acct-row ${a.isFocused ? 'focused' : ''}`;
        row.dataset.accountId = a.account_id;

        const dot5 = a.limits['5HR']?.isHit ? 'hit' : 'ok';
        const dotD = a.limits['DAILY']?.isHit ? 'hit' : 'ok';
        const dotW = a.limits['WEEKLY']?.isHit ? 'hit' : 'ok';

        row.innerHTML = `
            <div class="acct-left">
                <div class="acct-alias">${(a.alias || '').toUpperCase()}</div>
                <div class="acct-plan">${(a.plan || '').toUpperCase()}</div>
            </div>
            <div class="acct-right">
                ${a.isFocused ? '<div class="acct-active-badge">ACTIVE</div>' : '<div class="acct-active-badge hidden">ACTIVE</div>'}
                <div class="acct-dots">
                    <div class="limit-dot ${dot5}"></div>
                    <div class="limit-dot ${dotD}"></div>
                    <div class="limit-dot ${dotW}"></div>
                </div>
            </div>
        `;

        const details = document.createElement('div');
        details.className = 'acct-details hidden';
        details.id = `acct-details-${a.account_id}`;

        const mkLimitRow = (limitType) => {
            const info = a.limits[limitType];
            if (!info || !info.hasEvent) {
                return `
                    <div class="acct-limit-row">
                        <div class="acct-limit-left">
                            <span class="acct-limit-type">${limitType}</span>
                        </div>
                        <div class="acct-limit-right">
                            <span class="acct-status">NOT LOGGED</span>
                            <button class="action-btn-sharp acct-log-hit" data-limit-type="${limitType}">LOG HIT</button>
                        </div>
                    </div>
                `;
            }

            const resetAt = info.resetAt || 0;
            const remaining = resetAt - Date.now();
            const isHit = remaining > 0;
            return `
                <div class="acct-limit-row">
                    <div class="acct-limit-left">
                        <span class="acct-limit-type">${limitType}</span>
                    </div>
                    <div class="acct-limit-right">
                        <div class="acct-limit-status-wrap" data-acct-reset-at="${resetAt}">
                            <div class="limit-dot ${isHit ? 'hit' : 'ok'}"></div>
                            <span class="acct-status">${isHit ? 'HIT' : 'OK'}</span>
                            <span class="acct-countdown">${isHit ? formatRemainingMs(remaining) : '--:--'}</span>
                        </div>
                        ${isHit ? `
                            <button class="icon-btn acct-undo-hit" data-limit-type="${limitType}" title="Undo last hit">
                                <div class="icon-pixel icon-undo-x"></div>
                            </button>
                        ` : ''}
                        <button class="action-btn-sharp acct-log-hit" data-limit-type="${limitType}">LOG HIT</button>
                    </div>
                </div>
            `;
        };

        details.innerHTML = `
            <div class="acct-details-inner">
                ${mkLimitRow('5HR')}
                ${mkLimitRow('DAILY')}
                ${mkLimitRow('WEEKLY')}
            </div>
        `;

        // Safety: ensure undo X only exists for rows that are currently HIT.
        // (Prevents "X" showing on NOT LOGGED/OK due to state inconsistencies.)
        details.querySelectorAll('.acct-undo-hit').forEach(btn => {
            const limitRow = btn.closest('.acct-limit-row');
            const statusEl = limitRow?.querySelector('.acct-status');
            if (!statusEl || statusEl.textContent !== 'HIT') {
                btn.remove();
            }
        });

        // Expand / focus
        row.onclick = () => {
            const isOpen = !details.classList.contains('hidden');
            details.classList.toggle('hidden', isOpen);
            if (!isOpen) {
                // Mark focus locally for immediate UI feedback
                container.querySelectorAll('.acct-row').forEach(r => {
                    r.classList.remove('focused');
                    const badge = r.querySelector('.acct-active-badge');
                    if (badge) badge.classList.add('hidden');
                });
                row.classList.add('focused');
                const badge = row.querySelector('.acct-active-badge');
                if (badge) badge.classList.remove('hidden');
            }
            window.electronAPI.switchAccount(a.account_id).catch(() => {});
        };

        // Log-hit buttons
        details.querySelectorAll('.acct-log-hit').forEach(btn => {
            btn.onclick = async (e) => {
                e.stopPropagation();
                const limitType = btn.dataset.limitType;
                try {
                    await window.electronAPI.logAccountHit(a.account_id, limitType);
                    await loadAccounts();
                } catch (err) {
                    console.error(`[POPOVER] Log Hit Error: ${err.message}`);
                }
            };
        });

        // Undo last hit buttons
        details.querySelectorAll('.acct-undo-hit').forEach(btn => {
            btn.onclick = async (e) => {
                e.stopPropagation();
                const limitType = btn.dataset.limitType;
                try {
                    await window.electronAPI.undoAccountHit(a.account_id, limitType);
                    await loadAccounts();
                } catch (err) {
                    console.error(`[POPOVER] Undo Hit Error: ${err.message}`);
                }
            };
        });

        container.appendChild(row);
        container.appendChild(details);
    });
}

/**
 * HANDOFF tab logic (DG-066, DG-067)
 */
const HANDOFF_PROMPT_TEXT = `Summarize the entire conversation in this STRICT format:

1. OBJECTIVE:
2. CURRENT STATE:
3. KEY DECISIONS:
4. FILES USED:
5. IMPORTANT CONTEXT:
6. NEXT STEPS:

Do not write anything outside this structure.`;

const HANDOFF_SECTION_DEFS = [
    { key: 'objective', label: 'OBJECTIVE' },
    { key: 'current_state', label: 'CURRENT STATE' },
    { key: 'key_decisions', label: 'KEY DECISIONS' },
    { key: 'files_used', label: 'FILES USED' },
    { key: 'important_context', label: 'IMPORTANT CONTEXT' },
    { key: 'next_steps', label: 'NEXT STEPS' }
];

const HANDOFF_HEADERS_SET = new Set(HANDOFF_SECTION_DEFS.map(s => `${s.label}:`));
const HANDOFF_FOOTER_LINES_SET = new Set([
    'Continue exactly from NEXT STEPS.',
    'Do not restart or reinterpret the problem.'
]);

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function parseHandoffSummary(rawText) {
    // Split on numbered section headers (keeps each section as its own part).
    const parts = rawText
        .split(/(?=^\s*\d+\.\s)/m)
        .map(p => p.trim())
        .filter(Boolean);

    const result = {};

    for (const part of parts) {
        for (const { key, label } of HANDOFF_SECTION_DEFS) {
            const headerRe = new RegExp(`^\\d+\\.\\s*${label}:?\\s*`, 'i');
            if (headerRe.test(part)) {
                result[key] = part.replace(headerRe, '').trim();
                break;
            }
        }
    }

    for (const { key, label } of HANDOFF_SECTION_DEFS) {
        if (!result[key] || result[key].length === 0) {
            throw new Error(`HANDOFF_PARSE_ERROR · Missing or empty section: ${label}`);
        }
    }

    return result;
}

function buildHandoffTemplate(parsed) {
    // Per PRD/TRD: FILES section contains only the fixed re-upload instruction.
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

function buildHandoffOutputHtml(templateText) {
    const lines = String(templateText).split('\n');
    return lines.map(line => {
        const trimmed = line.trim();
        if (HANDOFF_HEADERS_SET.has(trimmed)) {
            return `<div class="handoff-out-header">${escapeHtml(line)}</div>`;
        }
        if (HANDOFF_FOOTER_LINES_SET.has(trimmed)) {
            return `<div class="handoff-out-footer">${escapeHtml(line)}</div>`;
        }
        if (trimmed.length === 0) return `<div class="handoff-out-body">&nbsp;</div>`;
        return `<div class="handoff-out-body">${escapeHtml(line)}</div>`;
    }).join('');
}

let handoffLatestBuiltTemplate = null;
let handoffRestoreDraft = null;

async function loadHandoff() {
    const textarea = document.getElementById('handoff-input');
    const restoreRow = document.getElementById('handoff-restore-row');
    const restoreTs = document.getElementById('handoff-restore-ts');
    const parseBtn = document.getElementById('btn-parse-handoff');
    const parseErrorEl = document.getElementById('handoff-parse-error');
    const outputWrap = document.getElementById('handoff-output-wrapper');
    const refFilesWrap = document.getElementById('handoff-reference-files');

    if (!textarea || !parseBtn || !parseErrorEl || !outputWrap || !refFilesWrap) return;

    // When user edits textarea, we hide output in the input handler; on tab switch, respect current textarea value.
    parseErrorEl.classList.add('hidden');
    parseErrorEl.textContent = '';

    const sessionId = currentStatus?.activeSession?.session_id || null;
    const rawValue = textarea.value || '';

    // Disable parse when textarea is empty.
    const shouldEnable = rawValue.trim().length > 0;
    parseBtn.disabled = !shouldEnable;

    // Restore last draft only if textarea is still empty.
    if (rawValue.trim().length === 0) {
        try {
            const draft = await window.electronAPI.getLatestHandoffDraft(sessionId);
            if (draft) {
                restoreRow?.classList.remove('hidden');
                if (restoreTs) restoreTs.textContent = new Date(draft.createdAt).toLocaleString([], { hour: '2-digit', minute: '2-digit' });
                handoffRestoreDraft = draft;
            } else {
                restoreRow?.classList.add('hidden');
                handoffRestoreDraft = null;
            }
        } catch (err) {
            console.error(`[POPOVER] Handoff restore error: ${err.message}`);
            restoreRow?.classList.add('hidden');
            handoffRestoreDraft = null;
        }
    } else {
        restoreRow?.classList.add('hidden');
        handoffRestoreDraft = null;
    }
}

function hideHandoffOutput() {
    const outputWrap = document.getElementById('handoff-output-wrapper');
    const refFilesWrap = document.getElementById('handoff-reference-files');
    const parseErrorEl = document.getElementById('handoff-parse-error');
    const restoreRow = document.getElementById('handoff-restore-row');
    const parseBtn = document.getElementById('btn-parse-handoff');

    if (parseErrorEl) {
        parseErrorEl.classList.add('hidden');
        parseErrorEl.textContent = '';
    }
    if (outputWrap) outputWrap.classList.add('hidden');
    if (refFilesWrap) refFilesWrap.classList.add('hidden');
    if (restoreRow) restoreRow.classList.add('hidden');
    if (parseBtn) parseBtn.disabled = true;
    handoffLatestBuiltTemplate = null;
}

/**
 * CHATS tab logic (DG-069)
 */
async function loadChats() {
    const activeSession = currentStatus?.activeSession;
    const sessDisplay = document.getElementById('chats-active-session');
    const list = document.getElementById('chat-history-list');
    const countEl = document.getElementById('chat-history-count');
    
    if (!sessDisplay || !list || !countEl) return;

    if (!activeSession) {
        sessDisplay.textContent = 'NONE';
        list.innerHTML = '<div class="mono-small" style="padding:14px; color:var(--text-muted); text-align:center;">NO ACTIVE SESSION</div>';
        countEl.textContent = '0';
        return;
    }

    const hash = activeSession.session_id.slice(0, 8);
    const alias = activeSession.alias || activeSession.project_name || hash;
    sessDisplay.textContent = `${hash.toUpperCase()} ~ ${alias.toUpperCase()}`;

    try {
        const chats = await window.electronAPI.listChats(activeSession.session_id);
        countEl.textContent = chats.length;
        list.innerHTML = '';

        if (chats.length === 0) {
            list.innerHTML = '<div class="mono-small" style="padding:14px; color:var(--text-muted); text-align:center;">NO CHATS LOGGED</div>';
            return;
        }

        chats.forEach((c, idx) => {
            const row = document.createElement('div');
            const isLatest = idx === 0;
            row.className = `chat-row ${isLatest ? 'latest' : ''}`;
            
            const date = new Date(c.created_at);
            const ts = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).toUpperCase() + 
                      ' · ' + 
                      date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

            const sessionAlias = c.session_alias || c.session_id.slice(0, 8);
            const sessionTag = `${c.session_id.slice(0, 8).toUpperCase()} ~ ${sessionAlias.toUpperCase()}`;
            const accountHighlight = c.account_alias ? ` <span class="chat-account-highlight">· ${c.account_alias.toUpperCase()}</span>` : '';

            row.innerHTML = `
                <div class="chat-info">
                    <div class="chat-name">${escapeHtml(c.name)}${accountHighlight}</div>
                    <div class="chat-meta">
                        <span class="chat-ts">${ts}</span>
                        <span class="chat-session-tag">${sessionTag}</span>
                        ${isLatest ? '<span class="chat-latest-badge">LATEST</span>' : ''}
                    </div>
                    ${c.notes ? `<div class="chat-notes">${escapeHtml(c.notes)}</div>` : ''}
                </div>
                <div class="chat-delete-btn" title="Remove Entry">
                    <div class="icon-pixel icon-undo-x"></div>
                </div>
            `;

            row.querySelector('.chat-delete-btn').onclick = async (e) => {
                e.stopPropagation();
                if (confirm('Delete this chat entry?')) {
                    await window.electronAPI.deleteChat(c.id);
                    await loadChats();
                }
            };

            list.appendChild(row);
        });
    } catch (err) {
        console.error(`[POPOVER] Load Chats Error: ${err.message}`);
    }
}

/**
 * Initialization
 */
function init() {
    console.log('[POPOVER] Binding Event Listeners');
    
    document.querySelectorAll('.tab-item').forEach(tab => {
        const tabId = tab.id.replace('tab-', '');
        tab.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            switchTab(tabId);
        });
    });

    const bind = (id, action, val) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', () => handleAction(action, val));
    };

    bind('btn-state-active', 'set-state', 'ACTIVE');
    bind('btn-state-limit', 'set-state', 'NEAR_LIMIT');
    bind('btn-state-final', 'set-state', 'FINAL_WINDOW');
    bind('btn-state-close', 'set-state', 'CLOSED');

    bind('btn-new-session', 'new-session');
    bind('btn-open-vault', 'open-vault');
    bind('btn-suggest-files', 'suggest-files');
    bind('btn-unlinked-files', 'unlinked-files');
    bind('btn-run-cleanup', 'run-cleanup');
    bind('btn-pause-watcher', 'pause-watcher');

    const trackAcctsBtn = document.getElementById('track-sub-accts');
    const trackChatsBtn = document.getElementById('track-sub-chats');
    if (trackAcctsBtn) trackAcctsBtn.addEventListener('click', () => switchTrackSubtab('accts'));
    if (trackChatsBtn) trackChatsBtn.addEventListener('click', () => switchTrackSubtab('chats'));

    // Suggestions Upload
    const uploadSuggestBtn = document.getElementById('btn-upload-suggested');
    if (uploadSuggestBtn) {
        uploadSuggestBtn.addEventListener('click', async () => {
            if (selectedFileIds.size === 0) return;
            const activeSessionId = currentStatus?.activeSession?.session_id;
            if (!activeSessionId) return;

            try {
                const originalText = uploadSuggestBtn.textContent;
                uploadSuggestBtn.textContent = 'UPLOADING...';
                uploadSuggestBtn.disabled = true;

                await window.electronAPI.linkFilesToSession(
                    Array.from(selectedFileIds),
                    activeSessionId
                );

                selectedFileIds.clear();
                uploadSuggestBtn.textContent = originalText;
                await updateStatus();
                await loadFilesTab();
            } catch (err) {
                console.error(`[POPOVER] Upload Suggested Error: ${err.message}`);
                uploadSuggestBtn.textContent = 'UPLOAD FAILED';
                setTimeout(() => {
                    uploadSuggestBtn.textContent = 'UPLOAD SELECTED';
                    uploadSuggestBtn.disabled = selectedFileIds.size === 0;
                }, 2000);
            }
        });
    }

    // Accounts form
    const addBtn = document.getElementById('btn-add-account');
    if (addBtn) {
        addBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            const alias = document.getElementById('acct-alias')?.value || '';
            const email = document.getElementById('acct-email')?.value || '';
            const plan = document.getElementById('acct-plan')?.value || 'FREE';
            try {
                await window.electronAPI.addAccount({ alias, email, plan });
                await loadAccounts();
            } catch (err) {
                console.error(`[POPOVER] Add Account Error: ${err.message}`);
                const errEl = document.getElementById('accounts-form-error');
                if (errEl) {
                    errEl.textContent = err.message;
                    errEl.classList.remove('hidden');
                }
            }
        });
    }

    // HANDOFF UI bindings (DG-066, DG-067)
    const copyPromptBtn = document.getElementById('btn-copy-handoff-prompt');
    const textarea = document.getElementById('handoff-input');
    const parseBtn = document.getElementById('btn-parse-handoff');
    const parseErrorEl = document.getElementById('handoff-parse-error');
    const restoreRow = document.getElementById('handoff-restore-row');
    const restoreBtn = document.getElementById('btn-restore-handoff');
    const referenceBody = document.getElementById('handoff-reference-files-body');
    const outputEl = document.getElementById('handoff-output');
    const outputWrap = document.getElementById('handoff-output-wrapper');
    const refFilesWrap = document.getElementById('handoff-reference-files');
    const copyTemplateBtn = document.getElementById('btn-copy-handoff-template');

    const setParseEnabled = () => {
        if (!parseBtn || !textarea) return;
        parseBtn.disabled = textarea.value.trim().length === 0;
    };

    if (copyPromptBtn) {
        copyPromptBtn.addEventListener('click', async () => {
            const original = copyPromptBtn.textContent;
            try {
                await navigator.clipboard.writeText(HANDOFF_PROMPT_TEXT);
                copyPromptBtn.textContent = 'COPIED ✓';
                copyPromptBtn.style.color = '#4ADE80';
                copyPromptBtn.style.borderColor = '#4ADE80';
                setTimeout(() => {
                    copyPromptBtn.textContent = original;
                    copyPromptBtn.style.color = '';
                    copyPromptBtn.style.borderColor = '';
                }, 2000);
            } catch (e) {
                console.error('[POPOVER] Copy prompt failed:', e.message);
                copyPromptBtn.textContent = 'COPY FAILED';
                setTimeout(() => {
                    copyPromptBtn.textContent = original;
                }, 2000);
            }
        });
    }

    if (textarea) {
        textarea.addEventListener('input', () => {
            // Any edits invalidate previous parse output.
            if (parseErrorEl) parseErrorEl.classList.add('hidden');
            if (restoreRow) restoreRow.classList.add('hidden');
            if (outputWrap) outputWrap.classList.add('hidden');
            if (refFilesWrap) refFilesWrap.classList.add('hidden');
            handoffLatestBuiltTemplate = null;
            setParseEnabled();
            textarea.style.borderColor = '#2a2a2a';
        });
    }

    if (parseBtn) {
        parseBtn.addEventListener('click', async () => {
            if (!textarea) return;
            const rawText = textarea.value || '';

            if (parseErrorEl) {
                parseErrorEl.classList.add('hidden');
                parseErrorEl.textContent = '';
            }

            try {
                const parsed = parseHandoffSummary(rawText);
                const builtTemplate = buildHandoffTemplate(parsed);
                handoffLatestBuiltTemplate = builtTemplate;

                if (referenceBody && refFilesWrap) {
                    refFilesWrap.classList.remove('hidden');
                    referenceBody.textContent = parsed.files_used || '';
                }

                if (outputEl && outputWrap) {
                    outputWrap.classList.remove('hidden');
                    outputEl.innerHTML = buildHandoffOutputHtml(builtTemplate);
                }

                if (restoreRow) restoreRow.classList.add('hidden');
                if (textarea) textarea.style.borderColor = '#2a2a2a';

                // Persist draft immediately after successful parse.
                const sessionId = currentStatus?.activeSession?.session_id || null;
                await window.electronAPI.saveHandoffDraft({
                    sessionId,
                    rawInput: rawText,
                    parsedJson: parsed,
                    builtTemplate
                });
            } catch (err) {
                const msg = err?.message || String(err);
                const m = msg.match(/Missing or empty section:\s*(.*)$/);
                const label = m ? m[1].trim() : 'UNKNOWN';
                if (parseErrorEl) {
                    parseErrorEl.textContent = `PARSE ERROR · MISSING SECTION: ${label}`;
                    parseErrorEl.classList.remove('hidden');
                }
                if (outputWrap) outputWrap.classList.add('hidden');
                if (refFilesWrap) refFilesWrap.classList.add('hidden');
                handoffLatestBuiltTemplate = null;
                if (textarea) textarea.style.borderColor = 'rgba(255, 75, 53, 0.4)';
            }
        });
    }

    if (restoreBtn && restoreRow) {
        restoreBtn.addEventListener('click', async () => {
            if (!textarea) return;
            try {
                if (!handoffRestoreDraft) return;
                const rawInput = handoffRestoreDraft.rawInput || '';
                const parsedJson = handoffRestoreDraft.parsedJson || '{}';
                const builtTemplate = handoffRestoreDraft.builtTemplate || '';

                textarea.value = rawInput;
                textarea.style.borderColor = '#2a2a2a';

                const parsed = JSON.parse(parsedJson);
                handoffLatestBuiltTemplate = builtTemplate;

                // Render reference + template without re-parsing.
                if (referenceBody && refFilesWrap) {
                    refFilesWrap.classList.remove('hidden');
                    referenceBody.textContent = parsed.files_used || '';
                }

                if (outputEl && outputWrap) {
                    outputWrap.classList.remove('hidden');
                    outputEl.innerHTML = buildHandoffOutputHtml(builtTemplate);
                }

                if (parseErrorEl) {
                    parseErrorEl.classList.add('hidden');
                    parseErrorEl.textContent = '';
                }

                restoreRow.classList.add('hidden');
                handoffRestoreDraft = null;
                setParseEnabled();
            } catch (e) {
                console.error('[POPOVER] Restore draft failed:', e.message);
            }
        });
    }

    if (copyTemplateBtn) {
        copyTemplateBtn.addEventListener('click', async () => {
            if (!handoffLatestBuiltTemplate) return;
            const original = copyTemplateBtn.textContent;
            try {
                await navigator.clipboard.writeText(handoffLatestBuiltTemplate);
                copyTemplateBtn.textContent = 'COPIED ✓';
                copyTemplateBtn.disabled = true;
                setTimeout(() => {
                    copyTemplateBtn.textContent = original;
                    copyTemplateBtn.disabled = false;
                }, 2500);
            } catch (e) {
                console.error('[POPOVER] Copy template failed:', e.message);
            }
        });
    }

    // CHATS tab initialization
    const addChatBtn = document.getElementById('btn-add-chat');
    const chatInputName = document.getElementById('chat-input-name');
    const chatInputNotes = document.getElementById('chat-input-notes');
    const chatError = document.getElementById('chat-form-error');

    if (addChatBtn) {
        addChatBtn.addEventListener('click', async () => {
            const activeSessionId = currentStatus?.activeSession?.session_id;
            const name = chatInputName?.value || '';
            const notes = chatInputNotes?.value || '';

            if (chatError) chatError.classList.add('hidden');

            try {
                // Find focused account for RCA mapping
                const accounts = await window.electronAPI.listAccounts();
                const activeAccount = accounts.find(a => a.isFocused);
                const accountId = activeAccount ? activeAccount.account_id : null;

                await window.electronAPI.addChat({
                    sessionId: activeSessionId,
                    accountId: accountId,
                    name,
                    notes
                });

                if (chatInputName) chatInputName.value = '';
                if (chatInputNotes) chatInputNotes.value = '';
                await loadChats();
            } catch (err) {
                console.error(`[POPOVER] Add Chat Error: ${err.message}`);
                if (chatError) {
                    chatError.textContent = err.message;
                    chatError.classList.remove('hidden');
                }
            }
        });
    }

    updateStatus();
    setInterval(updateStatus, 3000);
    switchTab('session');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
