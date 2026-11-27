// دكّان — Windows app. The whole app is INSIDE this program (works with no internet from the first run).
// It updates by itself: the app's own files (about 1 MB) come from the website in seconds,
// even while the window is closed (the program stays next to the clock and starts with Windows).
const {app, BrowserWindow, shell, session, protocol, net, Menu, Tray, nativeImage, Notification, ipcMain, powerMonitor} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {pathToFileURL} = require('url');
const cfg = (() => { try { return require('./config.json'); } catch (e) { return {}; } })();
let autoUpdater = null;
try { ({autoUpdater} = require('electron-updater')); } catch (e) {}

const BUNDLE = path.join(__dirname, 'app');                       // the app as it came inside the program
let ROOT = BUNDLE;                                                // what is shown now (a newer copy may live in userData/web)
const SITE = (cfg.url || '').replace(/\/app\/?$/, '');          // https://dukkan.….workers.dev
const DOWNLOAD = cfg.download || (SITE ? SITE + '/#install' : '');
const bundled = (() => { try { return JSON.parse(fs.readFileSync(path.join(BUNDLE, 'version.json'), 'utf8')).version || ''; } catch (e) { return ''; } })();
let active = bundled, webPending = null, webBusy = false, programReady = null;

// app://dukkan/ is a real, secure address: storage, camera and printing work like on the website
protocol.registerSchemesAsPrivileged([{scheme: 'app', privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true}}]);

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.setAppUserModelId('app.dukkan.desktop');
let win = null, tray = null, quitting = false, state = {stage: 'idle'}, rendererReady = false, lastInput = 0, openedAt = 0;
const UD = f => path.join(app.getPath('userData'), f);
const flag = (f, v) => { try { if (v === undefined) return fs.existsSync(UD(f)); if (v) fs.writeFileSync(UD(f), '1'); else fs.rmSync(UD(f), {force: true}); } catch (e) {} return false; };
const send = s => { state = {...s, appVersion: app.getVersion(), webVersion: active}; if (win && !win.isDestroyed() && rendererReady) win.webContents.send('dk:update', state); };

/* ---------- the window ---------- */
function showWindow() {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return; }
  // a newer copy downloaded while the window was closed is used straight away
  if (webPending) { ROOT = webPending.dir; active = webPending.version; webPending = null; state = {stage: 'idle'}; }
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 380, minHeight: 600,
    title: 'دكّان', icon: path.join(__dirname, 'icon.png'), backgroundColor: '#1E1B4B', autoHideMenuBar: true, show: false,
    webPreferences: {preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false}
  });
  openedAt = Date.now(); lastInput = 0; rendererReady = false;
  win.webContents.setUserAgent(win.webContents.getUserAgent() + ' DukkanDesktop/' + app.getVersion());
  win.once('ready-to-show', () => win.show());
  win.loadURL('app://dukkan/index.html');
  win.webContents.on('did-start-loading', () => { rendererReady = false; });
  win.webContents.setWindowOpenHandler(({url}) => { if (/^(https?|mailto|tel|whatsapp):/.test(url)) shell.openExternal(url); return {action: 'deny'}; });
  win.webContents.on('will-navigate', (e, url) => { if (url.startsWith('app://dukkan/')) return; e.preventDefault(); if (/^(https?|mailto|tel|whatsapp):/.test(url)) shell.openExternal(url); });
  win.webContents.on('before-input-event', (e, i) => {
    lastInput = Date.now();
    if (i.type !== 'keyDown') return;
    if (i.key === 'F5') { win.webContents.reload(); e.preventDefault(); }
    if (i.control && (i.key === '=' || i.key === '+')) { win.webContents.setZoomLevel(win.webContents.getZoomLevel() + .5); e.preventDefault(); }
    if (i.control && i.key === '-') { win.webContents.setZoomLevel(win.webContents.getZoomLevel() - .5); e.preventDefault(); }
    if (i.control && i.key === '0') { win.webContents.setZoomLevel(0); e.preventDefault(); }
    if (i.control && i.shift && i.key.toLowerCase() === 'i') { win.webContents.toggleDevTools(); e.preventDefault(); }
  });
  win.on('blur', () => setTimeout(autoApply, 400));
  win.on('minimize', () => setTimeout(autoApply, 400));
  // closing the window keeps the program next to the clock, so it can still update by itself
  win.on('close', e => {
    if (quitting || !tray) return;
    if (!flag('told-tray')) { flag('told-tray', true); try { new Notification({title: 'دكّان', body: 'دكّان يبقى شغّال جنب الساعة حتى يتحدث لحاله. تگدر تسده نهائياً من هناك.'}).show(); } catch (e2) {} }
  });
  win.on('closed', () => { win = null; rendererReady = false; if (programReady && !quitting) installProgram(); });
}

