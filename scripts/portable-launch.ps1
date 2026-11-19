$ErrorActionPreference='Stop'
$bundle=$PSScriptRoot
$data=Join-Path $bundle 'data/youdub'
$base=Join-Path $data 'runtime/python/python'
foreach($name in @('venv','nano-voxcpm')){
 $envDir=Join-Path $data "runtime/$name"
 if(Test-Path "$envDir/Scripts/python.exe"){
  @("home = $base",'include-system-site-packages = false','version = 3.12.15',"executable = $base/python.exe") | Set-Content "$envDir/pyvenv.cfg" -Encoding ascii
  if($name -eq 'nano-voxcpm'){
   Set-Content "$envDir/Lib/site-packages/host-runtime.pth" "$data/runtime/venv/Lib/site-packages" -Encoding utf8
  }
 }
}
$env:YOU2BI_HOME=Join-Path $bundle 'data'
$env:PYTHONUTF8='1'
$env:NLTK_DATA=Join-Path $data 'nltk_data'
Start-Process -FilePath (Join-Path $bundle 'app/You2Bi.exe') -ArgumentList @('--user-data-dir',('"' + (Join-Path $bundle 'profile') + '"')) -WorkingDirectory $bundle

