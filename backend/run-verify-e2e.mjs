import http from 'http';
import app from './src/app.js';
import db from './src/db.js';

await db.ready;
const pipeName = `\\\\.\\pipe\\prm-e2e-${Date.now()}`;
const server = http.createServer(app);
await new Promise(r => server.listen(pipeName, r));
console.log('[E2EServer] Listening on named pipe:', pipeName);

async function call(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : '';
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
    };
    const req = http.request({
      socketPath: pipeName,
      path,
      method,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let j = null;
        try { j = data ? JSON.parse(data) : {}; } catch { j = { raw: data }; }
        if (res.statusCode >= 400) {
          const err = new Error(`${method} ${path} -> ${res.statusCode} ${JSON.stringify(j)}`);
          err.status = res.statusCode;
          err.response = j;
          return reject(err);
        }
        resolve(j);
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

const ok = (c, m) => {
  console.log((c ? 'PASS' : 'FAIL') + ' ' + m);
  if (!c) process.exitCode = 1;
};

try {
  const login = await call('POST', '/api/auth/login', { email: 'admin@abcproperty.com', password: 'admin123' });
  ok(!!login.token, 'admin login');
  const T = login.token;

  const gen = await call('POST', '/api/jobs/generate-rent', { month: '2026-09-01' }, T);
  ok(gen.created >= 0, `generate-rent created=${gen.created} skipped=${gen.skipped}`);

  const invoices = await call('GET', '/api/invoices', null, T);
  ok(invoices.length >= 1 && invoices[0].invoice_number.startsWith('INV-'), 'invoice number format INV-YYYYMM-000000');

  const inv = invoices.find((i) => i.outstanding_amount > 0) || invoices[0];
  const detail = await call('GET', `/api/invoices/${inv.invoice_id}`, null, T);
  ok(detail && detail.invoice_id, 'invoice detail retrieved');

  // Tenant OTP + self service
  const otpReq = await call('POST', '/api/auth/tenant/request-otp', { mobile: '9000000001' });
  ok(otpReq.otp === '8520' || otpReq.message, 'tenant OTP requested');
  const otpVerify = await call('POST', '/api/auth/tenant/verify-otp', { mobile: '9000000001', otp: otpReq.otp || '8520' });
  ok(!!otpVerify.token, 'tenant OTP login');
  const TT = otpVerify.token;

  const me = await call('GET', '/api/tenant/me', null, TT);
  ok(me.dues && me.tenant, 'tenant dashboard dues + tenant');

  const tinv = await call('GET', '/api/tenant/invoices', null, TT);
  ok(Array.isArray(tinv), 'tenant sees invoices');

  const comp = await call('POST', '/api/complaints', { property_id: 1, category: 'PLUMBING', title: 'Tap leak', description: 'Kitchen tap leaking' }, TT);
  ok(!!comp.complaint_id, 'tenant raises complaint');

  const adv = await call('PUT', `/api/complaints/${comp.complaint_id}`, { status: 'ASSIGNED' }, T);
  ok(adv.status === 'ASSIGNED', 'complaint advances OPEN to ASSIGNED');

  const dash = await call('GET', '/api/dashboard/summary', null, T);
  ok(dash.units.total >= 2 && dash.finance.expected > 0, 'dashboard summary');

  const audit = await call('GET', '/api/audit-logs', null, T);
  ok(audit.length >= 3, `audit log has ${audit.length} entries`);

  const health = await call('GET', '/api/health');
  ok(health.ok === true, 'health endpoint');

  const rc = await call('GET', '/api/receipts', null, T);
  ok(rc.length >= 1, 'receipts found');
  const rdet = await call('GET', `/api/receipts/${rc[0].receipt_id}`, null, T);
  ok(rdet.organization && rdet.invoice && rdet.payment, 'receipt detail with org+invoice+payment');

  const stmt = await call('GET', '/api/tenant/statement?from=2026-01-01&to=2026-12-31', null, TT);
  ok(Array.isArray(stmt), `tenant statement has ${stmt.length} rows`);

  console.log('Original E2E flows verified successfully!');
} catch (e) {
  console.error('E2E ERROR:', e);
  process.exitCode = 1;
} finally {
  server.close();
  process.exit(process.exitCode || 0);
}