/* ---------- notifications: a live line to the shop, even with the window closed ---------- */
let sess = null, ws = null, wsTry = 0, wsTimer = 0, pingTimer = 0, lastEv = 0;
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(UD(f), 'utf8')); } catch (e) { return d; } };
const writeJSON = (f, v) => { try { if (v == null) fs.rmSync(UD(f), {force: true}); else fs.writeFileSync(UD(f), JSON.stringify(v)); } catch (e) {} };
const notifyOn = () => !flag('notify-off');
function notify(title, body) {
  if (!notifyOn() || !Notification.isSupported()) return;
  if (win && !win.isDestroyed() && win.isFocused()) return;          // the open app shows its own note on the side
  try {
    const n = new Notification({title, body, icon: path.join(__dirname, 'icon.png'), silent: false});
    n.on('click', () => { showWindow(); setTimeout(() => { try { win && win.webContents.executeJavaScript("location.hash='invoices'"); } catch (e) {} }, 600); });
    n.show();
  } catch (e) {}
}
async function catchUp() {
  // what happened while the computer was off or the program was closed
  if (!sess || !SITE) return;
  try {
    const r = await net.fetch(`${SITE}/api/events?since=${lastEv}`, {headers: {authorization: 'Bearer ' + sess.token}, cache: 'no-store'});
    if (!r.ok) return;
    const L = await r.json(); if (!Array.isArray(L) || !L.length) return;
    const first = !lastEv; lastEv = L[L.length - 1].id; writeJSON('events.json', {last: lastEv, shop: sess.shop});
    if (first) return;                                                // first connection on this computer: no flood of old news
    const others = L.filter(e => !e.mine);
    if (others.length && others.length <= 3) others.forEach(e => notify(e.title, e.body));
    else if (others.length) notify(`صار ${others.length} حركات وانت غايب`, others.slice(-3).map(e => e.title).join(' · '));
  } catch (e) {}
}
function live() {
  clearTimeout(wsTimer);
  if (!sess || !SITE || typeof WebSocket === 'undefined') return;
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  try { ws = new WebSocket(SITE.replace(/^http/, 'ws') + '/api/live?shop=' + encodeURIComponent(sess.shop)); } catch (e) { return; }
  const me = ws;
  me.onopen = () => me.send(JSON.stringify({auth: sess.token}));
  me.onmessage = e => {
    if (e.data === 'pong') return;
    let m; try { m = JSON.parse(String(e.data)); } catch (x) { return; }
    if (m.t === 'ok') { wsTry = 0; catchUp(); }
    else if (m.t === 'ev') { if (m.id > lastEv) { lastEv = m.id; writeJSON('events.json', {last: lastEv, shop: sess.shop}); } if (m.by !== sess.phone) notify(m.title, m.body); }
    else if (m.t === 'bye') { sess = null; }
  };
  me.onclose = () => {
    if (ws === me) ws = null;
    clearInterval(pingTimer);
    if (!sess) return;
    wsTimer = setTimeout(live, Math.min(60000, 2000 * Math.pow(2, wsTry++)));
  };
  me.onerror = () => {};
  clearInterval(pingTimer); pingTimer = setInterval(() => { try { if (me.readyState === 1) me.send('ping'); } catch (e) {} }, 25000);
}
function setSession(s) {
  const changed = JSON.stringify(s) !== JSON.stringify(sess);
  sess = s && s.token ? s : null;
  writeJSON('session.json', sess);
  if (!changed) return;
  try { ws && ws.close(); } catch (e) {} ws = null;
  const ev = readJSON('events.json', {});
  lastEv = sess && ev.shop === sess.shop ? +ev.last || 0 : 0;
  if (sess) live();
}
ipcMain.on('dk:session', (e, s) => setSession(s));

/* ---------- next to the clock ---------- */
function makeTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({width: 32, height: 32});
    tray = new Tray(img);
    tray.setToolTip('دكّان — نظام المحل');
    const menu = () => Menu.buildFromTemplate([
      {label: 'افتح دكّان', click: showWindow},
      {label: 'تحقق من التحديث', click: () => checkNow()},
      {label: 'الإشعارات', type: 'checkbox', checked: notifyOn(), click: m => flag('notify-off', !m.checked)},
      {type: 'separator'},
      {label: 'يشتغل مع تشغيل الحاسبة', type: 'checkbox', checked: !!app.getLoginItemSettings({args: ['--hidden']}).openAtLogin, click: m => app.setLoginItemSettings({openAtLogin: m.checked, args: ['--hidden']})},
      {type: 'separator'},
      {label: 'سد دكّان نهائياً', click: () => { quitting = true; app.quit(); }}
    ]);
    tray.setContextMenu(menu());
    tray.on('right-click', () => tray.setContextMenu(menu()));
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
  } catch (e) { tray = null; }
}

