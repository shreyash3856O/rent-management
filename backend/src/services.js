// Billing, occupancy, expenses, accounting, move-out, automation & reporting services.
// All financial writes run in transactions and emit events on the central bus.
const db = require('./db');
const events = require('./events');

function pad(n, w, fill = '0') { return String(n).padStart(w, fill); }
function monthKey(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1, 2)}-01`;
}
function yyyymm(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}${pad(dt.getMonth() + 1, 2)}`;
}
function money(n) {
  return 'Rs.' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

// Accounting double-entry ledger helpers
async function ensureAccount(tdb, code, name, type) {
  let acc = await tdb.prepare('SELECT * FROM ledger_accounts WHERE account_code = ?').get(code);
  if (!acc) {
    const info = await tdb.prepare('INSERT INTO ledger_accounts (account_code, account_name, account_type) VALUES (?,?,?)').run(code, name, type);
    acc = { account_id: info.lastInsertRowid, account_code: code, account_name: name, account_type: type };
  }
  return acc;
}

async function recordJournalEntry(tdb, { debitCode, debitName, debitType, creditCode, creditName, creditType, amount, date, refType, refId, desc, userId }) {
  if (!(Number(amount) > 0)) return;
  const dAcc = await ensureAccount(tdb, debitCode, debitName, debitType);
  const cAcc = await ensureAccount(tdb, creditCode, creditName, creditType);
  const dStr = date || new Date().toISOString().slice(0, 10);
  await tdb.prepare(`INSERT INTO ledger_entries (account_id, transaction_date, reference_type, reference_id, description, debit, credit, created_by)
    VALUES (?,?,?,?,?,?,0,?)`).run(dAcc.account_id, dStr, refType, refId, desc, Number(amount), userId || null);
  await tdb.prepare(`INSERT INTO ledger_entries (account_id, transaction_date, reference_type, reference_id, description, debit, credit, created_by)
    VALUES (?,?,?,?,?,0,?,?)`).run(cAcc.account_id, dStr, refType, refId, desc, Number(amount), userId || null);
}

// generate_rent_invoice(agreement_id, invoice_month)
async function generateRentInvoice(agreementId, invoiceMonth) {
  const monthStart = monthKey(invoiceMonth);
  const ag = await db.prepare(`SELECT * FROM rental_agreements WHERE agreement_id = ? AND status = 'ACTIVE'`).get(agreementId);
  if (!ag) throw Object.assign(new Error('Agreement not active or not found'), { status: 404 });
  const dup = await db.prepare(`SELECT 1 AS one FROM rent_invoices WHERE agreement_id = ? AND invoice_month = ?`).get(agreementId, monthStart);
  if (dup) return { skipped: true, agreementId };

  const plan = ag.rent_plan_id
    ? await db.prepare(`SELECT * FROM rent_plans WHERE rent_plan_id = ?`).get(ag.rent_plan_id)
    : null;
  const maintenance = plan ? Number(plan.maintenance_charge || 0) : 0;
  const water = plan ? Number(plan.water_charge || 0) : 0;
  const other = Number(ag.other_charges || 0);
  const rent = Number(ag.monthly_rent || 0);

  // GST Calculation (if configured in rent plan or org settings)
  let cgst = 0, sgst = 0, igst = 0;
  if (plan && plan.gst_applicable) {
    const prop = await db.prepare(`SELECT organization_id FROM properties WHERE property_id = ?`).get(ag.property_id);
    const gstSetting = prop ? await db.prepare(`SELECT * FROM gst_settings WHERE organization_id = ? AND status = 'ACTIVE' LIMIT 1`).get(prop.organization_id) : null;
    const rate = gstSetting ? Number(gstSetting.default_tax_rate || 18) : 18;
    const taxable = rent + maintenance + other;
    cgst = (taxable * (rate / 2)) / 100;
    sgst = (taxable * (rate / 2)) / 100;
  }
  const taxableAmount = rent + maintenance + other;
  const total = taxableAmount + water + cgst + sgst + igst;

  const dueDay = Math.min(Math.max(Number(ag.due_day || 5), 1), 28);
  const y = new Date(monthStart).getFullYear();
  const m = new Date(monthStart).getMonth();
  const dueDate = `${y}-${pad(m + 1, 2)}-${pad(dueDay, 2)}`;
  const invoiceNumber = `INV-${yyyymm(monthStart)}-${pad(agreementId, 6, '0')}`;

  const txn = db.transaction(async (tdb) => {
    const info = await tdb.prepare(`INSERT INTO rent_invoices
      (tenant_id, agreement_id, invoice_number, invoice_month, invoice_date, due_date,
       base_rent, maintenance, water, other_charges, taxable_amount, cgst, sgst, igst, total_amount, outstanding_amount, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'PENDING')`).run(
      ag.tenant_id, agreementId, invoiceNumber, monthStart, monthStart, dueDate,
      rent, maintenance, water, other, taxableAmount, cgst, sgst, igst, total, total);
    const invoiceId = info.lastInsertRowid;
    const add = async (type, desc, qty, rate, amount, taxable = 0) =>
      tdb.prepare(`INSERT INTO invoice_items (invoice_id, item_type, description, quantity, rate, amount, taxable)
        VALUES (?,?,?,?,?,?,?)`).run(invoiceId, type, desc, qty, rate, amount, taxable);
    await add('RENT', 'Monthly Rent', 1, rent, rent, plan && plan.gst_applicable ? 1 : 0);
    if (maintenance > 0) await add('MAINTENANCE', 'Maintenance Charge', 1, maintenance, maintenance, plan && plan.gst_applicable ? 1 : 0);
    if (water > 0) await add('WATER', 'Water Charge', 1, water, water, 0);
    if (other > 0) await add('OTHER', 'Other Charges', 1, other, other, plan && plan.gst_applicable ? 1 : 0);
    return invoiceId;
  });
  const invoiceId = await txn();
  const tenant = await db.prepare(`SELECT * FROM tenants WHERE tenant_id = ?`).get(ag.tenant_id);
  const prop = await db.prepare(`SELECT property_name FROM properties WHERE property_id = ?`).get(ag.property_id);
  const lines = [
    `Monthly Rent: ${money(rent)}`,
    ...(maintenance > 0 ? [`Maintenance Charge: ${money(maintenance)}`] : []),
    ...(water > 0 ? [`Water Charge: ${money(water)}`] : []),
    ...(other > 0 ? [`Other Charges: ${money(other)}`] : []),
    ...(cgst + sgst > 0 ? [`GST: ${money(cgst + sgst)}`] : []),
  ];
  const invoiceDetail = [
    `Rent invoice ${invoiceNumber} (${monthStart.slice(0, 7)})`,
    ``,
    `Tenant: ${tenant ? tenant.full_name : ''}`,
    `Property: ${prop ? prop.property_name : ''}`,
    `Due date: ${dueDate}`,
    ``,
    ...lines,
    ``,
    `Total due: ${money(total)}`,
  ].join('\n');
  events.dispatch({
    eventCode: 'RENT_GENERATED', tenantId: ag.tenant_id,
    vars: { tenant_name: tenant ? tenant.full_name : '', amount: total, due_date: dueDate, invoice_number: invoiceNumber, invoice_detail: invoiceDetail, email: tenant ? tenant.email : null, mobile: tenant ? tenant.mobile : null },
  }).catch(() => {});
  return { invoiceId, invoiceNumber };
}

// generate_monthly_rent(invoice_month): loop active agreements, skip existing.
async function generateMonthlyRent(invoiceMonth) {
  const monthStart = monthKey(invoiceMonth);
  const lastDay = new Date(new Date(monthStart).getFullYear(), new Date(monthStart).getMonth() + 1, 0).toISOString().slice(0, 10);
  const rows = await db.prepare(`SELECT agreement_id FROM rental_agreements
    WHERE status = 'ACTIVE' AND date(start_date) <= date(?) AND (end_date IS NULL OR date(end_date) >= date(?))`)
    .all(lastDay, monthStart);
  let created = 0, skipped = 0;
  for (const r of rows) {
    const res = await generateRentInvoice(r.agreement_id, monthStart);
    if (res.skipped) skipped++; else created++;
  }
  return { created, skipped, month: monthStart };
}

// Internal: recompute invoice totals/status after payment change.
async function refreshInvoice(invoiceId, tdb = db) {
  const inv = await tdb.prepare(`SELECT * FROM rent_invoices WHERE invoice_id = ?`).get(invoiceId);
  if (!inv) return;
  const row = await tdb.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE invoice_id = ? AND status = 'SUCCESS'`).get(invoiceId);
  const paid = Number(row.s || 0);
  const outstanding = Math.max(Number(inv.total_amount) - paid, 0);
  const today = new Date().toISOString().slice(0, 10);
  let status = 'PENDING';
  if (paid >= Number(inv.total_amount) && Number(inv.total_amount) > 0) status = 'PAID';
  else if (paid > 0) status = 'PARTIALLY_PAID';
  else if (inv.due_date < today) status = 'OVERDUE';
  await tdb.prepare(`UPDATE rent_invoices SET paid_amount = ?, outstanding_amount = ?, status = ? WHERE invoice_id = ?`)
    .run(paid, outstanding, status, invoiceId);
}

// record_payment(invoice_id, amount, payment_mode, reference, attachment_paths)
async function recordPayment(invoiceId, amount, paymentMode, reference, attachmentPaths = []) {
  if (!(Number(amount) > 0)) throw Object.assign(new Error('Payment amount must be greater than 0'), { status: 400 });
  const inv = await db.prepare(`SELECT * FROM rent_invoices WHERE invoice_id = ?`).get(invoiceId);
  if (!inv) throw Object.assign(new Error('Invoice not found'), { status: 404 });
  if (Number(amount) - Number(inv.outstanding_amount) > 0.005)
    throw Object.assign(new Error(`Amount exceeds the outstanding balance of ${inv.outstanding_amount}`), { status: 400 });

  const today = new Date().toISOString().slice(0, 10);
  const txn = db.transaction(async (tdb) => {
    const p = await tdb.prepare(`INSERT INTO payments (invoice_id, tenant_id, payment_reference, amount, payment_mode, status)
      VALUES (?,?,?,?,?,'SUCCESS')`).run(invoiceId, inv.tenant_id, reference || null, Number(amount), paymentMode);
    const paymentId = p.lastInsertRowid;
    await refreshInvoice(invoiceId, tdb);
    // auto-create receipt (idempotent per payment)
    const d = today.replace(/-/g, '');
    const receiptNumber = `RCT-${d}-${pad(paymentId, 6, '0')}`;
    await tdb.prepare(`INSERT INTO receipts (payment_id, receipt_number, amount) VALUES (?,?,?)`)
      .run(paymentId, receiptNumber, Number(amount));
    await tdb.prepare(`INSERT INTO payment_transactions (payment_id, amount, transaction_status, transaction_date)
      VALUES (?,?, 'SUCCESS', datetime('now'))`).run(paymentId, Number(amount));
    // reference images linked to payment
    for (const ap of (attachmentPaths || []).filter(Boolean)) {
      await tdb.prepare(`INSERT INTO documents (document_type, entity_type, entity_id, file_name, file_path)
        VALUES ('PAYMENT_PROOF','payment',?,?,?)`).run(paymentId, String(ap).split('/').pop(), ap);
    }
    // Double-entry accounting posting
    const isCash = String(paymentMode).toUpperCase() === 'CASH';
    await recordJournalEntry(tdb, {
      debitCode: isCash ? '1001' : '1002',
      debitName: isCash ? 'Cash on Hand' : 'Bank Account',
      debitType: 'ASSET',
      creditCode: '4001',
      creditName: 'Rental Income',
      creditType: 'INCOME',
      amount: Number(amount),
      date: today,
      refType: 'PAYMENT',
      refId: paymentId,
      desc: `Rent payment for invoice ${inv.invoice_number} via ${paymentMode}`,
    });
    return { paymentId, receiptNumber };
  });
  const out = await txn();
  const tenant = await db.prepare(`SELECT * FROM tenants WHERE tenant_id = ?`).get(inv.tenant_id);
  const invNow = await db.prepare(`SELECT * FROM rent_invoices WHERE invoice_id = ?`).get(invoiceId);
  const ctx = await db.prepare(`SELECT p.property_name, o.organization_name
    FROM rental_agreements a LEFT JOIN properties p ON p.property_id = a.property_id
    LEFT JOIN organizations o ON o.organization_id = p.organization_id
    WHERE a.agreement_id = ?`).get(inv.agreement_id);
  const receiptDetail = [
    `Rent receipt ${out.receiptNumber} dated ${today}`,
    ``,
    `Organization: ${ctx ? ctx.organization_name || '' : ''}`,
    `Property: ${ctx ? ctx.property_name || '' : ''}`,
    `Tenant: ${tenant ? tenant.full_name : ''}`,
    `Invoice: ${invNow.invoice_number} (${String(invNow.invoice_month).slice(0, 10)})`,
    `Payment mode: ${paymentMode}`,
    `Payment reference: ${reference || '-'}`,
    `Payment date: ${today}`,
    ``,
    `Amount received: ${money(amount)}`,
    ``,
    `Invoice ${invNow.invoice_number} now shows ${money(invNow.paid_amount)} paid, ${money(invNow.outstanding_amount)} outstanding.`,
  ].join('\n');
  events.dispatch({
    eventCode: 'PAYMENT_SUCCESS', tenantId: inv.tenant_id,
    vars: { tenant_name: tenant ? tenant.full_name : '', amount, receipt_number: out.receiptNumber, receipt_detail: receiptDetail, email: tenant ? tenant.email : null, mobile: tenant ? tenant.mobile : null },
  }).catch(() => {});
  return out;
}

// mark_overdue_invoices(): flip newly overdue rows, notify only those.
async function markOverdueInvoices() {
  const fresh = await db.prepare(`SELECT invoice_id FROM rent_invoices
    WHERE outstanding_amount > 0 AND date(due_date) < date('now') AND status IN ('PENDING','PARTIALLY_PAID')`).all();
  await db.prepare(`UPDATE rent_invoices SET status = 'OVERDUE'
    WHERE outstanding_amount > 0 AND date(due_date) < date('now') AND status IN ('PENDING','PARTIALLY_PAID')`).run();
  const rows = [];
  for (const f of fresh.slice(0, 50)) {
    const r = await db.prepare(`SELECT i.*, t.full_name, t.email, t.mobile FROM rent_invoices i
      JOIN tenants t ON t.tenant_id = i.tenant_id WHERE i.invoice_id = ?`).get(f.invoice_id);
    if (r) rows.push(r);
  }
  for (const r of rows) {
    events.dispatch({
      eventCode: 'PAYMENT_OVERDUE', tenantId: r.tenant_id,
      vars: { tenant_name: r.full_name, amount: r.outstanding_amount, due_date: r.due_date, invoice_number: r.invoice_number, email: r.email, mobile: r.mobile },
    }).catch(() => {});
  }
  return { marked: fresh.length };
}

// tenant_statement(tenant_id, from_date, to_date)
async function tenantStatement(tenantId, fromDate, toDate) {
  const inv = await db.prepare(`SELECT invoice_date AS transaction_date, 'INVOICE' AS transaction_type,
      invoice_number AS reference_no, total_amount AS debit, 0 AS credit, outstanding_amount
    FROM rent_invoices WHERE tenant_id = ? AND date(invoice_date) BETWEEN date(?) AND date(?)`).all(tenantId, fromDate, toDate);
  const pay = await db.prepare(`SELECT payment_date AS transaction_date, 'PAYMENT' AS transaction_type,
      COALESCE(payment_reference, 'PAY-' || payment_id) AS reference_no, 0 AS debit, amount AS credit, NULL AS outstanding_amount
    FROM payments WHERE tenant_id = ? AND status = 'SUCCESS' AND date(payment_date) BETWEEN date(?) AND date(?)`).all(tenantId, fromDate, toDate);
  return [...inv, ...pay].sort((a, b) => String(a.transaction_date).localeCompare(String(b.transaction_date)));
}

// Occupancy transitions
async function occupyForAgreement(ag) {
  if (ag.bed_id) await db.prepare(`UPDATE beds SET status = 'OCCUPIED' WHERE bed_id = ?`).run(ag.bed_id);
  if (ag.unit_id) {
    const avail = await db.prepare(`SELECT COUNT(*) AS c FROM beds WHERE unit_id = ? AND status = 'AVAILABLE'`).get(ag.unit_id);
    const status = Number(avail.c) > 0 ? 'PARTIALLY_OCCUPIED' : 'OCCUPIED';
    await db.prepare(`UPDATE units SET status = ?, updated_at = datetime('now') WHERE unit_id = ?`).run(status, ag.unit_id);
  }
}

async function releaseForAgreement(ag) {
  if (ag.bed_id) await db.prepare(`UPDATE beds SET status = 'AVAILABLE' WHERE bed_id = ?`).run(ag.bed_id);
  if (ag.unit_id) {
    const occ = await db.prepare(`SELECT COUNT(*) AS c FROM beds WHERE unit_id = ? AND status = 'OCCUPIED'`).get(ag.unit_id);
    const avail = await db.prepare(`SELECT COUNT(*) AS c FROM beds WHERE unit_id = ? AND status = 'AVAILABLE'`).get(ag.unit_id);
    let status = 'AVAILABLE';
    if (Number(occ.c) > 0 && Number(avail.c) > 0) status = 'PARTIALLY_OCCUPIED';
    else if (Number(occ.c) > 0) status = 'OCCUPIED';
    await db.prepare(`UPDATE units SET status = ?, updated_at = datetime('now') WHERE unit_id = ?`).run(status, ag.unit_id);
  }
}

// Section 24: Expense recording with ledger integration
async function recordExpense(data, userId) {
  const { property_id, building_id, vendor_id, category_id, expense_date, invoice_number, amount, gst_amount, payment_mode, attachment_path, remarks } = data;
  if (!(Number(amount) > 0)) throw Object.assign(new Error('Expense amount must be greater than 0'), { status: 400 });
  const dateStr = expense_date || new Date().toISOString().slice(0, 10);
  const txn = db.transaction(async (tdb) => {
    const info = await tdb.prepare(`INSERT INTO expenses
      (property_id, building_id, vendor_id, category_id, expense_date, invoice_number, amount, gst_amount, payment_mode, attachment_path, remarks, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      property_id, building_id || null, vendor_id || null, category_id, dateStr,
      invoice_number || null, Number(amount), Number(gst_amount || 0), payment_mode || 'BANK_TRANSFER',
      attachment_path || null, remarks || null, userId || null);
    const expenseId = info.lastInsertRowid;
    // Double entry to ledger
    const isCash = String(payment_mode).toUpperCase() === 'CASH';
    const creditCode = isCash ? '1001' : '1002';
    const creditName = isCash ? 'Cash on Hand' : 'Bank Account';
    await recordJournalEntry(tdb, {
      debitCode: '5007', debitName: 'Operating Expenses', debitType: 'EXPENSE',
      creditCode, creditName, creditType: 'ASSET',
      amount: Number(amount),
      date: dateStr,
      refType: 'EXPENSE',
      refId: expenseId,
      desc: `Expense #${expenseId}: ${remarks || 'Operating Expense'}`,
      userId,
    });
    return expenseId;
  });
  const expenseId = await txn();
  return { expense_id: expenseId, ...data };
}

