// the only bridge between the app and Windows: update news in, "install now" out
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('dukkanDesktop', {
  version: () => ipcRenderer.invoke('dk:version'),
  onUpdate: cb => { ipcRenderer.on('dk:update', (e, s) => cb(s)); ipcRenderer.send('dk:ready'); },
  install: () => ipcRenderer.send('dk:install'),
  openDownload: () => ipcRenderer.send('dk:download'),
  check: () => ipcRenderer.send('dk:check'),
  session: s => ipcRenderer.send('dk:session', s || null)
});