/* ---------- updates ---------- */
const newer = (a, b) => String(a || '') > String(b || '');   // versions look like 2026.11.27-1906, so text order = time order
const WEB = () => UD('web');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function pickRoot() {
  try {
    const cur = JSON.parse(fs.readFileSync(path.join(WEB(), 'current.json'), 'utf8')), dir = path.join(WEB(), cur.version);
    if (newer(cur.version, bundled) && fs.existsSync(path.join(dir, 'index.html')) && fs.existsSync(path.join(dir, 'version.json'))) { ROOT = dir; active = cur.version; }
  } catch (e) {}
}
// fast update: only the app's own files that changed (about 1 MB), never the whole program
async function webUpdate() {
  if (!SITE || webBusy) return false;
  webBusy = true;
  try {
    const r = await net.fetch(SITE + '/app/version.json?t=' + Date.now(), {cache: 'no-store'});
    if (!r.ok) return false;
    const raw = await r.text(), v = JSON.parse(raw);
    if (!v.version || !Array.isArray(v.files) || !newer(v.version, active)) return false;
    if (v.minShell && newer(v.minShell, app.getVersion())) return false;      // needs a new program: the full updater handles it
    if (webPending && webPending.version === v.version) { send({stage: 'web-ready', version: v.version}); return true; }
    const dir = path.join(WEB(), v.version), tmp = dir + '.part';
    fs.rmSync(tmp, {recursive: true, force: true}); fs.mkdirSync(tmp, {recursive: true});
    send({stage: 'downloading', version: v.version, percent: 0, fast: true});
    let done = 0;
    for (const f of v.files) {
      if (!/^[\w./-]+$/.test(f.path) || f.path.includes('..')) throw new Error('bad path');
      const out = path.join(tmp, f.path), have = path.join(ROOT, f.path);
      fs.mkdirSync(path.dirname(out), {recursive: true});
      let buf = null;
      try { const b = fs.readFileSync(have); if (sha(b) === f.sha256) buf = b; } catch (e) {}    // unchanged: copied from this computer, not downloaded
      if (!buf) {
        const res = await net.fetch(SITE + '/app/' + f.path + '?v=' + encodeURIComponent(v.version), {cache: 'no-store'});
        if (!res.ok) throw new Error('download ' + f.path);
        buf = Buffer.from(await res.arrayBuffer());
        if (sha(buf) !== f.sha256) throw new Error('check ' + f.path);         // a broken download never gets used
      }
      fs.writeFileSync(out, buf);
      done++; send({stage: 'downloading', version: v.version, percent: Math.round(done / v.files.length * 100), fast: true});
    }
    fs.writeFileSync(path.join(tmp, 'version.json'), raw);
    fs.rmSync(dir, {recursive: true, force: true}); fs.renameSync(tmp, dir);
    fs.writeFileSync(path.join(WEB(), 'current.json'), JSON.stringify({version: v.version}));   // the next opening uses it anyway
    try { fs.readdirSync(WEB()).filter(n => /^\d{4}\./.test(n) && n !== v.version && n !== active).sort().slice(0, -1).forEach(n => fs.rmSync(path.join(WEB(), n), {recursive: true, force: true})); } catch (e) {}
    webPending = {version: v.version, dir};
    if (!win) { ROOT = dir; active = v.version; webPending = null; state = {stage: 'idle'}; }    // window closed: just switch
    else { send({stage: 'web-ready', version: v.version}); setTimeout(autoApply, 300); }
    return true;
  } catch (e) {
    send({stage: 'idle'}); return false;
  } finally { webBusy = false; }
}
// apply by itself at a quiet moment: right after opening (before any typing), when the window is left, or after 90 seconds of no use
function autoApply(force) {
  if (!webPending || !win || win.isDestroyed()) return false;
  const quiet = force || !lastInput || !win.isFocused() || win.isMinimized() || Date.now() - lastInput > 90000 || (powerMonitor.getSystemIdleTime?.() || 0) > 90;
  if (!quiet) return false;
  const v = webPending.version;
  ROOT = webPending.dir; active = v; webPending = null; state = {stage: 'idle'};
  win.webContents.executeJavaScript(`try{localStorage.setItem('dk:updated',${JSON.stringify(v)})}catch(e){}`).catch(() => {}).finally(() => win && !win.isDestroyed() && win.webContents.reloadIgnoringCache());
  return true;
}
// the whole program (rare): downloaded quietly, installed when the window is closed or on quitting
function installProgram() {
  if (!programReady || !autoUpdater) return;
  flag('start-hidden', !win);           // installed in the background → comes back next to the clock, not as a window
  quitting = true;
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}
async function checkNow() {
  if (state.stage !== 'downloading') send({stage: 'checking'});
  if (await webUpdate()) return;                                   // fast way first
  if (!app.isPackaged || !autoUpdater) { if (state.stage === 'checking') send({stage: 'latest'}); return; }
  autoUpdater.checkForUpdates().catch(() => send({stage: 'idle'}));
}
function setupUpdater() {
  if (!autoUpdater) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', i => send({stage: 'downloading', version: i.version, percent: 0}));
  autoUpdater.on('download-progress', p => send({stage: 'downloading', version: state.version, percent: Math.round(p.percent || 0)}));
  autoUpdater.on('update-downloaded', i => { programReady = i.version; if (!win) installProgram(); else send({stage: 'ready', version: i.version}); });
  autoUpdater.on('update-not-available', () => { if (!webPending && state.stage === 'checking') send({stage: 'latest'}); });
  autoUpdater.on('error', () => { if (!webPending && state.stage !== 'web-ready') send({stage: 'idle'}); });
}
ipcMain.handle('dk:version', () => ({app: app.getVersion(), web: active}));
ipcMain.on('dk:ready', e => {
  rendererReady = true; e.sender.send('dk:update', {...state, appVersion: app.getVersion(), webVersion: active});
  if (webPending && Date.now() - openedAt < 15000 && !lastInput) autoApply(true);   // just opened and nothing typed yet
});
ipcMain.on('dk:install', () => {
  if (autoApply(true)) return;
  if (programReady && autoUpdater) installProgram();
  else if (DOWNLOAD) shell.openExternal(DOWNLOAD);
});
ipcMain.on('dk:download', () => { if (DOWNLOAD) shell.openExternal(DOWNLOAD); });
ipcMain.on('dk:check', () => checkNow());

