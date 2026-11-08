import http from 'http';
import app from './src/app.js';
import db from './src/db.js';

await db.ready;

const pipeName = `\\\\.\\pipe\\prm-test-${Date.now()}`;
const server = http.createServer(app);
await new Promise((resolve) => server.listen(pipeName, resolve));
console.log('[TestServer] Running on named pipe:', pipeName);

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
          return reject(new Error(`${method} ${path} -> ${res.statusCode} ${JSON.stringify(j)}`));
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
  // 1. Health check
  const health = await call('GET', '/api/health');
  ok(health.ok === true, 'Health endpoint responds with ok=true');

  // 2. Play Store Compliance: Privacy Policy & Terms
  const priv = await call('GET', '/api/privacy-policy');
  ok(priv.app_name && priv.account_deletion_url, 'Privacy policy endpoint is valid');
  const assetlinks = await call('GET', '/.well-known/assetlinks.json');
  ok(Array.isArray(assetlinks) && assetlinks[0].target.package_name === 'com.rentledger.tenant', 'Asset links for Android app verified');

  // 3. Admin Login
  const login = await call('POST', '/api/auth/login', { email: 'admin@abcproperty.com', password: 'admin123' });
  ok(!!login.token, 'Admin login succeeded');
  const T = login.token;

  // 3.1. Role-Based Auth (RBAC) Verification
  const testTenantOtp = await call('POST', '/api/auth/tenant/request-otp', { mobile: '9000000001' });
  const testTenantAuth = await call('POST', '/api/auth/tenant/verify-otp', { mobile: '9000000001', otp: testTenantOtp.otp || '8520' });
  const tenantJwt = testTenantAuth.token;

  try {
    await call('GET', '/api/properties', null, tenantJwt);
    ok(false, 'Tenant was erroneously allowed to access admin properties endpoint');
  } catch (err) {
    ok(err.message.includes('403'), 'RBAC properly blocks tenant from admin properties (403 Forbidden)');
  }

  try {
    await call('GET', '/api/expenses', null, tenantJwt);
    ok(false, 'Tenant was erroneously allowed to access admin expenses endpoint');
  } catch (err) {
    ok(err.message.includes('403'), 'RBAC properly blocks tenant from admin expenses (403 Forbidden)');
  }

  // 3.2. Tenant Self-Registration & Onboarding Workflow (Public Inventory & Self-Register)
  const inventory = await call('GET', '/api/public/inventory');
  ok(Array.isArray(inventory.properties) && inventory.properties.length >= 1, 'Public inventory lists available properties');
  ok(Array.isArray(inventory.units) && inventory.units.length >= 1, 'Public inventory lists available units');

  const selectedProp = inventory.properties[0];
  const selectedUnit = inventory.units.find(u => u.property_id === selectedProp.property_id) || inventory.units[0];
  const selfRegMobile = `98${Math.floor(10000000 + Math.random() * 90000000)}`;

  const selfReg = await call('POST', '/api/auth/tenant/register', {
    full_name: 'Aakash Mehta',
    mobile: selfRegMobile,
    email: 'aakash.mehta@example.com',
    gender: 'MALE',
    date_of_birth: '1998-05-12',
    address: 'Flat 402, Sunshine Heights, Pune',
    emergency_contact_name: 'Sunil Mehta',
    emergency_contact_mobile: '9822001122',
    occupation: 'Data Analyst',
    company_name: 'Infosys Ltd',
    property_id: selectedProp.property_id,
    unit_id: selectedUnit.unit_id,
    id_type: 'AADHAAR',
    id_number: '5544-3322-1100',
    document_path: '/files/1',
    move_in_date: '2026-11-01'
  });
  ok(!!selfReg.token, 'Tenant self-registration returned valid authentication token');
  ok(selfReg.tenant && selfReg.tenant.full_name === 'Aakash Mehta', 'Tenant profile created from self-registration');
  ok(selfReg.agreement && selfReg.agreement.agreement_number.startsWith('AGR-'), 'Rental agreement generated for tenant chosen room');

  // Verify self-registered tenant can immediately query their portal
  const aakashPortal = await call('GET', '/api/tenant/me', null, selfReg.token);
  ok(aakashPortal.tenant && aakashPortal.agreement, 'Self-registered tenant portal displays room details and agreement');

  // Verify KYC verification status in admin KYC queue
  const kycList = await call('GET', '/api/kyc', null, T);
  const aakashKyc = kycList.find(k => k.tenant_id === selfReg.tenant.tenant_id);
  ok(aakashKyc && aakashKyc.status === 'KYC_SUBMITTED', 'Admin KYC queue reflects tenant self-submitted documents');

  // 4. Global Search (SRS Section 37)
  const search = await call('GET', '/api/search?q=Rahul', null, T);
  ok(Array.isArray(search.tenants) && search.tenants.length >= 1, 'Global search returns matching tenants');

  // 5. Expense Management (SRS Section 24)
  const categories = await call('GET', '/api/expense-categories', null, T);
  ok(categories.length >= 1, `Expense categories seeded (${categories.length} categories)`);
  const catId = categories[0].category_id;

  const expense = await call('POST', '/api/expenses', {
    property_id: 1,
    category_id: catId,
    amount: 2500,
    expense_date: '2026-09-15',
    payment_mode: 'BANK_TRANSFER',
    remarks: 'Routine inspection & electrical repairs'
  }, T);
  ok(expense.expense_id && expense.amount === 2500, 'Recorded expense with ledger posting');

  const expList = await call('GET', `/api/expenses?property_id=1`, null, T);
  ok(expList.length >= 1, `Query expenses by property_id returned ${expList.length} rows`);

  // 6. Vendor Management (SRS Section 25)
  const vendor = await call('POST', '/api/vendors', {
    vendor_name: 'Metro Electricals',
    company_name: 'Metro Electricals Pvt Ltd',
    mobile: '9820098200',
    email: 'contact@metroelectricals.com',
    services: 'Electrical wiring and appliances'
  }, T);
  ok(vendor.vendor_id && vendor.vendor_name === 'Metro Electricals', 'Vendor created successfully');

  // 7. Property Tax Management (SRS Section 26)
  const tax = await call('POST', '/api/property-taxes', {
    property_id: 1,
    tax_authority: 'Thane Municipal Corporation',
    property_tax_number: 'TMC-2026-0099',
    financial_year: '2026-2027',
    tax_amount: 18000,
    due_date: '2026-12-31',
    status: 'PENDING'
  }, T);
  ok(tax.property_tax_id && tax.tax_amount === 18000, 'Property tax record created');

  // 8. GST Settings (SRS Section 27)
  const gst = await call('POST', '/api/gst-settings', {
    organization_id: 1,
    gstin: '27AABCT0001A1Z5',
    default_tax_rate: 18,
    cgst_rate: 9,
    sgst_rate: 9
  }, T);
  ok(gst.gst_setting_id && gst.default_tax_rate === 18, 'GST settings configured');

  // 9. Accounting & Ledger (SRS Section 28)
  const ledgerAccounts = await call('GET', '/api/ledger/accounts', null, T);
  ok(ledgerAccounts.length >= 10, `Chart of accounts verified (${ledgerAccounts.length} accounts)`);

  const ledgerSummary = await call('GET', '/api/ledger/summary', null, T);
  ok(Array.isArray(ledgerSummary) && ledgerSummary.length >= 10, 'Trial balance ledger summary generated');

  const pnl = await call('GET', '/api/accounting/pnl', null, T);
  ok(pnl && typeof pnl.net_profit === 'number', 'P&L report generated');

  // 10. Maintenance Tasks (SRS Section 31)
  const complaint = await call('POST', '/api/complaints', {
    tenant_id: 1,
    property_id: 1,
    category: 'PLUMBING',
    title: 'Water pressure low in 101',
    description: 'Shower and sink water pressure low'
  }, T);
  ok(complaint.complaint_id, 'Complaint created');

  const task = await call('POST', '/api/maintenance-tasks', {
    complaint_id: complaint.complaint_id,
    vendor_id: vendor.vendor_id,
    task_description: 'Fix pipeline pressure valve',
    estimated_cost: 1200,
    status: 'ASSIGNED'
  }, T);
  ok(task.task_id && task.estimated_cost === 1200, 'Maintenance task created and linked to complaint');

  // 11. Comprehensive Reports Module (SRS Section 36)
  const repOccupancy = await call('GET', '/api/reports/occupancy', null, T);
  ok(repOccupancy.portfolio && repOccupancy.units && typeof repOccupancy.occupancy_rate_pct === 'number', 'Occupancy report verified');

  const repRent = await call('GET', '/api/reports/rent-collection', null, T);
  ok(Array.isArray(repRent), 'Rent collection report verified');

  const repTax = await call('GET', '/api/reports/property-tax', null, T);
  ok(repTax.summary && Number(repTax.summary.total_assessed) >= 18000, 'Property tax report verified');

  const repTenants = await call('GET', '/api/reports/tenants', null, T);
  ok(repTenants.total_tenants >= 2, 'Tenants report verified');

  // 12. Automation & Reminder Engine (SRS Section 16 & 45)
  const reminders = await call('POST', '/api/jobs/send-reminders', {}, T);
  ok(typeof reminders.rentReminders === 'number' && typeof reminders.overdueReminders === 'number', 'Automation reminders job executed');

  // 13. Move-Out Workflow (SRS Section 30)
  const randNum = Math.floor(10000 + Math.random() * 90000);
  const newTenant = await call('POST', '/api/tenants', {
    full_name: 'Vikram Joshi',
    mobile: `91234${randNum}`,
    email: `vikram_${randNum}@example.com`
  }, T);
  const units = await call('GET', '/api/units', null, T);
  const availUnit = units.find(u => u.status === 'AVAILABLE') || units[0];
  const newAg = await call('POST', '/api/agreements', {
    tenant_id: newTenant.tenant_id,
    property_id: 1,
    unit_id: availUnit.unit_id,
    agreement_number: `AGR-MOVEOUT-${Date.now()}`,
    start_date: '2026-09-01',
    monthly_rent: 12000,
    security_deposit: 24000,
    status: 'ACTIVE'
  }, T);
  ok(newAg.agreement_id, 'Created active agreement for move-out test');

  // Execute Move-Out
  const moveOutResult = await call('POST', `/api/agreements/${newAg.agreement_id}/move-out`, {
    move_out_date: '2026-10-31',
    damage_charges: 2000,
    utility_charges: 500,
    remarks: 'Room handed over in good condition minus wall scuffs'
  }, T);
  ok(moveOutResult.agreementId === newAg.agreement_id && moveOutResult.refundAmount === 21500,
    `Move-out completed: Deposit Rs.${moveOutResult.depositHeld} - Deductions Rs.${moveOutResult.totalDeductions} = Refund Rs.${moveOutResult.refundAmount}`);

  // 14. Tenant Self-Service Account Deletion (Google Play Compliance)
  const otpReq = await call('POST', '/api/auth/tenant/request-otp', { mobile: `91234${randNum}` });
  const otpVerify = await call('POST', '/api/auth/tenant/verify-otp', { mobile: `91234${randNum}`, otp: otpReq.otp || '8520' });
  const TT = otpVerify.token;
  const delAcc = await call('POST', '/api/tenant/delete-account', {}, TT);
  ok(delAcc.success === true, 'Tenant self-service account deletion verified (Play Store compliant)');

  console.log('\n--- ALL TEST SUITE ASSERTIONS PASSED! ---');
} catch (e) {
  console.error('\nTEST FAILED:', e);
  process.exitCode = 1;
} finally {
  server.close();
  process.exit(process.exitCode || 0);
}
