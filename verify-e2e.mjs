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
// new: health, uploads guard, receipt detail, tenant statement, complaint files
const health = await call('GET', '/api/health');
ok(health.ok === true, 'health endpoint');
const rc = await call('GET', '/api/receipts', null, T);
const rdet = await call('GET', `/api/receipts/${rc[0].receipt_id}`, null, T);
ok(rdet.organization && rdet.invoice && rdet.payment, 'receipt detail with org+invoice+payment');
const trc = await call('GET', `/api/tenant/receipts/${rc[0].receipt_id}`, null, TT);
ok(trc.receipt.receipt_id === rc[0].receipt_id, 'tenant can open own receipt');
const stmt = await call('GET', '/api/tenant/statement?from=2026-01-01&to=2026-12-31', null, TT);
ok(Array.isArray(stmt) && stmt.length >= 2, `tenant statement has ${stmt.length} rows`);
const cdet = await call('GET', `/api/complaints/${comp.complaint_id}`, null, T);
ok(Array.isArray(cdet.attachments), 'complaint detail with attachments');
try { await call('POST', '/api/uploads', {}, T); ok(false, 'empty upload rejected'); }
catch { ok(true, 'empty upload rejected'); }
// real blob upload roundtrip: upload PNG bytes, download them back
const fd = new FormData();
fd.append('file', new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], { type: 'image/png' }), 'proof.png');
const upRes = await fetch(B + '/api/uploads', { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: fd });
const up = await upRes.json();
ok(upRes.ok && up.file_path.startsWith('/files/'), `blob upload -> ${up.file_path}`);
const dl = await fetch(B + up.file_path + '?token=' + encodeURIComponent(T));
const buf = Buffer.from(await dl.arrayBuffer());
ok(dl.ok && buf.equals(Buffer.from([137, 80, 78, 71, 1, 2, 3])), 'blob download bytes match');
const noAuth = await fetch(B + up.file_path);
ok(noAuth.status === 401, 'file download requires login');
// deleting a tenant with live agreements must 409, not crash the server
const delRes = await fetch(B + '/api/tenants/1?confirm=true', { method: 'DELETE', headers: { Authorization: 'Bearer ' + T } });
ok(delRes.status === 409, 'delete of referenced tenant refused with 409');
const stillUp = await call('GET', '/api/health');
ok(stillUp.ok === true, 'server still up after refused delete');
// tenant edit
const edited = await call('PUT', '/api/tenants/2', { occupation: 'Senior Designer' }, T);
ok(edited.occupation === 'Senior Designer', 'tenant details editable');
// payment with reference image + overpayment guard
const fd2 = new FormData();
fd2.append('file', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }), 'upi.png');
const up2 = await (await fetch(B + '/api/uploads', { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: fd2 })).json();
const pay2 = await call('POST', '/api/payments', { invoice_id: inv.invoice_id, amount: 1000, payment_mode: 'UPI', payment_reference: 'UPI-2', attachment_paths: [up2.file_path], confirm: true }, T);
ok(!!pay2.paymentId, 'payment with proof image recorded');
const det2 = await call('GET', `/api/invoices/${inv.invoice_id}`, null, T);
const withProof = det2.payments.find((p) => p.payment_id === pay2.paymentId);
ok(withProof && withProof.attachments.length === 1, 'proof image linked to payment');
try { await call('POST', '/api/payments', { invoice_id: inv.invoice_id, amount: 999999, payment_mode: 'UPI', confirm: true }, T); ok(false, 'overpayment rejected'); }
catch (e) { ok(/exceeds/.test(e.message), 'overpayment rejected with clear message'); }
// full tenant wipe for a tenant with no live money
const tmp = await call('POST', '/api/tenants', { full_name: 'Temp User', mobile: '9111111111' }, T);
const wiped = await fetch(B + `/api/tenants/${tmp.tenant_id}?confirm=true`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + T } });
ok(wiped.ok, 'tenant with no dues deletes cleanly');
const gone = await fetch(B + `/api/tenants/${tmp.tenant_id}`, { headers: { Authorization: 'Bearer ' + T } });
ok(gone.status === 404, 'deleted tenant is gone');
// tenant sees own complaints now
const tcomp = await call('GET', '/api/complaints', null, TT);
ok(tcomp.length >= 1 && tcomp.every((c) => c.tenant_id === 1), 'tenant lists own complaints');
// plan edit flows into rebuilt pending invoices
await call('POST', '/api/jobs/generate-rent', { month: '2026-10-01' }, T);
const oct = (await call('GET', '/api/invoices', null, T)).find((i) => i.tenant_id === 1 && String(i.invoice_month).startsWith('2026-10'));
ok(oct && oct.status === 'PENDING', 'october invoice pending');
await call('PUT', '/api/rent-plans/1', { maintenance_charge: 1500 }, T);
const re = await call('POST', `/api/invoices/${oct.invoice_id}/regenerate`, { confirm: true }, T);
ok(!!re.invoiceId, 'pending invoice rebuilt');
const oct2 = await call('GET', `/api/invoices/${re.invoiceId}`, null, T);
ok(oct2.maintenance === 1500 && oct2.total_amount === 16800, `rebuilt total ${oct2.total_amount}`);
ok(oct2.source && oct2.source.plan && oct2.source.plan.plan_name === 'Standard PG Plan', 'invoice shows its source');
console.log('E2E done.');
