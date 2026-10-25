// SQLite database (Node's built-in node:sqlite) + schema + demo seed.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
fs.mkdirSync(path.join(DATA, 'uploads'), { recursive: true });
const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA, 'qzero.db'));

db.exec(`
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL CHECK(role IN('student','admin','operator')),
  name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, reg TEXT, password_hash TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0, wallet INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS otps(email TEXT PRIMARY KEY, hash TEXT NOT NULL, exp INTEGER NOT NULL, purpose TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS kiosks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, loc TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL,
  online INTEGER NOT NULL DEFAULT 1, capacity INTEGER NOT NULL DEFAULT 2);
CREATE TABLE IF NOT EXISTS documents(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL,
  size INTEGER NOT NULL, pages INTEGER NOT NULL, stored_as TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
  document_id INTEGER REFERENCES documents(id), file TEXT NOT NULL, pages INTEGER NOT NULL, cfg TEXT NOT NULL,
  kiosk_id INTEGER NOT NULL REFERENCES kiosks(id), mode TEXT NOT NULL, slot TEXT NOT NULL, total INTEGER NOT NULL,
  code TEXT NOT NULL UNIQUE, status INTEGER NOT NULL DEFAULT 0, pay_ref TEXT NOT NULL,
  collected_by TEXT, collected_at INTEGER, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_orders_slot ON orders(kiosk_id, slot, status);
CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER REFERENCES orders(id), user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL, method TEXT NOT NULL, ref TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), message TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), category TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Open', created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS verification_records(
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id), operator_id INTEGER NOT NULL REFERENCES users(id),
  reg_matched INTEGER NOT NULL, envelope_checked INTEGER NOT NULL, id_checked INTEGER NOT NULL, result TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_logs(id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER NOT NULL, action TEXT NOT NULL, target TEXT, created INTEGER NOT NULL);
`);

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return;
  const now = Date.now(), h = (p) => bcrypt.hashSync(p, 10);
  const U = db.prepare('INSERT INTO users(role,name,email,reg,password_hash,verified,wallet,created) VALUES(?,?,?,?,?,1,?,?)');
  U.run('student', 'Aarav Sharma', 'aarav@univ.edu', '21CS1042', h('demo123'), 250, now);
  U.run('admin', 'Admin Priya', 'admin@univ.edu', null, h('admin123'), 0, now);
  U.run('operator', 'Operator Ravi', 'op@univ.edu', null, h('op123'), 0, now);
  const K = db.prepare('INSERT INTO kiosks(name,loc,x,y,online,capacity) VALUES(?,?,?,?,1,2)');
  [['Central Campus Kiosk', 'Rock Plaza', 50, 50], ['Library Kiosk', 'Ground floor, Library', 22, 30], ['Boys Hostel', 'Common room', 80, 25],
   ['Girls Hostel', 'Mess entrance', 82, 75], ['Central Block', 'Central Block lobby', 25, 78]].forEach((k) => K.run(...k));
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const O = db.prepare('INSERT INTO orders(user_id,file,pages,cfg,kiosk_id,mode,slot,total,code,status,pay_ref,collected_by,collected_at,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const cfg1 = JSON.stringify({ color: 0, dbl: 1, copies: 1, paper: 'A4', range: 'all', oe: 'all', orient: 'Portrait' });
  const cfg2 = JSON.stringify({ color: 1, dbl: 0, copies: 2, paper: 'A4', range: 'all', oe: 'all', orient: 'Portrait' });
  O.run(1, 'DBMS_Notes.pdf', 24, cfg1, 1, 'Scheduled', day(1) + ' 11:00', 41, '8XUI-Z123', 3, 'PAY-1001', null, null, now - 36e5);
  O.run(1, 'Resume.pdf', 2, cfg2, 2, 'Instant', 'ASAP', 47, 'K2MP-77QD', 5, 'PAY-1000', 'Operator Ravi', now - 8e7, now - 864e5);
  const P = db.prepare('INSERT INTO payments(order_id,user_id,amount,method,ref,status,created) VALUES(?,?,?,?,?,?,?)');
  P.run(1, 1, 41, 'MOCK', 'PAY-1001', 'SUCCESS', now - 36e5); P.run(2, 1, 47, 'MOCK', 'PAY-1000', 'SUCCESS', now - 864e5);
  const N = db.prepare('INSERT INTO notifications(user_id,message,created) VALUES(?,?,?)');
  N.run(1, 'Payment confirmed for DBMS_Notes.pdf', now - 36e5); N.run(1, 'Your Print Is Ready: Resume.pdf at Library Kiosk', now - 8e7);
}

module.exports = { db, tx, seed, DATA };
