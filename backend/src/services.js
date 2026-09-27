// Billing + occupancy services (application-layer equivalent of stored
// procedures/triggers; one consistent approach). All financial writes run in
// transactions and emit events on the central bus.
const db = require('./db');
const events = require('./events');

function pad(n, w) { return String(n).padStart(w, '0'); }
function monthKey(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1, 2)}-01`;
}
function yyyymm(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}${pad(dt.getMonth() + 1, 2)}`;
}

// generate_rent_invoice(agreement_id, invoice_month)
function generateRentInvoice(agreementId, invoiceMonth) {
  const monthStart = monthKey(invoiceMonth);
  const ag = db.prepare(`SELECT * FROM rental_agreements WHERE agreement_id = ? AND status = 'ACTIVE'`).get(agreementId);
  if (!ag) throw Object.assign(new Error('Agreement not active or not found'), { status: 404 });
  const dup = db.prepare(`SELECT 1 FROM rent_invoices WHERE agreement_id = ? AND invoice_month = ?`).get(agreementId, monthStart);
  if (dup) return { skipped: true, agreementId };

  const plan = ag.rent_plan_id
    ? db.prepare(`SELECT * FROM rent_plans WHERE rent_plan_id = ?`).get(ag.rent_plan_id)
    : null;
  const maintenance = plan ? Number(plan.maintenance_charge || 0) : 0;
  const water = plan ? Number(plan.water_charge || 0) : 0;
  const other = Number(ag.other_charges || 0);
  const rent = Number(ag.monthly_rent || 0);
  const total = rent + maintenance + water + other; // GST hook present but 0 in MVP
  const dueDay = Math.min(Math.max(Number(ag.due_day || 5), 1), 28);
  const y = new Date(monthStart).getFullYear();
  const m = new Date(monthStart).getMonth();
  const dueDate = `${y}-${pad(m + 1, 2)}-${pad(dueDay, 2)}`;
  const invoiceNumber = `INV-${yyyymm(monthStart)}-${pad(agreementId, 6, '0')}`;

  const txn = db.transaction(() => {
    const info = db.prepare(`INSERT INTO rent_invoices
      (tenant_id, agreement_id, invoice_number, invoice_month, invoice_date, due_date,
       base_rent, maintenance, water, other_charges, taxable_amount, total_amount, outstanding_amount, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'PENDING')`).run(
      ag.tenant_id, agreementId, invoiceNumber, monthStart, monthStart, dueDate,
      rent, maintenance, water, other, total, total, total);
    const invoiceId = info.lastInsertRowid;
    const add = db.prepare(`INSERT INTO invoice_items (invoice_id, item_type, description, quantity, rate, amount, taxable)
      VALUES (?,?,?,?,?,?,0)`);
    add.run(invoiceId, 'RENT', 'Monthly Rent', 1, rent, rent);
    if (maintenance > 0) add.run(invoiceId, 'MAINTENANCE', 'Maintenance Charge', 1, maintenance, maintenance);
    if (water > 0) add.run(invoiceId, 'WATER', 'Water Charge', 1, water, water);
    if (other > 0) add.run(invoiceId, 'OTHER', 'Other Charges', 1, other, other);
    return invoiceId;
  });
  const invoiceId = txn();
  const tenant = db.prepare(`SELECT * FROM tenants WHERE tenant_id = ?`).get(ag.tenant_id);
  events.dispatch({
    eventCode: 'RENT_GENERATED', tenantId: ag.tenant_id,
    vars: { tenant_name: tenant ? tenant.full_name : '', amount: total, due_date: dueDate, email: tenant ? tenant.email : null, mobile: tenant ? tenant.mobile : null },
  }).catch(() => {});
  return { invoiceId, invoiceNumber };
}

// generate_monthly_rent(invoice_month): loop active agreements, skip existing.
function generateMonthlyRent(invoiceMonth) {
  const monthStart = monthKey(invoiceMonth);
  const lastDay = new Date(new Date(monthStart).getFullYear(), new Date(monthStart).getMonth() + 1, 0).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT agreement_id FROM rental_agreements
    WHERE status = 'ACTIVE' AND date(start_date) <= date(?) AND (end_date IS NULL OR date(end_date) >= date(?))`)
    .all(lastDay, monthStart);
  let created = 0, skipped = 0;
  for (const r of rows) {
    const res = generateRentInvoice(r.agreement_id, monthStart);
    if (res.skipped) skipped++; else created++;
  }
  return { created, skipped, month: monthStart };
}

// Internal: recompute invoice totals/status after payment change.
// Enforces: invoice can only reach PAID via real SUCCESS payment rows.
function refreshInvoice(invoiceId) {
  const inv = db.prepare(`SELECT * FROM rent_invoices WHERE invoice_id = ?`).get(invoiceId);
  if (!inv) return;
  const row = db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE invoice_id = ? AND status = 'SUCCESS'`).get(invoiceId);
  const paid = Number(row.s || 0);
  const outstanding = Math.max(Number(inv.total_amount) - paid, 0);
  const today = new Date().toISOString().slice(0, 10);
  let status = 'PENDING';
  if (paid >= Number(inv.total_amount) && Number(inv.total_amount) > 0) status = 'PAID';
  else if (paid > 0) status = 'PARTIALLY_PAID';
  else if (inv.due_date < today) status = 'OVERDUE';
  db.prepare(`UPDATE rent_invoices SET paid_amount = ?, outstanding_amount = ?, status = ? WHERE invoice_id = ?`)
    .run(paid, outstanding, status, invoiceId);
}

