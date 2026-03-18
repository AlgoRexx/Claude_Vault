// State management
let currentStatus = null;
let currentTab = 'session';
let editingAliasForSessionId = null;

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
        if (tabId === 'files') loadFiles();
        if (tabId === 'suggest') loadSuggestions();
        if (tabId === 'accts') loadAccounts();
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
            // New layout: Alias primary (orange), Hash small below
            const hash = activeSession.session_id.slice(0, 8);
            const alias = activeSession.alias || hash;
            headerStateLabel.innerHTML = `
                <div class="session-name-stack" style="align-items: flex-end;">
                    <span class="session-alias-primary">${alias.toUpperCase()}</span>
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
            switchTab('suggest');
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

async function loadFiles() {
    const container = document.getElementById('files-list');
    container.innerHTML = '';
    try {
        const sessionId = currentStatus?.activeSession?.session_id || null;
        const files = await window.electronAPI.listRecentFiles(sessionId);
        if (files) {
            files.forEach((f, idx) => {
                const row = document.createElement('div');
                row.className = `file-row ${idx === 0 ? 'latest' : ''}`;
                const timeStr = f.created_at ? new Date(f.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '--:--';
                const ext = (f.file_type || (f.original_name?.split('.').pop() || '')).toString().toUpperCase();
                row.innerHTML = `
                  <div class="file-name-cell"><span>${f.original_name || 'UNKNOWN'}</span></div>
                  <div class="file-meta-cell">
                    <span class="mono-small" style="color:#555555; font-size:7px;">${timeStr}</span>
                    <span class="mono-small" style="color: var(--accent-70); font-size:6px;">${ext}</span>
                  </div>
                `;
                container.appendChild(row);
            });
        }
    } catch (err) { console.error(err); }
}

async function loadSuggestions() {
    const activeSession = currentStatus?.activeSession;
    if (!activeSession) return;
    try {
        const suggestions = await window.electronAPI.getSuggestions(activeSession.project_id);
        const container = document.getElementById('suggest-list');
        container.innerHTML = '';
        if (suggestions) {
            setElText('suggest-count', suggestions.length);
            suggestions.forEach(s => {
                const row = document.createElement('div');
                row.className = 'suggest-row';
                row.innerHTML = `<span class="mono-value">${s.original_name}</span>`;
                container.appendChild(row);
            });
        }
    } catch (err) { console.error(err); }
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

    updateStatus();
    setInterval(updateStatus, 3000);
    switchTab('session');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
