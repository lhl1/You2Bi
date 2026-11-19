"""App-owned YouTube cookies, encrypted with the current Windows user's DPAPI.

Only YouTube cookies are imported. Plaintext stays in memory, never in a task,
workflow, log, browser-profile reader, or temporary cookies file.
"""
from __future__ import annotations

import ctypes
import io
import json
import os
import re
import sys
import time
import uuid
from pathlib import Path
from .protocol import WorkerError

MAGIC = b'YDBYT1\0'
LOGIN_NAMES = {'SAPISID', '__Secure-1PAPISID', '__Secure-3PAPISID', 'SID', '__Secure-1PSID', '__Secure-3PSID'}
SESSION_NAMES = LOGIN_NAMES | {'SSID', 'HSID', 'APISID', 'SIDCC', '__Secure-1PSIDTS', '__Secure-3PSIDTS', '__Secure-1PSIDCC', '__Secure-3PSIDCC'}
AUTH_MESSAGE = 'YouTube 要求登录验证。请在 Edge 的同一配置中登录 YouTube 并同步，或到「发布设置 → YouTube 登录凭据」导入有效的 cookies.txt。B 站账号无需重新登录。'


def auth_error(error):
    if isinstance(error, WorkerError):
        return error
    message = str(error)
    if re.search(r"sign in to confirm|sign in.*(?:bot|age)|login required|authentication.*required|cookies.*no longer valid", message, re.I):
        return WorkerError('YOUTUBE_AUTH_REQUIRED', AUTH_MESSAGE)
    if re.search(r"does not look like a Netscape format cookies file|cookies file must be Netscape", message, re.I):
        return WorkerError('YOUTUBE_AUTH_INVALID', 'YouTube 登录凭据无法读取。请在发布设置检查登录同步或重新导入。')
    return error


def normalize_cookies(text, *, now=None):
    if not isinstance(text, str) or len(text.encode('utf-8')) > 1024 * 1024:
        raise WorkerError('YOUTUBE_AUTH_INVALID', 'cookies.txt 大小不能超过 1 MB。')
    text = text.lstrip('\ufeff')
    if not text.startswith(('# Netscape HTTP Cookie File', '# HTTP Cookie File')):
        raise WorkerError('YOUTUBE_AUTH_INVALID', '请选择 Netscape 格式的 cookies.txt，不能使用浏览器数据库或 JSON 文件。')
    now = time.time() if now is None else now
    rows = []
    authenticated = False
    for line in text.splitlines():
        if line.startswith('#HttpOnly_'):
            line = line[len('#HttpOnly_'):]
        elif not line or line.startswith('#'):
            continue
        cells = line.split('\t')
        if len(cells) != 7:
            raise WorkerError('YOUTUBE_AUTH_INVALID', 'cookies.txt 格式不正确，请重新导出。')
        domain, include, path, secure, expires, name, value = cells
        if domain not in {'youtube.com', '.youtube.com', 'www.youtube.com', '.www.youtube.com'}:
            continue
        if include not in {'TRUE', 'FALSE'} or secure not in {'TRUE', 'FALSE'} or not path.startswith('/') or not name or not expires.isdecimal() or any(ord(c) < 32 or ord(c) == 127 for c in name + value + path):
            raise WorkerError('YOUTUBE_AUTH_INVALID', 'YouTube Cookie 字段不正确，请重新导出。')
        if int(expires) and int(expires) <= now:
            continue
        rows.append('\t'.join(cells))
        authenticated |= name in LOGIN_NAMES and bool(value)
    if not rows or not authenticated:
        raise WorkerError('YOUTUBE_AUTH_INVALID', '文件中没有未过期的 YouTube 登录 Cookie。请先登录 YouTube 再导出。')
    return '# Netscape HTTP Cookie File\n' + '\n'.join(rows) + '\n', len(rows)