// Section 30: Move-out workflow & settlement
async function moveOutAgreement(agreementId, payload = {}, userId = null) {
  const ag = await db.prepare(`SELECT * FROM rental_agreements WHERE agreement_id = ?`).get(agreementId);
  if (!ag) throw Object.assign(new Error('Agreement not found'), { status: 404 });
  if (ag.status !== 'ACTIVE') throw Object.assign(new Error(`Agreement is not active (current status: ${ag.status})`), { status: 400 });

  const moveOutDate = payload.move_out_date || new Date().toISOString().slice(0, 10);
  const damage = Number(payload.damage_charges || 0);
  const utility = Number(payload.utility_charges || 0);
  const other = Number(payload.other_charges || 0);
  const remarks = payload.remarks || 'Tenant Move-Out & Final Settlement';

  // Compute unpaid rent dues
  const dueRow = await db.prepare(`SELECT COALESCE(SUM(outstanding_amount),0) AS total_due FROM rent_invoices WHERE agreement_id = ?`).get(agreementId);
  const pendingRent = Number(dueRow.total_due || 0);

  // Security deposit lookup
  const deposit = await db.prepare(`SELECT * FROM security_deposits WHERE agreement_id = ? ORDER BY deposit_id DESC LIMIT 1`).get(agreementId);
  const depositHeld = deposit ? Number(deposit.received_amount || deposit.deposit_amount || 0) : 0;
  const totalDeductions = damage + utility + other + pendingRent;
  const refundAmount = Math.max(0, depositHeld - totalDeductions);
  const settlementBalance = totalDeductions - depositHeld; // > 0 means tenant owes money, <= 0 means tenant gets refund

  const txn = db.transaction(async (tdb) => {
    // 1. Update agreement
    await tdb.prepare(`UPDATE rental_agreements SET status = 'TERMINATED', end_date = ? WHERE agreement_id = ?`).run(moveOutDate, agreementId);
    // 2. Release room / bed
    if (ag.bed_id) await tdb.prepare(`UPDATE beds SET status = 'AVAILABLE' WHERE bed_id = ?`).run(ag.bed_id);
    if (ag.unit_id) {
      const occ = await tdb.prepare(`SELECT COUNT(*) AS c FROM beds WHERE unit_id = ? AND status = 'OCCUPIED'`).get(ag.unit_id);
      const avail = await tdb.prepare(`SELECT COUNT(*) AS c FROM beds WHERE unit_id = ? AND status = 'AVAILABLE'`).get(ag.unit_id);
      let unitStatus = 'AVAILABLE';
      if (Number(occ.c) > 0 && Number(avail.c) > 0) unitStatus = 'PARTIALLY_OCCUPIED';
      else if (Number(occ.c) > 0) unitStatus = 'OCCUPIED';
      await tdb.prepare(`UPDATE units SET status = ?, updated_at = datetime('now') WHERE unit_id = ?`).run(unitStatus, ag.unit_id);
    }
    // 3. Update security deposit if present
    if (deposit) {
      await tdb.prepare(`UPDATE security_deposits SET
        damage_adjustment = ?, pending_rent_adjustment = ?, utility_adjustment = ?,
        other_adjustment = ?, refund_amount = ?, status = 'ADJUSTED', refund_date = ?, remarks = ?
        WHERE deposit_id = ?`).run(damage, pendingRent, utility, other, refundAmount, moveOutDate, remarks, deposit.deposit_id);
      // Accounting entry for deposit refund/adjustment
      if (depositHeld > 0) {
        await recordJournalEntry(tdb, {
          debitCode: '2001', debitName: 'Security Deposits Held', debitType: 'LIABILITY',
          creditCode: refundAmount > 0 ? '1002' : '4001',
          creditName: refundAmount > 0 ? 'Bank Account' : 'Rental Income',
          creditType: refundAmount > 0 ? 'ASSET' : 'INCOME',
          amount: depositHeld,
          date: moveOutDate,
          refType: 'DEPOSIT_SETTLEMENT',
          refId: deposit.deposit_id,
          desc: `Move-out deposit settlement for agreement ${ag.agreement_number}`,
          userId,
        });
      }
    }
    return { agreementId: Number(agreementId), moveOutDate, depositHeld, pendingRent, damage, utility, other, totalDeductions, refundAmount, settlementBalance };
  });

  const result = await txn();
  const tenant = await db.prepare(`SELECT * FROM tenants WHERE tenant_id = ?`).get(ag.tenant_id);
  events.dispatch({
    eventCode: 'MOVE_OUT_COMPLETED', tenantId: ag.tenant_id,
    vars: { tenant_name: tenant ? tenant.full_name : '', refund_amount: refundAmount, email: tenant ? tenant.email : null, mobile: tenant ? tenant.mobile : null },
  }).catch(() => {});
  return result;
}

