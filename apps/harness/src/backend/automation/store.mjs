import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { hasSubmission } from './publication-view.mjs';
const placeholders = values => values.map(() => '?').join(',');
const documents = rows => rows.map(row => JSON.parse(row.document));
export class AutomationStore {
  constructor(path) {
    this.db=new DatabaseSync(path);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS bi_channels(id TEXT PRIMARY KEY, channel_id TEXT NOT NULL UNIQUE, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bi_jobs(id TEXT PRIMARY KEY, video_id TEXT NOT NULL, account_id TEXT NOT NULL, state TEXT NOT NULL, next_run INTEGER NOT NULL DEFAULT 0, document TEXT NOT NULL, UNIQUE(video_id,account_id));
      CREATE TABLE IF NOT EXISTS bi_accounts(id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bi_settings(key TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bi_events(id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, time INTEGER NOT NULL, message TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS bi_jobs_due ON bi_jobs(state,next_run);
      CREATE INDEX IF NOT EXISTS bi_jobs_task ON bi_jobs(json_extract(document,'$.taskId'));
      CREATE INDEX IF NOT EXISTS bi_events_by_job ON bi_events(job_id,id);`);
    const settings=this.settings();
    if(!settings.proxyDefaultsVersion)this.saveSettings({...settings,proxyPort:settings.proxyPort || 7897,proxyDefaultsVersion:1});
    for(const job of this.jobsIn(['uploading','submitting','cover']))this.saveJob({
      ...job,state:hasSubmission(job)?'reconciling':'ready_to_publish',nextRun:0,
      ...(!hasSubmission(job)&&!job.uploaded?{bytesUploaded:0}:{}),
    });
    for(const job of this.jobsIn(['published'])){
      if(job.metadata?.is_only_self===1)this.saveJob({...job,state:'private_ready'});
      else if(!job.publishedAt&&job.aid&&job.uploaded?.filename)this.saveJob({...job,state:'awaiting_review',nextRun:0});
    }
    for(const job of this.jobsIn(['needs_attention'])){
      if(hasSubmission(job)&&job.remoteState===-60&&job.errorCode==='BILIBILI_REVIEW_STATUS'){
        this.saveJob({...job,state:'awaiting_review',nextRun:0,error:null,errorCode:null,failurePhase:null,reviewReason:'B 站正在转码'});
      }
    }
  }
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  channels(){return this.db.prepare('SELECT document FROM bi_channels').all().map(row=>JSON.parse(row.document));}
  saveChannel(channel){this.db.prepare('INSERT INTO bi_channels VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET channel_id=excluded.channel_id,document=excluded.document').run(channel.id,channel.channelId,JSON.stringify(channel));return channel;}
  deleteChannel(id){this.db.prepare('DELETE FROM bi_channels WHERE id=?').run(id);}
  accounts(){return this.db.prepare('SELECT document FROM bi_accounts').all().map(row=>JSON.parse(row.document));}
  saveAccount(account){this.db.prepare('INSERT OR REPLACE INTO bi_accounts VALUES(?,?)').run(account.id,JSON.stringify(account));return account;}
  settings(){return JSON.parse(this.db.prepare("SELECT document FROM bi_settings WHERE key='settings'").get()?.document || '{"paused":false,"proxyPort":7897}');}
  saveSettings(value){this.db.prepare("INSERT OR REPLACE INTO bi_settings VALUES('settings',?)").run(JSON.stringify(value));return value;}
  jobs(){return documents(this.db.prepare('SELECT document FROM bi_jobs ORDER BY rowid DESC').all());}
  jobsIn(states,{limit=1000,now=Number.MAX_SAFE_INTEGER,offset=0,retryPhase}={}){
    const phaseFilter=retryPhase==='media'?" AND (state<>'retry_wait' OR coalesce(json_extract(document,'$.failurePhase'),'media')='media')"
      : retryPhase==='publication'?" AND (state<>'retry_wait' OR coalesce(json_extract(document,'$.failurePhase'),'media')<>'media')":'';
    return documents(this.db.prepare('SELECT document FROM bi_jobs WHERE state IN ('+placeholders(states)+') AND next_run<=?'+phaseFilter+' ORDER BY next_run,rowid LIMIT ? OFFSET ?').all(...states,now,limit,offset));
  }
  page({states,query='',limit=30,offset=0}){
    const where = [], values = [];
    if(states?.length){where.push('state IN ('+placeholders(states)+')');values.push(...states);}
    if(query){where.push("instr(lower(coalesce(json_extract(document,'$.source.title'),'') || ' ' || coalesce(json_extract(document,'$.source.channel'),'') || ' ' || coalesce(json_extract(document,'$.metadata.title'),'') || ' ' || video_id),lower(?)) > 0");values.push(query);}
    const entries=documents(this.db.prepare('SELECT document FROM bi_jobs '+(where.length?'WHERE '+where.join(' AND '):'')+' ORDER BY rowid DESC LIMIT ? OFFSET ?').all(...values,limit+1,offset));
    return { items:entries.slice(0,limit),limit,offset,hasMore:entries.length>limit };
  }
  counts(){return Object.fromEntries(this.db.prepare('SELECT state,count(*) AS count FROM bi_jobs GROUP BY state').all().map(row=>[row.state,row.count]));}
  cleanupDue(now,automatic){return documents(this.db.prepare("SELECT document FROM bi_jobs WHERE state='published' AND json_extract(document,'$.cleanupPending')=1 AND coalesce(json_extract(document,'$.cleanupNextRun'),0)<=? AND (?=1 OR json_extract(document,'$.cleanupRequested')=1) ORDER BY rowid LIMIT 20").all(now,Number(automatic)));}
  forTasks(ids){
    return ids.length?documents(this.db.prepare("SELECT document FROM bi_jobs WHERE json_extract(document,'$.taskId') IN ("+placeholders(ids)+') ORDER BY rowid DESC').all(...ids)):[];
  }
  job(id){const row=this.db.prepare('SELECT document FROM bi_jobs WHERE id=?').get(id);if(!row)throw Object.assign(new Error('发布任务不存在'),{status:404,code:'PUBLICATION_NOT_FOUND'});return JSON.parse(row.document);}
  jobForVideo(videoId,accountId){const row=this.db.prepare('SELECT document FROM bi_jobs WHERE video_id=? AND account_id=?').get(videoId,accountId);return row?JSON.parse(row.document):null;}
  saveJob(job){job.updatedAt=Date.now();this.db.prepare('UPDATE bi_jobs SET state=?,next_run=?,document=? WHERE id=?').run(job.state,job.nextRun||0,JSON.stringify(job),job.id);return job;}
  enqueue(channel,source){const job={id:randomUUID(),videoId:source.id,accountId:channel.accountId,channelId:channel.id,source,template:structuredClone(channel.template),graph:structuredClone(channel.graph),state:'queued',createdAt:Date.now(),attempts:0,nextRun:0,taskId:randomUUID()};const result=this.db.prepare('INSERT OR IGNORE INTO bi_jobs VALUES(?,?,?,?,?,?)').run(job.id,source.id,channel.accountId,job.state,0,JSON.stringify(job));return result.changes?job:null;}
  event(id,message){this.db.prepare('INSERT INTO bi_events(job_id,time,message) VALUES(?,?,?)').run(id,Date.now(),message);}
  events(id){return this.db.prepare('SELECT time,message FROM bi_events WHERE job_id=? ORDER BY id DESC LIMIT 100').all(id);}
  close(){this.db.close();}
}
