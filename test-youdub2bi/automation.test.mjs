import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {AutomationStore} from '../apps/harness/src/backend/automation/store.mjs';
import {makeMetadata,sourceDate,categoryList,autoGraph} from '../apps/harness/src/backend/automation/metadata.mjs';
import {Automation} from '../apps/harness/src/backend/automation/service.mjs';
import {jsonProcess} from '../apps/harness/src/backend/automation/process.mjs';
const source={id:'abcdefghijk',title:'An original title',channel:'Original creator',upload_date:'20261117',description:'Original description'};
const categories=[{id:201,name:'科学科普'},{id:202,name:'数码'}];
const translated={title:'示例中文标题',description:'原介绍中文翻译',tid:201,tags:['科学','技术','研究','科普','学习','知识']};
function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'youdub2bi-test-'));const store=new AutomationStore(join(directory,'automation.sqlite'));
 t.after(()=>{try{store.close()}catch{}rmSync(directory,{recursive:true,force:true});});
 const ctx={logger:{error:()=>{}},tasks:{record:async()=>({status:'succeeded',outputs:[{id:'video',role:'video',artifact:{id:'output'}}],artifacts:{output:{mimeType:'video/mp4'}}})},files:{resolve:async()=>join(directory,'output.mp4')}};
 store.saveAccount({id:'primary',mid:'42',ready:true});
 const automation=new Automation(ctx,{root:directory,data:directory,python:process.execPath,store,transport:async()=>{throw new Error('Unexpected network request')},channelWorker:async()=>{throw new Error('Unexpected channel request')}});
 return {directory,store,automation,ctx};
}

test('YouTube login failures wait without treating the Bilibili account as expired',async t=>{
 const {automation,store}=fixture(t);const job=store.enqueue({id:'c',accountId:'primary',template:{},graph:{}},source);
 automation.step=async()=>{throw Object.assign(new Error('YouTube 要求登录验证。B 站账号无需重新登录。'),{code:'YOUTUBE_AUTH_REQUIRED'})};
 await automation.queue();assert.equal(store.job(job.id).state,'needs_youtube_login');assert.equal(store.accounts()[0].ready,true);
 automation.step=async()=>{throw new Error('Must not retry the blocked request')};await automation.queue();assert.equal(store.job(job.id).attempts,1);
});

test('a newly imported YouTube login resumes original blocked jobs once',async t=>{
 const {automation,store}=fixture(t);const blocked=store.enqueue({id:'c',accountId:'primary',template:{},graph:{}},source);store.saveJob({...blocked,state:'needs_attention',error:"Sign in to confirm you're not a bot"});
 const paused=store.enqueue({id:'c',accountId:'primary',template:{},graph:{}},{...source,id:'zzzzzzzzzzz'});store.saveJob({...paused,state:'paused',error:'YouTube 要求登录验证'});
 let retries=0;automation.ctx.tasks.get=async()=>({status:'failed',attempt:2});automation.ctx.tasks.retry=async(id,attempt)=>{assert.equal(id,blocked.taskId);assert.equal(attempt,2);retries++};
 const status={configured:true,importedAt:123};assert.deepEqual(await automation.resumeYoutube(status),[blocked.id]);assert.equal(store.job(blocked.id).taskId,blocked.taskId);assert.equal(store.job(blocked.id).state,'queued');assert.equal(store.job(paused.id).state,'paused');
 assert.deepEqual(await automation.resumeYoutube(status),[]);assert.equal(retries,1);
});

