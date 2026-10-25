// Q-Zero API + static frontend. REST endpoints live under /api.
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { z } = require('zod');
const { db, tx, seed, DATA } = require('./db');

const PROD = process.env.NODE_ENV === 'production';
const SECRET = process.env.JWT_SECRET || (PROD ? null : 'dev-only-secret');
if (!SECRET || SECRET === 'change-me') { console.error('Set JWT_SECRET to a long random string.'); process.exit(1); }
const DOMAINS = (process.env.UNIVERSITY_DOMAINS || 'univ.edu,.edu,.ac.in').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const SHOW_OTP = (process.env.SHOW_DEV_OTP ?? (PROD ? 'false' : 'true')) === 'true';
const MAX_MB = +process.env.MAX_UPLOAD_MB || 10;
const ST = ['Confirmed', 'Queued', 'Printing', 'Packing', 'Ready for Pickup', 'Collected'];
const TIMES = ['10:00', '11:00', '12:00', '14:00', '15:00', '16:00'];

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (m, c = 400) => { throw new HttpError(c, m); };
const parse = (schema, data) => { const r = schema.safeParse(data); if (!r.success) bad(r.error.issues[0].message); return r.data; };
const now = () => Date.now();
const q = {
  userById: db.prepare('SELECT * FROM users WHERE id=?'), userByEmail: db.prepare('SELECT * FROM users WHERE email=?'),
  kiosk: db.prepare('SELECT * FROM kiosks WHERE id=?'), order: db.prepare('SELECT * FROM orders WHERE id=?'),
  notify: db.prepare('INSERT INTO notifications(user_id,message,created) VALUES(?,?,?)'),
  audit: db.prepare('INSERT INTO audit_logs(actor_id,action,target,created) VALUES(?,?,?,?)'),
};
const notify = (uid, m) => q.notify.run(uid, m, now());

// ---------- mail (optional) ----------
let mailer = null;
if (process.env.SMTP_HOST) {
  mailer = require('nodemailer').createTransport({ host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 587,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined });
}
const sendMail = (to, subject, text) => mailer && mailer.sendMail({ from: process.env.MAIL_FROM, to, subject, text }).catch((e) => console.error('mail failed', e.message));

