import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { archiveBvid, archiveId } from './publication-view.mjs';

const starts = new Map();
async function libreReady(port, signal) {
  try {
    const response=await fetch('http://127.0.0.1:'+port+'/languages',{redirect:'error',
      signal:AbortSignal.any([signal,AbortSignal.timeout(2000)])});
    if(!response.ok)return false;
    const languages=await response.json();
    return Array.isArray(languages) && languages.some(item=>item.code==='en')
      && languages.some(item=>['zh','zh-Hans'].includes(item.code));
  } catch { signal.throwIfAborted(); return false; }
}
export async function ensureLibreTranslate(port, signal) {
  if(await libreReady(port,signal))return;
  if(process.platform!=='win32'||!process.env.LOCALAPPDATA)throw new Error('本机 LibreTranslate 尚未启动');
  if(!starts.has(port)){
    const work=(async()=>{
      const directory=join(process.env.LOCALAPPDATA,'YouDub2bi','LibreTranslate');
      const executable=join(directory,'venv','Scripts','libretranslate.exe');
      await access(executable);
      signal.throwIfAborted();
      const child=spawn(executable,['--host','127.0.0.1','--port',String(port),'--load-only','en,zh,ja'],
        {cwd:directory,stdio:'ignore',detached:true,windowsHide:true});
      let exited=false;
      child.once('error',()=>{exited=true;});
      child.once('exit',()=>{exited=true;});
      child.unref();
      const until=Date.now()+45_000;
      do {
        if(await libreReady(port,signal))return;
        if(exited)break;
        await delay(1500,undefined,{signal});
      } while(Date.now()<until);
      throw new Error('本机 LibreTranslate 未就绪');
    })();
    starts.set(port,work);
    work.finally(()=>starts.delete(port)).catch(()=>{});
  }
  await starts.get(port);
}

export async function verifyPublicArchive({ aid, bvid }, signal) {
  if(!archiveId(aid))return null;
  const url=new URL('https://api.bilibili.com/x/web-interface/view');
  if(archiveBvid(bvid))url.searchParams.set('bvid',bvid);
  else url.searchParams.set('aid',String(aid));
  try {
    const response=await fetch(url,{redirect:'error',headers:{referer:'https://www.bilibili.com/'},
      signal:AbortSignal.any([signal,AbortSignal.timeout(12_000)])});
    if(!response.ok)return null;
    const body=await response.json(), data=body?.data;
    if(body.code!==0 || archiveId(data?.aid)!==archiveId(aid) || !archiveBvid(data?.bvid))return null;
    if(archiveBvid(bvid) && bvid!==data.bvid)return null;
    return {aid:archiveId(data.aid),bvid:data.bvid,cid:archiveId(data.cid)};
  } catch { signal.throwIfAborted(); return null; }
}
