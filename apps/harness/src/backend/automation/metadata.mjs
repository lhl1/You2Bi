import { restoreClassicDubbing } from '../../../../../packages/builtin/src/original-audio-graph.ts';

export const PREFIX = '[中配]';
export function sourceDate(source) {
  if (source.release_timestamp || source.timestamp) return new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date((source.release_timestamp || source.timestamp)*1000));
  const date = String(source.upload_date || '');
  return /^\d{8}$/.test(date) ? `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6)}` : '未知';
}
const clean = value => String(value ?? '').replace(/\u0000/g,'').trim();
export function makeMetadata(source, translated, categories, template = {}) {
  const original = clean(source.title), author = clean(source.channel || source.uploader);
  if (!/^[\w-]{11}$/.test(source.id) || !original || !author) throw new Error('原视频标题、作者或视频 ID 缺失');
  const titleText = clean(translated.title).replace(/^(?:\[中配\]\s*)+/, '');
  if (!titleText) throw new Error('中文标题翻译为空');
  const prefix = template.hasDubbing === false ? '' : PREFIX;
  const title = prefix + [...titleText].slice(0,80-prefix.length).join('');
  const url = `https://www.youtube.com/watch?v=${source.id}`;
  const header = `原视频：${original}\n原作者：${author}\n发布日期：${sourceDate(source)}\n视频链接：${url}`;
  const fullTranslation = clean(translated.description);
  if (clean(source.description) && !fullTranslation) throw new Error('原视频介绍翻译为空');
  const room = 2000 - [...header].length - 2;
  if (room < 0) throw new Error('来源信息超过平台简介长度限制');
  const short = [...fullTranslation].length > room ? [...fullTranslation].slice(0,Math.max(0,room-1)).join('')+'…' : fullTranslation;
  const available = new Set(categories.map(item=>Number(item.id)));
  const tid = Number(template.fixedTid || translated.tid || template.fallbackTid);
  if (!available.has(tid)) throw new Error('无法选择有效投稿分区，请设置频道备用分区');
  const proposed = [...(template.fixedTags || []), ...(Array.isArray(translated.tags) ? translated.tags : []), ...(template.fallbackTags || [])];
  const tags = [...new Set(proposed.map(clean).filter(tag=>tag && [...tag].length<=20 && !/[,，\n]/.test(tag)))].slice(0,6);
  if (!tags.length) throw new Error('无法生成有效投稿标签，请设置频道备用标签');
  return {title,desc:header+(short?'\n\n'+short:''),desc_format_id:9999,fullTranslation,tid,tag:tags.join(','),tags,source:url,copyright:2,is_only_self:template.privateTest?1:0};
}
export function categoryList(value) {
  const result = [], seen = new Set();
  const visit = (node, parent='') => {
    if (!node || typeof node!=='object') return;
    if (Array.isArray(node)) { for (const entry of node) visit(entry,parent); return; }
    const id=Number(node.id ?? node.tid), name=clean(node.name ?? node.type_name);
    const children=node.children ?? node.sub ?? node.types;
    if (id>0 && name && !seen.has(id) && (!Array.isArray(children) || !children.length)) {seen.add(id);result.push({id,name:parent?`${parent} / ${name}`:name});}
    for(const [key,entry] of Object.entries(node)) if(entry && typeof entry==='object')visit(entry,name||parent);
  };
  visit(value?.data?.type ?? value?.data?.typelist ?? value?.data?.types ?? value);
  return result;
}
export function autoGraph(document, proxyPort=0) {
  const graph=structuredClone(document);
  const inputIds=new Set(graph.inputs.map(input=>input.id));
  if(graph.nodes.some(node=>node.id==='bi-download'))throw new Error('工作流节点名称冲突');
  for(const node of graph.nodes) node.autoContinue=true;
  const exports=graph.nodes.filter(node=>node.type==='youdub.export');
  if(!graph.nodes.some(node=>node.type==='youdub.synthesize' && node.config.voice?.mode==='source_clone') || !exports.length)throw new Error('请选择原声克隆配音工作流');
  for(const node of graph.nodes){if('targetLanguage' in node.config)node.config.targetLanguage='zh';if(node.type==='youdub.export')node.config.renderSubtitles=true;}
  for(const edge of graph.edges)if(edge.source.nodeId==='$inputs' && inputIds.has(edge.source.portId))edge.source={nodeId:'bi-download',portId:'video'};
  graph.nodes.unshift({id:'bi-download',type:'youdub.download',typeVersion:'1.0.0',provider:{id:'youdub.download'},config:{proxyPort},autoContinue:true});
  graph.inputs=[];
  return restoreClassicDubbing(graph);
}
