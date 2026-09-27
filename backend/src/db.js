const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { SCHEMA } = require('./schema');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'prm.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const raw = new DatabaseSync(DB_PATH);
raw.exec('PRAGMA foreign_keys = ON;');
raw.exec(SCHEMA);

// Minimal better-sqlite3-compatible wrapper over node:sqlite.
function normalizeResult(r) {
  if (!r) return { lastInsertRowid: 0, changes: 0 };
  return {
    lastInsertRowid: Number(r.lastInsertRowid != null ? r.lastInsertRowid : 0),
    changes: Number(r.changes != null ? r.changes : 0),
  };
}
const db = {
  prepare(sql) {
    const stmt = raw.prepare(sql);
    return {
      run(...params) { return normalizeResult(stmt.run(...params)); },
      get(...params) { const r = stmt.get(...params); return r === undefined ? undefined : r; },
      all(...params) { return stmt.all(...params); },
    };
  },
  exec(sql) { return raw.exec(sql); },
  transaction(fn) {
    return (...args) => {
      raw.exec('BEGIN IMMEDIATE;');
      try {
        const out = fn(...args);
        raw.exec('COMMIT;');
        return out;
      } catch (e) {
        try { raw.exec('ROLLBACK;'); } catch {}
        throw e;
      }
    };
  },
};

module.exports = db;
