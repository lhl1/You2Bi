require('./preload-app.cjs');
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('__YOUDUB2BI_DESKTOP__',{
  autoStart:value=>ipcRenderer.invoke('youdub2bi:auto-start',value),
  openFolder:path=>ipcRenderer.invoke('youdub2bi:open-folder',path),
});
