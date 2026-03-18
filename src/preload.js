const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window control
  windowAction: (action) => ipcRenderer.send('window-control', action),
  showMain: () => ipcRenderer.send('show-main'),
  
  // Status
  getStatus: () => ipcRenderer.invoke('get-status'),
  
  // Projects
  listProjects: () => ipcRenderer.invoke('list-projects'),
  createProject: (name) => ipcRenderer.invoke('create-project', name),
  
  // Sessions
  listSessions: (projectId) => ipcRenderer.invoke('list-sessions', projectId),
  startSession: (projectId) => ipcRenderer.invoke('start-session', projectId),
  stopSession: () => ipcRenderer.invoke('stop-session'),
  setSessionState: (state) => ipcRenderer.invoke('set-session-state', state),
  switchFocus: (sessionId) => ipcRenderer.invoke('switch-focus', sessionId),
  setAlias: (sessionId, alias) => ipcRenderer.invoke('set-alias', sessionId, alias),
  reopenSession: (sessionId) => ipcRenderer.invoke('reopen-session', sessionId),
  deleteSession: (sessionId) => ipcRenderer.invoke('delete-session', sessionId),
  revealSessionFolder: (sessionId) => ipcRenderer.invoke('reveal-session-folder', sessionId),
  
  // Suggestions
  getSuggestions: (projectId) => ipcRenderer.invoke('get-suggestions', projectId),
  
  // Watcher
  toggleWatcher: () => ipcRenderer.invoke('toggle-watcher'),
  listRecentFiles: (sessionId) => ipcRenderer.invoke('list-recent-files', sessionId),
  
  // Cleanup
  getCleanupEligible: () => ipcRenderer.invoke('get-cleanup-eligible'),
  archiveProject: (projectId) => ipcRenderer.invoke('archive-project', projectId),
  deleteProject: (projectId) => ipcRenderer.invoke('delete-project', projectId),
  keepProject: (projectId) => ipcRenderer.invoke('keep-project'),
  
  // Logs and Events (could add more)
  onWatcherUpdate: (callback) => ipcRenderer.on('watcher-update', (event, data) => callback(data))
});
