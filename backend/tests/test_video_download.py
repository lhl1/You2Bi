from pathlib import Path
from urllib.request import Request
from types import SimpleNamespace

import pytest
import yt_dlp
from backend.workers.download import video_url, VideoRedirect, download_video
from backend.workers.protocol import WorkerError
from backend.workers.operations import Operation


class Wire:
    def check_cancel(self):
        pass
    def progress(self, *_):
        pass


@pytest.mark.parametrize('youtube', [True, False])
def test_owned_youtube_cookies_are_never_attached_to_bilibili(tmp_path, monkeypatch, youtube):
    from backend.workers import youtube_auth
    from backend.app.v1 import media
    from backend.app import config
    from backend.workers import download
    from io import StringIO
    captured = {}
    def owned_options():
        captured['authLoaded'] = True
        return {'cookiefile': StringIO('memory-only')}
    monkeypatch.setattr(youtube_auth, 'youtube_options', owned_options)
    monkeypatch.setattr(config, 'ffmpeg_binary', lambda: 'ffmpeg')
    monkeypatch.setattr(download.shutil, 'which', lambda name: name)
    monkeypatch.setattr(media, 'inspect_video', lambda *_: {'duration_ms': 1000})
    class Downloader:
        def __init__(self, options): captured.update(options)
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def extract_info(self, *_args, **_kwargs):
            (tmp_path / 'source.mp4').write_bytes(b'video')
            return {'id': 'abcdefghijk'}
        def prepare_filename(self, _): return str(tmp_path / 'source.mp4')
    monkeypatch.setattr(yt_dlp, 'YoutubeDL', Downloader)
    url = 'https://youtu.be/abcdefghijk' if youtube else 'https://www.bilibili.com/video/BV1xx411c7mD/'
    download_video(url, tmp_path, Wire(), proxy_port=7897)
    assert ('cookiefile' in captured) is youtube
    assert bool(captured.get('authLoaded')) is youtube


@pytest.mark.parametrize('url', ['http://127.0.0.1/a', 'https://youtube.com.evil.com/watch?v=jNQXAC9IVRw', 'https://b23.tv:8000/a', 'https://www.youtube.com/playlist?list=x'])
def test_rejects_non_video_targets(url):
    with pytest.raises(WorkerError):
        video_url(url)


def test_short_link_redirect_is_checked_before_fetching():
    with pytest.raises(WorkerError):
        VideoRedirect().redirect_request(Request('https://b23.tv/abc'), None, 302, 'Found', {}, 'http://127.0.0.1/private')
    assert video_url('https://www.youtube.com/shorts/jNQXAC9IVRw') == 'https://www.youtube.com/watch?v=jNQXAC9IVRw'


@pytest.mark.parametrize('port', [-1, 65536, 1.5, True, '7897'])
def test_invalid_proxy_port_fails_before_network_access(tmp_path, monkeypatch, port):
    monkeypatch.setattr(yt_dlp, 'YoutubeDL', lambda *_: pytest.fail('Invalid port reached the downloader'))
    with pytest.raises(WorkerError) as error:
        download_video('https://youtu.be/jNQXAC9IVRw', tmp_path, Wire(), proxy_port=port)
    assert error.value.code == 'INVALID_CONFIG'