test('YouTube recovery waits for a globally paused queue to resume',async t=>{
 const {automation,store}=fixture(t);const job=store.enqueue({id:'c',accountId:'primary',template:{},graph:{}},source);store.saveJob({...job,state:'needs_youtube_login'});store.saveSettings({...store.settings(),paused:true});
 let called=false;automation.control=async()=>{called=true};const status={configured:true,importedAt:456};
 assert.deepEqual(await automation.resumeYoutube(status),[]);assert.equal(called,false);assert.equal(store.settings().youtubeAuthAppliedAt,undefined);
 store.saveSettings({...store.settings(),paused:false});assert.deepEqual(await automation.resumeYoutube(status),[job.id]);assert.equal(called,true);
});
test('an Edge credential file update wakes a waiting task without a manual import',async t=>{
 const {directory,automation,store}=fixture(t);
 const job=store.enqueue({id:'c',accountId:'primary',template:{},graph:{}},source);
 store.saveJob({...job,state:'needs_youtube_login'});
 store.saveSettings({...store.settings(),youtubeAuthAppliedAt:100});
 let status={configured:true,importedAt:100};
 automation.youtube=async command=>{assert.equal(command,'status');return status};
 automation.ctx.tasks.get=async()=>({status:'failed',attempt:2});
 automation.ctx.tasks.retry=async id=>assert.equal(id,job.taskId);
 const folder=join(directory,'youtube'), file=join(folder,'session.credential');
 await mkdir(folder);await writeFile(file,'fixture');
 await automation.syncYoutubeQueue();assert.equal(store.job(job.id).state,'needs_youtube_login');
 const {utimes}=await import('node:fs/promises');
 await utimes(file,Date.now()/1000+2,Date.now()/1000+2);
 status={configured:true,importedAt:200};
 await automation.syncYoutubeQueue();assert.equal(store.job(job.id).state,'queued');
 assert.equal(store.settings().youtubeAuthAppliedAt,200);
});
function prepared(store,patch={}){const channel={id:'channel',channelId:'UC1234567890123456789012',accountId:'primary',template:{},graph:{nodes:[]}};const job=store.enqueue(channel,source);return store.saveJob({...job,metadata:makeMetadata(source,translated,categories),coverUrl:'https://archive.biliimg.com/cover.jpg',uploaded:{filename:'unique-upload',desc:'',title:null},...patch});}
function publicationFixture(t){
 const value=fixture(t);value.automation.graph=async(workflow,proxyPort)=>({nodes:[{id:'bi-download',config:{proxyPort}}],workflow});value.ctx.catalog={workflow:()=>({graph:{compile:async()=>({})}})};return value;
}
test('manual video creates a full automatic job without adding a monitored channel',async t=>{
 const {automation,store}=publicationFixture(t);automation.channelWorker=async input=>{assert.equal(input.command,'video');assert.equal(input.proxyPort,7897);assert.equal(input.url,'https://www.youtube.com/watch?v=abcdefghijk');return source;};
 const result=await automation.addVideo({url:'https://youtu.be/abcdefghijk?t=10'});assert.equal(result.duplicate,false);assert.equal(result.job.state,'queued');assert.equal(result.job.origin,'manual');assert.equal(store.channels().length,0);assert.equal(store.jobs()[0].graph.nodes[0].config.proxyPort,7897);
});
test('manual URL variants and channel monitoring share duplicate protection',async t=>{
 const {automation,store}=publicationFixture(t);let calls=0;automation.channelWorker=async()=>{calls++;return source;};
 const first=await automation.addVideo({url:'https://youtu.be/abcdefghijk'});const second=await automation.addVideo({url:'https://www.youtube.com/shorts/abcdefghijk'});assert.equal(second.duplicate,true);assert.equal(second.job.id,first.job.id);assert.equal(calls,1);assert.equal(store.enqueue({id:'monitored',accountId:'primary',graph:{},template:{}},source),null);
});
test('concurrent manual additions atomically create only one job',async t=>{
 const {automation,store}=publicationFixture(t);automation.channelWorker=async()=>source;
 const result=await Promise.all([automation.addVideo({url:'https://youtu.be/abcdefghijk'}),automation.addVideo({url:'https://www.youtube.com/watch?v=abcdefghijk'})]);assert.equal(store.jobs().length,1);assert.equal(result.filter(item=>item.duplicate).length,1);
});