// Section 29: Security deposit refund
async function refundSecurityDeposit(depositId, payload = {}, userId = null) {
  const dep = await db.prepare(`SELECT * FROM security_deposits WHERE deposit_id = ?`).get(depositId);
  if (!dep) throw Object.assign(new Error('Security deposit not found'), { status: 404 });
  const refundDate = payload.refund_date || new Date().toISOString().slice(0, 10);
  const damage = Number(payload.damage_adjustment || 0);
  const pendingRent = Number(payload.pending_rent_adjustment || 0);
  const utility = Number(payload.utility_adjustment || 0);
  const other = Number(payload.other_adjustment || 0);
  const totalDeductions = damage + pendingRent + utility + other;
  const depositAmount = Number(dep.received_amount || dep.deposit_amount || 0);
  const refundAmount = payload.refund_amount !== undefined ? Number(payload.refund_amount) : Math.max(0, depositAmount - totalDeductions);
  const status = refundAmount > 0 ? 'REFUNDED' : 'ADJUSTED';
  const remarks = payload.remarks || 'Deposit settlement completed';

  const txn = db.transaction(async (tdb) => {
    await tdb.prepare(`UPDATE security_deposits SET
      damage_adjustment = ?, pending_rent_adjustment = ?, utility_adjustment = ?,
      other_adjustment = ?, refund_amount = ?, status = ?, refund_date = ?, remarks = ?
      WHERE deposit_id = ?`).run(damage, pendingRent, utility, other, refundAmount, status, refundDate, remarks, depositId);

    if (refundAmount > 0) {
      await recordJournalEntry(tdb, {
        debitCode: '2001', debitName: 'Security Deposits Held', debitType: 'LIABILITY',
        creditCode: '1002', creditName: 'Bank Account', creditType: 'ASSET',
        amount: refundAmount,
        date: refundDate,
        refType: 'DEPOSIT_REFUND',
        refId: depositId,
        desc: `Security deposit refund #${depositId}`,
        userId,
      });
    }
    return { deposit_id: depositId, status, refund_amount: refundAmount, totalDeductions };
  });
  return await txn();
}

