"""One bounded YouTube operation using the app-owned encrypted login when present."""
from __future__ import annotations
import json, re, sys
from contextlib import ExitStack
from itertools import chain
from urllib.parse import urlparse, quote
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError
from .youtube_auth import youtube_options, auth_error

def single_video_url(value):
    from backend.workers.download import video_url
    match=re.search(r'https?://[^\s<>]+',str(value))
    if not match: raise ValueError('请输入 YouTube 单个视频链接')
    url=video_url(match.group(0).rstrip('，。；！、）)'))
    if urlparse(url).hostname!='www.youtube.com':
        raise ValueError('仅支持 YouTube 单个视频链接')
    return url

def video_metadata(info):
    if info.get('_type','video')!='video' or not re.fullmatch(r'[\w-]{11}',str(info.get('id',''))):
        raise ValueError('链接没有返回单个视频')
    keys=['id','title','description','channel','uploader','channel_id','timestamp','release_timestamp','upload_date','thumbnail','thumbnails','duration','webpage_url']
    result={key:info.get(key) for key in keys}
    result['webpage_url']='https://www.youtube.com/watch?v='+info['id']
    return result

def channel_profile(info,first=None):
    first=first or {}
    identity=info.get('channel_id') or first.get('channel_id')
    if not identity or not re.fullmatch(r'UC[\w-]{22}',identity):
        raise ValueError('无法解析频道 ID，请使用 /channel/UC… 链接')
    images=info.get('thumbnails') or []
    avatars=[image for image in images if image.get('url') and ('avatar' in str(image.get('id','')).lower() or image.get('width') and image.get('width')==image.get('height'))]
    avatars.sort(key=lambda image:image.get('width') or 0,reverse=True)
    return {'channelId':identity,'name':info.get('channel') or info.get('title') or identity,
            'handle':info.get('uploader_id') or info.get('channel_handle'),
            'avatarUrl':avatars[0]['url'] if avatars else None,
            'subscriberCount':info.get('channel_follower_count'),
            'isVerified':bool(info.get('channel_is_verified')),
            'description':str(info.get('description') or '')[:1200],
            'cursor':first.get('id'),'url':'https://www.youtube.com/channel/'+identity+'/videos'}

def cache_avatar(url,path,port):
    from urllib.request import build_opener, ProxyHandler, Request
    from io import BytesIO
    from pathlib import Path
    from PIL import Image, ImageOps
    parsed=urlparse(url or '')
    if parsed.scheme!='https' or parsed.hostname not in {'yt3.googleusercontent.com','yt3.ggpht.com','lh3.googleusercontent.com','i.ytimg.com'} or parsed.username or parsed.port:
        raise ValueError('频道头像地址不可用')
    proxy=f'http://127.0.0.1:{port}' if port else ''
    opener=build_opener(ProxyHandler({'http':proxy,'https':proxy} if proxy else {}))
    with opener.open(Request(url,headers={'User-Agent':'Mozilla/5.0'}),timeout=20) as response:
        content=response.read(5*1024*1024+1)
    if len(content)>5*1024*1024: raise ValueError('频道头像文件过大')
    image=ImageOps.fit(Image.open(BytesIO(content)).convert('RGB'),(256,256))
    target=Path(path);target.parent.mkdir(parents=True,exist_ok=True)
    temporary=target.with_suffix('.tmp.jpg')
    image.save(temporary,'JPEG',quality=90)
    temporary.replace(target)

def channel_url(value):
    value = value.strip()
    if re.fullmatch(r'UC[\w-]{22}', value):
        return 'https://www.youtube.com/channel/' + value + '/videos'
    if re.fullmatch(r'@[\w.\-\u0080-\uffff]+', value):
        return 'https://www.youtube.com/' + value + '/videos'
    parsed = urlparse(value)
    if parsed.scheme not in {'http', 'https'} or parsed.hostname not in {'youtube.com','www.youtube.com','m.youtube.com'} or parsed.username or parsed.port:
        raise ValueError('请输入 YouTube 频道链接、@handle 或频道 ID')
    parts = parsed.path.strip('/').split('/')
    if parts[0].startswith('@') and len(parts) <= 2:
        return 'https://www.youtube.com/' + parts[0] + '/videos'
    if len(parts) >= 2 and parts[0] in {'channel','c','user'}:
        return 'https://www.youtube.com/' + '/'.join(parts[:2]) + '/videos'
    raise ValueError('请输入频道主页，不能使用视频或播放列表链接')

def regular(info):
    return not info.get('is_live') and not info.get('was_live') and info.get('live_status') not in {'is_live','is_upcoming','was_live','post_live'} and '/shorts/' not in (info.get('webpage_url') or '')

