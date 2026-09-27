-- ============================================================
-- PROPERTY & RENT MANAGEMENT SYSTEM
-- OLD MYSQL COMPATIBLE VERSION
-- Based on the supplied property_rent_management(1).sql
--
-- Compatibility target: MySQL 5.1
-- Character set: utf8
-- Collation: utf8_unicode_ci
--
-- Changes made:
--   * JSON -> LONGTEXT
--   * DATETIME DEFAULT CURRENT_TIMESTAMP -> TIMESTAMP
--   * updated_at handled by BEFORE UPDATE triggers
--   * MySQL 8 SIGNAL validation replaced with old-MySQL-safe logic
--   * Multiple AFTER INSERT triggers on payments merged (MySQL 5.1 allows one per event/timing)
--   * Invoice ID captured before inserting invoice items
-- ============================================================

DROP DATABASE IF EXISTS property_rent_management;
CREATE DATABASE property_rent_management
  CHARACTER SET utf8
  COLLATE utf8_unicode_ci;
USE property_rent_management;

SET NAMES utf8;
SET FOREIGN_KEY_CHECKS = 0;

-- ============================================================
-- 1. ORGANIZATIONS
-- ============================================================
CREATE TABLE organizations (
    organization_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    organization_name VARCHAR(200) NOT NULL,
    registration_no VARCHAR(100),
    gstin VARCHAR(20),
    pan VARCHAR(20),
    email VARCHAR(150),
    mobile VARCHAR(20),
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(100),
    pin_code VARCHAR(10),
    status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL ,
    INDEX idx_org_name (organization_name),
    INDEX idx_org_gstin (gstin)
) ENGINE=InnoDB;