// ---------- auth helpers ----------
const readCookie = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((a) => a[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const setSession = (res, u) => res.cookie('qz_token', jwt.sign({ id: u.id }, SECRET, { expiresIn: '7d' }), { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 7 * 864e5 });
const hashOtp = (email, code) => crypto.createHash('sha256').update(email + code + SECRET).digest('hex');
function issueOtp(email, purpose) {
  const code = String(crypto.randomInt(100000, 1000000));
  db.prepare('INSERT OR REPLACE INTO otps(email,hash,exp,purpose,tries) VALUES(?,?,?,?,0)').run(email, hashOtp(email, code), now() + 10 * 60e3, purpose);
  sendMail(email, 'Your Q-Zero code', `Your Q-Zero verification code is ${code}. It expires in 10 minutes.`);
  return code;
}
function checkOtp(email, code, purpose) {
  const o = db.prepare('SELECT * FROM otps WHERE email=? AND purpose=?').get(email, purpose);
  if (!o || o.exp < now()) bad('Code expired. Request a new one.');
  if (o.tries >= 5) bad('Too many attempts. Request a new code.', 429);
  db.prepare('UPDATE otps SET tries=tries+1 WHERE email=?').run(email);
  if (o.hash !== hashOtp(email, String(code))) bad('Incorrect OTP');
  db.prepare('DELETE FROM otps WHERE email=?').run(email);
}
function auth(req, _res, next) {
  try { const p = jwt.verify(readCookie(req).qz_token || '', SECRET); const u = q.userById.get(p.id); if (u) req.user = u; } catch { /* anonymous */ }
  next();
}
const need = (...roles) => (req, _res, next) => {
  if (!req.user) bad('Please log in', 401);
  if (roles.length && !roles.includes(req.user.role)) bad('You do not have access to this', 403);
  next();
};

// ---------- pricing (server is the source of truth) ----------
const cfgSchema = z.object({
  color: z.coerce.number().int().min(0).max(1), dbl: z.coerce.number().int().min(0).max(1),
  copies: z.coerce.number().int().min(1, 'Copies must be at least 1').max(100),
  paper: z.enum(['A4', 'A3']), orient: z.enum(['Portrait', 'Landscape']), oe: z.enum(['all', 'odd', 'even']).default('all'),
  range: z.string().trim().regex(/^(all|\d+(-\d+)?(,\d+(-\d+)?)*)$/i, 'Page range must look like all or 1-3,5').default('all'),
});
function selectedPages(cfg, n) {
  let set = [];
  if (!cfg.range || cfg.range.toLowerCase() === 'all') for (let i = 1; i <= n; i++) set.push(i);
  else cfg.range.split(',').forEach((p) => { const [a, b] = p.split('-').map(Number); if (a) for (let i = a; i <= (b || a) && i <= n; i++) set.push(i); });
  if (cfg.oe === 'odd') set = set.filter((i) => i % 2);
  if (cfg.oe === 'even') set = set.filter((i) => !(i % 2));
  return set.length;
}
function price(cfg, pages, mode) {
  let p = pages * cfg.copies * (cfg.color ? 8 : 2);
  if (cfg.dbl) p *= 0.85;
  if (cfg.paper === 'A3') p *= 2;
  if (mode === 'Instant') p += 15;
  return Math.round(p);
}
function trackingCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = '';
  for (let i = 0; i < 8; i++) s += c[crypto.randomInt(c.length)];
  return s.slice(0, 4) + '-' + s.slice(4);
}

// ---------- serializers (shape the frontend expects) ----------
const userOut = (u) => ({ id: u.id, role: u.role, name: u.name, email: u.email, reg: u.reg, wallet: u.wallet });
const ordOut = (r) => ({ id: r.id, uid: r.user_id, file: r.file, pages: r.pages, cfg: JSON.parse(r.cfg), kiosk: r.kiosk_id, mode: r.mode,
  slot: r.slot, total: r.total, code: r.code, st: r.status, pay: r.pay_ref, col: r.collected_by || undefined, t: r.created });
const kioskOut = (k) => ({ id: k.id, n: k.name, loc: k.loc, x: k.x, y: k.y, on: !!k.online, load: k.load || 0, cap: k.capacity });

// ---------- app ----------
function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], scriptSrcAttr: ["'unsafe-inline'"],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'],
    imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', rateLimit({ windowMs: 15 * 60e3, limit: 600, standardHeaders: true, legacyHeaders: false }));
  const authLimit = rateLimit({ windowMs: 15 * 60e3, limit: +process.env.AUTH_RATE_LIMIT || 30, message: { error: 'Too many attempts. Try again later.' } });
  app.use('/api', auth);

  const api = express.Router();
  api.get('/health', (_q, res) => res.json({ ok: true }));

  // --- auth
  api.post('/auth/register', authLimit, (req, res) => {
    const b = parse(z.object({ name: z.string().trim().min(2).max(80), email: z.string().trim().toLowerCase().email(),
      reg: z.string().trim().min(3).max(30), password: z.string().min(6, 'Password needs 6+ characters').max(100) }), req.body);
    const domain = b.email.split('@')[1];
    if (!DOMAINS.some((d) => (d.startsWith('.') ? domain.endsWith(d) : domain === d))) bad('Use your university email (e.g. name@univ.edu)');
    const ex = q.userByEmail.get(b.email);
    if (ex && ex.verified) bad('Email already registered', 409);
    if (ex) db.prepare('UPDATE users SET name=?,reg=?,password_hash=? WHERE id=?').run(b.name, b.reg.toUpperCase(), bcrypt.hashSync(b.password, 10), ex.id);
    else db.prepare('INSERT INTO users(role,name,email,reg,password_hash,verified,wallet,created) VALUES(?,?,?,?,?,0,100,?)')
      .run('student', b.name, b.email, b.reg.toUpperCase(), bcrypt.hashSync(b.password, 10), now());
    const code = issueOtp(b.email, 'verify');
    res.status(201).json({ ok: true, ...(SHOW_OTP ? { devOtp: code } : {}) });
  });
  api.post('/auth/verify-otp', authLimit, (req, res) => {
    const b = parse(z.object({ email: z.string().trim().toLowerCase().email(), otp: z.string().trim().length(6, 'Enter the 6-digit code') }), req.body);
    const u = q.userByEmail.get(b.email); if (!u) bad('Unknown email', 404);
    checkOtp(b.email, b.otp, 'verify');
    db.prepare('UPDATE users SET verified=1 WHERE id=?').run(u.id);
    notify(u.id, 'Welcome to Q-Zero! Upload your first document.');
    setSession(res, u); res.json({ ok: true });
  });
  api.post('/auth/login', authLimit, (req, res) => {
    const b = parse(z.object({ email: z.string().trim().toLowerCase(), password: z.string().min(1) }), req.body);
    const u = q.userByEmail.get(b.email);
    if (!u || !bcrypt.compareSync(b.password, u.password_hash)) bad('Wrong email or password', 401);
    if (!u.verified) bad('Verify your email first (register again to get a new code)', 403);
    setSession(res, u); res.json({ ok: true, role: u.role });
  });
  api.post('/auth/logout', (_q, res) => { res.clearCookie('qz_token'); res.json({ ok: true }); });
  api.post('/auth/forgot', authLimit, (req, res) => {
    const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email() }), req.body);
    const u = q.userByEmail.get(email); let code;
    if (u && u.verified) code = issueOtp(email, 'reset');
    res.json({ ok: true, ...(SHOW_OTP && code ? { devOtp: code } : {}) });
  });
  api.post('/auth/reset', authLimit, (req, res) => {
    const b = parse(z.object({ email: z.string().trim().toLowerCase().email(), otp: z.string().length(6), password: z.string().min(6).max(100) }), req.body);
    const u = q.userByEmail.get(b.email); if (!u) bad('Unknown email', 404);
    checkOtp(b.email, b.otp, 'reset');
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(b.password, 10), u.id);
    res.json({ ok: true });
  });

  // --- bootstrap: everything the signed-in user may see, in the shape the UI uses
  api.get('/bootstrap', (req, res) => {
    const u = req.user;
    const kiosks = db.prepare('SELECT k.*, (SELECT COUNT(*) FROM orders o WHERE o.kiosk_id=k.id AND o.status<5) load FROM kiosks k ORDER BY id').all().map(kioskOut);
    const taken = {};
    db.prepare("SELECT kiosk_id,slot,COUNT(*) c FROM orders WHERE status<5 AND mode='Scheduled' GROUP BY kiosk_id,slot").all().forEach((r) => { taken[r.kiosk_id + '|' + r.slot] = r.c; });
    const out = { ses: u ? u.id : null, u: u ? [userOut(u)] : [], k: kiosks, o: [], n: [], tk: [], taken, stats: {} };
    if (u) {
      const staff = u.role !== 'student';
      out.o = (staff ? db.prepare('SELECT * FROM orders ORDER BY id DESC').all() : db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY id DESC').all(u.id)).map(ordOut);
      if (u.role === 'student') {
        out.n = db.prepare('SELECT user_id uid,message m,created t FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50').all(u.id);
        out.tk = db.prepare('SELECT id,user_id uid,category cat,message m,status st,created t FROM tickets WHERE user_id=? ORDER BY id DESC').all(u.id);
      }
      if (u.role === 'admin') {
        out.tk = db.prepare('SELECT id,user_id uid,category cat,message m,status st,created t FROM tickets ORDER BY id DESC').all();
        out.stats = { students: db.prepare("SELECT COUNT(*) c FROM users WHERE role='student' AND verified=1").get().c,
          revenue: db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='SUCCESS'").get().s };
      }
    }
    res.json(out);
  });

  // --- documents (owner-only access)
  const upload = multer({ storage: multer.diskStorage({ destination: path.join(DATA, 'uploads'), filename: (_r, _f, cb) => cb(null, crypto.randomUUID()) }),
    limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
    fileFilter: (_r, f, cb) => cb(/\.(pdf|docx?|png|jpe?g)$/i.test(f.originalname) ? null : new HttpError(400, 'Only PDF, DOC, DOCX, PNG or JPG files are allowed'), true) });
  api.post('/documents', need('student'), upload.single('file'), (req, res) => {
    if (!req.file) bad('Choose a file to upload');
    const f = req.file; let pages = 1;
    if (/\.pdf$/i.test(f.originalname)) {
      const head = fs.readFileSync(f.path).toString('latin1');
      if (!head.startsWith('%PDF')) { fs.unlinkSync(f.path); bad('That file is not a valid PDF'); }
      pages = (head.match(/\/Type\s*\/Page[^s]/g) || []).length || 1;
    }
    const name = path.basename(f.originalname).slice(0, 120);
    const r = db.prepare('INSERT INTO documents(user_id,name,size,pages,stored_as,created) VALUES(?,?,?,?,?,?)').run(req.user.id, name, f.size, pages, f.filename, now());
    res.status(201).json({ id: Number(r.lastInsertRowid), name, size: f.size, pages });
  });
  api.get('/documents/:id/file', need(), (req, res) => {
    const d = db.prepare('SELECT * FROM documents WHERE id=?').get(+req.params.id);
    if (!d || (d.user_id !== req.user.id && req.user.role !== 'admin')) bad('Document not found', 404);
    res.download(path.join(DATA, 'uploads', d.stored_as), d.name);
  });

  // --- orders + mock payment (single transaction: slot check, payment, order, notification)
  api.post('/orders', need('student'), (req, res) => {
    const b = parse(z.object({ documentId: z.coerce.number().int(), cfg: cfgSchema, kioskId: z.coerce.number().int(),
      mode: z.enum(['Instant', 'Scheduled']), slot: z.string().nullish() }), req.body);
    const out = tx(() => {
      const doc = db.prepare('SELECT * FROM documents WHERE id=? AND user_id=?').get(b.documentId, req.user.id);
      if (!doc) bad('Upload a document first', 404);
      const k = q.kiosk.get(b.kioskId); if (!k) bad('Kiosk not found', 404);
      if (!k.online) bad('Kiosk is offline');
      const pages = selectedPages(b.cfg, doc.pages); if (!pages) bad('No pages selected');
      let slot = 'ASAP';
      if (b.mode === 'Scheduled') {
        const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(b.slot || '');
        if (!m || !TIMES.includes(m[2])) bad('Pick a time slot');
        const today = new Date().toISOString().slice(0, 10);
        if (m[1] < today || m[1] > new Date(Date.now() + 8 * 864e5).toISOString().slice(0, 10)) bad('Pick a date within the next 7 days');
        slot = b.slot;
        const used = db.prepare("SELECT COUNT(*) c FROM orders WHERE kiosk_id=? AND slot=? AND status<5").get(k.id, slot).c;
        if (used >= k.capacity) bad('That slot just filled up. Pick another time.', 409);
      }
      const total = price(b.cfg, pages, b.mode), ref = 'PAY-' + crypto.randomInt(10000, 99999);
      let code; do { code = trackingCode(); } while (db.prepare('SELECT 1 FROM orders WHERE code=?').get(code));
      const o = db.prepare('INSERT INTO orders(user_id,document_id,file,pages,cfg,kiosk_id,mode,slot,total,code,status,pay_ref,created) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?)')
        .run(req.user.id, doc.id, doc.name, pages, JSON.stringify(b.cfg), k.id, b.mode, slot, total, code, ref, now());
      db.prepare('INSERT INTO payments(order_id,user_id,amount,method,ref,status,created) VALUES(?,?,?,?,?,?,?)').run(o.lastInsertRowid, req.user.id, total, 'MOCK', ref, 'SUCCESS', now());
      notify(req.user.id, `Payment of ₹${total} succeeded. Order ${code} confirmed.`);
      return { id: Number(o.lastInsertRowid), code, total };
    });
    res.status(201).json(out);
  });
  api.get('/orders/:id/receipt', need(), (req, res) => {
    const o = q.order.get(+req.params.id);
    if (!o || (o.user_id !== req.user.id && req.user.role === 'student')) bad('Order not found', 404);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    res.type('html').send(`<!doctype html><meta charset=utf-8><title>Receipt ${esc(o.pay_ref)}</title><body style="font-family:Inter,sans-serif;max-width:480px;margin:40px auto"><h2>Q-Zero receipt</h2>
<p>Payment ${esc(o.pay_ref)} (mock gateway)<br>Tracking code <b>${esc(o.code)}</b></p><p>${esc(o.file)}: ${o.pages} pages<br>Pickup: ${esc(o.slot)}</p><h3>Total ₹${o.total}</h3><p>${new Date(o.created).toLocaleString()}</p>`);
  });

  // --- wallet / support
  api.post('/wallet/topup', need('student'), (req, res) => {
    const { amount } = parse(z.object({ amount: z.coerce.number().int().min(10).max(5000) }), req.body);
    db.prepare('UPDATE users SET wallet=wallet+? WHERE id=?').run(amount, req.user.id);
    db.prepare('INSERT INTO payments(order_id,user_id,amount,method,ref,status,created) VALUES(NULL,?,?,?,?,?,?)').run(req.user.id, amount, 'MOCK', 'TOPUP-' + crypto.randomInt(10000, 99999), 'SUCCESS', now());
    res.json({ ok: true });
  });
  api.post('/tickets', need('student'), (req, res) => {
    const b = parse(z.object({ category: z.string().trim().min(2).max(60), message: z.string().trim().min(1, 'Describe the issue').max(1000) }), req.body);
    db.prepare('INSERT INTO tickets(user_id,category,message,created) VALUES(?,?,?,?)').run(req.user.id, b.category, b.message, now());
    res.status(201).json({ ok: true });
  });

  // --- admin
  api.post('/admin/orders/:id/advance', need('admin'), (req, res) => {
    tx(() => {
      const o = q.order.get(+req.params.id); if (!o) bad('Order not found', 404);
      if (o.status >= 4) bad('Order is already ready or collected');
      const s = o.status + 1; db.prepare('UPDATE orders SET status=? WHERE id=?').run(s, o.id);
      const kn = q.kiosk.get(o.kiosk_id).name;
      notify(o.user_id, s === 4 ? `Your Print Is Ready: ${o.file} at ${kn}` : `${o.file} ${['', 'is queued', 'is printing', 'is being packed'][s]}`);
      q.audit.run(req.user.id, 'order.advance', `${o.code}->${ST[s]}`, now());
    });
    res.json({ ok: true });
  });
  api.post('/admin/kiosks/:id/toggle', need('admin'), (req, res) => {
    tx(() => {
      const k = q.kiosk.get(+req.params.id); if (!k) bad('Kiosk not found', 404);
      db.prepare('UPDATE kiosks SET online=? WHERE id=?').run(k.online ? 0 : 1, k.id);
      if (k.online) db.prepare('SELECT DISTINCT user_id FROM orders WHERE kiosk_id=? AND status<5').all(k.id).forEach((r) => notify(r.user_id, `${k.name} is temporarily unavailable. We will reach out about your pickup.`));
      q.audit.run(req.user.id, 'kiosk.toggle', `${k.name}->${k.online ? 'offline' : 'online'}`, now());
    });
    res.json({ ok: true });
  });
  api.post('/admin/tickets/:id/toggle', need('admin'), (req, res) => {
    const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(+req.params.id); if (!t) bad('Ticket not found', 404);
    db.prepare('UPDATE tickets SET status=? WHERE id=?').run(t.status === 'Open' ? 'Resolved' : 'Open', t.id);
    q.audit.run(req.user.id, 'ticket.toggle', String(t.id), now());
    res.json({ ok: true });
  });

  // --- operator: secure collection
  api.post('/operator/collect', need('operator', 'admin'), (req, res) => {
    const b = parse(z.object({ code: z.string().trim().toUpperCase().min(1, 'Enter the tracking code'), reg: z.string().trim().toUpperCase(),
      envelopeChecked: z.boolean(), idChecked: z.boolean() }), req.body);
    const result = tx(() => {
      const o = db.prepare('SELECT * FROM orders WHERE code=?').get(b.code); if (!o) return { err: 'No order with that code' };
      if (o.status !== 4) return { err: 'Order is not ready yet (' + ST[o.status] + ')' };
      const s = q.userById.get(o.user_id), match = (s.reg || '').toUpperCase() === b.reg;
      const rec = (r) => db.prepare('INSERT INTO verification_records(order_id,operator_id,reg_matched,envelope_checked,id_checked,result,created) VALUES(?,?,?,?,?,?,?)')
        .run(o.id, req.user.id, match ? 1 : 0, b.envelopeChecked ? 1 : 0, b.idChecked ? 1 : 0, r, now());
      if (!match) { rec('REG_MISMATCH'); return { err: 'Registration number does not match. Request OTP verification.' }; }
      if (!b.envelopeChecked || !b.idChecked) return { err: 'Confirm envelope and ID card checks' };
      rec('COLLECTED');
      db.prepare('UPDATE orders SET status=5, collected_by=?, collected_at=? WHERE id=?').run(req.user.name, now(), o.id);
      notify(o.user_id, 'Collected: ' + o.file);
      return { ok: true };
    });
    if (result.err) bad(result.err);
    res.json({ ok: true });
  });

  app.use('/api', api);
  app.use('/api', (_q, _r) => bad('Not found', 404));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use((_q, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.code).json({ error: err.message });
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File too large (max ${MAX_MB} MB)` });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err); res.status(500).json({ error: 'Something went wrong' });
  });
  return app;
}

if (process.env.SEED_DEMO !== 'false') seed();
if (require.main === module) {
  const port = +process.env.PORT || 3000;
  createApp().listen(port, () => console.log(`Q-Zero running on http://localhost:${port}`));
}
module.exports = { createApp };
