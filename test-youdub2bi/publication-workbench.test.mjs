import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Automation } from '../apps/harness/src/backend/automation/service.mjs';
import { AutomationStore } from '../apps/harness/src/backend/automation/store.mjs';

const bv='BV1abcdefghi', categories=[{id:17,name:'单机游戏'}];
const source={id:'abcdefghijk',title:'Physical discs on a console',channel:'Retro Channel',upload_date:'20261117',
  description:'Keep this link: https://example.org/a?x=1&y=2\nSee the original video.',language:'en'};
const plan={id:'channel',accountId:'primary',template:{fallbackTid:17,fallbackTags:['游戏','游戏机']},graph:{nodes:[
  {id:'bi-download',type:'youdub.download',config:{proxyPort:7897}},
  {id:'translate',type:'youdub.translate',provider:{id:'llm.retired',model:'retired'}},
  {id:'synthesize',type:'youdub.synthesize',config:{speechPerformance:'quality'}},
]}};
const metadata={title:'主机实体盘',description:source.description,tid:17,tags:['游戏']};
function result(state=0,visible=0){
  return {matched:true,details:{archive:{aid:42,bvid:bv,state,is_only_self:visible},videos:[{filename:'uploaded.mp4'}]}};
}
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'youdub-publication-'));
  const store=new AutomationStore(join(directory,'automation.sqlite')), records=new Map();
  const calls=[], file=join(directory,'video.mp4');
  await writeFile(file,Buffer.alloc(1024));
  store.saveAccount({id:'primary',ready:true});
  const context={
    logger:{error:()=>{}},settings:{read:async()=>({translator:{port:5000}})},
    catalog:{listProviders:()=>[]},
    files:{resolve:async()=>file,readLock:()=>()=>{}},
    store:{call:async(method,{ids})=>{
      assert.equal(method,'store.get_many');
      return ids.map(id=>records.get(id)).filter(Boolean);
    }},
    tasks:{record:async id=>records.get(id) ?? null,get:async id=>records.get(id) ?? null,
      create:async()=>assert.fail('Existing media must not be recreated'),
      retry:async()=>assert.fail('Completed media must not be retried')},
  };
  const automation=new Automation(context,{root:directory,data:directory,store,
    publicLookup:async()=>({aid:42,bvid:bv}),
    localTranslate:async(provider,config,key,texts)=>{
      assert.equal(provider,'libre');assert.equal(config.port,5000);assert.equal(key,undefined);
      assert.ok(texts.every(text=>!text.includes('https:')));
      return texts.map(text=>'中文版 '+text);
    },
    channelWorker:async request=>{
      assert.equal(request.command,'cover');assert.equal(request.proxyPort,7897);return {path:file};
    },
    transport:async(command,request,{onProgress}={})=>{
      calls.push(command);
      if(command==='categories')return {data:{type:categories}};
      if(command==='cover')return {url:'https://i0.hdslb.com/bfs/cover/test.jpg'};
      if(command==='upload'){onProgress({bytes:512,total:1024});return {filename:'uploaded'};}
      if(command==='submit')return {code:0,data:{aid:42,bvid:bv}};
      if(command==='reconcile')return result();
      assert.fail('Unexpected transport: '+command);
    },
  });
  t.after(async()=>{await automation.stop();await rm(directory,{recursive:true,force:true});});
  function add(patch={},input=source,config=plan){
    const job=store.saveJob({...store.enqueue(config,input),...patch});
    records.set(job.taskId,{id:job.taskId,status:'succeeded',attempt:3,updatedAt:'2026-11-18T01:24:00Z',steps:[],
      outputs:[{id:'video',role:'video',artifact:{id:'file'}}],artifacts:{file:{id:'file',mimeType:'video/mp4'}}});
    return job;
  }
  return {store,automation,context,records,calls,add,directory};
}

