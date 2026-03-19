const HANDOFF_SECTION_LABELS = ['OBJECTIVE', 'CURRENT STATE', 'KEY DECISIONS', 'FILES USED', 'IMPORTANT CONTEXT', 'NEXT STEPS'];

function saveHandoffDraft(db, { sessionId = null, rawInput, parsedJson, builtTemplate }) {
  if (rawInput == null || typeof rawInput !== 'string') {
    throw new Error('HANDOFF ERROR · rawInput must be a string');
  }
  if (!parsedJson || typeof parsedJson !== 'object') {
    throw new Error('HANDOFF ERROR · parsedJson must be an object');
  }
  if (!builtTemplate || typeof builtTemplate !== 'string') {
    throw new Error('HANDOFF ERROR · builtTemplate must be a string');
  }

  db.prepare(`
    INSERT INTO handoff_drafts (session_id, raw_input, parsed_json, built_template, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    sessionId ?? null,
    rawInput,
    JSON.stringify(parsedJson),
    builtTemplate,
    Date.now()
  );
}

function getLatestHandoffDraft(db, sessionId = null) {
  const row = sessionId
    ? db.prepare(`
        SELECT * FROM handoff_drafts
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(sessionId)
    : db.prepare(`
        SELECT * FROM handoff_drafts
        ORDER BY created_at DESC
        LIMIT 1
      `).get();

  if (!row) return null;

  return {
    sessionId: row.session_id,
    rawInput: row.raw_input,
    parsedJson: row.parsed_json,
    builtTemplate: row.built_template,
    createdAt: row.created_at
  };
}

module.exports = {
  HANDOFF_SECTION_LABELS,
  saveHandoffDraft,
  getLatestHandoffDraft
};