// Section 16 & 45: Automation & Reminder Engine
async function runReminderEngine() {
  const results = { rentReminders: 0, overdueReminders: 0, agreementExpiries: 0, taxReminders: 0 };
  // 1. Invoices due in 3 days or today
  const dueUpcoming = await db.prepare(`SELECT i.*, t.full_name, t.email, t.mobile FROM rent_invoices i
    JOIN tenants t ON t.tenant_id = i.tenant_id
    WHERE i.outstanding_amount > 0 AND i.status IN ('PENDING','PARTIALLY_PAID')
    AND date(i.due_date) IN (date('now'), date('now', '+3 days'))`).all();
  for (const inv of dueUpcoming) {
    events.dispatch({
      eventCode: 'RENT_REMINDER', tenantId: inv.tenant_id,
      vars: { tenant_name: inv.full_name, amount: inv.outstanding_amount, due_date: inv.due_date, invoice_number: inv.invoice_number, email: inv.email, mobile: inv.mobile },
    }).catch(() => {});
    results.rentReminders++;
  }

  // 2. Overdue detection & reminders
  const over = await markOverdueInvoices();
  results.overdueReminders = over.marked;

  // 3. Agreements expiring in 30 days
  const expiringAgreements = await db.prepare(`SELECT a.*, t.full_name, t.email, t.mobile FROM rental_agreements a
    JOIN tenants t ON t.tenant_id = a.tenant_id
    WHERE a.status = 'ACTIVE' AND date(a.end_date) BETWEEN date('now') AND date('now', '+30 days')`).all();
  for (const ag of expiringAgreements) {
    events.dispatch({
      eventCode: 'AGREEMENT_EXPIRING', tenantId: ag.tenant_id,
      vars: { tenant_name: ag.full_name, agreement_number: ag.agreement_number, end_date: ag.end_date, email: ag.email, mobile: ag.mobile },
    }).catch(() => {});
    results.agreementExpiries++;
  }

  // 4. Property taxes due within 30 days
  const taxesDue = await db.prepare(`SELECT pt.*, p.property_name FROM property_taxes pt
    JOIN properties p ON p.property_id = pt.property_id
    WHERE pt.status IN ('PENDING','PARTIALLY_PAID') AND date(pt.due_date) BETWEEN date('now') AND date('now', '+30 days')`).all();
  for (const pt of taxesDue) {
    results.taxReminders++;
  }
  return results;
}