test('recovers the exact exported task, falls back locally, publishes once, and leaves cancellations alone',async t=>{
  const {store,automation,calls,add}=await fixture(t);
  const job=add({state:'needs_attention',error:'Pinned provider llm.retired is unavailable.'});
  const cancelled=add({state:'cancelled',error:'Pinned provider llm.retired is unavailable.'},{...source,id:'zzzzzzzzzzz'});
  await automation.mediaCycle();
  assert.equal(store.job(job.id).state,'ready_to_publish');
  assert.equal(store.job(cancelled.id).state,'cancelled');
  await automation.publicationCycle();
  const submitted=store.job(job.id);
  assert.equal(submitted.taskId,job.taskId);
  assert.equal(submitted.state,'awaiting_review');
  assert.equal(submitted.metadataOrigin,'local');
  assert.equal(submitted.metadata.tid,17);
  assert.deepEqual(submitted.metadata.tags,['游戏','游戏机']);
  assert.match(submitted.metadata.fullTranslation,/https:\/\/example\.org\/a\?x=1&y=2\n/);
  assert.ok(submitted.metadata.title.startsWith('[中配]'));
  assert.equal(submitted.bytesUploaded,1024);
  assert.deepEqual(calls,['categories','cover','upload','submit']);
  store.saveJob({...submitted,nextRun:0});
  await automation.reviewCycle();
  const detail=await automation.jobDetail(job.id);
  assert.equal(detail.publication.status,'已发布');
  assert.equal(detail.publication.timeline.every(step=>step.status==='done'),true);
  assert.equal(detail.publication.archive.url,'https://www.bilibili.com/video/'+bv);
  assert.equal(detail.publication.upload.percent,100);
  assert.equal(detail.uploaded,undefined);assert.equal(detail.studio,undefined);assert.equal(detail.receipt,undefined);
});

for(const lostResponse of [false,true])test(`remake replaces the same archive and verifies its new CID (${lostResponse?'lost edit response':'accepted edit'})`,async t=>{
  const {store,automation,context,records,add}=await fixture(t);
  const old=add({state:'published',aid:42,bvid:bv,publishedAt:1,cleanedAt:2,uploaded:{filename:'previous'},metadata:{...metadata,is_only_self:0}});
  const completedMedia=records.get(old.taskId);
  records.delete(old.taskId);
  const detail=await automation.jobDetail(old.id);
  assert.equal(detail.publication.canRemake,true);
  assert.equal(detail.publication.mediaAvailable,false);
  automation.transport=async(command,request)=>{
    assert.equal(command,'reconcile');assert.equal(request.filename,'previous');
    const response=result();response.details.videos=[{filename:'previous',cid:7}];return response;
  };
  const made=await automation.control(old.id,'remake');
  assert.notEqual(made.taskId,old.taskId);
  assert.equal(automation.project(made,null).archive.bvid,bv);
  await assert.rejects(automation.control(old.id,'remake'),{code:'PUBLICATION_REMAKE'});
  assert.equal(made.cleanedAt,null);
  store.saveSettings({...store.settings(),speechPerformance:'balanced'});
  context.files.reserve=async id=>{
    assert.equal(id,made.taskId);return async()=>{};
  };
  context.tasks.create=async input=>{
    assert.equal(input.id,made.taskId);
    assert.equal(input.nodeRuntimeInputs['bi-download'].url,'https://www.youtube.com/watch?v='+source.id);
    assert.equal(input.graphDocument.nodes.find(node=>node.id==='synthesize').config.speechPerformance,'balanced');
    records.set(input.id,{...completedMedia,id:input.id});
  };
  await automation.mediaCycle();
  assert.equal(store.job(old.id).state,'processing');
  store.saveJob({...store.job(old.id),nextRun:0});
  let cid=7;
  const called=[];
  automation.publicLookup=async()=>({aid:42,bvid:bv,cid});
  automation.transport=async(command,request)=>{
    called.push(command);
    if(command==='upload')return {filename:'uploaded'};
    if(command==='replace_video'){
      assert.equal(request.aid,42);assert.equal(request.previousFilename,'previous');assert.equal(request.previousCid,7);assert.equal(request.filename,'uploaded');
      if(lostResponse)throw new Error('Connection interrupted after editing');
      return {code:0};
    }
    if(command==='reconcile'){
      assert.equal(request.aid,42);
      const response=result();response.details.videos[0].cid=10;return response;
    }
    assert.fail(command);
  };
  await automation.mediaCycle();await automation.publicationCycle();
  assert.equal(store.job(old.id).state,lostResponse?'reconciling':'awaiting_review');
  store.saveJob({...store.job(old.id),nextRun:0});await automation.reviewCycle();
  assert.equal(store.job(old.id).state,'awaiting_review');
  cid=10;store.saveJob({...store.job(old.id),nextRun:0});await automation.reviewCycle();
  const finished=store.job(old.id);
  assert.equal(finished.state,'published');assert.equal(finished.bvid,bv);assert.equal(finished.replacement,null);
  assert.deepEqual(called,['upload','replace_video','reconcile','reconcile']);
});

