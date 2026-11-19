$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$id = 'pjjhblfofncgibfbjnbgnpoaimpebeih'
$name = 'com.youdub2bi.youtube_sync'
$destination = Join-Path $root '.local/edge-sync'
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$exe = Join-Path $destination 'edge-sync-host.exe'
& $compiler /nologo /optimize+ /target:exe "/out:$exe" (Join-Path $root 'native/edge-sync-host.cs')
if ($LASTEXITCODE -ne 0) { throw 'Could not build the Edge native host.' }
$manifest = Join-Path $destination 'native-host.json'
@{
    name = $name
    description = 'You2Bi YouTube sync'
    path = $exe
    type = 'stdio'
    allowed_origins = @("chrome-extension://$id/")
} | ConvertTo-Json | Set-Content -LiteralPath $manifest -Encoding utf8NoBOM
$key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$name"
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $manifest
Write-Output (Join-Path $root 'apps/edge-sync')
