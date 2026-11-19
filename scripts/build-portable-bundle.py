"""Build a clean Windows bundle using only runtime/model directories."""
import json
import os
from pathlib import Path
import shutil
import zipfile

root=Path(__file__).resolve().parents[1]
source=Path(os.environ['APPDATA'])/'YouDub2bi/harness/youdub'
bundle=root.parent/'You2Bi-0.1.28-Windows-x64'
bundle.mkdir(exist_ok=True)
shutil.copytree(root/'dist/release-0.1.28/win-unpacked',bundle/'app',dirs_exist_ok=True)
def ignore(folder,names):
    return [name for name in names if name in ('__pycache__','.git') or name.endswith(('.pyc','.log'))]
for name in ('python','venv','nano-voxcpm','ffmpeg'):
    shutil.copytree(source/'runtime'/name,bundle/'data/youdub/runtime'/name,dirs_exist_ok=True,ignore=ignore)
for name in ('models','nltk_data'):
    if (source/name).exists():
        shutil.copytree(source/name,bundle/'data/youdub'/name,dirs_exist_ok=True,ignore=ignore)
for name in ('README.md','LICENSE'):
    shutil.copyfile(root/name,bundle/name)
shutil.copyfile(root/'scripts/portable-launch.ps1',bundle/'启动.ps1')
(bundle/'启动 You2Bi.cmd').write_text('@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0启动.ps1"\r\nif errorlevel 1 pause\r\n',encoding='gbk')
print('Copied runtime and models',flush=True)
# Rewrite relocated runtime files now as well as on each user launch.
base=bundle/'data/youdub/runtime/python/python'
for name in ('venv','nano-voxcpm'):
    env=bundle/'data/youdub/runtime'/name
    (env/'pyvenv.cfg').write_text(f'home = {base}\ninclude-system-site-packages = false\nversion = 3.12.15\nexecutable = {base}/python.exe\n','utf-8')
    if name=='nano-voxcpm':
        (env/'Lib/site-packages/host-runtime.pth').write_text(str(bundle/'data/youdub/runtime/venv/Lib/site-packages')+'\n','utf-8')
import subprocess
python=bundle/'data/youdub/runtime/venv/Scripts/python.exe'
subprocess.run([str(python),'-B','-c','import torch,voxcpm,whisper;print(torch.__version__)'],check=True)
nano=bundle/'data/youdub/runtime/nano-voxcpm/Scripts/python.exe'
subprocess.run([str(nano),'-B','-c','import torch,triton,flash_attn;from nanovllm_voxcpm.models.voxcpm2.server import AsyncVoxCPM2ServerPool;print("Nano ready")'],check=True)
files=list(bundle.rglob('*'))
total=sum(p.stat().st_size for p in files if p.is_file())
print(json.dumps({'files':len(files),'bytes':total}),flush=True)
archive=bundle.with_suffix('.zip')
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_STORED,allowZip64=True) as z:
    for p in files:
        if p.is_file():
            z.write(p,p.relative_to(bundle.parent).as_posix())
print(str(archive),flush=True)