test('an entirely original soundtrack proceeds to publication with a translated title and no dubbing prefix',async t=>{
  const {store,automation,records,add,calls}=await fixture(t);
  const job=add({state:'queued',graph:plan.graph});
  const record=records.get(job.taskId);
  record.steps=[{id:'export',status:'completed',outputs:{dubbingSummary:{dubbedSegments:0,preservedRanges:3}}}];
  await automation.mediaCycle();
  assert.equal(store.job(job.id).dubbedSegments,0);
  await automation.publicationCycle();
  assert.equal(store.job(job.id).state,'awaiting_review');
  assert.equal(store.job(job.id).metadata.title,'中文版 '+source.title);
  assert.deepEqual(calls,['categories','cover','upload','submit']);
});

test('cleanup removes only the local directories of a publicly confirmed job',async t=>{
  const {store,automation,context,records,add,directory}=await fixture(t);
  const accepted={state:'awaiting_review',aid:42,bvid:bv,uploaded:{filename:'uploaded'},coverUrl:'https://i0.hdslb.com/cover.jpg'};
  const job=add({...accepted,metadata:{...metadata,is_only_self:0}});
  records.get(job.taskId).steps=[{id:'prepare',status:'completed',outputs:{mediaInfo:{duration_ms:705183}}}];
  const privateJob=add({...accepted,metadata:{...metadata,is_only_self:1}},{...source,id:'zzzzzzzzzzz'});
  context.files.taskRoot=id=>join(directory,'tasks',id);
  context.tasks.delete=async(id,attempt)=>{
    assert.equal(id,job.taskId);assert.equal(attempt,3);
    await rm(context.files.taskRoot(id),{recursive:true});records.delete(id);
  };
  for(const item of [job,privateJob]){
    for(const path of [context.files.taskRoot(item.taskId),join(directory,'automation',item.id)]){
      await mkdir(path,{recursive:true});await writeFile(join(path,'material'), 'media');
    }
  }
  await automation.cleanupCycle();
  assert.ok(await stat(context.files.taskRoot(job.taskId)));
  await automation.reconcile(job);
  await automation.cleanupCycle();
  const view=(await automation.jobDetail(job.id)).publication;
  assert.equal(view.archive.url,'https://www.bilibili.com/video/'+bv);
  assert.ok(view.cleanedAt);assert.equal(view.mediaAvailable,false);
  assert.equal(view.durationSeconds,705.183);
  await assert.rejects(stat(context.files.taskRoot(job.taskId)),{code:'ENOENT'});
  await assert.rejects(stat(join(directory,'automation',job.id)),{code:'ENOENT'});
  assert.ok(await stat(context.files.taskRoot(privateJob.taskId)));
  assert.ok(await stat(join(directory,'automation',privateJob.id)));
});

test('an upgraded release recovers jobs parked by the old workflow check',async t=>{
  const {store,automation,context,records,add}=await fixture(t);
  const job=add({state:'needs_attention',failurePhase:'media',errorCode:'WORKFLOW_VERSION_UNAVAILABLE',failedMediaAttempt:4});
  records.set(job.taskId,{id:job.taskId,status:'failed',attempt:4,allowedActions:['retry'],
    error:{code:'WORKFLOW_VERSION_UNAVAILABLE',message:'Pinned workflow is unavailable.'}});
  context.tasks.retry=async(id,attempt)=>{assert.equal(id,job.taskId);assert.equal(attempt,4);};
  await automation.mediaCycle();
  assert.equal(store.job(job.id).state,'processing');
  assert.equal(store.job(job.id).workflowRecoveryVersion,'dev');
  assert.equal(store.job(job.id).taskId,job.taskId);
});

test('an interrupted media job backs off, then resumes the same attempt lineage',async t=>{
  const {store,automation,context,records,add}=await fixture(t);
  const job=add({state:'needs_attention',failurePhase:'media',errorCode:'APP_INTERRUPTED',failedMediaAttempt:3});
  records.set(job.taskId,{id:job.taskId,status:'failed',attempt:3,allowedActions:['retry'],
    steps:[{id:'bi-download',status:'completed'},{id:'translate',status:'failed'}],
    error:{code:'APP_INTERRUPTED',message:'Interrupted'}});
  let retried=0;
  context.tasks.retry=async(id,attempt)=>{assert.equal(id,job.taskId);assert.equal(attempt,3);retried++;};
  await automation.mediaCycle();
  assert.equal(store.job(job.id).state,'retry_wait');
  assert.equal(retried,0);
  store.saveJob({...store.job(job.id),nextRun:0});
  await automation.mediaCycle();
  assert.equal(retried,1);
  assert.equal(store.job(job.id).state,'processing');
  assert.equal(store.job(job.id).mediaRetryStage,'translate');
});

