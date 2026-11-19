export const automationStates = {
  queued: '排队中', processing: '成片处理中', waiting_media: '等待成片', ready_to_publish: '成片已导出',
  metadata: '准备投稿文案', cover: '准备原视频封面', uploading: '上传中', submitting: '提交中',
  reconciling: '核对投稿结果', awaiting_review: '审核中', published: '已发布', private_ready: '仅自己可见',
  needs_attention: '待处理', needs_login: 'B 站需登录', needs_youtube_login: 'YouTube 需登录',
  retry_wait: '等待重试', paused: '已暂停', cancelled: '已取消', rejected: '审核未通过',
};

export const publicationGroups = {
  active: ['queued','processing','waiting_media','ready_to_publish','metadata','cover','uploading','submitting','retry_wait'],
  attention: ['needs_attention','needs_login','needs_youtube_login','rejected'],
  review: ['reconciling','awaiting_review'],
  published: ['published'],
  stopped: ['paused','cancelled','private_ready'],
};

export const hasSubmission = job => !!(job.submissionStarted || job.aid || job.bvid);
export const hasUpload = job => typeof job.uploaded?.filename === 'string' && !!job.uploaded.filename.trim();
const positiveNumber = value => Number.isFinite(value) && value>0;
export function publicationDurationSeconds(job,media){
  const measured=media?.sourceDurationMs ?? media?.steps?.find(step=>positiveNumber(step.outputs?.mediaInfo?.duration_ms))?.outputs.mediaInfo.duration_ms;
  return [positiveNumber(measured)?measured/1000:null,job.durationSeconds,job.source?.duration].find(positiveNumber) ?? null;
}
export const archiveId = value => {
  const text = String(value ?? '');
  const id = /^\d{1,16}$/.test(text) ? Number(text) : 0;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
export const archiveBvid = value => /^BV[0-9A-Za-z]{10}$/.test(String(value ?? '')) ? String(value) : null;
export function archiveUrl(job) {
  const bvid = archiveBvid(job.replacement?.bvid ?? job.bvid), aid = archiveId(job.replacement?.aid ?? job.aid);
  return bvid ? `https://www.bilibili.com/video/${bvid}` : aid ? `https://www.bilibili.com/video/av${aid}` : null;
}
export const canRemake = job => ['published','private_ready'].includes(job.state) &&
  !!archiveId(job.aid) && !!hasUpload(job) && [0,1].includes(job.metadata?.is_only_self) && !!job.graph?.nodes?.length;

const phases = [
  ['download','下载原视频',['bi-download','download']],
  ['translation','识别与翻译',['prepare','separate','recognize','translate']],
  ['export','配音与导出',['reference','synthesize','mix','align','export']],
  ['metadata','文案与封面'],['upload','上传视频'],['submit','提交稿件'],['review','B 站审核'],
];

function mediaTimeline(media,exported) {
  return phases.slice(0,3).map(([id,label,keys]) => {
    const steps = (media?.steps ?? []).filter(step => keys.includes(step.id) || keys.includes(step.kind));
    const current = steps.find(step => ['running','waiting','failed','awaiting_review'].includes(step.status));
    const last = steps.filter(step => step.status === 'completed').at(-1);
    return { id,label,complete: exported || !!steps.length && steps.every(step => step.status === 'completed') && id!=='export',
      current: current || null, last: last || null };
  });
}

const percent = value => Number.isFinite(value) ? Math.round(Math.max(0,Math.min(1,value))*100) : null;
const millis = value => typeof value==='string' ? Date.parse(value) || 0 : Number(value) || 0;
export function productionTiming(job, media) {
  const keys = new Set(phases.slice(0, 3).flatMap(phase => phase[2]));
  const stages = (media?.steps ?? []).filter(step => keys.has(step.id) || keys.has(step.kind)).map(step => {
    const start = millis(step.startedAt), end = millis(step.finishedAt);
    return { id: step.id, label: step.label, durationMs: step.status === 'completed' && start > 0 && end >= start ? end - start : null };
  });
  if (!stages.length) return job.productionTiming ?? { stages: [], totalMs: null };
  const complete = media?.status === 'succeeded' && stages.every(stage => stage.durationMs !== null);
  return { stages, totalMs: complete ? stages.reduce((total, stage) => total + stage.durationMs, 0) : null };
}

export function publicError(text) {
  return String(text ?? '').replace(/https?:\/\/[^\s"'<>]+/gi, url => url.includes('?') ? url.split('?')[0]+'?[已隐藏]' : url)
    .replace(/(SESSDATA|bili_jct|access[_ -]?(?:key|token)|refresh[_ -]?token|api[_ -]?key|authorization|cookiefile)["'\s]*[:=]\s*(?:Bearer\s+)?[^\s,}]+/gi,'$1=[已隐藏]')
    .slice(0,600);
}
const defaultMessage = {
  queued:'在队列里等待开始', ready_to_publish:'成片已导出，正在等待投稿', metadata:'正在准备标题、简介、分区和标签',
  cover:'正在获取并上传 YouTube 原封面', uploading:'正在向 B 站传输成片', submitting:'正在等待 B 站接收稿件',
  reconciling:'正在核对原稿件，避免重复提交', awaiting_review:'已提交，等待 B 站审核',
  published:'B 站审核通过，视频已公开可见', private_ready:'B 站稿件仅自己可见',
  paused:'已暂停，可继续原任务', cancelled:'已取消', retry_wait:'将在冷却结束后重试',
};
const failureHint = {
  needs_youtube_login:'同步或导入有效的 YouTube 登录凭据，再继续原任务。',
  needs_login:'使用原绑定的 B 站账号扫码，已完成的步骤会保留。',
  rejected:'查看 B 站创作中心的审核原因，原稿件不会自动重复提交。',
};
const phaseErrorHint = {
  media:'查看成片任务中的失败步骤，重试会保留已完成的文件。',
  metadata:'检查投稿文案或翻译服务，保存有效文案后可继续。',
  cover:'检查 YouTube 原封面是否可访问，重试会使用现有成片。',
  upload:'可以重试上传，已导出的成片会保留。',
  submit:'检查投稿字段，已完成的上传会保留。',
  review:'可核对原稿件；结果未确定前不会再次投稿。',
};

export function publicationView(job, media, { busy = false, paused = false, blockedUntil = 0 } = {}) {
  const mediaHasVideo=media?.videoExported ?? media?.outputs?.some(output=>output.mimeType==='video/mp4' ||
    media.artifacts?.[output.artifact?.id]?.mimeType==='video/mp4');
  const exported = media?.status === 'succeeded' && !!mediaHasVideo || !!job.mediaReadyAt || hasUpload(job) || hasSubmission(job);
  const draftSaved = !!job.metadata;
  const submitted = !!(job.aid || job.bvid || job.replacement && job.submissionStarted);
  const uploadPct = hasUpload(job) ? 100 : job.totalBytes > 0 ? percent(job.bytesUploaded / job.totalBytes) : null;
  const completed = [
    ...mediaTimeline(media,exported),
    { id:'metadata', label:phases[3][1], complete:draftSaved && !!job.coverUrl || hasSubmission(job) },
    { id:'upload', label:phases[4][1], complete:hasUpload(job) || hasSubmission(job) },
    { id:'submit', label:phases[5][1], complete:submitted },
    { id:'review', label:phases[6][1], complete:job.state==='published' || job.state==='private_ready' },
  ];
  const currentPhase = completed.find(stage => !stage.complete) ?? completed.at(-1);
  const state = job.state;
  const group = Object.keys(publicationGroups).find(key => publicationGroups[key].includes(state)) ?? 'attention';
  const error = publicError(job.error);
  const activeStep = currentPhase.current;
  const stepMessage=activeStep ? publicError(activeStep.message ||
    (typeof activeStep.label==='string'? activeStep.label : activeStep.label?.translations?.zh || activeStep.label?.default || '')) : null;
  const progress = currentPhase.id === 'upload' ? uploadPct : activeStep ? percent(activeStep.progress) : null;
  const isStopped = state === 'paused' || state === 'cancelled';
  const finished = state === 'published' || state === 'private_ready';
  const isBlocked = !!error && ['needs_attention','needs_login','needs_youtube_login','retry_wait','rejected'].includes(state);
  const canEdit = !busy && !job.replacement && !hasSubmission(job) && exported && !isStopped && ['needs_attention','ready_to_publish','retry_wait'].includes(state);
  const action = state === 'needs_login' || state === 'needs_youtube_login' ? 'login'
    : hasSubmission(job) ? finished || state==='rejected' ? null : 'verify'
    : canEdit && ['metadata','submit'].includes(job.failurePhase) ? 'edit'
    : state==='paused' ? 'resume'
    : ['needs_attention','retry_wait','cancelled'].includes(state) && !busy ? 'retry' : null;
  const nextAt = (Number(job.nextRun) || 0);
  const nextRunAt = nextAt > 0 ? (['retry_wait','reconciling','awaiting_review'].includes(state) ? Math.max(nextAt,blockedUntil || 0) : null) : null;
  const status = state === 'needs_attention' && job.failurePhase === 'metadata' ? '文案待处理'
    : state === 'needs_attention' && hasSubmission(job) ? '投稿待核对'
    : state === 'needs_attention' && exported && (job.failurePhase === 'media' || /^Pinned provider /.test(job.error || '')) ? '成片已导出 · 待续跑'
    : state === 'awaiting_review' && job.remoteState===-60 ? 'B 站转码中'
    : state === 'processing' && media?.status==='queued' ? '等待空闲资源'
    : state === 'queued' && exported ? '成片已导出'
    : automationStates[state] ?? '待处理';
  const timeline = completed.map(stage => {
    const active = stage.id === currentPhase.id && !finished;
    return { id:stage.id,label:stage.label,status:stage.complete?'done':active?(isStopped?'stopped':isBlocked?'blocked':state==='queued'&&!exported?'pending':'current'):'pending',
      message: active ? stepMessage : null,
      progress: active && progress!==null ? progress : null };
  });
  const message = isBlocked || isStopped || finished ? defaultMessage[state] ?? status
    : state==='processing' && media?.status==='queued' ? '当前步骤在等待可用资源，其他独立步骤可继续。'
    : stepMessage || defaultMessage[state] || status;
  return {
    id:job.id, taskId:job.taskId, channelId:job.channelId ?? null, accountId:job.accountId, videoId:job.videoId,
    title:job.source?.title ?? '未命名视频', channel:job.source?.channel || job.source?.uploader || '', thumbnail:job.source?.thumbnail ?? null,
    durationSeconds:publicationDurationSeconds(job,media),
    productionTiming:productionTiming(job,media),
    sourceUrl:/^[\w-]{11}$/.test(job.videoId) ? `https://www.youtube.com/watch?v=${job.videoId}` : null,
    state,status,group,phase:currentPhase.id,phaseLabel:currentPhase.label,message,progress,action,busy,paused,
    canEdit,canPause:!busy&&!hasSubmission(job)&&publicationGroups.active.includes(state),
    canRemake:!busy&&canRemake(job),replacing:!!job.replacement,
    canCancel:!busy&&!hasSubmission(job)&&!finished&&state!=='cancelled',
    mediaReady:exported,mediaStatus:media?.status ?? (exported?'succeeded':null),mediaAvailable:!!media,
    dubbedSegments:job.dubbedSegments ?? null,preservedRanges:job.preservedRanges ?? null,
    cleanedAt:job.cleanedAt ?? null,cleanupPending:!!job.cleanupPending,cleanupError:job.cleanupError?publicError(job.cleanupError):null,
    canCleanup:state==='published'&&!!job.publishedAt&&!!archiveBvid(job.bvid)&&job.metadata?.is_only_self===0&&!job.cleanedAt&&!job.cleanupPending,
    updatedAt:Math.max(millis(job.updatedAt ?? job.createdAt),millis(media?.updatedAt)),createdAt:job.createdAt,
    timeline,nextRunAt,lastReviewAt:job.lastReviewAt ?? null,reviewReason:job.reviewReason ? publicError(job.reviewReason) : null,
    error:error ? { message:error, hint:failureHint[state] ?? phaseErrorHint[job.failurePhase] ?? null,
      code:job.errorCode ?? null } : null,
    upload:job.totalBytes>0 ? { bytes:Math.max(0,Math.min(job.totalBytes,job.bytesUploaded || 0)),total:job.totalBytes,percent:uploadPct } : null,
    archive:submitted || job.replacement ? { aid:archiveId(job.replacement?.aid ?? job.aid),bvid:archiveBvid(job.replacement?.bvid ?? job.bvid),url:archiveUrl(job),state:job.remoteState ?? null } : null,
  };
}