app.on('second-instance', () => showWindow());
app.on('before-quit', () => { quitting = true; });
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  pickRoot();
  protocol.handle('app', req => {
    const u = new URL(req.url);
    let p = decodeURIComponent(u.pathname); if (!p || p === '/') p = '/index.html';
    let f = path.normalize(path.join(ROOT, p));
    if (!f.startsWith(ROOT)) return new Response('no', {status: 403});
    if ((!fs.existsSync(f) || fs.statSync(f).isDirectory()) && ROOT !== BUNDLE) f = path.normalize(path.join(BUNDLE, p));
    if (!f.startsWith(ROOT) && !f.startsWith(BUNDLE)) return new Response('no', {status: 403});
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return new Response('not found', {status: 404});
    return net.fetch(pathToFileURL(f).toString());
  });
  // camera (barcode) and clipboard: only for the app itself
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, d) => cb(String(d.requestingUrl || wc.getURL()).startsWith('app://dukkan') && ['media', 'clipboard-sanitized-write', 'fullscreen', 'notifications'].includes(perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm, origin) => String(origin || '').startsWith('app://dukkan') && ['media', 'clipboard-sanitized-write', 'fullscreen'].includes(perm));
  makeTray();
  // starts with Windows (quietly, next to the clock) — set once, the person can switch it off from the clock menu
  if (app.isPackaged && !flag('login-set')) { try { app.setLoginItemSettings({openAtLogin: true, args: ['--hidden']}); } catch (e) {} flag('login-set', true); }
  const hidden = process.argv.includes('--hidden') || flag('start-hidden');
  flag('start-hidden', false);
  if (!hidden || !tray) showWindow();
  setupUpdater();
  sess = readJSON('session.json', null); { const ev = readJSON('events.json', {}); lastEv = sess && ev.shop === sess.shop ? +ev.last || 0 : 0; }
  if (sess) live();
  setTimeout(checkNow, 1500);                         // on every start…
  setInterval(checkNow, 60 * 60 * 1000);              // …every hour, open or closed
  powerMonitor.on('resume', () => { setTimeout(checkNow, 8000); wsTry = 0; try { ws && ws.close(); } catch (e) {} setTimeout(live, 3000); });   // and after the computer wakes up
});
app.on('window-all-closed', () => { if (!tray) { quitting = true; app.quit(); } });
