function tokenize(str) {
  if (!str) return new Set();
  const tokens = str.toLowerCase().split(/[_ \-.]+/);
  const stopwords = new Set(['old', 'backup', 'v1', 'copy', 'final']);
  return new Set(tokens.filter(t => t.length > 1 && !stopwords.has(t)));
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

function hoursAgo(timestamp) {
  return (Date.now() - timestamp) / (1000 * 60 * 60);
}

function scoreFile(candidate, context) {
  // Filename similarity
  const candidateTokens = tokenize(candidate.original_name);
  const contextTokens = tokenize(context.recentFileNames);
  const filenameSim = jaccardSimilarity(candidateTokens, contextTokens);

  // Recency score
  const recencyScore = 1 / (1 + hoursAgo(candidate.created_at));

  // Session overlap score (simplified for v1)
  const sessionOverlapScore = candidate.sharedSessionCount / (context.totalSessions || 1);

  const finalScore = (
    0.5 * filenameSim +
    0.3 * recencyScore +
    0.2 * sessionOverlapScore
  );

  let confidence = 'low';
  if (finalScore >= 0.7) confidence = 'high';
  else if (finalScore >= 0.4) confidence = 'medium';

  return {
    ...candidate,
    score: finalScore,
    confidence
  };
}

function getSuggestions(db, projectId) {
  // Candidates: files linked to sessions in the same project, or recent unlinked files
  // But exclude files already linked to an ACTIVE session of this project
  const query = `
    SELECT 
      f.file_id, 
      f.original_name, 
      f.file_path, 
      f.created_at, 
      f.linked_session_id,
      (SELECT COUNT(*) FROM files WHERE project_id = ? AND original_name = f.original_name) as sharedSessionCount
    FROM files f
    WHERE (f.project_id = ? OR f.project_id IS NULL)
      AND (f.linked_session_id IS NULL OR f.linked_session_id NOT IN (
        SELECT session_id FROM sessions WHERE project_id = ? AND state != 'CLOSED'
      ))
    ORDER BY f.created_at DESC
    LIMIT 50
  `;
  
  const candidates = db.prepare(query).all(projectId, projectId, projectId);

  // Context: files from the last session of this project
  const lastSession = db.prepare('SELECT session_id FROM sessions WHERE project_id = ? AND state = \'CLOSED\' ORDER BY ended_at DESC LIMIT 1').get(projectId);
  
  let recentFileNames = '';
  let totalSessions = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE project_id = ?').get(projectId).count;

  if (lastSession) {
    const lastSessionFiles = db.prepare('SELECT original_name FROM files WHERE linked_session_id = ?').all(lastSession.session_id);
    recentFileNames = lastSessionFiles.map(f => f.original_name).join(' ');
  }

  const context = {
    recentFileNames,
    totalSessions
  };

  const scored = candidates
    .map(c => scoreFile(c, context))
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 5); // Return top 5 suggestions
}

function linkFilesToSession(db, fileIds, sessionId) {
  const session = db.prepare('SELECT project_id FROM sessions WHERE session_id = ?').get(sessionId);
  if (!session) throw new Error(`SUGGESTIONS ERROR · SESSION NOT FOUND · ${sessionId}`);

  db.transaction(() => {
    for (const fileId of fileIds) {
      db.prepare(`
        UPDATE files 
        SET linked_session_id = ?, project_id = ?
        WHERE file_id = ?
      `).run(sessionId, session.project_id, fileId);

      db.prepare(`
        INSERT INTO file_events (file_id, event_type, detail, timestamp)
        VALUES (?, 'LINKED', ?, ?)
      `).run(fileId, JSON.stringify({ sessionId, projectId: session.project_id }), Date.now());
    }
  })();
}

module.exports = {
  getSuggestions,
  linkFilesToSession
};
