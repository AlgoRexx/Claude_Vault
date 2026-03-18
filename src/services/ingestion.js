const fs = require('fs-extra');
const path = require('path');
const { hashFile } = require('../utils/hashing');
async function ingestFile(db, config, filePath) {
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase().slice(1);

  // Stage 2: Validation
  if (!fs.existsSync(filePath)) {
    return { status: 'REJECTED', reason: 'FILE_DISAPPEARED' };
  }

  const stats = await fs.stat(filePath);
  if (stats.size === 0) {
    return { status: 'REJECTED', reason: 'SIZE_ZERO' };
  }

  if (config.fileTypeAllowlist && config.fileTypeAllowlist.length > 0) {
    if (!config.fileTypeAllowlist.includes(ext)) {
      return { status: 'REJECTED', reason: 'EXTENSION_BLOCKED' };
    }
  }

  // Stage 3: Hashing
  const hash = await hashFile(filePath);

  // Deduplication check
  const existing = db.prepare('SELECT file_id, file_path FROM files WHERE hash = ?').get(hash);
  if (existing) {
    // If it exists but at a different path, we might want to update it, 
    // but the TRD says "Skip file copy. Link existing file_id to current session."
    return { status: 'DEDUPLICATED', fileId: existing.file_id };
  }

  // Stage 4: Move & Rename
  const fileId = require('crypto').randomUUID();
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const hashPrefix = hash.slice(0, 8);
  const stem = path.parse(fileName).name;
  const newFileName = `${stem}_${timestamp}_${hashPrefix}${path.extname(fileName)}`;

  // Determine target path
  // Link to the currently FOCUSED session (TRD §11.2)
  const currentFocus = db.prepare(`
    SELECT s.session_id, s.project_id FROM sessions s
    JOIN session_focus f ON s.session_id = f.session_id
    ORDER BY f.focused_at DESC LIMIT 1
  `).get();
  
  let targetPath;
  let sessionId = null;
  let projectId = null;

  if (currentFocus) {
    sessionId = currentFocus.session_id;
    projectId = currentFocus.project_id;
    targetPath = path.join(config.projectStore, projectId, 'sessions', sessionId, 'files', newFileName);
  } else {
    const today = new Date().toISOString().split('T')[0];
    targetPath = path.join(config.unlinkedStore, today, newFileName);
  }

  await fs.ensureDir(path.dirname(targetPath));
  
  try {
    // Cross-device move handle
    await fs.move(filePath, targetPath);
  } catch (err) {
    console.error(`INGESTION ERROR · MOVE FAILED · ${err.message}`);
    return { status: 'REJECTED', reason: 'MOVE_FAILED', detail: err.message };
  }

  // Stage 5: DB Write
  const stmt = db.transaction(() => {
    db.prepare(`
      INSERT INTO files (file_id, file_name, original_name, file_path, hash, file_type, size_bytes, created_at, linked_session_id, project_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fileId, newFileName, fileName, targetPath, hash, ext, stats.size, Date.now(), sessionId, projectId);

    db.prepare(`
      INSERT INTO file_events (file_id, event_type, detail, timestamp)
      VALUES (?, 'CREATED', ?, ?)
    `).run(fileId, JSON.stringify({ status: 'CREATED', originalPath: filePath }), Date.now());
  });
  
  stmt();

  return { status: 'CREATED', fileId, fileName: newFileName, targetPath };
}

module.exports = {
  ingestFile
};