def run(request):
    port = request.get('proxyPort', 7897)
    if type(port) is not int or not 0 <= port <= 65535:
        raise ValueError('代理端口无效')
    options = {'quiet': True, 'no_warnings': True, 'skip_download':True, 'socket_timeout':25,'retries':1,'extractor_retries':1,'proxy':f'http://127.0.0.1:{port}' if port else '', 'js_runtimes':{'node':{'path':request['node']}}}
    def downloader_options(**extra):
        return {**options, **youtube_options(request.get('dataDir')), **extra}
    def channel_options(**extra):
        # Only public channel tabs use the API fallback when webpage metadata is
        # unavailable. Individual videos still use the normal authentication checks.
        return {**options, 'extractor_args': {'youtubetab': {'skip': ['authcheck']}}, **extra}
    if request['command'] == 'check':
        with YoutubeDL(downloader_options(noplaylist=True)) as downloader:
            info=downloader.extract_info(single_video_url(request['url']),download=False)
        return {'accessible':True,'id':info['id'],'title':info.get('title'),'formatCount':len(info.get('formats') or [])}
    if request['command']=='video':
        with YoutubeDL(downloader_options(noplaylist=True, ignore_no_formats_error=True)) as downloader:
            info=downloader.extract_info(single_video_url(request['url']),download=False)
        if info.get('is_live') or info.get('live_status') in {'is_live','is_upcoming','post_live'}:
            raise ValueError('直播中或尚未发布的视频暂不能加入任务')
        return video_metadata(info)
    if request['command'] == 'cover':
        from urllib.request import build_opener, ProxyHandler, Request, HTTPRedirectHandler
        from io import BytesIO
        from pathlib import Path
        from tempfile import NamedTemporaryFile
        from PIL import Image
        proxy = f'http://127.0.0.1:{port}' if port else ''
        def valid_image_url(url):
            parsed=urlparse(url or '')
            return parsed.scheme=='https' and parsed.hostname in {'i.ytimg.com','img.youtube.com','i9.ytimg.com'} and parsed.username is None and parsed.port is None
        class CoverRedirect(HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                if not valid_image_url(newurl):
                    raise ValueError('原封面跳转地址不可用')
                return super().redirect_request(req, fp, code, msg, headers, newurl)
        opener = build_opener(ProxyHandler({'http':proxy,'https':proxy} if proxy else {}),CoverRedirect())
        preview=request.get('preview') is True
        for candidate in request.get('thumbnails', []):
            try:
                if not valid_image_url(candidate.get('url')):
                    continue
                with opener.open(Request(candidate['url'], headers={'User-Agent':'Mozilla/5.0'}), timeout=8 if preview else 25) as response:
                    content=response.read(8*1024*1024+1)
                if len(content)>8*1024*1024: continue
                image=Image.open(BytesIO(content)).convert('RGB')
                if image.width<320 or image.height<180: continue
                image.thumbnail((640,360) if preview else (1920,1080))
                path=Path(request['path'])
                with NamedTemporaryFile(dir=path.parent,suffix='.jpg',delete=False) as stream:
                    temporary=Path(stream.name)
                try:
                    image.save(temporary,'JPEG',quality=82 if preview else 90)
                    if temporary.stat().st_size>4*1024*1024:
                        image.save(temporary,'JPEG',quality=75)
                    temporary.replace(path)
                finally:
                    temporary.unlink(missing_ok=True)
                return {'path':str(path)}
            except Exception:
                continue
        raise ValueError('YouTube 原封面暂时不可用，请稍后重试')
    url = channel_url(request['url'])
    def extract_channel(downloader):
        try:
            return downloader.extract_info(url, download=False)
        except DownloadError as error:
            handle = urlparse(url).path.split('/')[1]
            if not handle.startswith('@') or not re.search(
                    r'Failed to resolve url|HTTP Error 404|authcheck|channel.*does not exist', str(error), re.I):
                raise
            # YouTube search can still resolve an exact handle when its channel
            # webpage/resolve_url endpoint returns 404. Never select by title.
            search_url = 'https://www.youtube.com/results?search_query=' + quote(handle) + '&sp=EgIQAg%3D%3D'
            with YoutubeDL(channel_options(extract_flat=True, playlistend=5)) as search:
                result = search.extract_info(search_url, download=False)
                matches = {entry.get('channel_id') or entry.get('id') for entry in result.get('entries') or []
                           if entry and str(entry.get('uploader_id') or '').casefold() == handle.casefold()}
            matches = {identity for identity in matches if re.fullmatch(r'UC[\w-]{22}', str(identity))}
            if len(matches) != 1:
                raise ValueError('无法确认此 @handle 对应的频道，请粘贴频道 ID 链接后重试。') from error
            identity = matches.pop()
            channel = downloader.extract_info('https://www.youtube.com/channel/' + identity + '/videos', download=False)
            if channel.get('channel_id') != identity:
                raise ValueError('频道身份校验失败，请检查频道链接。')
            return channel
    if request['command'] == 'browse':
        offset, limit = request.get('offset', 0), request.get('limit', 30)
        if type(offset) is not int or not 0 <= offset <= 10000 or type(limit) is not int or not 1 <= limit <= 60:
            raise ValueError('视频分页参数无效')
        with YoutubeDL(channel_options(extract_flat='in_playlist', lazy_playlist=True,
                        playliststart=offset + 1, playlistend=offset + limit + 1)) as downloader:
            channel = extract_channel(downloader)
            entries = list(channel.get('entries') or [])
        videos = []
        for entry in entries[:limit]:
            if not entry or not re.fullmatch(r'[\w-]{11}', str(entry.get('id', ''))):
                continue
            identity = entry['id']
            unavailable = entry.get('availability') in {'private', 'premium_only', 'subscriber_only', 'needs_auth', 'unavailable'}
            videos.append({'id': identity, 'title': entry.get('title') or identity,
                           'thumbnail': entry.get('thumbnail') or next((item['url'] for item in reversed(entry.get('thumbnails') or []) if item.get('url')), None) or f'https://i.ytimg.com/vi/{identity}/hqdefault.jpg',
                           'duration': entry.get('duration'), 'upload_date': entry.get('upload_date'),
                           'webpage_url': f'https://www.youtube.com/watch?v={identity}',
                           'selectable': regular(entry) and not unavailable,
                           'unavailableReason': '视频不可公开访问' if unavailable else '' if regular(entry) else '直播或未发布视频'})
        more = len(entries) > limit and offset + limit <= 10000
        return {'channelId': channel_profile(channel, entries[0] if entries else None)['channelId'], 'videos': videos,
                'nextOffset': offset + limit if more else None}
    if request['command'] not in {'scan','resolve','profile'}:
        raise ValueError('不支持的频道操作')
    with YoutubeDL(channel_options(extract_flat='in_playlist', lazy_playlist=True, **({'playlistend':1} if request['command'] in {'resolve','profile'} else {}))) as downloader:
        channel = extract_channel(downloader)
        entries = iter(channel.get('entries') or [])
        first = next(entries, None)
        if request['command'] in {'resolve','profile'}:
            result=channel_profile(channel,first)
            result['avatarCached']=False
            if result['avatarUrl'] and request.get('avatarPath'):
                try:
                    cache_avatar(result['avatarUrl'],request['avatarPath'],port)
                    result['avatarCached']=True
                except Exception:
                    result['avatarError']='头像暂时无法下载，可稍后刷新'
            return result
        found=[]
        cursor=request.get('cursor')
        newest=None
        channel_id=channel_profile(channel,first)['channelId']
        metadata = None
        with ExitStack() as opened:
            for entry in chain([first], entries):
                if not entry or not re.fullmatch(r'[\w-]{11}', str(entry.get('id',''))): continue
                identity=entry.get('id')
                if identity==cursor:
                    if newest is None: newest=cursor
                    break
                if not regular(entry): continue
                if metadata is None:
                    metadata=opened.enter_context(YoutubeDL(downloader_options(noplaylist=True, ignore_no_formats_error=True)))
                info=metadata.extract_info('https://www.youtube.com/watch?v='+identity,download=False)
                if info.get('id')!=identity or info.get('channel_id') and info['channel_id']!=channel_id:
                    raise ValueError('视频来源与监控频道不一致')
                stamp=info.get('release_timestamp') or info.get('timestamp')
                if stamp and stamp < request['addedAt']/1000: break
                date=info.get('upload_date') or ''
                if not stamp and date and date < request['addedDate']: break
                if not regular(info): continue
                if newest is None: newest=identity
                found.append(video_metadata(info))
        return {'videos':list(reversed(found)),'cursor':newest or cursor,'channelId':channel_id}

if __name__ == '__main__':
    try:
        result=run(json.load(sys.stdin))
        print(json.dumps({'ok':True,'result':result},ensure_ascii=False))
    except Exception as error:
        error=auth_error(error)
        print(json.dumps({'ok':False,'error':str(error),'code':getattr(error,'code','YOUTUBE_ERROR')},ensure_ascii=False))
