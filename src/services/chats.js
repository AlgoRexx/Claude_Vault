const fs = require('fs-extra');
const path = require('path');

function addChat(db, { sessionId, name, notes }) {
  if (!sessionId) throw new Error('CHATS ERROR · NO ACTIVE SESSION');
  if (!name || name.trim().length === 0) throw new Error('CHATS ERROR · NAME REQUIRED');

  const stmt = db.prepare(`
    INSERT INTO chats (session_id, name, notes, created_at)
    VALUES (?, ?, ?, ?)
  `);
  
  const info = stmt.run(sessionId, name.trim(), notes ? notes.trim() : null, Date.now());
  return info.lastInsertRowid;
}

function listChats(db, sessionId) {
  if (!sessionId) return [];
  
  return db.prepare(`
    SELECT c.*, s.alias as session_alias
    FROM chats c
    JOIN sessions s ON c.session_id = s.session_id
    WHERE c.session_id = ?
    ORDER BY c.created_at DESC
  `).all(sessionId);
}

function deleteChat(db, chatId) {
  db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
}

module.exports = {
  addChat,
  listChats,
  deleteChat
};
