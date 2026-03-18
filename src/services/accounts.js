const crypto = require('crypto');

const LIMIT_TYPES = ['5HR', 'DAILY', 'WEEKLY'];
const PLAN_TYPES = ['FREE', 'PRO', 'MAX', 'TEAM'];
const ALIAS_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

function formatPlan(plan) {
  return (plan || '').toUpperCase();
}

function validateLimitType(limitType) {
  if (!LIMIT_TYPES.includes(limitType)) {
    throw new Error(`ACCOUNTS ERROR · INVALID_LIMIT_TYPE · ${limitType}`);
  }
}

function validatePlan(plan) {
  const p = formatPlan(plan);
  if (!PLAN_TYPES.includes(p)) {
    throw new Error(`ACCOUNTS ERROR · INVALID_PLAN · ${plan}`);
  }
  return p;
}

function validateAlias(alias) {
  if (!alias || typeof alias !== 'string') {
    throw new Error('ACCOUNTS ERROR · ALIAS_REQUIRED');
  }
  if (!ALIAS_PATTERN.test(alias)) {
    throw new Error('ACCOUNTS ERROR · ALIAS_INVALID · must match [a-zA-Z0-9_-], max 32 chars');
  }
  return alias.trim();
}

function addAccount(db, { alias, email, plan }) {
  const safeAlias = validateAlias(alias);
  const safePlan = validatePlan(plan);
  const safeEmail = email && typeof email === 'string' ? email.trim() : null;

  const existing = db.prepare('SELECT account_id FROM accounts WHERE alias = ?').get(safeAlias);
  if (existing) {
    throw new Error(`ACCOUNTS ERROR · ALIAS_ALREADY_EXISTS · ${safeAlias}`);
  }

  const accountId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO accounts (account_id, alias, email, plan, is_active, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(accountId, safeAlias, safeEmail, safePlan, Date.now());

  return accountId;
}

function switchAccountFocus(db, accountId) {
  const exists = db.prepare('SELECT account_id FROM accounts WHERE account_id = ? AND is_active = 1').get(accountId);
  if (!exists) {
    throw new Error(`ACCOUNTS ERROR · ACCOUNT_NOT_ACTIVE · ${accountId}`);
  }
  db.prepare(`
    INSERT INTO account_focus (account_id, focused_at)
    VALUES (?, ?)
  `).run(accountId, Date.now());
}

function getCurrentAccountFocus(db) {
  const focus = db.prepare(`
    SELECT account_id FROM account_focus
    ORDER BY focused_at DESC LIMIT 1
  `).get();
  return focus ? focus.account_id : null;
}

function logAccountHit(db, config, accountId, limitType) {
  validateLimitType(limitType);

  const account = db.prepare('SELECT account_id FROM accounts WHERE account_id = ? AND is_active = 1').get(accountId);
  if (!account) {
    throw new Error(`ACCOUNTS ERROR · ACCOUNT_NOT_ACTIVE · ${accountId}`);
  }

  const now = Date.now();
  const windowMs = config.limitWindowsMs[limitType];
  const resetAt = now + windowMs;

  db.prepare(`
    INSERT INTO account_limit_events (account_id, limit_type, hit_at, reset_at)
    VALUES (?, ?, ?, ?)
  `).run(accountId, limitType, now, resetAt);
}

function undoAccountHit(db, accountId, limitType) {
  validateLimitType(limitType);
  const now = Date.now();
  const exists = db.prepare(`
    SELECT id
    FROM account_limit_events
    WHERE account_id = ? AND limit_type = ?
      AND reset_at > ?
    ORDER BY id DESC
    LIMIT 1
  `).get(accountId, limitType, now);

  if (!exists || !exists.id) {
    throw new Error(`ACCOUNTS ERROR · NO_HIT_TO_UNDO · ${limitType}`);
  }

  db.prepare(`
    DELETE FROM account_limit_events
    WHERE id = ?
  `).run(exists.id);
}

function listAccountsWithLimitStatus(db, config) {
  const now = Date.now();
  const focusAccountId = getCurrentAccountFocus(db);

  const accounts = db.prepare(`
    SELECT account_id, alias, email, plan, created_at
    FROM accounts
    WHERE is_active = 1
    ORDER BY created_at DESC
  `).all();

  const latestEventStmt = db.prepare(`
    SELECT hit_at, reset_at
    FROM account_limit_events
    WHERE account_id = ? AND limit_type = ?
    ORDER BY reset_at DESC, hit_at DESC
    LIMIT 1
  `);

  return accounts.map(a => {
    const limits = {};
    for (const lt of LIMIT_TYPES) {
      const latest = latestEventStmt.get(a.account_id, lt);
      if (!latest) {
        limits[lt] = { hasEvent: false, isHit: false, resetAt: null, hitAt: null };
        continue;
      }
      const isHit = latest.reset_at > now;
      limits[lt] = {
        hasEvent: true,
        isHit,
        resetAt: latest.reset_at,
        hitAt: latest.hit_at
      };
    }

    return {
      account_id: a.account_id,
      alias: a.alias,
      email: a.email,
      plan: a.plan,
      created_at: a.created_at,
      isFocused: focusAccountId && focusAccountId === a.account_id,
      limits
    };
  });
}

module.exports = {
  addAccount,
  switchAccountFocus,
  getCurrentAccountFocus,
  logAccountHit,
  undoAccountHit,
  listAccountsWithLimitStatus
};

