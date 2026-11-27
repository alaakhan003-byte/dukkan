var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker/index.js
import { DurableObject } from "cloudflare:workers";
var enc = new TextEncoder();
var hex = /* @__PURE__ */ __name((b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""), "hex");
var rand = /* @__PURE__ */ __name((n) => hex(crypto.getRandomValues(new Uint8Array(n))), "rand");
var DIGITS = { "\u0660": "0", "\u0661": "1", "\u0662": "2", "\u0663": "3", "\u0664": "4", "\u0665": "5", "\u0666": "6", "\u0667": "7", "\u0668": "8", "\u0669": "9", "\u06F0": "0", "\u06F1": "1", "\u06F2": "2", "\u06F3": "3", "\u06F4": "4", "\u06F5": "5", "\u06F6": "6", "\u06F7": "7", "\u06F8": "8", "\u06F9": "9" };
var normPhone = /* @__PURE__ */ __name((p) => {
  let s = String(p || "").replace(/[٠-٩۰-۹]/g, (d) => DIGITS[d]).replace(/\D/g, "");
  if (s.startsWith("00964")) s = "0" + s.slice(5);
  else if (s.startsWith("964")) s = "0" + s.slice(3);
  else if (/^7\d{9}$/.test(s)) s = "0" + s;
  return s;
}, "normPhone");
var okPhone = /* @__PURE__ */ __name((p) => /^07\d{9}$/.test(p), "okPhone");
var okPass = /* @__PURE__ */ __name((p) => typeof p === "string" && p.length >= 6 && p.length <= 100, "okPass");
var clean = /* @__PURE__ */ __name((s, n = 80) => String(s ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, n), "clean");
var same = /* @__PURE__ */ __name((a, b) => {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}, "same");
async function pbkdf2(pass, salt) {
  const k = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 1e5 }, k, 256));
}
__name(pbkdf2, "pbkdf2");
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
__name(hmac, "hmac");
var Fail = class extends Error {
  static {
    __name(this, "Fail");
  }
  constructor(code, msg, status = 400) {
    super(`FAIL|${status}|${code}|${msg}`);
    this.code = code;
    this.status = status;
    this.msg = msg;
  }
};
var readFail = /* @__PURE__ */ __name((e) => {
  const m = /^FAIL\|(\d+)\|([\w-]+)\|([\s\S]*)$/.exec(String(e?.message || ""));
  return m ? { status: +m[1], code: m[2], msg: m[3] } : null;
}, "readFail");
var LOCK = [5, 5 * 60 * 1e3];
var Directory = class extends DurableObject {
  static {
    __name(this, "Directory");
  }
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY, hash TEXT, salt TEXT, secret TEXT, fails INTEGER DEFAULT 0, lockUntil INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS phones (phone TEXT PRIMARY KEY, shop TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shops (id TEXT PRIMARY KEY, name TEXT, owner TEXT, ownerName TEXT, createdAt INTEGER, disabled INTEGER DEFAULT 0, note TEXT);`);
    });
  }
  adminRow() {
    return this.sql.exec("SELECT * FROM admin WHERE id = 1").toArray()[0] || null;
  }
  async adminState() {
    return { setup: !!this.adminRow() };
  }
  async adminToken(a) {
    const exp = Date.now() + 30 * 864e5;
    return `adm.${exp}.${await hmac(a.secret, "adm." + exp)}`;
  }
  async adminSetup(password) {
    if (this.adminRow()) throw new Fail("exists", "\u0643\u0644\u0645\u0629 \u0633\u0631 \u0627\u0644\u0645\u062F\u064A\u0631 \u0645\u0633\u0648\u0651\u064A\u0629 \u0645\u0646 \u0642\u0628\u0644", 409);
    if (!okPass(password)) throw new Fail("weak", "\u0643\u0644\u0645\u0629 \u0627\u0644\u0633\u0631 \u0644\u0627\u0632\u0645 6 \u062D\u0631\u0648\u0641 \u0623\u0648 \u0623\u0643\u062B\u0631");
    const salt = rand(16), a = { hash: await pbkdf2(password, salt), salt, secret: rand(32) };
    this.sql.exec("INSERT INTO admin (id, hash, salt, secret) VALUES (1, ?, ?, ?)", a.hash, a.salt, a.secret);
    return { token: await this.adminToken(a) };
  }
  async adminLogin(password) {
    const a = this.adminRow();
    if (!a) throw new Fail("nosetup", "\u0645\u0627 \u0645\u0633\u0648\u0651\u064A \u0643\u0644\u0645\u0629 \u0633\u0631 \u0644\u0644\u0645\u062F\u064A\u0631 \u0628\u0639\u062F", 404);
    if (a.lockUntil > Date.now()) throw new Fail("locked", "\u0645\u062D\u0627\u0648\u0644\u0627\u062A \u063A\u0644\u0637 \u0647\u0648\u0627\u064A\u0629. \u0627\u0646\u062A\u0638\u0631 \u0643\u0645 \u062F\u0642\u064A\u0642\u0629", 429);
    if (!same(await pbkdf2(String(password || ""), a.salt), a.hash)) {
      const f = a.fails + 1;
      this.sql.exec("UPDATE admin SET fails = ?, lockUntil = ? WHERE id = 1", f >= LOCK[0] ? 0 : f, f >= LOCK[0] ? Date.now() + LOCK[1] : 0);
      throw new Fail("wrong", "\u0643\u0644\u0645\u0629 \u0627\u0644\u0633\u0631 \u063A\u0644\u0637", 401);
    }
    this.sql.exec("UPDATE admin SET fails = 0, lockUntil = 0 WHERE id = 1");
    return { token: await this.adminToken(a) };
  }
  async adminCheck(token) {
    const a = this.adminRow();
    if (!a || !token) return false;
    const [p, exp, sig] = String(token).split(".");
    return p === "adm" && +exp > Date.now() && same(sig || "", await hmac(a.secret, "adm." + exp));
  }
  async adminPassword(password) {
    if (!okPass(password)) throw new Fail("weak", "\u0643\u0644\u0645\u0629 \u0627\u0644\u0633\u0631 \u0644\u0627\u0632\u0645 6 \u062D\u0631\u0648\u0641 \u0623\u0648 \u0623\u0643\u062B\u0631");
    const salt = rand(16), secret = rand(32);
    this.sql.exec("UPDATE admin SET hash = ?, salt = ?, secret = ? WHERE id = 1", await pbkdf2(password, salt), salt, secret);
    return { token: await this.adminToken({ secret }) };
  }
  async listShops() {
    return this.sql.exec("SELECT s.*, (SELECT COUNT(*) FROM phones p WHERE p.shop = s.id) AS people FROM shops s ORDER BY createdAt DESC").toArray();
  }
  async getShop(id) {
    return this.sql.exec("SELECT * FROM shops WHERE id = ?", id).toArray()[0] || null;
  }
  async lookup(phone) {
    const r = this.sql.exec("SELECT p.shop, s.disabled FROM phones p JOIN shops s ON s.id = p.shop WHERE p.phone = ?", phone).toArray()[0];
    return r || null;
  }
  async createShop({ name, ownerName, phone, password }) {
    name = clean(name);
    ownerName = clean(ownerName);
    phone = normPhone(phone);
    if (name.length < 2) throw new Fail("name", "\u0627\u0643\u062A\u0628 \u0627\u0633\u0645 \u0627\u0644\u0645\u062D\u0644");
    if (!okPhone(phone)) throw new Fail("phone", "\u0631\u0642\u0645 \u0627\u0644\u0647\u0627\u062A\u0641 \u0644\u0627\u0632\u0645 11 \u0631\u0642\u0645 \u0648\u064A\u0628\u062F\u0623 \u0628\u0640 07");
    if (!okPass(password)) throw new Fail("weak", "\u0643\u0644\u0645\u0629 \u0627\u0644\u0633\u0631 \u0644\u0627\u0632\u0645 6 \u062D\u0631\u0648\u0641 \u0623\u0648 \u0623\u0643\u062B\u0631");
    if (this.sql.exec("SELECT 1 FROM phones WHERE phone = ?", phone).toArray().length) throw new Fail("taken", "\u0647\u0630\u0627 \u0627\u0644\u0631\u0642\u0645 \u0645\u0633\u062C\u0644 \u0628\u0645\u062D\u0644 \u062B\u0627\u0646\u064A", 409);
    const id = rand(8);
    await this.env.SHOP.get(this.env.SHOP.idFromName(id)).init({ id, name, owner: { phone, name: ownerName || "\u0635\u0627\u062D\u0628 \u0627\u0644\u0645\u062D\u0644", password } });
    this.sql.exec("INSERT INTO shops (id, name, owner, ownerName, createdAt) VALUES (?, ?, ?, ?, ?)", id, name, phone, ownerName, Date.now());
    this.sql.exec("INSERT INTO phones (phone, shop) VALUES (?, ?)", phone, id);
    return { id, name, owner: phone };
  }
  async setShop(id, patch) {
    const s = await this.getShop(id);
    if (!s) throw new Fail("noshop", "\u0627\u0644\u0645\u062D\u0644 \u0645\u0648 \u0645\u0648\u062C\u0648\u062F", 404);
    if (patch.name != null) {
      const n = clean(patch.name);
      if (n.length >= 2) this.sql.exec("UPDATE shops SET name = ? WHERE id = ?", n, id);
    }
    if (patch.note != null) this.sql.exec("UPDATE shops SET note = ? WHERE id = ?", clean(patch.note, 300), id);
    if (patch.disabled != null) {
      this.sql.exec("UPDATE shops SET disabled = ? WHERE id = ?", patch.disabled ? 1 : 0, id);
      await this.env.SHOP.get(this.env.SHOP.idFromName(id)).setDisabled(!!patch.disabled);
    }
    return this.getShop(id);
  }
  async claimPhone(phone, shop) {
    const r = this.sql.exec("SELECT shop FROM phones WHERE phone = ?", phone).toArray()[0];
    if (r && r.shop !== shop) throw new Fail("taken", "\u0647\u0630\u0627 \u0627\u0644\u0631\u0642\u0645 \u0645\u0633\u062C\u0644 \u0628\u0645\u062D\u0644 \u062B\u0627\u0646\u064A", 409);
    if (!r) this.sql.exec("INSERT INTO phones (phone, shop) VALUES (?, ?)", phone, shop);
    return true;
  }
  async releasePhone(phone, shop) {
    this.sql.exec("DELETE FROM phones WHERE phone = ? AND shop = ?", phone, shop);
    return true;
  }
};
var UNION = ["payments", "returns"];
function mergeList(cur, mine, base) {
  cur = Array.isArray(cur) ? cur : [];
  mine = Array.isArray(mine) ? mine : [];
  base = Array.isArray(base) ? base : [];
  const id = /* @__PURE__ */ __name((x) => x && typeof x === "object" ? x.id : void 0, "id");
  if (![...cur, ...mine, ...base].every((x) => id(x) != null)) return mine;
  const removed = new Set(base.map(id).filter((k) => !mine.some((m) => id(m) === k)));
  const out = mine.slice();
  cur.forEach((x) => {
    if (!removed.has(id(x)) && !out.some((m) => id(m) === id(x))) out.push(x);
  });
  return out;
}
__name(mergeList, "mergeList");
var Shop = class extends DurableObject {
  static {
    __name(this, "Shop");
  }
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
        CREATE TABLE IF NOT EXISTS members (phone TEXT PRIMARY KEY, name TEXT, role TEXT, hash TEXT, salt TEXT, active INTEGER DEFAULT 1, ver INTEGER DEFAULT 1, fails INTEGER DEFAULT 0, lockUntil INTEGER DEFAULT 0, createdAt INTEGER, lastSeen INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS docs (c TEXT NOT NULL, i TEXT NOT NULL, d TEXT, s INTEGER NOT NULL, del INTEGER DEFAULT 0, by TEXT, PRIMARY KEY (c, i));
        CREATE INDEX IF NOT EXISTS docs_s ON docs (s);`);
    });
  }
  kv(k, v) {
    if (v === void 0) return this.sql.exec("SELECT v FROM kv WHERE k = ?", k).toArray()[0]?.v ?? null;
    this.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v));
    return v;
  }
  info() {
    return { id: this.kv("id"), name: this.kv("name"), disabled: this.kv("disabled") === "1" };
  }
  member(phone) {
    return this.sql.exec("SELECT * FROM members WHERE phone = ?", phone).toArray()[0] || null;
  }
  async init({ id, name, owner }) {
    if (this.kv("id")) throw new Fail("exists", "\u0627\u0644\u0645\u062D\u0644 \u0645\u0648\u062C\u0648\u062F", 409);
    this.kv("id", id);
    this.kv("name", name);
    this.kv("secret", rand(32));
    this.kv("seq", 0);
    this.kv("createdAt", Date.now());
    const salt = rand(16);
    this.sql.exec("INSERT INTO members (phone, name, role, hash, salt, createdAt) VALUES (?, ?, ?, ?, ?, ?)", owner.phone, clean(owner.name), "owner", await pbkdf2(owner.password, salt), salt, Date.now());
    return true;
  }
  async token(m) {
    const id = this.kv("id");
    return `${id}.${m.phone}.${m.ver}.${await hmac(this.kv("secret"), `${id}.${m.phone}.${m.ver}`)}`;
  }
  pub(m) {
    return { phone: m.phone, name: m.name, role: m.role, active: !!m.active, createdAt: m.createdAt, lastSeen: m.lastSeen };
  }
  async login(phone, password) {
    const inf = this.info();
    if (!inf.id) throw new Fail("wrong", "\u0627\u0644\u0631\u0642\u0645 \u0623\u0648 \u0643\u0644\u0645\u0629 \u0627\u0644\u0633\u0631 \u063A\u0644\u0637", 401);
    const m = this.member(phone);
    if (!m) throw new Fail("wrong", "\u0627\u0644\u0631\u0642\u0645 \u0623\u0648 \u0643\u0644\u0645\u0629 \u0627\u0644\u0633\u0631 \u063A\u0644\u0637", 401);
    if (m.lockUntil > Date.now()) throw new Fail("locked", "\u0645\u062D\u0627\u0648\u0644\u0627\u062A \u063A\u0644\u0637 \u0647\u0648\u0627\u064A\u0629. \u0627\u0646\u062A\u0638\u0631 5 \u062F\u0642\u0627\u064A\u0642 \u0648\u062C\u0631\u0651\u0628", 429);
    if (!same(await pbkdf2(String(password || ""), m.salt), m.hash)) {
      const f = m.fails + 1;
      this.sql.exec("UPDATE members SET fails = ?, lockUntil = ? WHERE phone = ?", f >= LOCK[0] ? 0 : f, f >= LOCK[0] ? Date.now() + LOCK[1] : 0, phone);
      throw new Fail("wrong", "\u0627\u0644\u0631\u0642\u0645 \u0623\u0648 \u0643\u0644\u0645\u0629 \u0627\u0644\u0633\u0631 \u063A\u0644\u0637", 401);
    }
    if (inf.disabled) throw new Fail("disabled", "\u062D\u0633\u0627\u0628 \u0627\u0644\u0645\u062D\u0644 \u0645\u0648\u0642\u0648\u0641. \u0631\u0627\u062C\u0639 \u0635\u0627\u062D\u0628 \u0627\u0644\u062A\u0637\u0628\u064A\u0642", 403);
    if (!m.active) throw new Fail("inactive", "\u062D\u0633\u0627\u0628\u0643 \u0645\u0648\u0642\u0648\u0641. \u0631\u0627\u062C\u0639 \u0635\u0627\u062D\u0628 \u0627\u0644\u0645\u062D\u0644", 403);
    this.sql.exec("UPDATE members SET fails = 0, lockUntil = 0, lastSeen = ? WHERE phone = ?", Date.now(), phone);
    return { token: await this.token(m), user: this.pub(m), shop: { id: inf.id, name: inf.name } };
  }
  async auth(token) {
    const [id, phone, ver, sig] = String(token || "").split(".");
    if (!sig || id !== this.kv("id")) return null;
    if (!same(sig, await hmac(this.kv("secret"), `${id}.${phone}.${ver}`))) return null;
    const m = this.member(phone);
    if (!m || String(m.ver) !== ver) return null;
    if (this.kv("disabled") === "1") throw new Fail("disabled", "\u062D\u0633\u0627\u0628 \u0627\u0644\u0645\u062D\u0644 \u0645\u0648\u0642\u0648\u0641. \u0631\u0627\u062C\u0639 \u0635\u0627\u062D\u0628 \u0627\u0644\u062A\u0637\u0628\u064A\u0642", 403);
    if (!m.active) throw new Fail("inactive", "\u062D\u0633\u0627\u0628\u0643 \u0645\u0648\u0642\u0648\u0641. \u0631\u0627\u062C\u0639 \u0635\u0627\u062D\u0628 \u0627\u0644\u0645\u062D\u0644", 403);
    if (Date.now() - (m.lastSeen || 0) > 6e4) this.sql.exec("UPDATE members SET lastSeen = ? WHERE phone = ?", Date.now(), phone);
    return m;
  }
  async need(token, role) {
    const m = await this.auth(token);
    if (!m) throw new Fail("auth", "\u0644\u0627\u0632\u0645 \u062A\u0633\u062C\u0644 \u062F\u062E\u0648\u0644 \u0645\u0631\u0629 \u062B\u0627\u0646\u064A\u0629", 401);
    if (role === "owner" && m.role !== "owner") throw new Fail("owner", "\u0647\u0630\u0627 \u0627\u0644\u0634\u064A \u0644\u0635\u0627\u062D\u0628 \u0627\u0644\u0645\u062D\u0644 \u0628\u0633", 403);
    return m;
  }
  /* --- data --- */
  async me(token) {
    const m = await this.need(token);
    const inf = this.info();
    return { user: this.pub(m), shop: { id: inf.id, name: inf.name }, seq: +this.kv("seq") };
  }
  async pull(token, since, limit = 800) {
    await this.need(token);
    since = Math.max(0, +since || 0);
    limit = Math.min(2e3, Math.max(50, +limit || 800));
    const rows = this.sql.exec("SELECT c, i, d, s, del FROM docs WHERE s > ? ORDER BY s LIMIT ?", since, limit).toArray();
    const seq = rows.length ? rows[rows.length - 1].s : Math.max(since, +this.kv("seq"));
    return { changes: rows.map((r) => ({ c: r.c, i: r.i, s: r.s, d: r.del ? null : JSON.parse(r.d) })), seq, more: rows.length === limit };
  }
  async getDoc(token, c, i) {
    await this.need(token);
    const r = this.sql.exec("SELECT d, s, del FROM docs WHERE c = ? AND i = ?", c, i).toArray()[0];
    return r && !r.del ? { d: JSON.parse(r.d), s: r.s } : { d: null, s: r?.s || 0 };
  }
  async query(token, c, field, value) {
    await this.need(token);
    return this.sql.exec("SELECT i, d, s FROM docs WHERE c = ? AND del = 0", c).toArray().map((r) => ({ i: r.i, s: r.s, d: JSON.parse(r.d) })).filter((r) => JSON.stringify(r.d?.[field]) === JSON.stringify(value));
  }
  async push(token, ops) {
    const m = await this.need(token);
    if (!Array.isArray(ops) || ops.length > 500) throw new Fail("bad", "\u0637\u0644\u0628 \u063A\u0644\u0637");
    let seq = +this.kv("seq");
    const done = [];
    for (const op of ops) {
      const c = clean(op.c, 40), i = clean(op.i, 120);
      if (!/^[\w-]+$/.test(c) || !i) {
        done.push({ k: op.k, ok: false });
        continue;
      }
      if (c === "settings" && m.role !== "owner") {
        done.push({ k: op.k, ok: false, err: "owner" });
        continue;
      }
      const row = this.sql.exec("SELECT d, del FROM docs WHERE c = ? AND i = ?", c, i).toArray()[0];
      const cur = row && !row.del ? JSON.parse(row.d) : null;
      let out;
      if (op.t === "del") out = null;
      else {
        const d = op.d && typeof op.d === "object" ? op.d : {}, b = op.b && typeof op.b === "object" ? op.b : null;
        if (!cur || !b) out = d;
        else {
          out = { ...cur };
          for (const k of /* @__PURE__ */ new Set([...Object.keys(d), ...Object.keys(b)])) {
            const dv = JSON.stringify(d[k]), bv = JSON.stringify(b[k]);
            if (dv === bv) continue;
            if (k === "stock" && typeof d[k] === "number" && typeof b[k] === "number" && typeof cur[k] === "number") out[k] = Math.max(0, cur[k] + (d[k] - b[k]));
            else if (UNION.includes(k)) out[k] = mergeList(cur[k], d[k], b[k]);
            else if (!(k in d)) delete out[k];
            else out[k] = d[k];
          }
        }
      }
      const txt = out ? JSON.stringify(out) : "null";
      if (txt.length > 19e5) {
        done.push({ k: op.k, ok: false, err: "big" });
        continue;
      }
      seq++;
      this.sql.exec("INSERT INTO docs (c, i, d, s, del, by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(c, i) DO UPDATE SET d = excluded.d, s = excluded.s, del = excluded.del, by = excluded.by", c, i, txt, seq, out ? 0 : 1, m.phone);
      done.push({ k: op.k, ok: true, s: seq, d: out });
    }
    this.kv("seq", seq);
    return { done, seq };
  }
  /* --- people --- */
  async members(token) {
    const m = await this.need(token);
    const all = this.sql.exec("SELECT * FROM members ORDER BY createdAt").toArray();
    return m.role === "owner" ? all.map((x) => this.pub(x)) : all.map((x) => ({ phone: x.phone, name: x.name, role: x.role }));
  }
  async addMember(token, { phone, name, password }) {
    await this.need(token, "owner");
    phone = normPhone(phone);
    name = clean(name);
    if (!okPhone(phone)) throw new Fail("phone", "\u0631\u0642\u0645 \u0627\u0644\u0647\u0627\u062A\u0641 \u0644\u0627\u0632\u0645 11 \u0631\u0642\u0645 \u0648\u064A\u0628\u062F\u0623 \u0628\u0640 07");
    if (name.length < 2) throw new Fail("name", "\u0627\u0643\u062A\u0628 \u0627\u0633\u0645 \u0627\u0644\u0639\u0627\u0645\u0644");
    if (!okPass(password)) throw new Fail("weak", "\u0643\u0644\u0645\u0629 \u0627\u0644\u0633\u0631 \u0644\u0627\u0632\u0645 6 \u062D\u0631\u0648\u0641 \u0623\u0648 \u0623\u0643\u062B\u0631");
    if (this.member(phone)) throw new Fail("taken", "\u0647\u0630\u0627 \u0627\u0644\u0631\u0642\u0645 \u0645\u0636\u0627\u0641 \u0645\u0646 \u0642\u0628\u0644", 409);
    await this.env.DIR.get(this.env.DIR.idFromName("dir")).claimPhone(phone, this.kv("id"));
    const salt = rand(16);
    this.sql.exec("INSERT INTO members (phone, name, role, hash, salt, createdAt) VALUES (?, ?, ?, ?, ?, ?)", phone, name, "worker", await pbkdf2(password, salt), salt, Date.now());
    return this.pub(this.member(phone));
  }
  async setMember(token, phone, patch) {
    const me = await this.need(token, "owner");
    phone = normPhone(phone);
    const m = this.member(phone);
    if (!m) throw new Fail("nomember", "\u0645\u0627 \u0644\u06AF\u064A\u062A \u0647\u0630\u0627 \u0627\u0644\u0634\u062E\u0635", 404);
    if (patch.password != null) {
      if (!okPass(patch.password)) throw new Fail("weak", "\u0643\u0644\u0645\u0629 \u0627\u0644\u0633\u0631 \u0644\u0627\u0632\u0645 6 \u062D\u0631\u0648\u0641 \u0623\u0648 \u0623\u0643\u062B\u0631");
      const salt = rand(16);
      this.sql.exec("UPDATE members SET hash = ?, salt = ?, ver = ver + 1, fails = 0, lockUntil = 0 WHERE phone = ?", await pbkdf2(patch.password, salt), salt, phone);
    }
    if (patch.active != null) {
      if (m.role === "owner") throw new Fail("owner", "\u0645\u0627 \u062A\u06AF\u062F\u0631 \u062A\u0648\u0642\u0641 \u0635\u0627\u062D\u0628 \u0627\u0644\u0645\u062D\u0644");
      this.sql.exec("UPDATE members SET active = ?, ver = ver + 1 WHERE phone = ?", patch.active ? 1 : 0, phone);
    }
    if (patch.name != null) {
      const n = clean(patch.name);
      if (n.length >= 2) this.sql.exec("UPDATE members SET name = ? WHERE phone = ?", n, phone);
    }
    const out = this.pub(this.member(phone));
    if (phone === me.phone && patch.password != null) out.token = await this.token(this.member(phone));
    return out;
  }
  async removeMember(token, phone) {
    await this.need(token, "owner");
    phone = normPhone(phone);
    const m = this.member(phone);
    if (!m) return true;
    if (m.role === "owner") throw new Fail("owner", "\u0645\u0627 \u062A\u06AF\u062F\u0631 \u062A\u062D\u0630\u0641 \u0635\u0627\u062D\u0628 \u0627\u0644\u0645\u062D\u0644");
    this.sql.exec("DELETE FROM members WHERE phone = ?", phone);
    await this.env.DIR.get(this.env.DIR.idFromName("dir")).releasePhone(phone, this.kv("id"));
    return true;
  }
  /* --- for the app's owner (admin) --- */
  async setDisabled(v) {
    this.kv("disabled", v ? "1" : "0");
    return true;
  }
  async adminReset(phone, password) {
    phone = normPhone(phone);
    const m = this.member(phone);
    if (!m) throw new Fail("nomember", "\u0645\u0627 \u0644\u06AF\u064A\u062A \u0647\u0630\u0627 \u0627\u0644\u0634\u062E\u0635", 404);
    if (!okPass(password)) throw new Fail("weak", "\u0643\u0644\u0645\u0629 \u0627\u0644\u0633\u0631 \u0644\u0627\u0632\u0645 6 \u062D\u0631\u0648\u0641 \u0623\u0648 \u0623\u0643\u062B\u0631");
    const salt = rand(16);
    this.sql.exec("UPDATE members SET hash = ?, salt = ?, ver = ver + 1, fails = 0, lockUntil = 0, active = 1 WHERE phone = ?", await pbkdf2(password, salt), salt, phone);
    return true;
  }
  async stats() {
    const n = this.sql.exec("SELECT c, COUNT(*) AS n FROM docs WHERE del = 0 GROUP BY c").toArray(), people = this.sql.exec("SELECT phone, name, role, active, lastSeen FROM members ORDER BY createdAt").toArray();
    return { counts: Object.fromEntries(n.map((r) => [r.c, r.n])), people, lastSeen: Math.max(0, ...people.map((p) => p.lastSeen || 0)) };
  }
};
var CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, authorization", "access-control-max-age": "86400" };
var J = /* @__PURE__ */ __name((o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS } }), "J");
var bearer = /* @__PURE__ */ __name((req) => (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""), "bearer");
var shopOf = /* @__PURE__ */ __name((env, id) => env.SHOP.get(env.SHOP.idFromName(id)), "shopOf");
var shopFromToken = /* @__PURE__ */ __name((env, t) => {
  const id = String(t || "").split(".")[0];
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Fail("auth", "\u0644\u0627\u0632\u0645 \u062A\u0633\u062C\u0644 \u062F\u062E\u0648\u0644 \u0645\u0631\u0629 \u062B\u0627\u0646\u064A\u0629", 401);
  return shopOf(env, id);
}, "shopFromToken");
async function api(req, env, url) {
  const dir = env.DIR.get(env.DIR.idFromName("dir")), p = url.pathname.replace(/^\/api/, ""), t = bearer(req);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const q = /* @__PURE__ */ __name((k) => url.searchParams.get(k), "q");
  if (p === "/login" && req.method === "POST") {
    const phone = normPhone(body.phone);
    if (!okPhone(phone)) throw new Fail("phone", "\u0631\u0642\u0645 \u0627\u0644\u0647\u0627\u062A\u0641 \u0644\u0627\u0632\u0645 11 \u0631\u0642\u0645 \u0648\u064A\u0628\u062F\u0623 \u0628\u0640 07");
    const r = await dir.lookup(phone);
    if (!r) {
      await pbkdf2("x", "y");
      throw new Fail("wrong", "\u0627\u0644\u0631\u0642\u0645 \u0623\u0648 \u0643\u0644\u0645\u0629 \u0627\u0644\u0633\u0631 \u063A\u0644\u0637", 401);
    }
    return shopOf(env, r.shop).login(phone, body.password);
  }
  if (p === "/me") return shopFromToken(env, t).me(t);
  if (p === "/pull") return shopFromToken(env, t).pull(t, q("since"), q("limit"));
  if (p === "/push" && req.method === "POST") return shopFromToken(env, t).push(t, body.ops);
  if (p === "/doc") return shopFromToken(env, t).getDoc(t, q("c"), q("i"));
  if (p === "/query") return shopFromToken(env, t).query(t, q("c"), q("f"), JSON.parse(q("v") || "null"));
  if (p === "/members") return shopFromToken(env, t).members(t);
  if (p === "/members/add" && req.method === "POST") return shopFromToken(env, t).addMember(t, body);
  if (p === "/members/set" && req.method === "POST") return shopFromToken(env, t).setMember(t, body.phone, body);
  if (p === "/members/remove" && req.method === "POST") return shopFromToken(env, t).removeMember(t, body.phone);
  if (p === "/admin/state") return dir.adminState();
  if (p === "/admin/setup" && req.method === "POST") return dir.adminSetup(body.password);
  if (p === "/admin/login" && req.method === "POST") return dir.adminLogin(body.password);
  if (p.startsWith("/admin/")) {
    if (!await dir.adminCheck(t)) throw new Fail("auth", "\u0633\u062C\u0651\u0644 \u062F\u062E\u0648\u0644 \u0627\u0644\u0645\u062F\u064A\u0631 \u0645\u0631\u0629 \u062B\u0627\u0646\u064A\u0629", 401);
    if (p === "/admin/shops") {
      const list = await dir.listShops();
      const st = await Promise.all(list.map((s) => shopOf(env, s.id).stats().catch(() => null)));
      return list.map((s, k) => ({ ...s, stats: st[k] }));
    }
    if (p === "/admin/shops/add" && req.method === "POST") return dir.createShop(body);
    if (p === "/admin/shops/set" && req.method === "POST") return dir.setShop(body.id, body);
    if (p === "/admin/shops/reset" && req.method === "POST") {
      if (!await dir.getShop(body.id)) throw new Fail("noshop", "\u0627\u0644\u0645\u062D\u0644 \u0645\u0648 \u0645\u0648\u062C\u0648\u062F", 404);
      return shopOf(env, body.id).adminReset(body.phone, body.password);
    }
    if (p === "/admin/password" && req.method === "POST") return dir.adminPassword(body.password);
  }
  throw new Fail("notfound", "\u0645\u0648 \u0645\u0648\u062C\u0648\u062F", 404);
}
__name(api, "api");
var worker_default = {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      return J(await api(req, env, url));
    } catch (e) {
      const f = readFail(e);
      if (f) return J({ error: f.code, msg: f.msg }, f.status);
      console.log("server error", String(e?.stack || e));
      return J({ error: "error", msg: "\u0635\u0627\u0631 \u062E\u0637\u0623 \u0628\u0627\u0644\u0633\u064A\u0631\u0641\u0631\u060C \u062C\u0631\u0651\u0628 \u0628\u0639\u062F \u0634\u0648\u064A\u0629" }, 500);
    }
  }
};

// ../../../tmp/wcheck/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../tmp/wcheck/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-ELPHbD/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../../tmp/wcheck/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-ELPHbD/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  Directory,
  Shop,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
