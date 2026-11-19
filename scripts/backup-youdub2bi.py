"""Create and verify a rollback snapshot without stopping the running application."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone, timedelta
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import zipfile


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def backup(root, destination):
    root, destination = root.resolve(), destination.resolve()
    home = Path(os.environ['APPDATA']) / 'YouDub2bi/harness'
    if destination.is_relative_to(root) or destination.is_relative_to(home.resolve()):
        raise ValueError('备份目录必须位于项目和运行数据目录之外。')
    destination.mkdir(parents=True, exist_ok=False)
    if os.name == 'nt':
        identity = os.environ['USERDOMAIN'] + '\\' + os.environ['USERNAME']
        subprocess.run(['icacls.exe', str(destination), '/inheritance:r', '/grant:r', identity + ':(OI)(CI)F'], check=True, capture_output=True)
    manifest = {'createdAt': datetime.now(timezone(timedelta(hours=8))).isoformat(),
        'root': str(root), 'files': [], 'sourceFiles': [],
        'excluded': ['node_modules', 'model weights', 'Python/media runtime', 'downloaded videos', 'all other historical task media']}
    def record(path):
        manifest['files'].append({'path': str(path.relative_to(destination)), 'bytes': path.stat().st_size, 'sha256': digest(path)})
    names = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root).decode('utf-8').split('\0')
    source_zip = destination / 'project-source.zip'
    with zipfile.ZipFile(source_zip, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=5) as archive:
        for name in sorted(set(names)):
            path = root / name
            if name and path.is_file() and not path.is_symlink():
                archive.write(path, name)
                manifest['sourceFiles'].append({'path': name, 'bytes': path.stat().st_size, 'sha256': digest(path)})
    with zipfile.ZipFile(source_zip) as archive:
        assert archive.testzip() is None
    record(source_zip)
    subprocess.run(['git', 'bundle', 'create', str(destination / 'git-history.bundle'), '--all'], cwd=root, check=True, capture_output=True)
    subprocess.run(['git', 'bundle', 'verify', str(destination / 'git-history.bundle')], cwd=root, check=True, capture_output=True)
    record(destination / 'git-history.bundle')
    (destination / 'working-changes.patch').write_bytes(subprocess.check_output(['git', 'diff', 'HEAD', '--binary'], cwd=root))
    record(destination / 'working-changes.patch')
    ignored = {'node_modules', 'runtime', 'models', 'tasks', 'nltk_data', '__pycache__', '.plugin-manager'}
    for folder, dirs, files in os.walk(home):
        dirs[:] = [name for name in dirs if name not in ignored and not (Path(folder) / name).is_symlink()]
        for name in files:
            source = Path(folder) / name
            if name.endswith(('-wal', '-shm', '-journal')) or source.stat().st_size > 64 * 1024 * 1024:
                continue
            target = destination / 'private-config' / source.relative_to(home)
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.open('rb') as stream:
                sqlite = stream.read(16) == b'SQLite format 3\x00'
            if sqlite:
                with sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True) as incoming, sqlite3.connect(target) as outgoing:
                    incoming.backup(outgoing)
                    assert outgoing.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
            else:
                shutil.copy2(source, target)
            record(target)
    version = json.loads((root / 'package.json').read_text('utf-8'))['version']
    release = root / f'dist/YouDub2bi-{version}-windows-x64.zip'
    if release.exists():
        target = destination / release.name
        shutil.copy2(release, target)
        assert digest(target) == digest(release)
        record(target)
    sample = Path(os.environ['APPDATA']) / 'YouDub/harness/youdub/tasks/bbda8bd4-5dee-49d2-85b5-fbb1d5d1a5ec/attempts/2/3f198230-34d9-410c-9c02-20baae3abc02/output'
    for name in ['audio.original.wav', 'audio.wav', 'audio.repaired.wav']:
        source = sample / name
        if source.exists():
            target = destination / 'audio-example' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            assert digest(source) == digest(target)
            record(target)
    snapshot = root / '.local/audio-repair/original-task.json'
    if snapshot.exists():
        target = destination / 'audio-example/task-record.json'
        shutil.copy2(snapshot, target)
        record(target)
    (destination / 'RESTORE.md').write_text('''# YouDub2bi 回滚备份

本目录保存优化前的项目源码 ZIP、Git 历史、工作区差异、上一版免安装包、运行配置、SQLite 一致性快照，以及本次配音示例的原始/修复 WAV。

源码恢复：在独立空目录解压 project-source.zip；Git 历史可从 git-history.bundle 克隆。源码 ZIP 已包括尚未提交的新文件。

程序回滚：从托盘退出应用，再启动本目录中旧版免安装包。恢复配置前先另存当前配置，再将 private-config 内容恢复到原 %APPDATA%/YouDub2bi/harness 路径。应用退出后再恢复数据库；不要把快照与旧的 WAL/SHM 文件混用。

账号凭据使用当前 Windows 用户加密，备份也包含私有模型供应商配置，请保存在本机；换 Windows 用户后需重新登录。备份目录访问权限限定为当前用户。

未复制模型权重、Python/媒体运行时、已下载视频和其余历史任务媒体；它们的原目录保持不变，可继续复用。audio-example 中的原始音频可单独恢复本次修复。

manifest.json 保存源文件清单及 SHA-256，可核对备份。SQLite 使用在线 backup API 并检查完整性，没有直接复制活动中的 WAL 数据库文件。
''', 'utf-8')
    record(destination / 'RESTORE.md')
    manifest['verified'] = True
    (destination / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), 'utf-8')
    print(json.dumps({'backup': str(destination), 'sourceFiles': len(manifest['sourceFiles']), 'backupFiles': len(manifest['files']), 'verified': True}, ensure_ascii=False))


def verify(destination):
    destination = destination.resolve()
    manifest = json.loads((destination / 'manifest.json').read_text('utf-8'))
    for item in manifest['files']:
        path = (destination / item['path']).resolve(strict=True)
        if not path.is_relative_to(destination):
            raise ValueError('Invalid backup file path')
        assert path.stat().st_size == item['bytes'] and digest(path) == item['sha256'], item['path']
    with zipfile.ZipFile(destination / 'project-source.zip') as archive:
        assert archive.testzip() is None
        for item in manifest['sourceFiles']:
            with archive.open(item['path']) as stream:
                assert hashlib.file_digest(stream, 'sha256').hexdigest() == item['sha256'], item['path']
    print(json.dumps({'backup': str(destination), 'verifiedFiles': len(manifest['files']),
                      'verifiedSourceFiles': len(manifest['sourceFiles']), 'passed': True}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--destination', type=Path)
    parser.add_argument('--verify', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    stamp = datetime.now(timezone(timedelta(hours=8))).strftime('%Y%m%d_%H%M%S')
    if args.verify:
        verify(args.verify)
    else:
        backup(root, args.destination or root.parent / 'backups' / (stamp + '_before_audio_quality'))