@pytest.mark.parametrize('port', [None, '', 0, 1, 7897, 65535])
@pytest.mark.parametrize('short_link', [False, True])
def test_node_proxy_reaches_original_downloader_and_short_link_resolver(tmp_path, monkeypatch, port, short_link):
    from backend.workers import download
    from backend.app.v1 import media
    from backend.app import config
    expected = f'http://127.0.0.1:{port}' if port else ''
    url = 'https://b23.tv/abc' if short_link else 'https://youtu.be/jNQXAC9IVRw'
    work = tmp_path / 'invocation'
    received = {}
    # A direct node must override inherited machine proxy settings too.
    monkeypatch.setenv('HTTP_PROXY', 'http://127.0.0.1:9')
    monkeypatch.setenv('HTTPS_PROXY', 'http://127.0.0.1:9')
    node = tmp_path / 'private-node'
    node.write_text('#!/bin/sh\nexit 0\n')
    node.chmod(0o755)
    monkeypatch.setenv('YOUDUB_HARNESS_RUNTIME', '1')
    monkeypatch.setenv('YOUDUB_NODE_PATH', str(node))
    monkeypatch.setattr(config, 'ffmpeg_binary', lambda: '/private/youdub/ffmpeg')
    monkeypatch.setattr(download.shutil, 'which', lambda name: name)
    monkeypatch.setattr(media, 'inspect_video', lambda *_: {'duration_ms': 19000})
    class Response:
        url = 'https://www.bilibili.com/video/BV1xx411c7mD/'
        def __enter__(self): return self
        def __exit__(self, *_): pass
    def opener(*handlers):
        received['redirectProxy'] = handlers[0].proxies
        assert isinstance(handlers[1], VideoRedirect)
        return SimpleNamespace(open=lambda *_args, **_kwargs: Response())
    monkeypatch.setattr(download, 'build_opener', opener)
    class Downloader:
        def __init__(self, options): self.options = received['options'] = options
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def extract_info(self, url, download):
            received['url'] = url
            assert download is True
            self.options['format']({'formats': [
                {'width': 1920, 'height': 1080}, {'width': 1080, 'height': 1920},
                {'width': 2560, 'height': 1440}, {'width': 1440, 'height': 2560}, {'vcodec': 'none'},
            ]})
            Path(self.prepare_filename(None)).write_bytes(b'video')
            return {'title': 'Proxy contract video'}
        def prepare_filename(self, _): return self.options['outtmpl'].replace('%(ext)s', 'mp4')
        def build_format_selector(self, spec):
            received['formatSpec'] = spec
            return lambda context: received.update(formats=context['formats'])
    monkeypatch.setattr(yt_dlp, 'YoutubeDL', Downloader)
    operation = Operation({'workDir': str(work), 'taskDir': str(tmp_path), 'config': {'graph': True},
                           'binding': {'options': {'proxyPort': port}}, 'inputs': {'url': url}}, Wire())
    assert operation.download() == {'video': {'$artifact': 'video'}}
    assert received['options']['proxy'] == expected
    assert received['options']['js_runtimes'] == {'node': {'path': str(node)}}
    assert received['options']['retries'] == 2
    assert received['options']['continuedl'] is True
    assert received['formatSpec'] == 'bv[ext=mp4]+ba[ext=m4a]/b[ext=mp4]'
    assert received['formats'] == [{'width': 1920, 'height': 1080}, {'width': 1080, 'height': 1920}, {'vcodec': 'none'}]
    assert received['options']['ignoreerrors'] is False
    assert operation.artifacts['video']['metadata']['sourceUrl'] == received['url']
    if short_link:
        assert received['redirectProxy'] == ({'http': expected, 'https': expected} if expected else {})
        assert received['url'] == Response.url
    else:
        assert received['url'] == 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
    retry = Operation({**operation.request, 'workDir': str(tmp_path / 'retry')}, Wire())
    monkeypatch.setattr(yt_dlp, 'YoutubeDL', lambda *_: pytest.fail('Completed source was downloaded again'))
    assert retry.download() == {'video': {'$artifact': 'video'}}
    assert (retry.work / 'source.mp4').read_bytes() == b'video'


@pytest.mark.parametrize('node', ['', 'node', '/nonexistent/youdub/node'])
def test_harness_download_never_uses_global_node_when_private_runtime_is_missing(tmp_path, monkeypatch, node):
    monkeypatch.setenv('YOUDUB_HARNESS_RUNTIME', '1')
    monkeypatch.setenv('YOUDUB_NODE_PATH', node)
    monkeypatch.setattr(yt_dlp, 'YoutubeDL', lambda *_: pytest.fail('Missing private Node reached the downloader'))
    with pytest.raises(WorkerError) as error:
        download_video('https://youtu.be/jNQXAC9IVRw', tmp_path, Wire(), proxy_port=0)
    assert error.value.code == 'RUNTIME_UNAVAILABLE'


@pytest.mark.parametrize('mode', ['network', 'live', 'cancel'])
def test_download_failure_never_returns_an_artifact(tmp_path, monkeypatch, mode):
    original = RuntimeError('download network failure')
    class Downloader:
        def __init__(self, options): self.options = options
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def extract_info(self, *_args, **_kwargs):
            if mode == 'network': raise original
            if mode == 'live': self.options['match_filter']({'is_live': True})
            pytest.fail('Rejected download continued')
    class Cancelled(Wire):
        def check_cancel(self): raise WorkerError('CANCELLED', 'cancelled')
    monkeypatch.setattr(yt_dlp, 'YoutubeDL', Downloader)
    with pytest.raises((RuntimeError, WorkerError)) as error:
        download_video('https://youtu.be/jNQXAC9IVRw', tmp_path, Cancelled() if mode == 'cancel' else Wire(), proxy_port=0)
    if mode == 'network': assert error.value is original
    else: assert error.value.code == {'live': 'UNSUPPORTED_MEDIA', 'cancel': 'CANCELLED'}[mode]
    assert not list(tmp_path.iterdir())
