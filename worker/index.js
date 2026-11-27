// دكّان — the server: shop accounts and syncing. Each shop lives in its own Durable Object (its own database),
// so no shop can ever read another shop's data. The Directory only knows which phone belongs to which shop.
import {DurableObject} from 'cloudflare:workers';

const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const rand = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const DIGITS = {'٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9'};
const normPhone = p => { let s = String(p || '').replace(/[٠-٩۰-۹]/g, d => DIGITS[d]).replace(/\D/g, ''); if (s.startsWith('00964')) s = '0' + s.slice(5); else if (s.startsWith('964')) s = '0' + s.slice(3); else if (/^7\d{9}$/.test(s)) s = '0' + s; return s; };
const okPhone = p => /^07\d{9}$/.test(p);
const okPass = p => typeof p === 'string' && p.length >= 6 && p.length <= 100;
const clean = (s, n = 80) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
const same = (a, b) => { a = String(a); b = String(b); if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
async function pbkdf2(pass, salt) {
  const k = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000}, k, 256));
}
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
// errors keep their code and status even when they cross from a Durable Object to the Worker (only the message survives that trip)
class Fail extends Error { constructor(code, msg, status = 400) { super(`FAIL|${status}|${code}|${msg}`); this.code = code; this.status = status; this.msg = msg; } }
const readFail = e => { const m = /^FAIL\|(\d+)\|([\w-]+)\|([\s\S]*)$/.exec(String(e?.message || '')); return m ? {status: +m[1], code: m[2], msg: m[3]} : null; };
const LOCK = [5, 5 * 60 * 1000];   // 5 wrong passwords → 5 minutes wait
// wrong passwords lock only the device (internet address) that typed them, so a stranger can't lock the real owner out.
// A second, bigger counter for the number itself stops guessing from many places at once.
const LOCK_ALL = [30, 15 * 60 * 1000];
const ipKey = ip => String(ip || 'x').slice(0, 64);
function triesLocked(sql, keys) { const now = Date.now(); return keys.some(k => (sql.exec('SELECT lockUntil FROM tries WHERE k = ?', k).toArray()[0]?.lockUntil || 0) > now); }
function triesFail(sql, keys) {
  const now = Date.now();
  for (const k of keys) {
    const [n, wait] = k.startsWith('all:') ? LOCK_ALL : LOCK;
    const r = sql.exec('SELECT fails, at FROM tries WHERE k = ?', k).toArray()[0];
    const f = (r && now - r.at < wait * 2 ? r.fails : 0) + 1;
    sql.exec('INSERT INTO tries (k, fails, lockUntil, at) VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET fails = excluded.fails, lockUntil = excluded.lockUntil, at = excluded.at', k, f >= n ? 0 : f, f >= n ? now + wait : 0, now);
  }
  sql.exec('DELETE FROM tries WHERE at < ? AND lockUntil < ?', now - 86400000, now);
}
function triesOk(sql, keys) { for (const k of keys) if (k.startsWith('ip:')) sql.exec('DELETE FROM tries WHERE k = ?', k); }

/* ---------- real notifications (Web Push: phones and browsers, even with the app closed) ---------- */
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ub64 = str => { let t = String(str || '').replace(/-/g, '+').replace(/_/g, '/'); while (t.length % 4) t += '='; return Uint8Array.from(atob(t), c => c.charCodeAt(0)); };
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
async function hkdf(salt, ikm, info, len) { const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']); return new Uint8Array(await crypto.subtle.deriveBits({name: 'HKDF', hash: 'SHA-256', salt, info}, k, len * 8)); }
async function vapidJwt(aud, sub, privJwk) {
  const key = await crypto.subtle.importKey('jwk', privJwk, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign']);
  const h = b64u(enc.encode(JSON.stringify({typ: 'JWT', alg: 'ES256'}))), c = b64u(enc.encode(JSON.stringify({aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub})));
  return h + '.' + c + '.' + b64u(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, key, enc.encode(h + '.' + c)));
}
// RFC 8291 (aes128gcm): the message is locked so only that phone can read it
async function webPush(sub, payload, vapid) {
  const uaPub = ub64(sub.p256dh), auth = ub64(sub.auth);
  const eph = await crypto.subtle.generateKey({name: 'ECDH', namedCurve: 'P-256'}, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, {name: 'ECDH', namedCurve: 'P-256'}, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({name: 'ECDH', public: uaKey}, eph.privateKey, 256));
  const ikm = await hkdf(auth, shared, cat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16), nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv: nonce}, key, cat(enc.encode(payload), new Uint8Array([2]))));
  const body = cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([65]), asPub, ct);
  const jwt = await vapidJwt(new URL(sub.endpoint).origin, vapid.sender, vapid.priv);
  return fetch(sub.endpoint, {method: 'POST', body, headers: {'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'high', authorization: `vapid t=${jwt}, k=${vapid.pub}`}});
}
const money = n => Math.round(+n || 0).toLocaleString('en-US');
const TYPE = {cash: 'نقد', debt: 'دين', inst: 'أقساط'};
// what happened to an invoice, in plain words (only sales news: new sale, payment, return, cancel)
function invoiceNews(cur, out, who) {
  if (!out) return [];
  const no = out.no ? ' #' + out.no : '', cust = out.customerName || 'زبون', L = [];
  if (!cur && !out.void) L.push({title: '🧾 فاتورة جديدة' + no, body: `${who} باع لـ ${cust} — ${TYPE[out.type] || ''} — ${money(out.total)} د.ع`, kind: 'sale'});
  if (cur) {
    const ids = new Set((cur.payments || []).map(p => p && p.id)), add = (out.payments || []).filter(p => p && !ids.has(p.id));
    if (add.length) L.push({title: '💵 دفعة واصلة', body: `${who} سجّل ${money(add.reduce((t, p) => t + (+p.amount || 0), 0))} د.ع من ${cust} (فاتورة${no})`, kind: 'pay'});
    const rids = new Set((cur.returns || []).map(r => r && r.id)), radd = (out.returns || []).filter(r => r && !rids.has(r.id) && !r.void);
    if (radd.length) L.push({title: '↩️ إرجاع' + no, body: `${who} رجّع منتجات بقيمة ${money(radd.reduce((t, r) => t + (+r.amount || 0), 0))} د.ع — ${cust}`, kind: 'ret'});
    if (out.void && !cur.void) L.push({title: '⛔ انلغت فاتورة' + no, body: `${who} لغى فاتورة ${cust}${out.voidReason ? ' — ' + out.voidReason : ''}`, kind: 'void'});
  }
  return L;
}

/* ---------- shops on their own Firebase: check that a login really came from Google ---------- */
const dec = new TextDecoder();
let GKEYS = null, GKEYS_AT = 0;
async function googleKeys(env, fresh) {
  if (env.FB_JWKS_TEST) return JSON.parse(env.FB_JWKS_TEST).keys;   // local tests only
  if (GKEYS && !fresh && Date.now() - GKEYS_AT < 3600000) return GKEYS;
  const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  if (!r.ok) throw new Fail('google', 'ما گدرت أتأكد من الدخول هسه. جرّب بعد شوية', 503);
  GKEYS = (await r.json()).keys; GKEYS_AT = Date.now(); return GKEYS;
}
// a Firebase login card (ID token): signed by Google, for one Firebase project (aud) and one person (sub)
async function verifyIdToken(tok, env) {
  const bad = () => new Fail('auth', 'لازم تسجل دخول مرة ثانية', 401);
  const [h, p, sg] = String(tok || '').split('.'); if (!sg) throw bad();
  let head, body; try { head = JSON.parse(dec.decode(ub64(h))); body = JSON.parse(dec.decode(ub64(p))); } catch (e) { throw bad(); }
  if (head.alg !== 'RS256' || !head.kid) throw bad();
  let jwk = (await googleKeys(env)).find(k => k.kid === head.kid);
  if (!jwk) jwk = (await googleKeys(env, true)).find(k => k.kid === head.kid);
  if (!jwk) throw bad();
  const key = await crypto.subtle.importKey('jwk', {kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true}, {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['verify']);
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, ub64(sg), enc.encode(h + '.' + p)))) throw bad();
  const now = Date.now() / 1000;
  if (!(body.exp > now - 30) || !(body.iat < now + 300) || !/^[a-z0-9-]{4,40}$/.test(String(body.aud || '')) || body.iss !== 'https://securetoken.google.com/' + body.aud || !/^[\w-]{6,128}$/.test(String(body.sub || ''))) throw bad();
  return {pid: body.aud, uid: body.sub};
}
const DAY = 86400000;
const CODE_CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => { const r = crypto.getRandomValues(new Uint8Array(8)); let s = ''; for (let i = 0; i < 8; i++) s += CODE_CH[r[i] % CODE_CH.length]; return 'DK-' + s.slice(0, 4) + '-' + s.slice(4); };

