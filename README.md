# Property and Rent Management System (MVP, Phases 1 to 3)

Admin web app plus tenant web app plus REST API plus database. Scope is exactly the brief: property hierarchy, tenants and KYC, rent plans and agreements, monthly invoicing, manual payment recording with auto receipts, tenant self service, complaints, in-app plus email notifications. Out of scope items (GST, property tax tracking UI, vendors and expenses UI, full accounting, SMS and WhatsApp sending, live gateway, native app, AI assistant) are not built. Their tables exist in the schema so a later phase can attach logic without migrations.

## Layout

- `backend/` Node.js plus Express plus Turso (`@libsql/client`). Locally it is
  a plain SQLite file with zero setup; set `TURSO_URL` plus `TURSO_TOKEN` and
  it becomes an embedded replica that syncs to Turso in the background, so
  data survives disk wipes on free hosts. JWT auth for staff, mobile plus OTP
  for tenants, RBAC from the `role_permissions` table at the API layer,
  central event bus (`src/events.js`), scheduler (`node-cron`) for monthly
  rent and overdue marking. Uploads are stored as database blobs (not disk
  files) for the same survival reason.
- `frontend/` One Vite plus React build serving both sides: `/admin/*` (left nav, data dense tables) and `/tenant/*` (single column, thumb reachable). Grayscale only per Section 7.
- `property_rent_management_mysql51_final_import_ready.sql` Legacy reference schema. The running schema is `backend/src/schema.js`, a line for line port to modern SQLite with real `CHECK` errors (payments must be over 0, ledger rows cannot carry both debit and credit).
- `verify-e2e.mjs` End to end check (15 assertions, all passing).

## Run locally

Requirements: Node 22 or newer, npm. The database is a local SQLite file by
default; add `TURSO_URL` plus `TURSO_TOKEN` to sync with Turso.

```
cp .env.example .env   # then set JWT_SECRET at minimum
```

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

## Deploy (Docker, production)

```
cp .env.example .env   # set JWT_SECRET (compose refuses to start without it)
docker compose up --build -d
```

This builds one image (React build served by Express on :4000), persists the
local replica in `./data/`, and health checks `/api/health`. For hosted use,
set `TURSO_URL` plus `TURSO_TOKEN` so the database syncs to Turso and survives
disk wipes; uploads ride along because they live inside the database.
`NODE_ENV=production` enforces two guards: the server refuses to start without
`JWT_SECRET`, and tenant OTPs are sent only through the SMS seam, never
returned in the API response.

Bare metal works too: set the env vars from `.env.example`, run
`npm run build` in `frontend/`, then `node src/app.js` in `backend/`
behind any reverse proxy.

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

## Messaging: what actually sends

Notifications are dispatched automatically from one central event bus
(`backend/src/events.js`) on `RENT_GENERATED`, `PAYMENT_SUCCESS`, and
`PAYMENT_OVERDUE`. Every dispatch is recorded in `notifications` plus the
per channel log tables, so delivery is auditable either way.

| Channel | Status |
|---|---|
| In-app | Real. Written to `notifications`, visible in the tenant Notices tab. |
| Email | Real when `SMTP_HOST` (plus user, pass, from) is set, sent via SMTP on every billing event. Without SMTP config it logs to console and `email_logs` as `STUB_CONSOLE`, so demos work with zero setup. `email_logs` records `SENT`, `FAILED`, or `STUB_CONSOLE` with the provider message id or error. |
| SMS | Seam is live, vendor is not bundled. Set `SMS_WEBHOOK_URL` (a gateway accepting `POST {to, message}`) and texts, including tenant OTPs, actually send. Without it, rows stay `PENDING_STUB` in `sms_logs`. This matches the brief: no SMS vendor in v1, clean hook ready. |
| WhatsApp | Tables plus provider stub only, per the brief (explicitly out of v1 scope). Same webhook pattern fits when needed. |

## API notes

- `POST /api/auth/login`, `POST /api/auth/tenant/request-otp`, `POST /api/auth/tenant/verify-otp`
- `GET /api/health` (no auth, for monitors and Docker health check)
- `POST /api/uploads` (JPG, PNG, WEBP, PDF, MP4 up to 10 MB, stored as DB
  blobs), downloaded back through `GET /files/:id` (login required, JWT as
  `?token=` for plain links)
- CRUD: `/api/properties`, `/api/buildings`, `/api/floors`, `/api/units`, `/api/beds`, `/api/tenants`, `/api/rent-plans`, plus `/api/agreements` (occupancy transitions, terminate needs `confirm=true`).
- Billing: `POST /api/jobs/generate-rent {month}`, `POST /api/jobs/mark-overdue`, `POST /api/payments {invoice_id, amount, payment_mode, confirm:true}`, `GET /api/invoices/:id`, `GET /api/receipts`, `GET /api/statements/:tenantId`.
- Ops: `/api/complaints` (with photo attachments in `documents`, `GET /api/complaints/:id` for files), `/api/notifications`, `/api/dashboard/summary`, `/api/audit-logs`, tenant self service under `/api/tenant/*` (including `/api/tenant/statement` ledger and `/api/tenant/receipts/:id`).
- Receipts: `/api/receipts/:id` renders a printable receipt (Print or save PDF from the browser) with org, property, invoice, payment, and totals.

Cron runs monthly generation on the 1st at 01:00 and overdue marking daily at 02:00, with no admin logged in. An invoice reaches PAID only through real SUCCESS payment rows. GST fields exist but stay 0 in v1.

## Honest scope check (what is real, what is next)

Working product, verified by `verify-e2e.mjs` plus manual passes: auth, RBAC,
hierarchy, tenants and KYC with real document uploads, agreements with
automatic occupancy flips, monthly invoicing, payment recording with automatic
invoice updates and printable receipts, tenant dashboard and ledger, complaint
filing with photo attachments, in-app notifications, real email over SMTP when
configured, audit logs, scheduled jobs, Docker deployment with health checks.

Deliberately not built (per the brief, Phases 4 to 7): GST calculation,
property tax tracking UI, vendor and expense management UI, full accounting
reports, bundled SMS or WhatsApp vendors, live payment gateway (manual
recording only, schema is gateway ready with `payment_transactions`), native
mobile app, AI assistant. Tenant online payment is therefore "pay offline, the
receipt appears here", which is the brief's v1 model.

To go production live: set `JWT_SECRET`, configure `SMTP_*` for mail,
configure `SMS_WEBHOOK_URL` for texts and OTPs, put the container behind HTTPS,
and take regular copies of `./data/`.