-- ============================================================
-- 2. ROLES
-- ============================================================
CREATE TABLE roles (
    role_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    role_name VARCHAR(50) NOT NULL UNIQUE,
    description VARCHAR(255),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ============================================================
-- 3. PERMISSIONS
-- ============================================================
CREATE TABLE permissions (
    permission_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    module_name VARCHAR(100) NOT NULL,
    permission_name VARCHAR(50) NOT NULL,
    UNIQUE KEY uq_permission (module_name, permission_name),
    INDEX idx_permission_module (module_name)
) ENGINE=InnoDB;

-- ============================================================
-- 4. ROLE PERMISSIONS
-- ============================================================
CREATE TABLE role_permissions (
    role_id INT UNSIGNED NOT NULL,
    permission_id INT UNSIGNED NOT NULL,
    can_view BOOLEAN NOT NULL DEFAULT FALSE,
    can_add BOOLEAN NOT NULL DEFAULT FALSE,
    can_edit BOOLEAN NOT NULL DEFAULT FALSE,
    can_delete BOOLEAN NOT NULL DEFAULT FALSE,
    can_approve BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (role_id, permission_id),
    CONSTRAINT fk_rp_role FOREIGN KEY (role_id) REFERENCES roles(role_id),
    CONSTRAINT fk_rp_permission FOREIGN KEY (permission_id) REFERENCES permissions(permission_id)
) ENGINE=InnoDB;

-- ============================================================
-- 5. USERS
-- ============================================================
CREATE TABLE users (
    user_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    organization_id BIGINT UNSIGNED,
    role_id INT UNSIGNED NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    email VARCHAR(150) UNIQUE,
    mobile VARCHAR(20) UNIQUE,
    password_hash VARCHAR(255),
    otp_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    status ENUM('ACTIVE','INACTIVE','LOCKED') NOT NULL DEFAULT 'ACTIVE',
    last_login DATETIME,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL ,
    CONSTRAINT fk_users_org FOREIGN KEY (organization_id) REFERENCES organizations(organization_id),
    CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(role_id),
    INDEX idx_users_org (organization_id),
    INDEX idx_users_role (role_id),
    INDEX idx_users_status (status)
) ENGINE=InnoDB;

-- ============================================================
-- 6. PROPERTIES
-- ============================================================
CREATE TABLE properties (
    property_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    organization_id BIGINT UNSIGNED NOT NULL,
    owner_id BIGINT UNSIGNED,
    property_code VARCHAR(50) NOT NULL,
    property_name VARCHAR(200) NOT NULL,
    property_type ENUM(
        'RESIDENTIAL','COMMERCIAL','APARTMENT','PG','HOSTEL',
        'CO_LIVING','SHOP','OFFICE','WAREHOUSE','OTHER'
    ) NOT NULL,
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(100),
    pin_code VARCHAR(10),
    latitude DECIMAL(10,7),
    longitude DECIMAL(10,7),
    property_size DECIMAL(12,2),
    built_up_area DECIMAL(12,2),
    carpet_area DECIMAL(12,2),
    purchase_date DATE,
    purchase_value DECIMAL(15,2),
    current_value DECIMAL(15,2),
    status ENUM('ACTIVE','INACTIVE','UNDER_CONSTRUCTION','SOLD') NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL ,
    UNIQUE KEY uq_property_code (organization_id, property_code),
    CONSTRAINT fk_property_org FOREIGN KEY (organization_id) REFERENCES organizations(organization_id),
    CONSTRAINT fk_property_owner FOREIGN KEY (owner_id) REFERENCES users(user_id),
    INDEX idx_property_city (city),
    INDEX idx_property_type (property_type),
    INDEX idx_property_status (status)
) ENGINE=InnoDB;

-- ============================================================
-- 7. BUILDINGS
-- ============================================================
CREATE TABLE buildings (
    building_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    property_id BIGINT UNSIGNED NOT NULL,
    building_code VARCHAR(50) NOT NULL,
    building_name VARCHAR(150) NOT NULL,
    number_of_floors INT NOT NULL DEFAULT 0,
    construction_year YEAR,
    building_type VARCHAR(100),
    address TEXT,
    parking_available BOOLEAN NOT NULL DEFAULT FALSE,
    lift_available BOOLEAN NOT NULL DEFAULT FALSE,
    security_available BOOLEAN NOT NULL DEFAULT FALSE,
    common_area DECIMAL(12,2),
    maintenance_charges DECIMAL(12,2),
    status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_building_code (property_id, building_code),
    CONSTRAINT fk_building_property FOREIGN KEY (property_id) REFERENCES properties(property_id),
    INDEX idx_building_property (property_id),
    INDEX idx_building_status (status)
) ENGINE=InnoDB;

-- ============================================================
-- 8. FLOORS
-- ============================================================
CREATE TABLE floors (
    floor_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    building_id BIGINT UNSIGNED NOT NULL,
    floor_number INT NOT NULL,
    floor_name VARCHAR(100),
    status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_floor (building_id, floor_number),
    CONSTRAINT fk_floor_building FOREIGN KEY (building_id) REFERENCES buildings(building_id),
    INDEX idx_floor_building (building_id)
) ENGINE=InnoDB;

-- ============================================================
-- 9. UNITS / ROOMS
-- ============================================================
CREATE TABLE units (
    unit_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    floor_id BIGINT UNSIGNED NOT NULL,
    unit_number VARCHAR(50) NOT NULL,
    unit_type VARCHAR(100),
    room_size DECIMAL(10,2),
    sharing_type VARCHAR(50),
    monthly_rent DECIMAL(12,2) NOT NULL DEFAULT 0,
    security_deposit DECIMAL(12,2) NOT NULL DEFAULT 0,
    electricity_charge DECIMAL(12,2) NOT NULL DEFAULT 0,
    water_charge DECIMAL(12,2) NOT NULL DEFAULT 0,
    maintenance_charge DECIMAL(12,2) NOT NULL DEFAULT 0,
    late_fee DECIMAL(12,2) NOT NULL DEFAULT 0,
    notice_period_days INT NOT NULL DEFAULT 30,
    status ENUM(
        'AVAILABLE','RESERVED','OCCUPIED','PARTIALLY_OCCUPIED',
        'MAINTENANCE','BLOCKED'
    ) NOT NULL DEFAULT 'AVAILABLE',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL ,
    UNIQUE KEY uq_unit (floor_id, unit_number),
    CONSTRAINT fk_unit_floor FOREIGN KEY (floor_id) REFERENCES floors(floor_id),
    INDEX idx_unit_floor (floor_id),
    INDEX idx_unit_status (status)
) ENGINE=InnoDB;

-- ============================================================
-- 10. BEDS
-- ============================================================
CREATE TABLE beds (
    bed_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    unit_id BIGINT UNSIGNED NOT NULL,
    bed_number VARCHAR(50) NOT NULL,
    bed_type VARCHAR(50),
    monthly_rent DECIMAL(12,2) NOT NULL DEFAULT 0,
    security_deposit DECIMAL(12,2) NOT NULL DEFAULT 0,
    status ENUM('AVAILABLE','RESERVED','OCCUPIED','MAINTENANCE','BLOCKED')
        NOT NULL DEFAULT 'AVAILABLE',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_bed (unit_id, bed_number),
    CONSTRAINT fk_bed_unit FOREIGN KEY (unit_id) REFERENCES units(unit_id),
    INDEX idx_bed_unit (unit_id),
    INDEX idx_bed_status (status)
) ENGINE=InnoDB;

-- ============================================================
-- 11. TENANTS
-- ============================================================
CREATE TABLE tenants (
    tenant_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED UNIQUE,
    full_name VARCHAR(150) NOT NULL,
    mobile VARCHAR(20) NOT NULL,
    email VARCHAR(150),
    date_of_birth DATE,
    gender ENUM('MALE','FEMALE','OTHER'),
    address TEXT,
    emergency_contact_name VARCHAR(150),
    emergency_contact_mobile VARCHAR(20),
    occupation VARCHAR(100),
    company_name VARCHAR(150),
    id_type ENUM('AADHAAR','PAN','PASSPORT','DRIVING_LICENSE','VOTER_ID','OTHER'),
    id_number VARCHAR(100),
    photo_document_id BIGINT UNSIGNED,
    status ENUM('ACTIVE','INACTIVE','BLACKLISTED') NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL ,
    CONSTRAINT fk_tenant_user FOREIGN KEY (user_id) REFERENCES users(user_id),
    INDEX idx_tenant_name (full_name),
    INDEX idx_tenant_mobile (mobile),
    INDEX idx_tenant_status (status)
) ENGINE=InnoDB;

-- ============================================================
-- 12. TENANT DOCUMENTS
-- ============================================================
CREATE TABLE tenant_documents (
    tenant_document_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL,
    document_type ENUM(
        'AADHAAR','PAN','PASSPORT','DRIVING_LICENSE',
        'ADDRESS_PROOF','EMPLOYMENT_PROOF','PHOTO','OTHER'
    ) NOT NULL,
    document_number VARCHAR(100),
    file_path VARCHAR(500),
    issue_date DATE,
    expiry_date DATE,
    verification_status ENUM('PENDING','VERIFIED','REJECTED','EXPIRED')
        NOT NULL DEFAULT 'PENDING',
    verified_by BIGINT UNSIGNED,
    verified_at DATETIME,
    remarks TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_td_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
    CONSTRAINT fk_td_verifier FOREIGN KEY (verified_by) REFERENCES users(user_id),
    INDEX idx_td_tenant (tenant_id),
    INDEX idx_td_status (verification_status)
) ENGINE=InnoDB;

-- ============================================================
-- 13. TENANT KYC
-- ============================================================
CREATE TABLE tenant_kyc (
    kyc_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL,
    status ENUM(
        'KYC_PENDING','KYC_SUBMITTED','UNDER_VERIFICATION',
        'VERIFIED','REJECTED','EXPIRED'
    ) NOT NULL DEFAULT 'KYC_PENDING',
    submitted_at DATETIME,
    verification_date DATETIME,
    verified_by BIGINT UNSIGNED,
    remarks TEXT,
    CONSTRAINT fk_kyc_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
    CONSTRAINT fk_kyc_verifier FOREIGN KEY (verified_by) REFERENCES users(user_id),
    INDEX idx_kyc_tenant (tenant_id),
    INDEX idx_kyc_status (status)
) ENGINE=InnoDB;

-- ============================================================
-- 14. RENT PLANS
-- ============================================================
CREATE TABLE rent_plans (
    rent_plan_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    property_id BIGINT UNSIGNED NOT NULL,
    plan_name VARCHAR(150) NOT NULL,
    base_rent DECIMAL(12,2) NOT NULL DEFAULT 0,
    maintenance_charge DECIMAL(12,2) NOT NULL DEFAULT 0,
    water_charge DECIMAL(12,2) NOT NULL DEFAULT 0,
    electricity_mode ENUM('FIXED','ACTUAL','METER') NOT NULL DEFAULT 'ACTUAL',
    electricity_charge DECIMAL(12,2) NOT NULL DEFAULT 0,
    other_charges DECIMAL(12,2) NOT NULL DEFAULT 0,
    security_deposit DECIMAL(12,2) NOT NULL DEFAULT 0,
    late_fee DECIMAL(12,2) NOT NULL DEFAULT 0,
    due_day INT NOT NULL DEFAULT 5,
    gst_applicable BOOLEAN NOT NULL DEFAULT FALSE,
    discount DECIMAL(12,2) NOT NULL DEFAULT 0,
    status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_rentplan_property FOREIGN KEY (property_id) REFERENCES properties(property_id),
    CONSTRAINT chk_rent_due_day CHECK (due_day BETWEEN 1 AND 28),
    INDEX idx_rentplan_property (property_id),
    INDEX idx_rentplan_status (status)
) ENGINE=InnoDB;

-- ============================================================
-- 15. RENTAL AGREEMENTS
-- ============================================================
CREATE TABLE rental_agreements (
    agreement_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL,
    property_id BIGINT UNSIGNED NOT NULL,
    unit_id BIGINT UNSIGNED,
    bed_id BIGINT UNSIGNED,
    rent_plan_id BIGINT UNSIGNED,
    agreement_number VARCHAR(100) NOT NULL UNIQUE,
    start_date DATE NOT NULL,
    end_date DATE,
    monthly_rent DECIMAL(12,2) NOT NULL,
    security_deposit DECIMAL(12,2) NOT NULL DEFAULT 0,
    due_day INT NOT NULL DEFAULT 5,
    lock_in_period_days INT,
    notice_period_days INT NOT NULL DEFAULT 30,
    late_fee DECIMAL(12,2) NOT NULL DEFAULT 0,
    utilities TEXT,
    maintenance_terms TEXT,
    other_charges DECIMAL(12,2) NOT NULL DEFAULT 0,
    terms_conditions TEXT,
    status ENUM(
        'DRAFT','PENDING_SIGNATURE','ACTIVE','EXPIRED',
        'TERMINATED','RENEWED'
    ) NOT NULL DEFAULT 'DRAFT',
    signed_date DATE,
    document_id BIGINT UNSIGNED,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_agreement_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
    CONSTRAINT fk_agreement_property FOREIGN KEY (property_id) REFERENCES properties(property_id),
    CONSTRAINT fk_agreement_unit FOREIGN KEY (unit_id) REFERENCES units(unit_id),
    CONSTRAINT fk_agreement_bed FOREIGN KEY (bed_id) REFERENCES beds(bed_id),
    CONSTRAINT fk_agreement_rentplan FOREIGN KEY (rent_plan_id) REFERENCES rent_plans(rent_plan_id),
    INDEX idx_agreement_tenant (tenant_id),
    INDEX idx_agreement_property (property_id),
    INDEX idx_agreement_unit (unit_id),
    INDEX idx_agreement_bed (bed_id),
    INDEX idx_agreement_status (status),
    INDEX idx_agreement_dates (start_date, end_date)
) ENGINE=InnoDB;

-- ============================================================
-- 16. RENT INVOICES
-- ============================================================
CREATE TABLE rent_invoices (
    invoice_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL,
    agreement_id BIGINT UNSIGNED NOT NULL,
    invoice_number VARCHAR(100) NOT NULL UNIQUE,
    invoice_month DATE NOT NULL,
    invoice_date DATE NOT NULL,
    due_date DATE NOT NULL,
    base_rent DECIMAL(12,2) NOT NULL DEFAULT 0,
    maintenance DECIMAL(12,2) NOT NULL DEFAULT 0,
    electricity DECIMAL(12,2) NOT NULL DEFAULT 0,
    water DECIMAL(12,2) NOT NULL DEFAULT 0,
    other_charges DECIMAL(12,2) NOT NULL DEFAULT 0,
    taxable_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    cgst DECIMAL(12,2) NOT NULL DEFAULT 0,
    sgst DECIMAL(12,2) NOT NULL DEFAULT 0,
    igst DECIMAL(12,2) NOT NULL DEFAULT 0,
    discount DECIMAL(12,2) NOT NULL DEFAULT 0,
    total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    outstanding_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    status ENUM(
        'PENDING','PARTIALLY_PAID','PAID','OVERDUE',
        'FAILED','CANCELLED','REFUNDED'
    ) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_invoice_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
    CONSTRAINT fk_invoice_agreement FOREIGN KEY (agreement_id) REFERENCES rental_agreements(agreement_id),
    UNIQUE KEY uq_invoice_tenant_month (tenant_id, agreement_id, invoice_month),
    INDEX idx_invoice_tenant (tenant_id),
    INDEX idx_invoice_due_date (due_date),
    INDEX idx_invoice_status (status),
    INDEX idx_invoice_month (invoice_month)
) ENGINE=InnoDB;

-- ============================================================
-- 17. INVOICE ITEMS
-- ============================================================
CREATE TABLE invoice_items (
    invoice_item_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    invoice_id BIGINT UNSIGNED NOT NULL,
    item_type ENUM(
        'RENT','MAINTENANCE','ELECTRICITY','WATER',
        'PARKING','UTILITY','OTHER','PENALTY','DISCOUNT'
    ) NOT NULL,
    description VARCHAR(255),
    quantity DECIMAL(10,2) NOT NULL DEFAULT 1,
    rate DECIMAL(12,2) NOT NULL DEFAULT 0,
    amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    taxable BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT fk_invoiceitem_invoice FOREIGN KEY (invoice_id)
        REFERENCES rent_invoices(invoice_id) ON DELETE CASCADE,
    INDEX idx_invoiceitem_invoice (invoice_id)
) ENGINE=InnoDB;

-- ============================================================
-- 18. PAYMENTS
-- ============================================================
CREATE TABLE payments (
    payment_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    invoice_id BIGINT UNSIGNED NOT NULL,
    tenant_id BIGINT UNSIGNED NOT NULL,
    payment_reference VARCHAR(150),
    payment_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    amount DECIMAL(12,2) NOT NULL,
    payment_mode ENUM(
        'UPI','CREDIT_CARD','DEBIT_CARD','NET_BANKING',
        'BANK_TRANSFER','CASH','CHEQUE','PAYMENT_GATEWAY'
    ) NOT NULL,
    status ENUM(
        'PENDING','SUCCESS','FAILED','CANCELLED','REFUNDED'
    ) NOT NULL DEFAULT 'PENDING',
    gateway_name VARCHAR(100),
    gateway_transaction_id VARCHAR(200),
    remarks TEXT,
    -- MySQL 5.1 permits automatic CURRENT_TIMESTAMP for only one TIMESTAMP column per table.
    -- payment_date remains the automatic TIMESTAMP; created_at is maintained by trigger.
    created_at DATETIME NULL,
    CONSTRAINT fk_payment_invoice FOREIGN KEY (invoice_id) REFERENCES rent_invoices(invoice_id),
    CONSTRAINT fk_payment_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
    INDEX idx_payment_invoice (invoice_id),
    INDEX idx_payment_tenant (tenant_id),
    INDEX idx_payment_date (payment_date),
    INDEX idx_payment_status (status),
    INDEX idx_payment_reference (payment_reference)
) ENGINE=InnoDB;

-- ============================================================
-- 19. PAYMENT TRANSACTIONS
-- ============================================================
CREATE TABLE payment_transactions (
    transaction_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    payment_id BIGINT UNSIGNED NOT NULL,
    gateway_order_id VARCHAR(200),
    gateway_transaction_id VARCHAR(200),
    transaction_type ENUM('PAYMENT','REFUND') NOT NULL DEFAULT 'PAYMENT',
    amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    request_payload LONGTEXT,
    response_payload LONGTEXT,
    signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
    transaction_status VARCHAR(50),
    transaction_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_pt_payment FOREIGN KEY (payment_id) REFERENCES payments(payment_id),
    INDEX idx_pt_payment (payment_id),
    INDEX idx_pt_gateway_order (gateway_order_id),
    INDEX idx_pt_gateway_transaction (gateway_transaction_id)
) ENGINE=InnoDB;

-- ============================================================
-- 20. RECEIPTS
-- ============================================================
CREATE TABLE receipts (
    receipt_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    payment_id BIGINT UNSIGNED NOT NULL,
    receipt_number VARCHAR(100) NOT NULL UNIQUE,
    receipt_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    amount DECIMAL(12,2) NOT NULL,
    document_id BIGINT UNSIGNED,
    CONSTRAINT fk_receipt_payment FOREIGN KEY (payment_id) REFERENCES payments(payment_id),
    INDEX idx_receipt_payment (payment_id),
    INDEX idx_receipt_date (receipt_date)
) ENGINE=InnoDB;

-- ============================================================
-- 21. SECURITY DEPOSITS
-- ============================================================
CREATE TABLE security_deposits (
    deposit_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL,
    agreement_id BIGINT UNSIGNED NOT NULL,
    deposit_amount DECIMAL(12,2) NOT NULL,
    received_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    damage_adjustment DECIMAL(12,2) NOT NULL DEFAULT 0,
    pending_rent_adjustment DECIMAL(12,2) NOT NULL DEFAULT 0,
    utility_adjustment DECIMAL(12,2) NOT NULL DEFAULT 0,
    other_adjustment DECIMAL(12,2) NOT NULL DEFAULT 0,
    refund_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    status ENUM(
        'RECEIVED','HELD','ADJUSTED','REFUNDED','FORFEITED'
    ) NOT NULL DEFAULT 'RECEIVED',
    received_date DATE,
    refund_date DATE,
    remarks TEXT,
    CONSTRAINT fk_deposit_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
    CONSTRAINT fk_deposit_agreement FOREIGN KEY (agreement_id) REFERENCES rental_agreements(agreement_id),
    INDEX idx_deposit_tenant (tenant_id),
    INDEX idx_deposit_agreement (agreement_id),
    INDEX idx_deposit_status (status)
) ENGINE=InnoDB;

-- ============================================================
-- 22. VENDORS
-- ============================================================
CREATE TABLE vendors (
    vendor_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    vendor_name VARCHAR(200) NOT NULL,
    company_name VARCHAR(200),
    gstin VARCHAR(20),
    pan VARCHAR(20),
    mobile VARCHAR(20),
    email VARCHAR(150),
    address TEXT,
    bank_name VARCHAR(150),
    account_number VARCHAR(100),
    ifsc_code VARCHAR(20),
    services TEXT,
    status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_vendor_name (vendor_name),
    INDEX idx_vendor_gstin (gstin),
    INDEX idx_vendor_status (status)
) ENGINE=InnoDB;

-- ============================================================
-- 23. EXPENSE CATEGORIES
-- ============================================================
CREATE TABLE expense_categories (
    category_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    category_name VARCHAR(100) NOT NULL UNIQUE,
    description VARCHAR(255),
    status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE'
) ENGINE=InnoDB;

-- ============================================================
-- 24. EXPENSES
-- ============================================================
CREATE TABLE expenses (
    expense_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    property_id BIGINT UNSIGNED NOT NULL,
    building_id BIGINT UNSIGNED,
    vendor_id BIGINT UNSIGNED,
    category_id INT UNSIGNED NOT NULL,
    expense_date DATE NOT NULL,
    invoice_number VARCHAR(100),
    amount DECIMAL(12,2) NOT NULL,
    gst_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    payment_mode ENUM(
        'CASH','BANK_TRANSFER','UPI','CARD','CHEQUE','OTHER'
    ),
    attachment_path VARCHAR(500),
    remarks TEXT,
    created_by BIGINT UNSIGNED,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_exp_property FOREIGN KEY (property_id) REFERENCES properties(property_id),
    CONSTRAINT fk_exp_building FOREIGN KEY (building_id) REFERENCES buildings(building_id),
    CONSTRAINT fk_exp_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(vendor_id),
    CONSTRAINT fk_exp_category FOREIGN KEY (category_id) REFERENCES expense_categories(category_id),
    CONSTRAINT fk_exp_user FOREIGN KEY (created_by) REFERENCES users(user_id),
    INDEX idx_exp_property (property_id),
    INDEX idx_exp_date (expense_date),
    INDEX idx_exp_category (category_id),
    INDEX idx_exp_vendor (vendor_id)
) ENGINE=InnoDB;

-- ============================================================
-- 25. PROPERTY TAXES
-- ============================================================
CREATE TABLE property_taxes (
    property_tax_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    property_id BIGINT UNSIGNED NOT NULL,
    tax_authority VARCHAR(200),
    property_tax_number VARCHAR(100),
    assessment_number VARCHAR(100),
    ward VARCHAR(100),
    zone VARCHAR(100),
    financial_year VARCHAR(20),
    tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    penalty DECIMAL(12,2) NOT NULL DEFAULT 0,
    due_date DATE,
    paid_date DATE,
    receipt_number VARCHAR(100),
    document_path VARCHAR(500),
    status ENUM(
        'PENDING','PARTIALLY_PAID','PAID','OVERDUE'
    ) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_tax_property FOREIGN KEY (property_id) REFERENCES properties(property_id),
    INDEX idx_tax_property (property_id),
    INDEX idx_tax_fy (financial_year),
    INDEX idx_tax_due_date (due_date),
    INDEX idx_tax_status (status)
) ENGINE=InnoDB;

-- ============================================================
-- 26. GST SETTINGS
-- ============================================================
CREATE TABLE gst_settings (
    gst_setting_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    organization_id BIGINT UNSIGNED NOT NULL,
    gstin VARCHAR(20),
    registration_type VARCHAR(100),
    default_tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
    hsn_sac VARCHAR(50),
    cgst_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
    sgst_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
    igst_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
    effective_from DATE,
    status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    CONSTRAINT fk_gst_org FOREIGN KEY (organization_id) REFERENCES organizations(organization_id),
    INDEX idx_gst_org (organization_id),
    INDEX idx_gst_status (status)
) ENGINE=InnoDB;

-- ============================================================
-- 27. LEDGER ACCOUNTS
-- ============================================================
CREATE TABLE ledger_accounts (
    account_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    account_code VARCHAR(50) NOT NULL UNIQUE,
    account_name VARCHAR(200) NOT NULL,
    account_type ENUM(
        'ASSET','LIABILITY','INCOME','EXPENSE','EQUITY'
    ) NOT NULL,
    parent_account_id BIGINT UNSIGNED,
    status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    CONSTRAINT fk_ledger_parent FOREIGN KEY (parent_account_id)
        REFERENCES ledger_accounts(account_id),
    INDEX idx_ledger_type (account_type),
    INDEX idx_ledger_parent (parent_account_id)
) ENGINE=InnoDB;

-- ============================================================
-- 28. LEDGER ENTRIES
-- ============================================================
CREATE TABLE ledger_entries (
    ledger_entry_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT UNSIGNED NOT NULL,
    transaction_date DATETIME NOT NULL,
    reference_type VARCHAR(100),
    reference_id BIGINT UNSIGNED,
    description VARCHAR(255),
    debit DECIMAL(15,2) NOT NULL DEFAULT 0,
    credit DECIMAL(15,2) NOT NULL DEFAULT 0,
    created_by BIGINT UNSIGNED,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_le_account FOREIGN KEY (account_id) REFERENCES ledger_accounts(account_id),
    CONSTRAINT fk_le_user FOREIGN KEY (created_by) REFERENCES users(user_id),
    INDEX idx_le_account_date (account_id, transaction_date),
    INDEX idx_le_reference (reference_type, reference_id),
    INDEX idx_le_date (transaction_date)
) ENGINE=InnoDB;

-- ============================================================
-- 29. COMPLAINTS
-- ============================================================
CREATE TABLE complaints (
    complaint_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL,
    property_id BIGINT UNSIGNED NOT NULL,
    unit_id BIGINT UNSIGNED,
    complaint_number VARCHAR(100) UNIQUE,
    category ENUM(
        'ELECTRICITY','WATER','PLUMBING','AC','FURNITURE',
        'INTERNET','CLEANING','SECURITY','OTHER'
    ) NOT NULL,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    priority ENUM('LOW','MEDIUM','HIGH','URGENT') NOT NULL DEFAULT 'MEDIUM',
    status ENUM(
        'OPEN','ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED'
    ) NOT NULL DEFAULT 'OPEN',
    assigned_to BIGINT UNSIGNED,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assigned_at DATETIME,
    resolved_at DATETIME,
    closed_at DATETIME,
    tenant_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT fk_complaint_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
    CONSTRAINT fk_complaint_property FOREIGN KEY (property_id) REFERENCES properties(property_id),
    CONSTRAINT fk_complaint_unit FOREIGN KEY (unit_id) REFERENCES units(unit_id),
    CONSTRAINT fk_complaint_staff FOREIGN KEY (assigned_to) REFERENCES users(user_id),
    INDEX idx_complaint_tenant (tenant_id),
    INDEX idx_complaint_property (property_id),
    INDEX idx_complaint_status (status),
    INDEX idx_complaint_priority (priority)
) ENGINE=InnoDB;

-- ============================================================
-- 30. MAINTENANCE TASKS
-- ============================================================
CREATE TABLE maintenance_tasks (
    task_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    complaint_id BIGINT UNSIGNED NOT NULL,
    vendor_id BIGINT UNSIGNED,
    assigned_to BIGINT UNSIGNED,
    task_description TEXT,
    estimated_cost DECIMAL(12,2),
    actual_cost DECIMAL(12,2),
    start_date DATETIME,
    completion_date DATETIME,
    status ENUM(
        'ASSIGNED','IN_PROGRESS','COMPLETED','CANCELLED'
    ) NOT NULL DEFAULT 'ASSIGNED',
    remarks TEXT,
    CONSTRAINT fk_mt_complaint FOREIGN KEY (complaint_id) REFERENCES complaints(complaint_id),
    CONSTRAINT fk_mt_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(vendor_id),
    CONSTRAINT fk_mt_staff FOREIGN KEY (assigned_to) REFERENCES users(user_id),
    INDEX idx_mt_complaint (complaint_id),
    INDEX idx_mt_vendor (vendor_id),
    INDEX idx_mt_status (status)
) ENGINE=InnoDB;

-- ============================================================
-- 31. NOTICES
-- ============================================================
CREATE TABLE notices (
    notice_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    message TEXT NOT NULL,
    target_type ENUM(
        'ALL_TENANTS','PROPERTY','BUILDING','FLOOR','UNIT','TENANT'
    ) NOT NULL,
    property_id BIGINT UNSIGNED,
    building_id BIGINT UNSIGNED,
    floor_id BIGINT UNSIGNED,
    unit_id BIGINT UNSIGNED,
    tenant_id BIGINT UNSIGNED,
    publish_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expiry_date DATETIME,
    created_by BIGINT UNSIGNED,
    CONSTRAINT fk_notice_property FOREIGN KEY (property_id) REFERENCES properties(property_id),
    CONSTRAINT fk_notice_building FOREIGN KEY (building_id) REFERENCES buildings(building_id),
    CONSTRAINT fk_notice_floor FOREIGN KEY (floor_id) REFERENCES floors(floor_id),
    CONSTRAINT fk_notice_unit FOREIGN KEY (unit_id) REFERENCES units(unit_id),
    CONSTRAINT fk_notice_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
    CONSTRAINT fk_notice_user FOREIGN KEY (created_by) REFERENCES users(user_id),
    INDEX idx_notice_target (target_type),
    INDEX idx_notice_publish (publish_date)
) ENGINE=InnoDB;

-- ============================================================
-- 32. DOCUMENTS
-- ============================================================
CREATE TABLE documents (
    document_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    document_type VARCHAR(100) NOT NULL,
    entity_type VARCHAR(100) NOT NULL,
    entity_id BIGINT UNSIGNED NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    mime_type VARCHAR(100),
    file_size BIGINT UNSIGNED,
    uploaded_by BIGINT UNSIGNED,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_document_user FOREIGN KEY (uploaded_by) REFERENCES users(user_id),
    INDEX idx_document_entity (entity_type, entity_id),
    INDEX idx_document_type (document_type)
) ENGINE=InnoDB;

-- ============================================================
-- 33. NOTIFICATION TEMPLATES
-- ============================================================
CREATE TABLE notification_templates (
    template_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    template_name VARCHAR(150) NOT NULL,
    event_code VARCHAR(100) NOT NULL,
    channel ENUM('SMS','WHATSAPP','EMAIL','IN_APP') NOT NULL,
    subject VARCHAR(255),
    message_template TEXT NOT NULL,
    status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    UNIQUE KEY uq_template_event_channel (event_code, channel),
    INDEX idx_template_event (event_code)
) ENGINE=InnoDB;

-- ============================================================
-- 34. NOTIFICATIONS
-- ============================================================
CREATE TABLE notifications (
    notification_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED,
    template_id BIGINT UNSIGNED,
    event_code VARCHAR(100),
    channel ENUM('SMS','WHATSAPP','EMAIL','IN_APP'),
    recipient VARCHAR(200),
    subject VARCHAR(255),
    message TEXT,
    status ENUM(
        'PENDING','SENT','DELIVERED','FAILED','READ'
    ) NOT NULL DEFAULT 'PENDING',
    scheduled_at DATETIME,
    sent_at DATETIME,
    retry_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_notification_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
    CONSTRAINT fk_notification_template FOREIGN KEY (template_id) REFERENCES notification_templates(template_id),
    INDEX idx_notification_tenant (tenant_id),
    INDEX idx_notification_status (status),
    INDEX idx_notification_scheduled (scheduled_at)
) ENGINE=InnoDB;

-- ============================================================
-- 35. SMS LOGS
-- ============================================================
CREATE TABLE sms_logs (
    sms_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    notification_id BIGINT UNSIGNED,
    mobile VARCHAR(20),
    provider_message_id VARCHAR(200),
    status VARCHAR(50),
    response TEXT,
    sent_at DATETIME,
    CONSTRAINT fk_sms_notification FOREIGN KEY (notification_id)
        REFERENCES notifications(notification_id),
    INDEX idx_sms_notification (notification_id),
    INDEX idx_sms_status (status)
) ENGINE=InnoDB;

-- ============================================================
-- 36. WHATSAPP LOGS
-- ============================================================
CREATE TABLE whatsapp_logs (
    whatsapp_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    notification_id BIGINT UNSIGNED,
    mobile VARCHAR(20),
    provider_message_id VARCHAR(200),
    template_name VARCHAR(150),
    status VARCHAR(50),
    response TEXT,
    sent_at DATETIME,
    CONSTRAINT fk_wa_notification FOREIGN KEY (notification_id)
        REFERENCES notifications(notification_id),
    INDEX idx_wa_notification (notification_id),
    INDEX idx_wa_status (status)
) ENGINE=InnoDB;

-- ============================================================
-- 37. EMAIL LOGS
-- ============================================================
CREATE TABLE email_logs (
    email_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    notification_id BIGINT UNSIGNED,
    email_address VARCHAR(200),
    subject VARCHAR(255),
    status VARCHAR(50),
    response TEXT,
    sent_at DATETIME,
    CONSTRAINT fk_email_notification FOREIGN KEY (notification_id)
        REFERENCES notifications(notification_id),
    INDEX idx_email_notification (notification_id),
    INDEX idx_email_status (status)
) ENGINE=InnoDB;

-- ============================================================
-- 38. AUDIT LOGS
-- ============================================================
CREATE TABLE audit_logs (
    audit_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED,
    module_name VARCHAR(100),
    action VARCHAR(100),
    entity_type VARCHAR(100),
    entity_id BIGINT UNSIGNED,
    old_value LONGTEXT,
    new_value LONGTEXT,
    ip_address VARCHAR(50),
    device_info TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(user_id),
    INDEX idx_audit_user (user_id),
    INDEX idx_audit_module (module_name),
    INDEX idx_audit_entity (entity_type, entity_id),
    INDEX idx_audit_date (created_at)
) ENGINE=InnoDB;

-- ============================================================
-- 39. SETTINGS
-- ============================================================
CREATE TABLE settings (
    setting_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    organization_id BIGINT UNSIGNED,
    setting_key VARCHAR(150) NOT NULL,
    setting_value TEXT,
    setting_group VARCHAR(100),
    is_encrypted BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE KEY uq_setting (organization_id, setting_key),
    CONSTRAINT fk_setting_org FOREIGN KEY (organization_id) REFERENCES organizations(organization_id),
    INDEX idx_setting_group (setting_group)
) ENGINE=InnoDB;

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================
-- SAMPLE DATA
-- ============================================================

INSERT INTO organizations
(organization_name, registration_no, gstin, pan, email, mobile, address, city, state, pin_code)
VALUES
('ABC Property Management Pvt. Ltd.', 'REG-MH-2026-001',
 '27ABCDE1234F1Z5', 'ABCDE1234F', 'admin@abcproperty.com',
 '9876543210', 'Mira Road East', 'Thane', 'Maharashtra', '401107');

INSERT INTO roles (role_name, description) VALUES
('SUPER_ADMIN','Complete system access'),
('PROPERTY_OWNER','Property owner access'),
('PROPERTY_MANAGER','Property management access'),
('ACCOUNTANT','Finance and accounting access'),
('STAFF','Limited operational access'),
('TENANT','Tenant mobile/web access');

INSERT INTO permissions (module_name, permission_name) VALUES
('PROPERTY','VIEW'),('PROPERTY','ADD'),('PROPERTY','EDIT'),('PROPERTY','DELETE'),('PROPERTY','APPROVE'),
('TENANT','VIEW'),('TENANT','ADD'),('TENANT','EDIT'),('TENANT','DELETE'),('TENANT','APPROVE'),
('RENT','VIEW'),('RENT','ADD'),('RENT','EDIT'),('RENT','APPROVE'),
('PAYMENT','VIEW'),('PAYMENT','ADD'),('PAYMENT','EDIT'),('PAYMENT','APPROVE'),
('EXPENSE','VIEW'),('EXPENSE','ADD'),('EXPENSE','EDIT'),('EXPENSE','APPROVE'),
('GST','VIEW'),('GST','ADD'),('GST','EDIT'),('GST','APPROVE'),
('PROPERTY_TAX','VIEW'),('PROPERTY_TAX','ADD'),('PROPERTY_TAX','EDIT'),('PROPERTY_TAX','APPROVE'),
('REPORTS','VIEW'),
('COMPLAINT','VIEW'),('COMPLAINT','ADD'),('COMPLAINT','EDIT'),('COMPLAINT','APPROVE');

INSERT INTO users
(organization_id, role_id, full_name, email, mobile, password_hash, status)
VALUES
(1, 1, 'System Administrator', 'admin@abcproperty.com', '9876543210',
 '$2y$10$REPLACE_WITH_BCRYPT_HASH', 'ACTIVE'),
(1, 2, 'Rajesh Sharma', 'owner@abcproperty.com', '9876543211',
 '$2y$10$REPLACE_WITH_BCRYPT_HASH', 'ACTIVE'),
(1, 3, 'Priya Manager', 'manager@abcproperty.com', '9876543212',
 '$2y$10$REPLACE_WITH_BCRYPT_HASH', 'ACTIVE'),
(1, 4, 'Amit Accountant', 'accounts@abcproperty.com', '9876543213',
 '$2y$10$REPLACE_WITH_BCRYPT_HASH', 'ACTIVE'),
(1, 5, 'Maintenance Staff', 'staff@abcproperty.com', '9876543214',
 '$2y$10$REPLACE_WITH_BCRYPT_HASH', 'ACTIVE');

INSERT INTO properties
(organization_id, owner_id, property_code, property_name, property_type,
 address, city, state, pin_code, built_up_area, carpet_area,
 purchase_date, purchase_value, current_value)
VALUES
(1, 2, 'ABC-MR-001', 'ABC PG Mira Road', 'PG',
 'Mira Road East', 'Thane', 'Maharashtra', '401107',
 12000, 9500, '2020-06-15', 35000000, 48000000);

INSERT INTO buildings
(property_id, building_code, building_name, number_of_floors,
 construction_year, building_type, parking_available,
 lift_available, security_available, common_area, maintenance_charges)
VALUES
(1, 'BLD-A', 'Building A', 3, 2019, 'PG Building',
 TRUE, TRUE, TRUE, 1500, 1000);

INSERT INTO floors (building_id, floor_number, floor_name) VALUES
(1, 0, 'Ground Floor'),
(1, 1, 'First Floor'),
(1, 2, 'Second Floor');

INSERT INTO units
(floor_id, unit_number, unit_type, room_size, sharing_type,
 monthly_rent, security_deposit, electricity_charge, water_charge,
 maintenance_charge, late_fee, notice_period_days)
VALUES
(1, 'G001', 'PG Room', 250, '4 Sharing', 15000, 30000, 0, 300, 1000, 100, 30),
(1, 'G002', 'PG Room', 250, '4 Sharing', 15000, 30000, 0, 300, 1000, 100, 30),
(2, '101', 'PG Room', 250, '4 Sharing', 15000, 30000, 0, 300, 1000, 100, 30),
(2, '102', 'PG Room', 250, '3 Sharing', 17000, 34000, 0, 300, 1000, 100, 30),
(3, '201', 'PG Room', 300, '2 Sharing', 20000, 40000, 0, 300, 1200, 100, 30);

INSERT INTO beds (unit_id, bed_number, bed_type, monthly_rent, security_deposit) VALUES
(1,'A','Single Bed',15000,30000),
(1,'B','Single Bed',15000,30000),
(1,'C','Single Bed',15000,30000),
(1,'D','Single Bed',15000,30000),
(2,'A','Single Bed',15000,30000),
(2,'B','Single Bed',15000,30000),
(2,'C','Single Bed',15000,30000),
(2,'D','Single Bed',15000,30000),
(3,'A','Single Bed',15000,30000),
(3,'B','Single Bed',15000,30000),
(3,'C','Single Bed',15000,30000),
(3,'D','Single Bed',15000,30000);

INSERT INTO tenants
(full_name, mobile, email, date_of_birth, gender, address,
 emergency_contact_name, emergency_contact_mobile, occupation,
 company_name, id_type, id_number)
VALUES
('Rahul Patil','9000000001','rahul@example.com','1999-05-12','MALE',
 'Mumbai, Maharashtra','Suresh Patil','9000000011',
 'Software Engineer','XYZ Technologies','AADHAAR','XXXX-XXXX-1111'),
('Neha Shah','9000000002','neha@example.com','2000-08-20','FEMALE',
 'Thane, Maharashtra','Meena Shah','9000000012',
 'Designer','ABC Design','PAN','ABCDE1234P');

INSERT INTO tenant_kyc
(tenant_id, status, submitted_at, verification_date, verified_by, remarks)
VALUES
(1,'VERIFIED',NOW(),NOW(),3,'Documents verified'),
(2,'KYC_SUBMITTED',NOW(),NULL,NULL,'Awaiting verification');

INSERT INTO tenant_documents
(tenant_id, document_type, document_number, file_path, verification_status, verified_by, verified_at)
VALUES
(1,'AADHAAR','XXXX-XXXX-1111','/documents/tenant1/aadhaar.pdf','VERIFIED',3,NOW()),
(1,'PHOTO',NULL,'/documents/tenant1/photo.jpg','VERIFIED',3,NOW()),
(2,'PAN','ABCDE1234P','/documents/tenant2/pan.pdf','PENDING',NULL,NULL);

INSERT INTO rent_plans
(property_id, plan_name, base_rent, maintenance_charge, water_charge,
 electricity_mode, electricity_charge, security_deposit, late_fee, due_day, gst_applicable)
VALUES
(1,'Standard PG Plan',15000,1000,300,'ACTUAL',0,30000,100,5,FALSE),
(1,'Premium PG Plan',20000,1200,300,'ACTUAL',0,40000,100,5,FALSE);

INSERT INTO rental_agreements
(tenant_id, property_id, unit_id, bed_id, rent_plan_id, agreement_number,
 start_date, end_date, monthly_rent, security_deposit, due_day,
 notice_period_days, late_fee, status, signed_date)
VALUES
(1,1,1,1,1,'AGR-2026-0001','2026-09-01','2027-08-31',
 15000,30000,5,30,100,'ACTIVE','2026-08-30'),
(2,1,2,5,1,'AGR-2026-0002','2026-09-05','2027-09-04',
 15000,30000,5,30,100,'ACTIVE','2026-09-04');

INSERT INTO security_deposits
(tenant_id, agreement_id, deposit_amount, received_amount,
 status, received_date)
VALUES
(1,1,30000,30000,'HELD','2026-09-01'),
(2,2,30000,30000,'HELD','2026-09-05');

INSERT INTO expense_categories (category_name) VALUES
('Electricity'),('Water'),('Internet'),('Security'),('Cleaning'),
('Repair'),('Maintenance'),('Salary'),('Property Tax'),('Insurance'),
('Legal'),('Advertising'),('Other');

INSERT INTO vendors
(vendor_name, company_name, gstin, mobile, email, address, services)
VALUES
('Mira Electricals','Mira Electricals Pvt. Ltd.','27ABCDE5555A1Z1',
 '9000000101','vendor@example.com','Mira Road East','Electrical Maintenance');

INSERT INTO expenses
(property_id, building_id, vendor_id, category_id, expense_date,
 invoice_number, amount, gst_amount, payment_mode, remarks, created_by)
VALUES
(1,1,1,1,'2026-09-10','EXP-001',25000,4500,
 'BANK_TRANSFER','Monthly electricity expense',4);

INSERT INTO property_taxes
(property_id, tax_authority, property_tax_number, assessment_number,
 ward, zone, financial_year, tax_amount, penalty, due_date)
VALUES
(1,'Municipal Corporation','PT-MR-001','ASM-2026-001',
 'Mira Road Ward','Zone 3','2026-27',125000,0,'2027-03-31');

INSERT INTO gst_settings
(organization_id, gstin, registration_type, default_tax_rate,
 hsn_sac, cgst_rate, sgst_rate, igst_rate, effective_from)
VALUES
(1,'27ABCDE1234F1Z5','REGULAR',18.00,'9972',
 9.00,9.00,18.00,'2026-04-01');

INSERT INTO ledger_accounts
(account_code, account_name, account_type)
VALUES
('1000','Cash','ASSET'),
('1010','Bank','ASSET'),
('1100','Accounts Receivable - Tenants','ASSET'),
('2000','Security Deposits Payable','LIABILITY'),
('4000','Rental Income','INCOME'),
('4100','Maintenance Income','INCOME'),
('5000','Electricity Expense','EXPENSE'),
('5010','Water Expense','EXPENSE'),
('5020','Repairs Expense','EXPENSE'),
('5030','Salary Expense','EXPENSE'),
('5040','Property Tax Expense','EXPENSE');

INSERT INTO notification_templates
(template_name,event_code,channel,subject,message_template)
VALUES
('Rent Invoice SMS','RENT_GENERATED','SMS',NULL,
 'Dear {{tenant_name}}, your rent invoice of Rs.{{amount}} is due on {{due_date}}.'),
('Rent Reminder WhatsApp','RENT_DUE','WHATSAPP','Rent Reminder',
 'Dear {{tenant_name}}, your rent of Rs.{{amount}} is due on {{due_date}}.'),
('Payment Confirmation SMS','PAYMENT_SUCCESS','SMS',NULL,
 'Payment of Rs.{{amount}} received successfully. Receipt: {{receipt_number}}.'),
('Payment Receipt Email','PAYMENT_SUCCESS','EMAIL','Rent Payment Receipt',
 'Dear {{tenant_name}}, your payment of Rs.{{amount}} has been received.');

INSERT INTO settings (organization_id, setting_key, setting_value, setting_group)
VALUES
(1,'CURRENCY','INR','GENERAL'),
(1,'CURRENCY_SYMBOL','₹','GENERAL'),
(1,'DEFAULT_DUE_DAY','5','RENT'),
(1,'REMINDER_DAYS_BEFORE','3','NOTIFICATION'),
(1,'REMINDER_DAYS_AFTER','1,3,7,15','NOTIFICATION');

-- ============================================================
-- VIEWS
-- ============================================================

-- Property hierarchy
CREATE OR REPLACE VIEW vw_property_hierarchy AS
SELECT
    p.property_id,
    p.property_code,
    p.property_name,
    p.property_type,
    b.building_id,
    b.building_name,
    f.floor_id,
    f.floor_number,
    f.floor_name,
    u.unit_id,
    u.unit_number,
    u.unit_type,
    u.status AS unit_status,
    bed.bed_id,
    bed.bed_number,
    bed.status AS bed_status
FROM properties p
LEFT JOIN buildings b ON b.property_id = p.property_id
LEFT JOIN floors f ON f.building_id = b.building_id
LEFT JOIN units u ON u.floor_id = f.floor_id
LEFT JOIN beds bed ON bed.unit_id = u.unit_id;

-- Occupancy dashboard
CREATE OR REPLACE VIEW vw_occupancy_dashboard AS
SELECT
    p.property_id,
    p.property_name,
    COUNT(u.unit_id) AS total_units,
    COALESCE(SUM(u.status = 'OCCUPIED'),0) AS occupied_units,
    COALESCE(SUM(u.status = 'AVAILABLE'),0) AS vacant_units,
    COALESCE(SUM(u.status = 'MAINTENANCE'),0) AS maintenance_units,
    COALESCE(SUM(u.status = 'BLOCKED'),0) AS blocked_units,
    ROUND(
        COALESCE(SUM(u.status = 'OCCUPIED') * 100.0 / NULLIF(COUNT(u.unit_id),0),0),
        2
    ) AS occupancy_percentage
FROM properties p
LEFT JOIN buildings b ON b.property_id = p.property_id
LEFT JOIN floors f ON f.building_id = b.building_id
LEFT JOIN units u ON u.floor_id = f.floor_id
GROUP BY p.property_id, p.property_name;

-- Tenant current allocation
CREATE OR REPLACE VIEW vw_tenant_current_allocation AS
SELECT
    t.tenant_id,
    t.full_name,
    t.mobile,
    t.email,
    p.property_id,
    p.property_name,
    b.building_name,
    f.floor_number,
    u.unit_number,
    bed.bed_number,
    ra.agreement_number,
    ra.start_date,
    ra.end_date,
    ra.monthly_rent,
    ra.status AS agreement_status
FROM tenants t
JOIN rental_agreements ra
    ON ra.tenant_id = t.tenant_id
LEFT JOIN properties p
    ON p.property_id = ra.property_id
LEFT JOIN units u
    ON u.unit_id = ra.unit_id
LEFT JOIN beds bed
    ON bed.bed_id = ra.bed_id
LEFT JOIN floors f
    ON f.floor_id = u.floor_id
LEFT JOIN buildings b
    ON b.building_id = f.building_id
WHERE ra.status = 'ACTIVE';

-- Outstanding rent
CREATE OR REPLACE VIEW vw_rent_outstanding AS
SELECT
    i.invoice_id,
    i.invoice_number,
    i.invoice_month,
    i.invoice_date,
    i.due_date,
    t.tenant_id,
    t.full_name AS tenant_name,
    t.mobile,
    p.property_name,
    i.total_amount,
    i.paid_amount,
    i.outstanding_amount,
    i.status,
    CASE
        WHEN i.outstanding_amount > 0 AND CURDATE() > i.due_date
        THEN DATEDIFF(CURDATE(), i.due_date)
        ELSE 0
    END AS overdue_days
FROM rent_invoices i
JOIN tenants t ON t.tenant_id = i.tenant_id
JOIN rental_agreements ra ON ra.agreement_id = i.agreement_id
JOIN properties p ON p.property_id = ra.property_id
WHERE i.outstanding_amount > 0;

-- Monthly collection
CREATE OR REPLACE VIEW vw_monthly_collection AS
SELECT
    DATE_FORMAT(payment_date,'%Y-%m') AS collection_month,
    SUM(CASE WHEN status='SUCCESS' THEN amount ELSE 0 END) AS successful_collection,
    SUM(CASE WHEN status='FAILED' THEN amount ELSE 0 END) AS failed_amount,
    COUNT(CASE WHEN status='SUCCESS' THEN 1 END) AS successful_transactions
FROM payments
GROUP BY DATE_FORMAT(payment_date,'%Y-%m');

-- Property financial summary
CREATE OR REPLACE VIEW vw_property_rent_summary AS
SELECT
    ra.property_id,
    SUM(i.total_amount) AS total_invoiced,
    SUM(i.paid_amount) AS total_collected,
    SUM(i.outstanding_amount) AS total_outstanding
FROM rental_agreements ra
JOIN rent_invoices i ON i.agreement_id = ra.agreement_id
GROUP BY ra.property_id;

CREATE OR REPLACE VIEW vw_property_expense_summary AS
SELECT
    property_id,
    SUM(amount + gst_amount) AS total_expenses
FROM expenses
GROUP BY property_id;

CREATE OR REPLACE VIEW vw_property_financial_summary AS
SELECT
    p.property_id,
    p.property_name,
    COALESCE(r.total_invoiced,0) AS total_invoiced,
    COALESCE(r.total_collected,0) AS total_collected,
    COALESCE(r.total_outstanding,0) AS total_outstanding,
    COALESCE(e.total_expenses,0) AS total_expenses,
    COALESCE(r.total_collected,0) - COALESCE(e.total_expenses,0) AS net_cash_position
FROM properties p
LEFT JOIN vw_property_rent_summary r
    ON r.property_id = p.property_id
LEFT JOIN vw_property_expense_summary e
    ON e.property_id = p.property_id;

-- Open complaints
CREATE OR REPLACE VIEW vw_open_complaints AS
SELECT
    c.complaint_id,
    c.complaint_number,
    c.title,
    c.category,
    c.priority,
    c.status,
    t.full_name AS tenant_name,
    t.mobile,
    p.property_name,
    u.unit_number,
    s.full_name AS assigned_staff,
    c.created_at
FROM complaints c
JOIN tenants t ON t.tenant_id = c.tenant_id
JOIN properties p ON p.property_id = c.property_id
LEFT JOIN units u ON u.unit_id = c.unit_id
LEFT JOIN users s ON s.user_id = c.assigned_to
WHERE c.status <> 'CLOSED';

-- ============================================================
-- STORED PROCEDURES
-- ============================================================

DELIMITER $$

-- Generate one monthly invoice
CREATE PROCEDURE sp_generate_rent_invoice(
    IN p_agreement_id BIGINT UNSIGNED,
    IN p_invoice_month DATE
)
BEGIN
    DECLARE v_tenant_id BIGINT UNSIGNED;
    DECLARE v_rent DECIMAL(12,2);
    DECLARE v_maintenance DECIMAL(12,2);
    DECLARE v_water DECIMAL(12,2);
    DECLARE v_other DECIMAL(12,2);
    DECLARE v_due_day INT;
    DECLARE v_invoice_date DATE;
    DECLARE v_due_date DATE;
    DECLARE v_total DECIMAL(12,2);
    DECLARE v_invoice_number VARCHAR(100);
    DECLARE v_invoice_id BIGINT UNSIGNED;

    SELECT tenant_id, monthly_rent, due_day, other_charges
      INTO v_tenant_id, v_rent, v_due_day, v_other
    FROM rental_agreements
    WHERE agreement_id = p_agreement_id
      AND status = 'ACTIVE';

    SELECT maintenance_charge, water_charge
      INTO v_maintenance, v_water
    FROM rent_plans rp
    JOIN rental_agreements ra ON ra.rent_plan_id = rp.rent_plan_id
    WHERE ra.agreement_id = p_agreement_id;

    SET v_invoice_date = p_invoice_month;
    SET v_due_date = DATE_ADD(
        DATE_FORMAT(p_invoice_month,'%Y-%m-01'),
        INTERVAL (v_due_day - 1) DAY
    );

    SET v_total = v_rent + COALESCE(v_maintenance,0)
                    + COALESCE(v_water,0) + COALESCE(v_other,0);

    SET v_invoice_number = CONCAT(
        'INV-', DATE_FORMAT(p_invoice_month,'%Y%m'),
        '-', LPAD(p_agreement_id,6,'0')
    );

    INSERT INTO rent_invoices (
        tenant_id, agreement_id, invoice_number,
        invoice_month, invoice_date, due_date,
        base_rent, maintenance, water, other_charges,
        taxable_amount, total_amount, outstanding_amount
    )
    VALUES (
        v_tenant_id, p_agreement_id, v_invoice_number,
        DATE_FORMAT(p_invoice_month,'%Y-%m-01'),
        v_invoice_date, v_due_date,
        v_rent, COALESCE(v_maintenance,0), COALESCE(v_water,0),
        COALESCE(v_other,0),
        v_total, v_total, v_total
    );

    SET v_invoice_id = LAST_INSERT_ID();

    INSERT INTO invoice_items
    (invoice_id, item_type, description, quantity, rate, amount, taxable)
    VALUES
    (v_invoice_id,'RENT','Monthly Rent',1,v_rent,v_rent,FALSE);

    IF COALESCE(v_maintenance,0) > 0 THEN
        INSERT INTO invoice_items
        (invoice_id,item_type,description,quantity,rate,amount,taxable)
        VALUES
        (v_invoice_id,'MAINTENANCE','Maintenance Charge',
         1,v_maintenance,v_maintenance,FALSE);
    END IF;

END$$

-- Generate invoices for all active agreements
CREATE PROCEDURE sp_generate_monthly_rent(
    IN p_invoice_month DATE
)
BEGIN
    DECLARE done INT DEFAULT FALSE;
    DECLARE v_agreement_id BIGINT UNSIGNED;

    DECLARE cur CURSOR FOR
        SELECT agreement_id
        FROM rental_agreements
        WHERE status='ACTIVE'
          AND start_date <= LAST_DAY(p_invoice_month)
          AND (end_date IS NULL OR end_date >= p_invoice_month);

    DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;

    OPEN cur;

    read_loop: LOOP
        FETCH cur INTO v_agreement_id;
        IF done THEN
            LEAVE read_loop;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM rent_invoices
            WHERE agreement_id=v_agreement_id
              AND invoice_month=DATE_FORMAT(p_invoice_month,'%Y-%m-01')
        ) THEN
            CALL sp_generate_rent_invoice(v_agreement_id,p_invoice_month);
        END IF;
    END LOOP;

    CLOSE cur;