/* ======================= the list of shops (and the owner of the app) ======================= */
export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY, hash TEXT, salt TEXT, secret TEXT, fails INTEGER DEFAULT 0, lockUntil INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS phones (phone TEXT PRIMARY KEY, shop TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shops (id TEXT PRIMARY KEY, name TEXT, owner TEXT, ownerName TEXT, createdAt INTEGER, disabled INTEGER DEFAULT 0, note TEXT);
        CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
        CREATE TABLE IF NOT EXISTS tries (k TEXT PRIMARY KEY, fails INTEGER DEFAULT 0, lockUntil INTEGER DEFAULT 0, at INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS projects (pid TEXT PRIMARY KEY, name TEXT, phone TEXT, ownerUid TEXT, ownerName TEXT, firstSeen INTEGER, trialEnd INTEGER, state TEXT DEFAULT 'trial', lastSeen INTEGER, note TEXT, people INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, createdAt INTEGER, note TEXT, usedBy TEXT, usedAt INTEGER);`);
    });
  }
  /* --- shops on their own Firebase: free trial, then the app's owner turns them on for good --- */
  setting(k, v) { if (v === undefined) return this.sql.exec('SELECT v FROM kv WHERE k = ?', 'set:' + k).toArray()[0]?.v ?? null; this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', 'set:' + k, String(v)); return v; }
  trialDays() { const n = +this.setting('trialDays'); return n >= 1 && n <= 3650 ? n : 90; }
  info() { return {support: this.setting('support') || '', trialDays: this.trialDays()}; }
  project(pid) { return this.sql.exec('SELECT * FROM projects WHERE pid = ?', pid).toArray()[0] || null; }
  licOf(pid) {
    const p = this.project(pid), now = Date.now(); if (!p) return {state: 'none', support: this.setting('support') || ''};
    const state = p.state === 'active' ? 'active' : p.state === 'stopped' ? 'stopped' : now < p.trialEnd ? 'trial' : 'expired';
    return {state, trialEnd: p.trialEnd, days: Math.max(0, Math.ceil((p.trialEnd - now) / DAY)), support: this.setting('support') || '', checkedAt: now};
  }
  async hello({pid, uid, role, shop, phone, name}) {
    const now = Date.now(), p = this.project(pid); phone = normPhone(phone);
    if (!p) {
      let end = now + this.trialDays() * DAY;
      // the same shop owner making a second Firebase project doesn't get a second free trial
      const prior = okPhone(phone) ? this.sql.exec('SELECT MIN(trialEnd) AS e FROM projects WHERE phone = ?', phone).toArray()[0]?.e : null;
      if (prior) end = Math.min(end, prior);
      this.sql.exec('INSERT INTO projects (pid, name, phone, ownerUid, ownerName, firstSeen, trialEnd, state, lastSeen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', pid, clean(shop), okPhone(phone) ? phone : '', role === 'owner' ? uid : null, role === 'owner' ? clean(name) : '', now, end, 'trial', now);
    } else {
      this.sql.exec('UPDATE projects SET lastSeen = ? WHERE pid = ?', now, pid);
      if (role === 'owner' && !p.ownerUid) this.sql.exec('UPDATE projects SET ownerUid = ? WHERE pid = ?', uid, pid);
      if (role === 'owner' && (!p.ownerUid || p.ownerUid === uid)) { if (clean(shop)) this.sql.exec('UPDATE projects SET name = ? WHERE pid = ?', clean(shop), pid); if (clean(name)) this.sql.exec('UPDATE projects SET ownerName = ? WHERE pid = ?', clean(name), pid); if (okPhone(phone) && !p.phone) this.sql.exec('UPDATE projects SET phone = ? WHERE pid = ?', phone, pid); }
    }
    return this.licOf(pid);
  }
  isOwner(pid, uid) { const p = this.project(pid); return !!(p && p.ownerUid && p.ownerUid === uid); }
  async seen(pid, people) { this.sql.exec('UPDATE projects SET lastSeen = ?, people = ? WHERE pid = ?', Date.now(), Math.max(0, Math.min(999, +people || 0)), pid); return true; }
  async activate(pid, code) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); code = code.length === 10 && code.startsWith('DK') ? 'DK-' + code.slice(2, 6) + '-' + code.slice(6) : '';
    const c = code ? this.sql.exec('SELECT * FROM codes WHERE code = ?', code).toArray()[0] : null;
    if (!c) throw new Fail('code', 'الكود غلط. تأكد منه أو تواصل ويانا', 404);
    if (c.usedBy && c.usedBy !== pid) throw new Fail('used', 'هذا الكود مستعمل لمحل ثاني', 409);
    if (!this.project(pid)) throw new Fail('noshop', 'سجّل دخول أول مرة وبعدين فعّل', 404);
    this.sql.exec('UPDATE codes SET usedBy = ?, usedAt = ? WHERE code = ?', pid, Date.now(), code);
    this.sql.exec("UPDATE projects SET state = 'active' WHERE pid = ?", pid);
    return this.licOf(pid);
  }
  async listProjects() { const now = Date.now(); return this.sql.exec('SELECT * FROM projects ORDER BY firstSeen DESC').toArray().map(p => ({...p, lic: this.licOf(p.pid)})); }
  async setProject(pid, patch) {
    const p = this.project(pid); if (!p) throw new Fail('noshop', 'المحل مو موجود', 404);
    if (['trial', 'active', 'stopped'].includes(patch.state)) this.sql.exec('UPDATE projects SET state = ? WHERE pid = ?', patch.state, pid);
    if (patch.addDays) { const d = Math.max(-3650, Math.min(3650, Math.round(+patch.addDays) || 0)); this.sql.exec("UPDATE projects SET trialEnd = MAX(?, trialEnd) + ?, state = CASE WHEN state = 'stopped' THEN state ELSE 'trial' END WHERE pid = ? AND state != 'active'", Date.now(), d * DAY, pid); }
    if (patch.note != null) this.sql.exec('UPDATE projects SET note = ? WHERE pid = ?', clean(patch.note, 300), pid);
    return {...this.project(pid), lic: this.licOf(pid)};
  }
  async addCode(note) { let code; do { code = newCode(); } while (this.sql.exec('SELECT 1 FROM codes WHERE code = ?', code).toArray().length); this.sql.exec('INSERT INTO codes (code, createdAt, note) VALUES (?, ?, ?)', code, Date.now(), clean(note, 120)); return {code}; }
  async listCodes() { return this.sql.exec('SELECT c.*, p.name AS shop FROM codes c LEFT JOIN projects p ON p.pid = c.usedBy ORDER BY c.createdAt DESC LIMIT 300').toArray(); }
  async setSettings(patch) {
    if (patch.trialDays != null) { const n = Math.round(+patch.trialDays); if (!(n >= 1 && n <= 3650)) throw new Fail('days', 'أيام التجربة لازم بين 1 و 3650'); this.setting('trialDays', n); }
    if (patch.support != null) this.setting('support', clean(patch.support, 200));
    return this.info();
  }
  // the app's own notification keys (made once)
  async vapid(origin) {
    const row = this.sql.exec("SELECT v FROM kv WHERE k = 'vapid'").toArray()[0];
    if (row) return JSON.parse(row.v);
    const kp = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
    const v = {pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), priv: await crypto.subtle.exportKey('jwk', kp.privateKey), sender: origin && /^https:/.test(origin) ? origin : 'mailto:alerts@dukkan.app'};
    this.sql.exec("INSERT INTO kv (k, v) VALUES ('vapid', ?)", JSON.stringify(v));
    return v;
  }
  adminRow() { return this.sql.exec('SELECT * FROM admin WHERE id = 1').toArray()[0] || null; }
  async adminState() { return {setup: !!this.adminRow()}; }
  async adminToken(a) { const exp = Date.now() + 30 * 86400000; return `adm.${exp}.${await hmac(a.secret, 'adm.' + exp)}`; }
  async adminSetup(password) {
    if (this.adminRow()) throw new Fail('exists', 'كلمة سر المدير مسوّية من قبل', 409);
    if (!okPass(password)) throw new Fail('weak', 'كلمة السر لازم 6 حروف أو أكثر');
    const salt = rand(16), a = {hash: await pbkdf2(password, salt), salt, secret: rand(32)};
    this.sql.exec('INSERT INTO admin (id, hash, salt, secret) VALUES (1, ?, ?, ?)', a.hash, a.salt, a.secret);
    return {token: await this.adminToken(a)};
  }
  async adminLogin(password, ip) {
    const a = this.adminRow(); if (!a) throw new Fail('nosetup', 'ما مسوّي كلمة سر للمدير بعد', 404);
    const keys = ['ip:admin|' + ipKey(ip), 'all:admin'];
    if (triesLocked(this.sql, keys)) throw new Fail('locked', 'محاولات غلط هواية. انتظر كم دقيقة', 429);
    if (!same(await pbkdf2(String(password || ''), a.salt), a.hash)) { triesFail(this.sql, keys); throw new Fail('wrong', 'كلمة السر غلط', 401); }
    triesOk(this.sql, keys);
    return {token: await this.adminToken(a)};
  }
  async adminCheck(token) {
    const a = this.adminRow(); if (!a || !token) return false;
    const [p, exp, sig] = String(token).split('.');
    return p === 'adm' && +exp > Date.now() && same(sig || '', await hmac(a.secret, 'adm.' + exp));
  }
  async adminPassword(password) {
    if (!okPass(password)) throw new Fail('weak', 'كلمة السر لازم 6 حروف أو أكثر');
    const salt = rand(16), secret = rand(32);   // a new secret: every old admin login stops working
    this.sql.exec('UPDATE admin SET hash = ?, salt = ?, secret = ? WHERE id = 1', await pbkdf2(password, salt), salt, secret);
    return {token: await this.adminToken({secret})};
  }
  async listShops() { return this.sql.exec('SELECT s.*, (SELECT COUNT(*) FROM phones p WHERE p.shop = s.id) AS people FROM shops s ORDER BY createdAt DESC').toArray(); }
  async getShop(id) { return this.sql.exec('SELECT * FROM shops WHERE id = ?', id).toArray()[0] || null; }
  async lookup(phone) { const r = this.sql.exec('SELECT p.shop, s.disabled FROM phones p JOIN shops s ON s.id = p.shop WHERE p.phone = ?', phone).toArray()[0]; return r || null; }
  async createShop({name, ownerName, phone, password}) {
    name = clean(name); ownerName = clean(ownerName); phone = normPhone(phone);
    if (name.length < 2) throw new Fail('name', 'اكتب اسم المحل');
    if (!okPhone(phone)) throw new Fail('phone', 'رقم الهاتف لازم 11 رقم ويبدأ بـ 07');
    if (!okPass(password)) throw new Fail('weak', 'كلمة السر لازم 6 حروف أو أكثر');
    if (this.sql.exec('SELECT 1 FROM phones WHERE phone = ?', phone).toArray().length) throw new Fail('taken', 'هذا الرقم مسجل بمحل ثاني', 409);
    const id = rand(8);
    await this.env.SHOP.get(this.env.SHOP.idFromName(id)).init({id, name, owner: {phone, name: ownerName || 'صاحب المحل', password}});
    this.sql.exec('INSERT INTO shops (id, name, owner, ownerName, createdAt) VALUES (?, ?, ?, ?, ?)', id, name, phone, ownerName, Date.now());
    this.sql.exec('INSERT INTO phones (phone, shop) VALUES (?, ?)', phone, id);
    return {id, name, owner: phone};
  }
  async setShop(id, patch) {
    const s = await this.getShop(id); if (!s) throw new Fail('noshop', 'المحل مو موجود', 404);
    if (patch.name != null) { const n = clean(patch.name); if (n.length >= 2) this.sql.exec('UPDATE shops SET name = ? WHERE id = ?', n, id); }
    if (patch.note != null) this.sql.exec('UPDATE shops SET note = ? WHERE id = ?', clean(patch.note, 300), id);
    if (patch.disabled != null) {
      this.sql.exec('UPDATE shops SET disabled = ? WHERE id = ?', patch.disabled ? 1 : 0, id);
      await this.env.SHOP.get(this.env.SHOP.idFromName(id)).setDisabled(!!patch.disabled);
    }
    return this.getShop(id);
  }
  async claimPhone(phone, shop) {
    const r = this.sql.exec('SELECT shop FROM phones WHERE phone = ?', phone).toArray()[0];
    if (r && r.shop !== shop) throw new Fail('taken', 'هذا الرقم مسجل بمحل ثاني', 409);
    if (!r) this.sql.exec('INSERT INTO phones (phone, shop) VALUES (?, ?)', phone, shop);
    return true;
  }
  async releasePhone(phone, shop) { this.sql.exec('DELETE FROM phones WHERE phone = ? AND shop = ?', phone, shop); return true; }
}

/* ======================= one shop: its people and all its data ======================= */
/* ---------- what a worker may do (the owner switches these per worker) ---------- */
const PERMS = {
  money: false,       // sees money: cash box, expenses, profits, buying prices, totals
  sell: true,         // makes sales invoices
  pay: true,          // records payments / instalments
  customers: true,    // adds and edits customers
  products: false,    // adds products and changes names / prices
  returns: false,     // returns items and cancels invoices
  purchases: false    // suppliers and purchase invoices
};
const permsOf = m => { if (!m || m.role === 'owner') return Object.fromEntries(Object.keys(PERMS).map(k => [k, true])); let o = {}; try { o = JSON.parse(m.perms || '{}'); } catch (e) {} return Object.fromEntries(Object.keys(PERMS).map(k => [k, typeof o[k] === 'boolean' ? o[k] : PERMS[k]])); };
const MONEY_COLS = ['cash', 'expenses', 'closings', 'recurring', 'logs'], PUR_COLS = ['supplierTx', 'suppliers'];
const hiddenFor = P => [...(P.money ? [] : MONEY_COLS), ...(P.purchases ? [] : PUR_COLS)];
const COST_KEYS = ['buy', 'avgBuy', 'lastBuy', 'cost'];
// a worker without "money" never receives buying prices (so profits can't be worked out)
function stripCost(c, d) {
  if (!d) return d;
  if (c === 'products') { const o = {...d}; COST_KEYS.forEach(k => delete o[k]); return o; }
  if (c === 'invoices') { const o = {...d}; if (Array.isArray(o.items)) o.items = o.items.map(it => { const x = {...it}; COST_KEYS.forEach(k => delete x[k]); return x; }); delete o.cost; delete o.profit; return o; }
  return d;
}
const UNION = ['payments', 'returns'];   // lists merged item by item (by id), so two devices never drop each other's payment
function mergeList(cur, mine, base) {
  cur = Array.isArray(cur) ? cur : []; mine = Array.isArray(mine) ? mine : []; base = Array.isArray(base) ? base : [];
  const id = x => x && typeof x === 'object' ? x.id : undefined;
  if (![...cur, ...mine, ...base].every(x => id(x) != null)) return mine;
  const removed = new Set(base.map(id).filter(k => !mine.some(m => id(m) === k)));
  const out = mine.slice();
  cur.forEach(x => { if (!removed.has(id(x)) && !out.some(m => id(m) === id(x))) out.push(x); });
  return out;
}
export class Shop extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
        CREATE TABLE IF NOT EXISTS members (phone TEXT PRIMARY KEY, name TEXT, role TEXT, hash TEXT, salt TEXT, active INTEGER DEFAULT 1, ver INTEGER DEFAULT 1, fails INTEGER DEFAULT 0, lockUntil INTEGER DEFAULT 0, createdAt INTEGER, lastSeen INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS docs (c TEXT NOT NULL, i TEXT NOT NULL, d TEXT, s INTEGER NOT NULL, del INTEGER DEFAULT 0, by TEXT, PRIMARY KEY (c, i));
        CREATE INDEX IF NOT EXISTS docs_s ON docs (s);
        CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, phone TEXT, p256dh TEXT, auth TEXT, ua TEXT, createdAt INTEGER);
        CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, by TEXT, title TEXT, body TEXT, kind TEXT);
        CREATE TABLE IF NOT EXISTS tries (k TEXT PRIMARY KEY, fails INTEGER DEFAULT 0, lockUntil INTEGER DEFAULT 0, at INTEGER DEFAULT 0);
        CREATE INDEX IF NOT EXISTS docs_inv_no ON docs (c, json_extract(d, '$.no'));`);
      const cols = this.sql.exec('PRAGMA table_info(members)').toArray().map(r => r.name);
      if (!cols.includes('perms')) this.sql.exec('ALTER TABLE members ADD COLUMN perms TEXT');
      if (!cols.includes('salary')) this.sql.exec('ALTER TABLE members ADD COLUMN salary INTEGER DEFAULT 0');
    });
  }
  kv(k, v) { if (v === undefined) return this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0]?.v ?? null; this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v)); return v; }
  info() { return {id: this.kv('id'), name: this.kv('name'), disabled: this.kv('disabled') === '1'}; }
  member(phone) { return this.sql.exec('SELECT * FROM members WHERE phone = ?', phone).toArray()[0] || null; }
  async init({id, name, owner}) {
    if (this.kv('id')) throw new Fail('exists', 'المحل موجود', 409);
    this.kv('id', id); this.kv('name', name); this.kv('secret', rand(32)); this.kv('seq', 0); this.kv('createdAt', Date.now());
    const salt = rand(16);
    this.sql.exec('INSERT INTO members (phone, name, role, hash, salt, createdAt) VALUES (?, ?, ?, ?, ?, ?)', owner.phone, clean(owner.name), 'owner', await pbkdf2(owner.password, salt), salt, Date.now());
    return true;
  }
  async token(m) { const id = this.kv('id'); return `${id}.${m.phone}.${m.ver}.${await hmac(this.kv('secret'), `${id}.${m.phone}.${m.ver}`)}`; }
  pub(m) { return {phone: m.phone, name: m.name, role: m.role, active: !!m.active, createdAt: m.createdAt, lastSeen: m.lastSeen, perms: permsOf(m), salary: m.salary || 0}; }
  async login(phone, password, ip) {
    const inf = this.info(); if (!inf.id) throw new Fail('wrong', 'الرقم أو كلمة السر غلط', 401);
    const m = this.member(phone); if (!m) throw new Fail('wrong', 'الرقم أو كلمة السر غلط', 401);
    const keys = ['ip:' + phone + '|' + ipKey(ip), 'all:' + phone];
    if (triesLocked(this.sql, keys)) throw new Fail('locked', 'محاولات غلط هواية من هذا الجهاز. انتظر 5 دقايق وجرّب', 429);
    if (!same(await pbkdf2(String(password || ''), m.salt), m.hash)) { triesFail(this.sql, keys); throw new Fail('wrong', 'الرقم أو كلمة السر غلط', 401); }
    triesOk(this.sql, keys);
    if (inf.disabled) throw new Fail('disabled', 'حساب المحل موقوف. راجع صاحب التطبيق', 403);
    if (!m.active) throw new Fail('inactive', 'حسابك موقوف. راجع صاحب المحل', 403);
    this.sql.exec('UPDATE members SET lastSeen = ? WHERE phone = ?', Date.now(), phone);
    return {token: await this.token(m), user: this.pub(m), shop: {id: inf.id, name: inf.name}};
  }
  async auth(token) {
    const [id, phone, ver, sig] = String(token || '').split('.');
    if (!sig || id !== this.kv('id')) return null;
    if (!same(sig, await hmac(this.kv('secret'), `${id}.${phone}.${ver}`))) return null;
    const m = this.member(phone); if (!m || String(m.ver) !== ver) return null;
    if (this.kv('disabled') === '1') throw new Fail('disabled', 'حساب المحل موقوف. راجع صاحب التطبيق', 403);
    if (!m.active) throw new Fail('inactive', 'حسابك موقوف. راجع صاحب المحل', 403);
    if (Date.now() - (m.lastSeen || 0) > 60000) this.sql.exec('UPDATE members SET lastSeen = ? WHERE phone = ?', Date.now(), phone);
    return m;
  }
  async need(token, role) {
    const m = await this.auth(token);
    if (!m) throw new Fail('auth', 'لازم تسجل دخول مرة ثانية', 401);
    if (role === 'owner' && m.role !== 'owner') throw new Fail('owner', 'هذا الشي لصاحب المحل بس', 403);
    return m;
  }
  /* --- data --- */
  async me(token) { const m = await this.need(token); const inf = this.info(); return {user: this.pub(m), shop: {id: inf.id, name: inf.name}, seq: +this.kv('seq')}; }
  // the worker's own salary and what he received (taken from the shop's expenses marked with his phone)
  async mySalary(token, phone) {
    const m = await this.need(token); phone = phone ? normPhone(phone) : m.phone;
    if (phone !== m.phone && m.role !== 'owner') throw new Fail('owner', 'هذا الشي لصاحب المحل بس', 403);
    const who = this.member(phone); if (!who) throw new Fail('nomember', 'ما لگيت هذا الشخص', 404);
    const pays = this.sql.exec("SELECT d FROM docs WHERE c = 'expenses' AND del = 0").toArray().map(r => JSON.parse(r.d)).filter(e => e && e.worker === phone && !e.void)
      .map(e => ({amount: +e.amount || 0, date: e.date, desc: e.desc || '', month: e.month || String(e.date || '').slice(0, 7)})).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 36);
    return {salary: who.salary || 0, pays};
  }
  view(m, c, d) {
    if (c === 'settings' && d && m.role !== 'owner' && ('pinHash' in d)) { d = {...d}; delete d.pinHash; }   // the manager code stays with the owner
    const P = permsOf(m); return P.money ? d : stripCost(c, d);
  }
  async pull(token, since, limit = 800) {
    const m = await this.need(token), hide = hiddenFor(permsOf(m));
    since = Math.max(0, +since || 0); limit = Math.min(2000, Math.max(50, +limit || 800));
    const rows = this.sql.exec('SELECT c, i, d, s, del FROM docs WHERE s > ? ORDER BY s LIMIT ?', since, limit).toArray();
    const seq = rows.length ? rows[rows.length - 1].s : Math.max(since, +this.kv('seq'));
    // a worker's device never even receives the shop's money records
    return {changes: rows.filter(r => !hide.includes(r.c)).map(r => ({c: r.c, i: r.i, s: r.s, d: r.del ? null : this.view(m, r.c, JSON.parse(r.d))})), seq, more: rows.length === limit};
  }
  async getDoc(token, c, i) {
    const m = await this.need(token);
    if (hiddenFor(permsOf(m)).includes(c)) return {d: null, s: 0};
    const r = this.sql.exec('SELECT d, s, del FROM docs WHERE c = ? AND i = ?', c, i).toArray()[0];
    return r && !r.del ? {d: this.view(m, c, JSON.parse(r.d)), s: r.s} : {d: null, s: r?.s || 0};
  }
  async query(token, c, field, value) {
    const m = await this.need(token);
    if (hiddenFor(permsOf(m)).includes(c)) return [];
    // the database looks the value up itself (fast, even with thousands of invoices); the exact check below stays the same
    const fast = /^\w{1,40}$/.test(String(field || '')) && (typeof value === 'string' || (typeof value === 'number' && isFinite(value)));
    const rows = !fast ? this.sql.exec('SELECT i, d, s FROM docs WHERE c = ? AND del = 0', c)
      : field === 'no' ? this.sql.exec("SELECT i, d, s FROM docs WHERE c = ? AND json_extract(d, '$.no') = ? AND del = 0", c, value)
      : this.sql.exec('SELECT i, d, s FROM docs WHERE c = ? AND json_extract(d, ?) = ? AND del = 0', c, '$.' + field, value);
    return rows.toArray()
      .map(r => ({i: r.i, s: r.s, d: JSON.parse(r.d)})).filter(r => JSON.stringify(r.d?.[field]) === JSON.stringify(value)).map(r => ({...r, d: this.view(m, c, r.d)}));
  }
  async push(token, ops) {
    const m = await this.need(token);
    if (!Array.isArray(ops) || ops.length > 500) throw new Fail('bad', 'طلب غلط');
    let seq = +this.kv('seq'); const done = [], news = [], ownerNews = [], who = m.name || m.phone;
    for (const op of ops) {
      const c = clean(op.c, 40), i = clean(op.i, 120);
      if (!/^[\w-]+$/.test(c) || !i) { done.push({k: op.k, ok: false}); continue; }
      if (c === 'settings' && m.role !== 'owner') { done.push({k: op.k, ok: false, err: 'owner'}); continue; }
      if (!this.knownCol(c)) { done.push({k: op.k, ok: false, err: 'cols'}); continue; }   // too many different lists: someone is filling the shop with junk   // like the rule in Claude: settings are the owner's
      const row = this.sql.exec('SELECT d, del FROM docs WHERE c = ? AND i = ?', c, i).toArray()[0];
      const cur = row && !row.del ? JSON.parse(row.d) : null;
      const why = m.role === 'owner' ? '' : this.refuse(m, c, cur, op);
      if (why) { done.push({k: op.k, ok: false, err: 'perm', msg: why}); continue; }
      const handStock = m.role !== 'owner' && c === 'products' && cur && op.t !== 'del' ? this.handStock(m, i, cur, op) : null;
      if (m.role !== 'owner' && !permsOf(m).money && op.d && typeof op.d === 'object') {
        // the worker's copy has no buying prices: put them back from the shop's own records, so the owner's profits stay right
        if (c === 'products' && cur) COST_KEYS.forEach(k => { if (k in cur) { op.d[k] = cur[k]; if (op.b) op.b[k] = cur[k]; } });
        if (c === 'invoices') op.d = this.fillCost(op.d, cur);
        if (c === 'invoices' && op.b) op.b = {...op.b, items: op.d.items};
      }
      let out;
      if (op.t === 'del') out = null;
      else {
        const d = op.d && typeof op.d === 'object' ? op.d : {}, b = op.b && typeof op.b === 'object' ? op.b : null;
        if (!cur || !b) out = d;   // new record (or the device had no copy): take it as it is
        else {
          // only what THIS device changed goes on top of the newest copy
          out = {...cur};
          for (const k of new Set([...Object.keys(d), ...Object.keys(b)])) {
            const dv = JSON.stringify(d[k]), bv = JSON.stringify(b[k]);
            if (dv === bv) continue;
            if (k === 'stock' && typeof d[k] === 'number' && typeof b[k] === 'number' && typeof cur[k] === 'number') out[k] = Math.max(0, cur[k] + (d[k] - b[k]));
            else if (UNION.includes(k)) out[k] = mergeList(cur[k], d[k], b[k]);
            else if (!(k in d)) { if (k !== 'by' && k !== 'byName') delete out[k]; }   // who sold stays, even if an older copy forgot it
            else out[k] = d[k];
          }
        }
      }
      const txt = out ? JSON.stringify(out) : 'null';
      if (txt.length > 1900000) { done.push({k: op.k, ok: false, err: 'big'}); continue; }
      if (c === 'invoices' && out && !cur && !out.by) out = {...out, by: m.phone, byName: m.name || ''};   // who made the sale
      if (c === 'invoices') news.push(...invoiceNews(cur, out, who));
      seq++;
      this.sql.exec('INSERT INTO docs (c, i, d, s, del, by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(c, i) DO UPDATE SET d = excluded.d, s = excluded.s, del = excluded.del, by = excluded.by', c, i, txt, seq, out ? 0 : 1, m.phone);
      done.push({k: op.k, ok: true, s: seq, d: this.view(m, c, out)});
      if (handStock && out && typeof out.stock === 'number' && out.stock !== handStock.from) {
        // a worker changed a stock number by hand (not by a sale or a purchase): it goes in the shop's record under his name, and the owner gets told
        const name = out.name || cur.name || 'منتج', summary = `⚠️ ${who} غيّر مخزون «${name}» بيده: كان ${handStock.from} وصار ${out.stock}`;
        seq++;
        this.sql.exec('INSERT INTO docs (c, i, d, s, del, by) VALUES (?, ?, ?, ?, 0, ?)', 'logs', 'srv' + rand(8), JSON.stringify({t: Date.now(), date: new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10), uid: m.phone, byName: m.name || '', entity: 'products', action: 'stock', summary, amount: null, ref: i}), seq, m.phone);
        ownerNews.push({title: '📦 تعديل مخزون باليد', body: summary, kind: 'stock'});
      }
    }
    this.kv('seq', seq);
    this.broadcast({t: 'c', seq, by: m.phone});   // other open devices fetch the change at once
    if (news.length) this.ctx.waitUntil(this.announce(news, m.phone));
    if (ownerNews.length) this.ctx.waitUntil(this.announce(ownerNews, m.phone, true));
    return {done, seq};
  }
  // did this worker change the stock by hand? A sale moves it with a mark that points to its invoice (and the exact amount);
  // a purchase moves it with a purchase mark. Anything else is by hand. Returns {from} when it is by hand, else null.
  handStock(m, pid, cur, op) {
    const d = op.d || {}, b = op.b && typeof op.b === 'object' ? op.b : cur;
    if (typeof d.stock !== 'number' || typeof b.stock !== 'number' || d.stock === b.stock) return null;
    const had = new Set(b.stkMarks || []), fresh = (Array.isArray(d.stkMarks) ? d.stkMarks : []).filter(k => !had.has(k));
    for (const key of fresh) {
      const at = String(key).indexOf(':'); if (at < 1) continue;
      const row = this.sql.exec("SELECT d FROM docs WHERE c = 'invoices' AND i = ? AND del = 0", String(key).slice(0, at)).toArray()[0];
      const sp = row ? JSON.parse(row.d).stockPending : null;
      if (!sp || sp.k !== String(key).slice(at + 1)) continue;
      const dd = ((sp.need || {})[pid] || 0) - ((sp.had || {})[pid] || 0);
      if (d.stock === Math.max(0, b.stock - dd)) return null;
    }
    const pHad = new Set(b.purMarks || []);
    if (permsOf(m).purchases && (Array.isArray(d.purMarks) ? d.purMarks : []).some(k => !pHad.has(k))) return null;
    return {from: typeof cur.stock === 'number' ? cur.stock : b.stock};
  }
  knownCol(c) {
    if (!this._cols) this._cols = new Set(this.sql.exec('SELECT DISTINCT c FROM docs').toArray().map(r => r.c));
    if (this._cols.has(c)) return true;
    if (this._cols.size >= 80) return false;
    this._cols.add(c); return true;
  }
  // what a worker is NOT allowed to change (checked here on the server, not only hidden on the screen)
  refuse(m, c, cur, op) {
    const P = permsOf(m), d = op.d || {};
    if (MONEY_COLS.includes(c) && c !== 'logs' && !P.money) return 'الصندوق والصرفيات لصاحب المحل';
    if (c === 'logs' && (op.t === 'del' || cur)) return 'السجل ما ينعدل';   // a worker adds to the record, never changes it
    if (PUR_COLS.includes(c) && !P.purchases) return 'المشتريات لصاحب المحل';
    if (c === 'customers' && op.t === 'del') return 'حذف العملاء لصاحب المحل';
    if (c === 'customers' && !P.customers) return 'إضافة وتعديل العملاء لصاحب المحل';
    if (c === 'products') {
      if (op.t === 'del' || !cur) return P.products ? '' : 'إضافة المنتجات لصاحب المحل';
      if (!P.products) { const ok = ['stock', 'stkMarks', 'purMarks', 'imeiAdded', 'updatedAt', 'stockPending', 'stockDone']; const b = op.b || {}; for (const k of new Set([...Object.keys(d), ...Object.keys(b)])) if (!ok.includes(k) && !COST_KEYS.includes(k) && JSON.stringify(d[k] ?? null) !== JSON.stringify(b[k] ?? null)) return 'تعديل المنتجات وأسعارها لصاحب المحل'; }   // empty and missing count as the same
    }
    if (c === 'invoices') {
      if (op.t === 'del') return 'حذف الفواتير لصاحب المحل';
      if (!cur && !P.sell) return 'البيع مو من صلاحياتك';
      if (cur) {
        const why = this.oldInvoice(P, P.money ? cur : stripCost('invoices', cur), op);
        if (why) return why;
        if (!P.returns && ((d.void && !cur.void) || (d.returns || []).length > (cur.returns || []).length || (d.returns || []).some(r => r.void && !(cur.returns || []).find(x => x.id === r.id && x.void)))) return 'الإرجاع والإلغاء لصاحب المحل';
        if (!P.pay && (d.payments || []).length > (cur.payments || []).length) return 'تسجيل الدفعات مو من صلاحياتك';
      }
    }
    return '';
  }
  // an invoice that already exists: a worker may only ADD to it (a payment, a return, a cancel — each by its permission).
  // Prices, items, the total, the customer and payments already written are the owner's.
  oldInvoice(P, cur, op) {
    const d = op.d || {}, b = op.b && typeof op.b === 'object' ? op.b : cur, eq = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
    const FREE = ['payments', 'returns', 'void', 'voidReason', 'voidAt', 'voidT', 'refund', 'refundWallet', 'stockPending', 'stockDone', 'lastReminder', 'reminders', 'no', 'updatedAt', 'by', 'byName'];
    for (const k of new Set([...Object.keys(d), ...Object.keys(b)])) if (!FREE.includes(k) && !COST_KEYS.includes(k) && k !== 'profit' && !eq(d[k], b[k])) return 'تعديل الفواتير القديمة (الأسعار والمنتجات والمبلغ) لصاحب المحل';
    if (b.void && !d.void) return 'رجوع فاتورة ملغاة لصاحب المحل';
    if (!P.returns && ['void', 'voidReason', 'voidAt', 'voidT', 'refund', 'refundWallet', 'stockPending'].some(k => !eq(d[k], b[k]))) return 'الإرجاع والإلغاء لصاحب المحل';   // only returns and cancels move these
    const byId = L => new Map((Array.isArray(L) ? L : []).filter(x => x && x.id != null).map(x => [x.id, x]));
    const dp = byId(d.payments);
    for (const [id, x] of byId(b.payments)) { const y = dp.get(id); if (!y) return 'حذف الدفعات لصاحب المحل'; if (!eq(x, y)) return 'تعديل أو عكس الدفعات لصاحب المحل'; }
    const bp = byId(b.payments);
    for (const [id, y] of dp) if (!bp.has(id) && !(typeof y.amount === 'number' && y.amount > 0 && y.amount <= 1e10)) return 'مبلغ الدفعة غلط';
    const dr = byId(d.returns);
    for (const [id, x] of byId(b.returns)) { const y = dr.get(id); if (!y) return 'حذف الإرجاع لصاحب المحل'; const {void: v1, voidAt: a1, voidT: t1, ...rx} = x, {void: v2, voidAt: a2, voidT: t2, ...ry} = y; if (!eq(rx, ry) || (x.void && !y.void)) return 'تعديل الإرجاع لصاحب المحل'; }
    return '';
  }
  fillCost(d, cur) {
    if (!d || !Array.isArray(d.items)) return d;
    const items = d.items.map((it, n) => {
      if (it.buy != null) return it;
      const was = cur && Array.isArray(cur.items) ? (cur.items.find(x => x.pid && x.pid === it.pid) || cur.items[n]) : null;
      if (was && was.buy != null && (!was.pid || was.pid === it.pid)) return {...it, buy: was.buy};
      const p = it.pid ? this.sql.exec("SELECT d FROM docs WHERE c = 'products' AND i = ? AND del = 0", it.pid).toArray()[0] : null;
      const buy = p ? JSON.parse(p.d).buy : null;
      return buy != null ? {...it, buy} : it;
    });
    return {...d, items};
  }
  /* --- live connection (WebSocket): changes and news reach open devices within a second --- */
  async fetch(req) {
    if (req.headers.get('upgrade') !== 'websocket') return new Response('no', {status: 400});
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({phone: null, at: Date.now()});
    return new Response(null, {status: 101, webSocket: client});
  }
  async webSocketMessage(ws, msg) {
    if (msg === 'ping') { ws.send('pong'); return; }
    let j = null; try { j = JSON.parse(msg); } catch (e) { return; }
    if (j && j.auth) {
      let m = null; try { m = await this.auth(j.auth); } catch (e) {}
      if (!m) { ws.send(JSON.stringify({t: 'bye'})); ws.close(4001, 'auth'); return; }
      ws.serializeAttachment({phone: m.phone, at: Date.now()});
      ws.send(JSON.stringify({t: 'ok', seq: +this.kv('seq')}));
    }
  }
  async webSocketClose(ws, code) { try { ws.close(code === 1006 ? 1000 : code, 'bye'); } catch (e) {} }
  async webSocketError(ws) { try { ws.close(1011, 'error'); } catch (e) {} }
  // only people who are still in the shop (and active) hear it; a removed or stopped person's open line is closed
  broadcast(o, onlyOwner) {
    const txt = JSON.stringify(o), live = new Map(this.sql.exec('SELECT phone, role FROM members WHERE active = 1').toArray().map(r => [r.phone, r.role]));
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment(); if (!a || !a.phone) continue;
      if (!live.has(a.phone)) { this.kick(ws); continue; }
      if (onlyOwner && live.get(a.phone) !== 'owner') continue;
      try { ws.send(txt); } catch (e) {}
    }
  }
  kick(ws) { try { ws.send(JSON.stringify({t: 'bye'})); ws.close(4001, 'gone'); } catch (e) {} }
  kickPhone(phone) { for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a && a.phone === phone) this.kick(ws); } }
  async announce(news, by, onlyOwner) {
    const ids = [];
    for (const n of news) { this.sql.exec('INSERT INTO events (at, by, title, body, kind) VALUES (?, ?, ?, ?, ?)', Date.now(), by, n.title, n.body, n.kind); ids.push(this.sql.exec('SELECT last_insert_rowid() AS id').one().id); }
    this.sql.exec('DELETE FROM events WHERE id <= (SELECT MAX(id) - 500 FROM events)');
    news.forEach((n, k) => this.broadcast({t: 'ev', id: ids[k], by, title: n.title, body: n.body, kind: n.kind}, onlyOwner));
    const subs = this.sql.exec(`SELECT s.* FROM subs s JOIN members m ON m.phone = s.phone WHERE m.active = 1 AND s.phone != ?${onlyOwner ? " AND m.role = 'owner'" : ''}`, by).toArray();
    if (!subs.length) return;
    let vapid; try { vapid = await this.env.DIR.get(this.env.DIR.idFromName('dir')).vapid(); } catch (e) { return; }
    const one = news.length === 1 ? news[0] : {title: `${news.length} حركات جديدة`, body: news.map(n => n.title).join(' · ')};
    const payload = JSON.stringify({title: one.title, body: one.body, tag: 'dk-' + (ids[ids.length - 1] || Date.now()), url: './#invoices'});
    await Promise.allSettled(subs.map(async s => {
      const r = await webPush(s, payload, vapid).catch(() => null);
      if (r && (r.status === 404 || r.status === 410)) this.sql.exec('DELETE FROM subs WHERE endpoint = ?', s.endpoint);   // that phone switched notifications off
    }));
  }
  async subscribe(token, sub, ua) {
    const m = await this.need(token);
    if (!sub || !/^https:\/\//.test(sub.endpoint || '') || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) throw new Fail('bad', 'اشتراك الإشعارات غلط');
    this.sql.exec('INSERT INTO subs (endpoint, phone, p256dh, auth, ua, createdAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET phone = excluded.phone, p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua',
      String(sub.endpoint).slice(0, 1000), m.phone, String(sub.keys.p256dh).slice(0, 200), String(sub.keys.auth).slice(0, 100), clean(ua, 200), Date.now());
    return true;
  }
  async unsubscribe(token, endpoint) { await this.need(token); this.sql.exec('DELETE FROM subs WHERE endpoint = ?', String(endpoint || '')); return true; }
  async events(token, since) {
    const m = await this.need(token);
    return this.sql.exec('SELECT id, at, by, title, body, kind FROM events WHERE id > ? ORDER BY id DESC LIMIT 50', Math.max(0, +since || 0)).toArray().reverse()
      .filter(e => m.role === 'owner' || e.kind !== 'stock').map(e => ({...e, mine: e.by === m.phone}));   // stock warnings are for the owner
  }
  async testNotify(token) {
    const m = await this.need(token);
    const last = +this.kv('test:' + m.phone) || 0;
    if (Date.now() - last < 60000) throw new Fail('wait', 'جرّبت هسه. انتظر دقيقة وجرّب مرة ثانية', 429);
    this.kv('test:' + m.phone, Date.now());
    await this.announce([{title: '🔔 تجربة الإشعارات', body: `${m.name || m.phone}: الإشعارات شغّالة على أجهزة المحل ✓`, kind: 'test'}], '-');
    return true;
  }
  /* --- people --- */
  async members(token) { const m = await this.need(token); const all = this.sql.exec('SELECT * FROM members ORDER BY createdAt').toArray(); return m.role === 'owner' ? all.map(x => this.pub(x)) : all.map(x => ({phone: x.phone, name: x.name, role: x.role})); }
  async addMember(token, {phone, name, password}) {
    await this.need(token, 'owner');
    phone = normPhone(phone); name = clean(name);
    if (!okPhone(phone)) throw new Fail('phone', 'رقم الهاتف لازم 11 رقم ويبدأ بـ 07');
    if (name.length < 2) throw new Fail('name', 'اكتب اسم العامل');
    if (!okPass(password)) throw new Fail('weak', 'كلمة السر لازم 6 حروف أو أكثر');
    if (this.member(phone)) throw new Fail('taken', 'هذا الرقم مضاف من قبل', 409);
    await this.env.DIR.get(this.env.DIR.idFromName('dir')).claimPhone(phone, this.kv('id'));
    const salt = rand(16);
    this.sql.exec('INSERT INTO members (phone, name, role, hash, salt, createdAt) VALUES (?, ?, ?, ?, ?, ?)', phone, name, 'worker', await pbkdf2(password, salt), salt, Date.now());
    return this.pub(this.member(phone));
  }
  async setMember(token, phone, patch) {
    const me = await this.need(token, 'owner');
    phone = normPhone(phone); const m = this.member(phone); if (!m) throw new Fail('nomember', 'ما لگيت هذا الشخص', 404);
    if (patch.password != null) { if (!okPass(patch.password)) throw new Fail('weak', 'كلمة السر لازم 6 حروف أو أكثر'); const salt = rand(16); this.sql.exec('UPDATE members SET hash = ?, salt = ?, ver = ver + 1, fails = 0, lockUntil = 0 WHERE phone = ?', await pbkdf2(patch.password, salt), salt, phone); this.sql.exec("DELETE FROM tries WHERE k = ? OR k LIKE ?", 'all:' + phone, 'ip:' + phone + '|%'); }
    if (patch.active != null) { if (m.role === 'owner') throw new Fail('owner', 'ما تگدر توقف صاحب المحل'); this.sql.exec('UPDATE members SET active = ?, ver = ver + 1 WHERE phone = ?', patch.active ? 1 : 0, phone); if (!patch.active) this.kickPhone(phone); }
    if (patch.name != null) { const n = clean(patch.name); if (n.length >= 2) this.sql.exec('UPDATE members SET name = ? WHERE phone = ?', n, phone); }
    if (patch.perms && typeof patch.perms === 'object' && m.role !== 'owner') {
      const cur = permsOf(m), next = Object.fromEntries(Object.keys(PERMS).map(k => [k, typeof patch.perms[k] === 'boolean' ? patch.perms[k] : cur[k]]));
      this.sql.exec('UPDATE members SET perms = ? WHERE phone = ?', JSON.stringify(next), phone);
      const hadMoney = cur.money || cur.purchases, nowMoney = next.money || next.purchases;
      if (JSON.stringify(cur) !== JSON.stringify(next)) this.broadcast({t: 'perm', phone, full: !hadMoney && nowMoney});   // his devices reload what they may see
    }
    if (patch.salary != null) { const v = Math.max(0, Math.min(1e9, Math.round(+patch.salary || 0))); this.sql.exec('UPDATE members SET salary = ? WHERE phone = ?', v, phone); }
    const out = this.pub(this.member(phone));
    if (phone === me.phone && patch.password != null) out.token = await this.token(this.member(phone));   // you stay logged in after changing your own password
    return out;
  }
  async removeMember(token, phone) {
    await this.need(token, 'owner');
    phone = normPhone(phone); const m = this.member(phone); if (!m) return true;
    if (m.role === 'owner') throw new Fail('owner', 'ما تگدر تحذف صاحب المحل');
    this.sql.exec('DELETE FROM members WHERE phone = ?', phone);
    this.sql.exec('DELETE FROM subs WHERE phone = ?', phone);   // his phone stops getting the shop's notifications
    this.kickPhone(phone);
    await this.env.DIR.get(this.env.DIR.idFromName('dir')).releasePhone(phone, this.kv('id'));
    return true;
  }
  /* --- for the app's owner (admin) --- */
  async setDisabled(v) { this.kv('disabled', v ? '1' : '0'); return true; }
  async adminReset(phone, password) {
    phone = normPhone(phone); const m = this.member(phone); if (!m) throw new Fail('nomember', 'ما لگيت هذا الشخص', 404);
    if (!okPass(password)) throw new Fail('weak', 'كلمة السر لازم 6 حروف أو أكثر');
    const salt = rand(16); this.sql.exec('UPDATE members SET hash = ?, salt = ?, ver = ver + 1, fails = 0, lockUntil = 0, active = 1 WHERE phone = ?', await pbkdf2(password, salt), salt, phone);
    this.sql.exec("DELETE FROM tries WHERE k = ? OR k LIKE ?", 'all:' + phone, 'ip:' + phone + '|%');
    return true;
  }
  async stats() {
    const n = this.sql.exec('SELECT c, COUNT(*) AS n FROM docs WHERE del = 0 GROUP BY c').toArray(), people = this.sql.exec('SELECT phone, name, role, active, lastSeen FROM members ORDER BY createdAt').toArray();
    return {counts: Object.fromEntries(n.map(r => [r.c, r.n])), people, lastSeen: Math.max(0, ...people.map(p => p.lastSeen || 0))};
  }
}