// record_payment(invoice_id, amount, payment_mode, reference)
function recordPayment(invoiceId, amount, paymentMode, reference) {
  if (!(Number(amount) > 0)) throw Object.assign(new Error('Payment amount must be greater than 0'), { status: 400 });
  const inv = db.prepare(`SELECT * FROM rent_invoices WHERE invoice_id = ?`).get(invoiceId);
  if (!inv) throw Object.assign(new Error('Invoice not found'), { status: 404 });
  const txn = db.transaction(() => {
    const p = db.prepare(`INSERT INTO payments (invoice_id, tenant_id, payment_reference, amount, payment_mode, status)
      VALUES (?,?,?,?,?,'SUCCESS')`).run(invoiceId, inv.tenant_id, reference || null, Number(amount), paymentMode);
    const paymentId = p.lastInsertRowid;
    refreshInvoice(invoiceId);
    // auto-create receipt (idempotent per payment)
    const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const receiptNumber = `RCT-${d}-${pad(paymentId, 6, '0')}`;
    db.prepare(`INSERT INTO receipts (payment_id, receipt_number, amount) VALUES (?,?,?)`)
      .run(paymentId, receiptNumber, Number(amount));
    db.prepare(`INSERT INTO payment_transactions (payment_id, amount, transaction_status, transaction_date)
      VALUES (?,?, 'SUCCESS', datetime('now'))`).run(paymentId, Number(amount));
    return { paymentId, receiptNumber };
  });
  const out = txn();
  const tenant = db.prepare(`SELECT * FROM tenants WHERE tenant_id = ?`).get(inv.tenant_id);
  events.dispatch({
    eventCode: 'PAYMENT_SUCCESS', tenantId: inv.tenant_id,
    vars: { tenant_name: tenant ? tenant.full_name : '', amount, receipt_number: out.receiptNumber, email: tenant ? tenant.email : null, mobile: tenant ? tenant.mobile : null },
  }).catch(() => {});
  return out;
}

// mark_overdue_invoices()
function markOverdueInvoices() {
  const info = db.prepare(`UPDATE rent_invoices SET status = 'OVERDUE'
    WHERE outstanding_amount > 0 AND date(due_date) < date('now') AND status IN ('PENDING','PARTIALLY_PAID')`).run();
  // notify overdue (best effort, cap 50 per run)
  const rows = db.prepare(`SELECT i.*, t.full_name, t.email, t.mobile FROM rent_invoices i
    JOIN tenants t ON t.tenant_id = i.tenant_id
    WHERE i.status = 'OVERDUE' AND i.outstanding_amount > 0 ORDER BY i.due_date LIMIT 50`).all();
  for (const r of rows) {
    events.dispatch({
      eventCode: 'PAYMENT_OVERDUE', tenantId: r.tenant_id,
      vars: { tenant_name: r.full_name, amount: r.outstanding_amount, due_date: r.due_date, email: r.email, mobile: r.mobile },
    }).catch(() => {});
  }
  return { marked: info.changes };
}

// tenant_statement(tenant_id, from_date, to_date)
function tenantStatement(tenantId, fromDate, toDate) {
  const inv = db.prepare(`SELECT invoice_date AS transaction_date, 'INVOICE' AS transaction_type,
      invoice_number AS reference_no, total_amount AS debit, 0 AS credit, outstanding_amount
    FROM rent_invoices WHERE tenant_id = ? AND date(invoice_date) BETWEEN date(?) AND date(?)`).all(tenantId, fromDate, toDate);
  const pay = db.prepare(`SELECT payment_date AS transaction_date, 'PAYMENT' AS transaction_type,
      COALESCE(payment_reference, 'PAY-' || payment_id) AS reference_no, 0 AS debit, amount AS credit, NULL AS outstanding_amount
    FROM payments WHERE tenant_id = ? AND status = 'SUCCESS' AND date(payment_date) BETWEEN date(?) AND date(?)`).all(tenantId, fromDate, toDate);
  return [...inv, ...pay].sort((a, b) => String(a.transaction_date).localeCompare(String(b.transaction_date)));
}

// Occupancy transitions (trigger equivalents)
function occupyForAgreement(ag) {
  if (ag.bed_id) db.prepare(`UPDATE beds SET status = 'OCCUPIED' WHERE bed_id = ?`).run(ag.bed_id);
  if (ag.unit_id) {
    const avail = db.prepare(`SELECT COUNT(*) AS c FROM beds WHERE unit_id = ? AND status = 'AVAILABLE'`).get(ag.unit_id);
    const status = Number(avail.c) > 0 ? 'PARTIALLY_OCCUPIED' : 'OCCUPIED';
    db.prepare(`UPDATE units SET status = ?, updated_at = datetime('now') WHERE unit_id = ?`).run(status, ag.unit_id);
  }
}
function releaseForAgreement(ag) {
  if (ag.bed_id) db.prepare(`UPDATE beds SET status = 'AVAILABLE' WHERE bed_id = ?`).run(ag.bed_id);
  if (ag.unit_id) {
    const occ = db.prepare(`SELECT COUNT(*) AS c FROM beds WHERE unit_id = ? AND status = 'OCCUPIED'`).get(ag.unit_id);
    const avail = db.prepare(`SELECT COUNT(*) AS c FROM beds WHERE unit_id = ? AND status = 'AVAILABLE'`).get(ag.unit_id);
    let status = 'AVAILABLE';
    if (Number(occ.c) > 0 && Number(avail.c) > 0) status = 'PARTIALLY_OCCUPIED';
    else if (Number(occ.c) > 0) status = 'OCCUPIED';
    db.prepare(`UPDATE units SET status = ?, updated_at = datetime('now') WHERE unit_id = ?`).run(status, ag.unit_id);
  }
}

module.exports = { generateRentInvoice, generateMonthlyRent, recordPayment, refreshInvoice, markOverdueInvoices, tenantStatement, occupyForAgreement, releaseForAgreement };