END$$

-- Record a successful payment
CREATE PROCEDURE sp_record_payment(
    IN p_invoice_id BIGINT UNSIGNED,
    IN p_amount DECIMAL(12,2),
    IN p_payment_mode VARCHAR(30),
    IN p_reference VARCHAR(150)
)
BEGIN
    DECLARE v_tenant_id BIGINT UNSIGNED;

    SELECT tenant_id INTO v_tenant_id
    FROM rent_invoices
    WHERE invoice_id=p_invoice_id;

    INSERT INTO payments
    (invoice_id,tenant_id,payment_reference,amount,payment_mode,status)
    VALUES
    (p_invoice_id,v_tenant_id,p_reference,p_amount,p_payment_mode,'SUCCESS');

    -- Invoice amounts/status are updated by trigger.
END$$

-- Mark overdue invoices
CREATE PROCEDURE sp_mark_overdue_invoices()
BEGIN
    UPDATE rent_invoices
    SET status='OVERDUE'
    WHERE outstanding_amount > 0
      AND due_date < CURDATE()
      AND status IN ('PENDING','PARTIALLY_PAID');
END$$

-- Get tenant statement
CREATE PROCEDURE sp_tenant_statement(
    IN p_tenant_id BIGINT UNSIGNED,
    IN p_from_date DATE,
    IN p_to_date DATE
)
BEGIN
    SELECT
        i.invoice_date AS transaction_date,
        'INVOICE' AS transaction_type,
        i.invoice_number AS reference_no,
        i.total_amount AS debit,
        0 AS credit,
        i.outstanding_amount
    FROM rent_invoices i
    WHERE i.tenant_id=p_tenant_id
      AND i.invoice_date BETWEEN p_from_date AND p_to_date

    UNION ALL

    SELECT
        p.payment_date,
        'PAYMENT',
        COALESCE(p.payment_reference,CONCAT('PAY-',p.payment_id)),
        0,
        p.amount,
        NULL
    FROM payments p
    WHERE p.tenant_id=p_tenant_id
      AND p.status='SUCCESS'
      AND DATE(p.payment_date) BETWEEN p_from_date AND p_to_date

    ORDER BY transaction_date;