/* ======================= one Firebase shop's notifications (its data stays in its own Firebase) ======================= */
// Only short news passes here ("فاتورة جديدة #12 — 250,000"): kept for a while so a phone that was off can catch up, then dropped.
export class Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
        CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, phone TEXT, p256dh TEXT, auth TEXT, ua TEXT, createdAt INTEGER);
        CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, by TEXT, title TEXT, body TEXT, kind TEXT, owner INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS blocked (uid TEXT PRIMARY KEY, at INTEGER);
        CREATE TABLE IF NOT EXISTS sends (uid TEXT, at INTEGER);`);
    });
  }
  kv(k, v) { if (v === undefined) return this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0]?.v ?? null; this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v)); return v; }
  secret() { return this.kv('secret') || this.kv('secret', rand(32)); }
  // after Google said who this is, the shop's devices get a long card for this line (so the Windows program works with its window closed)
  async issue(pid, uid, owner) {
    if (!this.kv('pid')) this.kv('pid', pid);
    if (this.kv('pid') !== pid) throw new Fail('auth', 'لازم تسجل دخول مرة ثانية', 401);
    if (this.sql.exec('SELECT 1 FROM blocked WHERE uid = ?', uid).toArray().length) throw new Fail('inactive', 'حسابك موقوف. راجع صاحب المحل', 403);
    if (owner) this.kv('owner', uid);
    const exp = Date.now() + 365 * DAY;
    return `r.${pid}.${uid}.${exp}.${await hmac(this.secret(), `r.${pid}.${uid}.${exp}`)}`;
  }
  async auth(token) {
    const [r, pid, uid, exp, sig] = String(token || '').split('.');
    if (r !== 'r' || !sig || pid !== this.kv('pid') || !(+exp > Date.now())) return null;
    if (!same(sig, await hmac(this.secret(), `r.${pid}.${uid}.${exp}`))) return null;
    if (this.sql.exec('SELECT 1 FROM blocked WHERE uid = ?', uid).toArray().length) throw new Fail('inactive', 'حسابك موقوف. راجع صاحب المحل', 403);
    return {phone: uid, uid, pid, owner: this.kv('owner') === uid};
  }
  async need(token) { const m = await this.auth(token); if (!m) throw new Fail('auth', 'لازم تسجل دخول مرة ثانية', 401); return m; }
  async who(token) { return this.need(token); }
  rate(uid, n, ms) {
    const now = Date.now(); this.sql.exec('DELETE FROM sends WHERE at < ?', now - 3600000);
    if (this.sql.exec('SELECT COUNT(*) AS n FROM sends WHERE uid = ? AND at > ?', uid, now - ms).one().n >= n) throw new Fail('wait', 'إشعارات هواية بوقت قصير. انتظر شوية', 429);
    this.sql.exec('INSERT INTO sends (uid, at) VALUES (?, ?)', uid, now);
  }
  async news(token, list, ownerOnly) {
    const m = await this.need(token);
    if (!Array.isArray(list) || !list.length) return true;
    this.rate(m.uid, 240, 3600000);
    const L = list.slice(0, 10).map(n => ({title: clean(n && n.title, 120), body: clean(n && n.body, 300), kind: clean(n && n.kind, 20)})).filter(n => n.title);
    if (L.length) await this.announce(L, m.uid, !!ownerOnly);
    return true;
  }
  async announce(news, by, onlyOwner) {
    const ids = [];
    for (const n of news) { this.sql.exec('INSERT INTO events (at, by, title, body, kind, owner) VALUES (?, ?, ?, ?, ?, ?)', Date.now(), by, n.title, n.body, n.kind, onlyOwner ? 1 : 0); ids.push(this.sql.exec('SELECT last_insert_rowid() AS id').one().id); }
    this.sql.exec('DELETE FROM events WHERE id <= (SELECT MAX(id) - 500 FROM events) OR at < ?', Date.now() - 30 * DAY);
    const owner = this.kv('owner');
    news.forEach((n, k) => this.broadcast({t: 'ev', id: ids[k], by, title: n.title, body: n.body, kind: n.kind}, onlyOwner ? owner : null));
    const subs = this.sql.exec(`SELECT * FROM subs WHERE phone != ? AND phone NOT IN (SELECT uid FROM blocked)${onlyOwner ? ' AND phone = ?' : ''}`, ...(onlyOwner ? [by, owner || '-'] : [by])).toArray();
    if (!subs.length) return;
    let vapid; try { vapid = await this.env.DIR.get(this.env.DIR.idFromName('dir')).vapid(); } catch (e) { return; }
    const one = news.length === 1 ? news[0] : {title: `${news.length} حركات جديدة`, body: news.map(n => n.title).join(' · ')};
    const payload = JSON.stringify({title: one.title, body: one.body, tag: 'dk-' + (ids[ids.length - 1] || Date.now()), url: './#invoices'});
    await Promise.allSettled(subs.map(async s => {
      const r = await webPush(s, payload, vapid).catch(() => null);
      if (r && (r.status === 404 || r.status === 410)) this.sql.exec('DELETE FROM subs WHERE endpoint = ?', s.endpoint);
    }));
  }
  async subscribe(token, sub, ua) {
    const m = await this.need(token);
    if (!sub || !/^https:\/\//.test(sub.endpoint || '') || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) throw new Fail('bad', 'اشتراك الإشعارات غلط');
    this.sql.exec('INSERT INTO subs (endpoint, phone, p256dh, auth, ua, createdAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET phone = excluded.phone, p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua',
      String(sub.endpoint).slice(0, 1000), m.uid, String(sub.keys.p256dh).slice(0, 200), String(sub.keys.auth).slice(0, 100), clean(ua, 200), Date.now());
    if (this.sql.exec('SELECT COUNT(*) AS n FROM subs').one().n > 300) this.sql.exec('DELETE FROM subs WHERE endpoint IN (SELECT endpoint FROM subs ORDER BY createdAt LIMIT 50)');
    return true;
  }
  async unsubscribe(token, endpoint) { await this.need(token); this.sql.exec('DELETE FROM subs WHERE endpoint = ?', String(endpoint || '')); return true; }
  async events(token, since) {
    const m = await this.need(token);
    return this.sql.exec('SELECT id, at, by, title, body, kind, owner FROM events WHERE id > ? ORDER BY id DESC LIMIT 50', Math.max(0, +since || 0)).toArray().reverse()
      .filter(e => !e.owner || m.owner).map(e => ({id: e.id, at: e.at, by: e.by, title: e.title, body: e.body, kind: e.kind, mine: e.by === m.uid}));
  }
  async testNotify(token) {
    const m = await this.need(token);
    const last = +this.kv('test:' + m.uid) || 0;
    if (Date.now() - last < 60000) throw new Fail('wait', 'جرّبت هسه. انتظر دقيقة وجرّب مرة ثانية', 429);
    this.kv('test:' + m.uid, Date.now());
    await this.announce([{title: '🔔 تجربة الإشعارات', body: 'الإشعارات شغّالة على أجهزة المحل ✓', kind: 'test'}], '-');
    return true;
  }
  // the shop owner stopped or removed a worker: his devices stop hearing anything at once
  async block(token, uid, yes) {
    const m = await this.need(token);
    if (!m.owner) throw new Fail('owner', 'هذا الشي لصاحب المحل بس', 403);
    uid = clean(uid, 128); if (!uid || uid === m.uid) throw new Fail('bad', 'طلب غلط');
    if (yes) { this.sql.exec('INSERT INTO blocked (uid, at) VALUES (?, ?) ON CONFLICT(uid) DO NOTHING', uid, Date.now()); this.sql.exec('DELETE FROM subs WHERE phone = ?', uid); for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a && a.phone === uid) { try { ws.send(JSON.stringify({t: 'bye'})); ws.close(4001, 'gone'); } catch (e) {} } } }
    else this.sql.exec('DELETE FROM blocked WHERE uid = ?', uid);
    return true;
  }
  async fetch(req) {
    if (req.headers.get('upgrade') !== 'websocket') return new Response('no', {status: 400});
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({phone: null, at: Date.now()});
    return new Response(null, {status: 101, webSocket: client});
  }
  async webSocketMessage(ws, msg) {
    if (msg === 'ping') { ws.send('pong'); return; }
    let j = null; try { j = JSON.parse(msg); } catch (e) { return; }
    if (j && j.auth) {
      let m = null; try { m = await this.auth(j.auth); } catch (e) {}
      if (!m) { ws.send(JSON.stringify({t: 'bye'})); ws.close(4001, 'auth'); return; }
      ws.serializeAttachment({phone: m.uid, at: Date.now()});
      ws.send(JSON.stringify({t: 'ok', seq: 0}));
    }
  }
  async webSocketClose(ws, code) { try { ws.close(code === 1006 ? 1000 : code, 'bye'); } catch (e) {} }
  async webSocketError(ws) { try { ws.close(1011, 'error'); } catch (e) {} }
  broadcast(o, onlyUid) {
    const txt = JSON.stringify(o), blocked = new Set(this.sql.exec('SELECT uid FROM blocked').toArray().map(r => r.uid));
    for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (!a || !a.phone || blocked.has(a.phone) || (onlyUid && a.phone !== onlyUid)) continue; try { ws.send(txt); } catch (e) {} }
  }
}

/* ======================= the doors (HTTP) ======================= */
const CORS = {'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization', 'access-control-max-age': '86400'};
const J = (o, status = 200) => new Response(JSON.stringify(o), {status, headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS}});
const bearer = req => (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
const shopOf = (env, id) => env.SHOP.get(env.SHOP.idFromName(id));
const relayOf = (env, pid) => env.RELAY.get(env.RELAY.idFromName('fb:' + pid));
// a shop on our server (16 letters) or a Firebase shop's notification card (r.<project>.<person>...)
const shopFromToken = (env, t) => {
  const parts = String(t || '').split('.');
  if (parts[0] === 'r' && /^[a-z0-9-]{4,40}$/.test(parts[1] || '')) return relayOf(env, parts[1]);
  if (!/^[0-9a-f]{16}$/.test(parts[0])) throw new Fail('auth', 'لازم تسجل دخول مرة ثانية', 401);
  return shopOf(env, parts[0]);
};
const relayFromToken = (env, t) => { const parts = String(t || '').split('.'); if (parts[0] !== 'r' || !/^[a-z0-9-]{4,40}$/.test(parts[1] || '')) throw new Fail('auth', 'لازم تسجل دخول مرة ثانية', 401); return {relay: relayOf(env, parts[1]), pid: parts[1]}; };

async function api(req, env, url) {
  const dir = env.DIR.get(env.DIR.idFromName('dir')), p = url.pathname.replace(/^\/api/, ''), t = bearer(req);
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const q = k => url.searchParams.get(k);
  // shop people
  if (p === '/login' && req.method === 'POST') {
    const phone = normPhone(body.phone);
    if (!okPhone(phone)) throw new Fail('phone', 'رقم الهاتف لازم 11 رقم ويبدأ بـ 07');
    const r = await dir.lookup(phone); if (!r) { await pbkdf2('x', 'y'); throw new Fail('wrong', 'الرقم أو كلمة السر غلط', 401); }
    return shopOf(env, r.shop).login(phone, body.password, req.headers.get('cf-connecting-ip'));
  }
  if (p === '/me') return shopFromToken(env, t).me(t);
  if (p === '/salary') return shopFromToken(env, t).mySalary(t, q('phone'));
  if (p === '/pull') return shopFromToken(env, t).pull(t, q('since'), q('limit'));
  if (p === '/push' && req.method === 'POST') return shopFromToken(env, t).push(t, body.ops);
  if (p === '/doc') return shopFromToken(env, t).getDoc(t, q('c'), q('i'));
  if (p === '/query') return shopFromToken(env, t).query(t, q('c'), q('f'), JSON.parse(q('v') || 'null'));
  if (p === '/members') return shopFromToken(env, t).members(t);
  if (p === '/push/key') return {key: (await dir.vapid(url.origin)).pub};
  if (p === '/push/sub' && req.method === 'POST') return shopFromToken(env, t).subscribe(t, body.sub, req.headers.get('user-agent'));
  if (p === '/push/unsub' && req.method === 'POST') return shopFromToken(env, t).unsubscribe(t, body.endpoint);
  if (p === '/push/test' && req.method === 'POST') return shopFromToken(env, t).testNotify(t);
  if (p === '/events') return shopFromToken(env, t).events(t, q('since'));
  if (p === '/members/add' && req.method === 'POST') return shopFromToken(env, t).addMember(t, body);
  if (p === '/members/set' && req.method === 'POST') return shopFromToken(env, t).setMember(t, body.phone, body);
  if (p === '/members/remove' && req.method === 'POST') return shopFromToken(env, t).removeMember(t, body.phone);
  // shops on their own Firebase: notifications + free trial / activation
  if (p === '/info') return dir.info();
  if (p === '/fb/hello' && req.method === 'POST') {
    const v = await verifyIdToken(body.idToken, env), owner = body.role === 'owner';
    const lic = await dir.hello({pid: v.pid, uid: v.uid, role: owner ? 'owner' : 'worker', shop: body.shop, phone: body.phone, name: body.name});
    const isOwner = owner && (await dir.isOwner(v.pid, v.uid));
    const relay = await relayOf(env, v.pid).issue(v.pid, v.uid, isOwner);
    return {relay, lic, owner: isOwner};
  }
  if (p === '/fb/lic') { const {relay, pid} = relayFromToken(env, t); const m = await relay.need(t); if (m.owner && q('people')) await dir.seen(pid, q('people')); return dir.licOf(pid); }
  if (p === '/fb/activate' && req.method === 'POST') { const {relay, pid} = relayFromToken(env, t); await relay.need(t); return dir.activate(pid, body.code); }
  if (p === '/fb/news' && req.method === 'POST') { const {relay} = relayFromToken(env, t); return relay.news(t, body.news, !!body.ownerOnly); }
  if (p === '/fb/block' && req.method === 'POST') { const {relay} = relayFromToken(env, t); return relay.block(t, body.uid, !!body.blocked); }
  // the app's owner
  if (p === '/admin/state') return dir.adminState();
  if (p === '/admin/setup' && req.method === 'POST') return dir.adminSetup(body.password);
  if (p === '/admin/login' && req.method === 'POST') return dir.adminLogin(body.password, req.headers.get('cf-connecting-ip'));
  if (p.startsWith('/admin/')) {
    if (!(await dir.adminCheck(t))) throw new Fail('auth', 'سجّل دخول المدير مرة ثانية', 401);
    if (p === '/admin/shops') {
      const list = await dir.listShops();
      const st = await Promise.all(list.map(s => shopOf(env, s.id).stats().catch(() => null)));
      return list.map((s, k) => ({...s, stats: st[k]}));
    }
    if (p === '/admin/shops/add' && req.method === 'POST') return dir.createShop(body);
    if (p === '/admin/shops/set' && req.method === 'POST') return dir.setShop(body.id, body);
    if (p === '/admin/shops/reset' && req.method === 'POST') { if (!(await dir.getShop(body.id))) throw new Fail('noshop', 'المحل مو موجود', 404); return shopOf(env, body.id).adminReset(body.phone, body.password); }
    if (p === '/admin/password' && req.method === 'POST') return dir.adminPassword(body.password);
    if (p === '/admin/projects') return dir.listProjects();
    if (p === '/admin/projects/set' && req.method === 'POST') return dir.setProject(String(body.pid || ''), body);
    if (p === '/admin/codes') return dir.listCodes();
    if (p === '/admin/codes/add' && req.method === 'POST') return dir.addCode(body.note);
    if (p === '/admin/settings' && req.method === 'POST') return dir.setSettings(body);
    if (p === '/admin/settings') return dir.info();
  }
  throw new Fail('notfound', 'مو موجود', 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: CORS});
    if (url.pathname === '/api/live') {   // the live line: /api/live?shop=<id>, then the device sends its login inside
      const id = url.searchParams.get('shop') || '';
      if (req.headers.get('upgrade') !== 'websocket') return new Response('no', {status: 400});
      if (/^fb:[a-z0-9-]{4,40}$/.test(id)) return relayOf(env, id.slice(3)).fetch(req);   // a Firebase shop
      if (!/^[0-9a-f]{16}$/.test(id)) return new Response('no', {status: 400});
      return shopOf(env, id).fetch(req);
    }
    try { return J(await api(req, env, url)); }
    catch (e) {
      const f = readFail(e);
      if (f) return J({error: f.code, msg: f.msg}, f.status);
      console.log('server error', String(e?.stack || e));
      return J({error: 'error', msg: 'صار خطأ بالسيرفر، جرّب بعد شوية'}, 500);
    }
  }
};
