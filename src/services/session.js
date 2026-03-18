const crypto = require('crypto');

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

function startSession(db, projectId) {
  // Only one active session at a time (TRD §8 Case: Multiple sessions active simultaneously)
  const activeSessions = db.prepare("SELECT session_id FROM sessions WHERE state != 'CLOSED'").all();
  if (activeSessions.length > 0) {
    throw new Error(`SESSION ERROR · ACTIVE SESSION EXISTS · ${activeSessions[0].session_id}`);
  }

  const sessionId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO sessions (session_id, project_id, started_at, state)
    VALUES (?, ?, ?, 'ACTIVE')
  `).run(sessionId, projectId, Date.now());

  // Update last_active in project
  db.prepare('UPDATE projects SET last_active = ? WHERE project_id = ?').run(Date.now(), projectId);

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

function getActiveSession(db) {
  return db.prepare("SELECT * FROM sessions WHERE state != 'CLOSED' ORDER BY started_at DESC LIMIT 1").get();
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
  listSessions
};
