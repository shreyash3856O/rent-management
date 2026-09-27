// SQLite schema ported 1:1 from property_rent_management_mysql51 spec.
// Modern constraints: real CHECK errors (no silent zeroing workaround).
const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
  organization_id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_name TEXT NOT NULL,
  registration_no TEXT, gstin TEXT, pan TEXT, email TEXT, mobile TEXT,
  address TEXT, city TEXT, state TEXT, pin_code TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS roles (
  role_id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS permissions (
  permission_id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_name TEXT NOT NULL,
  permission_name TEXT NOT NULL,
  UNIQUE (module_name, permission_name)
);
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(role_id),
  permission_id INTEGER NOT NULL REFERENCES permissions(permission_id),
  can_view INTEGER NOT NULL DEFAULT 0,
  can_add INTEGER NOT NULL DEFAULT 0,
  can_edit INTEGER NOT NULL DEFAULT 0,
  can_delete INTEGER NOT NULL DEFAULT 0,
  can_approve INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (role_id, permission_id)
);
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER REFERENCES organizations(organization_id),
  role_id INTEGER NOT NULL REFERENCES roles(role_id),
  full_name TEXT NOT NULL, email TEXT UNIQUE, mobile TEXT UNIQUE,
  password_hash TEXT,
  otp_enabled INTEGER NOT NULL DEFAULT 1,
  two_factor_enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','LOCKED')),
  last_login TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS properties (
  property_id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(organization_id),
  owner_id INTEGER REFERENCES users(user_id),
  property_code TEXT NOT NULL, property_name TEXT NOT NULL,
  property_type TEXT NOT NULL CHECK (property_type IN ('RESIDENTIAL','COMMERCIAL','APARTMENT','PG','HOSTEL','CO_LIVING','SHOP','OFFICE','WAREHOUSE','OTHER')),
  address TEXT, city TEXT, state TEXT, pin_code TEXT,
  latitude REAL, longitude REAL,
  property_size REAL, built_up_area REAL, carpet_area REAL,
  purchase_date TEXT, purchase_value REAL, current_value REAL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','UNDER_CONSTRUCTION','SOLD')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT,
  UNIQUE (organization_id, property_code)
);
CREATE TABLE IF NOT EXISTS buildings (
  building_id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(property_id),
  building_code TEXT NOT NULL, building_name TEXT NOT NULL,
  number_of_floors INTEGER NOT NULL DEFAULT 0,
  construction_year INTEGER, building_type TEXT, address TEXT,
  parking_available INTEGER NOT NULL DEFAULT 0,
  lift_available INTEGER NOT NULL DEFAULT 0,
  security_available INTEGER NOT NULL DEFAULT 0,
  common_area REAL, maintenance_charges REAL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (property_id, building_code)
);
CREATE TABLE IF NOT EXISTS floors (
  floor_id INTEGER PRIMARY KEY AUTOINCREMENT,
  building_id INTEGER NOT NULL REFERENCES buildings(building_id),
  floor_number INTEGER NOT NULL, floor_name TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (building_id, floor_number)
);
CREATE TABLE IF NOT EXISTS units (
  unit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_id INTEGER NOT NULL REFERENCES floors(floor_id),
  unit_number TEXT NOT NULL, unit_type TEXT, room_size REAL, sharing_type TEXT,
  monthly_rent REAL NOT NULL DEFAULT 0 CHECK (monthly_rent >= 0),
  security_deposit REAL NOT NULL DEFAULT 0 CHECK (security_deposit >= 0),
  electricity_charge REAL NOT NULL DEFAULT 0,
  water_charge REAL NOT NULL DEFAULT 0,
  maintenance_charge REAL NOT NULL DEFAULT 0,
  late_fee REAL NOT NULL DEFAULT 0,
  notice_period_days INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','RESERVED','OCCUPIED','PARTIALLY_OCCUPIED','MAINTENANCE','BLOCKED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT,
  UNIQUE (floor_id, unit_number)
);
CREATE TABLE IF NOT EXISTS beds (
  bed_id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER NOT NULL REFERENCES units(unit_id),
  bed_number TEXT NOT NULL, bed_type TEXT,
  monthly_rent REAL NOT NULL DEFAULT 0 CHECK (monthly_rent >= 0),
  security_deposit REAL NOT NULL DEFAULT 0 CHECK (security_deposit >= 0),
  status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','RESERVED','OCCUPIED','MAINTENANCE','BLOCKED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (unit_id, bed_number)
);
CREATE TABLE IF NOT EXISTS tenants (
  tenant_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE REFERENCES users(user_id),
  full_name TEXT NOT NULL, mobile TEXT NOT NULL, email TEXT,
  date_of_birth TEXT,
  gender TEXT CHECK (gender IN ('MALE','FEMALE','OTHER')),
  address TEXT, emergency_contact_name TEXT, emergency_contact_mobile TEXT,
  occupation TEXT, company_name TEXT,
  id_type TEXT CHECK (id_type IN ('AADHAAR','PAN','PASSPORT','DRIVING_LICENSE','VOTER_ID','OTHER')),
  id_number TEXT, photo_document_id INTEGER,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','BLACKLISTED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
);
CREATE TABLE IF NOT EXISTS tenant_documents (
  tenant_document_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('AADHAAR','PAN','PASSPORT','DRIVING_LICENSE','ADDRESS_PROOF','EMPLOYMENT_PROOF','PHOTO','OTHER')),
  document_number TEXT, file_path TEXT, issue_date TEXT, expiry_date TEXT,
  verification_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING','VERIFIED','REJECTED','EXPIRED')),
  verified_by INTEGER REFERENCES users(user_id), verified_at TEXT, remarks TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tenant_kyc (
  kyc_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'KYC_PENDING' CHECK (status IN ('KYC_PENDING','KYC_SUBMITTED','UNDER_VERIFICATION','VERIFIED','REJECTED','EXPIRED')),
  submitted_at TEXT, verification_date TEXT,
  verified_by INTEGER REFERENCES users(user_id), remarks TEXT
);
CREATE TABLE IF NOT EXISTS rent_plans (
  rent_plan_id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(property_id),
  plan_name TEXT NOT NULL,
  base_rent REAL NOT NULL DEFAULT 0 CHECK (base_rent >= 0),
  maintenance_charge REAL NOT NULL DEFAULT 0,
  water_charge REAL NOT NULL DEFAULT 0,
  electricity_mode TEXT NOT NULL DEFAULT 'ACTUAL' CHECK (electricity_mode IN ('FIXED','ACTUAL','METER')),
  electricity_charge REAL NOT NULL DEFAULT 0,
  other_charges REAL NOT NULL DEFAULT 0,
  security_deposit REAL NOT NULL DEFAULT 0,
  late_fee REAL NOT NULL DEFAULT 0,
  due_day INTEGER NOT NULL DEFAULT 5 CHECK (due_day BETWEEN 1 AND 28),
  gst_applicable INTEGER NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rental_agreements (
  agreement_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(tenant_id),
  property_id INTEGER NOT NULL REFERENCES properties(property_id),
  unit_id INTEGER REFERENCES units(unit_id),
  bed_id INTEGER REFERENCES beds(bed_id),
  rent_plan_id INTEGER REFERENCES rent_plans(rent_plan_id),
  agreement_number TEXT NOT NULL UNIQUE,
  start_date TEXT NOT NULL, end_date TEXT,
  monthly_rent REAL NOT NULL CHECK (monthly_rent > 0),
  security_deposit REAL NOT NULL DEFAULT 0,
  due_day INTEGER NOT NULL DEFAULT 5 CHECK (due_day BETWEEN 1 AND 28),
  lock_in_period_days INTEGER,
  notice_period_days INTEGER NOT NULL DEFAULT 30,
  late_fee REAL NOT NULL DEFAULT 0,
  utilities TEXT, maintenance_terms TEXT,
  other_charges REAL NOT NULL DEFAULT 0,
  terms_conditions TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_SIGNATURE','ACTIVE','EXPIRED','TERMINATED','RENEWED')),
  signed_date TEXT, document_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rent_invoices (
  invoice_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(tenant_id),
  agreement_id INTEGER NOT NULL REFERENCES rental_agreements(agreement_id),
  invoice_number TEXT NOT NULL UNIQUE,
  invoice_month TEXT NOT NULL,
  invoice_date TEXT NOT NULL, due_date TEXT NOT NULL,
  base_rent REAL NOT NULL DEFAULT 0,
  maintenance REAL NOT NULL DEFAULT 0,
  electricity REAL NOT NULL DEFAULT 0,
  water REAL NOT NULL DEFAULT 0,
  other_charges REAL NOT NULL DEFAULT 0,
  taxable_amount REAL NOT NULL DEFAULT 0,
  cgst REAL NOT NULL DEFAULT 0, sgst REAL NOT NULL DEFAULT 0, igst REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  paid_amount REAL NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  outstanding_amount REAL NOT NULL DEFAULT 0 CHECK (outstanding_amount >= 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PARTIALLY_PAID','PAID','OVERDUE','FAILED','CANCELLED','REFUNDED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, agreement_id, invoice_month)
);
CREATE TABLE IF NOT EXISTS invoice_items (
  invoice_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES rent_invoices(invoice_id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('RENT','MAINTENANCE','ELECTRICITY','WATER','PARKING','UTILITY','OTHER','PENALTY','DISCOUNT')),
  description TEXT, quantity REAL NOT NULL DEFAULT 1, rate REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0, taxable INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payments (
  payment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES rent_invoices(invoice_id),
  tenant_id INTEGER NOT NULL REFERENCES tenants(tenant_id),
  payment_reference TEXT, payment_date TEXT NOT NULL DEFAULT (datetime('now')),
  amount REAL NOT NULL CHECK (amount > 0),
  payment_mode TEXT NOT NULL CHECK (payment_mode IN ('UPI','CREDIT_CARD','DEBIT_CARD','NET_BANKING','BANK_TRANSFER','CASH','CHEQUE','PAYMENT_GATEWAY')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUCCESS','FAILED','CANCELLED','REFUNDED')),
  gateway_name TEXT, gateway_transaction_id TEXT, remarks TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payment_transactions (
  transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(payment_id),
  gateway_order_id TEXT, gateway_transaction_id TEXT,
  transaction_type TEXT NOT NULL DEFAULT 'PAYMENT' CHECK (transaction_type IN ('PAYMENT','REFUND')),
  amount REAL NOT NULL DEFAULT 0,
  request_payload TEXT, response_payload TEXT,
  signature_verified INTEGER NOT NULL DEFAULT 0,
  transaction_status TEXT,
  transaction_date TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS receipts (
  receipt_id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(payment_id),
  receipt_number TEXT NOT NULL UNIQUE,
  receipt_date TEXT NOT NULL DEFAULT (datetime('now')),
  amount REAL NOT NULL CHECK (amount > 0),
  document_id INTEGER
);
CREATE TABLE IF NOT EXISTS security_deposits (
  deposit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(tenant_id),
  agreement_id INTEGER NOT NULL REFERENCES rental_agreements(agreement_id),
  deposit_amount REAL NOT NULL CHECK (deposit_amount >= 0),
  received_amount REAL NOT NULL DEFAULT 0,
  damage_adjustment REAL NOT NULL DEFAULT 0,
  pending_rent_adjustment REAL NOT NULL DEFAULT 0,
  utility_adjustment REAL NOT NULL DEFAULT 0,
  other_adjustment REAL NOT NULL DEFAULT 0,
  refund_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','HELD','ADJUSTED','REFUNDED','FORFEITED')),
  received_date TEXT, refund_date TEXT, remarks TEXT
);
CREATE TABLE IF NOT EXISTS vendors (
  vendor_id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_name TEXT NOT NULL, company_name TEXT, gstin TEXT, pan TEXT,
  mobile TEXT, email TEXT, address TEXT, bank_name TEXT, account_number TEXT,
  ifsc_code TEXT, services TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS expense_categories (
  category_id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_name TEXT NOT NULL UNIQUE, description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE'))
);
CREATE TABLE IF NOT EXISTS expenses (
  expense_id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(property_id),
  building_id INTEGER REFERENCES buildings(building_id),
  vendor_id INTEGER REFERENCES vendors(vendor_id),
  category_id INTEGER NOT NULL REFERENCES expense_categories(category_id),
  expense_date TEXT NOT NULL, invoice_number TEXT,
  amount REAL NOT NULL CHECK (amount > 0),
  gst_amount REAL NOT NULL DEFAULT 0,
  payment_mode TEXT CHECK (payment_mode IN ('CASH','BANK_TRANSFER','UPI','CARD','CHEQUE','OTHER')),
  attachment_path TEXT, remarks TEXT, created_by INTEGER REFERENCES users(user_id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS property_taxes (
  property_tax_id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(property_id),
  tax_authority TEXT, property_tax_number TEXT, assessment_number TEXT,
  ward TEXT, zone TEXT, financial_year TEXT,
  tax_amount REAL NOT NULL DEFAULT 0, penalty REAL NOT NULL DEFAULT 0,
  due_date TEXT, paid_date TEXT, receipt_number TEXT, document_path TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PARTIALLY_PAID','PAID','OVERDUE')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS gst_settings (
  gst_setting_id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(organization_id),
  gstin TEXT, registration_type TEXT, default_tax_rate REAL NOT NULL DEFAULT 0,
  hsn_sac TEXT, cgst_rate REAL NOT NULL DEFAULT 0, sgst_rate REAL NOT NULL DEFAULT 0,
  igst_rate REAL NOT NULL DEFAULT 0, effective_from TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE'))
);
CREATE TABLE IF NOT EXISTS ledger_accounts (
  account_id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_code TEXT NOT NULL UNIQUE, account_name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','INCOME','EXPENSE','EQUITY')),
  parent_account_id INTEGER REFERENCES ledger_accounts(account_id),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE'))
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  ledger_entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES ledger_accounts(account_id),
  transaction_date TEXT NOT NULL, reference_type TEXT, reference_id INTEGER,
  description TEXT,
  debit REAL NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit REAL NOT NULL DEFAULT 0 CHECK (credit >= 0),
  created_by INTEGER REFERENCES users(user_id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (NOT (debit > 0 AND credit > 0))
);
CREATE TABLE IF NOT EXISTS complaints (
  complaint_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(tenant_id),
  property_id INTEGER NOT NULL REFERENCES properties(property_id),
  unit_id INTEGER REFERENCES units(unit_id),
  complaint_number TEXT UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('ELECTRICITY','WATER','PLUMBING','AC','FURNITURE','INTERNET','CLEANING','SECURITY','OTHER')),
  title TEXT NOT NULL, description TEXT,
  priority TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED')),
  assigned_to INTEGER REFERENCES users(user_id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  assigned_at TEXT, resolved_at TEXT, closed_at TEXT,
  tenant_confirmation INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS maintenance_tasks (
  task_id INTEGER PRIMARY KEY AUTOINCREMENT,
  complaint_id INTEGER NOT NULL REFERENCES complaints(complaint_id),
  vendor_id INTEGER REFERENCES vendors(vendor_id),
  assigned_to INTEGER REFERENCES users(user_id),
  task_description TEXT, estimated_cost REAL, actual_cost REAL,
  start_date TEXT, completion_date TEXT,
  status TEXT NOT NULL DEFAULT 'ASSIGNED' CHECK (status IN ('ASSIGNED','IN_PROGRESS','COMPLETED','CANCELLED')),
  remarks TEXT
);
CREATE TABLE IF NOT EXISTS notices (
  notice_id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, message TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('ALL_TENANTS','PROPERTY','BUILDING','FLOOR','UNIT','TENANT')),
  property_id INTEGER REFERENCES properties(property_id),
  building_id INTEGER REFERENCES buildings(building_id),
  floor_id INTEGER REFERENCES floors(floor_id),
  unit_id INTEGER REFERENCES units(unit_id),
  tenant_id INTEGER REFERENCES tenants(tenant_id),
  publish_date TEXT NOT NULL DEFAULT (datetime('now')),
  expiry_date TEXT, created_by INTEGER REFERENCES users(user_id)
);
CREATE TABLE IF NOT EXISTS documents (
  document_id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL,
  file_name TEXT NOT NULL, file_path TEXT NOT NULL, mime_type TEXT, file_size INTEGER,
  uploaded_by INTEGER REFERENCES users(user_id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notification_templates (
  template_id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_name TEXT NOT NULL, event_code TEXT NOT NULL, channel TEXT NOT NULL
    CHECK (channel IN ('SMS','WHATSAPP','EMAIL','IN_APP')),
  subject TEXT, message_template TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (event_code, channel)
);
CREATE TABLE IF NOT EXISTS notifications (
  notification_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER REFERENCES tenants(tenant_id),
  user_id INTEGER REFERENCES users(user_id),
  template_id INTEGER REFERENCES notification_templates(template_id),
  event_code TEXT, channel TEXT CHECK (channel IN ('SMS','WHATSAPP','EMAIL','IN_APP')),
  recipient TEXT, subject TEXT, message TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','DELIVERED','FAILED','READ')),
  scheduled_at TEXT, sent_at TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sms_logs (
  sms_id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER REFERENCES notifications(notification_id),
  mobile TEXT, provider_message_id TEXT, status TEXT, response TEXT, sent_at TEXT
);
CREATE TABLE IF NOT EXISTS whatsapp_logs (
  whatsapp_id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER REFERENCES notifications(notification_id),
  mobile TEXT, provider_message_id TEXT, template_name TEXT, status TEXT, response TEXT, sent_at TEXT
);
CREATE TABLE IF NOT EXISTS email_logs (
  email_id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER REFERENCES notifications(notification_id),
  email_address TEXT, subject TEXT, status TEXT, response TEXT, sent_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(user_id),
  module_name TEXT, action TEXT, entity_type TEXT, entity_id INTEGER,
  old_value TEXT, new_value TEXT, ip_address TEXT, device_info TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  setting_id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER REFERENCES organizations(organization_id),
  setting_key TEXT NOT NULL, setting_value TEXT, setting_group TEXT,
  is_encrypted INTEGER NOT NULL DEFAULT 0,
  UNIQUE (organization_id, setting_key)
);
CREATE TABLE IF NOT EXISTS tenant_otps (
  otp_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mobile TEXT NOT NULL, otp_code TEXT NOT NULL,
  expires_at TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS file_blobs (
  file_id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL, mime_type TEXT NOT NULL, file_size INTEGER NOT NULL,
  data BLOB NOT NULL,
  uploaded_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

module.exports = { SCHEMA };
