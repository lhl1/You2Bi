//! StreamArchive/biliup transport adapter. The host owns the durable queue.
use biliup::{credential::{Credential,login_by_cookies,save_login_info}, uploader::{VideoFile, bilibili::{Studio,Vid},line::{self,UploadObserver}}, client::StatelessClient};
use futures::TryStreamExt;
use serde_json::{Value,json};
use std::{io::{self,BufRead,Write},path::Path,sync::atomic::{AtomicU64,Ordering},time::Duration};
type Result<T> = std::result::Result<T,Box<dyn std::error::Error + Send + Sync>>;
fn output(value:Value){let mut out=io::stdout().lock();let _=writeln!(out,"{value}");let _=out.flush();}
struct Progress{bytes:AtomicU64,total:u64}
impl UploadObserver for Progress{fn chunk_confirmed(&self,_:usize,bytes:usize)->bool{let bytes=self.bytes.fetch_add(bytes as u64,Ordering::Relaxed)+bytes as u64;output(json!({"event":"progress","bytes":bytes,"total":self.total}));true}}
fn string<'a>(v:&'a Value,key:&str)->Result<&'a str>{v[key].as_str().ok_or_else(||format!("Missing {key}").into())}
fn credential_lock(path:&str)->Result<std::fs::File>{
 let file=std::fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(Path::new(path).with_extension("lock"))?;
 file.lock()?;
 Ok(file)
}
async fn run(v:Value)->Result<Value>{
 let command=string(&v,"command")?;
 if command=="qr_start" {return Ok(Credential::new(None).get_qrcode().await?);}
 let credential=string(&v,"credentialPath")?;
 if command=="import_credential" {
  let bytes=biliup::uploader::credential_store::read(Path::new(string(&v,"sourcePath")?))?;
  let login:biliup::credential::LoginInfo=serde_json::from_slice(&bytes)?;
  let value=serde_json::to_value(&login)?;
  let _guard=credential_lock(credential)?;
  save_login_info(credential,&login).await?;
  return Ok(json!({"mid":value["token_info"]["mid"].to_string().trim_matches('"')}));
 }
 if command=="qr_login" {
  let login=tokio::time::timeout(Duration::from_secs(180),Credential::new(None).login_by_qrcode(v["challenge"].clone())).await??;
  let raw=serde_json::to_value(&login)?;
  let mid=raw["token_info"]["mid"].as_u64().or_else(||raw["token_info"]["mid"].as_str().and_then(|x|x.parse().ok())).ok_or("Login response has no account ID")?;
  if let Some(expected)=v["expectedMid"].as_str(){if expected!=mid.to_string(){return Err("请使用原绑定账号扫码，账号不一致".into());}}
  let _guard=credential_lock(credential)?;
  save_login_info(credential,&login).await?;
  return Ok(json!({"mid":mid.to_string()}));
 }
 let bili={let _guard=credential_lock(credential)?;login_by_cookies(credential,None).await?};
 match command {
  "account"=>Ok(bili.my_info().await?),
  "categories"=>Ok(bili.archive_pre().await?),
  "archive_web"=>{
   let aid=v["aid"].as_u64().ok_or("Missing aid")?;
   Ok(bili.client.get("https://member.bilibili.com/x/vupre/web/archive/view").query(&[("aid",aid.to_string())]).timeout(Duration::from_secs(30)).send().await?.json().await?)
  },
  "update_private_description"=>{
   let aid=v["aid"].as_u64().ok_or("Missing aid")?;
   let mut studio=bili.studio_data(&Vid::Aid(aid),None).await?;
   let filename=string(&v,"filename")?.trim_end_matches(".mp4");
   if studio.is_only_self!=Some(1) || studio.videos.len()!=1 || !studio.videos.iter().any(|part|part.filename.trim_end_matches(".mp4")==filename && part.cid.is_some()) {return Err("Private archive identity check failed".into());}
   studio.aid=Some(aid);studio.desc=string(&v,"description")?.to_string();studio.desc_format_id=9999;studio.extra_fields=None;
   studio.desc_v2=if v["structured"].as_bool()==Some(true){Some(vec![biliup::bilibili::Credit{type_id:1,raw_text:studio.desc.clone(),biz_id:Some(String::new())}])}else{None};
   Ok(serde_json::to_value(bili.edit_web_response(&studio).await?)?)
  },
  "recommend_tags"=>Ok(bili.recommend_tag(v["tid"].as_u64().ok_or("Missing tid")? as u16,string(&v,"title")?,"").await?),
  "cover"=>Ok(json!({"url":bili.cover_up(&std::fs::read(string(&v,"path")?)?).await?})),
  "upload"=>{
   let file=VideoFile::new(Path::new(string(&v,"path")?))?;
   let total=std::fs::metadata(string(&v,"path")?)?.len();
   let client=StatelessClient::for_upload(None);
   let parcel=line::bda2().pre_upload(&bili,file).await?;
   let progress=Progress{bytes:AtomicU64::new(0),total};
   let video=parcel.upload_with_observer(client,3,|stream|stream.map_ok(|bytes|{let len=bytes.len();(bytes,len)}).map_err(Into::into),Some(&progress)).await?;
   Ok(serde_json::to_value(video)?)
  },
  "submit"=>{
   let studio:Studio=serde_json::from_value(v["studio"].clone())?;
   let result=bili.submit_web_response(&studio,None).await?;
   Ok(serde_json::to_value(result)?)
  },
  "replace_video"=>{
   let aid=v["aid"].as_u64().filter(|id|*id>0).ok_or("Missing aid")?;
   let previous=string(&v,"previousFilename")?.trim_end_matches(".mp4");
   let next=string(&v,"filename")?.trim_end_matches(".mp4");
   if next.is_empty() || next==previous {return Err("Invalid replacement file identity".into());}
   let mut studio=bili.studio_data(&Vid::Aid(aid),None).await?;
   let previous_cid=v["previousCid"].as_u64().filter(|id|*id>0).ok_or("Missing previous CID")?;
   if studio.aid.is_some_and(|id|id!=aid) || studio.videos.len()!=1 || studio.videos[0].cid!=Some(previous_cid)
      || studio.videos[0].filename.trim_end_matches(".mp4")!=previous || studio.is_only_self.map(u64::from)!=v["visibility"].as_u64(){
    return Ok(json!({"identityMismatch":true}));
   }
   studio.aid=Some(aid);
   studio.videos[0].filename=next.to_string();
   studio.videos[0].cid=None;
   Ok(serde_json::to_value(bili.edit_web_response(&studio).await?)?)
  },
  "reconcile"=>{
   let filename=string(&v,"filename")?.trim_end_matches(".mp4");
   let candidates=if let Some(aid)=v["aid"].as_u64(){vec![aid]}else{bili.recent_archives("is_pubing,pubed,not_pubed",1,Some(10)).await?.into_iter().filter(|a|v["title"].as_str().is_some_and(|title|a.title==title)).map(|a|a.aid).collect()};
   for aid in candidates {
    let details=bili.video_data(&Vid::Aid(aid),None).await?;
    let data=details.get("data").unwrap_or(&details);
    if data["videos"].as_array().is_some_and(|parts|parts.iter().any(|p|p["filename"].as_str().is_some_and(|f|f.trim_end_matches(".mp4")==filename))){return Ok(json!({"matched":true,"details":data}));}
   }
   Ok(json!({"matched":false}))
  },
  _=>Err("Unknown transport command".into())
 }
}
#[tokio::main]
async fn main(){
 let result:Result<Value>=async{let line=io::stdin().lock().lines().next().ok_or("Missing request")??;let request:Value=serde_json::from_str(&line)?;run(request).await}.await;
 match result{Ok(value)=>output(json!({"ok":true,"result":value})),Err(error)=>output(json!({"ok":false,"error":error.to_string()}))}
}
