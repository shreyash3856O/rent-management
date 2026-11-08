# Rent Ledger — Property & Rent Management System

> **Enterprise-Ready Property, Tenant & Rent Management Platform**  
> *Admin Web Portal • Tenant Self-Service Web & Native Android Mobile App • Double-Entry Accounting • Google Play Store Ready*

---

## Table of Contents
1. [System Overview](#system-overview)
2. [Architecture & System Design](#architecture--system-design)
3. [Technology Stack](#technology-stack)
4. [Core Modules & SRS Implementation](#core-modules--srs-implementation)
5. [Role-Based Access Control (RBAC)](#role-based-access-control-rbac)
6. [Google Play Store & Native Mobile Readiness](#google-play-store--native-mobile-readiness)
7. [Performance & Stress Test Benchmarks](#performance--stress-test-benchmarks)
8. [Local Development & Setup](#local-development--setup)
9. [Docker & Production Deployment](#docker--production-deployment)
10. [API Reference](#api-reference)
11. [Testing & Verification](#testing--verification)

---

## System Overview

Rent Ledger is a property management platform designed to manage residential apartments, co-living spaces, hostels, and commercial real estate. It unifies operations across:
- **Property Hierarchy**: Multi-property, building, floor, room/unit, and PG/hostel bed inventory.
- **Tenant Self-Service**: Mobile onboarding, public room & bed selection, Govt ID KYC upload, rent ledger, complaints, and digital receipts.
- **Financial Engine**: Automated monthly invoice generation, manual and gateway-ready payment reconciliation, printable GST-compliant receipts, and a double-entry general ledger.
- **Move-Out Settlement**: Automatic deduction processing and deposit refund engine.
- **Compliance & Privacy**: Web and in-app account deletion compliant with Google Play Data Safety policies, served alongside terms and privacy endpoints.

---

## Architecture & System Design

```
+-----------------------------------------------------------------------------------+
|                                  CLIENT LAYER                                     |
|                                                                                   |
|  +----------------------------------+     +------------------------------------+  |
|  |     Admin Web Portal (React)     |     |    Tenant App (React PWA / Android)|  |
|  |   - Property & Tenant Management |     |   - Self-Service Room/Bed Picker   |  |
|  |   - Double-Entry Accounting      |     |   - KYC ID Document Upload         |  |
|  |   - Invoicing, Expenses & Tax    |     |   - Rent Dues & Instant Receipts   |  |
|  |   - 7 Comprehensive Reports      |     |   - Complaint Filing with Photos   |  |
|  +----------------------------------+     +------------------------------------+  |
|                  |                                          |                     |
|                  +--------------------+---------------------+                     |
|                                       | HTTP / REST (JWT Auth)                    |
+---------------------------------------|-------------------------------------------+
                                        v
+-----------------------------------------------------------------------------------+
|                             API & APPLICATION LAYER                               |
|                                                                                   |
|  +-----------------------------------------------------------------------------+  |
|  |                           Express.js REST Server                            |  |
|  |  - Auth Middleware (JWT Bearer Token Validation, Auto-401 Session Expiry)   |  |
|  |  - RBAC Guard (Tenant Boundary Isolation, Granular Staff Permissions)       |  |
|  |  - Rate Limiting (In-memory token bucket, 3,000 req/min)                    |  |
|  +-----------------------------------------------------------------------------+  |
|            |                              |                             |         |
|            v                              v                             v         |
|  +--------------------+        +---------------------+       +-----------------+  |
|  | Core Services      |        | Automation & Cron   |       | Event Dispatch  |  |
|  | - Rent Engine      |        | - Monthly Rent Gen  |       | - Central Bus   |  |
|  | - Double-Entry GL  |        | - Overdue Escalation|       | - Brevo Email   |  |
|  | - Move-Out Settler |        | - Daily Reminders   |       | - Webhook SMS   |  |
|  | - 7 Report Engines |        |   (01:00 & 02:00)   |       | - WhatsApp Cloud|  |
|  +--------------------+        +---------------------+       +-----------------+  |
+---------------------------------------|-------------------------------------------+
                                        v
+-----------------------------------------------------------------------------------+
|                            DATABASE & STORAGE LAYER                               |
|                                                                                   |
|  +-----------------------------------------------------------------------------+  |
|  |              SQLite (WAL Mode) / Turso Embedded Replica (@libsql)           |  |
|  |  - PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 15000; (Concurrency)    |  |
|  |  - 51 Compound Performance Indexes covering all Foreign Keys & Query Paths  |  |
|  |  - Document & Photo Storage (Database BLOBs via Multer, survives wipeouts) |  |
|  |  - Double-Entry Balance Constraints (Debit == Credit, non-zero validation) |  |
|  +-----------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------+
```

---

## Technology Stack

### Backend
- **Runtime**: Node.js (v22+ LTS)
- **Framework**: Express.js 4.19
- **Database**: SQLite (via `@libsql/client` with local embedded file fallback and Turso Cloud sync)
- **Concurrency & WAL**: SQLite Write-Ahead Logging (`WAL`), `busy_timeout = 15000`, 64MB cache
- **Security & Auth**: JSON Web Tokens (`jsonwebtoken`), Bcrypt password hashing (`bcryptjs`), CORS
- **File Uploads**: `multer` with in-memory buffer validation, stored as encrypted database BLOBs
- **Job Scheduling**: `node-cron` (automated monthly rent run on 1st of month, daily overdue scanner)
- **Communications**: `nodemailer` (SMTP), Brevo HTTP API (transactional email & SMS), Meta WhatsApp Cloud API

### Frontend
- **Framework**: React 18.3
- **Build Tool**: Vite 5.4 (sub-second HMR and production bundle optimization)
- **Routing**: React Router 6.26 (Segmented guards for `/admin/*` and `/tenant/*`)
- **Design System**: Section 7 compliant grayscale design language (strict hairline borders, zero pill distortions, `#8a0000` reserved strictly for overdue warnings)
- **Layouts**: Responsive CSS Grid & Flexbox with `.table-wrap` horizontal touch scrolling

### Mobile & Native App
- **Hybrid Framework**: Capacitor 6.0
- **Android Target**: Android 14 (`targetSdkVersion 34`, `compileSdkVersion 34`, `minSdkVersion 24`)
- **App Capabilities**: Camera capture, media access, push notifications, FileProvider for secure document/receipt viewing
- **PWA**: Web App Manifest (`manifest.webmanifest`), Digital Asset Links (`/.well-known/assetlinks.json`)

---

## Core Modules & SRS Implementation

### 1. Hierarchy & Inventory Management
- Hierarchical structure: Organization &rarr; Property &rarr; Building &rarr; Floor &rarr; Unit/Room &rarr; Bed.
- Dynamic occupancy status machine: flips automatically between `AVAILABLE`, `PARTIALLY_OCCUPIED`, `OCCUPIED`, and `MAINTENANCE`.
- Support for both private flats/apartments and shared PG/hostel bed spaces.

### 2. Tenant Self-Service Onboarding & KYC
- **Public Inventory Discovery** (`GET /api/public/inventory`): Prospective tenants browse vacant units/rooms and beds without authentication.
- **Dynamic Selection UI**: Tenants pick property, room, bed, and move-in date. Real-time pricing display for monthly rent and security deposits.
- **KYC Pipeline** (`POST /api/auth/tenant/upload-kyc`): Secure upload of Govt ID proofs (Aadhaar, PAN, Passport, Driving License, Voter ID).
- **Automated Agreement Generation** (`POST /api/auth/tenant/register`): In a single ACID transaction:
  1. Creates tenant record.
  2. Provisions active rental agreement (`AGR-YYYY-XXXX`).
  3. Updates unit/bed status to `OCCUPIED`.
  4. Creates security deposit tracking record in `security_deposits`.
  5. Stores ID document under verification status `SUBMITTED`.
  6. Returns authenticated JWT session directly into the mobile tenant app.

### 3. Rent Invoicing & Receipts
- **Automated Monthly Billing**: `POST /api/jobs/generate-rent` runs on schedule to generate sequential invoices (`INV-YYYYMM-000000`) based on active agreements and linked rent plans.
- **Payment Recording**: Validates amounts against outstanding balances, supports multi-mode payments (UPI, Cash, Cheque, Bank Transfer), and handles proof screenshot uploads.
- **Digital Receipts**: Instant generation of printable receipts (`RCT-YYYYMMDD-000000`) with organization branding, line items, and audit timestamps.

### 4. Double-Entry Accounting & Ledger
- **Chart of Accounts**: 14 standard accounts seeded across `ASSET`, `LIABILITY`, `EQUITY`, `REVENUE`, and `EXPENSE`.
- **Journal Posting**: Transactional posting ensuring balanced debits and credits (`INSERT INTO ledger_entries`).
- **Financial Statements**: Live Trial Balance (`/api/ledger/summary`) and Profit & Loss report (`/api/accounting/pnl`).

### 5. Expenses, Vendors & Tax Compliance
- **Expense Tracking**: 12 default expense categories (Electricity, Plumbing, Security, Property Tax, Elevator AMC, Internet, etc.) with automatic ledger postings.
- **Vendor Directory**: Vendor management with category linking and contact details.
- **Property Tax & GST**: Tax assessment recording, due dates, penalty tracking, and GST collection summaries.

### 6. Complaints & Maintenance Dispatch
- End-to-end complaint lifecycle: `OPEN` &rarr; `ASSIGNED` &rarr; `IN_PROGRESS` &rarr; `RESOLVED` &rarr; `CLOSED`.
- Photo and document attachments stored securely and viewable inline.
- Link maintenance work orders to specific vendors and complaints.

### 7. Move-Out Settlement Engine
- Automated move-out processing (`POST /api/agreements/:id/move-out`).
- Calculates held security deposit, deducts pending rent dues and damage charges, and determines the final refund or recovery amount.
- Flips room and bed status back to `AVAILABLE`.

### 8. Analytics & Reporting (7 Core Engines)
1. **Occupancy Report**: Total units, occupied, vacant, under maintenance, and occupancy rate percentage.
2. **Rent Collection Report**: Total invoiced, collected, outstanding, overdue, and collection efficiency percentage.
3. **Financial (P&L) Report**: Total revenue, operational expenses, net operating income (NOI), and breakdown by category.
4. **GST Summary Report**: Taxable revenue, total GST collected (CGST/SGST), and invoice count.
5. **Property Tax Report**: Tax amounts due, paid, pending, and upcoming due dates per property.
6. **Tenant Report**: Active vs inactive count, verified vs pending KYC counts, and high-risk overdue flags.
7. **Maintenance Report**: Total complaints, resolved count, open count, and average resolution metrics.

---

## Role-Based Access Control (RBAC)

Rent Ledger enforces role isolation at the HTTP middleware layer:

| Role | Access Scope | Enforced Restrictions |
|---|---|---|
| **ADMIN / OWNER** | Full system access | Full read/write across all modules, configuration, and audit logs. |
| **PROPERTY_MANAGER** | Operational management | Full access to properties, agreements, tenants, and complaints. |
| **ACCOUNTANT** | Financial management | Read/write on invoices, payments, expenses, ledger, and tax reports. |
| **STAFF** | Day-to-day operations | Read access to tenants and units; write access to complaints and maintenance. |
| **TENANT** | Isolated Self-Service | Strictly restricted to `/api/tenant/*`, `/api/complaints`, and `/api/notifications`. Any attempt to access admin routes (`/api/properties`, `/api/ledger`, `/api/expenses`, etc.) returns **403 Forbidden**. |

---

## Google Play Store & Native Mobile Readiness

The mobile tenant app is configured for Google Play deployment:

- **Android SDK Configuration**:
  - `compileSdkVersion`: **34** (Android 14)
  - `targetSdkVersion`: **34** (Google Play Store 2024–2026 requirement)
  - `minSdkVersion`: **24** (Android 7.0+, covers 99.1% of active devices worldwide)
- **Hardware & Device Permissions**:
  - `android.permission.CAMERA`: Capturing KYC ID documents and complaint photos.
  - `android.permission.READ_MEDIA_IMAGES`: Uploading receipts and payment screenshots.
  - `android.permission.POST_NOTIFICATIONS`: Receiving invoice and payment push alerts.
  - `android.permission.INTERNET`: TLS/HTTPS communication with backend.
- **FileProvider Security**: Custom `file_paths.xml` FileProvider preventing `FileUriExposedException` when sharing or previewing PDF receipts and documents.
- **App Launcher Icons**: Generated across all Android mipmap densities (`mdpi`, `hdpi`, `xhdpi`, `xxhdpi`, `xxxhdpi`).
- **Play Store Mandatory Policies**:
  - **In-App & Web Account Deletion**: Tenant profile deletion endpoint (`POST /api/tenant/delete-account`) and web disclosure page (`/privacy#account-deletion`).
  - **Privacy Policy & Terms**: Served live at `/privacy` and `/terms`.
  - **Digital Asset Links**: Configured at `/.well-known/assetlinks.json` for Android App Links.

---

## Performance & Stress Test Benchmarks

Stress tested under realistic property and tenant volumes (`node backend/stress-test.mjs`):

```
================================================================
  PROPERTY & RENT MANAGEMENT SYSTEM: ENTERPRISE STRESS TEST     
  Simulated Capacity: 100 Properties, 5,000 Tenants Concurrency   
================================================================

--- Phase 1: High Concurrency Dashboard, Search & Reports ---
Requests:    1,000 requests (Concurrency: 50)
Duration:    2.06 seconds
Throughput:  486.4 req/sec
Errors:      0 (0.00% error rate)
Latency p50: 48.4 ms
Latency p95: 63.4 ms

--- Phase 2: Transactional Writes (Expenses, Complaints, Tasks) ---
Requests:    200 sequential & concurrent ledger write transactions
Duration:    0.69 seconds
Throughput:  291.1 writes/sec
Errors:      0 (0.00% error rate)
Latency p50: 86.6 ms

--- Phase 3: Mixed Production Traffic (Admin + Tenant Burst) ---
Requests:    500 mixed requests
Throughput:  453.0 req/sec
Errors:      0 (0.00% error rate)

--- Database Integrity Check ---
PRAGMA integrity_check: ok (Zero locks, zero corruptions under WAL mode)
```

---

## Local Development & Setup

### Prerequisites
- **Node.js**: v22.0.0 or higher
- **npm**: v10.0.0 or higher
- **Git**

### Installation

1. Clone repository:
   ```bash
   git clone https://github.com/shreyash3856O/rent-management.git
   cd rent-management
   ```

2. Configure environment:
   ```bash
   cp .env.example .env
   ```

3. Install dependencies:
   ```bash
   cd backend && npm install
   cd ../frontend && npm install
   cd ..
   ```

4. Build frontend React bundle:
   ```bash
   npm --prefix frontend run build
   ```

5. Launch server:
   ```bash
   node backend/src/app.js
   ```

The application is now accessible at `http://localhost:4000`:
- **Admin Portal**: `http://localhost:4000/login`
- **Tenant Sign In**: `http://localhost:4000/tenant/login`
- **Tenant Self-Registration**: `http://localhost:4000/tenant/register`
- **Privacy Policy**: `http://localhost:4000/privacy`

---

## Demo Credentials

| Role | Username / Identifier | Password / Code | Notes |
|---|---|---|---|
| **Admin** | `admin@abcproperty.com` | `admin123` | Full administrative access |
| **Owner** | `owner@abcproperty.com` | `admin123` | Financial & portfolio oversight |
| **Manager** | `manager@abcproperty.com` | `admin123` | Property & tenant operations |
| **Accountant** | `accountant@abcproperty.com` | `admin123` | Billing, invoices, ledger |
| **Tenant (Demo)**| Mobile: `9000000001` | OTP: `8520` | Pre-linked to room & agreement |

---

## Docker & Production Deployment

A single production Docker container serves both the compiled React frontend and the Express REST API.

```bash
docker compose up --build -d
```

### Environment Variables

| Variable | Description | Default / Example |
|---|---|---|
| `PORT` | HTTP Server Port | `4000` |
| `JWT_SECRET` | Secret key for JWT signing (**Required** in production) | `dev-secret-change-me` |
| `NODE_ENV` | Runtime environment (`production` or `development`) | `development` |
| `TURSO_URL` | Turso remote database URL (optional cloud sync) | `libsql://your-db.turso.io` |
| `TURSO_TOKEN` | Turso authorization token | `token...` |
| `BREVO_API_KEY` | Transactional email & SMS API key | `xkeysib-...` |
| `BREVO_SMS_SENDER`| Registered SMS sender ID | `RENTLD` |
| `WHATSAPP_TOKEN` | Meta WhatsApp Cloud API Token | `EAA...` |

---

## API Reference

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/api/health` | `GET` | Public | System uptime & database connection check |
| `/api/public/inventory` | `GET` | Public | List available units, rooms, and PG beds |
| `/api/auth/tenant/upload-kyc` | `POST` | Public | Upload Govt ID document for onboarding |
| `/api/auth/tenant/register` | `POST` | Public | Tenant self-registration with room assignment |
| `/api/auth/tenant/request-otp` | `POST` | Public | Request SMS/demo login OTP |
| `/api/auth/tenant/verify-otp` | `POST` | Public | Verify OTP and issue tenant JWT |
| `/api/auth/login` | `POST` | Public | Staff email/password authentication |
| `/api/properties` | `GET`, `POST` | Staff | List or create properties |
| `/api/units` | `GET`, `POST` | Staff | List or create rooms/units |
| `/api/beds` | `GET`, `POST` | Staff | List or create hostel/PG beds |
| `/api/tenants` | `GET`, `POST` | Staff | Tenant registry and KYC management |
| `/api/agreements` | `GET`, `POST`, `PUT` | Staff | Agreement contracts & status transitions |
| `/api/agreements/:id/move-out`| `POST` | Staff | Process move-out & deposit settlement |
| `/api/invoices` | `GET`, `POST` | Staff | Invoices, regeneration & line items |
| `/api/payments` | `GET`, `POST` | Staff | Record payments & auto-generate receipts |
| `/api/expenses` | `GET`, `POST` | Staff | Record operational expenses with GL posting |
| `/api/ledger/summary` | `GET` | Staff | Chart of Accounts Trial Balance |
| `/api/accounting/pnl` | `GET` | Staff | Profit & Loss Statement |
| `/api/reports/*` | `GET` | Staff | Occupancy, Collection, GST, Tax reports |
| `/api/tenant/me` | `GET` | Tenant | Tenant profile, active room & dues summary |
| `/api/tenant/invoices` | `GET` | Tenant | Tenant rent invoice history |
| `/api/tenant/payments` | `GET` | Tenant | Tenant payment receipts |
| `/api/tenant/documents` | `GET`, `POST` | Tenant | Tenant uploaded ID documents & agreements |
| `/api/tenant/statement` | `GET` | Tenant | Personal ledger statement |
| `/api/tenant/delete-account` | `POST` | Tenant | In-app self-service account deletion |

---

## Testing & Verification

Run the automated test suites:

1. **Integration Test Suite** (33 assertions covering RBAC, inventory, KYC, self-registration, billing, reports):
   ```bash
   node backend/test-suite.mjs
   ```

2. **Regression Verification Suite** (15 core E2E flow tests):
   ```bash
   node backend/run-verify-e2e.mjs
   ```

3. **High-Concurrency Stress Test** (1,700 requests simulating 100 properties & 5,000 tenants):
   ```bash
   node backend/stress-test.mjs
   ```

---

## License

This project is licensed under the MIT License.
