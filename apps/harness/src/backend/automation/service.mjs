import { lstat,mkdir,readFile,realpath,rm,writeFile,stat } from 'node:fs/promises';
import { basename,dirname,join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import { AutomationStore } from './store.mjs';
import { categoryList,autoGraph } from './metadata.mjs';
import { automationStates,publicationView,publicationGroups,publicationDurationSeconds,productionTiming,publicError,hasSubmission,hasUpload,archiveId,archiveBvid,canRemake } from './publication-view.mjs';
import { generatePublicationMetadata,metadataFromDraft,publicationDraft } from './publication-metadata.mjs';
import { ensureLibreTranslate,verifyPublicArchive } from './publication-services.mjs';
import { machineTranslate } from '../machine-translation.mjs';
import { jsonProcess } from './process.mjs';
import { readJson,fileURL } from '../transport.mjs';
import { workflowTemplates } from '../../../../../packages/builtin/src/workflow-templates.ts';
import { restoreClassicDubbing } from '../../../../../packages/builtin/src/original-audio-graph.ts';
import { videoEncoders } from '../../../../../packages/builtin/src/video-encoders.ts';
import { videoSource } from '../../../../../packages/sdk/src/video-source.ts';

export { automationStates };
const redact=publicError;
const fail=(message,code='AUTOMATION_INVALID',status=422)=>Object.assign(new Error(message),{status,code});
const idOf=value=>String(value || '');
const waitsForYoutube=job=>!hasSubmission(job) &&
  (job.state==='needs_youtube_login' || job.state==='needs_attention' && /sign in to confirm|YouTube.*(?:要求登录|登录凭据)/i.test(job.error || ''));
const publicJob=job=>({
  ...Object.fromEntries(['id','taskId','accountId','channelId','videoId','state','createdAt','updatedAt','nextRun','lastReviewAt',
    'origin','sourceUrl','submissionStarted','aid','bvid','attempts','metadata','bytesUploaded','totalBytes'].map(key=>[key,job[key]])),
  source:{title:job.source?.title,channel:job.source?.channel,thumbnail:job.source?.thumbnail},
  error:job.error?redact(job.error):null,
});
const publicChannel=({graph,...channel})=>({...channel,avatar:channel.avatarReady?fileURL(`/api/v2/automation/channels/${encodeURIComponent(channel.id)}/avatar?v=${channel.profileUpdatedAt || 0}`):null});
function channelIssue(error) {
  const message=String(error?.message || '');
  if(/^YOUTUBE_AUTH_/.test(error?.code || '') || /Netscape format cookies file|sign in to confirm|登录凭据/i.test(message)){
    return {code:'auth',text:'YouTube 登录凭据需要更新。'};
  }
  if(/429|too many requests|rate limit/i.test(message))return {code:'rate',text:'YouTube 暂时限流，稍后自动重试。'};
  if(/timeout|超时|proxy|connection|offline|网络|代理|failed to resolve/i.test(message))return {code:'network',text:'暂时连不上 YouTube，请检查代理和网络。'};
  return {code:'source',text:'未能读取频道更新，已保留上次检查位置。'};
}
const channelCheckIssue=channel=>channel.error?channel.checkErrorCode?{code:channel.checkErrorCode,text:channel.error}:channelIssue({message:channel.error}):null;
const mediaStates=['queued','processing','waiting_media','retry_wait'];
const publishStates=['ready_to_publish','metadata','cover','retry_wait'];
const reviewStates=['reconciling','awaiting_review'];
const rateCodes=new Set([601,429,21566,21590,-412]);
const loginCodes=new Set([-101,-111,-400101]);
const rejectionCodes=new Set([-400,21103]);
const loginError=error=>error.code==='BILIBILI_LOGIN' || /(?:^|[^\d])-(?:101|111)(?:[^\d]|$)|B\s*站.*(?:登录|扫码)|cookie.*(?:expired|invalid)|not logged in/i.test(error.message || '');
const mediaFailure=job=>job.failurePhase==='media' || /^Pinned provider .* is unavailable\.$/i.test(job.error || '') || job.error==='翻译配音失败，请在任务详情检查后重试';
const transientMediaCodes=new Set(['APP_INTERRUPTED','TRANSLATION_NETWORK','DOWNLOAD_TRANSIENT','NETWORK','NETWORK_ERROR','RATE_LIMIT','TIMEOUT','WORKER_EXITED']);
const resolutions=new Set([360,480,720,1080,1440,2160,4320]);
const uuid=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
async function verifyOwnedDirectory(path,root){
  const parent=dirname(path);
  const info=await lstat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!info)return;
  if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==join(await realpath(root),basename(parent),basename(path))){
    throw fail('素材目录不在任务工作区内','CLEANUP_DIRECTORY');
  }
}
function retryableMedia(error){
  if(!error || error.action==='adjust_settings')return false;
  return transientMediaCodes.has(error.code)||[408,429,502,503,504].includes(error.status)&&
    !['MODEL_NOT_READY','RUNTIME_UNAVAILABLE','PROVIDER_UNAVAILABLE','PLUGIN_UNAVAILABLE','INVALID_PROVIDER_RESULT'].includes(error.code);
}
const videoArtifact=record=>{
  const matching=record.outputs?.find(output=>(output.role==='video'||output.id==='video') && record.artifacts?.[output.artifact?.id]?.mimeType==='video/mp4');
  return matching?record.artifacts[matching.artifact.id]:Object.values(record.artifacts || {}).find(artifact=>
    artifact.mimeType==='video/mp4' && record.outputs?.some(output=>output.artifact?.id===artifact.id));
};

