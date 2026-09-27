const B = 'http://localhost:4000';
async function call(method, path, body, token) {
  const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
}
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' ' + m); if (!c) process.exitCode = 1; };
// fresh DB was just seeded by server start
const login = await call('POST', '/api/auth/login', { email: 'admin@abcproperty.com', password: 'admin123' });
ok(!!login.token, 'admin login');
const T = login.token;
const gen = await call('POST', '/api/jobs/generate-rent', { month: '2026-09-01' }, T);
ok(gen.created >= 1, `generate-rent created=${gen.created} skipped=${gen.skipped}`);
const invoices = await call('GET', '/api/invoices', null, T);
ok(invoices.length >= 1 && invoices[0].invoice_number.startsWith('INV-202609-'), 'invoice number format INV-YYYYMM-000000');
const inv = invoices.find((i) => i.outstanding_amount > 0);
const pay = await call('POST', '/api/payments', { invoice_id: inv.invoice_id, amount: 5000, payment_mode: 'UPI', payment_reference: 'UPI-TEST-0001', confirm: true }, T);
ok(!!pay.paymentId && !!pay.receiptNumber, `record payment + receipt ${pay.receiptNumber}`);
const detail = await call('GET', `/api/invoices/${inv.invoice_id}`, null, T);
ok(detail.paid_amount === 5000 && detail.status === 'PARTIALLY_PAID', `invoice auto updated paid=${detail.paid_amount} status=${detail.status}`);
ok(detail.receipts.length === 1, 'receipt auto created');
// invalid amount rejected at data layer
try { await call('POST', '/api/payments', { invoice_id: inv.invoice_id, amount: 0, payment_mode: 'UPI', confirm: true }, T); ok(false, 'zero payment rejected'); }
catch { ok(true, 'zero payment rejected with real error'); }
// agreement activation flips occupancy
const unitsBefore = await call('GET', '/api/units', null, T);
const tenants = await call('GET', '/api/tenants', null, T);
const neha = tenants.find((t) => t.mobile === '9000000002');
const availUnit = unitsBefore.find((u) => u.status === 'AVAILABLE');
const ag = await call('POST', '/api/agreements', { tenant_id: neha.tenant_id, property_id: 1, unit_id: availUnit.unit_id, agreement_number: 'AGR-2026-0099', start_date: '2026-09-10', monthly_rent: 20000, status: 'ACTIVE' }, T);
const unitsAfter = await call('GET', '/api/units', null, T);
const changed = unitsAfter.find((u) => u.unit_id === availUnit.unit_id);
ok(['OCCUPIED', 'PARTIALLY_OCCUPIED'].includes(changed.status), `agreement activation flips unit to ${changed.status}`);
// tenant OTP + self service
const otpReq = await call('POST', '/api/auth/tenant/request-otp', { mobile: '9000000001' });
const otpVerify = await call('POST', '/api/auth/tenant/verify-otp', { mobile: '9000000001', otp: otpReq.otp });
ok(!!otpVerify.token, 'tenant OTP login');
const TT = otpVerify.token;
const me = await call('GET', '/api/tenant/me', null, TT);
ok(me.dues && me.agreement, 'tenant dashboard dues + agreement');
const tinv = await call('GET', '/api/tenant/invoices', null, TT);
ok(tinv.length >= 1, 'tenant sees invoices');
const comp = await call('POST', '/api/complaints', { property_id: 1, category: 'PLUMBING', title: 'Tap leak', description: 'Kitchen tap leaking' }, TT);
ok(!!comp.complaint_id, 'tenant raises complaint');
const adv = await call('PUT', `/api/complaints/${comp.complaint_id}`, { status: 'ASSIGNED' }, T);
ok(adv.status === 'ASSIGNED', 'complaint advances OPEN to ASSIGNED');
const dash = await call('GET', '/api/dashboard/summary', null, T);
ok(dash.units.total >= 2 && dash.finance.expected > 0, 'dashboard summary');
const audit = await call('GET', '/api/audit-logs', null, T);
ok(audit.length >= 3, `audit log has ${audit.length} entries`);
console.log('E2E done.');