// Section 36: Comprehensive Reports
async function getOccupancyReport() {
  const props = await db.prepare(`SELECT COUNT(*) AS c FROM properties WHERE status = 'ACTIVE'`).get();
  const buildings = await db.prepare(`SELECT COUNT(*) AS c FROM buildings WHERE status = 'ACTIVE'`).get();
  const floors = await db.prepare(`SELECT COUNT(*) AS c FROM floors WHERE status = 'ACTIVE'`).get();
  const unitsAll = await db.prepare(`SELECT status, COUNT(*) AS count FROM units GROUP BY status`).all();
  const bedsAll = await db.prepare(`SELECT status, COUNT(*) AS count FROM beds GROUP BY status`).all();

  const unitStats = { total: 0, occupied: 0, partially_occupied: 0, available: 0, maintenance: 0, blocked: 0 };
  for (const u of unitsAll) {
    const s = String(u.status).toLowerCase();
    unitStats.total += Number(u.count);
    if (unitStats[s] !== undefined) unitStats[s] = Number(u.count);
  }
  const bedStats = { total: 0, occupied: 0, available: 0, maintenance: 0, blocked: 0 };
  for (const b of bedsAll) {
    const s = String(b.status).toLowerCase();
    bedStats.total += Number(b.count);
    if (bedStats[s] !== undefined) bedStats[s] = Number(b.count);
  }
  const activeOccupied = unitStats.occupied + unitStats.partially_occupied;
  const occupancyRate = unitStats.total > 0 ? Number(((activeOccupied / unitStats.total) * 100).toFixed(1)) : 0;

  return {
    portfolio: { properties: Number(props.c || 0), buildings: Number(buildings.c || 0), floors: Number(floors.c || 0) },
    units: unitStats,
    beds: bedStats,
    occupancy_rate_pct: occupancyRate,
  };
}