export class Automation {
  constructor(ctx,{root,data,python,store,transport,channelWorker,version='dev',translationSlot,localAvailability=ensureLibreTranslate,localTranslate,publicLookup=verifyPublicArchive}) {
    this.ctx=ctx;this.root=root;this.data=data;this.python=python;this.store=store;this.transport=transport;this.channelWorker=channelWorker;this.stopping=new AbortController();this.login={state:'idle'};this.inflight=new Set();this.categoriesCache=null;
    this.browsedVideos=new Map();this.busyJobs=new Set();this.checkingChannels=new Set();this.thumbnails=new Map();this.thumbnailFailures=new Map();
    this.localAvailability=localAvailability;this.localTranslate=localTranslate;this.publicLookup=publicLookup;
    this.version=version;
    this.translationSlot=translationSlot;
  }
  account(id){const account=this.store.accounts().find(item=>item.id===id);if(!account?.ready)throw fail('请先扫码恢复 B 站账号','BILIBILI_LOGIN');return account;}
  credential(id){return join(this.data,'bilibili',`${id}.credential`);}
  youtube(command,extra={}){return jsonProcess(this.python,['-m','backend.workers.youtube_auth'],{command,dataDir:this.data,...extra},{cwd:this.root,signal:this.stopping.signal});}
  async importYoutube(input){
    if(typeof input.cookies!=='string' || Buffer.byteLength(input.cookies,'utf8')>1024*1024)throw fail('请选择不超过 1 MB 的 YouTube cookies.txt');
    const status=await this.youtube('import',{cookies:input.cookies});
    const resumed=input.resume===true?await this.resumeYoutube(status):[];
    if(input.resume!==true)this.store.saveSettings({...this.store.settings(),youtubeAuthAppliedAt:status.importedAt});
    return {...status,resumed,deferred:input.resume===true && this.store.settings().paused};
  }
  async resumeYoutube(status){
    const resumed=[];
    if(!status)status=await this.youtube('status');
    if(!status.configured || this.store.settings().paused || this.store.settings().youtubeAuthAppliedAt===status.importedAt)return resumed;
    for(const job of this.store.jobs()){
      if(waitsForYoutube(job)){
        try{await this.control(job.id,'retry');resumed.push(job.id);this.store.event(job.id,'已更新 YouTube 登录凭据，恢复原任务');}catch(error){this.store.event(job.id,redact(error.message));}
      }
    }
    this.store.saveSettings({...this.store.settings(),youtubeAuthAppliedAt:status.importedAt});
    return resumed;
  }
  async syncYoutubeQueue(){
    const settings=this.store.settings();
    const channels=this.store.channels().filter(channel=>channelCheckIssue(channel)?.code==='auth');
    if(!channels.length && (settings.paused || !this.store.jobs().some(waitsForYoutube)))return;
    const file=await stat(join(this.data,'youtube','session.credential')).catch(error=>{
      if(error.code==='ENOENT')return null;
      throw error;
    });
    if(!file || file.mtimeMs===this.youtubeCredentialMtime)return;
    const status=await this.youtube('status');
    if(status.configured){
      for(const old of channels){
        const channel=this.store.channels().find(item=>item.id===old.id);
        if(channel?.enabled && channelCheckIssue(channel)?.code==='auth' && !this.checkingChannels.has(channel.id)){
          this.store.saveChannel({...channel,nextCheck:0,checkRequested:true});
        }
      }
      if(!settings.paused)await this.resumeYoutube(status);
    }
    this.youtubeCredentialMtime=file.mtimeMs;
  }
  native(command,accountId,extra={},options={}) {
    return this.transport(command,{credentialPath:this.credential(accountId),...extra},{signal:this.stopping.signal,...options});
  }
  async categories(accountId){
    if(this.categoriesCache?.id===accountId && this.categoriesCache.until>Date.now())return this.categoriesCache.items;
    this.account(accountId);
    const response=await this.native('categories',accountId);
    if(loginCodes.has(Number(response?.code)))throw fail('B 站登录已失效，请使用原账号扫码','BILIBILI_LOGIN');
    if(rateCodes.has(Number(response?.code)))throw fail('B 站分区请求限流','BILIBILI_RATE',429);
    const items=categoryList(response);
    if(!items.length)throw fail('B 站没有返回可用投稿分区','BILIBILI_CATEGORIES',503);
    this.categoriesCache={id:accountId,until:Date.now()+300000,items};
    return items;
  }
  publicAccounts(){return this.store.accounts().map(({id,mid,name,ready})=>({id,mid,name,ready}));}
  async startLogin(){
    if(this.login.state==='waiting')return this.login;
    const challenge=await this.transport('qr_start',{}, {signal:this.stopping.signal});
    if(challenge.code!==0 || !challenge.data?.url)throw fail('无法获取 B 站登录二维码');
    const account=this.store.accounts()[0] || {id:'primary',ready:false};
    this.store.saveAccount(account);
    this.login={state:'waiting',image:await QRCode.toDataURL(challenge.data.url),expiresAt:Date.now()+180000};
    const login=this.native('qr_login',account.id,{challenge,expectedMid:account.mid || undefined},{timeout:185000}).then(async result=>{
      this.store.saveAccount({...account,mid:result.mid,ready:true});
      let name=result.mid;try{const info=await this.native('account',account.id);name=info?.data?.name || info?.name || name;}catch{}
      this.store.saveAccount({...account,mid:result.mid,name,ready:true});this.categoriesCache=null;this.login={state:'success'};
      for(const job of this.store.jobsIn(['needs_login']))if(job.accountId===account.id)this.save(job,{state:hasSubmission(job)?'reconciling':job.mediaReadyAt?'ready_to_publish':'queued',error:null,errorCode:null,nextRun:0},'B 站登录已恢复，继续原任务');
    }).catch(error=>{if(!this.stopping.signal.aborted)this.login={state:'error',error:redact(error.message)};});
    this.track(login);return this.login;
  }
  track(promise){this.inflight.add(promise);promise.finally(()=>this.inflight.delete(promise)).catch(()=>{});return promise;}
  async graph(documentId,proxyPort){
    const templates=workflowTemplates(this.ctx.catalog,await this.ctx.settings.read());
    const saved=templates.find(item=>item.id===documentId) || await this.ctx.store.call('store.workflow_get',{id:documentId});
    if(!saved)throw fail('工作流不存在');
    return autoGraph(saved.document,proxyPort);
  }
  async addChannel(input){
    const interval=Number(input.intervalMinutes ?? 5);
    if(!Number.isInteger(interval)||interval<1||interval>1440)throw fail('检查间隔无效');
    const publication=await this.publicationConfig(input);
    const {proxyPort}=publication;
    const addedAt=Date.now();
    const id=randomUUID();
    const info=await this.channelWorker({command:'resolve',url:String(input.url || ''),proxyPort,avatarPath:this.avatarPath(id)});
    if(this.store.channels().some(channel=>channel.channelId===info.channelId))throw fail('该频道已在监控列表中');
    const channel={id,...info,...publication,avatarReady:!!info.avatarCached,profileUpdatedAt:Date.now(),profileNextCheck:Date.now()+(info.avatarError?300000:86400000),profileRefreshRequested:!!info.avatarError,profileError:info.avatarError || null,intervalMinutes:interval,addedAt,enabled:true,nextCheck:0,lastCheck:null,error:null};
    return publicChannel(this.store.saveChannel(channel));
  }
  async publicationConfig(input,channel=null,url='https://www.youtube.com/watch?v=jNQXAC9IVRw'){
    const accountId=idOf(input.accountId || channel?.accountId || this.store.accounts()[0]?.id);this.account(accountId);
    const proxyPort=Number(input.proxyPort ?? channel?.proxyPort ?? this.store.settings().proxyPort ?? 7897);
    if(!Number.isInteger(proxyPort)||proxyPort<0||proxyPort>65535)throw fail('代理端口无效');
    const workflowId=input.workflowId || channel?.workflowId || 'youdub.subtitles-dubbing';
    const graph=await this.graph(workflowId,proxyPort);
    try{await this.ctx.catalog.workflow('youdub.graph').graph.compile({document:graph,inputs:{},nodeRuntimeInputs:{'bi-download':{url}}},this.ctx.catalog);}catch(error){throw fail(`工作流未就绪：${error.message}`);}
    const imported=this.store.settings().importedTemplate || {};
    const supplied={...channel?.template,...input.template};
    const template=this.template({...supplied,fallbackTid:supplied.fallbackTid || imported.fallbackTid || 0,fallbackTags:supplied.fallbackTags?.length?supplied.fallbackTags:imported.fallbackTags || []});
    return {accountId,proxyPort,workflowId,graph,template};
  }
  async addVideo(input,{expectedChannelId,origin='manual'}={}){
    let parsed;try{parsed=videoSource(String(input.url || ''));}catch(error){throw fail(error.message);}
    if(parsed.platform!=='YouTube')throw fail('仅支持 YouTube 单个视频链接');
    const channel=input.channelId?this.store.channels().find(item=>item.id===input.channelId):null;
    if(input.channelId && !channel)throw fail('所选频道配置不存在');
    const accountId=idOf(input.accountId || channel?.accountId || this.store.accounts()[0]?.id);this.account(accountId);
    const videoId=new URL(parsed.url).searchParams.get('v');
    const existing=this.store.jobForVideo(videoId,accountId);
    if(existing)return {job:publicJob(existing),duplicate:true};
    const publication=await this.publicationConfig({...input,accountId},channel,parsed.url);
    const source=await this.channelWorker({command:'video',url:parsed.url,proxyPort:publication.proxyPort});
    if(source.id!==videoId)throw fail('视频信息与链接不一致，请检查链接');
    if(expectedChannelId && (source.channel_id?source.channel_id!==expectedChannelId:!this.browsedVideos.get(channel.id)?.has(videoId)))throw fail('无法确认该视频属于所选频道，请刷新视频列表后重试');
    if(expectedChannelId && !this.store.channels().some(item=>item.id===channel.id))throw fail('频道已移除，无法继续添加');
    const created=this.store.enqueue({id:channel?.id || null,...publication},source);
    const job=created?this.save(created,{origin,sourceUrl:parsed.url}):this.store.jobForVideo(videoId,accountId);
    if(created)this.store.event(job.id,origin==='channel_selection'?'通过频道视频批量选择添加自动任务':'通过 YouTube 视频链接添加自动任务');
    return {job:publicJob(job),duplicate:!created};
  }
  async channelVideos(id,input={}){
    const channel=this.store.channels().find(item=>item.id===id);if(!channel)throw fail('频道不存在');
    const offset=Number(input.offset ?? 0),limit=Number(input.limit ?? 30);
    if(!Number.isInteger(offset)||offset<0||offset>10000||!Number.isInteger(limit)||limit<1||limit>60)throw fail('视频分页参数无效');
    const result=await this.channelWorker({command:'browse',url:channel.url,proxyPort:channel.proxyPort ?? 7897,offset,limit});
    if(result.channelId!==channel.channelId)throw fail('频道视频来源不匹配');
    const current=this.store.channels().find(item=>item.id===id);if(!current)throw fail('频道已移除');
    // Some watch pages omit channel_id. Only a server-fetched channel listing can
    // establish membership in that case; a caller-provided title/name cannot.
    const seen=new Set([...(this.browsedVideos.get(id) || []),...result.videos.map(video=>video.id)]);
    this.browsedVideos.delete(id);this.browsedVideos.set(id,new Set([...seen].slice(-5000)));
    if(this.browsedVideos.size>20)this.browsedVideos.delete(this.browsedVideos.keys().next().value);
    const jobs=new Map(this.store.jobs().filter(job=>job.accountId===current.accountId).map(job=>[job.videoId,job]));
    return {...result,channel:publicChannel(current),videos:result.videos.map(video=>({...video,job:jobs.has(video.id)?publicJob(jobs.get(video.id)):null}))};
  }
  async addChannelVideos(id,input){
    const channel=this.store.channels().find(item=>item.id===id);if(!channel)throw fail('频道不存在');
    if(!Array.isArray(input.videoIds)||!input.videoIds.length||input.videoIds.length>50||input.videoIds.some(value=>typeof value!=='string'||!/^[\w-]{11}$/.test(value)))throw fail('请选择 1–50 个有效视频');
    this.account(channel.accountId);
    const identities=[...new Set(input.videoIds)],results=new Array(identities.length);let next=0;
    const consume=async()=>{while(next<identities.length){const index=next++,videoId=identities[index];try{
      const result=await this.addVideo({url:`https://www.youtube.com/watch?v=${videoId}`,channelId:id,accountId:channel.accountId},{expectedChannelId:channel.channelId,origin:'channel_selection'});
      results[index]={videoId,...result};
    }catch(error){results[index]={videoId,error:redact(error.message)};}}};
    await Promise.all(Array.from({length:Math.min(3,identities.length)},consume));
    return {results,added:results.filter(item=>item.job&&!item.duplicate).length,duplicates:results.filter(item=>item.duplicate).length,failed:results.filter(item=>item.error).length,paused:this.store.settings().paused};
  }
  avatarPath(id){return join(this.data,'channels',id,'avatar.jpg');}
  channelView(channel){
    const issue=channelCheckIssue(channel);
    return {...publicChannel(channel),error:issue?.text ?? null,errorCode:issue?.code ?? null,
      checkState:!channel.enabled?'paused':this.checkingChannels.has(channel.id)?'checking':channel.checkRequested?'scheduled':issue?'issue':channel.lastCheck?'healthy':'new'};
  }
  requestChannelCheck(id){
    const channel=this.store.channels().find(item=>item.id===id);
    if(!channel)throw fail('频道不存在');
    if(!channel.enabled)throw fail('请先恢复监控，再检查频道。');
    return this.channelView(this.checkingChannels.has(id)?channel:this.store.saveChannel({...channel,nextCheck:0,checkRequested:true}));
  }
  async profiles(){
    const now=Date.now();
    const channel=this.store.channels().find(item=>(item.profileNextCheck || 0)<=now && (item.profileRefreshRequested || !item.profileUpdatedAt || now-item.profileUpdatedAt>=86400000));
    if(!channel)return;
    this.store.saveChannel({...channel,profileNextCheck:now+300000});
    try{
      const info=await this.channelWorker({command:'profile',url:channel.url,proxyPort:channel.proxyPort ?? 7897,avatarPath:this.avatarPath(channel.id)});
      const current=this.store.channels().find(item=>item.id===channel.id);if(!current)return;
      if(info.channelId!==current.channelId)throw fail('频道资料与频道 ID 不匹配');
      const fields=Object.fromEntries(['name','handle','avatarUrl','subscriberCount','isVerified','description'].filter(key=>info[key]!==undefined).map(key=>[key,info[key]]));
      this.store.saveChannel({...current,...fields,avatarReady:!!info.avatarCached || !!current.avatarReady,profileUpdatedAt:Date.now(),profileNextCheck:Date.now()+(info.avatarError?300000:86400000),profileRefreshRequested:!!info.avatarError,profileError:info.avatarError || null});
    }catch{const current=this.store.channels().find(item=>item.id===channel.id);if(current)this.store.saveChannel({...current,profileError:'未能刷新频道资料，已保留头像和已有信息。',profileNextCheck:Date.now()+300000,profileRefreshRequested:true});}
  }
  template(value){
    const numbers=['fixedTid','fallbackTid'];const template={fixedTags:[],fallbackTags:[]};
    for(const key of numbers){const number=Number(value[key] || 0);if(!Number.isInteger(number)||number<0||number>65535)throw fail('投稿分区无效');template[key]=number;}
    for(const key of ['fixedTags','fallbackTags']){if(value[key]!==undefined && !Array.isArray(value[key]))throw fail('标签应为数组');template[key]=[...new Set((value[key] || []).map(tag=>String(tag).trim()).filter(Boolean))];if(template[key].length>6 || template[key].some(tag=>[...tag].length>20 || /[,，\n]/.test(tag)))throw fail('标签最多 6 个，每个不超过 20 字');}
    return template;
  }
  async monitor(){
    const channel=this.store.channels().filter(item=>item.enabled && (item.nextCheck || 0)<=Date.now()&&!this.checkingChannels.has(item.id))
      .sort((a,b)=>Number(!!b.checkRequested)-Number(!!a.checkRequested)||(a.nextCheck || 0)-(b.nextCheck || 0))[0];
    if(!channel)return;
    this.checkingChannels.add(channel.id);
    this.store.saveChannel({...channel,checkRequested:false});
    const fresh=()=>this.store.channels().find(item=>item.id===channel.id&&item.enabled&&(item.checkEpoch || 0)===(channel.checkEpoch || 0));
    try{
      const result=await this.channelWorker({command:'scan',url:channel.url,proxyPort:channel.proxyPort,cursor:channel.cursor,addedAt:channel.addedAt,addedDate:new Date(channel.addedAt).toISOString().slice(0,10).replaceAll('-','')});
      const current=fresh();if(!current || this.stopping.signal.aborted)return;
      if(result.channelId&&result.channelId!==current.channelId)throw fail('检查结果与监控频道不匹配');
      const now=Date.now();
      this.store.transaction(()=>{
        let added=0;
        for(const source of result.videos)if(this.store.enqueue(current,source))added++;
        this.store.saveChannel({...current,cursor:result.cursor??current.cursor,lastCheck:now,lastSuccessAt:now,lastAdded:added,
          nextCheck:now+(current.intervalMinutes || 5)*60000,error:null,checkErrorCode:null});
      });
    }catch(error){
      const current=fresh();
      if(current&&!this.stopping.signal.aborted){
        const issue=channelIssue(error),now=Date.now();
        const retry=issue.code==='auth'||issue.code==='rate'?300000:60000;
        this.store.saveChannel({...current,error:issue.text,checkErrorCode:issue.code,lastCheck:now,nextCheck:now+Math.max(retry,(current.intervalMinutes || 5)*60000)});
      }
    }finally{this.checkingChannels.delete(channel.id);}
  }
  llmSelections(){
    return (this.ctx.catalog?.listProviders?.() || []).filter(provider=>provider.id.startsWith('llm.') && provider.available && provider.capability==='translation')
      .flatMap(provider=>(provider.models || []).filter(model=>model.available!==false).map(model=>({
        id:provider.id,model:model.id,label:(provider.label || provider.id)+' · '+(model.label || model.name || model.id),
      })));
  }
  async metadata(job,record){
    const categories=await this.categories(job.accountId);
    const options=this.llmSelections(), preference=this.store.settings().metadataSelection;
    const selection=preference?options.find(item=>item.id===preference.id && item.model===preference.model)
      : options[0] ?? (!this.ctx.catalog?.listProviders && job.graph.nodes.find(node=>node.type==='youdub.translate'&&node.provider.id.startsWith('llm.'))?.provider);
    const port=(await this.ctx.settings?.read())?.translator?.port || 5000, signal=this.stopping.signal;
    let localReady;
    const translate=this.localTranslate ?? (async (...args)=>{
      localReady ??= this.localAvailability(port,signal);
      await localReady;
      return machineTranslate(...args);
    });
    const generate=()=>generatePublicationMetadata({job,record,categories,llm:this.ctx.llm,selection,port,signal,translate});
    const result=this.translationSlot?await this.translationSlot.run(signal,generate):await generate();
    if(!result.metadata)throw Object.assign(fail(result.error,'PUBLICATION_METADATA'),{draft:result.draft});
    await this.saveMetadataFiles(job,result.metadata);
    return {...result.metadata,metadataOrigin:result.origin};
  }
  async saveMetadataFiles(job,metadata){
    const directory=join(this.data,'automation',job.id);
    await mkdir(directory,{recursive:true});
    await writeFile(join(directory,'介绍完整中文翻译.txt'),metadata.fullTranslation);
    await writeFile(join(directory,'投稿信息.json'),JSON.stringify(metadata,null,2));
  }
  async cover(job){
    const directory=join(this.data,'automation',job.id);
    await mkdir(directory,{recursive:true});
    const candidates=[...(job.source.thumbnails || []),{url:job.source.thumbnail,width:0}].filter(item=>item.url).sort((a,b)=>(b.width||0)-(a.width||0));
    if(!/^[\w-]{11}$/.test(job.videoId))throw fail('原视频来源无效','PUBLICATION_COVER');
    const path=join(directory,'youtube-cover.jpg');
    const result=await this.channelWorker({command:'cover',url:'https://www.youtube.com/watch?v='+job.videoId,
      proxyPort:job.graph.nodes.find(node=>node.id==='bi-download')?.config.proxyPort ?? this.store.settings().proxyPort ?? 7897,thumbnails:candidates,path});
    return result.path;
  }
  async thumbnail(id){
    const job=this.store.job(id);
    if(job.cleanupPending||job.cleanedAt)throw fail('本地封面已进入素材清理','PUBLICATION_THUMBNAIL',404);
    if(!/^[\w-]{11}$/.test(job.videoId) || !/^[a-f\d-]{36}$/i.test(job.id))throw fail('原封面不可用','PUBLICATION_THUMBNAIL',404);
    const directory=join(this.data,'automation',job.id);
    const real=join(directory,'youtube-cover.jpg'), preview=join(directory,'preview.jpg');
    for(const path of [real,preview]){
      const file=await stat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(file?.isFile() && file.size>0)return path;
    }
    if(this.thumbnailFailures.get(id)>Date.now())throw fail('原封面暂不可用','PUBLICATION_THUMBNAIL',404);
    if(!this.thumbnails.has(id)){
      const pending=(async()=>{
        try{
          await mkdir(directory,{recursive:true});
          const fallback='https://i.ytimg.com/vi/'+job.videoId+'/hqdefault.jpg';
          const thumbnails=[...new Set([job.source?.thumbnail,fallback].filter(Boolean))].map(url=>({url}));
          await this.channelWorker({command:'cover',preview:true,path:preview,thumbnails,
            proxyPort:job.graph?.nodes.find(node=>node.id==='bi-download')?.config.proxyPort ?? this.store.settings().proxyPort ?? 7897});
          this.thumbnailFailures.delete(id);
          return preview;
        }catch{
          this.thumbnailFailures.set(id,Date.now()+60_000);
          if(this.thumbnailFailures.size>256)this.thumbnailFailures.delete(this.thumbnailFailures.keys().next().value);
          throw fail('原封面暂不可用','PUBLICATION_THUMBNAIL',404);
        }
      })();
      this.thumbnails.set(id,pending);
      pending.finally(()=>this.thumbnails.delete(id)).catch(()=>{});
    }
    return this.thumbnails.get(id);
  }
  save(job,patch,event){
    const saved=this.store.saveJob({...job,...patch});
    const message=event || (saved.state!==job.state ? automationStates[saved.state] : null);
    if(message)this.store.event(job.id,message);
    return saved;
  }
  async mediaRecord(job){
    try{return await this.ctx.tasks.record(job.taskId);}
    catch(error){if(error.code!=='TASK_NOT_FOUND')throw error;return null;}
  }
  async mediaStep(job,{recover=false}={}){
    if(hasSubmission(job))return false;
    if(hasUpload(job) && job.metadata && (job.coverUrl||job.replacement)){
      this.save(job,{state:'ready_to_publish',mediaReadyAt:job.mediaReadyAt || Date.now(),phase:'submit',nextRun:0,error:null,errorCode:null});
      return true;
    }
    const record=await this.mediaRecord(job);
    if(recover&&!record)return false;
    if(!record){
      const translator=(await this.ctx.settings?.read())?.translator?.provider;
      const models=this.llmSelections();
      const settings=this.store.settings();
      const selectedGraph=restoreClassicDubbing(job.graph);
      const graph={...selectedGraph,nodes:selectedGraph.nodes.map(node=>{
        if(node.id==='bi-download')return {...node,config:{...node.config,maxHeight:settings.maxHeight ?? 1080}};
        if(node.type==='youdub.export')return {...node,config:{...node.config,videoEncoder:node.config.videoEncoder ?? settings.videoEncoder ?? 'auto'}};
        if(node.type==='youdub.synthesize'&&settings.speechPerformance)return {...node,config:{...node.config,speechPerformance:settings.speechPerformance}};
        if(node.type!=='youdub.translate')return node;
        if(translator&&translator!=='llm')return {...node,provider:{id:'mt.'+translator,model:'standard',device:'remote'}};
        if(!node.provider.id.startsWith('llm.')&&node.provider.id!=='openai')return node;
        if(models.some(x=>x.id===node.provider.id&&x.model===node.provider.model))return node;
        const model=models.find(x=>x.id===node.provider.id) || models[0];
        return model?{...node,provider:{id:model.id,model:model.model,device:'remote'}}:node;
      })};
      const release=await this.ctx.files.reserve(job.taskId,true,true);
      try{
        await this.ctx.tasks.create({id:job.taskId,workflowId:'youdub.graph',config:{},inputs:{},graphDocument:graph,
          nodeRuntimeInputs:{'bi-download':{url:'https://www.youtube.com/watch?v='+job.videoId}},sourceName:job.source.title});
      }catch(error){
        if(error.code==='INVALID_GRAPH'&&error.details?.some(x=>x.nodeId===graph.nodes.find(node=>node.type==='youdub.translate')?.id)){
          throw fail('当前翻译模型不可用，请在设置中选择可用的翻译服务后重试。','PUBLICATION_TRANSLATOR');
        }
        throw error;
      }finally{await release();}
      this.save(job,{state:'processing',phase:'media',nextRun:Date.now()+2000,error:null,errorCode:null});return false;
    }
    if(['failed','cancelled'].includes(record.status)){
      if(recover && !(await this.ctx.tasks.get(job.taskId)).allowedActions?.includes('retry'))return false;
      const interrupted=record.error?.code==='APP_INTERRUPTED';
      const repairedWorkflow=job.errorCode==='WORKFLOW_VERSION_UNAVAILABLE'&&job.workflowRecoveryVersion!==this.version;
      if(repairedWorkflow&&record.status==='failed'){
        job=this.save(job,{workflowRecoveryVersion:this.version});
        await this.ctx.tasks.retry(job.taskId,record.attempt);
        this.save(job,{state:'processing',phase:'media',nextRun:Date.now()+2500,error:null,errorCode:null},'已恢复旧版工作流，从中断步骤继续');
        return false;
      }
      const transient=record.status==='failed'&&retryableMedia(record.error);
      const stage=record.error?.nodeId || record.steps?.find(step=>step.status==='failed')?.id || 'media';
      const previous=job.mediaRetryStage===stage?job.mediaRetries||0:0;
      if(transient && (interrupted || previous<3)){
        if(job.failedMediaAttempt===record.attempt && job.state==='retry_wait'){
          try{await this.ctx.tasks.retry(job.taskId,record.attempt);}
          catch(error){
            if(error.code!=='ATTEMPT_CONFLICT')throw Object.assign(error,{status:422,mediaAttempt:record.attempt});
          }
          this.save(job,{state:'processing',phase:'media',nextRun:Date.now()+2500,mediaRetryStage:stage,mediaRetries:previous+Number(!interrupted),error:null,errorCode:null},'已从失败步骤继续执行');
        }else{
          const requestedWait=record.error.details?.retryAfterMs;
          const wait=record.error.code==='APP_INTERRUPTED'?1000:record.error.status===429||record.error.code==='RATE_LIMIT'?
            (Number.isFinite(requestedWait)&&requestedWait>0?requestedWait:60000):5000*2**previous;
          this.save(job,{state:'retry_wait',phase:'media',failurePhase:'media',failedMediaAttempt:record.attempt,
            nextRun:Date.now()+wait,error:record.error.message,errorCode:record.error.code},`已保留进度，${Math.ceil(wait/1000)} 秒后重试当前步骤`);
        }
        return false;
      }
      throw Object.assign(fail(record.error?.message || '翻译配音失败，请在任务详情检查后重试',record.error?.code || 'PUBLICATION_MEDIA'),{mediaAttempt:record.attempt});
    }
    if(record.status!=='succeeded'){
      this.save(job,{state:'processing',phase:'media',nextRun:Date.now()+2500,error:null,errorCode:null});
      return false;
    }
    const artifact=videoArtifact(record);
    if(!artifact)throw Object.assign(fail('工作流未生成可用于投稿的 MP4','PUBLICATION_MEDIA'),{mediaAttempt:record.attempt});
    try{await this.ctx.files.resolve(job.taskId,artifact);}
    catch(error){throw Object.assign(fail('无法读取已导出的 MP4，请检查成片文件','PUBLICATION_MEDIA'),{mediaAttempt:record.attempt,cause:error});}
    const summary=record.steps?.findLast(step=>step.outputs?.dubbingSummary)?.outputs.dubbingSummary;
    this.save(job,{state:'ready_to_publish',mediaReadyAt:job.mediaReadyAt || Date.now(),phase:job.metadata?'cover':'metadata',
      durationSeconds:publicationDurationSeconds(job,record),
      productionTiming:productionTiming(job,record),
      ...(summary?{dubbedSegments:summary.dubbedSegments,preservedRanges:summary.preservedRanges}:{}),
      nextRun:0,error:null,errorCode:null,failurePhase:null,attempts:0},
      summary?.dubbedSegments===0?'全片保留原声，继续准备投稿':recover?'检测到原任务已导出成片，从投稿阶段自动续跑':'成片已导出，已交接给发布队列');
    return true;
  }
  async publicationStep(job){
    if(hasSubmission(job) || this.store.settings().paused)return;
    this.account(job.accountId);
    let record;
    if(!hasUpload(job) || !job.metadata) {
      record=await this.mediaRecord(job);
      if(record?.status!=='succeeded' || !videoArtifact(record))throw fail('未找到已完成的 MP4，请检查成片任务','PUBLICATION_MEDIA');
    }
    if(!job.metadata){
      job=this.save(job,{state:'metadata',phase:'metadata',error:null,errorCode:null});
      const { metadataOrigin, ...metadata }=await this.metadata(job,record);
      job=this.save(job,{metadata,metadataOrigin,draft:null},metadataOrigin==='local'?'文案已就绪：本机翻译与备用分区、标签':'投稿文案已就绪');
    }
    if(!job.coverUrl&&!job.replacement){
      if(this.store.settings().paused || this.stopping.signal.aborted)return;
      job=this.save(job,{state:'cover',phase:'cover'});
      const path=await this.cover(job);
      const result=await this.native('cover',job.accountId,{path});
      const url=typeof result?.url==='string' && result.url.startsWith('//')?'https:'+result.url:result?.url;
      if(typeof url!=='string'||!/^https?:\/\//i.test(url))throw fail('B 站未返回有效封面地址','BILIBILI_COVER',502);
      job=this.save(job,{coverUrl:url,coverPath:path},'已使用 YouTube 原封面');
    }
    if(!hasUpload(job)){
      if(this.store.settings().paused || this.stopping.signal.aborted)return;
      const release=this.ctx.files.readLock?.(job.taskId) ?? (()=>{});
      try {
        const file=await this.ctx.files.resolve(job.taskId,videoArtifact(record));
        const total=(await stat(file)).size;
        if(!total)throw fail('成片文件为空，请检查导出结果','PUBLICATION_MEDIA');
        job=this.save(job,{state:'uploading',phase:'upload',bytesUploaded:0,totalBytes:total});
        let last=0,bytes=0;
        const uploaded=await this.native('upload',job.accountId,{path:file},{timeout:24*3600000,onProgress:event=>{
          if(!Number.isFinite(event.bytes) || event.bytes<0)return;
          bytes=Math.max(bytes,Math.min(total,event.bytes));
          if(Date.now()-last>=750 || bytes===total && job.bytesUploaded!==total){
            last=Date.now();job=this.save(job,{bytesUploaded:bytes,totalBytes:total});
          }
        }});
        if(!hasUpload({uploaded}))throw fail('B 站未返回完整上传回执','BILIBILI_UPLOAD_RECEIPT',502);
        job=this.save(job,{uploaded,bytesUploaded:total,totalBytes:total,state:'ready_to_publish',phase:'submit'},'视频上传完成，已保存回执');
      } finally { release(); }
    }
    if(this.store.settings().paused || this.stopping.signal.aborted)return;
    const {fullTranslation,tags,...metadata}=job.metadata;
    const studio={...metadata,cover:job.coverUrl,videos:[{...job.uploaded,title:metadata.title}]};
    job=this.store.transaction(()=>{
      const current=this.store.job(job.id);
      if(hasSubmission(current)||!hasUpload(current)||this.store.settings().paused)return null;
      return this.save(current,{state:'submitting',phase:'submit',submissionStarted:true,submittedAt:Date.now(),studio,reviewAttempts:0},
        current.replacement?'已保存替换意图，开始更新原 B 站稿件':'已保存提交意图，开始向 B 站提交稿件');
    });
    if(!job)return;
    const target=job.replacement;
    const response=await (target ? this.native('replace_video',job.accountId,{
      aid:target.aid,previousFilename:target.filename,previousCid:target.cid,filename:job.uploaded.filename,visibility:job.metadata.is_only_self,
    },{timeout:90000}) : this.native('submit',job.accountId,{studio},{timeout:90000}));
    if(response?.identityMismatch&&target){
      this.save(job,{state:'needs_attention',phase:'submit',failurePhase:'submit',submissionStarted:false,nextRun:0,
        error:'原稿件的分 P 或可见范围已变更，请到创作中心核对。',errorCode:'BILIBILI_REPLACEMENT_MISMATCH'});return;
    }
    if(target&&response?.code===0){
      this.save(job,{state:'awaiting_review',phase:'review',nextRun:Date.now()+15000,error:null,errorCode:null,failurePhase:null,receipt:response},'B 站已接收替换申请，等待审核');return;
    }
    const aid=archiveId(response?.data?.aid), bvid=archiveBvid(response?.data?.bvid), code=response?.code;
    if(!target&&(aid || bvid)){
      this.save(job,{state:code===0?'awaiting_review':'reconciling',phase:'review',aid,bvid,receipt:response,acceptedAt:Date.now(),
        nextRun:Date.now()+15000,error:null,errorCode:null,failurePhase:null,attempts:0},
        code===0?'B 站已接收稿件，等待审核':'收到稿件编号，正在核对原稿件');return;
    }
    if(rateCodes.has(code)){
      const nextRun=Date.now()+1800000;
      this.cooldown(nextRun);
      this.save(job,{state:'retry_wait',phase:'submit',failurePhase:'submit',submissionStarted:false,receipt:response,nextRun,
        error:'B 站限流（'+code+'），等待冷却',errorCode:'BILIBILI_RATE'});return;
    }
    if(loginCodes.has(code)){
      this.save(job,{state:'needs_login',phase:'submit',failurePhase:'submit',submissionStarted:false,receipt:response,nextRun:0,
        error:'B 站登录失效，请重新扫码',errorCode:'BILIBILI_LOGIN'});return;
    }
    if(rejectionCodes.has(code)){
      this.save(job,{state:'needs_attention',phase:'submit',failurePhase:'submit',submissionStarted:false,receipt:response,nextRun:0,
        error:'B 站拒绝投稿（'+code+'）：'+redact(response.message || '请检查投稿字段'),errorCode:'BILIBILI_REJECTED'});
      return;
    }
    this.save(job,{state:'reconciling',phase:'review',receipt:response,nextRun:Date.now()+15000,
      error:'提交结果未确认，正在核对原稿件',errorCode:'BILIBILI_SUBMISSION_UNKNOWN'});
  }
  reconciliationWait(job,note,extra={}){
    const tries=(job.reviewAttempts || 0)+1;
    const attention=tries>=15&&(job.replacement||!job.aid&&!job.bvid);
    return this.save(job,{...extra,state:attention?'needs_attention':'reconciling',phase:'review',failurePhase:'review',reviewReason:note,
      error:attention?'暂时查不到原稿件，请到创作中心核对；系统不会重复投稿。':null,errorCode:attention?'BILIBILI_SUBMISSION_UNKNOWN':null,
      reviewAttempts:tries,lastReviewAt:Date.now(),nextRun:attention?0:Date.now()+60000});
  }
  async reconcile(job){
    this.account(job.accountId);
    if(!hasUpload(job) || !job.metadata)throw fail('缺少上传回执或投稿文案，请在创作中心人工核对','BILIBILI_RECONCILE_DATA');
    const target=job.replacement;
    const expectedAid=target?.aid ?? archiveId(job.aid),expectedBvid=target?.bvid ?? archiveBvid(job.bvid);
    const result=await this.native('reconcile',job.accountId,{aid:expectedAid,bvid:expectedBvid,filename:job.uploaded.filename,title:job.metadata.title});
    if(!result.matched){
      this.reconciliationWait(job,'B 站尚未匹配到这个上传片段，正在核对原稿件。');return;
    }
    const data=result.details,archive=data?.archive || data?.Archive || {},parts=Array.isArray(data?.videos)?data.videos:[];
    const value=archive.is_only_self ?? data?.is_only_self;
    const publicRange=value===0||value===1||value==='0'||value==='1'?Number(value):null;
    const matched=parts.find(part=>String(part.filename||'').replace(/\.mp4$/i,'')===job.uploaded.filename.replace(/\.mp4$/i,''));
    const aid=archiveId(archive.aid ?? data?.aid) || expectedAid, bvid=archiveBvid(archive.bvid ?? data?.bvid) || expectedBvid;
    if(!matched || !aid || expectedAid && aid!==expectedAid || expectedBvid && bvid!==expectedBvid || target&&parts.length!==1){
      this.reconciliationWait(job,'B 站回执与原上传片段尚未匹配。');return;
    }
    const valueState=archive.state ?? data?.state;
    const remoteState=valueState===null||valueState===undefined||valueState===''?null:Number(valueState);
    const base={aid,bvid,lastReviewAt:Date.now(),reviewAttempts:0,phase:'review',remoteState:Number.isFinite(remoteState)?remoteState:null};
    if ([-2,-16].includes(remoteState) || parts.some(part=>Number(part.fail_code || 0)>0)) {
      this.save(job,{...base,state:'rejected',nextRun:0,failurePhase:'review',error:redact(archive.reject_reason || archive.state_desc || 'B 站审核未通过'),
        errorCode:'BILIBILI_REVIEW_REJECTED',reviewReason:null});return;
    }
    if(publicRange===null){
      this.reconciliationWait(job,'找到了原稿件，等待 B 站返回可见范围。',base);return;
    }
    if(publicRange!==job.metadata.is_only_self){
      this.save(job,{...base,state:'needs_attention',nextRun:0,failurePhase:'review',error:'B 站稿件的可见范围与设置不同，请到创作中心核对。',
        errorCode:'BILIBILI_VISIBILITY',reviewReason:null});return;
    }
    if(remoteState===0 || remoteState===-50&&(archive.had_passed===true||data?.had_passed===true)){
      if(publicRange===1){
        if(target&&(!archiveId(matched.cid)||archiveId(matched.cid)===target.cid)){this.reconciliationWait(job,'等待 B 站确认新视频源。',base);return;}
        this.save(job,{...base,replacement:null,state:'private_ready',nextRun:0,error:null,errorCode:null,failurePhase:null,reviewReason:null});return;
      }
      const visible=await this.publicLookup({aid,bvid},this.stopping.signal);
      if(visible?.aid===aid && archiveBvid(visible.bvid) && (!bvid || visible.bvid===bvid) && (!target || archiveId(matched.cid)&&archiveId(matched.cid)!==target.cid&&archiveId(visible.cid)===archiveId(matched.cid))){
        this.save(job,{...base,replacement:null,bvid:visible.bvid,state:'published',publishedAt:Date.now(),nextRun:0,error:null,errorCode:null,failurePhase:null,reviewReason:null,
          cleanupPending:this.store.settings().cleanupAfterPublish!==false});return;
      }
      this.save(job,{...base,state:'awaiting_review',nextRun:Date.now()+60000,error:null,errorCode:null,failurePhase:null,
        reviewReason:'创作中心显示已通过，等待匿名访问可见。'});return;
    }
    if(remoteState!==null && ![-1,-30,-50,-60].includes(remoteState)){
      this.save(job,{...base,state:'needs_attention',nextRun:0,failurePhase:'review',error:redact(archive.state_desc || 'B 站返回了未识别的稿件状态，请人工核对。'),
        errorCode:'BILIBILI_REVIEW_STATUS',reviewReason:null});return;
    }
    this.save(job,{...base,state:'awaiting_review',nextRun:Date.now()+60000,error:null,errorCode:null,failurePhase:null,
      reviewReason:redact(archive.state_desc || '已提交，等待 B 站审核。')});
  }
  cooldown(until){
    const settings=this.store.settings();
    this.store.saveSettings({...settings,blockedUntil:Math.max(until,settings.blockedUntil || 0)});
  }
  handleError(job,error,phase){
    if(this.stopping.signal.aborted)return;
    const current=this.store.job(job.id),message=redact(error.message);
    const attempts=(current.attempts||0)+1,limited=error.status===429||error.code==='BILIBILI_RATE'||/\b(601|429|21566|21590)\b/.test(message);
    const youtube=/^YOUTUBE_AUTH_/.test(error.code || '') || /sign in to confirm|YouTube.*(?:要求登录|登录凭据)/i.test(message);
    const login=!youtube && loginError(error);
    const at=Date.now(),nextRun=at+(limited?1800000:Math.min(300000,10000*2**Math.min(attempts,5)));
    const failurePhase=phase==='media' || phase==='review'?phase:current.phase || 'metadata';
    if(limited && failurePhase!=='media')this.cooldown(nextRun);
    this.store.event(job.id,message);
    const common={failurePhase,error:message,errorCode:error.code || 'PUBLICATION_ERROR',attempts,...(error.draft?{draft:error.draft}:{}),
      ...(error.mediaAttempt===undefined?{}:{failedMediaAttempt:error.mediaAttempt}),...(phase==='review'?{lastReviewAt:at}:{})};
    if(hasSubmission(current)){
      const stopped=error.code==='BILIBILI_RECONCILE_DATA';
      this.save(current,{...common,state:login?'needs_login':stopped?'needs_attention':'reconciling',phase:'review',
        nextRun:login||stopped?0:Math.max(nextRun,at+15000)});
      return;
    }
    const waiting=youtube||login||error.status===422||error.code==='IMPORT_RESIDUE'||attempts>=5;
    this.save(current,{...common,state:youtube?'needs_youtube_login':login?'needs_login':waiting?'needs_attention':'retry_wait',nextRun:waiting?0:nextRun});
  }
  async runJob(job,phase,run){
    if(this.busyJobs.has(job.id)||this.stopping.signal.aborted)return;
    this.busyJobs.add(job.id);
    try{await run(job);}
    catch(error){this.handleError(job,error,phase);}
    finally{this.busyJobs.delete(job.id);}
  }
  async step(job){
    if(['published','private_ready','paused','cancelled','rejected'].includes(job.state))return;
    if(hasSubmission(job)){await this.reconcile(job);return;}
    if(await this.mediaStep(job))await this.publicationStep(this.store.job(job.id));
  }
  async queue(){
    const settings=this.store.settings();if(settings.paused || settings.blockedUntil>Date.now())return;
    const jobs=this.store.jobsIn([...new Set([...mediaStates,...publishStates,...reviewStates])],{now:Date.now(),limit:40});
    const job=jobs.find(item=>!this.busyJobs.has(item.id));
    if(job)await this.runJob(job,hasSubmission(job)?'review':job.phase==='media'?'media':'publication',item=>this.step(item));
  }
  async mediaCycle(){
    if(this.store.settings().paused)return;
    const due=this.store.jobsIn(mediaStates,{now:Date.now(),limit:40,retryPhase:'media'}).filter(item=>!hasSubmission(item));
    const job=due.find(item=>!this.busyJobs.has(item.id));
    if(job)await this.runJob(job,'media',item=>this.mediaStep(item));
    const now=Date.now();
    if(now<(this.mediaRecoveryAt || 0))return;
    this.mediaRecoveryAt=now+10000;
    const candidates=this.store.jobsIn(['needs_attention'],{limit:30,offset:this.mediaRecoveryOffset || 0});
    this.mediaRecoveryOffset=candidates.length<30?0:(this.mediaRecoveryOffset || 0)+30;
    const parked=candidates.filter(item=>!hasSubmission(item)&&!item.uploaded&&mediaFailure(item)&&!this.busyJobs.has(item.id));
    const snapshots=await this.mediaSummaries(parked.map(item=>item.taskId));
    for(const item of parked){
      const media=snapshots.get(item.taskId);
      const interrupted=media?.status==='failed'&&['APP_INTERRUPTED','EXTERNAL_RESULT_UNKNOWN'].includes(item.errorCode);
      const repairedWorkflow=media?.status==='failed'&&item.errorCode==='WORKFLOW_VERSION_UNAVAILABLE'&&item.workflowRecoveryVersion!==this.version;
      const resumed=media&&['queued','running','waiting'].includes(media.status)&&media.attempt>(item.failedMediaAttempt??0);
      if(!interrupted&&!repairedWorkflow&&!resumed&&(media?.status!=='succeeded'||item.failedMediaAttempt!==undefined&&media.attempt<=item.failedMediaAttempt))continue;
      const current=this.store.job(item.id);
      if(current.state==='needs_attention'&&!hasSubmission(current)&&mediaFailure(current)&&!this.store.settings().paused){
        await this.runJob(current,'media',job=>this.mediaStep(job,{recover:true}));
      }
    }
  }
  async publicationCycle(){
    const settings=this.store.settings();if(settings.paused||settings.blockedUntil>Date.now())return;
    const job=this.store.jobsIn(publishStates,{now:Date.now(),limit:40,retryPhase:'publication'}).find(item=>!this.busyJobs.has(item.id)&&!hasSubmission(item));
    if(job)await this.runJob(job,'publication',item=>this.publicationStep(item));
  }
  async reviewCycle(){
    const settings=this.store.settings();if(settings.paused||settings.blockedUntil>Date.now())return;
    const job=this.store.jobsIn(reviewStates,{now:Date.now(),limit:40}).find(item=>!this.busyJobs.has(item.id)&&hasSubmission(item));
    if(job)await this.runJob(job,'review',item=>this.reconcile(item));
  }
  async cleanupCycle(){
    const automatic=this.store.settings().cleanupAfterPublish!==false;
    let job=this.store.cleanupDue(Date.now(),automatic).find(item=>!this.busyJobs.has(item.id)&&!this.thumbnails.has(item.id));
    if(!job)return;
    this.busyJobs.add(job.id);
    try{
      if(!uuid.test(job.id)||!uuid.test(job.taskId)||!job.publishedAt||!archiveBvid(job.bvid)||job.metadata?.is_only_self!==0){
        throw fail('缺少已公开发布的确认记录，已保留本地素材','CLEANUP_CONFIRMATION');
      }
      const media=await this.mediaRecord(job);
      if(media&&media.status!=='succeeded')throw fail('成片任务未完成，已保留素材','CLEANUP_MEDIA');
      const durationSeconds=publicationDurationSeconds(job,media);
      if(media)job=this.save(job,{productionTiming:productionTiming(job,media)});
      if(durationSeconds!==null&&job.durationSeconds!==durationSeconds)job=this.save(job,{durationSeconds});
      const jobDirectory=join(this.data,'automation',job.id);
      await verifyOwnedDirectory(jobDirectory,this.data);
      const taskDirectory=this.ctx.files.taskRoot(job.taskId);
      if(resolve(taskDirectory)!==resolve(this.data,'tasks',job.taskId))throw fail('任务目录与记录不匹配','CLEANUP_DIRECTORY');
      await verifyOwnedDirectory(taskDirectory,this.data);
      if(media)await this.ctx.tasks.delete(job.taskId,media.attempt);
      else{
        const release=await this.ctx.files.reserve(job.taskId);
        try{await rm(taskDirectory,{recursive:true,force:true});}finally{await release();}
      }
      await rm(jobDirectory,{recursive:true,force:true});
      this.save(job,{cleanupPending:false,cleanedAt:Date.now(),cleanupError:null,coverPath:null,durationSeconds},'已清理本地原视频、配音、中间文件和成片');
    }catch(error){
      const permanent=['CLEANUP_DIRECTORY','CLEANUP_CONFIRMATION','CLEANUP_MEDIA'].includes(error.code);
      this.save(job,{cleanupPending:!permanent,cleanupError:redact(error.message),cleanupNextRun:Date.now()+60000});
    }finally{this.busyJobs.delete(job.id);}
  }
  async control(id,action){
    const job=this.store.job(id);
    if(this.busyJobs.has(id))throw fail('当前步骤正在执行，请稍后再操作','PUBLICATION_BUSY',409);
    if(action==='remake'){
      if(!canRemake(job))throw fail('只有已确认的 B 站稿件可重新制作和替换。','PUBLICATION_REMAKE',409);
      this.account(job.accountId);
      this.busyJobs.add(id);
      try{
        const aid=archiveId(job.aid),bvid=archiveBvid(job.bvid),filename=job.uploaded.filename;
        const current=await this.native('reconcile',job.accountId,{aid,bvid,filename});
        const archive=current.details?.archive || current.details?.Archive;
        const parts=current.details?.videos;
        const cid=archiveId(parts?.[0]?.cid);
        if(!current.matched||parts?.length!==1||!cid||archiveId(archive?.aid)!==aid||
          bvid&&archiveBvid(archive?.bvid)!==bvid||String(archive?.is_only_self)!==String(job.metadata.is_only_self)){
          throw fail('无法确认原单分 P 稿件，请到创作中心核对。','BILIBILI_REPLACEMENT_MISMATCH',409);
        }
        return this.save(job,{taskId:randomUUID(),replacement:{aid,bvid,filename,cid,taskId:job.taskId},
          state:'queued',phase:'media',nextRun:0,aid:null,bvid:null,uploaded:null,receipt:null,studio:null,submissionStarted:false,submittedAt:null,
          acceptedAt:null,publishedAt:null,mediaReadyAt:null,productionTiming:null,bytesUploaded:0,totalBytes:0,error:null,errorCode:null,failurePhase:null,
          attempts:0,mediaRetries:0,mediaRetryStage:null,failedMediaAttempt:null,remoteState:null,reviewReason:null,lastReviewAt:null,
          cleanupPending:false,cleanupRequested:false,cleanupError:null,cleanedAt:null,dubbedSegments:null,preservedRanges:null},'已排队重新制作，成片上传后替换原稿件视频源');
      }finally{this.busyJobs.delete(id);}
    }
    if(action==='cleanup'){
      if(job.state!=='published'||!job.publishedAt||!archiveBvid(job.bvid)||job.metadata?.is_only_self!==0||job.cleanedAt||job.cleanupPending){
        throw fail('此任务当前无法清理本地文件','CLEANUP_CONFIRMATION');
      }
      this.busyJobs.add(id);
      try{
        const visible=await this.publicLookup({aid:archiveId(job.aid),bvid:job.bvid},this.stopping.signal);
        if(visible?.bvid!==job.bvid||job.aid&&visible.aid!==archiveId(job.aid))throw fail('暂时无法确认稿件公开可访问，已保留素材','CLEANUP_CONFIRMATION');
        return this.save(job,{cleanupPending:true,cleanupRequested:true,cleanupNextRun:0,cleanupError:null},'已确认公开稿件，准备清理本地素材');
      }finally{this.busyJobs.delete(id);}
    }
    if(hasSubmission(job)){
      if(action!=='verify')throw fail('已经提交或结果待确认的任务只能核对原稿件');
      if(['published','private_ready','rejected'].includes(job.state))throw fail('稿件已有最终结果，请到 B 站查看');
      return this.save(job,{state:'reconciling',phase:'review',nextRun:0,reviewAttempts:0,error:null,errorCode:null},'已安排核对原稿件');
    }
    if(!['pause','resume','retry','cancel'].includes(action))throw fail('无效任务操作');
    this.busyJobs.add(id);
    try{
      if(['pause','cancel'].includes(action)){
        try{const task=await this.ctx.tasks.get(job.taskId);if(!['succeeded','failed','cancelled'].includes(task.status))await this.ctx.tasks.cancel(job.taskId,task.attempt,task.revision);}
        catch(error){if(error.code!=='TASK_NOT_FOUND')throw error;}
        return this.save(job,{state:action==='pause'?'paused':'cancelled',error:null,errorCode:null,nextRun:0});
      }
      let task;
      try{
        task=await this.ctx.tasks.get(job.taskId);
        if(task.status==='cancelling')throw fail('媒体任务正在停止，请稍后恢复');
        if(['failed','cancelled'].includes(task.status))await this.ctx.tasks.retry(job.taskId,task.attempt);
      }catch(error){if(error.code!=='TASK_NOT_FOUND')throw error;}
      const mediaReady=task?.status==='succeeded'||hasUpload(job);
      const next=job.nextRun>Date.now()&&job.errorCode==='BILIBILI_RATE'?job.nextRun:0;
      const phase=!mediaReady?'media':!job.metadata?'metadata':!job.coverUrl&&!job.replacement?'cover':!hasUpload(job)?'upload':'submit';
      return this.save(job,{state:mediaReady?'ready_to_publish':'queued',phase,
        attempts:0,mediaRetries:0,mediaRetryStage:null,nextRun:next,error:null,errorCode:null,failurePhase:null},
        mediaReady?'继续原稿件，复用现有成片':'已安排继续原成片任务');
    }finally{this.busyJobs.delete(id);}
  }
  async updateMetadata(id,input){
    const job=this.store.job(id);
    if(this.busyJobs.has(id)||job.replacement||hasSubmission(job)||['paused','cancelled'].includes(job.state))throw fail('当前任务不能修改投稿信息');
    this.busyJobs.add(id);
    try{
      const record=await this.mediaRecord(job);
      if(record?.status!=='succeeded'&&!hasUpload(job))throw fail('请等待成片导出后再编辑投稿文案');
      if(input.expectedUpdatedAt!==undefined&&input.expectedUpdatedAt!==(job.updatedAt ?? job.createdAt)){
        throw fail('投稿信息已变化，请刷新后修改','PUBLICATION_REVISION',409);
      }
      const categories=await this.categories(job.accountId);
      let metadata;
      try{metadata=metadataFromDraft(job,input,categories);}
      catch(error){throw fail(error.message,'PUBLICATION_METADATA');}
      await this.saveMetadataFiles(job,metadata);
      const updated=this.save(job,{metadata,metadataOrigin:'manual',draft:null,state:'ready_to_publish',
        phase:job.coverUrl?(hasUpload(job)?'submit':'upload'):'cover',mediaReadyAt:job.mediaReadyAt || Date.now(),
        nextRun:0,attempts:0,error:null,errorCode:null,failurePhase:null},'已保存手动文案，继续原任务');
      return {...updated,events:this.store.events(id)};
    }finally{this.busyJobs.delete(id);}
  }
  async mediaSummaries(ids){
    if(!ids.length)return new Map();
    const unique=[...new Set(ids)];
    const results=this.ctx.store?.call ? await this.ctx.store.call('store.get_many',{ids:unique})
      : (await Promise.all(unique.map(taskId=>this.mediaRecord({taskId})))).filter(Boolean);
    return new Map(results.map((value,index)=>[value.id ?? unique[index],value]));
  }
  async jobPage(query){
    const group=query.get('group') || '', search=(query.get('q') || '').trim();
    const limit=Number(query.get('limit') ?? 30),offset=Number(query.get('offset') ?? 0);
    if(group && !Object.hasOwn(publicationGroups,group) || search.length>160 || !Number.isInteger(limit) || limit<1 || limit>50 ||
      !Number.isInteger(offset) || offset<0 || offset>100000)throw fail('发布列表参数无效');
    const page=this.store.page({states:publicationGroups[group],query:search,limit,offset});
    const settings=this.store.settings(),byState=this.store.counts();
    const counts=Object.fromEntries(Object.entries(publicationGroups).map(([key,states])=>[key,states.reduce((n,state)=>n+(byState[state] || 0),0)]));
    counts.all=Object.values(byState).reduce((a,b)=>a+b,0);
    const media=await this.mediaSummaries(page.items.map(item=>item.taskId));
    return {...page,counts,paused:!!settings.paused,blockedUntil:settings.blockedUntil || null,accounts:this.publicAccounts(),
      items:page.items.map(job=>this.project(job,media.get(job.taskId),settings))};
  }
  project(job,media,settings=this.store.settings()){
    return {...publicationView(job,media,{paused:!!settings.paused,blockedUntil:settings.blockedUntil,busy:this.busyJobs.has(job.id)}),
      thumbnail:job.cleanupPending||job.cleanedAt ? job.coverUrl || null : fileURL('/api/v2/automation/jobs/'+encodeURIComponent(job.id)+'/thumbnail')};
  }
  async jobLinks(query){
    const ids=(query.get('taskIds') || '').split(',').filter(Boolean);
    if(ids.length>60 || ids.some(id=>!/^[a-zA-Z\d][a-zA-Z\d_.:-]{0,127}$/.test(id)))throw fail('任务列表参数无效');
    const jobs=this.store.forTasks(ids), media=await this.mediaSummaries(jobs.map(job=>job.taskId));
    return {items:this.linkedJobs(jobs,media)};
  }
  publicationForTasks(tasks){
    const media=new Map(tasks.map(task=>[task.id,task]));
    return new Map(this.linkedJobs(this.store.forTasks([...media.keys()]),media).map(link=>[link.taskId,link]));
  }
  linkedJobs(jobs,media){
    const settings=this.store.settings();
    return jobs.map(job=>{
      const { id,taskId,status,group,state,phase,phaseLabel,archive,mediaReady }=this.project(job,media.get(job.taskId),settings);
      return {id,taskId,status,group,state,phase,phaseLabel,archive,mediaReady};
    });
  }
  assertCanRemoveMedia(id){
    if(this.store.forTasks([id]).some(job=>!hasUpload(job)&&!hasSubmission(job)&&!['cancelled','published','private_ready','rejected'].includes(job.state))){
      throw fail('这个成片仍关联投稿任务，请先在发布工作台取消投稿，再删除文件。','PUBLICATION_MEDIA_IN_USE',409);
    }
  }
  async jobDetail(id){
    const job=this.store.job(id),media=(await this.mediaSummaries([job.taskId])).get(job.taskId);
    const view=this.project(job,media);
    return {...publicJob(job),publication:view,draft:publicationDraft(job),revision:job.updatedAt ?? job.createdAt,
      events:this.store.events(id).map(({time,message})=>({time,message:redact(message)}))};
  }
  start(){
    if(this.started)return;
    this.started=true;
    for(const [method,poll] of [['monitor',2000],['monitor',2300],['mediaCycle',1300],['publicationCycle',1300],['reviewCycle',2000],['cleanupCycle',4000],['profiles',2500],['syncYoutubeQueue',15000]]){
      const run=async()=>{while(!this.stopping.signal.aborted){try{await this[method]();}catch(error){this.ctx.logger.error(redact(error.message));}try{await delay(poll,undefined,{signal:this.stopping.signal,ref:false});}catch{break;}}};
      this.track(run());
    }
  }
  async stop(){if(this.stopping.signal.aborted)return;this.stopping.abort();await Promise.allSettled([...this.inflight]);this.store.close();}
}

export async function registerAutomationRoutes(ctx,http,{root,data,python,version,translationSlot}){
  await mkdir(join(data,'bilibili'),{recursive:true});
  const store=new AutomationStore(join(data,'automation.sqlite'));
  const executable=resolve(process.env.YOUDUB2BI_UPLOADER || join(root,'native','bin','youdub2bi-uploader.exe'));
  const transport=(command,request,options)=>jsonProcess(executable,[],{command,...request},options);
  const channelWorker=request=>jsonProcess(python,['-m','backend.workers.channel_monitor'],{...request,dataDir:data,node:process.env.YOUDUB_NODE_PATH || process.execPath},{cwd:root,signal:automation.stopping.signal,timeout:request.command==='scan'?180000:600000});
  const automation=new Automation(ctx,{root,data,python,store,transport,channelWorker,version,translationSlot});
  const route=(method,path,handler)=>ctx.effect(()=>http.register(method,`/api/v2/automation${path}`,async request=>{http.json(request,200,await handler(request));}));
  route('GET','',()=>({channels:store.channels().map(channel=>automation.channelView(channel)),jobs:store.page({limit:300}).items.map(publicJob),accounts:automation.publicAccounts(),settings:store.settings(),states:automationStates}));
  route('GET','/configuration',()=>({channels:store.channels().map(channel=>automation.channelView(channel)),accounts:automation.publicAccounts(),settings:store.settings(),metadataModels:automation.llmSelections()}));
  route('GET','/jobs',request=>automation.jobPage(request.url.searchParams));
  route('GET','/job-links',request=>automation.jobLinks(request.url.searchParams));
  route('GET','/categories',request=>automation.categories(request.url.searchParams.get('accountId') || store.accounts()[0]?.id));
  route('POST','/login',()=>automation.startLogin());route('GET','/login',()=>automation.login);
  route('POST','/channels',async request=>automation.addChannel(await readJson(request)));
  route('POST','/videos',async request=>automation.addVideo(await readJson(request)));
  route('GET','/channels/:id/videos',request=>automation.channelVideos(request.params.id,{offset:request.url.searchParams.get('offset') ?? 0,limit:request.url.searchParams.get('limit') ?? 30}));
  route('POST','/channels/:id/videos',async request=>automation.addChannelVideos(request.params.id,await readJson(request)));
  route('GET','/youtube',()=>automation.youtube('status'));
  route('POST','/youtube',async request=>automation.importYoutube(await readJson(request)));
  route('DELETE','/youtube',()=>automation.youtube('clear'));
  route('POST','/youtube/check',async request=>{const input=await readJson(request);return channelWorker({command:'check',url:input.url || 'https://www.youtube.com/watch?v=jNQXAC9IVRw',proxyPort:store.settings().proxyPort ?? 7897});});
  route('POST','/channels/:id/profile',request=>{const channel=store.channels().find(item=>item.id===request.params.id);if(!channel)throw fail('频道不存在');return publicChannel(store.saveChannel({...channel,profileRefreshRequested:true,profileNextCheck:0}));});
  ctx.effect(()=>http.register('GET','/api/v2/automation/channels/:id/avatar',async request=>{
    const channel=store.channels().find(item=>item.id===request.params.id);if(!channel?.avatarReady)throw Object.assign(fail('频道头像尚未准备好'),{status:404});
    const path=automation.avatarPath(channel.id);await http.file(request,path,{mime:'image/jpeg'});
    request.result.headers.set('cache-control','private, max-age=86400');
  }));
  route('PATCH','/channels/:id',async request=>{
    const channel=store.channels().find(item=>item.id===request.params.id);if(!channel)throw fail('频道不存在');
    const patch=await readJson(request), changes={};
    if(patch.template)changes.template=automation.template(patch.template);
    if(patch.enabled!==undefined){if(typeof patch.enabled!=='boolean')throw fail('启用状态无效');changes.enabled=patch.enabled;}
    if(patch.intervalMinutes!==undefined){const interval=Number(patch.intervalMinutes);if(!Number.isInteger(interval)||interval<1||interval>1440)throw fail('检查间隔无效');changes.intervalMinutes=interval;}
    const port=Number(patch.proxyPort??channel.proxyPort??7897),workflowId=patch.workflowId||channel.workflowId;
    if(!Number.isInteger(port)||port<0||port>65535)throw fail('代理端口无效');
    if(workflowId!==channel.workflowId||port!==channel.proxyPort){
      changes.graph=await automation.graph(workflowId,port);changes.workflowId=workflowId;changes.proxyPort=port;
    }
    const current=store.channels().find(item=>item.id===channel.id);
    if(!current)throw fail('频道已移除');
    if((current.settingsRevision||0)!==(channel.settingsRevision||0))throw fail('频道设置已变化，请刷新后再保存','CHANNEL_CONFLICT',409);
    const changedConnection=port!==channel.proxyPort||changes.enabled!==undefined&&changes.enabled!==current.enabled;
    return automation.channelView(store.saveChannel({...current,...changes,settingsRevision:(current.settingsRevision||0)+1,
      checkEpoch:(current.checkEpoch||0)+Number(changedConnection),nextCheck:changedConnection?0:current.nextCheck,
      checkRequested:changedConnection?!!(changes.enabled??current.enabled):current.checkRequested}));
  });
  route('POST','/channels/:id/check',request=>automation.requestChannelCheck(request.params.id));
  route('DELETE','/channels/:id',request=>{store.deleteChannel(request.params.id);return {ok:true};});
  route('POST','/jobs/:id/:action',async request=>publicJob(await automation.control(request.params.id,request.params.action)));
  ctx.effect(()=>http.register('GET','/api/v2/automation/jobs/:id/thumbnail',async request=>{
    const path=await automation.thumbnail(request.params.id);
    await http.file(request,path,{mime:'image/jpeg'});
    request.result.headers.set('cache-control','private, max-age=3600');
  }));
  route('GET','/jobs/:id',request=>automation.jobDetail(request.params.id));
  route('PATCH','/jobs/:id/metadata',async request=>publicJob(await automation.updateMetadata(request.params.id,await readJson(request))));
  route('PATCH','/settings',async request=>{
    const patch=await readJson(request), settings=store.settings();
    if(patch.paused!==undefined){if(typeof patch.paused!=='boolean')throw fail('暂停设置无效');settings.paused=patch.paused;}
    if(patch.proxyPort!==undefined){const port=Number(patch.proxyPort);if(!Number.isInteger(port)||port<0||port>65535)throw fail('代理端口无效');settings.proxyPort=port;}
    if(patch.maxHeight!==undefined){if(!resolutions.has(patch.maxHeight))throw fail('下载分辨率上限无效');settings.maxHeight=patch.maxHeight;}
    if(patch.videoEncoder!==undefined){if(!videoEncoders.some(item=>item.value===patch.videoEncoder))throw fail('视频编码器无效');settings.videoEncoder=patch.videoEncoder;}
    if(patch.speechPerformance!==undefined){if(!['quality','balanced','nano2','nano4'].includes(patch.speechPerformance))throw fail('配音档位无效');settings.speechPerformance=patch.speechPerformance;}
    if(patch.cleanupAfterPublish!==undefined){if(typeof patch.cleanupAfterPublish!=='boolean')throw fail('素材清理设置无效');settings.cleanupAfterPublish=patch.cleanupAfterPublish;}
    if(patch.metadataSelection!==undefined){
      const selection=patch.metadataSelection;
      if(selection!==null&&!automation.llmSelections().some(item=>item.id===selection?.id&&item.model===selection?.model))throw fail('投稿大模型当前不可用');
      settings.metadataSelection=selection===null?null:{id:selection.id,model:selection.model};
    }
    store.saveSettings(settings);
    if(patch.paused===false)await automation.resumeYoutube();
    return store.settings();
  });
  ctx.on('app/ready',()=>automation.start());ctx.on('app/stopping',()=>automation.stop());ctx.effect(()=>()=>automation.stop());
  return automation;
}
