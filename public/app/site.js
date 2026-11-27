/* دكّان — website layer: storage on the device, files, automatic update, install and the Windows app.
   Loaded before the app itself. The app is the same file that runs inside Claude. */
(function () {
  'use strict';
  window.APP_SITE = true;
  window.APP_VERSION = '2026.11.27-1853';
  var desktop = /DukkanDesktop\//.test(navigator.userAgent);
  window.APP_DESKTOP = desktop;

  /* ---------- 1) the lists live in IndexedDB on this device (localStorage only holds 5 MB) ---------- */
  var dbp = null;
  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise(function (ok, bad) {
      try {
        var r = indexedDB.open('dukkan', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('c'); };
        r.onsuccess = function () { ok(r.result); };
        r.onerror = function () { bad(r.error); };
        r.onblocked = function () { bad(new Error('blocked')); };
      } catch (e) { bad(e); }
    });
    return dbp;
  }
  var pend = {}, timer = 0, failed = false;
  function flush() {
    clearTimeout(timer); timer = 0;
    var items = Object.keys(pend).map(function (k) { return [k, pend[k]]; }); pend = {};
    if (!items.length) return Promise.resolve();
    return openDB().then(function (db) {
      return new Promise(function (ok, bad) {
        var tx = db.transaction('c', 'readwrite'), st = tx.objectStore('c');
        items.forEach(function (it) { st.put(it[1], it[0]); });
        tx.oncomplete = ok; tx.onerror = function () { bad(tx.error); }; tx.onabort = function () { bad(tx.error); };
      });
    }).catch(function () {
      if (!failed) { failed = true; try { toast('ما انحفظت البيانات على هذا الجهاز! سوّي نسخة احتياطية هسه.', false); } catch (e) {} }
    });
  }
  window.__idbSave = function (name, list) { pend[name] = list; if (!timer) timer = setTimeout(flush, 150); return true; };
  window.__idbLoad = function () {
    return openDB().then(function (db) {
      return new Promise(function (ok, bad) {
        var out = {}, rq = db.transaction('c').objectStore('c').openCursor();
        rq.onsuccess = function () { var c = rq.result; if (c) { out[c.key] = c.value; c.continue(); } else ok(out); };
        rq.onerror = function () { bad(rq.error); };
      });
    }).then(function (all) {
      // anything saved by an older copy in localStorage moves over once
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i), m = /^shop_(.+)_v1$/.exec(k || '');
          if (m && !all[m[1]]) { try { all[m[1]] = JSON.parse(localStorage.getItem(k) || '[]'); pend[m[1]] = all[m[1]]; } catch (e) {} }
        }
        if (Object.keys(pend).length) flush();
      } catch (e) {}
      try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
      return all;
    }).catch(function (e) {
      delete window.__idbSave;   // no IndexedDB here: the app falls back to localStorage by itself
      throw e;
    });
  };
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });

  /* ---------- 2) saving files (backup, PDF): a normal download, or the share sheet on iPhone ---------- */
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var downloads = {
    save: function (o) {
      var data = o.data, name = o.filename || 'file';
      var type = name.slice(-4) === '.pdf' ? 'application/pdf' : name.slice(-5) === '.json' ? 'application/json' : 'application/octet-stream';
      var blob = data instanceof Blob ? data : new Blob([data], {type: type});
      var plain = function () {
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.rel = 'noopener';
        document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 8000);
      };
      if (isIOS && navigator.canShare) {
        try {
          var f = new File([blob], name, {type: blob.type || type});
          if (navigator.canShare({files: [f]})) {
            return navigator.share({files: [f], title: name}).catch(function (e) { if (e && e.name === 'AbortError') throw {code: 'declined'}; plain(); });
          }
        } catch (e) {}
      }
      plain(); return Promise.resolve();
    }
  };
  // the app asks Claude for its abilities; on the website only "downloads" exists — the rest answer "not here"
  window.claude = {use: function (name) { return Promise.resolve(name === 'downloads' ? downloads : null); }};

  /* ---------- 3) automatic update: every time the app opens ---------- */
  function readCfg() { return fetch('version.json?t=' + Date.now(), {cache: 'no-store'}).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); }
  var cfgP = readCfg();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        reg.update().catch(function () {});
        cfgP.then(function (c) {
          if (!c || !c.version || c.version === window.APP_VERSION) return;
          var k = 'dk:upd:' + c.version;
          try { if (sessionStorage.getItem(k)) return; sessionStorage.setItem(k, '1'); } catch (e) {}
          try { localStorage.setItem('dk:updated', c.version); } catch (e) {}
          // the new copy is fetched fresh; reload once when it is ready
          var done = false, go = function () { if (!done) { done = true; location.reload(); } };
          navigator.serviceWorker.addEventListener('controllerchange', go);
          reg.update().then(function () { setTimeout(go, 1500); }).catch(go);
        });
      }).catch(function () {});
    }
  }
  addEventListener('load', function () {
    try {
      var v = localStorage.getItem('dk:updated');
      if (v) { localStorage.removeItem('dk:updated'); setTimeout(function () { try { toast('انحدث التطبيق للنسخة الجديدة ✓'); } catch (e) {} }, 1800); }
    } catch (e) {}
  });

  /* ---------- 4) settings: version, install, the Windows app ---------- */
  var installEv = null;
  addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEv = e; });
  var standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function box(c) {
    var exe = c && c.exe && !/OWNER\/REPO/.test(c.exe) ? c.exe : '';
    var rows = [];
    rows.push('<div class="dk-row"><span>نسخة التطبيق</span><b class="num">' + esc(window.APP_VERSION) + '</b></div>');
    rows.push('<div class="dk-note">يتحدث لحاله كل ما تفتحه وأنت متصل بالإنترنت.</div>');
    if (desktop) rows.push('<div class="dk-note">أنت تستخدم نسخة الحاسبة (ويندوز).</div>');
    else {
      if (installEv && !standalone) rows.push('<button type="button" class="btn ghost dk-btn" id="dkInstall">ثبّت التطبيق على هذا الجهاز</button>');
      if (isIOS && !standalone) rows.push('<div class="dk-note">للآيفون: من Safari اضغط زر المشاركة ثم <b>إضافة إلى الشاشة الرئيسية</b>.</div>');
      rows.push(exe ? '<a class="btn pri dk-btn" href="' + esc(exe) + '" target="_blank" rel="noopener">نزّل نسخة الحاسبة (ويندوز EXE)</a>'
        : '<div class="dk-note">نسخة الحاسبة (EXE) تتوفر بعد ربط GitHub.</div>');
    }
    rows.push('<div class="dk-note dk-warn">بياناتك محفوظة على هذا الجهاز بس. سوّي نسخة احتياطية بشكل دوري.</div>');
    return '<div class="dk-box" id="dkBox"><div class="dk-h">التطبيق</div>' + rows.join('') + '</div>';
  }
  function inject() {
    var fs = document.getElementById('fs'); if (!fs || document.getElementById('dkBox')) return;
    var h = fs.querySelector('.pk-h h3'); if (!h || h.textContent.trim() !== 'الإعدادات') return;
    cfgP.then(function (c) {
      if (document.getElementById('dkBox')) return;
      var form = fs.querySelector('#fsForm'); if (!form) return;
      form.insertAdjacentHTML('afterbegin', box(c));
      var b = document.getElementById('dkInstall');
      if (b) b.onclick = function () { installEv.prompt(); installEv.userChoice.finally(function () { installEv = null; b.remove(); }); };
    });
  }
  document.addEventListener('DOMContentLoaded', function () {
    var st = document.createElement('style');
    st.textContent = '.dk-box{background:#EEF2FF;border-radius:16px;padding:14px;margin:0 0 14px;display:grid;gap:8px}.dk-h{font-weight:700;font-size:15px;color:#3730A3}'
      + '.dk-row{display:flex;justify-content:space-between;align-items:center;font-size:14.5px}.dk-row b{direction:ltr}.dk-note{font-size:13px;color:#475569;line-height:1.6}'
      + '.dk-warn{color:#B45309}.dk-btn{display:flex;align-items:center;justify-content:center;min-height:46px;text-decoration:none;width:100%}';
    document.head.appendChild(st);
    var fs = document.getElementById('fs');
    if (fs) new MutationObserver(inject).observe(fs, {childList: true});
  });
})();
