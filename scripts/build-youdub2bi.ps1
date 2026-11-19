param([switch]$SkipInstall,[switch]$SkipTests)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $taskRoot
try {
 $taskNpm=Get-Command npm.cmd -ErrorAction SilentlyContinue
 if (-not $taskNpm) { throw '需要 Node.js 24 与 npm。也可使用 node 指定本机 npm-cli.js。' }
 if(-not $SkipInstall){foreach($directory in @('.','apps/web','apps/harness')){ & $taskNpm.Source --prefix $directory ci --no-audit --no-fund; if($LASTEXITCODE){throw "依赖安装失败：$directory"} }}
 & cargo build --release --locked --manifest-path native/Cargo.toml
 if($LASTEXITCODE){throw 'B 站上传组件构建失败'}
 New-Item -ItemType Directory -Force native/bin | Out-Null
 Copy-Item -LiteralPath native/target/release/youdub2bi-uploader.exe -Destination native/bin/youdub2bi-uploader.exe
 & node apps/harness/build-framework.mjs
 if($LASTEXITCODE){throw '框架构建失败'}
 if(-not $SkipTests){ $env:PYTHONIOENCODING='utf-8'; $env:PYTHONUTF8='1'; & node --import tsx --test test-youdub2bi/*.test.mjs; if($LASTEXITCODE){throw '自动化测试失败'} }
 & node apps/harness/build.mjs
 if($LASTEXITCODE){throw '业务构建失败'}
 & node apps/harness/build-desktop.mjs
 if($LASTEXITCODE){throw '桌面构建失败'}
 & node apps/harness/package-desktop.mjs --dir
 if($LASTEXITCODE){throw '免安装包构建失败'}
} finally { Pop-Location }
