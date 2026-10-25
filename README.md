# Q-Zero: Print Smarter. Wait Less.

Smart campus printing platform. One Node.js service serves the web app (`public/index.html`) and a REST API (`/api`).
Sessions use an httpOnly JWT cookie, passwords are bcrypt-hashed, and all input is validated with Zod.

## Run locally
```bash
npm install
npm start            # http://localhost:3000  (needs Node 22.13+)
npm test             # 28-step end-to-end test on a temporary database
```
Demo accounts (created on first run, `SEED_DEMO=true`):

| Role | Email | Password |
|---|---|---|
| Student | aarav@univ.edu | demo123 |
| Admin | admin@univ.edu | admin123 |
| Kiosk operator | op@univ.edu | op123 |

Full journey: sign up (OTP is shown on screen in demo mode) → upload a PDF → customise → pick kiosk and slot → pay (mock) →
log in as admin and advance the order to *Ready for Pickup* → log in as operator and collect with the tracking code and the student's registration number (`21CS1042` for the demo student).

## Deploy
Needs Node 22.13+ and a **persistent disk** (SQLite database and uploaded files live in `DATA_DIR`).

**Docker / any VPS:** `docker build -t qzero .` then
`docker run -p 3000:3000 -v qzero-data:/data -e JWT_SECRET=<long-random> -e SHOW_DEV_OTP=true qzero`

**Railway / Fly.io / Render (paid disk):** connect the repo, build command `npm install`, start command `npm start`,
mount a volume at `/data`, and set `NODE_ENV=production`, `JWT_SECRET`, `DATA_DIR=/data`.
Serve over HTTPS (cookies are `secure` in production).

Environment variables are documented in `.env.example`. Set `SMTP_*` to send real OTP emails, then set `SHOW_DEV_OTP=false`.
Change or delete the demo accounts before a real launch (`SEED_DEMO=false` skips seeding).

## What is real and what is simulated
| Real | Simulated |
|---|---|
| Auth, OTP, roles, sessions, validation | Payment gateway (mock; no card data handled) |
| Upload, owner-only file access, PDF page count | Physical printing and packing (admin advances status by hand) |
| Server-side pricing, slot capacity (transactional) | Razorpay sandbox (not wired; add in `POST /api/orders`) |
| Orders, tracking codes, notifications, tickets | Email (only when `SMTP_*` is set) |
| Collection verification with audit records | Kiosk map (drawn campus map, demo coordinates) |

Database: SQLite via Node's built-in `node:sqlite` (schema in `db.js`). The original brief asked for PostgreSQL + Prisma; the
tables match that model (users, documents, orders, kiosks, payments, notifications, verification_records, tickets, audit_logs)
so porting is mechanical. Slots are capacity-checked per kiosk (`kiosks.capacity`); there is no separate slot table or admin UI for editing capacity yet.

## API (all under `/api`, JSON, cookie auth)
| Method & path | Role | Purpose |
|---|---|---|
| POST `/auth/register` `/auth/verify-otp` `/auth/login` `/auth/logout` | public | Sign up with university email, verify OTP, sign in/out |
| POST `/auth/forgot` `/auth/reset` | public | Password reset by OTP |
| GET `/bootstrap` | any | Everything the signed-in user may see (profile, kiosks, orders, notifications, tickets) |
| POST `/documents` (multipart `file`) | student | Upload PDF/DOC/DOCX/PNG/JPG, returns page count |
| GET `/documents/:id/file` | owner/admin | Download own document |
| POST `/orders` | student | Price, check slot, pay (mock), create order + tracking code |
| GET `/orders/:id/receipt` | owner/staff | HTML receipt |
| POST `/wallet/topup` · POST `/tickets` | student | Mock top-up · support ticket |
| POST `/admin/orders/:id/advance` | admin | Confirmed → Queued → Printing → Packing → Ready |
| POST `/admin/kiosks/:id/toggle` · `/admin/tickets/:id/toggle` | admin | Kiosk online/offline · ticket open/resolved |
| POST `/operator/collect` | operator/admin | Verify code, registration number, envelope and ID; mark Collected |
| GET `/health` | public | Liveness check |

Errors return `{ "error": "message" }` with 400/401/403/404/409/413/429 as appropriate.
