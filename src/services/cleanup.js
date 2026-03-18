const fs = require('fs-extra');
const path = require('path');
const archiver = require('archiver');

async function getEligibleProjects(db, ttlDays) {
  const threshold = Date.now() - (ttlDays * 24 * 60 * 60 * 1000);
  
  const query = `
    SELECT 
      f.project_id,
      p.name as project_name,
      COUNT(f.file_id) AS file_count,
      SUM(f.size_bytes) AS total_bytes,
      MIN(f.created_at) AS oldest_file
    FROM files f
    JOIN projects p ON f.project_id = p.project_id
    WHERE f.created_at < ?
      AND f.project_id NOT IN (
        SELECT project_id FROM cleanup_log
        WHERE action = 'SKIPPED' AND triggered_at > ?
      )
    GROUP BY f.project_id
    HAVING COUNT(f.file_id) > 0;
  `;
  
  // Re-check SKIPPED logic. Let's say if we skipped it in the last 30 days, don't show it again.
  return db.prepare(query).all(threshold, threshold);
}

async function archiveProject(db, projectId, projectDir, archiveDir) {
  if (!fs.existsSync(projectDir)) {
    throw new Error(`CLEANUP ERROR · PROJECT DIR NOT FOUND · ${projectDir}`);
  }

  const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '_');
  const archiveName = `${projectId}_${timestamp}.zip`;
  const archivePath = path.join(archiveDir, archiveName);

  await fs.ensureDir(archiveDir);

  const output = fs.createWriteStream(archivePath);
  const archive = archiver('zip', { zlib: { level: 6 } });

  return new Promise((resolve, reject) => {
    output.on('close', () => {
      // Record in log
      db.prepare(`
        INSERT INTO cleanup_log (project_id, action, triggered_at, resolved_at)
        VALUES (?, 'ARCHIVED', ?, ?)
      `).run(projectId, Date.now(), Date.now());
      
      // Update file_events for each file? Maybe just for the project.
      resolve(archivePath);
    });

    archive.on('error', (err) => reject(err));
    archive.pipe(output);
    archive.directory(projectDir, false);
    archive.finalize();
  });
}

async function deleteProjectFiles(db, projectId, projectDir) {
  if (fs.existsSync(projectDir)) {
    await fs.remove(projectDir);
  }

  db.prepare(`
    INSERT INTO cleanup_log (project_id, action, triggered_at, resolved_at)
    VALUES (?, 'DELETED', ?, ?)
  `).run(projectId, Date.now(), Date.now());
}

async function keepProject(db, projectId) {
  db.prepare(`
    INSERT INTO cleanup_log (project_id, action, triggered_at, resolved_at)
    VALUES (?, 'SKIPPED', ?, ?)
  `).run(projectId, Date.now(), Date.now());
}

module.exports = {
  getEligibleProjects,
  archiveProject,
  deleteProjectFiles,
  keepProject
};
