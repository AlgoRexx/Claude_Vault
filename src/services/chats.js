const fs = require('fs-extra');
const path = require('path');

function addChat(db, { sessionId, accountId, name, notes }) {
  if (!sessionId) throw new Error('CHATS ERROR · NO ACTIVE SESSION');
  if (!name || name.trim().length === 0) throw new Error('CHATS ERROR · NAME REQUIRED');

  const stmt = db.prepare(`
    INSERT INTO chats (session_id, account_id, name, notes, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  
  const info = stmt.run(sessionId, accountId || null, name.trim(), notes ? notes.trim() : null, Date.now());
  return info.lastInsertRowid;
}

function listChats(db, sessionId) {
  if (!sessionId) return [];
  
  return db.prepare(`
    SELECT c.*, s.alias as session_alias, a.alias as account_alias
    FROM chats c
    JOIN sessions s ON c.session_id = s.session_id
    LEFT JOIN accounts a ON c.account_id = a.account_id
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