def protect(content, *, decrypt=False):
    if os.name != 'nt':
        raise WorkerError('YOUTUBE_AUTH_UNAVAILABLE', '此版本使用 Windows 当前用户加密保存 YouTube 登录凭据。')
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]
    buffer = ctypes.create_string_buffer(content)
    incoming = Blob(len(content), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    outgoing = Blob()
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    function = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    if not function(ctypes.byref(incoming), None, None, None, None, 1, ctypes.byref(outgoing)):
        raise WorkerError('YOUTUBE_AUTH_INVALID', '无法读取 YouTube 登录凭据，请在当前 Windows 用户下重新导入。')
    try:
        return ctypes.string_at(outgoing.data, outgoing.size)
    finally:
        kernel.LocalFree(outgoing.data)


def credential_path(data_dir=None):
    data_dir = data_dir or os.getenv('YOUDUB_DESKTOP_DATA_DIR')
    return Path(data_dir) / 'youtube' / 'session.credential' if data_dir else None


def load(data_dir=None):
    path = credential_path(data_dir)
    if path is None or not path.exists():
        return None
    content = path.read_bytes()
    if not content.startswith(MAGIC) or len(content) > 2 * 1024 * 1024:
        raise WorkerError('YOUTUBE_AUTH_INVALID', 'YouTube 登录凭据文件损坏，请重新导入。')
    try:
        document = json.loads(protect(content[len(MAGIC):], decrypt=True))
        normalized, count = normalize_cookies(document['cookies'])
        return {**document, 'cookies': normalized, 'cookieCount': count}
    except WorkerError:
        raise
    except Exception:
        raise WorkerError('YOUTUBE_AUTH_INVALID', 'YouTube 登录凭据文件损坏，请重新导入。') from None


def save(text, data_dir, *, only_changed=False):
    normalized, count = normalize_cookies(text)
    if only_changed:
        try:
            previous = load(data_dir)
        except WorkerError:
            previous = None
        def session_rows(value):
            rows = (line.split('\t') for line in value.splitlines()[1:])
            return sorted(row for row in rows if row[5] in SESSION_NAMES)
        if previous and session_rows(previous['cookies']) == session_rows(normalized):
            return {'configured': True, 'cookieCount': previous['cookieCount'], 'importedAt': previous['importedAt']}
    document = {'cookies': normalized, 'importedAt': int(time.time() * 1000)}
    encrypted = MAGIC + protect(json.dumps(document, ensure_ascii=False).encode('utf-8'))
    path = credential_path(data_dir)
    if path is None:
        raise WorkerError('YOUTUBE_AUTH_INVALID', '应用数据目录未就绪。')
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('xb') as stream:
            stream.write(encrypted)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return {'configured': True, 'cookieCount': count, 'importedAt': document['importedAt']}


def youtube_options(data_dir=None):
    document = load(data_dir)
    # Each YoutubeDL instance consumes and may rewrite its own stream.
    return {'cookiefile': io.StringIO(document['cookies'])} if document else {}


def run(request):
    from importlib.metadata import version
    command, data_dir = request['command'], request['dataDir']
    if command == 'import':
        return {**save(request.get('cookies'), data_dir), 'downloaderVersion': version('yt-dlp')}
    if command == 'clear':
        credential_path(data_dir).unlink(missing_ok=True)
    if command in {'status', 'clear'}:
        try:
            document = load(data_dir)
            result = {'configured': bool(document)}
            if document:
                result.update({key: document[key] for key in ['cookieCount', 'importedAt']})
        except WorkerError as error:
            result = {'configured': False, 'error': str(error)}
        return {**result, 'downloaderVersion': version('yt-dlp')}
    raise WorkerError('YOUTUBE_AUTH_INVALID', '不支持的凭据操作。')


if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'result': run(json.load(sys.stdin))}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error), 'code': getattr(error, 'code', 'YOUTUBE_AUTH_INVALID')}, ensure_ascii=False))