async function getRentCollectionReport(fromMonth, toMonth) {
  let sql = `SELECT invoice_month,
    COUNT(*) as total_invoices,
    SUM(total_amount) as total_invoiced,
    SUM(paid_amount) as total_collected,
    SUM(outstanding_amount) as total_outstanding,
    SUM(CASE WHEN status = 'OVERDUE' THEN 1 ELSE 0 END) as overdue_invoices,
    SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END) as paid_invoices
    FROM rent_invoices`;
  const params = [];
  if (fromMonth && toMonth) {
    sql += ` WHERE invoice_month BETWEEN ? AND ?`;
    params.push(fromMonth, toMonth);
  }
  sql += ` GROUP BY invoice_month ORDER BY invoice_month DESC LIMIT 24`;
  const rows = await db.prepare(sql).all(...params);
  return rows.map(r => ({
    ...r,
    collection_rate_pct: Number(r.total_invoiced) > 0 ? Number(((Number(r.total_collected) / Number(r.total_invoiced)) * 100).toFixed(1)) : 0,
  }));
}

async function getFinancialReport(fromDate, toDate) {
  const f = fromDate || '2000-01-01';
  const t = toDate || '2099-12-31';

  // Income from payments
  const incomeRow = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS total_income
    FROM payments WHERE status = 'SUCCESS' AND date(payment_date) BETWEEN date(?) AND date(?)`).get(f, t);

  // Expenses by category
  const expenseRows = await db.prepare(`SELECT ec.category_name, COALESCE(SUM(e.amount),0) AS category_total
    FROM expense_categories ec
    LEFT JOIN expenses e ON e.category_id = ec.category_id AND date(e.expense_date) BETWEEN date(?) AND date(?)
    GROUP BY ec.category_id, ec.category_name`).all(f, t);

  const totalExpenseRow = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS total_expenses
    FROM expenses WHERE date(expense_date) BETWEEN date(?) AND date(?)`).get(f, t);

  const totalIncome = Number(incomeRow.total_income || 0);
  const totalExpenses = Number(totalExpenseRow.total_expenses || 0);
  const netProfit = totalIncome - totalExpenses;
  const marginPct = totalIncome > 0 ? Number(((netProfit / totalIncome) * 100).toFixed(1)) : 0;

  return {
    from_date: f,
    to_date: t,
    total_income: totalIncome,
    total_expenses: totalExpenses,
    net_profit: netProfit,
    profit_margin_pct: marginPct,
    expense_breakdown: expenseRows.filter(r => Number(r.category_total) > 0),
  };
}

