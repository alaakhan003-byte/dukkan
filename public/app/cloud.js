/* دكّان — shop accounts and syncing (website, iPhone/Android app and the Windows program).
   Everything is saved on the device first (works with no internet), then sent to the shop's own
   database on the server. Other devices of the same shop get it within seconds.
   The app talks to this exactly like it talks to Claude's database, so all its rules keep working. */
(function () {
  'use strict';
  var API = (location.protocol === 'app:' ? 'https://dukkan.alaakhan55.workers.dev' : '') + '/api';
  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var sess = null; try { sess = JSON.parse(LS.get('dk:session') || 'null'); } catch (e) {}
  var choice = LS.get('dk:mode');            // 'local' = trying on this device without an account
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); };
  var toEn = function (s) { return String(s || '').replace(/[٠-٩]/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'.indexOf(d); }).replace(/[۰-۹]/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'.indexOf(d); }); };
  var say = function (m, ok) { try { toast(m, ok !== false); } catch (e) {} };

  /* ---------- talking to the server ---------- */
  function call(path, body, timeout) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var t = setTimeout(function () { ctl && ctl.abort(); }, timeout || 15000);
    return fetch(API + path, {
      method: body ? 'POST' : 'GET', cache: 'no-store', signal: ctl && ctl.signal,
      headers: Object.assign({'content-type': 'application/json'}, sess && sess.token ? {authorization: 'Bearer ' + sess.token} : {}),
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          // no clear answer from the server (busy or over its limit for a moment): say so plainly
          var busy = !j.msg && r.status >= 500;
          var e = new Error(j.msg || (busy ? 'السيرفر مشغول هسه. جرّب مرة ثانية بعد ثواني' : 'صار خطأ')); e.code = j.error || (busy ? 'busy' : 'http'); e.status = r.status; throw e;
        }
        return j;
      });
    }, function (e) { var x = new Error('ما أكو اتصال بالسيرفر'); x.code = 'offline'; throw x; }).finally(function () { clearTimeout(t); });
  }

  // everything about people goes through T: our server by default; a Firebase shop swaps in its own
  var T = {
    members: function () { return call('/members'); },
    add: function (o) { return call('/members/add', o); },
    set: function (phone, patch) { return call('/members/set', Object.assign({phone: phone}, patch)); },
    remove: function (phone) { return call('/members/remove', {phone: phone}); },
    salary: function (phone) { return call('/salary' + (phone ? '?phone=' + encodeURIComponent(phone) : '')); },
    me: function () { return call('/me'); }
  };
  var hooks = {};

  /* ---------- the copy on this device (IndexedDB) ---------- */
  function idb(name) {
    return new Promise(function (ok, bad) {
      var r = indexedDB.open(name, 1);
      r.onupgradeneeded = function () { var d = r.result; d.createObjectStore('docs'); d.createObjectStore('meta'); d.createObjectStore('outbox', {keyPath: 'k'}); };
      r.onsuccess = function () { ok(r.result); }; r.onerror = function () { bad(r.error); };
    });
  }
  function all(store) { return new Promise(function (ok, bad) { var out = [], rq = store.openCursor(); rq.onsuccess = function () { var c = rq.result; if (c) { out.push([c.key, c.value]); c.continue(); } else ok(out); }; rq.onerror = function () { bad(rq.error); }; }); }
  var newId = function () { var a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', s = '', r = crypto.getRandomValues(new Uint8Array(20)); for (var i = 0; i < 20; i++) s += a[r[i] % 62]; return s; };
  var clone = function (o) { return o == null ? o : JSON.parse(JSON.stringify(o)); };
  var KEY = function (c, i) { return c + '\u0001' + i; };

  /* ---------- the database the app sees (same shape as Claude's) ---------- */
  function Cloud(s) {
    var self = this;
    self.s = s; self.cols = {}; self.subs = {}; self.queue = []; self.waits = {}; self.cursor = 0; self.synced = false; self.k = Date.now();
    self.ready = idb('dukkan-cloud-' + s.shop.id).then(function (d) {
      self.d = d;
      var tx = d.transaction(['docs', 'meta', 'outbox']);
      return Promise.all([all(tx.objectStore('docs')), all(tx.objectStore('meta')), all(tx.objectStore('outbox'))]).then(function (r) {
        r[0].forEach(function (e) { var v = e[1]; (self.cols[v.c] = self.cols[v.c] || new Map()).set(v.i, v.d); });
        r[1].forEach(function (e) { if (e[0] === 'cursor') self.cursor = +e[1] || 0; });
        self.queue = r[2].map(function (e) { return e[1]; }).sort(function (a, b) { return a.k - b.k; });
        if (self.queue.length) self.k = Math.max(self.k, self.queue[self.queue.length - 1].k + 1);
        self.synced = self.cursor > 0;         // synced before: what is here is good to show straight away
      });
    });
  }
  Cloud.prototype.col = function (c) { return this.cols[c] || (this.cols[c] = new Map()); };
  Cloud.prototype.pending = function (c, i) { return this.queue.some(function (o) { return o.c === c && o.i === i; }); };
  Cloud.prototype.saveDoc = function (c, i, d) {
    var st = this.d.transaction('docs', 'readwrite').objectStore('docs');
    if (d == null) st.delete(KEY(c, i)); else st.put({c: c, i: i, d: d}, KEY(c, i));
  };
  Cloud.prototype.snap = function (c, q) {
    var arr = []; this.col(c).forEach(function (d, i) { arr.push({id: i, d: d}); });
    if (q && q.order) { var f = q.order, dir = q.dir === 'desc' ? -1 : 1; arr.sort(function (a, b) { var x = a.d[f], y = b.d[f]; return (x > y ? 1 : x < y ? -1 : 0) * dir; }); }
    if (q && q.limit) arr = arr.slice(0, q.limit);
    var docs = arr.map(function (x) { return docSnap(x.id, x.d); });
    return {docs: docs, size: docs.length, empty: !docs.length, metadata: {fromCache: !this.synced}, forEach: function (fn) { docs.forEach(fn); }};
  };
  Cloud.prototype.notify = function (c) {
    var self = this; if (self.held) { self.held[c] = 1; return; }
    (self.subs[c] || []).forEach(function (s) { try { s.cb(self.snap(c, s.q)); } catch (e) {} });
  };
  Cloud.prototype.hold = function (fn) {
    var self = this; self.held = {};
    try { fn(); } finally { var h = self.held; self.held = null; Object.keys(h).forEach(function (c) { self.notify(c); }); }
  };
  // a change made here: saved on the device at once, then sent
  Cloud.prototype.write = function (c, i, d) {
    var self = this, col = self.col(c), base = col.has(i) ? clone(col.get(i)) : null;
    if (d == null) col.delete(i); else col.set(i, clone(d));
    self.saveDoc(c, i, d == null ? null : col.get(i));
    var op = {k: self.k++, c: c, i: i, t: d == null ? 'del' : 'set', d: d == null ? null : clone(d), b: base};
    self.queue.push(op);
    self.d.transaction('outbox', 'readwrite').objectStore('outbox').put(op);
    self.notify(c);
    var p = new Promise(function (ok, bad) { self.waits[op.k] = {ok: ok, bad: bad}; });
    var timer = new Promise(function (ok) { setTimeout(ok, navigator.onLine === false ? 0 : 4000); });   // offline: never makes the app wait
    self.flushSoon();
    return Promise.race([p, timer]);
  };
  Cloud.prototype.flushSoon = function () { var self = this; clearTimeout(self.ft); self.ft = setTimeout(function () { self.flush(); }, 60); };
  Cloud.prototype.flush = function () {
    var self = this;
    if (self.pushing || !self.queue.length || self.dead) return Promise.resolve();
    self.pushing = true;
    var batch = self.queue.slice(0, 200);
    return call('/push', {ops: batch.map(function (o) { return {k: o.k, c: o.c, i: o.i, t: o.t, d: o.d, b: o.b}; })}, 25000).then(function (r) {
      var tx = self.d.transaction(['outbox', 'docs'], 'readwrite'), ob = tx.objectStore('outbox'), changed = {};
      (r.done || []).forEach(function (x) {
        var idx = self.queue.findIndex(function (o) { return o.k === x.k; }); if (idx < 0) return;
        var op = self.queue.splice(idx, 1)[0]; ob.delete(op.k);
        var w = self.waits[op.k]; delete self.waits[op.k];
        if (!self.pending(op.c, op.i)) {
          if (x.ok) { if (x.d == null) self.col(op.c).delete(op.i); else self.col(op.c).set(op.i, x.d); }
          self.refetch = self.refetch || []; if (!x.ok) self.refetch.push([op.c, op.i]);   // refused (e.g. a worker editing settings): get the real copy back
          var d = self.col(op.c).get(op.i);
          if (d == null) tx.objectStore('docs').delete(KEY(op.c, op.i)); else tx.objectStore('docs').put({c: op.c, i: op.i, d: d}, KEY(op.c, op.i));
          changed[op.c] = 1;
        }
        if (!x.ok && x.msg) say(x.msg, false);
        if (w) { if (x.ok) w.ok(); else { var e = new Error(x.msg || (x.err === 'owner' ? 'هذا الشي لصاحب المحل بس' : 'ما انحفظ')); e.code = x.err === 'owner' || x.err === 'perm' ? 'permission_denied' : 'failed'; w.bad(e); } }
      });
      self.hold(function () { Object.keys(changed).forEach(function (c) { self.notify(c); }); });
      self.online(true);
      (self.refetch || []).splice(0).forEach(function (ci) { self.fetchDoc(ci[0], ci[1]); });
    }).catch(function (e) { self.fail(e); }).finally(function () {
      self.pushing = false;
      if (self.queue.length && !self.offline) self.flushSoon(); else self.pull();
      self.status();
    });
  };
  Cloud.prototype.pull = function () {
    var self = this;
    if (self.pulling || self.dead) return self.pulling || Promise.resolve();
    self.pulling = call('/pull?since=' + self.cursor + '&limit=800', null, 30000).then(function (r) {
      var tx = self.d.transaction(['docs', 'meta'], 'readwrite'), st = tx.objectStore('docs');
      self.hold(function () {
        (r.changes || []).forEach(function (x) {
          if (self.pending(x.c, x.i)) return;          // our own change is on its way; its answer brings the newest copy
          var col = self.col(x.c);
          if (x.d == null) { if (col.has(x.i)) { col.delete(x.i); st.delete(KEY(x.c, x.i)); self.notify(x.c); } }
          else { col.set(x.i, x.d); st.put({c: x.c, i: x.i, d: x.d}, KEY(x.c, x.i)); self.notify(x.c); }
        });
        self.cursor = r.seq; tx.objectStore('meta').put(self.cursor, 'cursor');
        if (!self.synced && !r.more) { self.synced = true; Object.keys(self.subs).forEach(function (c) { self.notify(c); }); }
      });
      self.online(true);
      self.pulling = null;
      if (r.more) return self.pull();
    }).catch(function (e) { self.pulling = null; self.fail(e); }).finally(function () { self.status(); });
    return self.pulling;
  };
  Cloud.prototype.fetchDoc = function (c, i) {
    var self = this;
    return call('/doc?c=' + encodeURIComponent(c) + '&i=' + encodeURIComponent(i), null, 3500).then(function (r) {
      if (self.pending(c, i)) return self.col(c).get(i);
      var col = self.col(c), before = JSON.stringify(col.get(i) ?? null);
      if (r.d == null) col.delete(i); else col.set(i, r.d);
      if (JSON.stringify(r.d ?? null) !== before) { self.saveDoc(c, i, r.d); self.notify(c); }
      self.online(true);
      return r.d;
    });
  };
  Cloud.prototype.online = function (yes) {
    var was = this.offline; this.offline = !yes;
    if (was && yes) { this.flushSoon(); }
  };
  Cloud.prototype.fail = function (e) {
    if (e && (e.status === 401 || e.status === 403)) { this.dead = true; relogin(e); return; }
    this.online(false);
  };
  Cloud.prototype.status = function () {
    var n = this.queue.length, el = document.getElementById('dkSync');
    if (el) el.innerHTML = n ? '<b class="num">' + n + '</b> حركة تنتظر النت حتى تنرفع' : this.offline ? 'ما أكو نت — كل شي محفوظ على الجهاز' : 'كل شي مرفوع للسحابة ✓';
    if (this.lastN && !n && !this.offline) say('انرفعت كل الحركات للسحابة ✓');
    this.lastN = n;
  };
  // the live line: a change on another device arrives within a second (and its news as a note on the side)
  Cloud.prototype.live = function () {
    var self = this;
    if (self.dead || self.wsDead || !('WebSocket' in window)) return;
    if (self.ws && (self.ws.readyState === 0 || self.ws.readyState === 1)) return;
    var base = API.indexOf('http') === 0 ? API.replace(/^http/, 'ws') : (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + API, ws;
    try { ws = new WebSocket(base + '/live?shop=' + encodeURIComponent(self.s.shop.id)); } catch (e) { return; }
    self.ws = ws;
    ws.onopen = function () { ws.send(JSON.stringify({auth: self.s.token})); };
    ws.onmessage = function (e) {
      if (e.data === 'pong') return;
      var m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.t === 'ok') { self.liveOk = true; self.wsTry = 0; if (m.seq > self.cursor) self.pull(); }
      else if (m.t === 'c') { if (m.seq > self.cursor) self.pull(); }
      else if (m.t === 'ev') { if (m.by !== self.s.user.phone) sideNote(m.title, m.body); }
      else if (m.t === 'bye') { self.wsDead = true; self.pull(); }
      else if (m.t === 'perm' && m.phone === self.s.user.phone) refreshMe(true);
    };
    ws.onclose = function () {
      self.liveOk = false; self.ws = null; clearInterval(self.pingT);
      if (self.wsDead || self.dead) return;
      var wait = Math.min(30000, 1500 * Math.pow(2, self.wsTry || 0)); self.wsTry = (self.wsTry || 0) + 1;
      clearTimeout(self.wsT); self.wsT = setTimeout(function () { if (document.visibilityState === 'visible' || window.APP_DESKTOP) self.live(); }, wait);
    };
    clearInterval(self.pingT); self.pingT = setInterval(function () { try { if (ws.readyState === 1) ws.send('ping'); } catch (e) {} }, 25000);
  };
  Cloud.prototype.start = function () {
    var self = this, lastPull = 0;
    self.pull().then(function () { self.flush(); });
    self.live();
    setInterval(function () {
      if (document.visibilityState !== 'visible') return;
      if (self.queue.length) self.flush();
      else if (!self.liveOk || Date.now() - lastPull > 60000) { lastPull = Date.now(); self.pull(); }   // the live line does the fast part; this is the safety net
      self.live();
    }, 20000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { self.pull(); self.flush(); self.live(); } });
    addEventListener('online', function () { self.online(true); self.flush(); self.pull(); self.wsTry = 0; self.live(); });
    addEventListener('offline', function () { self.online(false); self.status(); });
  };
  function docSnap(id, d) { var x = d == null ? null : clone(d); return {id: id, exists: x != null, data: function () { return x == null ? undefined : clone(x); }}; }
  function Ref(db, c, i) { this.db = db; this.c = c; this.id = i; }
  Ref.prototype.set = function (data) { return this.db.write(this.c, this.id, JSON.parse(JSON.stringify(data))); };
  Ref.prototype.delete = function () { return this.db.write(this.c, this.id, null); };
  Ref.prototype.get = function () {
    var db = this.db, c = this.c, i = this.id;
    if (navigator.onLine === false || db.pending(c, i) || db.offline) return Promise.resolve(docSnap(i, db.col(c).get(i)));
    return db.fetchDoc(c, i).then(function (d) { return docSnap(i, d); }, function () { return docSnap(i, db.col(c).get(i)); });
  };
  function Query(db, c, q) { this.db = db; this.c = c; this.q = q || {}; }
  Query.prototype.doc = function (i) { return new Ref(this.db, this.c, i || newId()); };
  Query.prototype.orderBy = function (f, dir) { return new Query(this.db, this.c, Object.assign({}, this.q, {order: f, dir: dir})); };
  Query.prototype.limit = function (n) { return new Query(this.db, this.c, Object.assign({}, this.q, {limit: n})); };
  Query.prototype.where = function (f, op, v) { return new Query(this.db, this.c, Object.assign({}, this.q, {where: [f, v]})); };
  Query.prototype.onSnapshot = function (cb, err) {
    var db = this.db, c = this.c, s = {cb: cb, q: this.q};
    (db.subs[c] = db.subs[c] || []).push(s);
    setTimeout(function () { try { cb(db.snap(c, s.q)); } catch (e) {} }, 0);
    return function () { db.subs[c] = (db.subs[c] || []).filter(function (x) { return x !== s; }); };
  };
  Query.prototype.get = function () {
    var db = this.db, c = this.c, q = this.q;
    if (q.where) {
      var f = q.where[0], v = q.where[1];
      var local = function () { var docs = []; db.col(c).forEach(function (d, i) { if (JSON.stringify(d[f]) === JSON.stringify(v)) docs.push(docSnap(i, d)); }); return {docs: docs, size: docs.length, empty: !docs.length}; };
      if (navigator.onLine === false || db.offline) return Promise.resolve(local());
      if (db.remoteQuery) return db.remoteQuery(c, f, v).then(null, local);
      return call('/query?c=' + encodeURIComponent(c) + '&f=' + encodeURIComponent(f) + '&v=' + encodeURIComponent(JSON.stringify(v)), null, 4000).then(function (r) {
        var docs = r.map(function (x) { return docSnap(x.i, x.d); });
        db.queue.forEach(function (o) { if (o.c === c && o.t === 'set' && JSON.stringify(o.d[f]) === JSON.stringify(v) && !docs.some(function (d) { return d.id === o.i; })) docs.push(docSnap(o.i, o.d)); });
        return {docs: docs, size: docs.length, empty: !docs.length};
      }, local);
    }
    return Promise.race([db.pull(), new Promise(function (ok) { setTimeout(ok, 3000); })]).then(function () { return db.snap(c, q); });
  };
  Cloud.prototype.collection = function (c) { return new Query(this, c); };

  /* ---------- notes on the side (the app is open) ---------- */
  function sideNote(title, body, actions) {
    var box = document.getElementById('dkNt');
    if (!box) { box = document.createElement('div'); box.id = 'dkNt'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    var n = document.createElement('div'); n.className = 'dk-nt';
    n.innerHTML = '<img src="icons/icon-192.png" alt=""><div><b>' + esc(title) + '</b><span>' + esc(body || '') + '</span>' + (actions ? '<p>' + actions + '</p>' : '') + '</div><button type="button" class="x" aria-label="سد">×</button>';
    box.prepend(n);
    while (box.children.length > 3) box.lastChild.remove();
    var gone = function () { n.classList.add('out'); setTimeout(function () { n.remove(); }, 250); };
    n.querySelector('.x').onclick = function (e) { e.stopPropagation(); gone(); };
    if (!actions) { n.onclick = function () { gone(); try { if (location.hash !== '#invoices') location.hash = 'invoices'; } catch (e) {} }; setTimeout(gone, 7000); }
    try { navigator.vibrate && navigator.vibrate(40); } catch (e) {}
    return n;
  }
  window.__dkNote = sideNote;
  // what fire.js (a shop on its own Firebase) builds on
  var core = {
    Cloud: Cloud, docSnap: docSnap, KEY: KEY, call: call, sideNote: sideNote, hooks: hooks,
    overlay: function (h) { return overlay(h); }, showLogin: function (m, a) { showLogin(m, a); }, startLocal: function () { startLocal(); },
    startCloud: function (inst) { startCloud(inst); }, desktopSession: function () { desktopSession(); },
    getSess: function () { return sess; }, setSess: function (s) { sess = s; setRole(); }, setT: function (t) { T = t; }
  };

  /* ---------- real notifications on this device ---------- */
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  var canPush = function () { return !window.APP_DESKTOP && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext; };
  var u8 = function (s) { var t = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (t.length % 4) t += '='; return Uint8Array.from(atob(t), function (c) { return c.charCodeAt(0); }); };
  function pushSub() { return navigator.serviceWorker.ready.then(function (r) { return r.pushManager.getSubscription(); }); }
  function pushOn() {
    return Notification.requestPermission().then(function (p) {
      if (p !== 'granted') { var e = new Error(isIOS ? 'الإشعارات مرفوضة. فعّلها من إعدادات الآيفون ← الإشعارات ← دكّان' : 'الإشعارات مرفوضة. فعّلها من إعدادات المتصفح'); throw e; }
      return Promise.all([navigator.serviceWorker.ready, call('/push/key')]);
    }).then(function (r) {
      return r[0].pushManager.getSubscription().then(function (old) { return old || r[0].pushManager.subscribe({userVisibleOnly: true, applicationServerKey: u8(r[1].key)}); });
    }).then(function (sub) { return call('/push/sub', {sub: sub.toJSON()}); }).then(function () { LS.set('dk:push', '1'); });
  }
  function pushOff() {
    return pushSub().then(function (sub) { if (!sub) return; var ep = sub.endpoint; return sub.unsubscribe().then(function () { return call('/push/unsub', {endpoint: ep}).catch(function () {}); }); }).then(function () { LS.del('dk:push'); });
  }
  function pushState() {
    if (window.APP_DESKTOP) return Promise.resolve('desktop');
    if (!canPush()) return Promise.resolve(isIOS && !standalone ? 'ios-install' : 'none');
    if (Notification.permission === 'denied') return Promise.resolve('denied');
    return pushSub().then(function (s) { return s ? 'on' : 'off'; }).catch(function () { return 'off'; });
  }
  // after logging in: ask once (needs a tap on iPhone), and quietly renew if it was allowed before
  function pushInvite() {
    pushState().then(function (st) {
      if (st === 'off' && Notification.permission === 'granted') { pushOn().catch(function () {}); return; }
      if (st !== 'off' || LS.get('dk:pushAsked')) return;
      setTimeout(function () {
        var n = sideNote('🔔 تريد يوصلك إشعار؟', 'لكل بيعة ودفعة وإرجاع بالمحل — حتى لو التطبيق مسدود.', '<button type="button" class="y">فعّل الإشعارات</button><button type="button" class="n">بعدين</button>');
        n.querySelector('.y').onclick = function () { LS.set('dk:pushAsked', '1'); n.remove(); pushOn().then(function () { say('انفعلت الإشعارات ✓'); }, function (e) { say(e.message, false); }); };
        n.querySelector('.n').onclick = function () { LS.set('dk:pushAsked', '1'); n.remove(); };
      }, 2500);
    });
  }

  /* ---------- who is using it ---------- */
  var people = {}; try { people = JSON.parse(LS.get('dk:people') || '{}'); } catch (e) {}
  function loadPeople() { return T.members().then(function (L) { people = {}; L.forEach(function (m) { people[m.phone] = {name: m.name, role: m.role}; }); LS.set('dk:people', JSON.stringify(people)); return L; }); }
  function userApi() {
    return {
      id: function () { return Promise.resolve(sess.user.phone); },
      can: function () { return Promise.resolve(hooks.canWrite ? !!hooks.canWrite() : true); },   // a Firebase shop whose free trial ended: look, don't sell
      canEdit: function () { return Promise.resolve(sess.user.role === 'owner'); },
      profiles: function (ids) { var miss = ids.some(function (i) { return !people[i]; }); return (miss ? loadPeople().catch(function () {}) : Promise.resolve()).then(function () { var o = {}; ids.forEach(function (i) { if (people[i]) o[i] = {name: people[i].name}; }); return o; }); }
    };
  }

  /* ---------- plugging into the app ---------- */
  var resolveDb, resolveUser, cloud = null;
  var dbReady = new Promise(function (ok) { resolveDb = ok; }), userReady = new Promise(function (ok) { resolveUser = ok; });
  var baseUse = window.claude && window.claude.use;
  window.claude = {use: function (name) {
    if (name === 'db') return dbReady;
    if (name === 'user') return userReady;
    return baseUse ? baseUse(name) : Promise.resolve(null);
  }};
  function startCloud(inst) {
    setRole();
    cloud = inst || new Cloud(sess);
    window.__dkCloud = cloud;
    cloud.ready.then(function () { resolveDb(cloud); resolveUser(userApi()); cloud.start(); loadPeople().catch(function () {}); offerUpload(); pushInvite(); desktopSession(); setTimeout(function () { refreshMe(false); }, 1500); })
      .catch(function () { resolveDb(null); resolveUser(null); say('ما گدرت أفتح التخزين على هذا الجهاز', false); });
  }
  function startLocal() { resolveDb(null); resolveUser(null); }
  // what this person may see and do (the owner changes it from "العمال"); the app reads window.__dkRole
  function setRole() { window.__dkRole = sess && sess.user ? {role: sess.user.role, perms: sess.user.perms || {}, name: sess.user.name, phone: sess.user.phone} : null; }
  var HIDE = function (P) { return (P.money ? [] : ['cash', 'expenses', 'closings', 'recurring', 'logs']).concat(P.purchases ? [] : ['supplierTx', 'suppliers']); };
  function refreshMe(fromServer) {
    return T.me().then(function (r) {
      var before = JSON.stringify((sess.user && sess.user.perms) || {}), now = JSON.stringify(r.user.perms || {});
      sess.user = r.user; sess.shop = r.shop; if (!sess.fb) LS.set('dk:session', JSON.stringify(sess)); setRole();
      if (before === now || !cloud) return;
      // permissions changed: drop what may no longer be seen, fetch again what may now be seen, and redraw the app
      var hide = HIDE(r.user.perms || {}), st = cloud.d.transaction(['docs', 'meta'], 'readwrite');
      Object.keys(cloud.cols).forEach(function (c) { if (hide.indexOf(c) >= 0) { cloud.col(c).forEach(function (d, i) { st.objectStore('docs').delete(KEY(c, i)); }); cloud.cols[c] = new Map(); } });
      cloud.cursor = 0; st.objectStore('meta').put(0, 'cursor');
      say(fromServer ? 'صاحب المحل غيّر صلاحياتك — جاري التحديث' : 'تحدثت صلاحياتك');
      setTimeout(function () { cloud.pull().then(function () { location.reload(); }); }, 600);
    }).catch(function (e) { if (e && (e.status === 401 || e.status === 403)) relogin(e); });
  }
  // the Windows program keeps its own live line (it notifies even with the window closed)
  function desktopSession() { try { if (window.dukkanDesktop && window.dukkanDesktop.session) window.dukkanDesktop.session(sess ? (sess.fb ? sess.desk : {token: sess.token, shop: sess.shop.id, phone: sess.user.phone, name: sess.shop.name}) : null); } catch (e) {} }

  /* ---------- the login screen ---------- */
  var CSS = '#dkIn{position:fixed;inset:0;z-index:400;display:flex;align-items:center;justify-content:center;padding:20px;overflow:auto;background:radial-gradient(70% 55% at 85% 0%,rgba(129,140,248,.5),transparent 60%),radial-gradient(60% 50% at 0% 100%,rgba(236,72,153,.32),transparent 62%),linear-gradient(170deg,#3730A3,#1E1B4B 70%);font-family:inherit;color:#0F172A}'
    + '#dkIn .c{flex:0 1 400px;width:100%;max-width:400px;margin:auto;background:#fff;border-radius:26px;padding:26px 22px 20px;box-shadow:0 40px 80px -30px rgba(0,0,0,.6)}'
    + '#dkIn .h{display:flex;align-items:center;gap:12px;margin-bottom:18px}#dkIn .h img{width:52px;height:52px;border-radius:16px}#dkIn .h b{display:block;font-size:22px}#dkIn .h span{color:#64748B;font-size:14px}'
    + '#dkIn label{display:block;font-size:14px;font-weight:600;margin:12px 0 6px;color:#334155}'
    + '#dkIn .f{display:flex;align-items:center;background:#F6F7FB;border:1.5px solid transparent;border-radius:15px;height:52px;padding:0 14px}#dkIn .f:focus-within{border-color:#818CF8;background:#fff}'
    + '#dkIn input{flex:1;border:0;outline:0;background:none;font:inherit;font-size:17px;min-width:0;height:100%;color:#0F172A}#dkIn input.l{direction:ltr;text-align:right}'
    + '#dkIn .eye{border:0;background:none;color:#64748B;font:inherit;font-size:13px;cursor:pointer;padding:6px}'
    + '#dkIn .go{width:100%;min-height:54px;margin-top:18px;border:0;border-radius:16px;background:linear-gradient(135deg,#6366F1,#4338CA);color:#fff;font:inherit;font-size:17px;font-weight:700;cursor:pointer}#dkIn .go:disabled{opacity:.6}'
    + '#dkIn .er{color:#BE123C;font-size:14px;font-weight:600;margin-top:10px;min-height:20px;line-height:1.6}'
    + '#dkIn .n{font-size:13px;color:#64748B;line-height:1.7;margin-top:14px;text-align:center}#dkIn .lo{display:block;margin:10px auto 0;border:0;background:none;color:#4338CA;font:inherit;font-size:14px;font-weight:600;cursor:pointer;text-decoration:underline}'
    + '#dkIn .two{display:flex;gap:8px;margin-top:16px}#dkIn .two button{flex:1;min-height:50px;border-radius:14px;font:inherit;font-weight:700;cursor:pointer;border:0}#dkIn .two .y{background:#4338CA;color:#fff}#dkIn .two .no{background:#EEF2FF;color:#3730A3}';
  function overlay(html) {
    var o = document.getElementById('dkIn');
    if (!o) { var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); o = document.createElement('div'); o.id = 'dkIn'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true'); document.body.appendChild(o); }
    o.innerHTML = '<div class="c">' + html + '</div>';
    return o;
  }
  var HEAD = '<div class="h"><img src="icons/icon-192.png" alt=""><div><b>دكّان</b><span>سجّل دخول محلك</span></div></div>';
  function showLogin(msg, again) {
    var lastPhone = (sess && sess.user && sess.user.phone) || LS.get('dk:lastPhone') || '';
    var o = overlay(HEAD
      + (again ? '<div class="er" style="margin:0 0 6px">' + esc(msg || 'سجّل دخول مرة ثانية') + '</div>' : '')
      + '<form id="dkF" novalidate><label for="dkP">رقم الهاتف</label><div class="f"><input id="dkP" class="l" type="tel" inputmode="tel" autocomplete="username" placeholder="07xxxxxxxxx" value="' + esc(lastPhone) + '"></div>'
      + '<label for="dkW">كلمة السر</label><div class="f"><input id="dkW" type="password" autocomplete="current-password" placeholder="••••••"><button type="button" class="eye" id="dkE">إظهار</button></div>'
      + '<div class="er" id="dkR">' + (!again && msg ? esc(msg) : '') + '</div><button class="go" id="dkG">دخول</button></form>'
      + '<div class="n">حساب المحل يسويه إلك صاحب التطبيق. وصاحب المحل يضيف عماله من الإعدادات.<br>بعد أول دخول يبقى التطبيق مفتوح على حسابك، ويشتغل حتى بدون إنترنت.</div>'
      + (again ? '' : '<button class="lo" id="dkL">جرّب على هذا الجهاز بس (بدون حساب)</button>'));
    var f = o.querySelector('#dkF'), p = o.querySelector('#dkP'), w = o.querySelector('#dkW'), r = o.querySelector('#dkR'), g = o.querySelector('#dkG');
    o.querySelector('#dkE').onclick = function () { var sh = w.type === 'password'; w.type = sh ? 'text' : 'password'; this.textContent = sh ? 'إخفاء' : 'إظهار'; };
    var lo = o.querySelector('#dkL'); if (lo) lo.onclick = function () { LS.set('dk:mode', 'local'); o.remove(); startLocal(); };
    setTimeout(function () { (p.value ? w : p).focus(); }, 50);
    f.onsubmit = function (e) {
      e.preventDefault();
      var phone = toEn(p.value).replace(/\D/g, ''); if (/^7\d{9}$/.test(phone)) phone = '0' + phone;
      if (!/^07\d{9}$/.test(phone)) { r.textContent = 'رقم الهاتف لازم 11 رقم ويبدأ بـ 07'; p.focus(); return; }
      if (!w.value) { r.textContent = 'اكتب كلمة السر'; w.focus(); return; }
      if (navigator.onLine === false) { r.textContent = 'أول دخول يحتاج إنترنت. اتصل وجرّب'; return; }
      g.disabled = true; g.textContent = 'جاري الدخول...'; r.textContent = '';
      var old = sess; sess = null;
      var once = function () { return call('/login', {phone: phone, password: w.value}); };
      once().catch(function (e) { if (e && e.code === 'busy') return new Promise(function (ok) { setTimeout(ok, 900); }).then(once); throw e; }).then(function (res) {   // a busy server gets one quiet second try
        LS.set('dk:lastPhone', phone);
        var sameShop = old && old.shop && old.shop.id === res.shop.id;
        sess = {token: res.token, user: res.user, shop: res.shop};
        LS.set('dk:session', JSON.stringify(sess)); LS.del('dk:mode'); setRole();
        o.remove();
        if (again && cloud && sameShop) { cloud.s = sess; cloud.dead = false; cloud.wsDead = false; cloud.flush(); cloud.pull(); cloud.live(); desktopSession(); say('رجعت لحسابك ✓'); return; }
        if (again) { location.reload(); return; }
        say('أهلاً ' + (res.user.name || '') + ' — ' + res.shop.name);
        startCloud();
      }).catch(function (e) {
        sess = old; g.disabled = false; g.textContent = 'دخول';
        r.textContent = e.code === 'offline' ? 'ما أكو اتصال. تأكد من الإنترنت وجرّب' : e.message;
      });
    };
  }
  function relogin(e) {
    if (document.getElementById('dkIn')) return;
    var m = e && e.code === 'disabled' ? e.message : e && e.code === 'inactive' ? e.message : 'لازم تسجل دخول مرة ثانية (يمكن تغيّرت كلمة السر). بياناتك محفوظة';
    if (hooks.relogin) { hooks.relogin(m); return; }
    showLogin(m, true);
  }
  // the first time a shop logs in on a device that already has data from "trying without an account"
  function offerUpload() {
    if (sess.user.role !== 'owner' || LS.get('dk:uploaded:' + sess.shop.id)) return;
    var dbLocal = null;
    cloud.pull().then(function () {
      var empty = ['products', 'invoices', 'customers'].every(function (c) { return !cloud.col(c).size; });
      if (!empty || !window.__idbLoad) return;
      return window.__idbLoad().then(function (d) {
        dbLocal = d || {};
        var n = function (k) { return Array.isArray(dbLocal[k]) ? dbLocal[k].length : 0; };
        if (!n('products') && !n('invoices') && !n('customers')) return;
        var o = overlay(HEAD + '<div style="font-size:16px;line-height:1.8">لگيت بيانات على هذا الجهاز: <b>' + n('products') + '</b> منتج، <b>' + n('invoices') + '</b> فاتورة، <b>' + n('customers') + '</b> عميل.<br>ترفعها لحساب محلك حتى تنحفظ بالسحابة؟</div>'
          + '<div class="two"><button class="y" id="dkUy">ارفعها</button><button class="no" id="dkUn">لا</button></div>');
        o.querySelector('#dkUn').onclick = function () { LS.set('dk:uploaded:' + sess.shop.id, 'no'); o.remove(); };
        o.querySelector('#dkUy').onclick = function () {
          o.remove();
          cloud.hold(function () {
            Object.keys(dbLocal).forEach(function (c) { (dbLocal[c] || []).forEach(function (x) { if (!x || !x.id) return; var d = Object.assign({}, x); delete d.id; cloud.write(c, x.id, d); }); });
          });
          LS.set('dk:uploaded:' + sess.shop.id, 'yes'); say('جاري رفع بيانات الجهاز للسحابة...');
        };
      });
    }).catch(function () {});
  }

  /* ---------- settings: the account, the workers, logging out ---------- */
  window.__dkAccount = function () {
    if (!sess || !cloud) return '';
    var u = sess.user, owner = u.role === 'owner';
    return '<div class="dk-row"><span>المحل</span><b>' + esc(sess.shop.name) + '</b></div>'
      + '<div class="dk-row"><span>' + (owner ? 'صاحب المحل' : 'عامل') + '</span><b>' + esc(u.name) + ' · <span class="num">' + esc(u.phone) + '</span></b></div>'
      + '<div class="dk-note" id="dkSync"></div>'
      + '<div class="dk-row"><span>الإشعارات على هذا الجهاز</span><b id="dkPushSt">...</b></div><div id="dkPushBox"></div>'
      + (owner ? '<button type="button" class="btn ghost dk-btn" id="dkTeam">العمال: حساباتهم، صلاحياتهم ورواتبهم</button><div id="dkTeamBox"></div>' : '<div id="dkMySal"></div>')
      + (hooks.account ? hooks.account() : owner && window.DKFire ? '<button type="button" class="btn ghost dk-btn" id="dkMove">🔥 انقل محلك لـ Firebase مالتك</button>' : '')
      + '<button type="button" class="btn ghost dk-btn" id="dkOut" style="color:#BE123C">تسجيل خروج</button>';
  };
  window.__dkAccountBind = function () {
    if (!cloud) return;
    cloud.status();
    paintPush();
    if (hooks.accountBind) hooks.accountBind();
    var mv = document.getElementById('dkMove');
    if (mv) mv.onclick = function () {
      if (cloud.queue.length) { say('انتظر لحد ما تنرفع كل الحركات، وبعدين انقل', false); return; }
      window.DKFire.setup(core, {migrate: true});
    };
    var out = document.getElementById('dkOut');
    if (out) out.onclick = function () {
      if (cloud.queue.length && !confirmOut) { confirmOut = true; out.textContent = cloud.queue.length + ' حركة ما انرفعت بعد! اضغط مرة ثانية حتى تطلع'; setTimeout(function () { confirmOut = false; out.textContent = 'تسجيل خروج'; }, 5000); return; }
      if (hooks.logout) { hooks.logout(); return; }
      try { if (window.dukkanDesktop && window.dukkanDesktop.session) window.dukkanDesktop.session(null); } catch (e) {}
      if (canPush()) pushOff().catch(function () {});
      LS.del('dk:session'); LS.del('dk:people'); LS.del('dk:pushAsked');
      try { indexedDB.deleteDatabase('dukkan-cloud-' + sess.shop.id); } catch (e) {}
      location.reload();
    };
    var tb = document.getElementById('dkTeam');
    if (tb) tb.onclick = function () { team(document.getElementById('dkTeamBox')); };
    var ms = document.getElementById('dkMySal');
    if (ms) T.salary().then(function (r) { ms.innerHTML = salaryHTML(r, true); }).catch(function () { ms.innerHTML = ''; });
  };
  var confirmOut = false;
  var M = function (n) { return Math.round(+n || 0).toLocaleString('en-US'); };
  var MONTH = function (d) { var m = ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول']; var p = String(d || '').split('-'); return p.length >= 2 ? m[+p[1] - 1] + ' ' + p[0] : ''; };
  function salaryHTML(r, mine) {
    var thisM = new Date().toISOString().slice(0, 7), got = r.pays.filter(function (p) { return p.month === thisM; }).reduce(function (t, p) { return t + p.amount; }, 0);
    return '<div class="dk-sal"><div class="dk-row"><span>' + (mine ? 'راتبك الشهري' : 'الراتب الشهري') + '</span><b class="num">' + (r.salary ? M(r.salary) + ' د.ع' : 'ما محدد') + '</b></div>'
      + '<div class="dk-row"><span>استلم هذا الشهر</span><b class="num">' + M(got) + ' د.ع' + (r.salary ? (got >= r.salary ? ' ✓' : ' · الباقي ' + M(r.salary - got)) : '') + '</b></div>'
      + (r.pays.length ? '<details><summary>سجل الرواتب</summary>' + r.pays.slice(0, 12).map(function (p) { return '<div class="dk-row small"><span>' + esc(MONTH(p.month)) + ' · <span class="num">' + esc(p.date) + '</span></span><b class="num">' + M(p.amount) + '</b></div>'; }).join('') + '</details>' : '') + '</div>';
  }
  var PERM_L = [['sell', 'يبيع (فواتير بيع)'], ['pay', 'يسجل دفعات وأقساط'], ['customers', 'يضيف ويعدل العملاء'], ['products', 'يضيف المنتجات ويغيّر أسعارها'], ['returns', 'يرجّع منتجات ويلغي فواتير'], ['purchases', 'المشتريات والموردين'], ['money', 'يشوف الفلوس: الصندوق، الصرفيات، الأرباح، أسعار الشراء والمجاميع']];
  function payOne(phone, name, amount, box) {
    if (typeof put !== 'function') { say('افتح التطبيق وجرّب', false); return Promise.resolve(); }
    var d = new Date(), date = d.toISOString().slice(0, 10), month = date.slice(0, 7);
    try { if (typeof setLog === 'function') setLog('تسليم راتب: ' + name + ' — ' + M(amount) + ' د.ع (' + MONTH(month) + ')', 'add'); } catch (e) {}
    return put('expenses', {category: 'رواتب', amount: amount, date: date, desc: 'راتب ' + name + ' — ' + MONTH(month), payee: name, worker: phone, month: month, createdAt: Date.now()})
      .then(function () { return hooks.paid ? hooks.paid(phone, {amount: amount, date: date, month: month, desc: 'راتب ' + name + ' — ' + MONTH(month)}).catch(function () {}) : null; })   // a Firebase shop: the worker's own salary page (he can't see expenses)
      .then(function () { say('انسجل الراتب كصرفية ✓'); team(box); });
  }
  function paintPush() {
    var st = document.getElementById('dkPushSt'), box = document.getElementById('dkPushBox'); if (!st) return;
    pushState().then(function (s) {
      var T = {on: 'شغّالة ✓', off: 'مطفية', denied: 'مرفوضة', 'ios-install': 'تحتاج تثبيت', none: 'ما تنفع هنا', desktop: 'شغّالة ✓'};
      st.textContent = T[s] || '';
      var btn = function (id, t, cls) { return '<button type="button" class="btn ' + (cls || 'ghost') + ' dk-btn" id="' + id + '">' + t + '</button>'; };
      box.innerHTML = s === 'off' ? btn('dkPOn', 'فعّل الإشعارات (كل بيعة ودفعة توصلك)', 'pri')
        : s === 'on' ? btn('dkPTest', 'جرّب إشعار') + btn('dkPOff', 'أطفي الإشعارات على هذا الجهاز')
        : s === 'desktop' ? '<div class="dk-note">توصلك جنب الساعة حتى لو نافذة دكّان مسدودة. تگدر تطفيها من أيقونة دكّان جنب الساعة.</div>' + btn('dkPTest', 'جرّب إشعار')
        : s === 'ios-install' ? '<div class="dk-note">الآيفون يسمح بالإشعارات بس للتطبيق المثبّت: من Safari اضغط مشاركة ← إضافة إلى الشاشة الرئيسية، وافتحه من الأيقونة.</div>'
        : s === 'denied' ? '<div class="dk-note">' + (isIOS ? 'فعّلها من إعدادات الآيفون ← الإشعارات ← دكّان.' : 'فعّلها من إعدادات المتصفح (القفل جنب الرابط ← الإشعارات ← سماح).') + '</div>'
        : '<div class="dk-note">هذا المتصفح ما يدعم الإشعارات. استعمل Chrome أو التطبيق المثبّت.</div>';
      var on = document.getElementById('dkPOn'), off = document.getElementById('dkPOff'), test = document.getElementById('dkPTest');
      if (on) on.onclick = function () { on.disabled = true; pushOn().then(function () { say('انفعلت الإشعارات ✓'); paintPush(); }, function (e) { say(e.message, false); paintPush(); }); };
      if (off) off.onclick = function () { pushOff().then(function () { say('انطفت الإشعارات على هذا الجهاز'); paintPush(); }); };
      if (test) test.onclick = function () { test.disabled = true; call('/push/test', {}).then(function () { say('انرسل إشعار تجربة لكل أجهزة المحل'); }, function (e) { say(e.message, false); }).finally(function () { test.disabled = false; }); };
    });
  }
  function team(box) {
    box.innerHTML = '<div class="dk-note">جاري التحميل...</div>';
    loadPeople().then(function (L) {
      box.innerHTML = '<div class="dk-team">' + L.map(function (m) {
        return '<div class="dk-m"><div><b>' + esc(m.name) + '</b> <span class="num">' + esc(m.phone) + '</span><small>' + (m.role === 'owner' ? 'صاحب المحل' : m.active ? 'عامل' : 'عامل — موقوف') + '</small></div>'
          + (m.role === 'owner' ? '<button type="button" data-pw="' + m.phone + '">كلمة سر جديدة</button>'
            : '<button type="button" data-pw="' + m.phone + '">كلمة سر</button><button type="button" data-act="' + m.phone + '" data-v="' + (m.active ? 0 : 1) + '">' + (m.active ? 'إيقاف' : 'تفعيل') + '</button><button type="button" data-rm="' + m.phone + '" class="r">حذف</button>'
              + '<details class="dk-perm" data-ph="' + m.phone + '"><summary>الصلاحيات</summary>' + PERM_L.map(function (p) { return '<label><input type="checkbox" data-pk="' + p[0] + '"' + (m.perms && m.perms[p[0]] ? ' checked' : '') + '> ' + p[1] + '</label>'; }).join('') + '</details>'
              + '<details class="dk-perm dk-salbox" data-ph="' + m.phone + '" data-nm="' + esc(m.name) + '"><summary>الراتب' + (m.salary ? ' · <span class="num">' + M(m.salary) + '</span>' : '') + '</summary><div class="dk-pw"><input class="l" inputmode="numeric" placeholder="الراتب الشهري" value="' + (m.salary || '') + '"><button type="button" data-salset>حفظ</button></div><div class="dk-salinfo"></div><div class="dk-pw"><input class="l" inputmode="numeric" placeholder="مبلغ التسليم" value="' + (m.salary || '') + '"><button type="button" data-salpay>سلّم الراتب</button></div></details>') + '</div>';
      }).join('') + '</div>'
        + '<div class="dk-add"><b>إضافة عامل</b><input id="dkAn" placeholder="اسم العامل"><input id="dkAp" class="l" inputmode="tel" placeholder="رقم تلفونه 07xxxxxxxxx"><input id="dkAw" placeholder="كلمة سر (6 حروف أو أكثر)"><button type="button" class="btn pri dk-btn" id="dkAg">أضف العامل</button><div class="dk-er" id="dkAe"></div></div>'
        + '<div class="dk-note">العامل يدخل برقمه وكلمة السر. افتح «الصلاحيات» تحت اسمه وحدد شنو يگدر يسوي. بدون صلاحية «الفلوس» ما يشوف الصندوق ولا الصرفيات ولا الأرباح ولا مجاميع الديون، بس يشوف دين كل زبون لحاله حتى يتابعه.</div>';
      var err = box.querySelector('#dkAe');
      box.querySelector('#dkAg').onclick = function () {
        var b = this; b.disabled = true;
        T.add({name: box.querySelector('#dkAn').value, phone: toEn(box.querySelector('#dkAp').value), password: box.querySelector('#dkAw').value})
          .then(function () { say('انضاف العامل ✓'); team(box); }).catch(function (e) { err.textContent = e.message; b.disabled = false; });
      };
      box.querySelectorAll('.dk-perm[data-ph] input[data-pk]').forEach(function (c) {
        c.onchange = function () {
          var d = c.closest('.dk-perm'), perms = {}; d.querySelectorAll('input[data-pk]').forEach(function (x) { perms[x.dataset.pk] = x.checked; });
          T.set(d.dataset.ph, {perms: perms}).then(function () { say('انحفظت الصلاحيات ✓ (تتطبق على أجهزته فوراً)'); }).catch(function (e) { say(e.message, false); c.checked = !c.checked; });
        };
      });
      box.querySelectorAll('.dk-salbox').forEach(function (d) {
        var ins = d.querySelectorAll('input'), info = d.querySelector('.dk-salinfo');
        d.addEventListener('toggle', function () { if (d.open) T.salary(d.dataset.ph).then(function (r) { info.innerHTML = salaryHTML(r, false); }).catch(function () {}); });
        d.querySelector('[data-salset]').onclick = function () { T.set(d.dataset.ph, {salary: +toEn(ins[0].value).replace(/\D/g, '') || 0}).then(function () { say('انحفظ الراتب ✓'); team(box); }).catch(function (e) { say(e.message, false); }); };
        d.querySelector('[data-salpay]').onclick = function () {
          var b = this, amt = +toEn(ins[1].value).replace(/\D/g, '') || 0;
          if (!amt) { say('اكتب مبلغ التسليم', false); return; }
          if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = 'تأكيد ' + M(amt) + '؟'; return; }
          b.disabled = true; payOne(d.dataset.ph, d.dataset.nm, amt, box).catch(function (e) { say(e.message || 'ما انسجل', false); b.disabled = false; });
        };
      });
      box.querySelectorAll('[data-act]').forEach(function (b) { b.onclick = function () { T.set(b.dataset.act, {active: b.dataset.v === '1'}).then(function () { team(box); }).catch(function (e) { say(e.message, false); }); }; });
      box.querySelectorAll('[data-rm]').forEach(function (b) { b.onclick = function () { if (b.dataset.sure) { T.remove(b.dataset.rm).then(function () { say('انحذف'); team(box); }).catch(function (e) { say(e.message, false); }); } else { b.dataset.sure = 1; b.textContent = 'متأكد؟'; } }; });
      box.querySelectorAll('[data-pw]').forEach(function (b) {
        b.onclick = function () {
          var row = b.closest('.dk-m'); if (row.querySelector('.dk-pw')) return;
          row.insertAdjacentHTML('beforeend', '<div class="dk-pw"><input placeholder="كلمة السر الجديدة"><button type="button">حفظ</button></div>');
          var i = row.querySelector('.dk-pw input'); i.focus();
          row.querySelector('.dk-pw button').onclick = function () {
            T.set(b.dataset.pw, {password: i.value}).then(function (r) {
              if (r.token && !sess.fb) { sess.token = r.token; LS.set('dk:session', JSON.stringify(sess)); }
              say('تغيّرت كلمة السر ✓'); team(box);
            }).catch(function (e) { say(e.message, false); });
          };
        };
      });
    }).catch(function (e) { box.innerHTML = '<div class="dk-er">' + esc(e.code === 'offline' ? 'تحتاج إنترنت حتى تدير العمال' : e.message) + '</div>'; });
  }
  document.addEventListener('DOMContentLoaded', function () {
    var st = document.createElement('style');
    st.textContent = '.dk-team{display:grid;gap:8px}.dk-m{background:#fff;border-radius:12px;padding:10px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}.dk-m>div:first-child{flex:1 1 160px}.dk-m small{display:block;color:#64748B;font-size:12px}'
      + '.dk-m button,.dk-pw button{border:0;border-radius:10px;background:#EEF2FF;color:#3730A3;font:inherit;font-size:13px;font-weight:600;min-height:36px;padding:0 10px;cursor:pointer}.dk-m button.r{background:#FFF1F2;color:#BE123C}'
      + '#dkNt{position:fixed;z-index:300;top:calc(10px + env(safe-area-inset-top));right:10px;left:10px;display:grid;gap:8px;pointer-events:none}@media(min-width:700px){#dkNt{left:auto;width:360px}}'
      + '.dk-nt{pointer-events:auto;display:flex;gap:10px;align-items:flex-start;background:#fff;color:#0F172A;border-radius:16px;padding:12px;box-shadow:0 16px 40px -14px rgba(15,23,42,.45);border:1px solid #E2E8F0;cursor:pointer;animation:dkIn .25s ease;transition:opacity .25s,transform .25s}'
      + '.dk-nt.out{opacity:0;transform:translateY(-8px)}.dk-nt img{width:36px;height:36px;border-radius:10px;flex:none}.dk-nt>div{flex:1;min-width:0}.dk-nt b{display:block;font-size:14.5px}.dk-nt span{display:block;font-size:13.5px;color:#475569;line-height:1.55}'
      + '.dk-nt .x{border:0;background:none;font-size:20px;line-height:1;color:#94A3B8;cursor:pointer;padding:0 4px}.dk-nt p{display:flex;gap:6px;margin:8px 0 0}.dk-nt p button{border:0;border-radius:10px;min-height:38px;padding:0 12px;font:inherit;font-size:13.5px;font-weight:700;cursor:pointer}.dk-nt p .y{background:#4338CA;color:#fff}.dk-nt p .n{background:#EEF2FF;color:#3730A3}'
      + '@keyframes dkIn{from{opacity:0;transform:translateY(-10px)}}@media(prefers-reduced-motion:reduce){.dk-nt{animation:none}}'
      + '.dk-perm{flex:1 1 100%;background:#F8FAFC;border-radius:10px;padding:6px 10px}.dk-perm summary{cursor:pointer;font-weight:600;font-size:13.5px;color:#3730A3;padding:4px 0}.dk-perm label{display:flex;gap:8px;align-items:center;font-size:13.5px;padding:5px 0}.dk-perm input[type=checkbox]{width:18px;height:18px;accent-color:#4338CA}'
      + '.dk-sal{display:grid;gap:4px}.dk-sal details summary{cursor:pointer;font-size:13px;color:#4338CA}.dk-row.small{font-size:13px}.dk-salinfo{margin:6px 0}'
      + '.dk-pw{display:flex;gap:6px;flex:1 1 100%}.dk-pw input,.dk-add input{flex:1;min-height:42px;border:1.5px solid #E2E8F0;border-radius:11px;padding:0 10px;font:inherit;font-size:16px}.dk-add{display:grid;gap:8px;margin-top:10px}.dk-add input.l{direction:ltr;text-align:right}.dk-er{color:#BE123C;font-size:13px;font-weight:600}';
    document.head.appendChild(st);
    // decide: a Firebase shop (or a link to join one), an account on our server, "trying without one", or the first screen
    if (window.DKFire && window.DKFire.has()) window.DKFire.boot(core);
    else if (sess && sess.token) startCloud();
    else if (choice === 'local') startLocal();
    else if (window.DKFire) window.DKFire.boot(core);
    else showLogin();
  });
})();
