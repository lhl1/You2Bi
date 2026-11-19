; Built from the already validated desktop bundle; runtime data lives outside {app}.
#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef RepoRoot
  #error RepoRoot is required
#endif
[Setup]
AppId={{FB4B0547-B385-4917-A617-E50636C5811B}
AppName=You2Bi
AppVersion={#AppVersion}
AppPublisher=You2Bi
AppPublisherURL=https://github.com/liuzhao1225/YouDub-webui
DefaultDirName={localappdata}\Programs\You2Bi
DefaultGroupName=You2Bi
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19045
OutputDir={#OutputPath}
OutputBaseFilename=You2Bi-{#AppVersion}-windows-x64-Setup
SetupIconFile={#RepoRoot}\.cache\windows\You2Bi.ico
UninstallDisplayIcon={app}\You2Bi.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; The user exits You2Bi before upgrading. Restart Manager can close any process
; holding an installation file, including the process supervising the installer.
CloseApplications=no
RestartApplications=no

[Languages]
Name: "chinesesimplified"; MessagesFile: "{#RepoRoot}\apps\desktop\windows\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; Replace application-owned code on upgrade. Runtime, models and credentials
; live in You2Bi's separate data directory and are never installer payloads.
Type: filesandordirs; Name: "{app}\resources\app"
Type: filesandordirs; Name: "{app}\resources\youdub"

[Icons]
Name: "{group}\You2Bi"; Filename: "{app}\You2Bi.exe"; AppUserModelID: "com.youdub2bi.desktop"
Name: "{autodesktop}\You2Bi"; Filename: "{app}\You2Bi.exe"; Tasks: desktopicon; AppUserModelID: "com.youdub2bi.desktop"

[Run]
Filename: "{app}\You2Bi.exe"; Description: "{cm:LaunchProgram,You2Bi}"; Flags: nowait postinstall skipifsilent
Filename: "{app}\You2Bi.exe"; Parameters: "--updated --user-data-dir=""{param:UPDATEUSERDATA}"""; Flags: nowait runasoriginaluser; Check: IsYou2BiUpdate

[Code]
function OpenProcess(Access: LongWord; InheritHandle: Boolean; ProcessId: LongWord): THandle;
  external 'OpenProcess@kernel32.dll stdcall';
function WaitForSingleObject(Handle: THandle; Milliseconds: LongWord): LongWord;
  external 'WaitForSingleObject@kernel32.dll stdcall';
function CloseHandle(Handle: THandle): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';

function IsYou2BiUpdate: Boolean;
begin
  Result := ExpandConstant('{param:YOUDUBUPDATE|0}') <> '0';
end;

function InitializeSetup: Boolean;
var
  ProcessId: Integer;
  Handle: THandle;
  WaitResult: LongWord;
begin
  Result := True;
  if not IsYou2BiUpdate then Exit;
  if ExpandConstant('{param:UPDATEUSERDATA|}') = '' then begin
    MsgBox('You2Bi update: user data directory is missing.', mbError, MB_OK);
    Result := False;
    Exit;
  end;
  ProcessId := StrToIntDef(ExpandConstant('{param:UPDATEPID|0}'), 0);
  if ProcessId <= 0 then begin
    MsgBox('You2Bi update: invalid application process ID.', mbError, MB_OK);
    Result := False;
    Exit;
  end;
  Handle := OpenProcess($00100000, False, ProcessId);
  if Handle = 0 then begin
    { ERROR_INVALID_PARAMETER means the parent already exited. Other errors must stop installation. }
    if DLLGetLastError <> 87 then begin
      MsgBox('You2Bi update: cannot wait for the application: ' + SysErrorMessage(DLLGetLastError), mbError, MB_OK);
      Result := False;
    end;
    Exit;
  end;
  Log('You2Bi update: waiting for application process ' + IntToStr(ProcessId));
  WaitResult := WaitForSingleObject(Handle, 30000);
  CloseHandle(Handle);
  if WaitResult <> 0 then begin
    MsgBox('You2Bi update: the application did not exit. Close You2Bi and try again. Wait result: ' + IntToStr(WaitResult), mbError, MB_OK);
    Result := False;
  end;
end;