END$$

DELIMITER ;


-- ============================================================
-- OLD MYSQL COMPATIBILITY TRIGGERS FOR updated_at
-- ============================================================

DELIMITER $$

CREATE TRIGGER trg_organizations_updated_at
BEFORE UPDATE ON organizations
FOR EACH ROW
BEGIN
    SET NEW.updated_at = NOW();
END$$

CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
BEGIN
    SET NEW.updated_at = NOW();
END$$

CREATE TRIGGER trg_properties_updated_at
BEFORE UPDATE ON properties
FOR EACH ROW
BEGIN
    SET NEW.updated_at = NOW();
END$$

CREATE TRIGGER trg_units_updated_at
BEFORE UPDATE ON units
FOR EACH ROW
BEGIN
    SET NEW.updated_at = NOW();
END$$

CREATE TRIGGER trg_tenants_updated_at
BEFORE UPDATE ON tenants
FOR EACH ROW
BEGIN
    SET NEW.updated_at = NOW();
END$$

DELIMITER ;

-- ============================================================
-- TRIGGERS
-- ============================================================

DELIMITER $$

-- Update invoice whenever a successful payment is inserted
CREATE TRIGGER trg_payment_after_insert
AFTER INSERT ON payments
FOR EACH ROW
BEGIN
    IF NEW.status='SUCCESS' THEN
        UPDATE rent_invoices
        SET paid_amount = (
                SELECT COALESCE(SUM(amount),0)
                FROM payments
                WHERE invoice_id=NEW.invoice_id
                  AND status='SUCCESS'
            ),
            outstanding_amount = GREATEST(
                total_amount - (
                    SELECT COALESCE(SUM(amount),0)
                    FROM payments
                    WHERE invoice_id=NEW.invoice_id
                      AND status='SUCCESS'
                ), 0
            ),
            status = CASE
                WHEN (
                    SELECT COALESCE(SUM(amount),0)
                    FROM payments
                    WHERE invoice_id=NEW.invoice_id
                      AND status='SUCCESS'
                ) >= total_amount THEN 'PAID'
                WHEN (
                    SELECT COALESCE(SUM(amount),0)
                    FROM payments
                    WHERE invoice_id=NEW.invoice_id
                      AND status='SUCCESS'
                ) > 0 THEN 'PARTIALLY_PAID'
                WHEN due_date < CURDATE() THEN 'OVERDUE'
                ELSE 'PENDING'
            END
        WHERE invoice_id=NEW.invoice_id;
    END IF;
    IF NEW.status='SUCCESS' THEN
        INSERT INTO receipts
        (payment_id,receipt_number,amount)
        VALUES
        (
            NEW.payment_id,
            CONCAT('RCT-',DATE_FORMAT(CURDATE(),'%Y%m%d'),'-',
                   LPAD(NEW.payment_id,6,'0')),
            NEW.amount
        );
    END IF;
