param([ValidateRange(1, 65535)][int]$Port = 5000)
$ErrorActionPreference = 'Stop'
$directory = Join-Path $env:LOCALAPPDATA 'YouDub2bi/LibreTranslate'
$runtime = Join-Path $directory 'venv'
$python = Join-Path $env:APPDATA 'YouDub2bi/harness/youdub/runtime/venv/Scripts/python.exe'
$executable = Join-Path $runtime 'Scripts/libretranslate.exe'
$origin = "http://127.0.0.1:$Port"
function Test-Translator {
    try {
        $languages = Invoke-RestMethod -Uri "$origin/languages" -TimeoutSec 2
        return ('en' -in $languages.code -and ('zh' -in $languages.code -or 'zh-Hans' -in $languages.code))
    } catch { return $false }
}
if (Test-Translator) { Write-Output "LibreTranslate: $origin"; exit 0 }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "Local port $Port is already in use." }
New-Item -ItemType Directory -Force -Path $directory | Out-Null
if (!(Test-Path -LiteralPath $executable)) {
    & $python -m venv $runtime
    if ($LASTEXITCODE) { throw 'Could not create the isolated translation runtime.' }
    & (Join-Path $runtime 'Scripts/python.exe') -m pip install --disable-pip-version-check 'libretranslate==1.9.6'
    if ($LASTEXITCODE) { throw 'LibreTranslate installation failed.' }
}
$process = Start-Process -FilePath $executable -ArgumentList @('--host', '127.0.0.1', '--port', $Port, '--load-only', 'en,zh,ja') -WindowStyle Hidden -WorkingDirectory $directory -RedirectStandardOutput (Join-Path $directory 'stdout.log') -RedirectStandardError (Join-Path $directory 'stderr.log') -PassThru
$until = (Get-Date).AddMinutes(4)
do {
    if (Test-Translator) { Write-Output "LibreTranslate: $origin"; exit 0 }
    if ($process.HasExited) { throw "LibreTranslate exited. See $directory/stderr.log." }
    Start-Sleep -Seconds 2
} while ((Get-Date) -lt $until)
throw "LibreTranslate has not finished starting. See $directory/stderr.log."
