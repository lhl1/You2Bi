"""Download one public video into the invocation's owned workspace."""
from __future__ import annotations

import re
import json
import os
import shutil
import sys
import time
from pathlib import Path
from hashlib import sha256
from urllib.parse import parse_qs, urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from .protocol import WorkerError


def video_url(value: str) -> str:
    if not isinstance(value, str):
        raise WorkerError("INVALID_VIDEO_URL", "请输入有效的视频链接。")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password or parsed.port:
        raise WorkerError("INVALID_VIDEO_URL", "视频链接必须是公开的 HTTP(S) 视频地址。")
    host, path, query = parsed.hostname, parsed.path, parse_qs(parsed.query)
    if host == "youtu.be":
        identity = path.strip("/")
    elif host in {"youtube.com", "www.youtube.com", "m.youtube.com"}:
        identity = query.get("v", [""])[0] if path == "/watch" else path.removeprefix("/shorts/").strip("/") if path.startswith("/shorts/") else ""
    else:
        identity = ""
    if re.fullmatch(r"[\w-]{11}", identity, re.ASCII):
        return f"https://www.youtube.com/watch?v={identity}"
    if host in {"bilibili.com", "www.bilibili.com", "m.bilibili.com"}:
        match = re.fullmatch(r"/video/(BV[\da-zA-Z]{10}|av\d+)/?", path)
        part = query.get("p", [""])[0]
        if match and (not part or re.fullmatch(r"[1-9]\d*", part)):
            return f"https://www.bilibili.com/video/{match[1]}/" + (f"?p={part}" if part else "")
    if host == "b23.tv" and re.fullmatch(r"/[\da-zA-Z]+/?", path):
        return f"https://b23.tv{path}"
    raise WorkerError("INVALID_VIDEO_URL", "请输入 YouTube 或 B 站的单个视频链接。")


class VideoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        # Validate before following a short link; never fetch arbitrary targets.
        return super().redirect_request(request, response, code, message, headers, video_url(newurl))


class DownloadLog:
    def debug(self, message):
        print(message, file=sys.stderr)
    info = debug
    warning = debug
    error = debug


def _within_resolution(fmt: dict, limit: int) -> bool:
    if fmt.get('vcodec') == 'none':
        return True
    dimensions = [value for value in (fmt.get('width'), fmt.get('height')) if isinstance(value, int) and value > 0]
    return bool(dimensions) and min(dimensions) <= limit