END$$

-- Keep invoice amounts/status correct after payment update
CREATE TRIGGER trg_payment_after_update
AFTER UPDATE ON payments
FOR EACH ROW
BEGIN
    UPDATE rent_invoices
    SET paid_amount = (
            SELECT COALESCE(SUM(amount),0)
            FROM payments
            WHERE invoice_id=NEW.invoice_id
              AND status='SUCCESS'
        ),
        outstanding_amount = GREATEST(
            total_amount - (
                SELECT COALESCE(SUM(amount),0)
                FROM payments
                WHERE invoice_id=NEW.invoice_id
                  AND status='SUCCESS'
            ),0
        ),
        status = CASE
            WHEN (
                SELECT COALESCE(SUM(amount),0)
                FROM payments
                WHERE invoice_id=NEW.invoice_id
                  AND status='SUCCESS'
            ) >= total_amount THEN 'PAID'
            WHEN (
                SELECT COALESCE(SUM(amount),0)
                FROM payments
                WHERE invoice_id=NEW.invoice_id
                  AND status='SUCCESS'
            ) > 0 THEN 'PARTIALLY_PAID'
            WHEN due_date < CURDATE() THEN 'OVERDUE'
            ELSE 'PENDING'
        END
    WHERE invoice_id=NEW.invoice_id;
