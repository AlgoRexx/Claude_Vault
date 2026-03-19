const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { loadConfig } = require('./utils/config');
const { initDb } = require('./database/db');
const { startWatcher, toggleWatcher, getWatcherState } = require('./services/watcher');
const { 
  createProject, 
  listProjects, 
  startSession, 
  setSessionState, 
  getActiveSession, 
  listSessions,
  switchFocus,
  getCurrentFocus,
  listActiveSessions,
  listSessionHistory,
  setAlias,
  reopenSession,
  deleteSession
} = require('./services/session');
const { getSuggestions, linkFilesToSession } = require('./services/suggestions');
const { getEligibleProjects, archiveProject, deleteProjectFiles, keepProject } = require('./services/cleanup');
const { generateTrayIcon } = require('./utils/icon_gen');
const {
  addAccount,
  logAccountHit,
  undoAccountHit,
  switchAccountFocus,
  listAccountsWithLimitStatus
} = require('./services/accounts');

const { saveHandoffDraft, getLatestHandoffDraft } = require('./services/handoff');
const { addChat, listChats, deleteChat } = require('./services/chats');

let mainWindow;
let popoverWindow;
let tray;
let watcher;
let config;
let db;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#1C1C1C',
    frame: false,
    show: false, // DG-035: Electron main window is hidden at launch
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  global.mainWindow = mainWindow;
  mainWindow.loadFile('src/renderer/index.html');

  ipcMain.on('window-control', (event, action) => {
    if (action === 'minimize') mainWindow.minimize();
    if (action === 'maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
    if (action === 'close') mainWindow.hide(); // Hide instead of close per DG-035
  });

  ipcMain.on('show-main', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

function createPopoverWindow() {
  popoverWindow = new BrowserWindow({
    width: 320, // DG-038: Popover is exactly 320px wide
    height: 520, 
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#111111', // DG-039: Popover background is #111111
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  popoverWindow.loadFile('src/renderer/widget.html');
  global.popoverWindow = popoverWindow;
  
  popoverWindow.on('blur', () => {
    popoverWindow.hide();
  });
}

function togglePopover() {
  if (popoverWindow.isVisible()) {
    popoverWindow.hide();
  } else {
    showPopover();
  }
}

function showPopover() {
  const trayBounds = tray.getBounds();
  const windowBounds = popoverWindow.getBounds();
  
  // DG-038: Anchors top-right below the icon
  const x = Math.round(trayBounds.x + trayBounds.width - windowBounds.width);
  const y = Math.round(trayBounds.y + trayBounds.height + 4);
  
  popoverWindow.setPosition(x, y, false);
  popoverWindow.show();
  popoverWindow.focus();
}

function createTray() {
  console.log('TRAY · INITIALIZING');
  try {
    // Using dynamic buffer generation for sharp pixels (DG-036)
    const icon = generateTrayIcon();
    tray = new Tray(icon);
    
    tray.on('click', () => {
      togglePopover();
    });

    tray.on('right-click', () => {
      const contextMenu = Menu.buildFromTemplate([
        { label: 'Show ClaudeVault', click: () => { mainWindow.show(); mainWindow.focus(); } },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() }
      ]);
      tray.popUpContextMenu(contextMenu);
    });
    
    tray.setToolTip('ClaudeVault');
    console.log('TRAY · READY');

    // Periodically check for pending actions to update badge (DG-037)
    setInterval(updateTrayIcon, 5000);
  } catch (err) {
    console.error(`TRAY · ERROR · ${err.message}`);
  }
}

function updateTrayIcon() {
  if (!tray) return;
  
  const activeSession = getActiveSession(db);
  const eligibleProjects = getEligibleProjects(db, config.cleanupTtlDays || 30);
  
  // As per TRD/PRD, we need to check if these are unresolved. 
  // For v1, just presence is enough to trigger the badge logic in DG-037.
  const hasPendingAction = (activeSession && (activeSession.state === 'NEAR_LIMIT' || activeSession.state === 'FINAL_WINDOW')) || 
                           (eligibleProjects.length > 0);

  tray.setImage(generateTrayIcon(hasPendingAction));
}

function setupIpc() {
  ipcMain.handle('get-status', () => {
    const activeSession = getActiveSession(db);
    let activeSessionFileCount = 0;
    if (activeSession) {
      const result = db.prepare('SELECT COUNT(*) as count FROM files WHERE linked_session_id = ?').get(activeSession.session_id);
      activeSessionFileCount = result ? result.count : 0;
    }
    return {
      activeSession,
      activeSessionFileCount,
      activeSessions: listActiveSessions(db),
      sessionHistory: listSessionHistory(db),
      watchDir: config.watchDir,
      dbPath: config.dbPath,
      watcherState: getWatcherState(),
      lastEvent: null 
    };
  });

  ipcMain.handle('switch-focus', (event, sessionId) => switchFocus(db, sessionId));
  ipcMain.handle('set-alias', (event, sessionId, alias) => setAlias(db, sessionId, alias));
  ipcMain.handle('reopen-session', (event, sessionId) => reopenSession(db, sessionId, config, config.max_concurrent_sessions || 5));
  ipcMain.handle('delete-session', (event, sessionId) => deleteSession(db, sessionId, config));
  ipcMain.handle('start-session', (event, projectId) => startSession(db, projectId, config, config.max_concurrent_sessions || 5));
  ipcMain.handle('reveal-session-folder', (event, sessionId) => {
    const sessionInfo = db.prepare('SELECT project_id FROM sessions WHERE session_id = ?').get(sessionId);
    if (sessionInfo && config && config.projectStore) {
      const sessionDirPath = path.join(config.projectStore, sessionInfo.project_id, 'sessions', sessionId);
      if (fs.existsSync(sessionDirPath)) {
        shell.showItemInFolder(path.resolve(sessionDirPath));
      } else {
        // Fallback: create it if it somehow doesn't exist when user clicks reveal
        try {
          fs.ensureDirSync(sessionDirPath);
          shell.showItemInFolder(path.resolve(sessionDirPath));
        } catch (err) {
          console.error(`SESSION · REVEAL ERROR · ${err.message}`);
        }
      }
    }
  });
  
  ipcMain.handle('toggle-watcher', () => toggleWatcher());
  ipcMain.handle('list-recent-files', (event, sessionId = null) => {
    if (sessionId) {
      return db.prepare(`
        SELECT f.file_id, f.original_name, f.file_type, f.created_at, f.linked_session_id, f.project_id, s.alias as session_alias
        FROM files f
        LEFT JOIN sessions s ON f.linked_session_id = s.session_id
        WHERE f.linked_session_id = ?
        ORDER BY f.created_at DESC
        LIMIT 50
      `).all(sessionId);
    }
    return db.prepare(`
      SELECT f.file_id, f.original_name, f.file_type, f.created_at, f.linked_session_id, f.project_id, s.alias as session_alias
      FROM files f
      LEFT JOIN sessions s ON f.linked_session_id = s.session_id
      ORDER BY f.created_at DESC
      LIMIT 50
    `).all();
  });

  ipcMain.handle('list-projects', () => listProjects(db));
  ipcMain.handle('create-project', (event, name) => createProject(db, name, config));
  ipcMain.handle('list-sessions', (event, projectId) => listSessions(db, projectId));
  
  ipcMain.handle('stop-session', () => {
    const active = getActiveSession(db);
    if (active) setSessionState(db, active.session_id, 'CLOSED');
  });
  ipcMain.handle('set-session-state', (event, state) => {
    const active = getActiveSession(db);
    if (active) setSessionState(db, active.session_id, state);
  });
  ipcMain.handle('get-suggestions', (event, projectId) => getSuggestions(db, projectId));
  ipcMain.handle('link-files-to-session', (event, fileIds, sessionId) => linkFilesToSession(db, fileIds, sessionId));
  ipcMain.handle('get-cleanup-eligible', () => getEligibleProjects(db, config.cleanupTtlDays || 30));
  ipcMain.handle('archive-project', (event, projectId) => {
    const projectDir = path.join(config.projectStore, projectId);
    return archiveProject(db, projectId, projectDir, config.archiveDir);
  });
  ipcMain.handle('delete-project', (event, projectId) => {
    const projectDir = path.join(config.projectStore, projectId);
    return deleteProjectFiles(db, projectId, projectDir);
  });
  ipcMain.handle('keep-project', (event, projectId) => keepProject(db, projectId));

  // Accounts (ACCTS tab)
  ipcMain.handle('list-accounts', () => listAccountsWithLimitStatus(db, config));
  ipcMain.handle('add-account', (event, payload) => addAccount(db, payload));
  ipcMain.handle('log-account-hit', (event, accountId, limitType) => logAccountHit(db, config, accountId, limitType));
  ipcMain.handle('undo-account-hit', (event, accountId, limitType) => undoAccountHit(db, accountId, limitType));
  ipcMain.handle('switch-account', (event, accountId) => switchAccountFocus(db, accountId));

  // HANDOFF tab
  ipcMain.handle('save-handoff-draft', (event, payload) => saveHandoffDraft(db, payload));
  ipcMain.handle('get-latest-handoff-draft', (event, sessionId = null) => getLatestHandoffDraft(db, sessionId));

  // CHATS tab
  ipcMain.handle('add-chat', (event, payload) => addChat(db, payload));
  ipcMain.handle('list-chats', (event, sessionId) => listChats(db, sessionId));
  ipcMain.handle('delete-chat', (event, chatId) => deleteChat(db, chatId));
}

app.whenReady().then(() => {
  config = loadConfig();
  db = initDb(config.dbPath);
  watcher = startWatcher(db, config);
  
  setupIpc();
  createWindow();
  createPopoverWindow();
  createTray();
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
