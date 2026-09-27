# Property and Rent Management System (MVP, Phases 1 to 3)

Admin web app plus tenant web app plus REST API plus database. Scope is exactly the brief: property hierarchy, tenants and KYC, rent plans and agreements, monthly invoicing, manual payment recording with auto receipts, tenant self service, complaints, in-app plus email notifications. Out of scope items (GST, property tax tracking UI, vendors and expenses UI, full accounting, SMS and WhatsApp sending, live gateway, native app, AI assistant) are not built. Their tables exist in the schema so a later phase can attach logic without migrations.

## Layout

- `backend/` Node.js plus Express plus SQLite (`node:sqlite`, zero native build). JWT auth for staff, mobile plus OTP for tenants, RBAC from the `role_permissions` table at the API layer, central event bus (`src/events.js`), scheduler (`node-cron`) for monthly rent and overdue marking.
- `frontend/` One Vite plus React build serving both sides: `/admin/*` (left nav, data dense tables) and `/tenant/*` (single column, thumb reachable). Grayscale only per Section 7.
- `property_rent_management_mysql51_final_import_ready.sql` Legacy reference schema. The running schema is `backend/src/schema.js`, a line for line port to modern SQLite with real `CHECK` errors (payments must be over 0, ledger rows cannot carry both debit and credit).
- `verify-e2e.mjs` End to end check (15 assertions, all passing).

## Run locally

Requirements: Node 22 or newer (uses built in `node:sqlite`), npm.

Terminal 1, backend (port 4000, auto creates and seeds `backend/data/prm.sqlite`):

```
cd backend
npm install
npm start
```

Terminal 2, frontend (port 5173, proxies `/api` to 4000):

```
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. The backend also serves the production build, so `npm run build` in frontend followed by backend `npm start` is enough for a single process demo.

Demo logins (seeded):

- Admin: `admin@abcproperty.com` / `admin123` (also owner, manager, accountant on `*@abcproperty.com` / `admin123`).
- Tenant: mobile `9000000001`. Request OTP, then enter the OTP shown on screen (demo mode returns it directly, since no SMS vendor is wired in v1).

## Demo script (matches success criteria)

1. Sign in as admin. Dashboard shows portfolio and finance.
2. Properties page: add property, building, floor, room, bed.
3. Tenants page: register tenant, mark KYC verified.
4. Agreements page: create agreement with status ACTIVE. The room flips to Occupied or Partially Occupied automatically.
5. Invoices page: set month to the first of a month, press Generate month. One `INV-YYYYMM-000000` per active agreement appears, duplicates skipped.
6. Record a payment against an invoice (confirm step). Paid amount, outstanding and status update immediately, receipt `RCT-YYYYMMDD-000000` appears under Payments.
7. Sign in as tenant (OTP). Home shows dues and Pay rent. Rent tab shows invoices and downloadable receipts. File a complaint and watch it under admin Complaints, then advance it.

## API notes

- `POST /api/auth/login`, `POST /api/auth/tenant/request-otp`, `POST /api/auth/tenant/verify-otp`
- CRUD: `/api/properties`, `/api/buildings`, `/api/floors`, `/api/units`, `/api/beds`, `/api/tenants`, `/api/rent-plans`, plus `/api/agreements` (occupancy transitions, terminate needs `confirm=true`).
- Billing: `POST /api/jobs/generate-rent {month}`, `POST /api/jobs/mark-overdue`, `POST /api/payments {invoice_id, amount, payment_mode, confirm:true}`, `GET /api/invoices/:id`, `GET /api/receipts`, `GET /api/statements/:tenantId`.
- Ops: `/api/complaints`, `/api/notifications`, `/api/dashboard/summary`, `/api/audit-logs`, tenant self service under `/api/tenant/*`.

Cron runs monthly generation on the 1st at 01:00 and overdue marking daily at 02:00, with no admin logged in. An invoice reaches PAID only through real SUCCESS payment rows. GST fields exist but stay 0 in v1. Email is logged to `email_logs` and console; SMS and WhatsApp write PENDING stubs to their log tables behind a clean provider interface for later.
