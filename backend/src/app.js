const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const seed = require('./seed');
const svc = require('./services');
const events = require('./events');

const app = express();

// Security Headers (production hardened)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// High-performance sliding-window in-memory rate limiter for API protection
const rateLimitMap = new Map();
function rateLimiter(windowMs = 60000, maxRequests = 2000) {
  return (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const now = Date.now();
    let entry = rateLimitMap.get(ip);
    if (!entry || now - entry.resetTime > windowMs) {
      entry = { count: 1, resetTime: now };
      rateLimitMap.set(ip, entry);
    } else {
      entry.count++;
      if (entry.count > maxRequests) {
        return res.status(429).json({ error: 'Too many requests. Please slow down.' });
      }
    }
    next();
  };
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(rateLimiter(60000, 3000));

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET must be set when NODE_ENV=production. Refusing to start.');
  process.exit(1);
}
const PORT = process.env.PORT || 4000;

// File upload handler
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'video/mp4'];
    if (okTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, WEBP, PDF or MP4 files are accepted'));
  },
});

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
      const isAllowedTenantEndpoint = req.originalUrl.startsWith('/api/tenant') ||
        (req.originalUrl.startsWith('/api/complaints') && ['GET', 'POST'].includes(req.method));
      if (!isAllowedTenantEndpoint) {
        return res.status(403).json({ error: 'Forbidden: Tenants are restricted to tenant routes' });
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

app.post('/api/auth/tenant/request-otp', async (req, res) => {
  const { mobile } = req.body || {};
  if (!/^\d{10}$/.test(String(mobile || ''))) return res.status(400).json({ error: 'Enter a 10 digit mobile number.' });
  const t = await db.prepare(`SELECT * FROM tenants WHERE mobile = ?`).get(mobile);
  if (!t) return res.status(404).json({ error: 'Tenant mobile not registered. Please register first.', notRegistered: true });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const smsReady = Boolean(process.env.SMS_WEBHOOK_URL)
    || (String(process.env.BREVO_API_KEY || '').trim() && String(process.env.BREVO_SMS_SENDER || '').trim());
  if (!smsReady) {
    await db.prepare(`DELETE FROM tenant_otps WHERE mobile = ? AND consumed = 0`).run(mobile);
    await db.prepare(`INSERT INTO tenant_otps (mobile, otp_code, expires_at) VALUES (?,?,datetime('now','+10 minutes'))`).run(mobile, '8520');
    return res.json({ message: 'SMS not connected. Demo code 8520 is active.', otp: '8520' });
  }
  await db.prepare(`INSERT INTO tenant_otps (mobile, otp_code, expires_at) VALUES (?,?,datetime('now','+10 minutes'))`).run(mobile, code);
  try {
    await events.smsProviders.sendSms(mobile, `Your Rent Ledger login code is ${code}. It expires in 10 minutes.`);
    return res.json({ message: 'OTP sent by SMS.' });
  } catch (e) {
    return res.status(502).json({ error: 'SMS delivery failed (' + e.message + ').' });
  }
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

// Public inventory for prospective/registering tenants
app.get('/api/public/inventory', async (req, res) => {
  try {
    const properties = await db.prepare(`SELECT property_id, property_code, property_name, property_type, address, city, state, pin_code
      FROM properties WHERE status = 'ACTIVE' ORDER BY property_name ASC`).all();
    const units = await db.prepare(`SELECT u.unit_id, u.floor_id, u.unit_number, u.unit_type, u.sharing_type,
        u.monthly_rent, u.security_deposit, u.maintenance_charge, u.status, f.building_id, b.property_id
      FROM units u
      JOIN floors f ON f.floor_id = u.floor_id
      JOIN buildings b ON b.building_id = f.building_id
      WHERE u.status IN ('AVAILABLE', 'PARTIALLY_OCCUPIED')
      ORDER BY u.unit_number ASC`).all();
    const beds = await db.prepare(`SELECT b.bed_id, b.unit_id, b.bed_number, b.bed_type, b.monthly_rent, b.security_deposit, b.status
      FROM beds b
      JOIN units u ON u.unit_id = b.unit_id
      WHERE b.status = 'AVAILABLE'
      ORDER BY b.bed_number ASC`).all();
    res.json({ properties, units, beds });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Unauthenticated upload endpoint specifically for tenant onboarding KYC docs/photos
app.post('/api/auth/tenant/upload-kyc', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const info = await db.prepare(`INSERT INTO file_blobs (file_name, mime_type, file_size, data, uploaded_by)
      VALUES (?,?,?,?, 'onboarding:tenant')`).run(req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer);
    res.status(201).json({
      file_path: '/files/' + info.lastInsertRowid,
      file_name: req.file.originalname,
      mime_type: req.file.mimetype,
      file_size: req.file.size
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Tenant Self-Registration based on property/room chosen
app.post('/api/auth/tenant/register', async (req, res) => {
  const {
    full_name, mobile, email, date_of_birth, gender, address,
    emergency_contact_name, emergency_contact_mobile,
    occupation, company_name, id_type, id_number,
    property_id, unit_id, bed_id, document_path, move_in_date
  } = req.body || {};

  if (!full_name || !String(full_name).trim()) {
    return res.status(400).json({ error: 'Full name is required.' });
  }
  if (!/^\d{10}$/.test(String(mobile || ''))) {
    return res.status(400).json({ error: 'Mobile number must be exactly 10 digits.' });
  }
  if (!property_id || !unit_id) {
    return res.status(400).json({ error: 'Please select a property and room/unit you have taken.' });
  }

  // Check if tenant already exists with an active agreement
  const existing = await db.prepare(`SELECT * FROM tenants WHERE mobile = ?`).get(mobile);
  if (existing) {
    const liveAgreement = await db.prepare(`SELECT agreement_id FROM rental_agreements WHERE tenant_id = ? AND status = 'ACTIVE'`).get(existing.tenant_id);
    if (liveAgreement) {
      return res.status(409).json({ error: 'A tenant with this mobile number is already registered with an active agreement. Please sign in via OTP.' });
    }
  }

  const prop = await db.prepare(`SELECT * FROM properties WHERE property_id = ?`).get(property_id);
  if (!prop) return res.status(404).json({ error: 'Selected property not found.' });

  const unit = await db.prepare(`SELECT * FROM units WHERE unit_id = ?`).get(unit_id);
  if (!unit) return res.status(404).json({ error: 'Selected room/unit not found.' });

  const monthlyRent = Number(unit.monthly_rent || 0);
  const securityDeposit = Number(unit.security_deposit || 0);
  const startDate = move_in_date || new Date().toISOString().slice(0, 10);

  const txn = db.transaction(async (tdb) => {
    let tenantId;
    if (existing) {
      tenantId = existing.tenant_id;
      await tdb.prepare(`UPDATE tenants SET full_name=?, email=?, date_of_birth=?, gender=?, address=?,
        emergency_contact_name=?, emergency_contact_mobile=?, occupation=?, company_name=?, id_type=?, id_number=?, status='ACTIVE', updated_at=datetime('now')
        WHERE tenant_id=?`).run(
        full_name, email || null, date_of_birth || null, gender || null, address || null,
        emergency_contact_name || null, emergency_contact_mobile || null,
        occupation || null, company_name || null, id_type || 'AADHAAR', id_number || null, tenantId);
    } else {
      const tInfo = await tdb.prepare(`INSERT INTO tenants
        (full_name, mobile, email, date_of_birth, gender, address, emergency_contact_name, emergency_contact_mobile, occupation, company_name, id_type, id_number, status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'ACTIVE')`).run(
        full_name, mobile, email || null, date_of_birth || null, gender || null, address || null,
        emergency_contact_name || null, emergency_contact_mobile || null,
        occupation || null, company_name || null, id_type || 'AADHAAR', id_number || null);
      tenantId = tInfo.lastInsertRowid;
    }

    // Record / Update KYC entry as KYC_SUBMITTED
    await tdb.prepare(`DELETE FROM tenant_kyc WHERE tenant_id = ?`).run(tenantId);
    await tdb.prepare(`INSERT INTO tenant_kyc (tenant_id, status, submitted_at, remarks)
      VALUES (?, 'KYC_SUBMITTED', datetime('now'), 'Self-registered and documents submitted via Tenant Mobile App')`).run(tenantId);

    // Save uploaded KYC document if provided
    if (document_path) {
      await tdb.prepare(`INSERT INTO tenant_documents (tenant_id, document_type, document_number, file_path, verification_status)
        VALUES (?,?,?,?,'PENDING')`).run(tenantId, id_type || 'AADHAAR', id_number || null, document_path);
    }

    // Create rental agreement
    const agreementNumber = `AGR-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
    const agInfo = await tdb.prepare(`INSERT INTO rental_agreements
      (tenant_id, property_id, unit_id, bed_id, agreement_number, start_date, monthly_rent, security_deposit, due_day, status, signed_date)
      VALUES (?,?,?,?,?,?,?,?,5, 'ACTIVE', datetime('now'))`).run(
      tenantId, property_id, unit_id, bed_id || null, agreementNumber, startDate, monthlyRent, securityDeposit);
    const agreementId = agInfo.lastInsertRowid;

    // Create linked security deposit record
    if (securityDeposit > 0) {
      await tdb.prepare(`INSERT INTO security_deposits (tenant_id, agreement_id, deposit_amount, received_amount, status, received_date, remarks)
        VALUES (?,?,?,?,'HELD',?, 'Deposit registered at onboarding')`).run(
        tenantId, agreementId, securityDeposit, securityDeposit, startDate);
    }

    // Occupy bed / unit
    if (bed_id) {
      await tdb.prepare(`UPDATE beds SET status = 'OCCUPIED' WHERE bed_id = ?`).run(bed_id);
    }
    const availBeds = await tdb.prepare(`SELECT COUNT(*) AS c FROM beds WHERE unit_id = ? AND status = 'AVAILABLE'`).get(unit_id);
    const unitStatus = Number(availBeds.c) > 0 ? 'PARTIALLY_OCCUPIED' : 'OCCUPIED';
    await tdb.prepare(`UPDATE units SET status = ?, updated_at = datetime('now') WHERE unit_id = ?`).run(unitStatus, unit_id);

    return { tenantId, agreementId, agreementNumber };
  });

  try {
    const out = await txn();
    const token = signToken({ kind: 'tenant', tenantId: out.tenantId, role: 'TENANT' });
    audit(null, 'TENANT', 'SELF_REGISTER', 'tenants', out.tenantId, null, { mobile, full_name, property_id, unit_id }, req);

    events.dispatch({
      eventCode: 'TENANT_REGISTERED',
      tenantId: out.tenantId,
      vars: {
        tenant_name: full_name,
        property_name: prop.property_name,
        room_number: unit.unit_number,
        mobile,
        email: email || null
      }
    }).catch(() => {});

    res.status(201).json({
      token,
      tenant: { tenant_id: out.tenantId, full_name, mobile, email },
      agreement: { agreement_id: out.agreementId, agreement_number: out.agreementNumber },
      message: 'Registration successful! Welcome to your new home. Your KYC is under review.'
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- generic CRUD helper with query filtering ----------
function crud(table, pk, moduleName, opts = {}) {
  const r = express.Router();
  r.get('/', auth(), requirePerm(moduleName, 'view'), async (req, res) => {
    try {
      let sql = `SELECT * FROM ${table}`;
      const wheres = [];
      const args = [];
      for (const [k, v] of Object.entries(req.query || {})) {
        if (['limit', 'offset', 'confirm', 'token'].includes(k)) continue;
        if (v !== undefined && v !== null && v !== '') {
          wheres.push(`${k} = ?`);
          args.push(v);
        }
      }
      if (wheres.length) sql += ' WHERE ' + wheres.join(' AND ');
      sql += ` ORDER BY ${pk} DESC LIMIT 500`;
      const rows = await db.prepare(sql).all(...args);
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
      if ((table === 'tenants' || table === 'users') && data.mobile !== undefined && data.mobile !== null && data.mobile !== '') {
        if (!/^\d{10}$/.test(String(data.mobile))) return res.status(400).json({ error: 'Mobile must be exactly 10 digits.' });
      }
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
      if ((table === 'tenants' || table === 'users') && data.mobile !== undefined && data.mobile !== null && data.mobile !== '') {
        if (!/^\d{10}$/.test(String(data.mobile))) return res.status(400).json({ error: 'Mobile must be exactly 10 digits.' });
      }
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
      if (req.query.confirm !== 'true' && (req.body || {}).confirm !== true)
        return res.status(400).json({ error: 'Confirmation required: resend with confirm=true' });
      if (opts.onDelete) return opts.onDelete(req, res, old);
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

// Core entities
app.use('/api/organizations', crud('organizations', 'organization_id', 'PROPERTY'));
app.use('/api/properties', crud('properties', 'property_id', 'PROPERTY'));
app.use('/api/buildings', crud('buildings', 'building_id', 'PROPERTY'));
app.use('/api/floors', crud('floors', 'floor_id', 'PROPERTY'));
app.use('/api/units', crud('units', 'unit_id', 'PROPERTY'));
app.use('/api/beds', crud('beds', 'bed_id', 'PROPERTY'));
app.use('/api/tenants', crud('tenants', 'tenant_id', 'TENANT', {
  onDelete: async (req, res, old) => {
    const tid = req.params.id;
    const active = await db.prepare(`SELECT agreement_id FROM rental_agreements WHERE tenant_id = ? AND status = 'ACTIVE' LIMIT 1`).get(tid);
    if (active) return res.status(409).json({ error: 'Cannot delete: tenant has an active agreement. Terminate it first.' });
    const due = await db.prepare(`SELECT COALESCE(SUM(outstanding_amount),0) AS d FROM rent_invoices WHERE tenant_id = ?`).get(tid);
    if (Number(due.d) > 0.005) return res.status(409).json({ error: 'Cannot delete: tenant still owes ' + due.d + '. Settle dues first.' });
    try {
      const wipe = db.transaction(async (tdb) => {
        const step = async (name, sql, ...args) => {
          try { await tdb.prepare(sql).run(...args); }
          catch (e) { throw Object.assign(new Error(`delete failed at step [${name}]: ${e.message}`), { step: name }); }
        };
        const payIds = (await tdb.prepare(`SELECT payment_id FROM payments WHERE tenant_id = ?`).all(tid)).map((p) => p.payment_id);
        const invIds = (await tdb.prepare(`SELECT invoice_id FROM rent_invoices WHERE tenant_id = ?`).all(tid)).map((i) => i.invoice_id);
        const compIds = (await tdb.prepare(`SELECT complaint_id FROM complaints WHERE tenant_id = ?`).all(tid)).map((c) => c.complaint_id);
        if (payIds.length) {
          const ph = payIds.map(() => '?').join(',');
          await step('payment_transactions', `DELETE FROM payment_transactions WHERE payment_id IN (${ph})`, ...payIds);
          await step('receipts', `DELETE FROM receipts WHERE payment_id IN (${ph})`, ...payIds);
          await step('payment_proofs', `DELETE FROM documents WHERE entity_type = 'payment' AND entity_id IN (${ph})`, ...payIds);
          await step('payments', `DELETE FROM payments WHERE payment_id IN (${ph})`, ...payIds);
        }
        if (invIds.length) {
          const ih = invIds.map(() => '?').join(',');
          await step('invoice_items', `DELETE FROM invoice_items WHERE invoice_id IN (${ih})`, ...invIds);
          await step('rent_invoices', `DELETE FROM rent_invoices WHERE invoice_id IN (${ih})`, ...invIds);
        }
        if (compIds.length) {
          const ch = compIds.map(() => '?').join(',');
          await step('maintenance_tasks', `DELETE FROM maintenance_tasks WHERE complaint_id IN (${ch})`, ...compIds);
          await step('complaint_docs', `DELETE FROM documents WHERE entity_type = 'complaint' AND entity_id IN (${ch})`, ...compIds);
          await step('complaints', `DELETE FROM complaints WHERE complaint_id IN (${ch})`, ...compIds);
        }
        await step('security_deposits', `DELETE FROM security_deposits WHERE tenant_id = ?`, tid);
        await step('tenant_documents', `DELETE FROM tenant_documents WHERE tenant_id = ?`, tid);
        await step('tenant_kyc', `DELETE FROM tenant_kyc WHERE tenant_id = ?`, tid);
        await step('sms_logs', `DELETE FROM sms_logs WHERE notification_id IN (SELECT notification_id FROM notifications WHERE tenant_id = ?)`, tid);
        await step('whatsapp_logs', `DELETE FROM whatsapp_logs WHERE notification_id IN (SELECT notification_id FROM notifications WHERE tenant_id = ?)`, tid);
        await step('email_logs', `DELETE FROM email_logs WHERE notification_id IN (SELECT notification_id FROM notifications WHERE tenant_id = ?)`, tid);
        await step('notifications', `DELETE FROM notifications WHERE tenant_id = ?`, tid);
        await step('notices', `DELETE FROM notices WHERE tenant_id = ?`, tid);
        await step('tenant_otps', `DELETE FROM tenant_otps WHERE mobile = ?`, old.mobile);
        await step('rental_agreements', `DELETE FROM rental_agreements WHERE tenant_id = ?`, tid);
        await step('tenants', `DELETE FROM tenants WHERE tenant_id = ?`, tid);
        if (old.user_id) await step('users', `DELETE FROM users WHERE user_id = ?`, old.user_id);
      });
      await wipe();
      audit(req.auth.userId, 'TENANT', 'DELETE', 'tenants', tid, old, null, req);
      res.json({ deleted: true });
    } catch (e) {
      if (/foreign key/i.test(e.message) && !e.step)
        return res.status(409).json({ error: 'Cannot delete: other records still link to this one. Remove or reassign them first.' });
      res.status(400).json({ error: e.message });
    }
  },
}));
app.use('/api/tenant-documents', crud('tenant_documents', 'tenant_document_id', 'TENANT'));
app.use('/api/rent-plans', crud('rent_plans', 'rent_plan_id', 'RENT'));
app.use('/api/notices', crud('notices', 'notice_id', 'COMPLAINT'));
app.use('/api/users', crud('users', 'user_id', 'PROPERTY'));

// SRS Phase 4 - 6 entities: Expenses, Vendors, Taxes, GST, Deposits, Maintenance Tasks, Documents
app.use('/api/expenses', crud('expenses', 'expense_id', 'EXPENSE', {
  afterCreate: async (id, data, req) => {
    const isCash = String(data.payment_mode).toUpperCase() === 'CASH';
    await svc.recordJournalEntry(db, {
      debitCode: '5007', debitName: 'Operating Expenses', debitType: 'EXPENSE',
      creditCode: isCash ? '1001' : '1002', creditName: isCash ? 'Cash on Hand' : 'Bank Account', creditType: 'ASSET',
      amount: Number(data.amount), date: data.expense_date, refType: 'EXPENSE', refId: id,
      desc: `Expense #${id}: ${data.remarks || 'Property Expense'}`, userId: req.auth.userId
    });
  }
}));
app.use('/api/expense-categories', crud('expense_categories', 'category_id', 'EXPENSE'));
app.use('/api/vendors', crud('vendors', 'vendor_id', 'VENDOR'));
app.use('/api/property-taxes', crud('property_taxes', 'property_tax_id', 'TAX'));
app.use('/api/gst-settings', crud('gst_settings', 'gst_setting_id', 'GST'));
app.use('/api/security-deposits', crud('security_deposits', 'deposit_id', 'DEPOSIT'));
app.use('/api/maintenance-tasks', crud('maintenance_tasks', 'task_id', 'MAINTENANCE'));
app.use('/api/documents', crud('documents', 'document_id', 'DOCUMENT'));

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
    // Auto-create initial security deposit record if deposit > 0
    if (Number(b.security_deposit) > 0) {
      await db.prepare(`INSERT INTO security_deposits (tenant_id, agreement_id, deposit_amount, received_amount, status, received_date)
        VALUES (?,?,?,?,'RECEIVED',?)`).run(b.tenant_id, info.lastInsertRowid, Number(b.security_deposit), Number(b.security_deposit), b.start_date);
    }
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
    if (old.status !== 'ACTIVE' && cur.status === 'ACTIVE') await svc.occupyForAgreement(cur);
    if (old.status === 'ACTIVE' && ['TERMINATED','EXPIRED'].includes(cur.status)) await svc.releaseForAgreement(cur);
    audit(req.auth.userId, 'RENT', 'UPDATE', 'rental_agreements', req.params.id, old, cur, req);
    res.json(cur);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Section 30: Move-Out Workflow & Settlement
app.post('/api/agreements/:id/move-out', auth(), requirePerm('RENT', 'edit'), async (req, res) => {
  try {
    const out = await svc.moveOutAgreement(req.params.id, req.body, req.auth.userId);
    audit(req.auth.userId, 'RENT', 'MOVE_OUT', 'rental_agreements', req.params.id, null, out, req);
    res.json(out);
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// Section 29: Security Deposit Refund
app.post('/api/security-deposits/:id/refund', auth(), requirePerm('DEPOSIT', 'edit'), async (req, res) => {
  try {
    const out = await svc.refundSecurityDeposit(req.params.id, req.body, req.auth.userId);
    audit(req.auth.userId, 'DEPOSIT', 'REFUND', 'security_deposits', req.params.id, null, out, req);
    res.json(out);
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// Invoices / payments / receipts
app.get('/api/invoices', auth(), requirePerm('RENT', 'view'), async (req, res) => {
  res.json(await db.prepare(`SELECT i.*, t.full_name AS tenant_name FROM rent_invoices i
    LEFT JOIN tenants t ON t.tenant_id = i.tenant_id ORDER BY i.invoice_id DESC LIMIT 500`).all());
});
app.get('/api/invoices/:id', auth(), requirePerm('RENT', 'view'), async (req, res) => {
  const inv = await db.prepare(`SELECT * FROM rent_invoices WHERE invoice_id = ?`).get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  const items = await db.prepare(`SELECT * FROM invoice_items WHERE invoice_id = ?`).all(req.params.id);
  const payments = await db.prepare(`SELECT * FROM payments WHERE invoice_id = ? ORDER BY payment_id DESC`).all(req.params.id);
  for (const p of payments) {
    p.attachments = await db.prepare(`SELECT * FROM documents WHERE entity_type = 'payment' AND entity_id = ?`).all(p.payment_id);
  }
  const receipts = await db.prepare(`SELECT r.* FROM receipts r JOIN payments p ON p.payment_id = r.payment_id WHERE p.invoice_id = ?`).all(req.params.id);
  const agreement = await db.prepare(`SELECT * FROM rental_agreements WHERE agreement_id = ?`).get(inv.agreement_id);
  const plan = agreement && agreement.rent_plan_id ? await db.prepare(`SELECT * FROM rent_plans WHERE rent_plan_id = ?`).get(agreement.rent_plan_id) : null;
  res.json({ ...inv, items, payments, receipts, source: { agreement, plan } });
});

app.post('/api/invoices/:id/regenerate', auth(), requirePerm('RENT', 'add'), async (req, res) => {
  const inv = await db.prepare(`SELECT * FROM rent_invoices WHERE invoice_id = ?`).get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (inv.status !== 'PENDING' || Number(inv.paid_amount) > 0)
    return res.status(400).json({ error: 'Only unpaid PENDING invoices can be regenerated' });
  const txn = db.transaction(async (tdb) => {
    await tdb.prepare(`DELETE FROM invoice_items WHERE invoice_id = ?`).run(inv.invoice_id);
    await tdb.prepare(`DELETE FROM rent_invoices WHERE invoice_id = ?`).run(inv.invoice_id);
  });
  await txn();
  const res2 = await svc.generateRentInvoice(inv.agreement_id, inv.invoice_month);
  audit(req.auth.userId, 'RENT', 'REGENERATE', 'rent_invoices', res2.invoiceId, inv, res2, req);
  res.json(res2);
});

app.post('/api/jobs/generate-rent', auth(), requirePerm('RENT', 'add'), async (req, res) => {
  const { month } = req.body || {};
  if (!month) return res.status(400).json({ error: 'month (YYYY-MM-01) required' });
  try {
    const result = await svc.generateMonthlyRent(month);
    audit(req.auth.userId, 'RENT', 'GENERATE_MONTH', 'rent_invoices', null, null, result, req);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/jobs/mark-overdue', auth(), requirePerm('RENT', 'edit'), async (req, res) => {
  const result = await svc.markOverdueInvoices();
  audit(req.auth.userId, 'RENT', 'MARK_OVERDUE', 'rent_invoices', null, null, result, req);
  res.json(result);
});

app.post('/api/jobs/send-reminders', auth(), requirePerm('RENT', 'edit'), async (req, res) => {
  const result = await svc.runReminderEngine();
  audit(req.auth.userId, 'AUTOMATION', 'RUN_REMINDERS', 'notifications', null, null, result, req);
  res.json(result);
});

app.post('/api/jobs/check-expiries', auth(), requirePerm('RENT', 'view'), async (req, res) => {
  const result = await svc.runReminderEngine();
  res.json(result);
});

app.post('/api/payments', auth(), requirePerm('PAYMENT', 'add'), async (req, res) => {
  const { invoice_id, amount, payment_mode, payment_reference, attachment_paths, confirm } = req.body || {};
  if (confirm !== true) return res.status(400).json({ error: 'Recording a payment requires confirm=true' });
  try {
    const out = await svc.recordPayment(Number(invoice_id), Number(amount), payment_mode, payment_reference, attachment_paths);
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

// Complaints
app.get('/api/complaints', auth(), async (req, res) => {
  if (req.auth.kind === 'tenant') {
    return res.json(await db.prepare(`SELECT c.*, p.property_name,
        (SELECT COUNT(*) FROM documents d WHERE d.entity_type = 'complaint' AND d.entity_id = c.complaint_id) AS files
      FROM complaints c LEFT JOIN properties p ON p.property_id = c.property_id
      WHERE c.tenant_id = ? ORDER BY c.complaint_id DESC LIMIT 200`).all(req.auth.tenantId));
  }
  if (!req.auth.roleId) return res.status(403).json({ error: 'Forbidden' });
  const perms = await db.prepare(`SELECT rp.can_view FROM role_permissions rp JOIN permissions p ON p.permission_id = rp.permission_id
    WHERE rp.role_id = ? AND p.module_name = 'COMPLAINT'`).get(req.auth.roleId);
  if (!perms || !perms.can_view) return res.status(403).json({ error: 'Forbidden: COMPLAINT view required' });
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
  c.tasks = await db.prepare(`SELECT * FROM maintenance_tasks WHERE complaint_id = ?`).all(req.params.id);
  res.json(c);
});

app.post('/api/complaints', auth(), async (req, res) => {
  const b = req.body || {};
  const tenantId = req.auth.kind === 'tenant' ? req.auth.tenantId : b.tenant_id;
  if (!tenantId || !b.property_id || !b.category || !b.title) return res.status(400).json({ error: 'tenant, property, category, title required' });
  try {
    const n = `CMP-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(Date.now()).slice(-5)}`;
    const info = await db.prepare(`INSERT INTO complaints (tenant_id, property_id, unit_id, complaint_number, category, title, description, priority, status)
      VALUES (?,?,?,?,?,?,?,?,'OPEN')`).run(tenantId, b.property_id, b.unit_id || null, n, b.category, b.title, b.description || null, b.priority || 'MEDIUM');
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

// File uploads
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

// Notifications & Audit
app.get('/api/notifications', auth(), async (req, res) => {
  if (req.auth.kind === 'tenant') {
    return res.json(await db.prepare(`SELECT * FROM notifications WHERE tenant_id = ? ORDER BY notification_id DESC LIMIT 200`).all(req.auth.tenantId));
  }
  res.json(await db.prepare(`SELECT * FROM notifications ORDER BY notification_id DESC LIMIT 200`).all());
});
app.get('/api/audit-logs', auth(), requirePerm('REPORTS', 'view'), async (req, res) => {
  res.json(await db.prepare(`SELECT * FROM audit_logs ORDER BY audit_id DESC LIMIT 300`).all());
});
app.get('/api/message-logs', auth(), requirePerm('REPORTS', 'view'), async (req, res) => {
  const emails = await db.prepare(`SELECT e.email_id, e.email_address, e.subject, e.status, e.response, e.sent_at, n.event_code, n.tenant_id
    FROM email_logs e LEFT JOIN notifications n ON n.notification_id = e.notification_id
    ORDER BY e.email_id DESC LIMIT 200`).all();
  const sms = await db.prepare(`SELECT s.sms_id, s.mobile, s.status, s.response, s.sent_at, n.event_code
    FROM sms_logs s LEFT JOIN notifications n ON n.notification_id = s.notification_id
    ORDER BY s.sms_id DESC LIMIT 200`).all();
  res.json({ emails, sms });
});

app.get('/api/diag/email', auth(), requirePerm('REPORTS', 'view'), async (req, res) => {
  const brevoKey = String(process.env.BREVO_API_KEY || '').trim();
  const keyType = brevoKey.startsWith('xkeysib-') ? 'api-key'
    : brevoKey.startsWith('xsmtpsib-') ? 'smtp-password (wrong type: generate an API key in Brevo, not an SMTP credential)'
    : (brevoKey ? 'unrecognized' : 'missing');
  res.json({
    brevoKeyPresent: brevoKey.length > 0,
    brevoKeyLength: brevoKey.length,
    keyType,
    sender: String(process.env.BREVO_SENDER || '').trim() || null,
    smtpHost: process.env.SMTP_HOST || null,
    probe: await events.probeBrevo(),
  });
});

app.get('/api/permissions/me', auth(), async (req, res) => {
  if (req.auth.kind === 'tenant') return res.json({ role: 'TENANT', permissions: [] });
  const rows = await db.prepare(`SELECT p.module_name, p.permission_name, rp.can_view, rp.can_add, rp.can_edit, rp.can_delete, rp.can_approve
    FROM role_permissions rp JOIN permissions p ON p.permission_id = rp.permission_id WHERE rp.role_id = ?`).all(req.auth.roleId);
  res.json({ role: await roleName(req.auth.roleId), permissions: rows });
});

// Section 22 & 23: Dashboard
app.get('/api/dashboard/summary', auth(), requirePerm('REPORTS', 'view'), async (req, res) => {
  const units = await db.prepare(`SELECT status, COUNT(*) AS c FROM units GROUP BY status`).all();
  const by = Object.fromEntries(units.map((u) => [u.status, u.c]));
  const totalUnits = units.reduce((s, u) => s + Number(u.c), 0);
  const currentMonth = new Date().toISOString().slice(0, 7);
  let fin = await db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS expected, COALESCE(SUM(paid_amount),0) AS collected,
    COALESCE(SUM(outstanding_amount),0) AS outstanding FROM rent_invoices WHERE substr(invoice_month,1,7) = ?`).get(currentMonth);
  if (!fin || Number(fin.expected) === 0) {
    fin = await db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS expected, COALESCE(SUM(paid_amount),0) AS collected,
      COALESCE(SUM(outstanding_amount),0) AS outstanding FROM rent_invoices`).get();
  }
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

// Section 36: Comprehensive Reports Module
app.get('/api/reports/occupancy', auth(), requirePerm('REPORTS', 'view'), async (req, res) => {
  res.json(await svc.getOccupancyReport());
});
app.get('/api/reports/rent-collection', auth(), requirePerm('REPORTS', 'view'), async (req, res) => {
  res.json(await svc.getRentCollectionReport(req.query.from, req.query.to));
});
app.get('/api/reports/financial', auth(), requirePerm('REPORTS', 'view'), async (req, res) => {
  res.json(await svc.getFinancialReport(req.query.from, req.query.to));
});
app.get('/api/reports/gst', auth(), requirePerm('REPORTS', 'view'), async (req, res) => {
  res.json(await svc.getGstReport(req.query.from, req.query.to));
});
app.get('/api/reports/property-tax', auth(), requirePerm('REPORTS', 'view'), async (req, res) => {
  res.json(await svc.getPropertyTaxReport());
});
app.get('/api/reports/tenants', auth(), requirePerm('REPORTS', 'view'), async (req, res) => {
  res.json(await svc.getTenantReport());
});
app.get('/api/reports/maintenance', auth(), requirePerm('REPORTS', 'view'), async (req, res) => {
  res.json(await svc.getMaintenanceReport());
});

// Section 37: Global Search
app.get('/api/search', auth(), async (req, res) => {
  res.json(await svc.searchGlobal(req.query.q));
});

// Section 28: Accounting & Ledger Module
app.get('/api/ledger/accounts', auth(), requirePerm('ACCOUNTING', 'view'), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM ledger_accounts ORDER BY account_code ASC').all());
});
app.post('/api/ledger/accounts', auth(), requirePerm('ACCOUNTING', 'add'), async (req, res) => {
  const { account_code, account_name, account_type } = req.body || {};
  if (!account_code || !account_name || !account_type) return res.status(400).json({ error: 'account_code, account_name, account_type required' });
  const info = await db.prepare('INSERT INTO ledger_accounts (account_code, account_name, account_type) VALUES (?,?,?)').run(account_code, account_name, account_type);
  res.status(201).json({ account_id: info.lastInsertRowid, ...req.body });
});
app.get('/api/ledger/entries', auth(), requirePerm('ACCOUNTING', 'view'), async (req, res) => {
  const { account_id, from, to } = req.query || {};
  let sql = `SELECT e.*, a.account_code, a.account_name, a.account_type FROM ledger_entries e
    JOIN ledger_accounts a ON a.account_id = e.account_id`;
  const wheres = [];
  const args = [];
  if (account_id) { wheres.push('e.account_id = ?'); args.push(account_id); }
  if (from) { wheres.push('date(e.transaction_date) >= date(?)'); args.push(from); }
  if (to) { wheres.push('date(e.transaction_date) <= date(?)'); args.push(to); }
  if (wheres.length) sql += ' WHERE ' + wheres.join(' AND ');
  sql += ' ORDER BY e.transaction_date DESC, e.ledger_entry_id DESC LIMIT 500';
  res.json(await db.prepare(sql).all(...args));
});
app.post('/api/ledger/entries', auth(), requirePerm('ACCOUNTING', 'add'), async (req, res) => {
  const { debit_account_id, credit_account_id, amount, description, transaction_date } = req.body || {};
  if (!debit_account_id || !credit_account_id || !(Number(amount) > 0)) {
    return res.status(400).json({ error: 'debit_account_id, credit_account_id, and positive amount are required' });
  }
  const dateStr = transaction_date || new Date().toISOString().slice(0, 10);
  const txn = db.transaction(async (tdb) => {
    await tdb.prepare(`INSERT INTO ledger_entries (account_id, transaction_date, reference_type, description, debit, credit, created_by)
      VALUES (?,?, 'JOURNAL', ?, ?, 0, ?)`).run(debit_account_id, dateStr, description, Number(amount), req.auth.userId);
    await tdb.prepare(`INSERT INTO ledger_entries (account_id, transaction_date, reference_type, description, debit, credit, created_by)
      VALUES (?,?, 'JOURNAL', ?, 0, ?, ?)`).run(credit_account_id, dateStr, description, Number(amount), req.auth.userId);
  });
  await txn();
  res.status(201).json({ success: true, message: 'Journal entry recorded' });
});
app.get('/api/ledger/summary', auth(), requirePerm('ACCOUNTING', 'view'), async (req, res) => {
  const rows = await db.prepare(`SELECT a.account_id, a.account_code, a.account_name, a.account_type,
    COALESCE(SUM(e.debit),0) as total_debit, COALESCE(SUM(e.credit),0) as total_credit
    FROM ledger_accounts a
    LEFT JOIN ledger_entries e ON e.account_id = a.account_id
    GROUP BY a.account_id, a.account_code, a.account_name, a.account_type
    ORDER BY a.account_code ASC`).all();
  res.json(rows.map(r => ({
    ...r,
    balance: ['ASSET','EXPENSE'].includes(r.account_type) ? (Number(r.total_debit) - Number(r.total_credit)) : (Number(r.total_credit) - Number(r.total_debit))
  })));
});
app.get('/api/accounting/pnl', auth(), requirePerm('ACCOUNTING', 'view'), async (req, res) => {
  res.json(await svc.getFinancialReport(req.query.from, req.query.to));
});

// ---------- tenant self-service & Play Store Compliance ----------
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
  const kyc = await db.prepare(`SELECT * FROM tenant_kyc WHERE tenant_id = ? ORDER BY kyc_id DESC LIMIT 1`).get(req.auth.tenantId);
  const dues = await db.prepare(`SELECT COALESCE(SUM(outstanding_amount),0) AS outstanding, COALESCE(SUM(CASE WHEN status='OVERDUE' THEN outstanding_amount ELSE 0 END),0) AS overdue
    FROM rent_invoices WHERE tenant_id = ? AND outstanding_amount > 0`).get(req.auth.tenantId);
  res.json({ tenant: t, agreement: ag || null, kyc: kyc || null, dues });
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

// Google Play Store Mandatory: Tenant Self-Service Account Deletion
app.post('/api/tenant/delete-account', tAuth, needTenant, async (req, res) => {
  const tid = req.auth.tenantId;
  const active = await db.prepare(`SELECT agreement_id FROM rental_agreements WHERE tenant_id = ? AND status = 'ACTIVE' LIMIT 1`).get(tid);
  if (active) return res.status(409).json({ error: 'Cannot delete account with an active rental agreement. Please complete move-out first.' });
  const due = await db.prepare(`SELECT COALESCE(SUM(outstanding_amount),0) AS d FROM rent_invoices WHERE tenant_id = ?`).get(tid);
  if (Number(due.d) > 0.005) return res.status(409).json({ error: `Cannot delete account with outstanding balance of Rs.${due.d}. Settle dues first.` });

  try {
    const wipe = db.transaction(async (tdb) => {
      await tdb.prepare(`UPDATE tenants SET status = 'INACTIVE', full_name = 'Anonymized Tenant', email = NULL, address = NULL WHERE tenant_id = ?`).run(tid);
      await tdb.prepare(`DELETE FROM tenant_documents WHERE tenant_id = ?`).run(tid);
      await tdb.prepare(`DELETE FROM tenant_otps WHERE mobile IN (SELECT mobile FROM tenants WHERE tenant_id = ?)`).run(tid);
    });
    await wipe();
    audit(null, 'TENANT', 'ACCOUNT_DELETED', 'tenants', tid, null, { deleted_at: new Date().toISOString() }, req);
    res.json({ success: true, message: 'Your account and personal data have been deleted per privacy requirements.' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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

// Google Play Store Mandatory: Privacy Policy, Terms & Android App Asset Links
const PRIVACY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy - Rent Ledger & Property Management</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #111; max-width: 800px; margin: 40px auto; padding: 0 20px; }
    h1 { border-bottom: 2px solid #eee; padding-bottom: 12px; }
    h2 { margin-top: 28px; }
    .box { background: #f9f9f9; border-left: 4px solid #111; padding: 14px 18px; margin: 20px 0; }
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p><strong>Effective Date:</strong> September 1, 2026</p>
  <p>This Privacy Policy describes how Rent Ledger & Property Management System ("we", "our", or "the App") collects, uses, and safeguards personal data for property managers and tenants.</p>

  <h2>1. Information We Collect</h2>
  <ul>
    <li><strong>Contact & Identity Data:</strong> Full name, mobile phone number, email address, date of birth, emergency contact.</li>
    <li><strong>KYC Documents:</strong> Identity proof (e.g. Aadhaar, PAN, Passport, Driving License) and photographs uploaded for tenancy verification.</li>
    <li><strong>Financial Data:</strong> Rent invoices, payment mode, transaction references, security deposit records, and payment receipts.</li>
    <li><strong>Device & Usage Data:</strong> IP address, device model, operating system version for security and audit logging.</li>
  </ul>

  <h2>2. Device Permissions Required</h2>
  <ul>
    <li><strong>Camera / Photo Library:</strong> To capture and upload KYC identity proofs, payment screenshots, and maintenance complaint photos.</li>
    <li><strong>Notifications:</strong> To deliver timely rent invoice notices, payment receipts, and maintenance alerts.</li>
    <li><strong>Internet Access:</strong> To communicate securely with the rental ledger backend over TLS/HTTPS.</li>
  </ul>

  <h2>3. How We Use Information</h2>
  <p>Information is strictly used for rental contract execution, invoice generation, payment receipt issuance, tenant verification, and maintenance coordination. We do not sell or monetize personal data.</p>

  <h2>4. Data Retention & Security</h2>
  <p>All sensitive documents and databases are protected by industry-standard encryption, strict access control, and comprehensive audit logs. Financial records are retained according to statutory accounting standards.</p>

  <h2 id="account-deletion">5. User Account & Data Deletion</h2>
  <div class="box">
    <p><strong>How to delete your account:</strong></p>
    <p>Tenants may request complete deletion of their profile and KYC documents directly in the mobile application via <em>Profile &gt; Delete Account</em>, or by submitting a deletion request to <a href="mailto:privacy@abcproperty.com">privacy@abcproperty.com</a>.</p>
    <p>Requests are processed immediately provided all active rental agreements have been settled and no outstanding dues remain.</p>
  </div>

  <h2>6. Contact Us</h2>
  <p>If you have any questions regarding privacy or data protection, contact our Data Protection Officer at: <a href="mailto:privacy@abcproperty.com">privacy@abcproperty.com</a>.</p>
</body>
</html>`;

const TERMS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terms of Service - Rent Ledger & Property Management</title>
  <style>body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial; line-height: 1.6; color: #111; max-width: 800px; margin: 40px auto; padding: 0 20px; }</style>
</head>
<body>
  <h1>Terms of Service</h1>
  <p>By using the Rent Ledger & Property Management platform, you agree to comply with your tenancy agreement terms, timely rent payments, and respectful use of managed premises and software facilities.</p>
</body>
</html>`;

app.get('/privacy', (req, res) => res.type('html').send(PRIVACY_HTML));
app.get('/api/privacy-policy', (req, res) => res.json({
  app_name: 'Rent Ledger & Property Management',
  effective_date: '2026-09-01',
  data_collected: ['Name', 'Mobile Number', 'Email', 'KYC Documents', 'Payment Records'],
  account_deletion_url: '/privacy#account-deletion',
  contact_email: 'privacy@abcproperty.com'
}));

app.get('/terms', (req, res) => res.type('html').send(TERMS_HTML));

// Android Digital Asset Links (Google Play App Links verification)
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.json([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: 'com.rentledger.tenant',
      sha256_cert_fingerprints: [
        '14:6D:E9:CD:07:4B:43:A1:04:F6:4E:A2:46:EC:69:2B:A3:33:33:39:84:69:4E:92:CB:A3:40:E1:98:F6:CB:A4'
      ]
    }
  }]);
});

// PWA Web App Manifest (Android WebAPK / Play Store wrapper)
app.get(['/manifest.webmanifest', '/manifest.json'], (req, res) => {
  res.json({
    short_name: 'RentLedger',
    name: 'Rent Ledger - Property & Tenant Management',
    icons: [
      { src: '/icon-192.png', type: 'image/png', sizes: '192x192' },
      { src: '/icon-512.png', type: 'image/png', sizes: '512x512' }
    ],
    start_url: '/tenant/login',
    background_color: '#ffffff',
    theme_color: '#111111',
    display: 'standalone',
    orientation: 'portrait'
  });
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
  try {
    console.log('[CRON] running overdue marking & reminder engine:', await svc.runReminderEngine());
  } catch (e) { console.error('[CRON] reminder engine failed', e.message); }
});

// Upload error handler
app.use((err, req, res, next) => {
  if (err && (err.code === 'LIMIT_FILE_SIZE' || /Only JPG/.test(err.message || '')))
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 10 MB.' : err.message });
  next(err);
});

// Last-resort crash guards
process.on('unhandledRejection', (e) => console.error('[guard] unhandled rejection, server stays up:', e && e.message));
process.on('uncaughtException', (e) => console.error('[guard] uncaught exception, server stays up:', e && e.message));
app.use((err, req, res, next) => {
  console.error('[api] error:', err && err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Serve frontend build if present
const dist = path.join(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|files|\.well-known|privacy|terms).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
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
