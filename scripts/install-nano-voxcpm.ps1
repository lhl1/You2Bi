param([string]$DataRoot = "$env:APPDATA/YouDub2bi/harness/youdub")
$ErrorActionPreference = 'Stop'
$base = Join-Path $DataRoot 'runtime/venv'
$target = Join-Path $DataRoot 'runtime/nano-voxcpm'
& "$base/Scripts/python.exe" -m venv --system-site-packages $target
if ($LASTEXITCODE) { throw '无法创建 NanoVLLM 运行环境' }
Set-Content -LiteralPath "$target/Lib/site-packages/host-runtime.pth" -Value "$base/Lib/site-packages" -Encoding utf8
$python = "$target/Scripts/python.exe"
& $python -m pip install --no-deps 'nano-vllm-voxcpm==2.0.5' 'triton-windows==3.4.0.post21'
if ($LASTEXITCODE) { throw 'NanoVLLM 依赖安装失败' }
$wheel = 'https://github.com/kingbri1/flash-attention/releases/download/v2.8.3/flash_attn-2.8.3%2Bcu128torch2.8.0cxx11abiFALSE-cp312-cp312-win_amd64.whl#sha256=709d6663d74f96bb0304b5ba2ffee84a4dafbcb56d73d35bc90b7ca8cd44261b'
& $python -m pip install --no-deps $wheel
if ($LASTEXITCODE) { throw 'FlashAttention 安装失败' }
& $python -c "import torch,triton,flash_attn; assert torch.__version__ == '2.8.0+cu126', '需要 PyTorch 2.8.0+cu126'; from nanovllm_voxcpm.models.voxcpm2.server import AsyncVoxCPM2ServerPool; print('NanoVLLM 配音环境已准备好')"
if ($LASTEXITCODE) { throw 'NanoVLLM 运行环境校验失败' }

