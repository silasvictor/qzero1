// End-to-end test: spins up the real server on a temp database and walks the full journey.
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qz-'));
process.env.SHOW_DEV_OTP = 'true'; process.env.AUTH_RATE_LIMIT = '1000'; process.env.NODE_ENV = 'test';
const { createApp } = require('../server');

const server = createApp().listen(0, async () => {
  const base = `http://localhost:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (p, o = {}) => {
      const fd = o.body instanceof FormData;
      const r = await fetch(base + '/api' + p, { method: o.method || (o.body ? 'POST' : 'GET'),
        headers: { ...(cookie ? { cookie } : {}), ...(o.body && !fd ? { 'content-type': 'application/json' } : {}) },
        body: o.body ? (fd ? o.body : JSON.stringify(o.body)) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      return { status: r.status, body: await r.json().catch(() => ({})), raw: r };
    };
  };
  let n = 0; const ok = (m) => console.log(`  ✓ ${++n}. ${m}`);
  try {
    const stu = client(), adm = client(), op = client(), anon = client(), other = client();
    assert.equal((await anon('/orders', { body: {} })).status, 401); ok('anonymous requests are rejected (401)');
    assert.equal((await stu('/auth/register', { body: { name: 'Test Student', email: 'x@gmail.com', reg: 'T1', password: 'secret1' } })).status, 400); ok('non-university email rejected');
    let r = await stu('/auth/register', { body: { name: 'Test Student', email: 'test@univ.edu', reg: '22ec2001', password: 'secret1' } });
    assert.equal(r.status, 201); const otp = r.body.devOtp; assert.match(otp, /^\d{6}$/); ok('student registers and receives OTP');
    assert.equal((await stu('/auth/login', { body: { email: 'test@univ.edu', password: 'secret1' } })).status, 403); ok('cannot log in before verifying');
    assert.equal((await stu('/auth/verify-otp', { body: { email: 'test@univ.edu', otp: '000000' } })).status, 400); ok('wrong OTP rejected');
    assert.equal((await stu('/auth/verify-otp', { body: { email: 'test@univ.edu', otp } })).status, 200); ok('OTP verified, session cookie set');
    let b = (await stu('/bootstrap')).body; assert.equal(b.u[0].reg, '22EC2001'); assert.equal(b.k.length, 5); ok('bootstrap returns profile and 5 kiosks');

    const pdf = '%PDF-1.4\n' + ['1','2','3','4'].map((i) => `${i} 0 obj\n<< /Type /Page >>\nendobj\n`).join('') + '<< /Type /Pages /Count 4 >>\n%%EOF';
    const fd = new FormData(); fd.append('file', new Blob([pdf], { type: 'application/pdf' }), 'notes.pdf');
    r = await stu('/documents', { body: fd }); assert.equal(r.status, 201); assert.equal(r.body.pages, 4); const docId = r.body.id; ok('PDF uploaded, 4 pages counted');
    const bad = new FormData(); bad.append('file', new Blob(['hello'], { type: 'text/plain' }), 'x.pdf');
    assert.equal((await stu('/documents', { body: bad })).status, 400); ok('fake PDF rejected');

    await other('/auth/register', { body: { name: 'Other', email: 'other@univ.edu', reg: 'OT1', password: 'secret1' } }).then(async (x) => other('/auth/verify-otp', { body: { email: 'other@univ.edu', otp: x.body.devOtp } }));
    assert.equal((await other(`/documents/${docId}/file`)).status, 404); ok('other students cannot download my document');
    assert.equal((await other('/orders', { body: { documentId: docId, cfg: { color: 0, dbl: 0, copies: 1, paper: 'A4', range: 'all', oe: 'all', orient: 'Portrait' }, kioskId: 1, mode: 'Instant' } })).status, 404); ok('other students cannot order my document');

    const d = new Date(Date.now() + 864e5).toISOString().slice(0, 10), slot = d + ' 12:00';
    const mk = (extra = {}) => ({ documentId: docId, cfg: { color: 0, dbl: 1, copies: 2, paper: 'A4', range: '1-3', oe: 'all', orient: 'Portrait' }, kioskId: 3, mode: 'Scheduled', slot, ...extra });
    r = await stu('/orders', { body: mk() }); assert.equal(r.status, 201); assert.match(r.body.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(r.body.total, Math.round(3 * 2 * 2 * 0.85)); const code = r.body.code; ok(`order paid; server priced ₹${r.body.total}; code ${code}`);
    assert.equal((await stu('/orders', { body: mk() })).status, 201); assert.equal((await stu('/orders', { body: mk() })).status, 409); ok('slot capacity (2) enforced; third booking blocked');
    assert.equal((await stu('/orders', { body: mk({ cfg: { color: 0, dbl: 0, copies: 1, paper: 'A4', range: 'abc', oe: 'all', orient: 'Portrait' } }) })).status, 400); ok('invalid page range rejected');

    assert.equal((await adm('/auth/login', { body: { email: 'admin@univ.edu', password: 'wrong' } })).status, 401);
    assert.equal((await adm('/auth/login', { body: { email: 'admin@univ.edu', password: 'admin123' } })).status, 200); ok('admin login');
    assert.equal((await stu('/admin/orders/1/advance', { body: {} })).status, 403); ok('student blocked from admin API (403)');
    b = (await adm('/bootstrap')).body; const mine = b.o.find((o) => o.code === code); assert(mine); assert(b.stats.students >= 2); ok('admin sees all orders and stats');
    assert.equal((await op('/auth/login', { body: { email: 'op@univ.edu', password: 'op123' } })).status, 200);
    assert.equal((await op('/operator/collect', { body: { code, reg: '22EC2001', envelopeChecked: true, idChecked: true } })).status, 400); ok('collection refused before order is ready');
    for (let i = 0; i < 4; i++) assert.equal((await adm(`/admin/orders/${mine.id}/advance`, { body: {} })).status, 200);
    assert.equal((await adm(`/admin/orders/${mine.id}/advance`, { body: {} })).status, 400); ok('admin advanced Confirmed → Ready for Pickup');
    b = (await stu('/bootstrap')).body; assert(b.n.some((x) => x.m.startsWith('Your Print Is Ready'))); assert.equal(b.o.find((o) => o.code === code).st, 4); ok('student received "Your Print Is Ready" notification');

    assert.equal((await op('/operator/collect', { body: { code, reg: 'WRONG', envelopeChecked: true, idChecked: true } })).status, 400); ok('wrong registration number refused');
    assert.equal((await op('/operator/collect', { body: { code, reg: '22EC2001', envelopeChecked: false, idChecked: true } })).status, 400); ok('unchecked envelope refused');
    assert.equal((await op('/operator/collect', { body: { code, reg: '22ec2001', envelopeChecked: true, idChecked: true } })).status, 200); ok('operator verifies identity and hands over');
    b = (await stu('/bootstrap')).body; const fin = b.o.find((o) => o.code === code); assert.equal(fin.st, 5); assert.equal(fin.col, 'Operator Ravi'); ok('order marked Collected with operator recorded');
    assert.equal((await stu('/orders/' + fin.id + '/receipt')).status, 200); ok('receipt available');

    assert.equal((await stu('/tickets', { body: { category: 'Payment issue', message: 'Charged twice' } })).status, 201);
    b = (await adm('/bootstrap')).body; const t = b.tk[0]; assert.equal((await adm(`/admin/tickets/${t.id}/toggle`, { body: {} })).status, 200); ok('support ticket created and resolved by admin');
    assert.equal((await adm('/admin/kiosks/2/toggle', { body: {} })).status, 200); assert.equal((await adm('/bootstrap')).body.k[1].on, false); ok('admin toggled kiosk offline');
    const html = await fetch(base + '/'); assert.equal(html.status, 200); assert((await html.text()).includes('Print Smarter')); ok('frontend served at /');
    console.log(`\nAll ${n} checks passed.`); server.close(); process.exit(0);
  } catch (e) { console.error('\n✗ FAILED:', e.message); console.error(e.stack.split('\n').slice(1, 4).join('\n')); server.close(); process.exit(1); }
});
