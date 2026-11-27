// دكّان — Windows app. It opens the website in its own window, so every update on the site reaches it by itself.
const {app, BrowserWindow, shell, session, Menu} = require('electron');
const path = require('path');
const cfg = require('./config.json');
const START = cfg.url;
const ORIGIN = new URL(START).origin;

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.setAppUserModelId('app.dukkan.desktop');
let win = null;

function create() {
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 380, minHeight: 600,
    title: 'دكّان', icon: path.join(__dirname, 'icon.png'), backgroundColor: '#1E1B4B', autoHideMenuBar: true, show: false,
    webPreferences: {contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false}
  });
  Menu.setApplicationMenu(null);
  win.webContents.setUserAgent(win.webContents.getUserAgent() + ' DukkanDesktop/' + app.getVersion());
  win.once('ready-to-show', () => win.show());
  win.loadURL(START).catch(() => {});
  // no internet and nothing saved yet: a friendly page with a retry button
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (isMain && code !== -3 && !url.startsWith('file:')) win.loadFile(path.join(__dirname, 'offline.html'), {query: {u: START}});
  });
  // links to other sites (WhatsApp, GitHub…) open in the normal browser
  win.webContents.setWindowOpenHandler(({url}) => { if (/^https?:|^mailto:|^tel:|^whatsapp:/.test(url)) shell.openExternal(url); return {action: 'deny'}; });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(ORIGIN) || url.startsWith('file:')) return;
    e.preventDefault(); if (/^https?:|^whatsapp:/.test(url)) shell.openExternal(url);
  });
  // F5 reloads, Ctrl+P prints, Ctrl +/- zoom — like a browser
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    if (i.key === 'F5') { win.webContents.reloadIgnoringCache(); e.preventDefault(); }
    if (i.control && (i.key === '=' || i.key === '+')) { win.webContents.setZoomLevel(win.webContents.getZoomLevel() + .5); e.preventDefault(); }
    if (i.control && i.key === '-') { win.webContents.setZoomLevel(win.webContents.getZoomLevel() - .5); e.preventDefault(); }
    if (i.control && i.key === '0') { win.webContents.setZoomLevel(0); e.preventDefault(); }
  });
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  // the camera (barcode) and the clipboard are allowed only for our own site
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, d) => {
    const ok = (d.requestingUrl || '').startsWith(ORIGIN) && ['media', 'clipboard-sanitized-write', 'fullscreen', 'notifications'].includes(perm);
    cb(ok);
  });
  create();
});
app.on('window-all-closed', () => app.quit());