END$$

-- Automatically set unit occupancy for a new active agreement
CREATE TRIGGER trg_agreement_after_insert
AFTER INSERT ON rental_agreements
FOR EACH ROW
BEGIN
    IF NEW.status='ACTIVE' THEN
        IF NEW.bed_id IS NOT NULL THEN
            UPDATE beds
            SET status='OCCUPIED'
            WHERE bed_id=NEW.bed_id;
        END IF;

        IF NEW.unit_id IS NOT NULL THEN
            UPDATE units u
            SET status = CASE
                WHEN EXISTS (
                    SELECT 1 FROM beds b
                    WHERE b.unit_id=u.unit_id
                      AND b.status='AVAILABLE'
                ) THEN 'PARTIALLY_OCCUPIED'
                ELSE 'OCCUPIED'
            END
            WHERE u.unit_id=NEW.unit_id;
        END IF;
    END IF;
END$$

-- Set bed/unit availability when an agreement is terminated
CREATE TRIGGER trg_agreement_after_update
AFTER UPDATE ON rental_agreements
FOR EACH ROW
BEGIN
    IF OLD.status='ACTIVE' AND NEW.status IN ('TERMINATED','EXPIRED') THEN

        IF NEW.bed_id IS NOT NULL THEN
            UPDATE beds
            SET status='AVAILABLE'
            WHERE bed_id=NEW.bed_id;
        END IF;

        IF NEW.unit_id IS NOT NULL THEN
            UPDATE units u
            SET status = CASE
                WHEN EXISTS (
                    SELECT 1 FROM beds b
                    WHERE b.unit_id=u.unit_id
                      AND b.status='OCCUPIED'
                )
                AND EXISTS (
                    SELECT 1 FROM beds b
                    WHERE b.unit_id=u.unit_id
                      AND b.status='AVAILABLE'
                ) THEN 'PARTIALLY_OCCUPIED'

                WHEN EXISTS (
                    SELECT 1 FROM beds b
                    WHERE b.unit_id=u.unit_id
                      AND b.status='OCCUPIED'
                ) THEN 'OCCUPIED'

                ELSE 'AVAILABLE'
            END
            WHERE u.unit_id=NEW.unit_id;
        END IF;
    END IF;
