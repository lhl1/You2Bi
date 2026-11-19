import { spawn } from 'node:child_process';
export function jsonProcess(command,args,request,{cwd,signal,onProgress,timeout=180000}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,windowsHide:true,stdio:['pipe','pipe','pipe'],signal,env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'}});
    let buffer='',result,stderr='',settled=false;
    const timer=setTimeout(()=>{child.kill();finish(new Error('操作超时，请检查网络后重试'));},timeout);timer.unref();
    function finish(error){if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);}
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{buffer+=chunk;if(buffer.length>16*1024*1024){child.kill();finish(new Error('子进程输出过大'));return;}let line;while((line=buffer.indexOf('\n'))>=0){const raw=buffer.slice(0,line);buffer=buffer.slice(line+1);try{const value=JSON.parse(raw);if(value.event==='progress')onProgress?.(value);else result=value;}catch{}}});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000);});
    child.once('error',error=>finish(error));
    child.once('close',code=>{if(result?.ok)finish();else finish(Object.assign(new Error(result?.error || `子进程退出（${code}），请检查运行环境`),{code:result?.code}));});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request)+'\n');
  }).then(value=>value.result);
}