async function getGstReport(fromDate, toDate) {
  const f = fromDate || '2000-01-01';
  const t = toDate || '2099-12-31';
  const row = await db.prepare(`SELECT
    COUNT(*) as invoice_count,
    COALESCE(SUM(taxable_amount),0) as taxable_amount,
    COALESCE(SUM(cgst),0) as total_cgst,
    COALESCE(SUM(sgst),0) as total_sgst,
    COALESCE(SUM(igst),0) as total_igst,
    COALESCE(SUM(cgst + sgst + igst),0) as total_gst
    FROM rent_invoices WHERE date(invoice_date) BETWEEN date(?) AND date(?)`).get(f, t);
  return { from_date: f, to_date: t, ...row };
}

async function getPropertyTaxReport() {
  const rows = await db.prepare(`SELECT pt.*, p.property_name, p.city FROM property_taxes pt
    JOIN properties p ON p.property_id = pt.property_id
    ORDER BY pt.due_date ASC`).all();
  const summary = await db.prepare(`SELECT
    COALESCE(SUM(tax_amount),0) as total_assessed,
    COALESCE(SUM(penalty),0) as total_penalty,
    COALESCE(SUM(CASE WHEN status = 'PAID' THEN tax_amount ELSE 0 END),0) as total_paid,
    COALESCE(SUM(CASE WHEN status != 'PAID' THEN tax_amount ELSE 0 END),0) as total_pending
    FROM property_taxes`).get();
  return { summary, records: rows };
}