END$$

-- Prevent negative/zero payments
CREATE TRIGGER trg_payment_before_insert
BEFORE INSERT ON payments
FOR EACH ROW
BEGIN
    /* MySQL 5.1 compatibility: maintain created_at through the trigger. */
    IF NEW.created_at IS NULL THEN
        SET NEW.created_at = NOW();
    END IF;

    /* Old MySQL compatibility: SIGNAL is not supported.
       Application code should validate payment amount > 0. */
    IF NEW.amount <= 0 THEN
        SET NEW.amount = 0;
    END IF;
END$$

-- Prevent invalid ledger entry where both debit and credit are entered
CREATE TRIGGER trg_ledger_before_insert
BEFORE INSERT ON ledger_entries
FOR EACH ROW
BEGIN
    /* Old MySQL compatibility: SIGNAL is not supported.
       Invalid ledger rows are normalized to zero rather than raising SIGNAL. */
    IF NEW.debit < 0 THEN SET NEW.debit = 0; END IF;
    IF NEW.credit < 0 THEN SET NEW.credit = 0; END IF;

    IF NEW.debit > 0 AND NEW.credit > 0 THEN
        SET NEW.credit = 0;
    END IF;

    IF NEW.debit = 0 AND NEW.credit = 0 THEN
        SET NEW.debit = 0;
        SET NEW.credit = 0;
    END IF;
END$$

DELIMITER ;

-- ============================================================
-- TEST DATA: generate September 2026 invoices
-- ============================================================
CALL sp_generate_monthly_rent('2026-09-01');

-- ============================================================
-- TEST SUCCESSFUL PAYMENT
-- ============================================================
-- The following is intentionally commented out.
-- Uncomment to test payment/receipt/invoice triggers:
--
-- CALL sp_record_payment(1,5000,'UPI','UPI-TEST-0001');

-- ============================================================
-- USEFUL TEST QUERIES
-- ============================================================
-- SELECT * FROM vw_property_hierarchy;
-- SELECT * FROM vw_occupancy_dashboard;
-- SELECT * FROM vw_tenant_current_allocation;
-- SELECT * FROM vw_rent_outstanding;
-- SELECT * FROM vw_monthly_collection;
-- SELECT * FROM vw_property_financial_summary;
-- SELECT * FROM vw_open_complaints;
--
-- CALL sp_mark_overdue_invoices();
-- CALL sp_tenant_statement(1,'2026-09-01','2026-09-30');

-- ============================================================
-- END OF DATABASE SCRIPT
-- ============================================================