def download_video(url: str, work: Path, wire, *, proxy_port: int | None,
                   max_height: int = 1080, checkpoint_root: Path | None = None) -> tuple[Path, dict]:
    from yt_dlp import YoutubeDL
    from yt_dlp.utils.networking import std_headers
    from backend.app.config import ffmpeg_binary
    from backend.app.v1.media import inspect_video

    if proxy_port is None or proxy_port == "":
        proxy_port = 0
    if type(proxy_port) is not int or not 0 <= proxy_port <= 65535:
        raise WorkerError("INVALID_CONFIG", "本机 HTTP 代理端口须为 1–65535，0 或留空表示直连。")
    if type(max_height) is not int or max_height not in {360, 480, 720, 1080, 1440, 2160, 4320}:
        raise WorkerError('INVALID_CONFIG', '下载分辨率上限无效。')
    proxy = f"http://127.0.0.1:{proxy_port}" if proxy_port else ""
    url = video_url(url)
    wire.check_cancel()
    wire.progress(None, "解析视频链接")
    if urlparse(url).hostname == "b23.tv":
        proxies = {"http": proxy, "https": proxy} if proxy else {}
        with build_opener(ProxyHandler(proxies), VideoRedirect()).open(Request(url, headers=std_headers), timeout=20) as response:
            url = video_url(response.url)
        if urlparse(url).hostname == "b23.tv":
            raise WorkerError("INVALID_VIDEO_URL", "B 站短链接没有指向视频。")
    target = work
    if checkpoint_root is not None:
        target = checkpoint_root / sha256(f'{url}\n{max_height}'.encode()).hexdigest()
        target.mkdir(parents=True, exist_ok=True)
        receipt = target / 'complete.json'
        if receipt.is_file() and (target / 'source.mp4').is_file():
            metadata = json.loads(receipt.read_text('utf-8'))
            inspect_video(target / 'source.mp4', wire.check_cancel)
            result = _restore_download(target / 'source.mp4', work)
            wire.progress(1, '已复用下载完成的原视频')
            return result, metadata
    last_update = 0.0

    def admission(info, *, incomplete=False):
        wire.check_cancel()
        if info.get("is_live") or info.get("live_status") == "is_upcoming":
            raise WorkerError("UNSUPPORTED_MEDIA", "暂不支持直播或尚未发布的视频。")

    def progress(event):
        nonlocal last_update
        wire.check_cancel()
        count = event.get("downloaded_bytes", 0)
        total = event.get("total_bytes") or event.get("total_bytes_estimate")
        stamp = time.monotonic()
        if stamp - last_update >= 0.4 or event.get("status") == "finished":
            last_update = stamp
            value = min(count / total, 1) if total else None
            wire.progress(value, "下载视频" if event.get("status") != "finished" else "合并并检查视频")

    ffmpeg = shutil.which(ffmpeg_binary())
    if not ffmpeg:
        raise WorkerError("MEDIA_TOOLS_UNAVAILABLE", "找不到 FFmpeg，无法合并下载的视频。")
    node = os.getenv("YOUDUB_NODE_PATH", "").strip()
    if node:
        if not Path(node).is_absolute() or not Path(node).is_file() or not os.access(node, os.X_OK):
            raise WorkerError("RUNTIME_UNAVAILABLE", "YouDub 私有 Node.js 路径无效或不可执行。")
    elif os.getenv("YOUDUB_HARNESS_RUNTIME") == "1":
        raise WorkerError("RUNTIME_UNAVAILABLE", "YouDub 私有 Node.js 路径未配置。")
    else:
        node = shutil.which("node") or "node"
    def select_format(context):
        formats = [fmt for fmt in context['formats'] if _within_resolution(fmt, max_height)]
        return downloader.build_format_selector('bv[ext=mp4]+ba[ext=m4a]/b[ext=mp4]')({**context, 'formats': formats})

    options = {
        # Original youdub/downloader.py also passes an explicit yt-dlp proxy URL.
        # The node owns this value; an empty string explicitly selects direct access.
        "proxy": proxy,
        "outtmpl": str(target / "source.%(ext)s"), "noplaylist": True,
        "allowed_extractors": ["youtube$", "bilibili$"],
        "format": select_format,
        "merge_output_format": "mp4", "ffmpeg_location": ffmpeg,
        "js_runtimes": {"node": {"path": node}},
        "retries": 2, "fragment_retries": 2, "extractor_retries": 1,
        "file_access_retries": 0, "socket_timeout": 20,
        "skip_unavailable_fragments": False, "ignoreerrors": False,
        "continuedl": checkpoint_root is not None, "overwrites": False,
        "match_filter": admission, "progress_hooks": [progress], "logger": DownloadLog(),
        "quiet": True, "noprogress": True,
    }
    from .youtube_auth import youtube_options, auth_error
    if urlparse(url).hostname == 'www.youtube.com':
        options.update(youtube_options())
    try:
        with YoutubeDL(options) as downloader:
            info = downloader.extract_info(url, download=True)
            wire.check_cancel()
            if not info or info.get("_type", "video") != "video":
                raise WorkerError("INVALID_MEDIA", "链接没有返回单个视频。")
            path = Path(downloader.prepare_filename(info)).resolve()
    except Exception as error:
        converted = auth_error(error) if urlparse(url).hostname == 'www.youtube.com' else error
        if converted is not error:
            raise converted from None
        if re.search(r'timed? out|timeout|connection (?:reset|refused|aborted)|network is unreachable|temporary failure|HTTP Error (?:408|429|5\d\d)', str(error), re.I):
            raise WorkerError('DOWNLOAD_TRANSIENT', str(error)) from None
        raise
    if not path.is_relative_to(target.resolve()) or not path.is_file() or not path.stat().st_size:
        raise WorkerError("DOWNLOAD_MISSING", "下载没有生成完整视频文件。")
    media = inspect_video(path, wire.check_cancel)
    metadata = {"sourceUrl": url, "title": info.get("title"), "durationMs": media["duration_ms"]}
    if checkpoint_root is not None:
        temporary = receipt.with_suffix('.tmp')
        temporary.write_text(json.dumps(metadata, ensure_ascii=False), 'utf-8')
        temporary.replace(receipt)
        path = _restore_download(path, work)
    wire.progress(1, "视频下载完成")
    return path, metadata


def _restore_download(path: Path, work: Path) -> Path:
    result = work / path.name
    try:
        os.link(path, result)
    except OSError:
        shutil.copyfile(path, result)
    return result