async function getTenantReport() {
  const totalTenants = (await db.prepare(`SELECT COUNT(*) AS c FROM tenants`).get()).c;
  const activeTenants = (await db.prepare(`SELECT COUNT(*) AS c FROM tenants WHERE status = 'ACTIVE'`).get()).c;
  const kycBreakdown = await db.prepare(`SELECT status, COUNT(*) AS count FROM tenant_kyc GROUP BY status`).all();
  const docsCount = (await db.prepare(`SELECT COUNT(*) AS c FROM tenant_documents`).get()).c;
  return {
    total_tenants: Number(totalTenants),
    active_tenants: Number(activeTenants),
    kyc_status: kycBreakdown,
    total_documents_uploaded: Number(docsCount),
  };
}

async function getMaintenanceReport() {
  const compTotal = (await db.prepare(`SELECT COUNT(*) AS c FROM complaints`).get()).c;
  const statusBreakdown = await db.prepare(`SELECT status, COUNT(*) AS count FROM complaints GROUP BY status`).all();
  const catBreakdown = await db.prepare(`SELECT category, COUNT(*) AS count FROM complaints GROUP BY category`).all();
  const taskCost = await db.prepare(`SELECT COALESCE(SUM(estimated_cost),0) as total_estimated, COALESCE(SUM(actual_cost),0) as total_actual FROM maintenance_tasks`).get();
  return {
    total_complaints: Number(compTotal),
    by_status: statusBreakdown,
    by_category: catBreakdown,
    task_costs: taskCost,
  };
}

// Section 37: Global Search across portfolio
async function searchGlobal(query) {
  const q = String(query || '').trim();
  if (!q) return { tenants: [], properties: [], units: [], invoices: [], complaints: [], receipts: [] };
  const pat = `%${q}%`;

  const [tenants, properties, units, invoices, receipts, complaints] = await Promise.all([
    db.prepare(`SELECT tenant_id, full_name, mobile, email, status FROM tenants
      WHERE full_name LIKE ? OR mobile LIKE ? OR email LIKE ? LIMIT 10`).all(pat, pat, pat),
    db.prepare(`SELECT property_id, property_code, property_name, property_type, city FROM properties
      WHERE property_name LIKE ? OR property_code LIKE ? OR city LIKE ? LIMIT 10`).all(pat, pat, pat),
    db.prepare(`SELECT unit_id, unit_number, unit_type, status FROM units
      WHERE unit_number LIKE ? LIMIT 10`).all(pat),
    db.prepare(`SELECT invoice_id, invoice_number, invoice_month, total_amount, outstanding_amount, status FROM rent_invoices
      WHERE invoice_number LIKE ? LIMIT 10`).all(pat),
    db.prepare(`SELECT receipt_id, receipt_number, amount, receipt_date FROM receipts
      WHERE receipt_number LIKE ? LIMIT 10`).all(pat),
    db.prepare(`SELECT complaint_id, complaint_number, title, category, status FROM complaints
      WHERE complaint_number LIKE ? OR title LIKE ? LIMIT 10`).all(pat, pat),
  ]);

  return { tenants, properties, units, invoices, receipts, complaints };
}

module.exports = {
  generateRentInvoice,
  generateMonthlyRent,
  recordPayment,
  refreshInvoice,
  markOverdueInvoices,
  tenantStatement,
  occupyForAgreement,
  releaseForAgreement,
  recordExpense,
  moveOutAgreement,
  refundSecurityDeposit,
  runReminderEngine,
  getOccupancyReport,
  getRentCollectionReport,
  getFinancialReport,
  getGstReport,
  getPropertyTaxReport,
  getTenantReport,
  getMaintenanceReport,
  searchGlobal,
  ensureAccount,
  recordJournalEntry,
};
