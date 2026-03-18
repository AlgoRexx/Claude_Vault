const { electronAPI } = window;

// State management
let currentProjectId = null;
let currentSessionId = null;
let currentStatus = null;

// Initialize
async function init() {
    await updateStatus();
    await loadProjects();
    
    // Auto-select active project if exists
    if (currentStatus.activeSession) {
        selectProject(currentStatus.activeSession.project_id);
    }

    // Refresh status periodically
    setInterval(updateStatus, 5000);
}

// Window control
function windowAction(action) {
    electronAPI.windowAction(action);
}

// UI Updates
async function updateStatus() {
    currentStatus = await electronAPI.getStatus();
    
    // Update bottom bar
    document.getElementById('watcher-state').textContent = currentStatus.watcherState;
    document.getElementById('watcher-dir').textContent = currentStatus.watchDir;
    document.getElementById('db-path').textContent = currentStatus.dbPath;

    // Update active session badge
    const badge = document.getElementById('session-badge');
    if (currentStatus.activeSession) {
        const state = currentStatus.activeSession.state;
        badge.textContent = state;
        
        // Color mapping from DG-008
        if (state === 'ACTIVE') {
            badge.style.color = '#9CA3AF';
            badge.style.borderColor = '#9CA3AF';
            badge.classList.remove('pulse-border');
        } else if (state === 'NEAR_LIMIT') {
            badge.style.color = 'rgba(255, 75, 53, 0.7)';
            badge.style.borderColor = 'rgba(255, 75, 53, 0.7)';
            badge.classList.remove('pulse-border');
        } else if (state === 'FINAL_WINDOW') {
            badge.style.color = '#FF4B35';
            badge.style.borderColor = '#FF4B35';
            badge.classList.add('pulse-border');
        }
        
        badge.classList.remove('idle');
    } else {
        badge.textContent = 'IDLE';
        badge.style.color = '#9CA3AF';
        badge.style.borderColor = '#333333';
        badge.classList.remove('pulse-border');
        badge.classList.add('idle');
    }
}

async function loadProjects() {
    const projects = await electronAPI.listProjects();
    const list = document.getElementById('project-list');
    const count = document.getElementById('project-count');
    
    count.textContent = projects.length;
    list.innerHTML = '';
    
    projects.forEach(p => {
        const item = document.createElement('div');
        item.className = `nav-item ${currentProjectId === p.project_id ? 'active' : ''}`;
        item.innerHTML = `<span class="indent-prefix">↳</span><span class="level-3">${p.name}</span>`;
        item.onclick = () => selectProject(p.project_id);
        list.appendChild(item);
    });
}

async function selectProject(projectId) {
    currentProjectId = projectId;
    const projects = await electronAPI.listProjects();
    const p = projects.find(proj => proj.project_id === projectId);
    
    document.getElementById('view-title').textContent = p.name;
    
    // Update navigator selection
    const items = document.querySelectorAll('#project-list .nav-item');
    items.forEach(i => i.classList.remove('active'));
    // (Actual re-rendering of project list happens in loadProjects)
    await loadProjects();

    await loadSessions(projectId);
    renderProjectActions(p);
}

function renderProjectActions(p) {
    const container = document.getElementById('view-actions');
    container.innerHTML = '';

    if (currentStatus.activeSession && currentStatus.activeSession.project_id === p.project_id) {
        // Stop Session Button
        const stopBtn = document.createElement('button');
        stopBtn.className = 'level-4 action-btn coral';
        stopBtn.textContent = 'STOP SESSION';
        stopBtn.onclick = async () => {
            await electronAPI.stopSession();
            await updateStatus();
            renderProjectActions(p);
        };
        container.appendChild(stopBtn);
        
        // State toggles
        const states = ['ACTIVE', 'NEAR_LIMIT', 'FINAL_WINDOW'];
        states.forEach(s => {
            const btn = document.createElement('button');
            btn.className = `level-4 action-btn ${currentStatus.activeSession.state === s ? 'active' : ''}`;
            btn.textContent = s;
            btn.onclick = async () => {
                await electronAPI.setSessionState(s);
                await updateStatus();
                renderProjectActions(p);
            };
            container.appendChild(btn);
        });
    } else if (!currentStatus.activeSession) {
        // Start Session Button
        const startBtn = document.createElement('button');
        startBtn.className = 'level-4 action-btn';
        startBtn.textContent = 'START SESSION';
        startBtn.onclick = async () => {
            await electronAPI.startSession(p.project_id);
            await updateStatus();
            renderProjectActions(p);
            await showSuggestions(p.project_id);
        };
        container.appendChild(startBtn);
    }
}

async function loadSessions(projectId) {
    const sessions = await electronAPI.listSessions(projectId);
    const list = document.getElementById('session-list');
    const count = document.getElementById('session-count');
    
    count.textContent = sessions.length;
    list.innerHTML = '';
    
    sessions.forEach(s => {
        const item = document.createElement('div');
        item.className = `nav-item ${currentSessionId === s.session_id ? 'active' : ''}`;
        const date = new Date(s.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const time = new Date(s.started_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        item.innerHTML = `<span class="indent-prefix">↳</span><span class="level-4">${date} · ${time} · ${s.state}</span>`;
        item.onclick = () => selectSession(s.session_id);
        list.appendChild(item);
    });
}

async function selectSession(sessionId) {
    currentSessionId = sessionId;
    const items = document.querySelectorAll('#session-list .nav-item');
    items.forEach(i => i.classList.remove('active'));
    // Actual re-render via loadSessions later... or just add class
    
    // In a real app, I'd query files for this session here
    // For now, let's just update the view title
    document.getElementById('view-title').textContent = `SESSION · ${sessionId.slice(0, 8)}`;
}

async function showSuggestions(projectId) {
    const suggestions = await electronAPI.getSuggestions(projectId);
    const drawer = document.getElementById('suggestion-drawer');
    const list = document.getElementById('suggestion-list');
    
    if (suggestions.length === 0) return;
    
    list.innerHTML = '';
    suggestions.forEach(s => {
        const item = document.createElement('div');
        item.className = 'suggestion-item';
        item.innerHTML = `
            <div class="pixel-checkbox checked" onclick="this.classList.toggle('checked')"></div>
            <div>
                <div class="level-3" style="font-weight: 600;">${s.original_name}</div>
                <div class="level-4">${s.confidence} CONFIDENCE · USED IN ${s.sharedSessionCount} PREVIOUS SESSIONS</div>
            </div>
        `;
        list.appendChild(item);
    });
    
    drawer.classList.add('active');
}

// Global scope functions for HTML
window.windowAction = windowAction;
window.createNewProject = async () => {
    const name = prompt('Project Name:');
    if (name) {
        await electronAPI.createProject(name);
        await loadProjects();
    }
};

// Start
init();
