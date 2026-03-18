const { electronAPI } = window;

// State management
let currentStatus = null;
let currentTab = 'session';

/**
 * Tab Switching (DG-043)
 */
function switchTab(tabId) {
    console.log(`POPOVER · SWITCH TAB · ${tabId}`);
    currentTab = tabId;
    
    // Update tab bar styles
    document.querySelectorAll('.tab-item').forEach(el => {
        el.classList.toggle('active', el.id === `tab-${tabId}`);
    });
    
    // Update panel visibility
    document.querySelectorAll('.panel').forEach(el => {
        el.classList.toggle('active', el.id === `panel-${tabId}`);
    });

    // Load data for specific tab
    try {
        if (tabId === 'files') loadFiles();
        if (tabId === 'suggest') loadSuggestions();
        if (tabId === 'log') loadLogs();
    } catch (err) {
        console.error(`POPOVER · ERROR · ${err.message}`);
    }
}

/**
 * UI Updates
 */
async function updateStatus() {
    try {
        currentStatus = await electronAPI.getStatus();
        if (!currentStatus) return;

        const { activeSession, watcherState, watchDir } = currentStatus;

        // Popover Header (DG-040)
        const dot = document.getElementById('header-state-dot');
        const label = document.getElementById('header-state-label');
        
        if (activeSession) {
            label.textContent = activeSession.state;
            const color = activeSession.state === 'ACTIVE' ? '#9CA3AF' : 
                         (activeSession.state === 'NEAR_LIMIT' ? 'rgba(255, 75, 53, 0.7)' : '#FF4B35');
            dot.style.backgroundColor = color;
            
            // SESSION Tab (DG-044)
            document.getElementById('sess-id').textContent = activeSession.session_id.slice(0, 8);
            document.getElementById('sess-proj').textContent = activeSession.project_id.slice(0, 12);
            document.getElementById('sess-start').textContent = new Date(activeSession.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
            document.getElementById('sess-state').textContent = activeSession.state;
            document.getElementById('sess-state').style.color = color;
            document.getElementById('sess-files').textContent = activeSession.fileCount || 0; // Actual file count?
            
            // Progress bar (DG-045)
            const msgCount = 0; // Placeholder for message tracking
            const limit = 30;
            document.getElementById('sess-msg').textContent = `${msgCount} / ${limit}`;
            document.getElementById('sess-progress').style.width = `${(msgCount / limit) * 100}%`;
            
            if (activeSession.state !== 'ACTIVE') {
                document.getElementById('sess-msg').style.color = 'var(--accent)';
            } else {
                document.getElementById('sess-msg').style.color = 'var(--text-value)';
            }
        } else {
            label.textContent = 'IDLE';
            dot.style.backgroundColor = '#555555';
            document.getElementById('sess-id').textContent = 'NONE';
            document.getElementById('sess-proj').textContent = 'NONE';
            document.getElementById('sess-state').textContent = 'IDLE';
            document.getElementById('sess-state').style.color = 'var(--text-value)';
            document.getElementById('sess-files').textContent = '0';
            document.getElementById('sess-start').textContent = '--:--';
            document.getElementById('sess-msg').textContent = '0 / 30';
            document.getElementById('sess-progress').style.width = '0%';
        }

        // Watcher State (DG-046)
        const wState = document.getElementById('watch-state');
        wState.textContent = watcherState;
        wState.style.color = watcherState === 'WATCHING' ? '#4ADE80' : (watcherState === 'ERROR' ? '#FF4B35' : '#9CA3AF');
        document.getElementById('watch-dir').textContent = watchDir;
        
        // Bottom Status Bar (DG-051)
        document.getElementById('status-db').textContent = '1.2 MB'; // Placeholder
    } catch (err) {
        console.error(`POPOVER · UPDATE STATUS ERROR · ${err.message}`);
    }
}

async function checkCleanup() {
    try {
        const projects = await electronAPI.getCleanupEligible();
        const banner = document.getElementById('cleanup-banner');
        
        if (projects && projects.length > 0) {
            const p = projects[0];
            document.getElementById('cleanup-proj').textContent = p.project_name;
            document.getElementById('cleanup-count').textContent = p.file_count;
            banner.classList.remove('hidden');
        } else {
            banner.classList.add('hidden');
        }
    } catch (err) {
        console.error(`POPOVER · CHECK CLEANUP ERROR · ${err.message}`);
    }
}

/**
 * FILES Tab (DG-047)
 */
async function loadFiles() {
    const activeSession = currentStatus?.activeSession;
    if (!activeSession) return;
    
    const container = document.getElementById('files-list');
    container.innerHTML = '';
    
    try {
        const files = await electronAPI.getSuggestions(activeSession.project_id);
        if (files) {
            files.forEach((f, index) => {
                const row = document.createElement('div');
                row.className = `file-row ${index === 0 ? 'latest' : ''}`;
                const timeStr = new Date(f.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                const ext = f.original_name.split('.').pop().toUpperCase();
                row.innerHTML = `
                    <div class="file-name-cell"><span>${f.original_name}</span></div>
                    <div class="file-meta-cell">
                        <span class="mono-small" style="color: #555555; font-size: 7px;">${timeStr}</span>
                        <span class="mono-small" style="color: var(--accent-70); font-size: 6px;">${ext}</span>
                    </div>
                `;
                container.appendChild(row);
            });
        }
    } catch (err) {
        console.error(`POPOVER · LOAD FILES ERROR · ${err.message}`);
    }
}

/**
 * SUGGEST Tab (DG-048)
 */
async function loadSuggestions() {
    const activeSession = currentStatus?.activeSession;
    if (!activeSession) return;

    try {
        const suggestions = await electronAPI.getSuggestions(activeSession.project_id);
        const container = document.getElementById('suggest-list');
        const countEl = document.getElementById('suggest-count');
        
        container.innerHTML = '';
        if (suggestions) {
            countEl.textContent = suggestions.length;
            suggestions.forEach(s => {
                const row = document.createElement('div');
                row.className = 'suggest-row';
                row.innerHTML = `
                    <div class="pixel-checkbox" style="width:12px; height:12px; border:1px solid var(--accent);"></div>
                    <div style="flex:1; display:flex; flex-direction:column;">
                        <span class="mono-value" style="font-size:9px;">${s.original_name}</span>
                        <span class="mono-small" style="font-size:7px; color:#555555;">USED IN ${s.sharedSessionCount} SESSIONS</span>
                    </div>
                    <span class="mono-small" style="color: var(--accent); opacity: ${s.confidence === 'high' ? 1 : (s.confidence === 'medium' ? 0.55 : 0.25)}">${s.confidence}</span>
                `;
                container.appendChild(row);
            });
        }
    } catch (err) {
        console.error(`POPOVER · LOAD SUGGESTIONS ERROR · ${err.message}`);
    }
}

/**
 * LOG Tab (DG-049)
 */
async function loadLogs() {
    const container = document.getElementById('log-list');
    container.innerHTML = '';
    
    // Mock logs
    const mockLogs = [
        { time: '14:23', type: 'CREATED', detail: 'model_results.csv' },
        { time: '14:20', type: 'LINKED', detail: 'sess_92a7ced0' },
        { time: '14:15', type: 'SESSION START', detail: 'CLAUDE_VAULT' }
    ];

    mockLogs.forEach(log => {
        const row = document.createElement('div');
        row.className = 'log-row';
        let typeColor = 'var(--accent)';
        if (log.type === 'LINKED') typeColor = 'rgba(255,75,53,0.75)';
        if (log.type === 'REJECTED') typeColor = 'rgba(255,75,53,0.4)';
        if (log.type === 'SESSION START') typeColor = 'rgba(255,75,53,0.6)';

        row.innerHTML = `
            <span class="mono-small" style="color: #555555;">${log.time}</span>
            <span class="mono-small" style="color: ${typeColor};">${log.type}</span>
            <span class="mono-small" style="color: #9CA3AF; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;">${log.detail}</span>
        `;
        container.appendChild(row);
    });
}

// Global exposure
window.switchTab = switchTab;
window.setSessionState = async (state) => {
    try {
        if (state === 'CLOSED') {
            await electronAPI.stopSession();
        } else {
            await electronAPI.setSessionState(state);
        }
        await updateStatus();
    } catch (err) {
        console.error(`POPOVER · SET STATE ERROR · ${err.message}`);
    }
};

window.openVault = () => {
    electronAPI.showMain();
};

window.startNewSession = async () => {
    try {
        let projects = await electronAPI.listProjects();
        if (projects.length === 0) {
            // Create a default project if none exist
            await electronAPI.createProject('CLAUDE_VAULT');
            projects = await electronAPI.listProjects();
        }
        
        if (projects.length > 0) {
            await electronAPI.startSession(projects[0].project_id);
            await updateStatus();
            switchTab('session');
        }
    } catch (err) {
        console.error(`POPOVER · START SESSION ERROR · ${err.message}`);
    }
};

// Initialize
async function init() {
    console.log('POPOVER · INITIALIZING');
    
    // Add event listeners to tabs instead of relying on onclick if possible
    document.querySelectorAll('.tab-item').forEach(tab => {
        const tabId = tab.id.replace('tab-', '');
        tab.addEventListener('click', () => switchTab(tabId));
    });

    await updateStatus();
    await checkCleanup();
    switchTab('session');

    setInterval(updateStatus, 5000);
    setInterval(checkCleanup, 30000);
    console.log('POPOVER · READY');
}

// Start immediately
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
