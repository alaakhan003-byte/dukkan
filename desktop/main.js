// دكّان — Windows app. The whole app is INSIDE this program (works with no internet from the first run).
// When there is internet it looks for a newer version and tells the app, which shows "حدّث هسه".
const {app, BrowserWindow, shell, session, protocol, net, Menu, ipcMain} = require('electron');
const path = require('path');
const fs = require('fs');
const {pathToFileURL} = require('url');
const cfg = (() => { try { return require('./config.json'); } catch (e) { return {}; } })();
let autoUpdater = null;
try { ({autoUpdater} = require('electron-updater')); } catch (e) {}

const ROOT = path.join(__dirname, 'app');
const SITE = (cfg.url || '').replace(/\/app\/?$/, '');          // https://dukkan.….workers.dev
const DOWNLOAD = cfg.download || (SITE ? SITE + '/#install' : '');
const bundled = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')).version || ''; } catch (e) { return ''; } })();

// app://dukkan/ is a real, secure address: storage, camera and printing work like on the website
protocol.registerSchemesAsPrivileged([{scheme: 'app', privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true}}]);

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('app.dukkan.desktop');
let win = null, state = {stage: 'idle'}, rendererReady = false;
const send = s => { state = {...s, appVersion: app.getVersion(), webVersion: bundled}; if (win && rendererReady) win.webContents.send('dk:update', state); };

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
function checkNow() {
  if (!app.isPackaged || !autoUpdater) { checkSite(); return; }
  send({stage: 'checking'});
  autoUpdater.checkForUpdates().catch(() => checkSite());
}
function setupUpdater() {
  if (!autoUpdater) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', i => send({stage: 'downloading', version: i.version, percent: 0}));
  autoUpdater.on('download-progress', p => send({stage: 'downloading', version: state.version, percent: Math.round(p.percent || 0)}));
  autoUpdater.on('update-downloaded', i => send({stage: 'ready', version: i.version}));
  autoUpdater.on('update-not-available', () => { send({stage: 'latest'}); checkSite(); });
  autoUpdater.on('error', () => { send({stage: 'idle'}); checkSite(); });
}
ipcMain.handle('dk:version', () => ({app: app.getVersion(), web: bundled}));
ipcMain.on('dk:ready', e => { rendererReady = true; e.sender.send('dk:update', {...state, appVersion: app.getVersion(), webVersion: bundled}); });
ipcMain.on('dk:install', () => { if (state.stage === 'ready' && autoUpdater) { setImmediate(() => autoUpdater.quitAndInstall(false, true)); } else if (DOWNLOAD) shell.openExternal(DOWNLOAD); });
ipcMain.on('dk:download', () => { if (DOWNLOAD) shell.openExternal(DOWNLOAD); });
ipcMain.on('dk:check', () => checkNow());

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  protocol.handle('app', req => {
    const u = new URL(req.url);
    let p = decodeURIComponent(u.pathname); if (!p || p === '/') p = '/index.html';
    const f = path.normalize(path.join(ROOT, p));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return new Response('not found', {status: 404});
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