test('the publication queue honors the translator Retry-After without retrying early',async t=>{
  const {store,automation,context,records,add}=await fixture(t);
  const job=add({state:'processing'});
  records.set(job.taskId,{id:job.taskId,status:'failed',attempt:3,
    steps:[{id:'translate',status:'failed'}],
    error:{code:'RATE_LIMIT',status:429,message:'Rate limited',details:{retryAfterMs:125_000}}});
  let retried=0;
  context.tasks.retry=async()=>{retried++;};
  const start=Date.now();
  await automation.mediaCycle();
  const waiting=store.job(job.id);
  assert.equal(waiting.state,'retry_wait');
  assert.ok(waiting.nextRun>=start+125_000 && waiting.nextRun<=Date.now()+125_000);
  await automation.mediaCycle();
  assert.equal(retried,0);
});

test('missing fallback fields park at an editable draft and a valid edit resumes without re-encoding',async t=>{
  const {store,automation,add}=await fixture(t);
  const job=add({state:'queued'},source,{...plan,template:{}});
  await automation.mediaCycle();await automation.publicationCycle();
  const detail=await automation.jobDetail(job.id);
  assert.equal(detail.publication.status,'文案待处理');
  assert.equal(detail.publication.phase,'metadata');
  assert.equal(detail.publication.action,'edit');
  assert.ok(detail.draft.title.includes('中文版'));
  assert.equal(store.job(job.id).uploaded,undefined);
  await assert.rejects(automation.updateMetadata(job.id,{...metadata,expectedUpdatedAt:detail.revision-1}),{code:'PUBLICATION_REVISION'});
  await automation.updateMetadata(job.id,{...metadata,expectedUpdatedAt:detail.revision});
  assert.equal(store.job(job.id).state,'ready_to_publish');
  await automation.publicationCycle();
  assert.equal(store.job(job.id).state,'awaiting_review');
  assert.equal(store.job(job.id).metadataOrigin,'manual');
});

test('ambiguous response never resubmits; creator approval must also pass anonymous visibility',async t=>{
  const {store,automation,calls,add}=await fixture(t);
  const job=add({state:'queued'});
  const delivery=automation.transport;
  automation.transport=async(command,...params)=>{
    if(command==='submit'){calls.push(command);throw new Error('connection dropped after request');}
    return delivery(command,...params);
  };
  automation.publicLookup=async()=>null;
  await automation.mediaCycle();await automation.publicationCycle();
  const pending=store.job(job.id);
  assert.equal(pending.state,'reconciling');assert.equal(pending.submissionStarted,true);
  await assert.rejects(automation.control(job.id,'retry'),/只能核对/);
  await automation.control(job.id,'verify');await automation.reviewCycle();
  assert.equal(store.job(job.id).state,'awaiting_review');
  assert.match(store.job(job.id).reviewReason,/等待匿名访问可见/);
  automation.publicLookup=async()=>({aid:42,bvid:bv});
  await automation.control(job.id,'verify');await automation.reviewCycle();
  assert.equal(store.job(job.id).state,'published');
  assert.equal(calls.filter(command=>command==='submit').length,1);
  assert.equal(calls.filter(command=>command==='upload').length,1);
});