function selectableChannel(store){return store.saveChannel({id:'selected-channel',channelId:'UC1234567890123456789012',name:'Creator',url:'https://www.youtube.com/@creator/videos',accountId:'primary',proxyPort:0,workflowId:'custom',enabled:false,addedAt:Date.now(),cursor:'unchanged',template:{fixedTags:['游戏']},graph:{}});}
test('channel browsing keeps cursor and queue untouched while annotating duplicates',async t=>{
 const {automation,store}=publicationFixture(t),channel=selectableChannel(store);const job=store.enqueue(channel,source);
 automation.channelWorker=async input=>{assert.equal(input.command,'browse');assert.equal(input.offset,30);assert.equal(input.proxyPort,0);return {channelId:channel.channelId,nextOffset:60,videos:[{id:source.id,title:source.title,selectable:true}]};};
 const result=await automation.channelVideos(channel.id,{offset:30});assert.equal(result.videos[0].job.id,job.id);assert.equal(result.nextOffset,60);assert.equal(store.channels()[0].cursor,'unchanged');assert.equal(store.jobs().length,1);
});
test('batch selection uses channel configuration, skips duplicates and reports partial failure',async t=>{
 const {automation,store}=publicationFixture(t),channel=selectableChannel(store);store.saveSettings({...store.settings(),paused:true});store.enqueue(channel,source);
 const requested=[];automation.channelWorker=async input=>{requested.push(input.url);if(input.url.includes('yyyyyyyyyyy'))throw new Error('Video unavailable');return {...source,id:'zzzzzzzzzzz',channel_id:channel.channelId};};
 const result=await automation.addChannelVideos(channel.id,{videoIds:[source.id,'zzzzzzzzzzz','yyyyyyyyyyy','zzzzzzzzzzz']});
 assert.deepEqual([result.added,result.duplicates,result.failed,result.paused],[1,1,1,true]);assert.equal(requested.length,2);assert.equal(store.jobs().length,2);const job=store.jobForVideo('zzzzzzzzzzz','primary');assert.equal(job.graph.workflow,'custom');assert.equal(job.graph.nodes[0].config.proxyPort,0);assert.equal(job.origin,'channel_selection');assert.deepEqual(job.template.fixedTags,['游戏']);assert.equal(store.channels()[0].cursor,'unchanged');assert.equal(store.channels()[0].enabled,false);
 const again=await automation.addChannelVideos(channel.id,{videoIds:['zzzzzzzzzzz']});assert.equal(again.duplicates,1);assert.equal(requested.length,2);
});
test('batch rejects a different creator and a channel removed during metadata lookup',async t=>{
 const {automation,store}=publicationFixture(t),channel=selectableChannel(store);
 automation.channelWorker=async()=>({...source,channel_id:'UCxxxxxxxxxxxxxxxxxxxxxx'});const wrong=await automation.addChannelVideos(channel.id,{videoIds:[source.id]});assert.equal(wrong.failed,1);assert.match(wrong.results[0].error,/属于/);assert.equal(store.jobs().length,0);
 automation.channelWorker=async()=>{store.deleteChannel(channel.id);return {...source,channel_id:channel.channelId};};const removed=await automation.addChannelVideos(channel.id,{videoIds:[source.id]});assert.equal(removed.failed,1);assert.equal(store.jobs().length,0);
});
test('invalid bulk selections and page bounds do not reach the network',async t=>{
 const {automation,store}=publicationFixture(t),channel=selectableChannel(store);
 for(const videoIds of [[],['invalid'],Array(51).fill(source.id),null])await assert.rejects(automation.addChannelVideos(channel.id,{videoIds}),/请选择/);
 for(const input of [{offset:-1},{offset:10001},{limit:0},{limit:61}])await assert.rejects(automation.channelVideos(channel.id,input),/分页参数/);
 await assert.rejects(automation.channelVideos('missing'),/不存在/);assert.equal(store.jobs().length,0);
});
test('missing watch-page channel ID requires server-fetched membership, not a matching display name',async t=>{
 const {automation,store}=publicationFixture(t),channel=selectableChannel(store);
 automation.channelWorker=async input=>input.command==='browse'?{channelId:channel.channelId,videos:[{id:source.id,title:source.title,selectable:true}],nextOffset:null}:{...source,channel_id:null,channel:channel.name};
 const unverified=await automation.addChannelVideos(channel.id,{videoIds:[source.id]});assert.equal(unverified.failed,1);assert.equal(store.jobs().length,0);
 await automation.channelVideos(channel.id);const verified=await automation.addChannelVideos(channel.id,{videoIds:[source.id]});assert.equal(verified.added,1);
});
test('batch metadata lookup limits concurrency and shares atomic duplicate protection',async t=>{
 const {automation,store}=publicationFixture(t),channel=selectableChannel(store);let active=0,peak=0;
 automation.channelWorker=async input=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,5));active--;return {...source,id:new URL(input.url).searchParams.get('v'),channel_id:channel.channelId};};
 const videoIds=Array.from({length:7},(_,index)=>'abcdefghij'+index);const results=await Promise.all([automation.addChannelVideos(channel.id,{videoIds}),automation.addChannelVideos(channel.id,{videoIds})]);assert.equal(store.jobs().length,7);assert.equal(results.reduce((sum,result)=>sum+result.added,0),7);assert.ok(peak<=6);assert.ok(peak>1);
});
test('manual task inherits channel settings and respects explicit direct connection',async t=>{
 const {automation,store}=publicationFixture(t);store.saveChannel({id:'channel',channelId:'UC1234567890123456789012',accountId:'primary',workflowId:'custom',proxyPort:1080,template:{fixedTid:202,fixedTags:['频道标签']}});automation.channelWorker=async input=>{assert.equal(input.proxyPort,0);return source;};
 await automation.addVideo({url:'https://youtu.be/abcdefghijk',channelId:'channel',proxyPort:0});const job=store.jobs()[0];assert.equal(job.template.fixedTid,202);assert.deepEqual(job.template.fixedTags,['频道标签']);assert.equal(job.graph.workflow,'custom');
});
test('manual task rejects non-YouTube URLs, missing channels and mismatched metadata',async t=>{
 const {automation,store}=publicationFixture(t);await assert.rejects(automation.addVideo({url:'https://www.bilibili.com/video/BV1abcdefghj'}),/仅支持/);await assert.rejects(automation.addVideo({url:'https://youtube.com/playlist?list=abc'}));await assert.rejects(automation.addVideo({url:'https://youtu.be/abcdefghijk',channelId:'missing'}),/不存在/);automation.channelWorker=async()=>({...source,id:'zzzzzzzzzzz'});await assert.rejects(automation.addVideo({url:'https://youtu.be/abcdefghijk'}),/信息与链接不一致/);assert.equal(store.jobs().length,0);
});
test('proxy defaults migrate once and preserve later explicit zero or custom ports',t=>{
 const {store,directory}=fixture(t);assert.equal(store.settings().proxyPort,7897);store.saveSettings({paused:false,proxyPort:0});store.close();let reopened=new AutomationStore(join(directory,'automation.sqlite'));assert.equal(reopened.settings().proxyPort,7897);reopened.saveSettings({...reopened.settings(),proxyPort:0});reopened.close();reopened=new AutomationStore(join(directory,'automation.sqlite'));assert.equal(reopened.settings().proxyPort,0);reopened.saveSettings({paused:false,proxyPort:1080});reopened.close();reopened=new AutomationStore(join(directory,'automation.sqlite'));assert.equal(reopened.settings().proxyPort,1080);reopened.close();
});
test('profile refresh preserves monitoring cursor and concurrent pause changes',async t=>{
 const {automation,store}=fixture(t);const channel={id:'channel',channelId:'UC1234567890123456789012',name:'Old',url:'https://youtube.com/@old',enabled:true,cursor:'old-cursor',proxyPort:7897};store.saveChannel(channel);
 automation.channelWorker=async input=>{assert.equal(input.command,'profile');assert.ok(input.avatarPath.endsWith('avatar.jpg'));store.saveChannel({...channel,enabled:false,cursor:'new-cursor'});return {channelId:channel.channelId,name:'New',handle:'@new',subscriberCount:0,avatarCached:true,cursor:'must-not-overwrite'};};await automation.profiles();const current=store.channels()[0];assert.equal(current.cursor,'new-cursor');assert.equal(current.enabled,false);assert.equal(current.handle,'@new');assert.equal(current.subscriberCount,0);assert.equal(current.avatarReady,true);
});
test('failed profile refresh keeps cached information and uses a retry delay',async t=>{
 const {automation,store}=fixture(t);store.saveChannel({id:'channel',channelId:'UC1234567890123456789012',name:'Existing',avatarReady:true,cursor:'cursor'});automation.channelWorker=async()=>{throw new Error('offline')};await automation.profiles();const current=store.channels()[0];assert.equal(current.name,'Existing');assert.equal(current.avatarReady,true);assert.equal(current.cursor,'cursor');assert.ok(current.profileNextCheck>Date.now());assert.match(current.profileError,/已保留头像/);
});
test('profile refresh cannot resurrect a deleted channel',async t=>{
 const {automation,store}=fixture(t);store.saveChannel({id:'channel',channelId:'UC1234567890123456789012'});automation.channelWorker=async()=>{store.deleteChannel('channel');return {channelId:'UC1234567890123456789012',name:'Late result'};};await automation.profiles();assert.equal(store.channels().length,0);
});
test('exact prefix and description structure use original source fields',()=>{
 const value=makeMetadata(source,translated,categories);
 assert.equal(value.title,'[中配]示例中文标题');assert.equal(value.desc,'原视频：An original title\n原作者：Original creator\n发布日期：2026-11-17\n视频链接：https://www.youtube.com/watch?v=abcdefghijk\n\n原介绍中文翻译');assert.equal(value.desc_format_id,9999);assert.equal(value.copyright,2);assert.equal(value.is_only_self,0);assert.equal(value.tags.length,6);
});
test('prefix is not duplicated; date uses source release in Shanghai',()=>{
 assert.equal(makeMetadata(source,{...translated,title:'[中配][中配]中文标题'},categories).title,'[中配]中文标题');
 assert.equal(sourceDate({timestamp:Date.UTC(2026,10,16,18)/1000}),'2026-11-17');
});
test('long translated introductions preserve source header and full translation',()=>{
 const value=makeMetadata(source,{...translated,description:'中'.repeat(3000)},categories);assert.equal([...value.desc].length,2000);assert.equal(value.fullTranslation.length,3000);assert.ok(value.desc.endsWith('…'));assert.ok(value.desc.includes(source.title));
});
test('missing introduction and invalid metadata cannot silently lose source content',()=>{
 assert.throws(()=>makeMetadata(source,{...translated,description:''},categories),/翻译为空/);
 assert.throws(()=>makeMetadata(source,{...translated,tid:999},categories),/有效投稿分区/);
 const value=makeMetadata({...source,description:''},{...translated,description:''},categories);assert.ok(!value.desc.endsWith('\n\n'));
});
test('channel overrides and tags are validated and deduplicated',()=>{
 const value=makeMetadata(source,translated,categories,{fixedTid:202,fixedTags:['指定标签','科学']});assert.equal(value.tid,202);assert.equal(value.tags[0],'指定标签');assert.equal(value.tags.filter(tag=>tag==='科学').length,1);
});
test('category extraction accepts only known leaf IDs',()=>{
 assert.deepEqual(categoryList({data:{type:[{id:1,name:'知识',children:[{id:201,name:'科普'}]}]}}),[{id:201,name:'知识 / 科普'}]);
});
test('auto workflow injects download, Chinese dubbing and automatic node approvals',async()=>{
 const original=JSON.parse(await readFile(new URL('../packages/builtin/src/workflow-templates/source-clone-dubbing.json',import.meta.url)));
 const graph=autoGraph(original,7890);assert.equal(graph.inputs.length,0);assert.equal(graph.nodes[0].config.proxyPort,7890);assert.ok(graph.nodes.every(node=>node.autoContinue));assert.ok(graph.edges.some(edge=>edge.source.nodeId==='bi-download'));assert.ok(graph.nodes.find(node=>node.type==='youdub.export').config.renderSubtitles);assert.equal(original.nodes[0].id,'prepare');
});
test('queue deduplicates across channels and persists after reopening',t=>{
 const {store,directory}=fixture(t);const channel={id:'c',accountId:'primary',template:{},graph:{nodes:[]}};
 const job=store.enqueue(channel,source);assert.ok(job);assert.equal(store.enqueue({...channel,id:'another'},source),null);
 store.saveJob({...job,state:'submitting',submissionStarted:true});store.close();const reopened=new AutomationStore(join(directory,'automation.sqlite'));assert.equal(reopened.job(job.id).state,'reconciling');assert.equal(reopened.enqueue(channel,source),null);reopened.close();
});
test('crashed upload can resume without inventing a submission',t=>{
 const {store,directory}=fixture(t);const job=prepared(store,{state:'uploading'});store.close();const reopened=new AutomationStore(join(directory,'automation.sqlite'));assert.equal(reopened.job(job.id).state,'ready_to_publish');assert.equal(reopened.job(job.id).uploaded.filename,job.uploaded.filename);reopened.close();
});
test('unknown submission is reconciled on retry and never resubmitted',async t=>{
 const {store,automation}=fixture(t);const job=prepared(store);const calls=[];
 automation.transport=async(command)=>{calls.push(command);if(command==='submit')throw new Error('connection lost');if(command==='reconcile')return {matched:false};throw new Error(command)};
 await automation.queue();let current=store.job(job.id);assert.equal(current.state,'reconciling');assert.equal(current.submissionStarted,true);store.saveJob({...current,nextRun:0});await automation.queue();assert.deepEqual(calls,['submit','reconcile']);assert.equal(store.job(job.id).state,'reconciling');
});
test('rate limits persist cooldown and do not drop uploaded receipt',async t=>{
 const {store,automation}=fixture(t);const job=prepared(store);automation.transport=async()=>({code:601,message:'rate limited'});await automation.queue();const current=store.job(job.id);assert.equal(current.state,'retry_wait');assert.equal(current.submissionStarted,false);assert.ok(store.settings().blockedUntil>Date.now());assert.equal(current.uploaded.filename,'unique-upload');
});
test('explicit platform rejection retains uploaded file and permits correction retry',async t=>{
 const {store,automation}=fixture(t);const job=prepared(store);automation.transport=async()=>({code:21103,message:'invalid tag'});await automation.queue();const current=store.job(job.id);assert.equal(current.state,'needs_attention');assert.equal(current.submissionStarted,false);assert.equal(current.uploaded.filename,'unique-upload');
});
test('metadata correction preserves source layout, prefix and upload receipt',async t=>{
 const {store,automation}=fixture(t);const job=prepared(store,{state:'needs_attention'});automation.categories=async()=>categories;
 const updated=await automation.updateMetadata(job.id,{...translated,title:'修正标题',tid:202,tags:['修正标签']});assert.equal(updated.metadata.title,'[中配]修正标题');assert.ok(updated.metadata.desc.startsWith('原视频：'+source.title));assert.equal(updated.uploaded.filename,'unique-upload');assert.equal(updated.metadata.tid,202);
});
test('metadata editing cannot change an already submitted job',async t=>{
 const {store,automation}=fixture(t);const job=prepared(store,{submissionStarted:true});await assert.rejects(automation.updateMetadata(job.id,translated),/不能修改/);
});
test('review approval requires exact uploaded identity and requested visibility',async t=>{
 const {store,automation}=fixture(t);const job=prepared(store,{state:'reconciling',submissionStarted:true});
 automation.transport=async()=>({matched:true,details:{archive:{aid:123,bvid:'BV1abcdefghi',state:0,is_only_self:0},videos:[{filename:'unique-upload.mp4'}]}});
 automation.publicLookup=async()=>({aid:123,bvid:'BV1abcdefghi'});await automation.queue();assert.equal(store.job(job.id).state,'published');
});
test('unknown remote visibility is never marked published',async t=>{
 const {store,automation}=fixture(t);const job=prepared(store,{state:'reconciling',submissionStarted:true});automation.transport=async()=>({matched:true,details:{archive:{aid:123,state:0},videos:[{filename:'unique-upload'}]}});await automation.queue();assert.equal(store.job(job.id).state,'reconciling');
});
test('rejected review is terminal and keeps the original BV',async t=>{
 const {store,automation}=fixture(t);const job=prepared(store,{state:'awaiting_review',submissionStarted:true,aid:123});automation.transport=async()=>({matched:true,details:{archive:{aid:123,state:-2,is_only_self:0},videos:[{filename:'unique-upload'}]}});await automation.queue();assert.equal(store.job(job.id).state,'rejected');assert.equal(store.job(job.id).aid,123);await assert.rejects(automation.control(job.id,'retry'),/只能核对/);
});
test('discovery atomically advances cursor and queue ownership',async t=>{
 const {store,automation}=fixture(t);store.saveChannel({id:'c',channelId:'UC1234567890123456789012',enabled:true,nextCheck:0,intervalMinutes:5,addedAt:Date.now(),accountId:'primary',template:{},graph:{},cursor:'previous'});automation.channelWorker=async()=>({cursor:source.id,videos:[source,source]});await automation.monitor();assert.equal(store.jobs().length,1);assert.equal(store.channels()[0].cursor,source.id);
});
test('failed channel lookup preserves cursor and does not enqueue partial results',async t=>{
 const {store,automation}=fixture(t);store.saveChannel({id:'c',channelId:'UC1234567890123456789012',enabled:true,nextCheck:0,intervalMinutes:5,addedAt:Date.now(),accountId:'primary',cursor:'previous'});automation.channelWorker=async()=>{throw new Error('offline')};await automation.monitor();assert.equal(store.jobs().length,0);assert.equal(store.channels()[0].cursor,'previous');assert.equal(store.channels()[0].checkErrorCode,'network');
});
test('concurrent monitor loops never run the same check twice',async t=>{
 const {store,automation}=fixture(t);
 for(const id of ['first','second'])store.saveChannel({id,channelId:id,enabled:true,nextCheck:0,intervalMinutes:5,addedAt:Date.now(),url:id});
 const seen=[], finish=[];
 automation.channelWorker=async({url})=>{seen.push(url);await new Promise(resolve=>finish.push(resolve));return {channelId:url,videos:[],cursor:'head'};};
 const a=automation.monitor(),b=automation.monitor();
 await automation.monitor();
 assert.deepEqual(seen,['first','second']);
 assert.equal(automation.channelView(store.channels()[0]).checkState,'checking');
 finish.forEach(resolve=>resolve());
 await Promise.all([a,b]);assert.equal(automation.channelView(store.channels()[0]).checkState,'healthy');
});
test('pausing a channel during discovery prevents late enqueues',async t=>{
 const {store,automation}=fixture(t);const channel={id:'c',channelId:'UC1234567890123456789012',enabled:true,nextCheck:0,intervalMinutes:5,addedAt:Date.now(),accountId:'primary',cursor:'previous'};store.saveChannel(channel);
 automation.channelWorker=async()=>{store.saveChannel({...channel,enabled:false});return {cursor:source.id,videos:[source]}};await automation.monitor();assert.equal(store.jobs().length,0);assert.equal(store.channels()[0].cursor,'previous');
});
const nativeExecutable=fileURLToPath(new URL('../native/bin/youdub2bi-uploader.exe',import.meta.url));
test('legacy plaintext credential import writes DPAPI and leaves source untouched',{skip:process.platform!=='win32'||!existsSync(nativeExecutable)},async t=>{
 const {directory}=fixture(t);const original=join(directory,'legacy.json'),destination=join(directory,'imported.credential');const data=JSON.stringify({cookie_info:{cookies:[{name:'SESSDATA',value:'fixture-secret'}]},sso:[],token_info:{mid:42,access_token:'fixture-secret',refresh_token:'fixture-refresh',expires_in:2592000},platform:null});await writeFile(original,data);
 const result=await jsonProcess(nativeExecutable,[],{command:'import_credential',sourcePath:original,credentialPath:destination});assert.equal(result.mid,'42');const bytes=await readFile(destination);assert.ok(bytes.toString('utf8').startsWith('STREAMARCHIVE-DPAPI-1\n'));assert.ok(!bytes.includes(Buffer.from('fixture-secret')));assert.equal(await readFile(original,'utf8'),data);
});
test('global pause makes no external calls',async t=>{const {store,automation}=fixture(t);prepared(store);store.saveSettings({...store.settings(),paused:true});await automation.queue();assert.equal(store.jobs()[0].state,'queued');});
test('publication metadata respects the configured structured-output adapter limit',async t=>{
 const {store,automation,ctx}=fixture(t);const job=prepared(store);job.graph={nodes:[{type:'youdub.translate',provider:{id:'llm.configured',model:'configured-model'}}]};automation.categories=async()=>categories;automation.transport=async()=>[];
 ctx.llm={prepareCall:async config=>{assert.ok(config.maxTokens>=65535,'Shared structured output rejects smaller limits');return {config,async *stream(){yield {type:'text-delta',text:JSON.stringify(translated)};yield {type:'finish',reason:{kind:'stop'}};}}}};
 const metadata=await automation.metadata(job,{steps:[]});assert.equal(metadata.title,'[中配]示例中文标题');
});
test('subprocess consumes JSON progress and rejects transport failures',async()=>{
 const progress=[];const value=await jsonProcess(process.execPath,['-e',`process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({event:'progress',bytes:3}));console.log(JSON.stringify({ok:true,result:{done:true}}))})`],{},{onProgress:event=>progress.push(event)});assert.equal(value.done,true);assert.equal(progress.length,1);
 await assert.rejects(jsonProcess(process.execPath,['-e',`process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({ok:false,error:'fixture failed'})))`],{}),/fixture failed/);
});
