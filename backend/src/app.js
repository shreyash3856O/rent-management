const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const multer = require('multer');
const db = require('./db');
const seed = require('./seed');
const svc = require('./services');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET must be set when NODE_ENV=production. Refusing to start.');
  process.exit(1);
}
const PORT = process.env.PORT || 4000;

// ---------- helpers ----------
function audit(userId, moduleName, action, entityType, entityId, oldVal, newVal, req) {
  (async () => {
    try {
      await db.prepare(`INSERT INTO audit_logs (user_id, module_name, action, entity_type, entity_id, old_value, new_value, ip_address, device_info)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        userId || null, moduleName, action, entityType, entityId == null ? null : Number(entityId),
        oldVal ? JSON.stringify(oldVal).slice(0, 4000) : null,
        newVal ? JSON.stringify(newVal).slice(0, 4000) : null,
        req ? (req.ip || null) : null, req ? String(req.headers['user-agent'] || '').slice(0, 500) : null);
    } catch (e) { console.error('audit fail', e.message); }
  })();
}
function signToken(payload) { return jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' }); }

function auth(required = true) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!tok) { if (!required) return next(); return res.status(401).json({ error: 'Missing token' }); }
    try {
      const p = jwt.verify(tok, JWT_SECRET);
      req.auth = p;
      next();
    } catch { return res.status(401).json({ error: 'Invalid token' }); }
  };
}
// File downloads happen through plain links, which cannot set headers,
// so /files also accepts the JWT as ?token=.
function fileAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || null);
  if (!tok) return res.status(401).json({ error: 'Missing token' });
  try { req.auth = jwt.verify(tok, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }
}
// RBAC enforced at API layer from role_permissions table.
function requirePerm(moduleName, action) {
  const col = { view: 'can_view', add: 'can_add', edit: 'can_edit', delete: 'can_delete', approve: 'can_approve' }[action];
  return async (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Missing token' });
    if (req.auth.kind === 'tenant') {
      if (!req.path.startsWith('/tenant/') && req.baseUrl === '/api') {
        const tenantOnly = req.originalUrl.includes('/api/tenant/');
        if (!tenantOnly) return res.status(403).json({ error: 'Tenants are limited to tenant routes' });
      }
      return next();
    }
    try {
      const perms = await db.prepare(`SELECT p.module_name, rp.can_view, rp.can_add, rp.can_edit, rp.can_delete, rp.can_approve
        FROM role_permissions rp JOIN permissions p ON p.permission_id = rp.permission_id
        WHERE rp.role_id = ? AND p.module_name = ?`).get(req.auth.roleId, moduleName);
      if (!perms || !perms[col]) return res.status(403).json({ error: `Forbidden: ${moduleName} ${action} required` });
      next();
    } catch (e) { return res.status(500).json({ error: 'Permission check failed' }); }
  };
}
const roleName = async (id) => { try { return (await db.prepare(`SELECT role_name FROM roles WHERE role_id = ?`).get(id)).role_name; } catch { return null; } };

// Health check for orchestrators and uptime monitors (no auth).
app.get('/api/health', async (req, res) => {
  try {
    await db.prepare('SELECT 1 AS ok').get();
    res.json({ ok: true, service: 'prm-backend', time: new Date().toISOString() });
  } catch (e) { res.status(500).json({ ok: false, error: 'database unreachable' }); }
});

// ---------- auth ----------
// Admin/staff login: email + password.
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const u = await db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
  if (!u || !u.password_hash || !bcrypt.compareSync(password || '', u.password_hash))
    return res.status(401).json({ error: 'Invalid credentials' });
  if (u.status !== 'ACTIVE') return res.status(403).json({ error: 'Account not active' });
  await db.prepare(`UPDATE users SET last_login = datetime('now') WHERE user_id = ?`).run(u.user_id);
  const role = await roleName(u.role_id);
  const token = signToken({ kind: 'staff', userId: u.user_id, roleId: u.role_id, role, orgId: u.organization_id });
  audit(u.user_id, 'AUTH', 'LOGIN', 'users', u.user_id, null, { email }, req);
  res.json({ token, user: { user_id: u.user_id, full_name: u.full_name, email: u.email, role, role_id: u.role_id } });
});

// Tenant OTP: request + verify. Demo returns OTP in response (no SMS vendor in v1).
app.post('/api/auth/tenant/request-otp', async (req, res) => {
  const { mobile } = req.body || {};
  const t = await db.prepare(`SELECT * FROM tenants WHERE mobile = ?`).get(mobile);
  if (!t) return res.status(404).json({ error: 'Tenant mobile not registered' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await db.prepare(`INSERT INTO tenant_otps (mobile, otp_code, expires_at) VALUES (?,?,datetime('now','+10 minutes'))`).run(mobile, code);
  // Demo mode returns the OTP directly so the flow works without an SMS vendor.
  // In production the OTP is only ever sent through the SMS seam, never in
  // the response. Without SMS_WEBHOOK_URL configured, this endpoint refuses.
  if (process.env.NODE_ENV === 'production') {
    const events = require('./events');
    try {
      await events.smsProviders.sendSms(mobile, `Your Rent Ledger login code is ${code}. It expires in 10 minutes.`);
      return res.json({ message: 'OTP sent by SMS.' });
    } catch (e) {
      return res.status(502).json({ error: 'SMS delivery is not configured (' + e.message + '). Set SMS_WEBHOOK_URL.' });
    }
  }
  res.json({ message: 'OTP generated (demo mode, returned directly).', otp: code });
});
app.post('/api/auth/tenant/verify-otp', async (req, res) => {
  const { mobile, otp } = req.body || {};
  const row = await db.prepare(`SELECT * FROM tenant_otps WHERE mobile = ? AND otp_code = ? AND consumed = 0 AND datetime(expires_at) > datetime('now') ORDER BY otp_id DESC`).get(mobile, otp);
  if (!row) return res.status(401).json({ error: 'Invalid or expired OTP' });
  await db.prepare(`UPDATE tenant_otps SET consumed = 1 WHERE otp_id = ?`).run(row.otp_id);
  const t = await db.prepare(`SELECT * FROM tenants WHERE mobile = ?`).get(mobile);
  const token = signToken({ kind: 'tenant', tenantId: t.tenant_id, role: 'TENANT' });
  res.json({ token, tenant: { tenant_id: t.tenant_id, full_name: t.full_name, mobile: t.mobile, email: t.email } });
});

// ---------- generic CRUD helper ----------
function crud(table, pk, moduleName, opts = {}) {
  const r = express.Router();
  r.get('/', auth(), requirePerm(moduleName, 'view'), async (req, res) => {
    try {
      const rows = await db.prepare(`SELECT * FROM ${table} ORDER BY ${pk} DESC LIMIT 500`).all();
      res.json(rows);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  r.get('/:id', auth(), requirePerm(moduleName, 'view'), async (req, res) => {
    const row = await db.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  });
  r.post('/', auth(), requirePerm(moduleName, 'add'), async (req, res) => {
    try {
      const data = { ...(req.body || {}) };
      delete data[pk];
      const keys = Object.keys(data);
      if (!keys.length) return res.status(400).json({ error: 'Empty body' });
      const info = await db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => data[k]));
      audit(req.auth.userId, moduleName, 'CREATE', table, info.lastInsertRowid, null, data, req);
      if (opts.afterCreate) await opts.afterCreate(info.lastInsertRowid, data, req);
      res.status(201).json({ [pk]: info.lastInsertRowid, ...data });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  r.put('/:id', auth(), requirePerm(moduleName, 'edit'), async (req, res) => {
    try {
      const old = await db.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).get(req.params.id);
      if (!old) return res.status(404).json({ error: 'Not found' });
      const data = { ...(req.body || {}) };
      delete data[pk];
      const keys = Object.keys(data);
      if (opts.beforeUpdate) await opts.beforeUpdate(old, data, req);
      if (keys.length) await db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(',')} WHERE ${pk} = ?`).run(...keys.map((k) => data[k]), req.params.id);
      const cur = await db.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).get(req.params.id);
      audit(req.auth.userId, moduleName, 'UPDATE', table, req.params.id, old, cur, req);
      if (opts.afterUpdate) await opts.afterUpdate(old, cur, req);
      res.json(cur);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  r.delete('/:id', auth(), requirePerm(moduleName, 'delete'), async (req, res) => {
    try {
      const old = await db.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).get(req.params.id);
      if (!old) return res.status(404).json({ error: 'Not found' });
      // Explicit confirmation is enforced client-side; server requires confirm=true.
      if (req.query.confirm !== 'true' && (req.body || {}).confirm !== true)
        return res.status(400).json({ error: 'Confirmation required: resend with confirm=true' });
      await db.prepare(`DELETE FROM ${table} WHERE ${pk} = ?`).run(req.params.id);
      audit(req.auth.userId, moduleName, 'DELETE', table, req.params.id, old, null, req);
      res.json({ deleted: true });
    } catch (e) {
      if (/foreign key/i.test(e.message))
        return res.status(409).json({ error: 'Cannot delete: other records still link to this one. Remove or reassign them first.' });
      res.status(400).json({ error: e.message });
    }
  });
  return r;
}

app.use('/api/organizations', crud('organizations', 'organization_id', 'PROPERTY'));
app.use('/api/properties', crud('properties', 'property_id', 'PROPERTY'));
app.use('/api/buildings', crud('buildings', 'building_id', 'PROPERTY'));
app.use('/api/floors', crud('floors', 'floor_id', 'PROPERTY'));
app.use('/api/units', crud('units', 'unit_id', 'PROPERTY'));
app.use('/api/beds', crud('beds', 'bed_id', 'PROPERTY'));
app.use('/api/tenants', crud('tenants', 'tenant_id', 'TENANT'));
app.use('/api/tenant-documents', crud('tenant_documents', 'tenant_document_id', 'TENANT'));
app.use('/api/rent-plans', crud('rent_plans', 'rent_plan_id', 'RENT'));
app.use('/api/notices', crud('notices', 'notice_id', 'COMPLAINT'));
app.use('/api/users', crud('users', 'user_id', 'PROPERTY'));

// KYC: status updates write tenant_kyc row.
app.get('/api/kyc', auth(), requirePerm('TENANT', 'view'), async (req, res) => {
  res.json(await db.prepare(`SELECT k.*, t.full_name, t.mobile FROM tenant_kyc k JOIN tenants t ON t.tenant_id = k.tenant_id ORDER BY k.kyc_id DESC LIMIT 200`).all());
});
app.put('/api/kyc/:tenantId', auth(), requirePerm('TENANT', 'approve'), async (req, res) => {
  const { status, remarks } = req.body || {};
  const allowed = ['KYC_PENDING','KYC_SUBMITTED','UNDER_VERIFICATION','VERIFIED','REJECTED','EXPIRED'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid KYC status' });
  const old = await db.prepare(`SELECT * FROM tenant_kyc WHERE tenant_id = ? ORDER BY kyc_id DESC`).get(req.params.tenantId);
  await db.prepare(`INSERT INTO tenant_kyc (tenant_id, status, submitted_at, verification_date, verified_by, remarks)
    VALUES (?,?,datetime('now'),datetime('now'),?,?)`).run(req.params.tenantId, status, req.auth.userId, remarks || null);
  audit(req.auth.userId, 'TENANT', 'KYC_' + status, 'tenant_kyc', req.params.tenantId, old, { status, remarks }, req);
  res.json({ tenant_id: Number(req.params.tenantId), status });
});

// Agreements with occupancy transitions + confirm guard.
app.get('/api/agreements', auth(), requirePerm('RENT', 'view'), async (req, res) => {
  res.json(await db.prepare(`SELECT a.*, t.full_name AS tenant_name, p.property_name FROM rental_agreements a
    LEFT JOIN tenants t ON t.tenant_id = a.tenant_id LEFT JOIN properties p ON p.property_id = a.property_id
    ORDER BY a.agreement_id DESC LIMIT 500`).all());
});
app.post('/api/agreements', auth(), requirePerm('RENT', 'add'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.tenant_id || !b.property_id || !b.monthly_rent || !b.start_date || !b.agreement_number)
      return res.status(400).json({ error: 'tenant_id, property_id, monthly_rent, start_date, agreement_number are required' });
    const info = await db.prepare(`INSERT INTO rental_agreements
      (tenant_id, property_id, unit_id, bed_id, rent_plan_id, agreement_number, start_date, end_date, monthly_rent, security_deposit, due_day, lock_in_period_days, notice_period_days, late_fee, utilities, maintenance_terms, other_charges, terms_conditions, status, signed_date)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      b.tenant_id, b.property_id, b.unit_id || null, b.bed_id || null, b.rent_plan_id || null, b.agreement_number,
      b.start_date, b.end_date || null, b.monthly_rent, b.security_deposit || 0, b.due_day || 5,
      b.lock_in_period_days || null, b.notice_period_days || 30, b.late_fee || 0,
      b.utilities || null, b.maintenance_terms || null, b.other_charges || 0, b.terms_conditions || null,
      b.status || 'DRAFT', b.signed_date || null);
    const ag = await db.prepare(`SELECT * FROM rental_agreements WHERE agreement_id = ?`).get(info.lastInsertRowid);
    if (ag.status === 'ACTIVE') await svc.occupyForAgreement(ag);
    audit(req.auth.userId, 'RENT', 'CREATE', 'rental_agreements', info.lastInsertRowid, null, ag, req);
    res.status(201).json(ag);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/agreements/:id', auth(), requirePerm('RENT', 'edit'), async (req, res) => {
  try {
    const old = await db.prepare(`SELECT * FROM rental_agreements WHERE agreement_id = ?`).get(req.params.id);
    if (!old) return res.status(404).json({ error: 'Not found' });
    if (['TERMINATED','EXPIRED'].includes(req.body.status) && req.body.confirm !== true && req.query.confirm !== 'true')
      return res.status(400).json({ error: 'Terminating an agreement requires confirm=true' });
    const b = { ...old, ...(req.body || {}) };
    delete b.confirm;
    await db.prepare(`UPDATE rental_agreements SET tenant_id=?, property_id=?, unit_id=?, bed_id=?, rent_plan_id=?, agreement_number=?,
      start_date=?, end_date=?, monthly_rent=?, security_deposit=?, due_day=?, lock_in_period_days=?, notice_period_days=?,
      late_fee=?, utilities=?, maintenance_terms=?, other_charges=?, terms_conditions=?, status=?, signed_date=? WHERE agreement_id=?`)
      .run(b.tenant_id, b.property_id, b.unit_id, b.bed_id, b.rent_plan_id, b.agreement_number, b.start_date, b.end_date,
        b.monthly_rent, b.security_deposit, b.due_day, b.lock_in_period_days, b.notice_period_days, b.late_fee,
        b.utilities, b.maintenance_terms, b.other_charges, b.terms_conditions, b.status, b.signed_date, req.params.id);
    const cur = await db.prepare(`SELECT * FROM rental_agreements WHERE agreement_id = ?`).get(req.params.id);
    // Trigger equivalents:
    if (old.status !== 'ACTIVE' && cur.status === 'ACTIVE') await svc.occupyForAgreement(cur);
    if (old.status === 'ACTIVE' && ['TERMINATED','EXPIRED'].includes(cur.status)) await svc.releaseForAgreement(cur);
    audit(req.auth.userId, 'RENT', 'UPDATE', 'rental_agreements', req.params.id, old, cur, req);
    res.json(cur);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Invoices / payments / receipts
app.get('/api/invoices', auth(), requirePerm('RENT', 'view'), async (req, res) => {
  res.json(await db.prepare(`SELECT i.*, t.full_name AS tenant_name FROM rent_invoices i
    LEFT JOIN tenants t ON t.tenant_id = i.tenant_id ORDER BY i.invoice_id DESC LIMIT 500`).all());
});
app.get('/api/invoices/:id', auth(), requirePerm('RENT', 'view'), async (req, res) => {
  const inv = await db.prepare(`SELECT * FROM rent_invoices WHERE invoice_id = ?`).get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  inv.items = await db.prepare(`SELECT * FROM invoice_items WHERE invoice_id = ?`).all(req.params.id);
  inv.payments = await db.prepare(`SELECT * FROM payments WHERE invoice_id = ?`).all(req.params.id);
  inv.receipts = await db.prepare(`SELECT r.* FROM receipts r JOIN payments p ON p.payment_id = r.payment_id WHERE p.invoice_id = ?`).all(req.params.id);
  res.json(inv);
});
app.post('/api/jobs/generate-rent', auth(), requirePerm('RENT', 'add'), async (req, res) => {
  const { month } = req.body || {};
  if (!month) return res.status(400).json({ error: 'month (YYYY-MM-01) required' });
  try {
    const out = await svc.generateMonthlyRent(month);
    audit(req.auth.userId, 'RENT', 'GENERATE_MONTHLY', 'rent_invoices', null, null, out, req);
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/jobs/mark-overdue', auth(), requirePerm('RENT', 'edit'), async (req, res) => {
  const out = await svc.markOverdueInvoices();
  audit(req.auth.userId, 'RENT', 'MARK_OVERDUE', 'rent_invoices', null, null, out, req);
  res.json(out);
});
app.post('/api/payments', auth(), requirePerm('PAYMENT', 'add'), async (req, res) => {
  const { invoice_id, amount, payment_mode, payment_reference, confirm } = req.body || {};
  if (confirm !== true) return res.status(400).json({ error: 'Recording a payment requires confirm=true' });
  try {
    const out = await svc.recordPayment(Number(invoice_id), Number(amount), payment_mode, payment_reference);
    audit(req.auth.userId, 'PAYMENT', 'RECORD', 'payments', out.paymentId, null, req.body, req);
    res.status(201).json(out);
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.get('/api/payments', auth(), requirePerm('PAYMENT', 'view'), async (req, res) => {
  res.json(await db.prepare(`SELECT p.*, t.full_name AS tenant_name FROM payments p LEFT JOIN tenants t ON t.tenant_id = p.tenant_id ORDER BY p.payment_id DESC LIMIT 500`).all());
});
app.get('/api/receipts', auth(), requirePerm('PAYMENT', 'view'), async (req, res) => {
  res.json(await db.prepare(`SELECT r.*, p.invoice_id, t.full_name AS tenant_name FROM receipts r
    JOIN payments p ON p.payment_id = r.payment_id LEFT JOIN tenants t ON t.tenant_id = p.tenant_id ORDER BY r.receipt_id DESC LIMIT 500`).all());
});
app.get('/api/statements/:tenantId', auth(), requirePerm('RENT', 'view'), async (req, res) => {
  const { from = '2000-01-01', to = '2100-01-01' } = req.query;
  res.json(await svc.tenantStatement(req.params.tenantId, from, to));
});

// Complaints (admin side)
app.get('/api/complaints', auth(), requirePerm('COMPLAINT', 'view'), async (req, res) => {
  res.json(await db.prepare(`SELECT c.*, t.full_name AS tenant_name, p.property_name,
      (SELECT COUNT(*) FROM documents d WHERE d.entity_type = 'complaint' AND d.entity_id = c.complaint_id) AS files
    FROM complaints c
    LEFT JOIN tenants t ON t.tenant_id = c.tenant_id LEFT JOIN properties p ON p.property_id = c.property_id
    ORDER BY c.complaint_id DESC LIMIT 500`).all());
});
app.get('/api/complaints/:id', auth(), requirePerm('COMPLAINT', 'view'), async (req, res) => {
  const c = await db.prepare(`SELECT * FROM complaints WHERE complaint_id = ?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  c.attachments = await db.prepare(`SELECT * FROM documents WHERE entity_type = 'complaint' AND entity_id = ?`).all(req.params.id);
  res.json(c);
});
app.post('/api/complaints', auth(), async (req, res) => {
  // Tenant token OR staff with COMPLAINT add.
  const b = req.body || {};
  const tenantId = req.auth.kind === 'tenant' ? req.auth.tenantId : b.tenant_id;
  if (!tenantId || !b.property_id || !b.category || !b.title) return res.status(400).json({ error: 'tenant, property, category, title required' });
  try {
    const n = `CMP-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(Date.now()).slice(-5)}`;
    const info = await db.prepare(`INSERT INTO complaints (tenant_id, property_id, unit_id, complaint_number, category, title, description, priority, status)
      VALUES (?,?,?,?,?,?,?,?,'OPEN')`).run(tenantId, b.property_id, b.unit_id || null, n, b.category, b.title, b.description || null, b.priority || 'MEDIUM');
    // Photo/video attachments live in documents, linked to the complaint.
    const paths = [b.attachment_path, ...(b.attachment_paths || [])].filter(Boolean);
    const actorId = req.auth.kind === 'tenant' ? null : (req.auth.userId || null);
    for (const p of paths) {
      await db.prepare(`INSERT INTO documents (document_type, entity_type, entity_id, file_name, file_path, uploaded_by)
        VALUES ('COMPLAINT_PHOTO','complaint',?,?,?,?)`).run(info.lastInsertRowid, String(p).split('/').pop(), p, actorId);
    }
    audit(req.auth.userId || null, 'COMPLAINT', 'CREATE', 'complaints', info.lastInsertRowid, null, b, req);
    res.status(201).json({ complaint_id: info.lastInsertRowid, complaint_number: n });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
const COMPLAINT_FLOW = ['OPEN','ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED'];
app.put('/api/complaints/:id', auth(), requirePerm('COMPLAINT', 'edit'), async (req, res) => {
  const old = await db.prepare(`SELECT * FROM complaints WHERE complaint_id = ?`).get(req.params.id);
  if (!old) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const next = b.status || old.status;
  if (next !== old.status) {
    const oi = COMPLAINT_FLOW.indexOf(old.status), ni = COMPLAINT_FLOW.indexOf(next);
    if (ni < oi) return res.status(400).json({ error: `Invalid transition ${old.status} to ${next}` });
  }
  await db.prepare(`UPDATE complaints SET category=?, title=?, description=?, priority=?, status=?, assigned_to=?,
    assigned_at = CASE WHEN ? = 'ASSIGNED' THEN datetime('now') ELSE assigned_at END,
    resolved_at = CASE WHEN ? = 'RESOLVED' THEN datetime('now') ELSE resolved_at END,
    closed_at = CASE WHEN ? = 'CLOSED' THEN datetime('now') ELSE closed_at END,
    tenant_confirmation = ? WHERE complaint_id = ?`)
    .run(b.category || old.category, b.title || old.title, b.description != null ? b.description : old.description,
      b.priority || old.priority, next, b.assigned_to != null ? b.assigned_to : old.assigned_to,
      next, next, next, b.tenant_confirmation != null ? (b.tenant_confirmation ? 1 : 0) : old.tenant_confirmation, req.params.id);
  const cur = await db.prepare(`SELECT * FROM complaints WHERE complaint_id = ?`).get(req.params.id);
  audit(req.auth.userId, 'COMPLAINT', 'UPDATE', 'complaints', req.params.id, old, cur, req);
  res.json(cur);
});

// ---------- file uploads (stored as blobs, so they sync with the database) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'video/mp4'];
    if (okTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, WEBP, PDF or MP4 files are accepted'));
  },
});
app.post('/api/uploads', auth(), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const actor = req.auth.kind === 'tenant' ? `tenant:${req.auth.tenantId}` : `user:${req.auth.userId}`;
    const info = await db.prepare(`INSERT INTO file_blobs (file_name, mime_type, file_size, data, uploaded_by)
      VALUES (?,?,?,?,?)`).run(req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer, actor);
    audit(req.auth.userId || null, 'DOCUMENT', 'UPLOAD', 'file_blobs', info.lastInsertRowid,
      null, { file: req.file.originalname, bytes: req.file.size, by: actor }, req);
    res.status(201).json({ file_path: '/files/' + info.lastInsertRowid, file_name: req.file.originalname, mime_type: req.file.mimetype, file_size: req.file.size });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/files/:id', fileAuth, async (req, res) => {
  const f = await db.prepare(`SELECT * FROM file_blobs WHERE file_id = ?`).get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Not found' });
  res.set('Content-Type', f.mime_type);
  res.set('Content-Length', f.file_size);
  res.set('Content-Disposition', `inline; filename="${String(f.file_name).replace(/"/g, '')}"`);
  res.send(Buffer.from(f.data));
});

// Notifications + audit + dashboard
app.get('/api/notifications', auth(), async (req, res) => {
  if (req.auth.kind === 'tenant') {
    return res.json(await db.prepare(`SELECT * FROM notifications WHERE tenant_id = ? ORDER BY notification_id DESC LIMIT 200`).all(req.auth.tenantId));
  }
  res.json(await db.prepare(`SELECT * FROM notifications ORDER BY notification_id DESC LIMIT 200`).all());
});
app.get('/api/audit-logs', auth(), requirePerm('REPORTS', 'view'), async (req, res) => {
  res.json(await db.prepare(`SELECT * FROM audit_logs ORDER BY audit_id DESC LIMIT 300`).all());
});
app.get('/api/permissions/me', auth(), async (req, res) => {
  if (req.auth.kind === 'tenant') return res.json({ role: 'TENANT', permissions: [] });
  const rows = await db.prepare(`SELECT p.module_name, p.permission_name, rp.can_view, rp.can_add, rp.can_edit, rp.can_delete, rp.can_approve
    FROM role_permissions rp JOIN permissions p ON p.permission_id = rp.permission_id WHERE rp.role_id = ?`).all(req.auth.roleId);
  res.json({ role: await roleName(req.auth.roleId), permissions: rows });
});
app.get('/api/dashboard/summary', auth(), requirePerm('REPORTS', 'view'), async (req, res) => {
  const units = await db.prepare(`SELECT status, COUNT(*) AS c FROM units GROUP BY status`).all();
  const by = Object.fromEntries(units.map((u) => [u.status, u.c]));
  const totalUnits = units.reduce((s, u) => s + Number(u.c), 0);
  const fin = await db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS expected, COALESCE(SUM(paid_amount),0) AS collected,
    COALESCE(SUM(outstanding_amount),0) AS outstanding FROM rent_invoices WHERE substr(invoice_month,1,7) = substr(date('now'),1,7)`).get();
  const overdue = await db.prepare(`SELECT COALESCE(SUM(outstanding_amount),0) AS overdue, COUNT(*) AS n FROM rent_invoices WHERE status = 'OVERDUE'`).get();
  const perProp = await db.prepare(`SELECT p.property_id, p.property_name, COUNT(DISTINCT u.unit_id) AS units,
      COALESCE(SUM(CASE WHEN u.status IN ('OCCUPIED','PARTIALLY_OCCUPIED') THEN 1 ELSE 0 END),0) AS occupied,
      COALESCE(SUM(i.total_amount),0) AS invoiced, COALESCE(SUM(i.paid_amount),0) AS collected,
      COALESCE(SUM(i.outstanding_amount),0) AS outstanding
    FROM properties p LEFT JOIN buildings b ON b.property_id = p.property_id
    LEFT JOIN floors f ON f.building_id = b.building_id LEFT JOIN units u ON u.floor_id = f.floor_id
    LEFT JOIN rental_agreements a ON a.property_id = p.property_id LEFT JOIN rent_invoices i ON i.agreement_id = a.agreement_id
    GROUP BY p.property_id, p.property_name`).all();
  res.json({ units: { total: totalUnits, ...by }, finance: { ...fin, ...overdue }, perProperty: perProp });
});

// ---------- tenant self-service ----------
const tAuth = auth();
function needTenant(req, res, next) {
  if (!req.auth || req.auth.kind !== 'tenant') return res.status(403).json({ error: 'Tenant login required' });
  next();
}
app.get('/api/tenant/me', tAuth, needTenant, async (req, res) => {
  const t = await db.prepare(`SELECT * FROM tenants WHERE tenant_id = ?`).get(req.auth.tenantId);
  const ag = await db.prepare(`SELECT a.*, p.property_name, u.unit_number, b.bed_number FROM rental_agreements a
    LEFT JOIN properties p ON p.property_id = a.property_id LEFT JOIN units u ON u.unit_id = a.unit_id
    LEFT JOIN beds b ON b.bed_id = a.bed_id WHERE a.tenant_id = ? AND a.status = 'ACTIVE' ORDER BY a.agreement_id DESC LIMIT 1`).get(req.auth.tenantId);
  const dues = await db.prepare(`SELECT COALESCE(SUM(outstanding_amount),0) AS outstanding, COALESCE(SUM(CASE WHEN status='OVERDUE' THEN outstanding_amount ELSE 0 END),0) AS overdue
    FROM rent_invoices WHERE tenant_id = ? AND outstanding_amount > 0`).get(req.auth.tenantId);
  res.json({ tenant: t, agreement: ag || null, dues });
});
app.get('/api/tenant/invoices', tAuth, needTenant, async (req, res) => {
  res.json(await db.prepare(`SELECT * FROM rent_invoices WHERE tenant_id = ? ORDER BY invoice_id DESC`).all(req.auth.tenantId));
});
app.get('/api/tenant/payments', tAuth, needTenant, async (req, res) => {
  res.json(await db.prepare(`SELECT p.*, r.receipt_number, r.receipt_id FROM payments p LEFT JOIN receipts r ON r.payment_id = p.payment_id
    WHERE p.tenant_id = ? ORDER BY p.payment_id DESC`).all(req.auth.tenantId));
});
app.get('/api/tenant/documents', tAuth, needTenant, async (req, res) => {
  const docs = await db.prepare(`SELECT * FROM tenant_documents WHERE tenant_id = ?`).all(req.auth.tenantId);
  const kyc = await db.prepare(`SELECT * FROM tenant_kyc WHERE tenant_id = ? ORDER BY kyc_id DESC LIMIT 1`).get(req.auth.tenantId);
  const agr = await db.prepare(`SELECT agreement_id, agreement_number, status, start_date, end_date FROM rental_agreements WHERE tenant_id = ?`).all(req.auth.tenantId);
  res.json({ documents: docs, kyc: kyc || null, agreements: agr });
});
app.post('/api/tenant/documents', tAuth, needTenant, async (req, res) => {
  const { document_type, document_number, file_path } = req.body || {};
  const allowed = ['AADHAAR','PAN','PASSPORT','DRIVING_LICENSE','ADDRESS_PROOF','EMPLOYMENT_PROOF','PHOTO','OTHER'];
  if (!allowed.includes(document_type) || !file_path) return res.status(400).json({ error: 'document_type and file_path (from /api/uploads) are required' });
  try {
    const info = await db.prepare(`INSERT INTO tenant_documents (tenant_id, document_type, document_number, file_path, verification_status)
      VALUES (?,?,?,?,'PENDING')`).run(req.auth.tenantId, document_type, document_number || null, file_path);
    audit(null, 'TENANT', 'DOC_UPLOAD', 'tenant_documents', info.lastInsertRowid, null, req.body, req);
    res.status(201).json({ tenant_document_id: info.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/tenant/statement', tAuth, needTenant, async (req, res) => {
  const { from = '2000-01-01', to = '2100-01-01' } = req.query;
  res.json(await svc.tenantStatement(req.auth.tenantId, from, to));
});
async function receiptDetail(receiptId) {
  const r = await db.prepare(`SELECT * FROM receipts WHERE receipt_id = ?`).get(receiptId);
  if (!r) return null;
  const p = await db.prepare(`SELECT * FROM payments WHERE payment_id = ?`).get(r.payment_id);
  const inv = p ? await db.prepare(`SELECT * FROM rent_invoices WHERE invoice_id = ?`).get(p.invoice_id) : null;
  const tenant = p ? await db.prepare(`SELECT * FROM tenants WHERE tenant_id = ?`).get(p.tenant_id) : null;
  const ag = inv ? await db.prepare(`SELECT * FROM rental_agreements WHERE agreement_id = ?`).get(inv.agreement_id) : null;
  const prop = ag ? await db.prepare(`SELECT * FROM properties WHERE property_id = ?`).get(ag.property_id) : null;
  const org = prop ? await db.prepare(`SELECT * FROM organizations WHERE organization_id = ?`).get(prop.organization_id) : null;
  return { receipt: r, payment: p, invoice: inv, tenant, agreement: ag, property: prop, organization: org };
}
app.get('/api/receipts/:id', auth(), requirePerm('PAYMENT', 'view'), async (req, res) => {
  const d = await receiptDetail(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json(d);
});
app.get('/api/tenant/receipts/:id', tAuth, needTenant, async (req, res) => {
  const d = await receiptDetail(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (!d.payment || d.payment.tenant_id !== req.auth.tenantId) return res.status(403).json({ error: 'Not your receipt' });
  res.json(d);
});

// ---------- scheduler (cron, runs even with no admin logged in) ----------
cron.schedule('0 1 1 * *', async () => {
  try {
    const first = new Date(); first.setDate(1);
    const m = first.toISOString().slice(0, 10);
    console.log('[CRON] monthly rent generation for', m, await svc.generateMonthlyRent(m));
  } catch (e) { console.error('[CRON] rent gen failed', e.message); }
});
cron.schedule('0 2 * * *', async () => {
  try { console.log('[CRON] overdue marking', await svc.markOverdueInvoices()); }
  catch (e) { console.error('[CRON] overdue failed', e.message); }
});

// Last-resort guards: no single request may ever take the process down.
// (Express 4 does not forward async errors by itself.)
process.on('unhandledRejection', (e) => console.error('[guard] unhandled rejection, server stays up:', e && e.message));
process.on('uncaughtException', (e) => console.error('[guard] uncaught exception, server stays up:', e && e.message));
app.use((err, req, res, next) => {
  console.error('[api] error:', err && err.message);
  res.status(500).json({ error: 'Internal error' });
});

// Serve frontend build if present
const path = require('path');
const fs = require('fs');
const dist = path.join(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|files).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  app.get('/', (req, res) => res.json({ ok: true, service: 'prm-backend', hint: 'Run frontend dev server on :5173' }));
}

async function main() {
  await db.ready;
  await seed();
  app.listen(PORT, () => console.log(`Backend listening on http://localhost:${PORT}`));
}
if (require.main === module) {
  main().catch((e) => { console.error('startup failed:', e.message); process.exit(1); });
}
module.exports = app;
