/* دكّان — a shop on its OWN Firebase (Google). Each shop owner makes his own Firebase project; the shop's data,
   accounts and permissions live there. Our server only sends notifications and handles the free trial / activation.
   The app keeps working exactly as before: everything is saved on the device first, then sent. */
(function () {
  'use strict';
  var SITE = '__SITE__' || location.origin;
  var RULES = __RULES__, RULES_VER = 'v1';
  var DOMAIN = 'dukkan-shop.app';
  var SDK = ['vendor/firebase-app-compat.js', 'vendor/firebase-auth-compat.js', 'vendor/firebase-firestore-compat.js'];
  var PERMS = {money: false, sell: true, pay: true, customers: true, products: false, returns: false, purchases: false};
  var ALL = {money: true, sell: true, pay: true, customers: true, products: true, returns: true, purchases: true};
  var COST = ['buy', 'avgBuy', 'lastBuy', 'cost'];
  var note = function (t, b, a) { return (window.__dkNote || C.sideNote)(t, b, a); };
  var C = null, app = null, auth = null, fs = null, FV = null, cfg = null, me = null, cloud = null;
  var LS = {get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }, del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }};
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); };
  var toEn = function (s) { return String(s || '').replace(/[٠-٩]/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'.indexOf(d); }).replace(/[۰-۹]/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'.indexOf(d); }); };
  var normPhone = function (p) { var s = toEn(p).replace(/\D/g, ''); if (s.indexOf('00964') === 0) s = '0' + s.slice(5); else if (s.indexOf('964') === 0) s = '0' + s.slice(3); else if (/^7\d{9}$/.test(s)) s = '0' + s; return s; };
  var okPhone = function (p) { return /^07\d{9}$/.test(p); };
  var say = function (m, ok) { try { toast(m, ok !== false); } catch (e) {} };
  var clone = function (o) { return o == null ? o : JSON.parse(JSON.stringify(o)); };
  var sleep = function (ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); };
  var emailOf = function (phone, k) { return phone + (k ? '.' + k : '') + '@' + DOMAIN; };
  var b64u = function (s) { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  var ub64 = function (s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return decodeURIComponent(escape(atob(s))); };

  /* ---------- the shop's Firebase "ID card" (not a secret: Google's rules protect the data) ---------- */
  function parseCfg(txt) {
    txt = String(txt || '').trim();
    var m = /[#&?]fb=([A-Za-z0-9_-]+)/.exec(txt) || /^([A-Za-z0-9_-]{40,})$/.exec(txt);
    if (m) { try { return checkCfg(JSON.parse(ub64(m[1]))); } catch (e) { return null; } }
    var get = function (k) { var r = new RegExp('["\']?' + k + '["\']?\\s*[:=]\\s*["\']([^"\']+)["\']').exec(txt); return r ? r[1].trim() : ''; };
    return checkCfg({apiKey: get('apiKey'), authDomain: get('authDomain'), projectId: get('projectId'), appId: get('appId'), messagingSenderId: get('messagingSenderId'), storageBucket: get('storageBucket')});
  }
  function checkCfg(c) {
    if (!c || !/^AIza[\w-]{20,}$/.test(c.apiKey || '') || !/^[a-z0-9-]{4,40}$/.test(c.projectId || '')) return null;
    var o = {apiKey: c.apiKey, projectId: c.projectId, authDomain: /^[\w.-]+$/.test(c.authDomain || '') ? c.authDomain : c.projectId + '.firebaseapp.com'};
    if (/^[\w:.-]+$/.test(c.appId || '')) o.appId = c.appId;
    if (/^\d+$/.test(c.messagingSenderId || '')) o.messagingSenderId = c.messagingSenderId;
    if (/^[\w.-]+$/.test(c.storageBucket || '')) o.storageBucket = c.storageBucket;
    return o;
  }
  function joinLink() { return SITE.replace(/\/$/, '') + '/app/#fb=' + b64u(JSON.stringify({apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId, appId: cfg.appId})); }
  function loadCfg() { try { return checkCfg(JSON.parse(LS.get('dk:fb') || 'null')); } catch (e) { return null; } }

  /* ---------- Google's code (loaded only for Firebase shops) ---------- */
  var sdkP = null;
  function loadSdk() {
    if (sdkP) return sdkP;
    sdkP = SDK.reduce(function (p, src) { return p.then(function () { return new Promise(function (ok, bad) { var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = function () { bad(new Error('ما گدرت أحمّل ملفات Firebase. تأكد من النت وجرّب')); }; document.head.appendChild(s); }); }); }, Promise.resolve());
    sdkP.catch(function () { sdkP = null; });
    return sdkP;
  }
  function open(c) {
    return loadSdk().then(function () {
      if (app && cfg && cfg.projectId === c.projectId) return;
      cfg = c;
      app = firebase.apps.find(function (a) { return a.name === 'dk'; }) || firebase.initializeApp(c, 'dk');
      auth = app.auth(); fs = app.firestore(); FV = firebase.firestore.FieldValue;
    });
  }
  var ts = function () { return FV.serverTimestamp(); };
  function fbErr(e, fallback) {
    var code = String(e && e.code || ''), m = {
      'auth/wrong-password': 'الرقم أو كلمة السر غلط', 'auth/invalid-credential': 'الرقم أو كلمة السر غلط', 'auth/invalid-login-credentials': 'الرقم أو كلمة السر غلط', 'auth/user-not-found': 'الرقم أو كلمة السر غلط',
      'auth/too-many-requests': 'محاولات هواية. Google وگّفها شوية، انتظر وجرّب', 'auth/network-request-failed': 'ما أكو اتصال. تأكد من الإنترنت', 'auth/weak-password': 'كلمة السر ضعيفة: لازم 6 حروف أو أكثر',
      'auth/email-already-in-use': 'هذا الرقم مسجل من قبل', 'auth/invalid-email': 'الإيميل مو صحيح', 'auth/operation-not-allowed': 'لازم تفعّل «Email/Password» من Firebase ← Authentication ← Sign-in method',
      'auth/configuration-not-found': 'لازم تفعّل Authentication بمشروع Firebase مالتك (Get started ← Email/Password)', 'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'بطاقة المشروع (apiKey) غلط. انسخها مرة ثانية',
      'auth/requires-recent-login': 'لأمانك، اكتب كلمة السر الحالية مرة ثانية', 'permission-denied': 'Firebase رفض. تأكد إن قواعد القفل ملصوقة صح', 'unavailable': 'ما أكو اتصال بـ Firebase هسه', 'resource-exhausted': 'وصلت حد Firebase المجاني لهذا اليوم. يرجع باچر، أو حوّل مشروعك لخطة Blaze'
    }[code];
    var x = new Error(m || (fallback || 'صار خطأ') + (code ? ' (' + code + ')' : '')); x.code = code; return x;
  }

  /* ---------- encoding: Firebase doesn't take a list directly inside a list ---------- */
  function enc(v) {
    if (Array.isArray(v)) return v.map(function (x) { return Array.isArray(x) ? {_nA: JSON.stringify(x)} : enc(x); });
    if (v && typeof v === 'object') { var o = {}; Object.keys(v).forEach(function (k) { if (v[k] !== undefined) o[k] = enc(v[k]); }); return o; }
    return v;
  }
  function dec(v) {
    if (Array.isArray(v)) return v.map(dec);
    if (v && typeof v === 'object') {
      if (typeof v.toMillis === 'function') return v.toMillis();
      if (Object.keys(v).length === 1 && typeof v._nA === 'string') { try { return JSON.parse(v._nA); } catch (e) { return []; } }
      var o = {}; Object.keys(v).forEach(function (k) { o[k] = dec(v[k]); }); return o;
    }
    return v;
  }
  function plain(raw) { var o = dec(raw || {}); delete o._t; delete o._by; delete o._del; return o; }

  /* ---------- private fields: buying prices / costs (money people) and the manager code (owner) live apart ---------- */
  var privCol = function (c) { return c === 'settings' ? 'dk_opriv' : 'dk_priv'; };
  function canPriv(c) { if (!me) return false; if (c === 'settings') return me.role === 'owner'; return me.role === 'owner' || !!(me.perms && me.perms.money); }
  function hasPriv(c) { return c === 'products' || c === 'invoices' || c === 'settings'; }
  function splitPriv(c, d, old) {
    var main = clone(d), f = null;
    if (c === 'products') { f = {}; COST.forEach(function (k) { if (k in main) { f[k] = main[k]; delete main[k]; } }); var hist = (old && old.hist) || []; if (f.buy != null && (!hist.length || hist[hist.length - 1].buy !== f.buy)) hist = hist.concat([{t: Date.now(), buy: f.buy}]).slice(-30); if (hist.length) f.hist = hist; }
    else if (c === 'invoices') { f = {}; if (Array.isArray(main.items)) { f.itemsBuy = main.items.map(function (it) { return it && it.buy != null ? it.buy : null; }); main.items = main.items.map(function (it) { var x = Object.assign({}, it); COST.forEach(function (k) { delete x[k]; }); return x; }); } if ('cost' in main) { f.cost = main.cost; delete main.cost; } if ('profit' in main) { f.profit = main.profit; delete main.profit; } }
    else if (c === 'settings') { f = {}; if ('pinHash' in main) { f.pinHash = main.pinHash; delete main.pinHash; } }
    return {main: main, priv: f};
  }
  function applyPriv(c, d, f) {
    if (!d || !f) return d;
    var o = Object.assign({}, d);
    if (c === 'products') COST.forEach(function (k) { if (k in f) o[k] = f[k]; });
    else if (c === 'invoices') { if (Array.isArray(f.itemsBuy) && Array.isArray(o.items)) o.items = o.items.map(function (it, n) { return f.itemsBuy[n] != null ? Object.assign({}, it, {buy: f.itemsBuy[n]}) : it; }); if ('cost' in f) o.cost = f.cost; if ('profit' in f) o.profit = f.profit; }
    else if (c === 'settings') { if ('pinHash' in f) o.pinHash = f.pinHash; }
    return o;
  }
  var samePriv = function (a, b) { var x = Object.assign({}, a || {}), y = Object.assign({}, b || {}); delete x.hist; delete y.hist; return JSON.stringify(x) === JSON.stringify(y); };

  /* ---------- merging, exactly like our server did: only what THIS device changed goes on top of the newest copy ---------- */
  var UNION = ['payments', 'returns'];
  function mergeList(cur, mine, base) {
    cur = Array.isArray(cur) ? cur : []; mine = Array.isArray(mine) ? mine : []; base = Array.isArray(base) ? base : [];
    var id = function (x) { return x && typeof x === 'object' ? x.id : undefined; };
    if (![].concat(cur, mine, base).every(function (x) { return id(x) != null; })) return mine;
    var removed = {}; base.forEach(function (b) { if (!mine.some(function (m) { return id(m) === id(b); })) removed[id(b)] = 1; });
    var inBase = {}; base.forEach(function (b) { inBase[id(b)] = b; });
    // keep the shop's order: what is there stays in place (with this device's edits), what this device added goes at the end
    var out = cur.filter(function (x) { return !removed[id(x)]; }).map(function (x) { var m = mine.find(function (y) { return id(y) === id(x); }), b = inBase[id(x)]; return m && JSON.stringify(m) !== JSON.stringify(b) ? m : x; });
    mine.forEach(function (m) { if (!out.some(function (x) { return id(x) === id(m); })) out.push(m); });
    return out;
  }
  function mergeOp(cur, d, b) {
    d = d && typeof d === 'object' ? d : {}; b = b && typeof b === 'object' ? b : null;
    if (!cur || !b) return clone(d);
    var out = clone(cur), keys = {}; Object.keys(d).concat(Object.keys(b)).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(function (k) {
      var dv = JSON.stringify(d[k]), bv = JSON.stringify(b[k]); if (dv === bv) return;
      if (k === 'stock' && typeof d[k] === 'number' && typeof b[k] === 'number' && typeof cur[k] === 'number') out[k] = Math.max(0, cur[k] + (d[k] - b[k]));
      else if (UNION.indexOf(k) >= 0) out[k] = mergeList(cur[k], d[k], b[k]);
      else if (!(k in d)) { if (k !== 'by' && k !== 'byName') delete out[k]; }
      else out[k] = clone(d[k]);
    });
    return out;
  }

  /* ---------- news about invoices (the same words the server used) ---------- */
  var money = function (n) { return Math.round(+n || 0).toLocaleString('en-US'); };
  var TYPE = {cash: 'نقد', debt: 'دين', inst: 'أقساط'};
  function invoiceNews(cur, out, who) {
    if (!out) return [];
    var no = out.no ? ' #' + out.no : '', cust = out.customerName || 'زبون', L = [];
    if (!cur && !out.void) L.push({title: '🧾 فاتورة جديدة' + no, body: who + ' باع لـ ' + cust + ' — ' + (TYPE[out.type] || '') + ' — ' + money(out.total) + ' د.ع', kind: 'sale'});
    if (cur) {
      var ids = {}; (cur.payments || []).forEach(function (p) { if (p) ids[p.id] = 1; });
      var add = (out.payments || []).filter(function (p) { return p && !ids[p.id]; });
      if (add.length) L.push({title: '💵 دفعة واصلة', body: who + ' سجّل ' + money(add.reduce(function (t, p) { return t + (+p.amount || 0); }, 0)) + ' د.ع من ' + cust + ' (فاتورة' + no + ')', kind: 'pay'});
      var rids = {}; (cur.returns || []).forEach(function (r) { if (r) rids[r.id] = 1; });
      var radd = (out.returns || []).filter(function (r) { return r && !rids[r.id] && !r.void; });
      if (radd.length) L.push({title: '↩️ إرجاع' + no, body: who + ' رجّع منتجات بقيمة ' + money(radd.reduce(function (t, r) { return t + (+r.amount || 0); }, 0)) + ' د.ع — ' + cust, kind: 'ret'});
      if (out.void && !cur.void) L.push({title: '⛔ انلغت فاتورة' + no, body: who + ' لغى فاتورة ' + cust + (out.voidReason ? ' — ' + out.voidReason : ''), kind: 'void'});
    }
    return L;
  }

  /* ---------- who can see which lists ---------- */
  var MONEY_COLS = ['cash', 'expenses', 'closings', 'recurring', 'logs'], PUR_COLS = ['supplierTx', 'suppliers'];
  function hidden(c) { if (!me || me.role === 'owner') return false; var P = me.perms || {}; return (!P.money && MONEY_COLS.indexOf(c) >= 0) || (!P.purchases && PUR_COLS.indexOf(c) >= 0); }

  /* ---------- the database the app sees: the same local copy as before, but it talks to Firebase ---------- */
  function makeCloud(s) {
    var Base = C.Cloud;
    function FireCloud(s) {
      var self = this; Base.call(this, s);
      self.L = {}; self.cur = {}; self.first = {}; self.chores = [];
      self.ready = self.ready.then(function () {
        return new Promise(function (ok) { var r = self.d.transaction('meta').objectStore('meta').get('fbcur'); r.onsuccess = function () { self.cur = r.result || {}; ok(); }; r.onerror = function () { ok(); }; });
      }).then(function () { self.synced = Object.keys(self.cur).length > 0; });
    }
    FireCloud.prototype = Object.create(Base.prototype);
    FireCloud.prototype.constructor = FireCloud;
    var P = FireCloud.prototype;
    P.collection = function (c) { this.listen(c); return Base.prototype.collection.call(this, c); };
    P.saveCur = function () { try { this.d.transaction('meta', 'readwrite').objectStore('meta').put(this.cur, 'fbcur'); } catch (e) {} };
    P.privOf = function (c, i) { return this.col('__priv').get(c + '~' + i) || null; };
    P.setPriv = function (c, i, f) { var k = c + '~' + i; if (f == null) this.col('__priv').delete(k); else this.col('__priv').set(k, f); this.saveDoc('__priv', k, f); };
    // live: everything that changed since this device last looked (each thing is read once, not the whole shop every time)
    P.listen = function (c) {
      var self = this;
      if (self.L[c] || hidden(c) || c === '__priv' || !fs) return;
      var since = Math.max(0, (self.cur[c] || 0) - 5 * 60000);
      var q = fs.collection('c_' + c).where('_t', '>', firebase.firestore.Timestamp.fromMillis(since)).orderBy('_t');
      self.L[c] = q.onSnapshot(function (snap) {
        var maxT = self.cur[c] || 0, news = [];
        self.hold(function () {
          snap.docChanges().forEach(function (ch) {
            if (ch.type === 'removed') return;
            var raw = ch.doc.data({serverTimestamps: 'estimate'}), t = raw._t && raw._t.toMillis ? raw._t.toMillis() : 0;
            if (ch.doc.metadata.hasPendingWrites) return;
            if (t > maxT) maxT = t;
            self.remote(c, ch.doc.id, raw, news);
          });
        });
        if (maxT > (self.cur[c] || 0)) { self.cur[c] = maxT; self.saveCur(); }
        if (!self.first[c]) { self.first[c] = 1; self.checkSynced(); }
        self.online(true); self.status();
        news.forEach(function (n) { note(n.title, n.body); });
      }, function (e) { self.L[c] = null; self.fbFail(e); });
      if (hasPriv(c) && canPriv(c)) self.listenPriv(privCol(c));
    };
    P.listenPriv = function (pc) {
      var self = this, key = '~' + pc;
      if (self.L[key]) return;
      var since = Math.max(0, (self.cur[key] || 0) - 5 * 60000);
      self.L[key] = fs.collection(pc).where('_t', '>', firebase.firestore.Timestamp.fromMillis(since)).orderBy('_t').onSnapshot(function (snap) {
        var maxT = self.cur[key] || 0, touched = {};
        self.hold(function () {
          snap.docChanges().forEach(function (ch) {
            if (ch.type === 'removed') return;
            var raw = ch.doc.data({serverTimestamps: 'estimate'}), t = raw._t && raw._t.toMillis ? raw._t.toMillis() : 0; if (t > maxT) maxT = t;
            if (ch.doc.metadata.hasPendingWrites) return;
            var c = raw.c, i = raw.i; if (!c || !i || self.pending(c, i)) return;
            var f = dec(raw.f || {}); self.setPriv(c, i, f);
            var d = self.col(c).get(i); if (d) { var v = applyPriv(c, d, f); self.col(c).set(i, v); self.saveDoc(c, i, v); touched[c] = 1; }
          });
          Object.keys(touched).forEach(function (c) { self.notify(c); });
        });
        if (maxT > (self.cur[key] || 0)) { self.cur[key] = maxT; self.saveCur(); }
      }, function (e) { self.L[key] = null; self.fbFail(e); });
    };
    P.checkSynced = function () {
      var self = this, wanted = Object.keys(self.L).filter(function (k) { return k[0] !== '~' && self.L[k]; });
      if (!self.synced && wanted.length && wanted.every(function (k) { return self.first[k]; })) { self.synced = true; Object.keys(self.subs).forEach(function (c) { self.notify(c); }); }
      if (self.synced && self.syncWait) { self.syncWait.forEach(function (f) { f(); }); self.syncWait = null; }
    };
    // a change from another device (or from this one, confirmed)
    P.remote = function (c, i, raw, news) {
      var self = this;
      if (self.pending(c, i)) { (self.skipped = self.skipped || {})[c + '\u0001' + i] = 1; return; }
      var col = self.col(c), prev = col.has(i) ? col.get(i) : undefined;
      if (raw._del) { if (col.has(i)) { col.delete(i); self.saveDoc(c, i, null); self.notify(c); } return; }
      var d = applyPriv(c, plain(raw), self.privOf(c, i));
      col.set(i, d); self.saveDoc(c, i, d); self.notify(c);
      var other = raw._by && raw._by !== (me && me.uid);
      if (!other) return;
      if (c === 'invoices' && self.first[c]) news.push.apply(news, invoiceNews(prev || null, d, nameOf(raw._by)));
      if (me && me.role === 'owner') {
        if (c === 'invoices') self.chore(function () { return fillCost(i, self.col('invoices').get(i)); });
        if (c === 'products' && prev) self.chore(function () { return handStock(i, prev, d, raw); });
      }
    };
    P.chore = function (fn) { var self = this; self.chores.push(fn); if (self.choring) return; self.choring = true; (function next() { var f = self.chores.shift(); if (!f) { self.choring = false; return; } Promise.resolve().then(f).catch(function () {}).then(function () { setTimeout(next, 150); }); })(); };
    P.fbFail = function (e) {
      var code = String(e && e.code || '');
      if (code === 'permission-denied' && auth && auth.currentUser) { checkStillMember(); return; }
      if (code === 'resource-exhausted') { quota(); return; }
      this.online(false); this.status();
    };
    // a change made here goes up one by one; each one is merged with the newest copy on Firebase (so no device wipes another's work)
    P.flush = function () {
      var self = this;
      if (self.pushing || !self.queue.length || self.dead || !fs || !auth || !auth.currentUser) return Promise.resolve();
      if (navigator.onLine === false) { self.online(false); self.status(); return Promise.resolve(); }
      self.pushing = true;
      var changed = {}, stop = false;
      var step = function () {
        var op = self.queue[0];
        if (!op || stop) return Promise.resolve();
        return withTimeout(self.pushOne(op), 20000).then(function (res) {
          self.done(op, true, res.view, null); changed[op.c] = 1;
          if (res.news && res.news.length) C.call('/fb/news', {news: res.news}).catch(function () {});
          return step();
        }, function (e) {
          var code = String(e && e.code || '');
          if (code === 'permission-denied' || code === 'invalid-argument' || code === 'failed-precondition' || code === 'out-of-range') {
            self.done(op, false, null, e.msg || (code === 'permission-denied' ? 'هذا مو من صلاحياتك' : 'ما انحفظ: ' + code)); changed[op.c] = 1;
            if (code === 'permission-denied') self.fetchDoc(op.c, op.i).catch(function () {});
            return step();
          }
          if (code === 'resource-exhausted') quota();
          stop = true; self.online(false);
        });
      };
      return step().then(function () {
        self.hold(function () { Object.keys(changed).forEach(function (c) { self.notify(c); }); });
        if (!stop) self.online(true);
      }).finally(function () { self.pushing = false; self.status(); if (self.queue.length && !self.offline) self.flushSoon(); });
    };
    P.done = function (op, ok, view, msg) {
      var self = this, idx = self.queue.indexOf(op); if (idx >= 0) self.queue.splice(idx, 1);
      try { self.d.transaction('outbox', 'readwrite').objectStore('outbox').delete(op.k); } catch (e) {}
      var w = self.waits[op.k]; delete self.waits[op.k];
      if (!self.pending(op.c, op.i) && ok) { if (view == null) self.col(op.c).delete(op.i); else self.col(op.c).set(op.i, view); self.saveDoc(op.c, op.i, view); }
      if (!ok && msg && op.c !== 'logs') say(msg, false);
      if (w) { if (ok) w.ok(); else { var e = new Error(msg || 'ما انحفظ'); e.code = 'permission_denied'; w.bad(e); } }
      var sk = op.c + '\u0001' + op.i;
      if (self.skipped && self.skipped[sk] && !self.pending(op.c, op.i)) { delete self.skipped[sk]; self.fetchDoc(op.c, op.i).catch(function () {}); }   // someone else changed it while ours was on its way
    };
    P.pushOne = function (op) {
      var self = this, c = op.c, i = op.i, ref = fs.collection('c_' + c).doc(i), uid = me.uid;
      // a list this person can't read (a worker writing to the record): just add it, no merge needed
      if (hidden(c)) {
        if (op.t === 'del') return Promise.reject({code: 'permission-denied'});
        var sp0 = splitPriv(c, op.d || {}), main0 = enc(sp0.main); main0._t = ts(); main0._by = uid;
        return ref.set(main0).then(function () { return {view: op.d, news: []}; });
      }
      var wp = hasPriv(c) && canPriv(c), pref = wp ? fs.collection(privCol(c)).doc('c_' + c + '~' + i) : null, who = me.name || me.phone;
      return fs.runTransaction(function (tx) {
        return Promise.all([tx.get(ref), pref ? tx.get(pref) : null]).then(function (r) {
          var raw = r[0].exists ? r[0].data() : null, cur = raw && !raw._del ? plain(raw) : null;
          var pv = r[1] && r[1].exists ? dec(r[1].data().f || {}) : (wp ? null : self.privOf(c, i));
          var curView = cur ? applyPriv(c, cur, pv) : null;
          var out = op.t === 'del' ? null : mergeOp(curView, op.d, op.b);
          if (c === 'invoices' && out && !cur && !out.by) { out.by = me.phone; out.byName = me.name || ''; }
          var news = c === 'invoices' ? invoiceNews(curView, out, who) : [];
          if (!out) { tx.set(ref, {_del: true, _t: ts(), _by: uid}); return {view: null, news: news}; }
          var sp = hasPriv(c) ? splitPriv(c, out, pv) : {main: out, priv: null};
          var main = enc(sp.main); main._t = ts(); main._by = uid;
          tx.set(ref, main);
          if (wp && sp.priv && (!samePriv(sp.priv, pv) || (sp.priv.hist && JSON.stringify(sp.priv.hist) !== JSON.stringify(pv && pv.hist)))) tx.set(pref, {c: c, i: i, f: enc(sp.priv), _t: ts(), _by: uid});
          return {view: applyPriv(c, sp.main, wp ? sp.priv : pv), news: news, priv: wp ? sp.priv : null};
        });
      }).then(function (res) { if (res.priv) self.setPriv(c, i, res.priv); return res; });
    };
    P.fetchDoc = function (c, i) {
      var self = this;
      if (!fs || hidden(c)) return Promise.resolve(self.col(c).get(i));
      var gp = hasPriv(c) && canPriv(c) ? fs.collection(privCol(c)).doc('c_' + c + '~' + i).get() : Promise.resolve(null);
      return withTimeout(Promise.all([fs.collection('c_' + c).doc(i).get(), gp]), 4000).then(function (r) {
        if (self.pending(c, i)) return self.col(c).get(i);
        if (r[1] && r[1].exists) self.setPriv(c, i, dec(r[1].data().f || {}));
        var raw = r[0].exists ? r[0].data() : null, d = raw && !raw._del ? applyPriv(c, plain(raw), self.privOf(c, i)) : null;
        var col = self.col(c), before = JSON.stringify(col.get(i) == null ? null : col.get(i));
        if (d == null) col.delete(i); else col.set(i, d);
        if (JSON.stringify(d) !== before) { self.saveDoc(c, i, d); self.notify(c); }
        self.online(true);
        return d;
      });
    };
    P.remoteQuery = function (c, f, v) {
      var self = this;
      if (!fs || hidden(c)) return Promise.reject(new Error('local'));
      return withTimeout(fs.collection('c_' + c).where(f, '==', v).get(), 4000).then(function (snap) {
        var docs = []; snap.forEach(function (x) { var raw = x.data(); if (!raw._del) docs.push(C.docSnap(x.id, applyPriv(c, plain(raw), self.privOf(c, x.id)))); });
        self.queue.forEach(function (o) { if (o.c === c && o.t === 'set' && JSON.stringify(o.d[f]) === JSON.stringify(v) && !docs.some(function (d) { return d.id === o.i; })) docs.push(C.docSnap(o.i, o.d)); });
        return {docs: docs, size: docs.length, empty: !docs.length};
      });
    };
    P.pull = function () { var self = this; if (self.synced) return Promise.resolve(); return new Promise(function (ok) { (self.syncWait = self.syncWait || []).push(ok); setTimeout(ok, 8000); }); };
    P.live = function () {};
    P.relisten = function () { var self = this; Object.keys(self.L).forEach(function (k) { if (self.L[k]) { try { self.L[k](); } catch (e) {} } self.L[k] = null; }); self.L = {}; self.first = {}; Object.keys(self.subs).forEach(function (c) { self.listen(c); }); };
    P.start = function () {
      var self = this;
      self.flush();
      setInterval(function () { if (self.queue.length && document.visibilityState === 'visible') self.flush(); }, 20000);
      setInterval(function () { if (!self.queue.length) self.relisten(); }, 3 * 3600000);   // a long-open program starts fresh every few hours (cheaper for Firebase)
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') self.flush(); });
      addEventListener('online', function () { self.online(true); self.flush(); });
      addEventListener('offline', function () { self.online(false); self.status(); });
    };
    return new FireCloud(s);
  }
  function withTimeout(p, ms) { return Promise.race([p, new Promise(function (ok, bad) { setTimeout(function () { var e = new Error('timeout'); e.code = 'unavailable'; bad(e); }, ms); })]); }
  var quotaSaid = 0;
  function quota() { if (Date.now() - quotaSaid < 600000) return; quotaSaid = Date.now(); note('⚠️ وصلت حد Firebase المجاني', 'الحركات محفوظة على الجهاز وتنرفع وحدها لما يرجع الحد (باچر). إذا تتكرر، حوّل مشروعك لخطة Blaze من Firebase.'); }

  /* ---------- the owner's device quietly finishes two jobs the server used to do ---------- */
  var names = {}; try { names = JSON.parse(LS.get('dk:fbnames') || '{}'); } catch (e) {}
  function nameOf(uid) { var n = names[uid]; return n ? n.name || n.phone : 'واحد من المحل'; }
  // 1) a worker's sale has no buying prices (he can't see them): the owner's device adds them, so profits stay right
  function fillCost(id, inv) {
    if (!cloud || !inv || !Array.isArray(inv.items) || !inv.items.some(function (it) { return it && it.pid && it.buy == null; })) return;
    var pref = fs.collection('dk_priv').doc('c_invoices~' + id);
    return pref.get().then(function (snap) {
      var f = snap.exists ? dec(snap.data().f || {}) : {}, have = f.itemsBuy || [], at = inv.createdAt || Date.parse(inv.date || '') || Date.now(), any = false;
      var itemsBuy = inv.items.map(function (it, n) {
        if (have[n] != null) return have[n];
        var pf = it && it.pid ? cloud.privOf('products', it.pid) : null; if (!pf) return null;
        var hist = (pf.hist || []).filter(function (h) { return h.t <= at; }), b = hist.length ? hist[hist.length - 1].buy : pf.buy;
        if (b != null) any = true; return b != null ? b : null;
      });
      if (!any) return;
      f.itemsBuy = itemsBuy;
      return pref.set({c: 'invoices', i: id, f: enc(f), _t: ts(), _by: me.uid}).then(function () {
        cloud.setPriv('invoices', id, f); var d = cloud.col('invoices').get(id); if (d) { var v = applyPriv('invoices', d, f); cloud.col('invoices').set(id, v); cloud.saveDoc('invoices', id, v); cloud.notify('invoices'); }
      });
    });
  }
  // 2) a worker changed a stock number by hand (not by a sale): it goes in the record under his name, and the owner gets told
  function handStock(pid, prev, now, raw) {
    if (typeof prev.stock !== 'number' || typeof now.stock !== 'number' || prev.stock === now.stock) return;
    var had = {}; (prev.stkMarks || []).forEach(function (k) { had[k] = 1; });
    var fresh = (now.stkMarks || []).filter(function (k) { return !had[k]; });
    for (var n = 0; n < fresh.length; n++) {
      var key = String(fresh[n]), at = key.indexOf(':'); if (at < 1) continue;
      var inv = cloud.col('invoices').get(key.slice(0, at)), sp = inv && inv.stockPending;
      if (!sp || sp.k !== key.slice(at + 1)) continue;
      var dd = ((sp.need || {})[pid] || 0) - ((sp.had || {})[pid] || 0);
      if (now.stock === Math.max(0, prev.stock - dd)) return;
    }
    var pHad = {}; (prev.purMarks || []).forEach(function (k) { pHad[k] = 1; });
    var wp = names[raw._by] && names[raw._by].perms; if (wp && wp.purchases && (now.purMarks || []).some(function (k) { return !pHad[k]; })) return;
    var who = nameOf(raw._by), summary = '⚠️ ' + who + ' غيّر مخزون «' + (now.name || 'منتج') + '» بيده: كان ' + prev.stock + ' وصار ' + now.stock;
    var t = raw._t && raw._t.toMillis ? raw._t.toMillis() : Date.now();
    cloud.write('logs', 'hs-' + pid + '-' + t, {t: t, date: new Date(t + 3 * 3600000).toISOString().slice(0, 10), uid: (names[raw._by] || {}).phone || '', byName: who, entity: 'products', action: 'stock', summary: summary, amount: null, ref: pid});
    C.call('/fb/news', {news: [{title: '📦 تعديل مخزون باليد', body: summary, kind: 'stock'}], ownerOnly: true}).catch(function () {});
    note('📦 تعديل مخزون باليد', summary);
  }

  /* ---------- people: login, the owner, the workers ---------- */
  function sessOf(m, shopName) {
    var rt = LS.get('dk:fbrelay') || '';
    return {fb: true, token: rt, user: {phone: m.phone, name: m.name, role: m.role, perms: m.role === 'owner' ? ALL : Object.assign({}, PERMS, m.perms || {}), uid: m.uid, active: true, salary: m.salary || 0},
      shop: {id: 'fb-' + cfg.projectId, name: shopName || LS.get('dk:fbshop') || 'محلي'},
      desk: rt ? {token: rt, shop: 'fb:' + cfg.projectId, phone: m.uid, name: shopName || LS.get('dk:fbshop') || ''} : null};
  }
  function memberDoc(uid) { return fs.collection('dk_members').doc(uid).get().then(function (d) { if (!d.exists) return null; var m = d.data(); m.uid = uid; return m; }); }
  function signIn(phone, pass) {
    return fs.collection('dk_logins').doc(phone).get().then(function (d) {
      if (!d.exists) { var e = new Error('الرقم أو كلمة السر غلط'); e.code = 'auth/user-not-found'; throw e; }
      return auth.signInWithEmailAndPassword(d.data().e, pass);
    }).then(function (cr) { return afterSignIn(cr.user.uid); });
  }
  function afterSignIn(uid) {
    return Promise.all([memberDoc(uid), fs.collection('dk_meta').doc('shop').get().catch(function () { return null; })]).then(function (r) {
      var m = r[0];
      if (!m) { auth.signOut(); throw new Error('هذا الحساب مو من أهل المحل. راجع صاحب المحل'); }
      if (!m.active) { auth.signOut(); throw new Error('حسابك موقوف. راجع صاحب المحل'); }
      var shopName = r[1] && r[1].exists ? r[1].data().name : '';
      if (shopName) LS.set('dk:fbshop', shopName);
      me = m; return m;
    });
  }
  // our server: a card for notifications + the free trial / activation state
  function hello() {
    if (!auth || !auth.currentUser || !me) return Promise.resolve(null);
    return auth.currentUser.getIdToken().then(function (tok) { return C.call('/fb/hello', {idToken: tok, role: me.role, shop: LS.get('dk:fbshop') || '', phone: me.phone, name: me.name}); }).then(function (r) {
      var was = canWrite();
      LS.set('dk:fbrelay', r.relay); LS.set('dk:lic', JSON.stringify(r.lic));
      if (was !== canWrite()) { setTimeout(function () { location.reload(); }, 300); return r; }   // the trial ended (or got turned on): open again in the right mode
      var s = C.getSess(); if (s && s.fb) { s.token = r.relay; s.desk = {token: r.relay, shop: 'fb:' + cfg.projectId, phone: me.uid, name: LS.get('dk:fbshop') || ''}; C.setSess(s); C.desktopSession(); }
      licPaint(); return r;
    }).catch(function (e) { if (e && e.status === 403) { relogin('حسابك موقوف. راجع صاحب المحل'); } return null; });
  }
  function checkStillMember() {
    if (!auth || !auth.currentUser) return;
    memberDoc(auth.currentUser.uid).then(function (m) {
      if (!m || !m.active) { var s = C.getSess(); if (cloud) cloud.dead = true; relogin(!m ? 'صاحب المحل شالك من المحل' : 'حسابك موقوف. راجع صاحب المحل'); }
    }).catch(function () {});
  }
  // the owner changed what this person may do: drop what may no longer be seen and reload
  function watchMe() {
    if (!auth.currentUser) return;
    try { watchMe2(); } catch (e) { setTimeout(checkStillMember, 5000); }
  }
  function watchMe2() {
    fs.collection('dk_members').doc(auth.currentUser.uid).onSnapshot(function (d) {
      if (!d.exists || !d.data().active) { checkStillMember(); return; }
      var m = d.data(); m.uid = d.id;
      var before = JSON.stringify(me && me.perms || {}), now = JSON.stringify(m.perms || {});
      me = m;
      var s = C.getSess(); if (s) { var ns = sessOf(m, s.shop.name); ns.token = s.token; ns.desk = s.desk; C.setSess(ns); }
      if (m.role !== 'owner' && before !== now && cloud) {
        say('صاحب المحل غيّر صلاحياتك — جاري التحديث');
        var st = cloud.d.transaction(['docs', 'meta'], 'readwrite');
        Object.keys(cloud.cols).forEach(function (c) { cloud.col(c).forEach(function (x, i) { st.objectStore('docs').delete(C.KEY(c, i)); }); });
        st.objectStore('meta').put({}, 'fbcur');
        st.oncomplete = function () { setTimeout(function () { location.reload(); }, 700); };
      }
    }, function () {});
  }
  function loadNames() {
    return fs.collection('dk_names').get().then(function (snap) { var o = {}; snap.forEach(function (d) { o[d.id] = d.data(); }); names = o; LS.set('dk:fbnames', JSON.stringify(o)); return o; }).catch(function () { return names; });
  }
  // what cloud.js asks about people (same answers our server gave)
  var T = {
    members: function () {
      if (me.role !== 'owner') return loadNames().then(function (o) { return Object.keys(o).map(function (u) { return {phone: o[u].phone, name: o[u].name, role: o[u].role}; }); });
      return fs.collection('dk_members').get().then(function (snap) { var L = []; snap.forEach(function (d) { var m = d.data(); L.push({uid: d.id, phone: m.phone, name: m.name, role: m.role, active: !!m.active, perms: m.role === 'owner' ? ALL : Object.assign({}, PERMS, m.perms || {}), salary: m.salary || 0, createdAt: m.createdAt || 0}); }); L.sort(function (a, b) { return (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0) || a.createdAt - b.createdAt; }); C.call('/fb/lic?people=' + L.length).catch(function () {}); return L; });
    },
    add: function (o) {
      var phone = normPhone(o.phone), name = String(o.name || '').trim().slice(0, 80), pass = String(o.password || '');
      if (!okPhone(phone)) return Promise.reject(new Error('رقم الهاتف لازم 11 رقم ويبدأ بـ 07'));
      if (name.length < 2) return Promise.reject(new Error('اكتب اسم العامل'));
      if (pass.length < 6) return Promise.reject(new Error('كلمة السر لازم 6 حروف أو أكثر'));
      return fs.collection('dk_logins').doc(phone).get().then(function (d) {
        if (d.exists) throw new Error('هذا الرقم مضاف من قبل');
        return makeAccount(phone, pass, 0);
      }).then(function (a) {
        var b = fs.batch();
        b.set(fs.collection('dk_members').doc(a.uid), {phone: phone, name: name, role: 'worker', perms: PERMS, active: true, salary: 0, createdAt: Date.now()});
        b.set(fs.collection('dk_logins').doc(phone), {e: a.email, uid: a.uid, k: a.k});
        b.set(fs.collection('dk_names').doc(a.uid), {name: name, phone: phone, role: 'worker', perms: PERMS});
        return b.commit().then(function () { C.call('/fb/block', {uid: a.uid, blocked: false}).catch(function () {}); loadNames(); return {phone: phone, name: name}; });
      }).catch(function (e) { throw e.code ? fbErr(e) : e; });
    },
    set: function (phone, patch) {
      phone = normPhone(phone);
      return findByPhone(phone).then(function (m) {
        if (!m) throw new Error('ما لگيت هذا الشخص');
        if (patch.password != null) return newPassword(m, String(patch.password));
        var up = {};
        if (patch.active != null) { if (m.role === 'owner') throw new Error('ما تگدر توقف صاحب المحل'); up.active = !!patch.active; }
        if (patch.perms && m.role !== 'owner') { var cur = Object.assign({}, PERMS, m.perms || {}); Object.keys(PERMS).forEach(function (k) { if (typeof patch.perms[k] === 'boolean') cur[k] = patch.perms[k]; }); up.perms = cur; }
        if (patch.salary != null) up.salary = Math.max(0, Math.min(1e9, Math.round(+patch.salary || 0)));
        if (patch.name != null && String(patch.name).trim().length >= 2) up.name = String(patch.name).trim().slice(0, 80);
        var b = fs.batch(); b.update(fs.collection('dk_members').doc(m.uid), up);
        if (up.name || up.perms) b.set(fs.collection('dk_names').doc(m.uid), Object.assign({name: m.name, phone: m.phone, role: m.role}, up.name ? {name: up.name} : {}, up.perms ? {perms: up.perms} : {}), {merge: true});
        return b.commit().then(function () {
          if (patch.active != null) C.call('/fb/block', {uid: m.uid, blocked: !patch.active}).catch(function () {});
          loadNames(); return Object.assign({}, m, up);
        });
      }).catch(function (e) { throw e.code ? fbErr(e) : e; });
    },
    remove: function (phone) {
      phone = normPhone(phone);
      return findByPhone(phone).then(function (m) {
        if (!m) return true;
        if (m.role === 'owner') throw new Error('ما تگدر تحذف صاحب المحل');
        var b = fs.batch(); b.delete(fs.collection('dk_members').doc(m.uid)); b.delete(fs.collection('dk_logins').doc(phone)); b.delete(fs.collection('dk_names').doc(m.uid));
        return b.commit().then(function () { C.call('/fb/block', {uid: m.uid, blocked: true}).catch(function () {}); loadNames(); return true; });
      }).catch(function (e) { throw e.code ? fbErr(e) : e; });
    },
    salary: function (phone) {
      var p = phone ? findByPhone(normPhone(phone)) : Promise.resolve(me);
      return p.then(function (m) {
        if (!m) throw new Error('ما لگيت هذا الشخص');
        return Promise.all([m.uid === me.uid ? memberDoc(m.uid) : Promise.resolve(m), fs.collection('dk_sal').doc(m.uid).get().catch(function () { return null; })]).then(function (r) {
          var pays = r[1] && r[1].exists ? (r[1].data().pays || []) : [];
          return {salary: (r[0] && r[0].salary) || 0, pays: pays.slice().sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); }).slice(0, 36)};
        });
      });
    },
    paid: function (phone, rec) { return findByPhone(normPhone(phone)).then(function (m) { if (!m) return; return fs.collection('dk_sal').doc(m.uid).set({pays: FV.arrayUnion(Object.assign({t: Date.now()}, rec))}, {merge: true}); }); },
    me: function () { return memberDoc(auth.currentUser.uid).then(function (m) { if (!m) { var e = new Error('صاحب المحل شالك من المحل'); e.status = 403; throw e; } return {user: sessOf(m).user, shop: {id: 'fb-' + cfg.projectId, name: LS.get('dk:fbshop') || ''}}; }); }
  };
  function findByPhone(phone) { return fs.collection('dk_logins').doc(phone).get().then(function (d) { if (!d.exists) return null; return memberDoc(d.data().uid); }); }
  // a new login made by the owner, without logging the owner out (a second, temporary connection)
  function makeAccount(phone, pass, k0) {
    var tmp = firebase.initializeApp(cfg, 'dk-tmp-' + Date.now()), ta = tmp.auth();
    var attempt = function (k) {
      return ta.createUserWithEmailAndPassword(emailOf(phone, k), pass).then(function (cr) { return {uid: cr.user.uid, email: emailOf(phone, k), k: k}; }, function (e) {
        if (e && e.code === 'auth/email-already-in-use' && k < k0 + 20) return attempt(k + 1);
        throw e;
      });
    };
    return attempt(k0).finally(function () { ta.signOut().catch(function () {}).then(function () { return tmp.delete(); }).catch(function () {}); });
  }
  // a worker's new password: a new login for him (the old one stops working at once)
  function newPassword(m, pass) {
    if (pass.length < 6) return Promise.reject(new Error('كلمة السر لازم 6 حروف أو أكثر'));
    if (m.uid === me.uid) return ownPassword(pass);
    return fs.collection('dk_logins').doc(m.phone).get().then(function (d) {
      var k = d.exists ? (+d.data().k || 0) + 1 : 1;
      return makeAccount(m.phone, pass, k);
    }).then(function (a) {
      var data = {phone: m.phone, name: m.name, role: 'worker', perms: Object.assign({}, PERMS, m.perms || {}), active: m.active !== false, salary: m.salary || 0, createdAt: m.createdAt || Date.now()};
      var b = fs.batch();
      b.set(fs.collection('dk_members').doc(a.uid), data);
      b.delete(fs.collection('dk_members').doc(m.uid));
      b.set(fs.collection('dk_logins').doc(m.phone), {e: a.email, uid: a.uid, k: a.k});
      b.set(fs.collection('dk_names').doc(a.uid), {name: m.name, phone: m.phone, role: 'worker', perms: data.perms});
      b.delete(fs.collection('dk_names').doc(m.uid));
      var sal = fs.collection('dk_sal').doc(m.uid);
      return sal.get().then(function (s) { if (s.exists) b.set(fs.collection('dk_sal').doc(a.uid), s.data()); return b.commit(); }).then(function () {
        C.call('/fb/block', {uid: m.uid, blocked: true}).catch(function () {});
        if (!data.active) C.call('/fb/block', {uid: a.uid, blocked: true}).catch(function () {});
        loadNames(); return {phone: m.phone};
      });
    });
  }
  function ownPassword(pass) {
    var u = auth.currentUser;
    return u.updatePassword(pass).catch(function (e) {
      if (!e || e.code !== 'auth/requires-recent-login') throw e;
      var cur = prompt('لأمانك اكتب كلمة السر الحالية:'); if (!cur) throw new Error('ما تغيّرت');
      return u.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(u.email, cur)).then(function () { return u.updatePassword(pass); });
    }).then(function () { return {phone: me.phone}; });
  }

  /* ---------- free trial / activation ---------- */
  function lic() { try { return JSON.parse(LS.get('dk:lic') || 'null'); } catch (e) { return null; } }
  function licState() {
    var l = lic(); if (!l) return 'trial';
    if (l.state === 'active') return 'active';
    if (l.state === 'stopped') return 'stopped';
    if (l.state === 'expired' || (l.trialEnd && Date.now() > l.trialEnd)) return 'expired';
    return 'trial';
  }
  function canWrite() { var s = licState(); return s === 'active' || s === 'trial'; }
  function support() { var l = lic(); return (l && l.support) || LS.get('dk:support') || ''; }
  function supportBtn(label) {
    var s = support(), href = '';
    if (/^\+?[\d\s-]{8,}$/.test(s)) { var d = normPhone(s); href = 'https://wa.me/' + (d.indexOf('0') === 0 ? '964' + d.slice(1) : d.replace(/\D/g, '')); }
    else if (/^https?:\/\//.test(s)) href = s;
    return href ? '<a class="dkf-sup" href="' + esc(href) + '" target="_blank" rel="noopener">💬 ' + esc(label || 'تواصل ويا خدمة العملاء') + '</a>' : '<span class="dkf-sup off">💬 رقم خدمة العملاء راح ينضاف قريباً</span>';
  }
  function licPaint() {
    var s = licState(), l = lic() || {}, bar = document.getElementById('dkLic');
    var show = s === 'expired' || s === 'stopped' || (s === 'trial' && l.days != null && l.days <= 7);
    if (!show) { if (bar) bar.remove(); return; }
    if (!bar) { bar = document.createElement('div'); bar.id = 'dkLic'; document.body.appendChild(bar); }
    var txt = s === 'stopped' ? 'حساب محلك موقوف من صاحب التطبيق. بياناتك محفوظة وتگدر تشوفها.' : s === 'expired' ? 'انتهت التجربة المجانية. بياناتك محفوظة وتگدر تشوفها وتطلعها، بس البيع واقف لحد التفعيل.' : 'باقي ' + l.days + ' يوم من التجربة المجانية.';
    bar.className = s === 'trial' ? 'soft' : '';
    bar.innerHTML = '<b>' + esc(txt) + '</b><div><button type="button" id="dkLicCode">عندي كود تفعيل</button>' + supportBtn('تواصل حتى تفعّل') + (s === 'trial' ? '<button type="button" id="dkLicX" class="x">×</button>' : '') + '</div>';
    bar.querySelector('#dkLicCode').onclick = activateDialog;
    var x = bar.querySelector('#dkLicX'); if (x) x.onclick = function () { bar.remove(); };
  }
  function activateDialog() {
    var code = prompt('اكتب كود التفعيل (مثل DK-ABCD-2345):'); if (!code) return;
    C.call('/fb/activate', {code: code}).then(function (l) { LS.set('dk:lic', JSON.stringify(l)); say('انفعل التطبيق ✓ شكراً إلك'); setTimeout(function () { location.reload(); }, 900); }, function (e) { say(e.message, false); });
  }
  function licRefresh() { if (!navigator.onLine || !C.getSess() || !C.getSess().token) return; C.call('/fb/lic').then(function (l) { var was = canWrite(); LS.set('dk:lic', JSON.stringify(l)); licPaint(); if (was !== canWrite()) location.reload(); }).catch(function () {}); }

  /* ---------- checking the lock: is the database closed, and with OUR rules? ---------- */
  function checkLock() {
    var g = function (id) { return fs.collection('dk_ping').doc(id).get().then(function () { return 'ok'; }, function (e) { return e && e.code === 'permission-denied' ? 'no' : 'err'; }); };
    return Promise.all([g(RULES_VER), g('zz-open-check'), fs.collection('c_products').limit(1).get().then(function () { return 'ok'; }, function (e) { return e && e.code === 'permission-denied' ? 'no' : 'err'; })]).then(function (r) {
      if (r[0] === 'err' || r[1] === 'err') return 'net';
      if (r[1] === 'ok') return 'open';           // something answers that should be closed: the database is OPEN
      if (r[0] === 'no') return 'notours';        // closed, but not with our rules (or an old copy of them)
      return auth && auth.currentUser ? 'ok' : (r[2] === 'no' ? 'ok' : 'open');
    });
  }
  function lockWatch() {
    if (!me || me.role !== 'owner') return;
    checkLock().then(function (st) {
      if (st === 'open') note('🔴 قاعدة بيانات محلك مفتوحة!', 'أي أحد يگدر يشوف ويمسح بياناتك. افتح «دليل Firebase» من الإعدادات والصق قواعد القفل هسه.', '<button type="button" class="y" onclick="window.DKFire.guide()">افتح الدليل</button>');
      else if (st === 'notours') note('⚠️ لازم تحدّث قواعد القفل', 'افتح «دليل Firebase» من الإعدادات، انسخ القواعد الجديدة والصقها بـ Firebase.', '<button type="button" class="y" onclick="window.DKFire.guide()">افتح الدليل</button>');
    });
  }

  /* ---------- the words: warnings, steps, and questions to ask an AI ---------- */
  var QUESTIONS = [
    'شنو هو Firebase؟ وشنو فكرته ببساطة؟',
    'شنو الفرق بين Firestore و Authentication بـ Firebase؟',
    'شلون أسوي حساب ومشروع جديد بـ Firebase خطوة بخطوة؟',
    'شلون أشغّل Firestore وتسجيل الدخول بالإيميل وكلمة السر (Email/Password)؟',
    'شنو هي «قواعد الأمان» (Security Rules) بـ Firestore؟ وليش لازم تكون مقفولة؟',
    'شلون ألصق قواعد أمان جاهزة وأنشرها (Publish)؟ وشلون أتأكد إنها اشتغلت؟',
    'شنو أخطر غلط ممكن أسويه بـ Firebase؟ وشلون أتجنبه؟',
    'شنو الحدود المجانية بخطة Spark؟ وشلون أراقب استهلاكي قبل ما أوصلها؟',
    'شلون أربط تطبيق موقع ويب بمشروع Firebase مالتي (firebaseConfig)؟',
    'شلون أضيف عمال بحسابات منفصلة، وكل واحد بصلاحيات محددة؟',
    'شلون أحمي حساب Google مالي بالتحقق بخطوتين؟ وليش هذا مهم؟'
  ];
  function questionsText() { return 'عندي تطبيق محل اسمه «دكّان» يحفظ بياناته بـ Firebase مالتي. جاوبني بالعربي وبكلمات بسيطة، سؤال سؤال:\n\n' + QUESTIONS.map(function (q, n) { return (n + 1) + '. ' + q; }).join('\n'); }
  function copy(text, okMsg) { (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { say(okMsg || 'انتسخ ✓'); }, function () { var t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); say(okMsg || 'انتسخ ✓'); } catch (e) { say('ما گدرت أنسخ، حدده وانسخه بيدك', false); } t.remove(); }); }
  var WARN = '<div class="dkf-warn"><b>⚠️ اقرا هذا قبل ما تكمل</b><ul>'
    + '<li>بيانات محلك (الفواتير، الزبائن، الديون) راح تنحفظ بحساب <b>Firebase مالتك</b> من Google. إنت صاحبه، وإنت المسؤول عنه.</li>'
    + '<li>لازم <b>تقفل</b> قاعدة البيانات بالقواعد اللي ننطيك ياها. إذا تركتها مفتوحة، أي أحد بالإنترنت يگدر يشوف بياناتك ويمسحها.</li>'
    + '<li><b>لا تغيّر القواعد أبداً</b>، ولا تفتحها «للتجربة» (test mode)، حتى لو أحد گلك سويها.</li>'
    + '<li>فعّل <b>التحقق بخطوتين</b> على حساب Google مالتك. اللي يسرق حساب Google يوصل لكل بياناتك.</li>'
    + '<li>الخطة المجانية إلها حد يومي (تقريباً 20 ألف حفظ و50 ألف قراءة باليوم). إذا كبر شغلك، تگدر تحوّل لخطة Blaze وتدفع لـ Google حسب استهلاكك.</li>'
    + '<li>إذا ما فهمت أي خطوة: <b>لا تكمل</b>. تواصل ويانا، أو اسأل الذكاء الاصطناعي (ChatGPT أو Claude) الأسئلة اللي تحت، <b>سؤال سؤال</b>، ولا تنتقل للي بعده قبل ما تفهم الجواب.</li>'
    + '</ul></div>';
  function questionsHTML() { return '<details class="dkf-q"><summary>🤖 أسئلة جاهزة للذكاء الاصطناعي</summary><ol>' + QUESTIONS.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ol><button type="button" class="dkf-b2" data-copyq>انسخ الأسئلة كلها</button></details>'; }
  function stepsHTML() {
    return '<ol class="dkf-steps">'
      + '<li>افتح <a href="https://console.firebase.google.com" target="_blank" rel="noopener">console.firebase.google.com</a> وسجّل دخول بحساب Google مالتك.</li>'
      + '<li>اضغط <b>Create a project</b> (إنشاء مشروع)، واكتب اسم محلك. Google Analytics مو ضروري، تگدر تطفيه.</li>'
      + '<li>من القائمة: <b>Build ← Firestore Database ← Create database</b>. اختار المكان الأقرب إلك (مثلاً europe-west)، واختار <b>Production mode</b> (يعني مقفول).</li>'
      + '<li>من القائمة: <b>Build ← Authentication ← Get started</b>. اختار <b>Email/Password</b>، فعّل أول خيار (Enable)، واضغط <b>Save</b>.</li>'
      + '<li>ارجع للصفحة الرئيسية للمشروع (⚙️ Project settings)، وانزل لـ «Your apps». اضغط أيقونة الويب <b>&lt;/&gt;</b>، سمّيه «دكان»، واضغط <b>Register app</b>.</li>'
      + '<li>راح يطلعلك كود بيه <b>firebaseConfig</b>. انسخه كله والصقه بالخانة اللي تحت.</li>'
      + '</ol>';
  }
  function rulesHTML() {
    return '<ol class="dkf-steps"><li>بـ Firebase روح لـ <b>Firestore Database ← Rules</b> (القواعد).</li><li>امسح كل المكتوب هناك، والصق القواعد هذي مثل ما هي:</li></ol>'
      + '<textarea class="dkf-rules" readonly dir="ltr">' + esc(RULES) + '</textarea><button type="button" class="dkf-b2" data-copyr>📋 انسخ القواعد</button>'
      + '<ol class="dkf-steps" start="3"><li>اضغط <b>Publish</b> (نشر)، وانتظر دقيقة.</li><li>ارجع هنا واضغط «تأكد من القفل».</li></ol>';
  }

  /* ---------- screens ---------- */
  var CSS = '.dkf-card{max-width:560px!important;flex-basis:560px!important}.dkf-card h3{font-size:19px;margin:0 0 6px}.dkf-card p{font-size:15px;line-height:1.8;color:#334155;margin:6px 0}'
    + '.dkf-warn{background:#FFF7ED;border:1.5px solid #FDBA74;border-radius:16px;padding:12px 14px;margin:10px 0;font-size:14.5px;line-height:1.85;color:#7C2D12}.dkf-warn ul{margin:6px 0 0;padding-inline-start:20px}.dkf-warn li{margin:4px 0}'
    + '.dkf-steps{font-size:14.5px;line-height:1.9;color:#1E293B;padding-inline-start:22px;margin:8px 0}.dkf-steps li{margin:5px 0}.dkf-steps a{color:#4338CA;font-weight:700}'
    + '.dkf-q{background:#EEF2FF;border-radius:14px;padding:8px 12px;margin:10px 0}.dkf-q summary{cursor:pointer;font-weight:700;color:#3730A3;font-size:14.5px;padding:4px 0}.dkf-q ol{font-size:14px;line-height:1.8;padding-inline-start:22px;margin:6px 0}'
    + '.dkf-b2{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 14px;border:0;border-radius:12px;background:#EEF2FF;color:#3730A3;font:inherit;font-size:14px;font-weight:700;cursor:pointer;margin:4px 0}'
    + '.dkf-sup{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 14px;border-radius:12px;background:#ECFDF5;color:#047857;font-weight:700;font-size:14px;text-decoration:none;margin:4px 0}.dkf-sup.off{background:#F1F5F9;color:#64748B}'
    + '.dkf-rules{width:100%;height:150px;font:12px/1.5 ui-monospace,monospace;border:1.5px solid #E2E8F0;border-radius:12px;padding:8px;background:#F8FAFC;color:#0F172A;box-sizing:border-box}'
    + '.dkf-ta{width:100%;min-height:110px;font:13px/1.5 ui-monospace,monospace;border:1.5px solid #E2E8F0;border-radius:12px;padding:10px;box-sizing:border-box;direction:ltr}'
    + '.dkf-ok{background:#ECFDF5;color:#065F46;border-radius:12px;padding:10px 12px;font-weight:700;font-size:14.5px;margin:8px 0;line-height:1.7}.dkf-bad{background:#FFF1F2;color:#9F1239;border-radius:12px;padding:10px 12px;font-weight:700;font-size:14.5px;margin:8px 0;line-height:1.7}'
    + '.dkf-chk{display:flex;gap:10px;align-items:flex-start;font-size:15px;font-weight:600;margin:12px 0;line-height:1.6}.dkf-chk input{width:22px;height:22px;flex:none;accent-color:#4338CA;margin-top:2px}'
    + '.dkf-nav{display:flex;gap:8px;margin-top:14px}.dkf-nav .go{margin-top:0!important}.dkf-nav .back{flex:0 0 auto;min-height:54px;padding:0 16px;border:0;border-radius:16px;background:#F1F5F9;color:#334155;font:inherit;font-weight:700;cursor:pointer}'
    + '.dkf-dots{display:flex;gap:6px;justify-content:center;margin:0 0 12px}.dkf-dots i{width:8px;height:8px;border-radius:50%;background:#E2E8F0}.dkf-dots i.on{background:#4338CA;width:22px;border-radius:5px}'
    + '.dkf-choice{display:grid;gap:10px;margin-top:6px}.dkf-choice button{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:start;padding:14px;border:1.5px solid #E2E8F0;border-radius:16px;background:#fff;font:inherit;cursor:pointer}.dkf-choice button b{font-size:16px;color:#0F172A}.dkf-choice button span{font-size:13.5px;color:#64748B;line-height:1.6}.dkf-choice button.main{border-color:#818CF8;background:#EEF2FF}'
    + '#dkLic{position:fixed;z-index:250;left:10px;right:10px;bottom:calc(76px + env(safe-area-inset-bottom));background:#FFF1F2;border:1.5px solid #FDA4AF;color:#881337;border-radius:16px;padding:10px 12px;box-shadow:0 14px 30px -14px rgba(0,0,0,.35);font-size:14px;line-height:1.7}#dkLic.soft{background:#FFFBEB;border-color:#FCD34D;color:#78350F}#dkLic div{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;align-items:center}#dkLic button{min-height:40px;border:0;border-radius:11px;padding:0 12px;background:#fff;color:#3730A3;font:inherit;font-weight:700;cursor:pointer}#dkLic .x{margin-inline-start:auto;background:none;font-size:20px;color:#94A3B8}@media(min-width:800px){#dkLic{left:auto;width:420px;bottom:16px}}';
  var cssOn = false;
  function screen(html, opts) {
    if (!cssOn) { var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); cssOn = true; }
    var o = C.overlay(html); o.querySelector('.c').classList.add('dkf-card');
    o.querySelectorAll('[data-copyq]').forEach(function (b) { b.onclick = function () { copy(questionsText(), 'انتسخت الأسئلة ✓ الصقها عند الذكاء الاصطناعي'); }; });
    o.querySelectorAll('[data-copyr]').forEach(function (b) { b.onclick = function () { copy(RULES, 'انتسخت القواعد ✓ الصقها بـ Firebase'); }; });
    o.scrollTop = 0;
    return o;
  }
  var HEAD = function (sub) { return '<div class="h"><img src="icons/icon-192.png" alt=""><div><b>دكّان</b><span>' + esc(sub) + '</span></div></div>'; };
  var dots = function (n, of) { var s = '<div class="dkf-dots">'; for (var i = 1; i <= of; i++) s += '<i class="' + (i === n ? 'on' : '') + '"></i>'; return s + '</div>'; };

  // the first screen on a new device
  function welcome() {
    var o = screen(HEAD('أهلاً بيك') + '<p>شلون تريد تبدي؟</p><div class="dkf-choice">'
      + '<button type="button" class="main" id="fW1"><b>🏪 محل جديد</b><span>تربط محلك بـ Firebase مالتك (من Google). بياناتك عندك إنت.</span></button>'
      + '<button type="button" id="fW2"><b>🔗 عندي رابط من صاحب المحل</b><span>إذا إنت عامل، أو هذا جهاز ثاني لنفس المحل.</span></button>'
      + '<button type="button" id="fW3"><b>🔑 عندي حساب دكّان القديم</b><span>إذا صاحب التطبيق سوالك حساب قبل.</span></button>'
      + '<button type="button" id="fW4"><b>👀 جرّب بس على هذا الجهاز</b><span>بدون حساب. تگدر تربط بعدين وترفع بياناتك.</span></button>'
      + '</div><div class="n">' + supportBtn() + '</div>');
    o.querySelector('#fW1').onclick = function () { setup({}); };
    o.querySelector('#fW2').onclick = pasteLink;
    o.querySelector('#fW3').onclick = function () { C.showLogin(); };
    o.querySelector('#fW4').onclick = function () { LS.set('dk:mode', 'local'); o.remove(); C.startLocal(); };
  }
  function pasteLink() {
    var o = screen(HEAD('ربط جهاز بمحل') + '<p>صاحب المحل يلگى «رابط ربط الأجهزة» بالإعدادات. يرسله إلك، وإنت تفتحه أو تلصقه هنا:</p><textarea class="dkf-ta" id="fL" placeholder="https://.../app/#fb=..."></textarea><div class="er" id="fLe"></div><div class="dkf-nav"><button type="button" class="back" id="fLb">رجوع</button><button type="button" class="go" id="fLg">التالي</button></div>');
    o.querySelector('#fLb').onclick = welcome;
    o.querySelector('#fLg').onclick = function () { var c = parseCfg(o.querySelector('#fL').value); if (!c) { o.querySelector('#fLe').textContent = 'هذا الرابط مو صحيح. اطلب من صاحب المحل يرسله مرة ثانية'; return; } LS.set('dk:fb', JSON.stringify(c)); login(); };
  }
  // the setup for a new shop: 1 warnings → 2 make the project → 3 lock it → 4 the owner's account
  function setup(opt) {
    opt = opt || {};
    var o = screen(HEAD(opt.migrate ? 'انقل محلك لـ Firebase مالتك' : 'ربط محل جديد') + dots(1, 4) + '<h3>قبل كل شي</h3>' + WARN + questionsHTML() + '<div>' + supportBtn() + '</div>'
      + '<label class="dkf-chk"><input type="checkbox" id="fS1c"> قريت كل التحذيرات وفهمتها</label><div class="dkf-nav"><button type="button" class="back" id="fS1b">رجوع</button><button type="button" class="go" id="fS1g" disabled>التالي</button></div>');
    var cb = o.querySelector('#fS1c'), g = o.querySelector('#fS1g');
    cb.onchange = function () { g.disabled = !cb.checked; };
    o.querySelector('#fS1b').onclick = function () { if (opt.migrate) o.remove(); else welcome(); };
    g.onclick = function () { step2(opt); };
  }
  function step2(opt) {
    var o = screen(HEAD('ربط محل جديد') + dots(2, 4) + '<h3>سوّي مشروع Firebase</h3>' + stepsHTML() + questionsHTML()
      + '<textarea class="dkf-ta" id="fC" placeholder="const firebaseConfig = {\n  apiKey: &quot;...&quot;,\n  projectId: &quot;...&quot;,\n  ...\n};"></textarea><div class="er" id="fCe"></div>'
      + '<div class="dkf-nav"><button type="button" class="back" id="fCb">رجوع</button><button type="button" class="go" id="fCg">التالي</button></div>');
    var saved = loadCfg(); if (saved) o.querySelector('#fC').value = JSON.stringify(saved, null, 2);
    o.querySelector('#fCb').onclick = function () { setup(opt); };
    o.querySelector('#fCg').onclick = function () {
      var c = parseCfg(o.querySelector('#fC').value), e = o.querySelector('#fCe');
      if (!c) { e.textContent = 'ما لگيت apiKey و projectId بالكود. انسخ كود firebaseConfig كله مرة ثانية'; return; }
      var b = this; b.disabled = true; b.textContent = 'جاري الفحص...';
      open(c).then(function () { LS.set('dk:fb', JSON.stringify(c)); step3(opt); }, function (er) { e.textContent = er.message; b.disabled = false; b.textContent = 'التالي'; });
    };
  }
  function step3(opt) {
    var o = screen(HEAD('ربط محل جديد') + dots(3, 4) + '<h3>اقفل قاعدة البيانات 🔒</h3><p>هاي أهم خطوة. القواعد تخلي كل واحد يشوف بس اللي إله، والعامل ما يشوف الفلوس، وما أحد غريب يوصل لبياناتك.</p>' + rulesHTML()
      + '<div id="fRr"></div><button type="button" class="dkf-b2" id="fRc" style="width:100%;min-height:50px">🔎 تأكد من القفل</button>'
      + '<div class="dkf-nav"><button type="button" class="back" id="fRb">رجوع</button><button type="button" class="go" id="fRg" disabled>التالي</button></div>');
    var res = o.querySelector('#fRr'), g = o.querySelector('#fRg');
    o.querySelector('#fRb').onclick = function () { step2(opt); };
    o.querySelector('#fRc').onclick = function () {
      var b = this; b.disabled = true; b.textContent = 'جاري الفحص...';
      checkLock().then(function (st) {
        res.innerHTML = st === 'ok' ? '<div class="dkf-ok">✅ ممتاز! قاعدة البيانات مقفولة بقواعد دكّان.</div>'
          : st === 'open' ? '<div class="dkf-bad">🔴 قاعدة البيانات مفتوحة! أي أحد يگدر يوصلها. الصق القواعد واضغط Publish، وبعدين جرّب مرة ثانية.</div>'
          : st === 'notours' ? '<div class="dkf-bad">⚠️ القاعدة مقفولة بس مو بقواعد دكّان (يمكن ما انلصقت، أو ما ضغطت Publish، أو بعدها ما اشتغلت). انتظر دقيقة وجرّب مرة ثانية.</div>'
          : '<div class="dkf-bad">ما گدرت أوصل لـ Firebase. تأكد من النت، وإنك سويت Firestore Database، وجرّب مرة ثانية.</div>';
        g.disabled = st !== 'ok';
      }).finally(function () { b.disabled = false; b.textContent = '🔎 تأكد من القفل'; });
    };
    g.onclick = function () { step4(opt); };
  }
  function step4(opt) {
    var s0 = opt.migrate && C.getSess() ? C.getSess() : null;
    var o = screen(HEAD('ربط محل جديد') + dots(4, 4) + '<h3>حساب صاحب المحل</h3><p>تدخل بيه برقمك وكلمة السر من أي جهاز.</p>'
      + '<form id="fA" novalidate><label>اسم المحل</label><div class="f"><input id="fAs" value="' + esc(s0 ? s0.shop.name : '') + '"></div>'
      + '<label>اسمك</label><div class="f"><input id="fAn" value="' + esc(s0 ? s0.user.name : '') + '"></div>'
      + '<label>رقم تلفونك</label><div class="f"><input id="fAp" class="l" type="tel" inputmode="tel" placeholder="07xxxxxxxxx" value="' + esc(s0 ? s0.user.phone : '') + '"></div>'
      + '<label>كلمة السر (6 حروف أو أكثر)</label><div class="f"><input id="fAw" type="password" autocomplete="new-password"></div>'
      + '<label>إيميلك (مهم: حتى ترجّع كلمة السر إذا نسيتها)</label><div class="f"><input id="fAe" class="l" type="email" inputmode="email" placeholder="name@gmail.com"></div>'
      + '<div class="er" id="fAr"></div><div class="dkf-nav"><button type="button" class="back" id="fAb">رجوع</button><button class="go" id="fAg">سوّي الحساب</button></div></form>'
      + (opt.migrate ? '<div class="n">بعد ما يتسوى الحساب، أنقل كل بيانات محلك لـ Firebase. العمال تضيفهم من جديد من الإعدادات.</div>' : ''));
    o.querySelector('#fAb').onclick = function () { step3(opt); };
    o.querySelector('#fA').onsubmit = function (ev) {
      ev.preventDefault();
      var shop = o.querySelector('#fAs').value.trim(), name = o.querySelector('#fAn').value.trim(), phone = normPhone(o.querySelector('#fAp').value), pass = o.querySelector('#fAw').value, email = o.querySelector('#fAe').value.trim(), r = o.querySelector('#fAr'), g = o.querySelector('#fAg');
      if (shop.length < 2) { r.textContent = 'اكتب اسم المحل'; return; }
      if (name.length < 2) { r.textContent = 'اكتب اسمك'; return; }
      if (!okPhone(phone)) { r.textContent = 'رقم الهاتف لازم 11 رقم ويبدأ بـ 07'; return; }
      if (pass.length < 6) { r.textContent = 'كلمة السر لازم 6 حروف أو أكثر'; return; }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { r.textContent = 'الإيميل مو صحيح'; return; }
      g.disabled = true; g.textContent = 'جاري التسوية...'; r.textContent = '';
      createOwner(shop, name, phone, pass, email).then(function () {
        return opt.migrate ? migrate(o) : null;
      }).then(function () { done(o, opt); }).catch(function (e) { r.textContent = (e.code ? fbErr(e) : e).message; g.disabled = false; g.textContent = 'سوّي الحساب'; });
    };
  }
  function createOwner(shop, name, phone, pass, email) {
    var uid;
    return fs.collection('dk_logins').doc(phone).get().then(function (d) {
      if (d.exists) throw new Error('هذا الرقم مسجل بهذا المحل من قبل. ارجع وسجّل دخول');
      return auth.createUserWithEmailAndPassword(email || emailOf(phone, 0), pass).catch(function (e) {
        if (e && e.code === 'auth/email-already-in-use') return auth.signInWithEmailAndPassword(email || emailOf(phone, 0), pass);   // a second try after a cut-off first one
        throw e;
      });
    }).then(function (cr) {
      uid = cr.user.uid;
      var meta = fs.collection('dk_meta').doc('shop');
      return meta.get().then(function (m) {
        if (m.exists && m.data().owner !== uid) throw new Error('مشروع Firebase هذا مربوط بمحل ثاني. سوّي مشروع جديد لمحلك');
        if (!m.exists) return meta.set({name: shop, owner: uid, createdAt: Date.now(), v: 1});
      });
    }).then(function () { return fs.collection('dk_members').doc(uid).set({phone: phone, name: name, role: 'owner', perms: ALL, active: true, salary: 0, createdAt: Date.now()}); })
      .then(function () { return fs.collection('dk_logins').doc(phone).set({e: email || emailOf(phone, 0), uid: uid, k: 0}); })
      .then(function () { return fs.collection('dk_names').doc(uid).set({name: name, phone: phone, role: 'owner'}); })
      .then(function () { LS.set('dk:fbshop', shop); return afterSignIn(uid); });
  }
  function done(o, opt) {
    var link = joinLink();
    o = screen(HEAD('خلص!') + '<div class="dkf-ok">✅ محلك صار مربوط بـ Firebase مالتك.</div>'
      + '<p><b>🎁 عندك تجربة مجانية.</b> بعدها تفعّل التطبيق من خدمة العملاء.</p>'
      + '<p><b>🔗 رابط ربط الأجهزة:</b> أرسله لعمالك أو لجهازك الثاني. يفتحونه ويدخلون برقمهم وكلمة السر. تلگاه دائماً بالإعدادات.</p>'
      + '<button type="button" class="dkf-b2" id="fDl" style="width:100%">📋 انسخ رابط الربط</button>'
      + '<p style="font-size:13.5px;color:#64748B">الرابط مو كلمة سر: بدون رقم وكلمة سر محد يدخل. بس لا تنشره بمكان عام.</p>'
      + '<button type="button" class="go" id="fDg">ابدي الشغل</button>');
    o.querySelector('#fDl').onclick = function () { copy(link, 'انتسخ الرابط ✓'); };
    o.querySelector('#fDg').onclick = function () {
      if (opt.migrate) { LS.set('dk:fbsess', JSON.stringify({uid: me.uid})); LS.set('dk:fbme', JSON.stringify(me)); LS.del('dk:session'); location.reload(); return; }
      o.remove(); start();
    };
  }

  // a device of an existing shop: phone + password
  function login(msg, again) {
    var shopName = LS.get('dk:fbshop') || '';
    var o = screen(HEAD(shopName ? 'سجّل دخول — ' + shopName : 'سجّل دخول محلك')
      + (msg ? '<div class="er" style="margin:0 0 6px">' + esc(msg) + '</div>' : '')
      + '<form id="fI" novalidate><label for="fIp">رقم الهاتف</label><div class="f"><input id="fIp" class="l" type="tel" inputmode="tel" autocomplete="username" placeholder="07xxxxxxxxx" value="' + esc(LS.get('dk:lastPhone') || '') + '"></div>'
      + '<label for="fIw">كلمة السر</label><div class="f"><input id="fIw" type="password" autocomplete="current-password"><button type="button" class="eye" id="fIe">إظهار</button></div>'
      + '<div class="er" id="fIr"></div><button class="go" id="fIg">دخول</button></form>'
      + '<button class="lo" id="fIf">نسيت كلمة السر؟</button>' + (again ? '' : '<button class="lo" id="fIx">هذا الجهاز لمحل ثاني؟</button>')
      + '<div class="n">' + supportBtn() + '</div>');
    var p = o.querySelector('#fIp'), w = o.querySelector('#fIw'), r = o.querySelector('#fIr'), g = o.querySelector('#fIg');
    o.querySelector('#fIe').onclick = function () { var sh = w.type === 'password'; w.type = sh ? 'text' : 'password'; this.textContent = sh ? 'إخفاء' : 'إظهار'; };
    var x = o.querySelector('#fIx'); if (x) x.onclick = function () { LS.del('dk:fb'); LS.del('dk:fbshop'); LS.del('dk:fbsess'); LS.del('dk:fbme'); LS.del('dk:fbrelay'); LS.del('dk:lic'); welcome(); };
    o.querySelector('#fIf').onclick = function () { forgot(normPhone(p.value)); };
    setTimeout(function () { (p.value ? w : p).focus(); }, 50);
    o.querySelector('#fI').onsubmit = function (ev) {
      ev.preventDefault();
      var phone = normPhone(p.value);
      if (!okPhone(phone)) { r.textContent = 'رقم الهاتف لازم 11 رقم ويبدأ بـ 07'; return; }
      if (!w.value) { r.textContent = 'اكتب كلمة السر'; return; }
      if (navigator.onLine === false) { r.textContent = 'أول دخول يحتاج إنترنت. اتصل وجرّب'; return; }
      g.disabled = true; g.textContent = 'جاري الدخول...'; r.textContent = '';
      open(loadCfg()).then(function () { return signIn(phone, w.value); }).then(function () {
        LS.set('dk:lastPhone', phone);
        if (again && cloud) { o.remove(); cloud.dead = false; cloud.flush(); hello(); say('رجعت لحسابك ✓'); return; }
        if (again) { location.reload(); return; }
        o.remove(); start();
      }).catch(function (e) { r.textContent = (e.code ? fbErr(e) : e).message; g.disabled = false; g.textContent = 'دخول'; });
    };
  }
  function forgot(phone) {
    if (!okPhone(phone)) { say('اكتب رقمك أول، وبعدين اضغط نسيت كلمة السر', false); return; }
    open(loadCfg()).then(function () { return fs.collection('dk_logins').doc(phone).get(); }).then(function (d) {
      var e = d.exists ? d.data().e : '';
      if (e && e.indexOf('@' + DOMAIN) < 0) return auth.sendPasswordResetEmail(e).then(function () { say('انرسل رابط تغيير كلمة السر لإيميلك ✓'); });
      say(d.exists && e ? 'اطلب من صاحب المحل يسويلك كلمة سر جديدة (من الإعدادات ← العمال)' : 'هذا الرقم مو مسجل بالمحل', false);
    }).catch(function (e) { say(fbErr(e).message, false); });
  }
  function relogin(msg) { if (document.getElementById('dkIn')) return; login(msg || 'لازم تسجل دخول مرة ثانية. بياناتك محفوظة', true); }

  /* ---------- starting: the session, the app, the extras ---------- */
  function start() {
    // from here on this device is a Firebase shop: cloud.js asks us about the trial, logging in again, the settings box
    C.hooks.canWrite = canWrite;
    C.hooks.relogin = function (m) { relogin(m); };
    C.hooks.logout = logout;
    C.hooks.account = accountHTML;
    C.hooks.accountBind = accountBind;
    C.hooks.paid = function (phone, rec) { return T.paid(phone, rec); };
    var s = sessOf(me, LS.get('dk:fbshop'));
    LS.set('dk:fbsess', JSON.stringify({uid: me.uid})); LS.set('dk:fbme', JSON.stringify(me));
    C.setSess(s); C.setT(T);
    cloud = makeCloud(s);
    C.startCloud(cloud);
    hello();
    loadNames();
    watchMe();
    setTimeout(lockWatch, 8000);
    setInterval(function () { hello(); }, 12 * 3600000);
    setInterval(licRefresh, 3600000);
    licPaint();
  }
  // boot: called by cloud.js when this device belongs to a Firebase shop (or opened a join link)
  function boot(core) {
    C = core;
    var m = /#fb=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (m) { var c = parseCfg(location.hash); try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {} if (c) { var old = loadCfg(); if (!old || old.projectId !== c.projectId) { LS.set('dk:fb', JSON.stringify(c)); LS.del('dk:fbsess'); LS.del('dk:fbshop'); } } }
    cfg = loadCfg();
    if (!cfg) { welcome(); return; }
    var saved = null; try { saved = JSON.parse(LS.get('dk:fbsess') || 'null'); } catch (e) {}
    if (!saved) { login(); return; }
    // a device that was logged in: open straight from its own copy (works with no internet), Firebase catches up
    open(cfg).then(function () {
      return new Promise(function (ok) { var un = auth.onAuthStateChanged(function (u) { un(); ok(u); }); });
    }).then(function (u) {
      if (!u || u.uid !== saved.uid) { LS.del('dk:fbsess'); login('لازم تسجل دخول مرة ثانية'); return; }
      var cached = null; try { cached = JSON.parse(LS.get('dk:fbme') || 'null'); } catch (e) {}
      var go = function (mm) { me = mm; LS.set('dk:fbme', JSON.stringify(mm)); start(); };
      if (navigator.onLine === false && cached && cached.uid === u.uid) { go(cached); return; }
      withTimeout(afterSignIn(u.uid), 8000).then(go, function (e) {
        if (cached && cached.uid === u.uid && (!e || e.code === 'unavailable' || /timeout/.test(String(e && e.message)))) go(cached);
        else { LS.del('dk:fbsess'); login(e && e.message); }
      });
    }, function (e) { login(e.message); });
  }
  function logout() {
    try { if (window.dukkanDesktop && window.dukkanDesktop.session) window.dukkanDesktop.session(null); } catch (e) {}
    var s = C.getSess();
    LS.del('dk:fbsess'); LS.del('dk:fbme'); LS.del('dk:fbrelay'); LS.del('dk:pushAsked');
    try { indexedDB.deleteDatabase('dukkan-cloud-' + s.shop.id); } catch (e) {}
    (auth ? auth.signOut() : Promise.resolve()).finally(function () { location.reload(); });
  }

  /* ---------- the settings box (Firebase shops) ---------- */
  function accountHTML() {
    var s = licState(), l = lic() || {}, owner = me && me.role === 'owner';
    var lt = s === 'active' ? 'مفعّل ✓' : s === 'trial' ? 'تجربة مجانية — باقي ' + (l.days != null ? l.days : '?') + ' يوم' : s === 'stopped' ? 'موقوف' : 'انتهت التجربة';
    return '<div class="dk-row"><span>التفعيل</span><b>' + esc(lt) + '</b></div>'
      + '<div class="dk-row"><span>قاعدة البيانات</span><b>Firebase · <span class="num">' + esc(cfg.projectId) + '</span></b></div>'
      + (s !== 'active' ? '<button type="button" class="btn ghost dk-btn" id="fxCode">عندي كود تفعيل</button>' : '')
      + (owner ? '<button type="button" class="btn ghost dk-btn" id="fxLink">🔗 رابط ربط الأجهزة (للعمال وأجهزتك)</button>' : '')
      + '<button type="button" class="btn ghost dk-btn" id="fxGuide">📘 دليل Firebase والتحذيرات</button>';
  }
  function accountBind() {
    var a = document.getElementById('fxCode'); if (a) a.onclick = activateDialog;
    var b = document.getElementById('fxLink'); if (b) b.onclick = function () { var link = joinLink(); if (navigator.share) navigator.share({title: 'ربط جهاز بمحلي — دكّان', text: 'افتح هذا الرابط وادخل برقمك وكلمة السر:', url: link}).catch(function () { copy(link, 'انتسخ الرابط ✓'); }); else copy(link, 'انتسخ الرابط ✓'); };
    var g = document.getElementById('fxGuide'); if (g) g.onclick = guide;
  }
  function guide() {
    var o = screen(HEAD('دليل Firebase') + WARN + questionsHTML() + '<div>' + supportBtn() + '</div>'
      + '<h3 style="margin-top:14px">🔒 قواعد القفل</h3><p>إذا التطبيق گلك «حدّث القواعد» أو «القاعدة مفتوحة»، الصق هذي من جديد:</p>' + rulesHTML()
      + '<div id="fGr"></div><button type="button" class="dkf-b2" id="fGc" style="width:100%">🔎 تأكد من القفل هسه</button>'
      + '<h3 style="margin-top:14px">👀 شنو تراقب كل فترة</h3><ul class="dkf-steps"><li>Firebase ← <b>Usage and billing</b>: شگد مستهلك من الحد المجاني.</li><li>Authentication ← <b>Users</b>: إذا شفت حسابات ما تعرفها، ما يگدرون يشوفون شي بدون ما تضيفهم إنت، بس احچي ويانا.</li><li>حساب Google مالتك: التحقق بخطوتين شغّال.</li></ul>'
      + '<button type="button" class="go" id="fGx">سد</button>');
    o.querySelector('#fGx').onclick = function () { o.remove(); };
    o.querySelector('#fGc').onclick = function () { var r = o.querySelector('#fGr'); checkLock().then(function (st) { r.innerHTML = st === 'ok' ? '<div class="dkf-ok">✅ مقفولة بقواعد دكّان.</div>' : st === 'open' ? '<div class="dkf-bad">🔴 مفتوحة! الصق القواعد واضغط Publish هسه.</div>' : st === 'notours' ? '<div class="dkf-bad">⚠️ مو بقواعد دكّان الحالية. الصقها من جديد.</div>' : '<div class="dkf-bad">ما گدرت أوصل لـ Firebase.</div>'; }); };
  }

  /* ---------- moving an existing shop (on our server) to its own Firebase ---------- */
  function migrate(o) {
    var old = window.__dkCloud;
    if (!old) return Promise.resolve();
    var info = o.querySelector('#fAr'); info.style.color = '#3730A3';
    info.textContent = 'جاري جلب كل بيانات المحل...';
    var pullAll = function () { return old.pull().then(function () { return old.cursor; }); };
    return pullAll().then(function () {
      var all = []; Object.keys(old.cols).forEach(function (c) { if (c === '__priv') return; old.col(c).forEach(function (d, i) { all.push([c, i, d]); }); });
      var n = 0, chunks = [];
      for (var k = 0; k < all.length; k += 200) chunks.push(all.slice(k, k + 200));
      return chunks.reduce(function (p, ch) {
        return p.then(function () {
          var b = fs.batch();
          ch.forEach(function (x) {
            var c = x[0], i = x[1], sp = hasPriv(c) ? splitPriv(c, x[2]) : {main: x[2], priv: null}, main = enc(sp.main); main._t = ts(); main._by = me.uid;
            b.set(fs.collection('c_' + c).doc(i), main);
            if (sp.priv && Object.keys(sp.priv).length) b.set(fs.collection(privCol(c)).doc('c_' + c + '~' + i), {c: c, i: i, f: enc(sp.priv), _t: ts(), _by: me.uid});
          });
          return b.commit().then(function () { n += ch.length; info.textContent = 'انتقل ' + n + ' من ' + all.length + '...'; });
        });
      }, Promise.resolve()).then(function () { info.textContent = '✅ انتقلت كل البيانات (' + all.length + ')'; });
    });
  }

  window.DKFire = {
    has: function () { return !!(loadCfg() || /#fb=/.test(location.hash)); },
    boot: boot, setup: function (core, opt) { if (core) C = core; setup(opt || {}); }, guide: guide, welcome: welcome,
    _test: {parseCfg: parseCfg, mergeOp: mergeOp, mergeList: mergeList, splitPriv: splitPriv, applyPriv: applyPriv, enc: enc, dec: dec, invoiceNews: invoiceNews, checkCfg: checkCfg}
  };
})();
