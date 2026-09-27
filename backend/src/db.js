// Database layer on @libsql/client (Turso).
//
// Two modes, one code path:
//   Local dev (no TURSO_URL): plain SQLite file at DB_PATH. Zero setup.
//   Production (TURSO_URL + TURSO_TOKEN): embedded replica. Reads and writes
//     hit the LOCAL file (so transactions stay real SQLite transactions),
//     and the client pushes/pulls to Turso every syncInterval. On Render free,
//     a wiped disk re bootstraps from Turso on next boot, so data survives
//     restarts. Only writes newer than the last push (seconds) are at risk.
//
// All methods are async. Callers must await them.
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');
const { SCHEMA } = require('./schema');

const LOCAL_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'prm.sqlite');
fs.mkdirSync(path.dirname(LOCAL_PATH), { recursive: true });

const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;
const REMOTE = Boolean(TURSO_URL);

const client = createClient({
  url: 'file:' + LOCAL_PATH,
  ...(REMOTE ? { syncUrl: TURSO_URL, authToken: TURSO_TOKEN, syncInterval: 10000 } : {}),
});

function toObjects(res) {
  const cols = res.columns || [];
  return (res.rows || []).map((row) => {
    const o = {};
    cols.forEach((c, i) => { o[c] = row[i]; });
    return o;
  });
}

function bindPrepare(executor, sql, gate) {
  return {
    async run(...params) {
      if (gate) await gate;
      const res = await executor({ sql, args: params });
      return {
        lastInsertRowid: res.lastInsertRowid == null ? 0 : Number(res.lastInsertRowid),
        changes: Number(res.rowsAffected || 0),
      };
    },
    async get(...params) {
      if (gate) await gate;
      const rows = toObjects(await executor({ sql, args: params }));
      return rows.length ? rows[0] : undefined;
    },
    async all(...params) {
      if (gate) await gate;
      return toObjects(await executor({ sql, args: params }));
    },
  };
}

function splitStatements(sql) {
  return sql.split(';').map((s) => s.trim()).filter((s) => s.length > 5);
}

const ready = (async () => {
  if (REMOTE) {
    try {
      await client.sync();
      console.log('[db] synced from Turso.');
    } catch (e) {
      console.error('[db] Turso pull failed, continuing with local copy:', e.message);
    }
  }
  await client.execute('PRAGMA foreign_keys = ON;');
  for (const stmt of splitStatements(SCHEMA)) {
    await client.execute(stmt);
  }
  // One time template upgrade for databases seeded before the receipt and
  // invoice detail blocks existed. Only touches templates still carrying
  // the exact original text, never customized ones.
  const upgrades = [
    ['Rent Invoice Email',
      'Dear {{tenant_name}}, your rent invoice of Rs.{{amount}} is due on {{due_date}}.',
      'Dear {{tenant_name}}, your rent invoice {{invoice_number}} of Rs.{{amount}} is due on {{due_date}}.\n\n{{invoice_detail}}'],
    ['Payment Receipt Email',
      'Dear {{tenant_name}}, your payment of Rs.{{amount}} has been received. Receipt: {{receipt_number}}.',
      'Dear {{tenant_name}}, your payment of Rs.{{amount}} has been received. Receipt: {{receipt_number}}.\n\n{{receipt_detail}}'],
    ['Overdue Email',
      'Dear {{tenant_name}}, Rs.{{amount}} is overdue since {{due_date}}.',
      'Dear {{tenant_name}}, Rs.{{amount}} on invoice {{invoice_number}} is overdue since {{due_date}}.'],
  ];
  for (const [name, from, to] of upgrades) {
    try {
      await client.execute({ sql: `UPDATE notification_templates SET message_template = ? WHERE template_name = ? AND message_template = ?`, args: [to, name, from] });
    } catch (e) { console.error('[db] template migration note:', e.message); }
  }
  console.log(`[db] ready (${REMOTE ? 'embedded replica + Turso' : 'local file'}).`);
})().catch((e) => { console.error('[db] init failed:', e.message); process.exit(1); });

const db = {
  ready,
  isRemote: REMOTE,
  async sync() {
    if (!REMOTE) return;
    try { await client.sync(); } catch (e) { console.error('[db] Turso sync failed:', e.message); }
  },
  prepare(sql) {
    return bindPrepare((stmt) => client.execute(stmt), sql, ready);
  },
  async exec(sql) {
    await ready;
    for (const stmt of splitStatements(sql)) {
      await client.execute(stmt);
    }
  },
  // Atomic write transaction. The closure receives a tx-scoped handle with
  // the same prepare/exec shape; ALL statements inside must use it, because
  // statements on the shared client run outside the transaction.
  transaction(fn) {
    return async (...args) => {
      await ready;
      const tx = await client.transaction('write');
      const tdb = {
        prepare: (sql) => bindPrepare((stmt) => tx.execute(stmt), sql),
        exec: async (sql) => {
          for (const stmt of splitStatements(sql)) {
            await tx.execute(stmt);
          }
        },
      };
      try {
        const out = await fn(tdb, ...args);
        await tx.commit();
        return out;
      } catch (e) {
        try { await tx.rollback(); } catch {}
        throw e;
      } finally {
        tx.close();
      }
    };
  },
};

module.exports = db;
