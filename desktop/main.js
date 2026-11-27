// دكّان — Windows app. The whole app is INSIDE this program (works with no internet from the first run).
// When there is internet it looks for a newer version and tells the app, which shows "حدّث هسه".
const {app, BrowserWindow, shell, session, protocol, net, Menu, ipcMain} = require('electron');
const path = require('path');
const fs = require('fs');
const {pathToFileURL} = require('url');
const cfg = (() => { try { return require('./config.json'); } catch (e) { return {}; } })();
let autoUpdater = null;
try { ({autoUpdater} = require('electron-updater')); } catch (e) {}

const crypto = require('crypto');
const BUNDLE = path.join(__dirname, 'app');                       // the app as it came inside the program
let ROOT = BUNDLE;                                                // what is shown now (a newer copy may live in userData/web)
const SITE = (cfg.url || '').replace(/\/app\/?$/, '');          // https://dukkan.….workers.dev
const DOWNLOAD = cfg.download || (SITE ? SITE + '/#install' : '');
const bundled = (() => { try { return JSON.parse(fs.readFileSync(path.join(BUNDLE, 'version.json'), 'utf8')).version || ''; } catch (e) { return ''; } })();
let active = bundled, webPending = null, webBusy = false;

// app://dukkan/ is a real, secure address: storage, camera and printing work like on the website
protocol.registerSchemesAsPrivileged([{scheme: 'app', privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true}}]);

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('app.dukkan.desktop');
let win = null, state = {stage: 'idle'}, rendererReady = false;
const send = s => { state = {...s, appVersion: app.getVersion(), webVersion: active}; if (win && rendererReady) win.webContents.send('dk:update', state); };

function create() {
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 380, minHeight: 600,
    title: 'دكّان', icon: path.join(__dirname, 'icon.png'), backgroundColor: '#1E1B4B', autoHideMenuBar: true, show: false,
    webPreferences: {preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false}
  });
  Menu.setApplicationMenu(null);
  win.webContents.setUserAgent(win.webContents.getUserAgent() + ' DukkanDesktop/' + app.getVersion());
  win.once('ready-to-show', () => win.show());
  win.loadURL('app://dukkan/index.html');
  win.webContents.on('did-start-loading', () => { rendererReady = false; });
  // links to other sites (WhatsApp, the website…) open outside
  win.webContents.setWindowOpenHandler(({url}) => { if (/^(https?|mailto|tel|whatsapp):/.test(url)) shell.openExternal(url); return {action: 'deny'}; });
  win.webContents.on('will-navigate', (e, url) => { if (url.startsWith('app://dukkan/')) return; e.preventDefault(); if (/^(https?|mailto|tel|whatsapp):/.test(url)) shell.openExternal(url); });
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    if (i.key === 'F5') { win.webContents.reload(); e.preventDefault(); }
    if (i.control && (i.key === '=' || i.key === '+')) { win.webContents.setZoomLevel(win.webContents.getZoomLevel() + .5); e.preventDefault(); }
    if (i.control && i.key === '-') { win.webContents.setZoomLevel(win.webContents.getZoomLevel() - .5); e.preventDefault(); }
    if (i.control && i.key === '0') { win.webContents.setZoomLevel(0); e.preventDefault(); }
    if (i.control && i.shift && i.key.toLowerCase() === 'i') { win.webContents.toggleDevTools(); e.preventDefault(); }
  });
}

/* ---------- updates ---------- */
const newer = (a, b) => String(a || '') > String(b || '');   // versions look like 2026.11.27-1906, so text order = time order
/* fast update: only the app's own files (about 1 MB), not the whole program */
const WEB = () => path.join(app.getPath('userData'), 'web');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function pickRoot() {
  try {
    const cur = JSON.parse(fs.readFileSync(path.join(WEB(), 'current.json'), 'utf8')), dir = path.join(WEB(), cur.version);
    if (newer(cur.version, bundled) && fs.existsSync(path.join(dir, 'index.html')) && fs.existsSync(path.join(dir, 'version.json'))) { ROOT = dir; active = cur.version; }
  } catch (e) {}
}
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
      try { const b = fs.readFileSync(have); if (sha(b) === f.sha256) buf = b; } catch (e) {}    // unchanged: copied from the phone, not downloaded
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
    fs.writeFileSync(path.join(WEB(), 'current.json'), JSON.stringify({version: v.version}));   // next opening uses it even if "later" was pressed
    // keep only the newest two copies
    try { fs.readdirSync(WEB()).filter(n => /^\d{4}\./.test(n) && n !== v.version && n !== active).sort().slice(0, -1).forEach(n => fs.rmSync(path.join(WEB(), n), {recursive: true, force: true})); } catch (e) {}
    webPending = {version: v.version, dir};
    send({stage: 'web-ready', version: v.version});
    return true;
  } catch (e) {
    send({stage: 'idle'}); return false;
  } finally { webBusy = false; }
}
function applyWeb() {
  if (!webPending) return false;
  ROOT = webPending.dir; active = webPending.version; webPending = null;
  send({stage: 'idle'}); win && win.webContents.reloadIgnoringCache();
  return true;
}
async function checkSite() {
  // second way, if the program's own updater can't reach GitHub: compare with the website
  if (!SITE) return;
  try {
    const r = await net.fetch(SITE + '/app/version.json?t=' + Date.now(), {cache: 'no-store'});
    if (!r.ok) return;
    const v = await r.json();
    if (newer(v.version, bundled) && !['available', 'downloading', 'ready'].includes(state.stage)) send({stage: 'manual', version: v.version});
  } catch (e) {}
}
async function checkNow() {
  send({stage: 'checking'});
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
  autoUpdater.on('update-downloaded', i => send({stage: 'ready', version: i.version}));
  autoUpdater.on('update-not-available', () => { if (!webPending) send({stage: 'latest'}); });
  autoUpdater.on('error', () => { if (!webPending) send({stage: 'idle'}); });
}
ipcMain.handle('dk:version', () => ({app: app.getVersion(), web: active}));
ipcMain.on('dk:ready', e => { rendererReady = true; e.sender.send('dk:update', {...state, appVersion: app.getVersion(), webVersion: active}); });
ipcMain.on('dk:install', () => {
  if (applyWeb()) return;
  if (state.stage === 'ready' && autoUpdater) { setImmediate(() => autoUpdater.quitAndInstall(false, true)); }
  else if (DOWNLOAD) shell.openExternal(DOWNLOAD);
});
ipcMain.on('dk:download', () => { if (DOWNLOAD) shell.openExternal(DOWNLOAD); });
ipcMain.on('dk:check', () => checkNow());

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
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
  create();
  setupUpdater();
  setTimeout(checkNow, 2500);                       // on every opening…
  setInterval(checkNow, 3 * 60 * 60 * 1000);        // …and every 3 hours while it stays open
});
app.on('window-all-closed', () => app.quit());
