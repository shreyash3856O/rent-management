const bcrypt = require('bcryptjs');
const db = require('./db');

function has(table) {
  try { return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c > 0; } catch { return false; }
}

function seed() {
  if (has('organizations')) { console.log('Seed skipped: data exists.'); return; }
  const txn = db.transaction(() => {
    const org = db.prepare(`INSERT INTO organizations (organization_name, registration_no, email, mobile, address, city, state, pin_code)
      VALUES ('ABC Property Management Pvt. Ltd.','REG-MH-2026-001','admin@abcproperty.com','9876543210','Mira Road East','Thane','Maharashtra','401107')`).run();
    const orgId = org.lastInsertRowid;
    for (const [n, d] of [['SUPER_ADMIN','Complete system access'],['PROPERTY_OWNER','Property owner access'],['PROPERTY_MANAGER','Property management access'],['ACCOUNTANT','Finance and accounting access'],['STAFF','Limited operational access'],['TENANT','Tenant mobile/web access']]) {
      db.prepare(`INSERT INTO roles (role_name, description) VALUES (?,?)`).run(n, d);
    }
    const perms = [];
    const mods = { PROPERTY: ['VIEW','ADD','EDIT','DELETE','APPROVE'], TENANT: ['VIEW','ADD','EDIT','DELETE','APPROVE'], RENT: ['VIEW','ADD','EDIT','APPROVE'], PAYMENT: ['VIEW','ADD','EDIT','APPROVE'], COMPLAINT: ['VIEW','ADD','EDIT','APPROVE'], REPORTS: ['VIEW'] };
    for (const [m, acts] of Object.entries(mods)) for (const a of acts) {
      const r = db.prepare(`INSERT INTO permissions (module_name, permission_name) VALUES (?,?)`).run(m, a);
      perms.push(r.lastInsertRowid);
    }
    // SUPER_ADMIN gets everything
    const all = db.prepare(`SELECT permission_id FROM permissions`).all();
    for (const p of all) db.prepare(`INSERT INTO role_permissions (role_id, permission_id, can_view, can_add, can_edit, can_delete, can_approve) VALUES (1,?,1,1,1,1,1)`).run(p.permission_id);
    // OWNER/MANAGER broad, ACCOUNTANT rent+payment, STAFF complaint, TENANT minimal
    const grant = (roleId, modules, level) => {
      for (const p of db.prepare(`SELECT * FROM permissions`).all()) {
        if (!modules.includes(p.module_name)) continue;
        db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_id, can_view, can_add, can_edit, can_delete, can_approve)
          VALUES (?,?,?,?,?,?,?)`).run(roleId, p.permission_id, 1, level >= 1 ? 1 : 0, level >= 1 ? 1 : 0, level >= 2 ? 1 : 0, level >= 2 ? 1 : 0);
      }
    };
    grant(2, ['PROPERTY','TENANT','RENT','PAYMENT','COMPLAINT','REPORTS'], 2);
    grant(3, ['PROPERTY','TENANT','RENT','PAYMENT','COMPLAINT'], 1);
    grant(4, ['RENT','PAYMENT','REPORTS'], 1);
    grant(5, ['COMPLAINT'], 1);

    const hash = bcrypt.hashSync('admin123', 10);
    const users = [
      ['System Administrator','admin@abcproperty.com','9876543210',1],
      ['Rajesh Sharma','owner@abcproperty.com','9876543211',2],
      ['Priya Manager','manager@abcproperty.com','9876543212',3],
      ['Amit Accountant','accounts@abcproperty.com','9876543213',4],
    ];
    const userIds = [];
    for (const [n, e, m, r] of users) {
      const u = db.prepare(`INSERT INTO users (organization_id, role_id, full_name, email, mobile, password_hash, status) VALUES (?,?,?,?,?,?, 'ACTIVE')`).run(orgId, r, n, e, m, hash);
      userIds.push(u.lastInsertRowid);
    }
    const prop = db.prepare(`INSERT INTO properties (organization_id, owner_id, property_code, property_name, property_type, address, city, state, pin_code, built_up_area, carpet_area)
      VALUES (?,?, 'ABC-MR-001','ABC PG Mira Road','PG','Mira Road East','Thane','Maharashtra','401107',12000,9500)`).run(orgId, userIds[1]);
    const propId = prop.lastInsertRowid;
    const bld = db.prepare(`INSERT INTO buildings (property_id, building_code, building_name, number_of_floors, building_type, parking_available, lift_available, security_available)
      VALUES (?,?, 'Building A', 2, 'PG Building',1,1,1)`).run(propId, 'BLD-A');
    const bldId = bld.lastInsertRowid;
    const f1 = db.prepare(`INSERT INTO floors (building_id, floor_number, floor_name) VALUES (?,?,?)`).run(bldId, 1, 'First Floor');
    const f2 = db.prepare(`INSERT INTO floors (building_id, floor_number, floor_name) VALUES (?,?,?)`).run(bldId, 2, 'Second Floor');
    const u1 = db.prepare(`INSERT INTO units (floor_id, unit_number, unit_type, sharing_type, monthly_rent, security_deposit, water_charge, maintenance_charge, late_fee, status)
      VALUES (?,?,?,?,?,?,?,?,?, 'PARTIALLY_OCCUPIED')`).run(f1.lastInsertRowid, '101', 'PG Room', '4 Sharing', 15000, 30000, 300, 1000, 100);
    const u2 = db.prepare(`INSERT INTO units (floor_id, unit_number, unit_type, sharing_type, monthly_rent, security_deposit, water_charge, maintenance_charge, late_fee, status)
      VALUES (?,?,?,?,?,?,?,?,?, 'AVAILABLE')`).run(f2.lastInsertRowid, '201', 'PG Room', '2 Sharing', 20000, 40000, 300, 1200, 100);
    const bedIds = [];
    for (const b of ['A','B','C','D']) {
      const r = db.prepare(`INSERT INTO beds (unit_id, bed_number, bed_type, monthly_rent, security_deposit, status) VALUES (?,?,?,?,?,?)`)
        .run(u1.lastInsertRowid, b, 'Single Bed', 15000, 30000, b === 'A' ? 'OCCUPIED' : 'AVAILABLE');
      bedIds.push(r.lastInsertRowid);
    }
    for (const b of ['A','B']) {
      db.prepare(`INSERT INTO beds (unit_id, bed_number, bed_type, monthly_rent, security_deposit, status) VALUES (?,?,?,?,?,?)`)
        .run(u2.lastInsertRowid, b, 'Single Bed', 20000, 40000, 'AVAILABLE');
    }
    const t1 = db.prepare(`INSERT INTO tenants (full_name, mobile, email, gender, occupation, id_type, id_number, status)
      VALUES ('Rahul Patil','9000000001','rahul@example.com','MALE','Software Engineer','AADHAAR','XXXX-XXXX-1111','ACTIVE')`).run();
    db.prepare(`INSERT INTO tenants (full_name, mobile, email, gender, occupation, id_type, id_number, status)
      VALUES ('Neha Shah','9000000002','neha@example.com','FEMALE','Designer','PAN','ABCDE1234P','ACTIVE')`).run();
    db.prepare(`INSERT INTO tenant_kyc (tenant_id, status, submitted_at, verification_date, verified_by, remarks) VALUES (?, 'VERIFIED', datetime('now'), datetime('now'), ?, 'Documents verified')`).run(t1.lastInsertRowid, userIds[2]);
    db.prepare(`INSERT INTO tenant_documents (tenant_id, document_type, document_number, file_path, verification_status, verified_by, verified_at) VALUES (?, 'AADHAAR','XXXX-XXXX-1111','/documents/tenant1/aadhaar.pdf','VERIFIED',?,datetime('now'))`).run(t1.lastInsertRowid, userIds[2]);
    const plan = db.prepare(`INSERT INTO rent_plans (property_id, plan_name, base_rent, maintenance_charge, water_charge, electricity_mode, security_deposit, late_fee, due_day, gst_applicable)
      VALUES (?, 'Standard PG Plan', 15000, 1000, 300, 'ACTUAL', 30000, 100, 5, 0)`).run(propId);
    db.prepare(`INSERT INTO rental_agreements (tenant_id, property_id, unit_id, bed_id, rent_plan_id, agreement_number, start_date, end_date, monthly_rent, security_deposit, due_day, notice_period_days, late_fee, status, signed_date)
      VALUES (?,?,?,?,?, 'AGR-2026-0001','2026-09-01','2027-08-31',15000,30000,5,30,100,'ACTIVE','2026-08-30')`)
      .run(t1.lastInsertRowid, propId, u1.lastInsertRowid, bedIds[0], plan.lastInsertRowid);
    db.prepare(`INSERT INTO security_deposits (tenant_id, agreement_id, deposit_amount, received_amount, status, received_date) VALUES (?,?,30000,30000,'HELD','2026-09-01')`).run(t1.lastInsertRowid, 1);
    for (const [name, code, ch, subj, msg] of [
      ['Rent Invoice Email','RENT_GENERATED','EMAIL','Rent invoice {{amount}} due {{due_date}}','Dear {{tenant_name}}, your rent invoice of Rs.{{amount}} is due on {{due_date}}.'],
      ['Payment Receipt Email','PAYMENT_SUCCESS','EMAIL','Rent Payment Receipt','Dear {{tenant_name}}, your payment of Rs.{{amount}} has been received. Receipt: {{receipt_number}}.'],
      ['Overdue Email','PAYMENT_OVERDUE','EMAIL','Rent overdue','Dear {{tenant_name}}, Rs.{{amount}} is overdue since {{due_date}}.'],
      ['Rent Invoice InApp','RENT_GENERATED','IN_APP',null,'Invoice of Rs.{{amount}} due {{due_date}}.'],
      ['Payment InApp','PAYMENT_SUCCESS','IN_APP',null,'Payment of Rs.{{amount}} received. Receipt {{receipt_number}}.'],
      ['Overdue InApp','PAYMENT_OVERDUE','IN_APP',null,'Rs.{{amount}} overdue since {{due_date}}.'],
    ]) db.prepare(`INSERT INTO notification_templates (template_name, event_code, channel, subject, message_template) VALUES (?,?,?,?,?)`).run(name, code, ch, subj, msg);
    for (const [k, v, g] of [['CURRENCY','INR','GENERAL'],['CURRENCY_SYMBOL','Rs.','GENERAL'],['DEFAULT_DUE_DAY','5','RENT']])
      db.prepare(`INSERT INTO settings (organization_id, setting_key, setting_value, setting_group) VALUES (?,?,?,?)`).run(orgId, k, v, g);
  });
  txn();
  console.log('Seed complete. Admin login: admin@abcproperty.com / admin123. Tenant OTP mobile: 9000000001 (OTP printed in API response for demo).');
}

if (require.main === module) seed();
module.exports = seed;
