const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');

function createProject(db, name) {
  const projectId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO projects (project_id, name, created_at, last_active)
    VALUES (?, ?, ?, ?)
  `).run(projectId, name, Date.now(), Date.now());
  return projectId;
}

function listProjects(db) {
  return db.prepare('SELECT * FROM projects ORDER BY last_active DESC').all();
}

function startSession(db, projectId, maxConcurrentSessions = 5) {
  // Check concurrent session limit
  const activeCount = db.prepare("SELECT COUNT(*) as n FROM sessions WHERE state != 'CLOSED'").get().n;
  if (activeCount >= maxConcurrentSessions) {
    throw new Error(`MAX_SESSIONS_REACHED: ${activeCount}/${maxConcurrentSessions} active`);
  }

  const sessionId = crypto.randomUUID();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO sessions (session_id, project_id, started_at, state)
      VALUES (?, ?, ?, 'ACTIVE')
    `).run(sessionId, projectId, Date.now());

    // Automatically focus the new session
    db.prepare(`
      INSERT INTO session_focus (session_id, focused_at)
      VALUES (?, ?)
    `).run(sessionId, Date.now());

    // Update last_active in project
    db.prepare('UPDATE projects SET last_active = ? WHERE project_id = ?').run(Date.now(), projectId);
  })();

  return sessionId;
}

function setSessionState(db, sessionId, state) {
  const allowedStates = ['ACTIVE', 'NEAR_LIMIT', 'FINAL_WINDOW', 'CLOSED'];
  if (!allowedStates.includes(state)) {
    throw new Error(`SESSION ERROR · INVALID STATE · ${state}`);
  }

  if (state === 'CLOSED') {
    db.prepare('UPDATE sessions SET state = ?, ended_at = ? WHERE session_id = ?').run(state, Date.now(), sessionId);
  } else {
    db.prepare('UPDATE sessions SET state = ? WHERE session_id = ?').run(state, sessionId);
  }
}

function switchFocus(db, sessionId) {
  const session = db.prepare("SELECT session_id FROM sessions WHERE session_id = ? AND state != 'CLOSED'").get(sessionId);
  if (!session) throw new Error(`SESSION ERROR · SESSION NOT ACTIVE · ${sessionId}`);

  db.prepare(`
    INSERT INTO session_focus (session_id, focused_at)
    VALUES (?, ?)
  `).run(sessionId, Date.now());
}

function getCurrentFocus(db) {
  const focus = db.prepare(`
    SELECT s.* FROM sessions s
    JOIN session_focus f ON s.session_id = f.session_id
    ORDER BY f.focused_at DESC LIMIT 1
  `).get();
  return focus || null;
}

function getActiveSession(db) {
  // Returns the currently focused session
  return getCurrentFocus(db);
}

function listActiveSessions(db) {
  const currentFocus = getCurrentFocus(db);
  const sessions = db.prepare(`
    SELECT s.*, p.name as project_name 
    FROM sessions s
    JOIN projects p ON s.project_id = p.project_id
    WHERE s.state != 'CLOSED'
    ORDER BY s.started_at DESC
  `).all();

  return sessions.map(s => ({
    ...s,
    isFocused: currentFocus && s.session_id === currentFocus.session_id
  }));
}

function listSessionHistory(db) {
  return db.prepare(`
    SELECT s.*, p.name as project_name, 
    (SELECT COUNT(*) FROM files WHERE linked_session_id = s.session_id) as file_count
    FROM sessions s
    JOIN projects p ON s.project_id = p.project_id
    WHERE s.state = 'CLOSED'
    ORDER BY s.ended_at DESC
  `).all();
}

function setAlias(db, sessionId, alias) {
  const ALIAS_PATTERN = /^[a-zA-Z0-9_-]{0,32}$/;
  if (alias && !ALIAS_PATTERN.test(alias)) {
    throw new Error(`ALIAS_INVALID: must match [a-zA-Z0-9_-], max 32 chars`);
  }

  db.prepare('UPDATE sessions SET alias = ? WHERE session_id = ?').run(alias || null, sessionId);
}

function reopenSession(db, sessionId, maxConcurrentSessions = 5) {
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ? AND state = "CLOSED"').get(sessionId);
  if (!session) throw new Error(`SESSION ERROR · SESSION NOT CLOSED · ${sessionId}`);

  // Check concurrent session limit
  const activeCount = db.prepare("SELECT COUNT(*) as n FROM sessions WHERE state != 'CLOSED'").get().n;
  if (activeCount >= maxConcurrentSessions) {
    throw new Error(`MAX_SESSIONS_REACHED: ${activeCount}/${maxConcurrentSessions} active`);
  }

  db.transaction(() => {
    db.prepare('UPDATE sessions SET state = "ACTIVE", ended_at = NULL WHERE session_id = ?').run(sessionId);
    
    // Set reopened session as focused
    db.prepare(`
      INSERT INTO session_focus (session_id, focused_at)
      VALUES (?, ?)
    `).run(sessionId, Date.now());
  })();
}

function deleteSession(db, sessionId, config) {
  db.transaction(() => {
    // 1. Get file paths and delete from disk
    const filesToDelete = db.prepare('SELECT file_path FROM files WHERE linked_session_id = ?').all(sessionId);
    for (const file of filesToDelete) {
      try {
        fs.removeSync(file.file_path);
        console.log(`SESSION · DELETED FILE · ${file.file_path}`);
      } catch (err) {
        console.error(`SESSION · ERROR DELETING FILE · ${file.file_path} · ${err.message}`);
      }
    }

    // 2. Identify and delete the session's directory
    const sessionInfo = db.prepare('SELECT project_id FROM sessions WHERE session_id = ?').get(sessionId);
    if (sessionInfo && config && config.projectStore) {
      const sessionDirPath = path.join(config.projectStore, sessionInfo.project_id, 'sessions', sessionId);
      try {
        fs.removeSync(sessionDirPath);
        console.log(`SESSION · DELETED DIR · ${sessionDirPath}`);
      } catch (err) {
        console.error(`SESSION · ERROR DELETING DIR · ${sessionDirPath} · ${err.message}`);
      }
    }

    // 3. Remove focus history
    db.prepare('DELETE FROM session_focus WHERE session_id = ?').run(sessionId);
    
    // 4. Delete session record
    db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
  })();
}

function listSessions(db, projectId) {
  if (projectId) {
    return db.prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC').all(projectId);
  }
  return db.prepare('SELECT * FROM sessions ORDER BY started_at DESC').all();
}

module.exports = {
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
};