test('upload progress and review run independently, and an interrupted upload reuses its draft and cover',async t=>{
  const {store,automation,calls,add}=await fixture(t);
  const upload=add({state:'queued'}), review=add({state:'awaiting_review',submissionStarted:true,aid:42,bvid:bv,
    uploaded:{filename:'uploaded'},metadata:{is_only_self:0,title:'已有稿件'},nextRun:0},{...source,id:'yyyyyyyyyyy'});
  await automation.mediaCycle();
  const delivery=automation.transport;
  let signal,rejectUpload;
  const started=new Promise(resolve=>{signal=resolve;});
  automation.transport=async(command,request,options)=>{
    if(command==='upload'){
      calls.push(command);options.onProgress({bytes:256,total:1024});
      return new Promise((resolve,reject)=>{rejectUpload=reject;signal();});
    }
    return delivery(command,request,options);
  };
  const active=automation.publicationCycle();
  await started;
  const progress=(await automation.jobDetail(upload.id)).publication;
  assert.equal(progress.phase,'upload');assert.equal(progress.progress,25);
  await automation.reviewCycle();assert.equal(store.job(review.id).state,'published');
  rejectUpload(new Error('temporary interruption'));
  await active;
  assert.equal(store.job(upload.id).state,'retry_wait');
  const saved=store.job(upload.id);assert.ok(saved.metadata && saved.coverUrl);
  automation.transport=delivery;
  store.saveJob({...saved,nextRun:0});await automation.publicationCycle();
  assert.equal(store.job(upload.id).state,'awaiting_review');
  assert.equal(calls.filter(command=>command==='cover').length,1);
  assert.equal(calls.filter(command=>command==='upload').length,2);
});

test('paged workbench searches by title and library links omit auth data and original receipts',async t=>{
  const {automation,add}=await fixture(t);
  const first=add({state:'needs_attention',error:'401 access_key=fixture-secret',receipt:{key:'internal-receipt'}});
  add({state:'cancelled'},{...source,id:'yyyyyyyyyyy',title:'Other subject'});
  const page=await automation.jobPage(new URLSearchParams({group:'attention',q:'retro channel',limit:'1'}));
  assert.equal(page.counts.all,2);assert.equal(page.counts.attention,1);
  assert.deepEqual(page.items.map(item=>item.id),[first.id]);
  assert.equal(page.items[0].mediaReady,true);
  assert.doesNotMatch(JSON.stringify(page),/fixture-secret|internal-receipt/);
  const links=await automation.jobLinks(new URLSearchParams({taskIds:first.taskId+',local-only'}));
  assert.equal(links.items.length,1);assert.equal(links.items[0].taskId,first.taskId);
});

test('expired Bilibili sign-in during review keeps the original submission locked',async t=>{
  const {store,automation,add}=await fixture(t);
  const job=add({state:'awaiting_review',submissionStarted:true,aid:42,bvid:bv,nextRun:0,
    uploaded:{filename:'uploaded'},metadata:{title:'原稿件',is_only_self:0}});
  automation.transport=async()=>{throw new Error('B 站登录已失效，请扫码');};
  await automation.reviewCycle();
  const detail=await automation.jobDetail(job.id);
  assert.equal(detail.state,'needs_login');assert.equal(detail.publication.action,'login');
  assert.equal(detail.publication.archive.aid,42);
  assert.equal(store.job(job.id).submissionStarted,true);
  await assert.rejects(automation.control(job.id,'retry'),/只能核对/);
});

test('Bilibili transcoding stays in the review queue and does not submit again',async t=>{
  const {store,automation,add}=await fixture(t);
  const job=add({state:'awaiting_review',submissionStarted:true,aid:42,bvid:bv,nextRun:0,
    uploaded:{filename:'uploaded'},metadata:{title:'原稿件',is_only_self:0}});
  automation.transport=async command=>{
    assert.equal(command,'reconcile');
    const pending=result(-60);pending.details.archive.state_desc='转码中';
    return pending;
  };
  await automation.reviewCycle();
  const current=await automation.jobDetail(job.id);
  assert.equal(current.state,'awaiting_review');
  assert.equal(current.publication.status,'B 站转码中');
  assert.ok(current.publication.nextRunAt>Date.now());
});


test('production time includes only completed media stages and survives material cleanup', async () => {
  const {productionTiming}=await import('../apps/harness/src/backend/automation/publication-view.mjs');
  const start=Date.UTC(2026,10,19);
  const step=(id,seconds)=>({id,label:id,status:'completed',startedAt:new Date(start).toISOString(),finishedAt:new Date(start+seconds*1000).toISOString()});
  const media={status:'succeeded',steps:[step('bi-download',10),step('translate',20),step('synthesize',30),step('export',40),step('upload',999),step('review',888)]};
  const timing=productionTiming({},media);
  assert.equal(timing.totalMs,100000);
  assert.deepEqual(timing.stages.map(row=>row.id),['bi-download','translate','synthesize','export']);
  assert.deepEqual(productionTiming({productionTiming:timing},null),timing);
  assert.equal(productionTiming({}, {status:'succeeded',steps:[{id:'export',status:'completed'}]}).totalMs,null);
  assert.equal(productionTiming({}, {...media,status:'running'}).totalMs,null);
});

