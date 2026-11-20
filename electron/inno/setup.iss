; =============================================================================
; 「班集」Windows 安装器脚本（Inno Setup 6 / 7）
; -----------------------------------------------------------------------------
; 用途：把 electron-builder 产出的“未打包目录”（{#AppDir}\win-unpacked）压成
;       单个安装包 exe，并使用完全自定义的安装界面。
;
; 编译方式（需先安装 Inno Setup 6 或 7）：
;   ISCC.exe electron\inno\setup.iss
; 或由 package.json 的 electron-build 脚本在 electron-builder --dir 之后自动调用。
;
; 自定义界面（见 [Code] 段）：
;   - 低版本系统提示页（仅当系统低于 Windows 10 1709 且未勾选过「不再提示」时出现）：
;       1) logo（居中）
;       2) 标题「班集」（居中）
;       3) 红色提示文案（居中，自动换行）
;       4) 「获取最新的 Windows」链接（居中，点开默认浏览器访问系统下载页并退出安装程序）
;       5) 「不再提示」勾选框，勾选即在 %LocalAppData%\班集\ 写当前用户标记文件
;          （SkipOsVersionWarning.flag）
;     底部按钮复用向导按钮：「退出程序」（左，高亮）与「忽略」（右）。
;   - 一个自绘的安装页，全部元素水平/垂直居中：
;       1) logo（居中）
;       2) 标题「安装 班集 预览版」（居中）
;       3) 「安装路径」+ 圆角输入框 + 「浏览...」按钮
;       4) 「我已阅读并同意《用户协议》」勾选框
;   - 点击勾选框弹出「用户协议」弹窗：点「同意」关闭并勾选；点「不同意」仅关闭、不勾选。
;   - 一个自绘的卸载页（InitializeUninstall 里用 CreateCustomForm 造独立模态窗体）：
;       1) logo（居中，从 {app}\uninstall-logo.png 读）
;       2) 标题「班集 预览版」（居中）
;       3) 「保留用户数据」勾选框（默认勾选 = 卸载历来「不动数据」的行为）+ 状态提示
;       4) 「取消」/「卸载 班集」按钮
;     取消勾选时，usPostUninstall 会删掉数据目录（含设置页搬走后的自定义 dataDir）
;     与 %APPDATA%\classnest 用户配置目录，操作不可恢复。
;     两条入口（开始菜单快捷方式 / 卸载注册表项 UninstallString）都带
;     /SILENT /CUSTOMUNINSTALL：/SILENT 抑制 Inno 自带的确认框与完成提示，
;     自定义开关表示由本脚本弹卸载页；直接双击 unins000.exe 则回退到 Inno 默认界面。
;
; 说明：
;   - 低版本系统提示页预览：给安装包加命令行参数 /OSWARN=1 可无条件展示该页
;     （应用内对应环境变量 OS_WARN_FORCE=1）。
;   - 相对路径均以本 .iss 文件所在目录（electron\inno）为基准：..\ 即 electron 目录，..\.. 即工程根目录；
;   - 图像（wizard-large.bmp / wizard-small.bmp）已刻意不含发布者署名文字；
;   - 用户协议全文沿用 electron\installer-assets\license.txt（含 UTF-8 BOM）；
;   - 简体中文安装界面译文随仓库分发（ChineseSimplified.isl，Inno 6.5.0+ 译文，
;     来源与维护者见文件头）。官方 Inno 安装包**不自带**中文，故不能再用
;     compiler:Languages\... 依赖本机语言包（CI 上会直接编译失败）。
; =============================================================================

; ---- 版本号：需与 package.json 的 version 保持一致 -------------------------
#define MyAppVersion "0.1.0"
#define MyAppExeName "ClassNest.exe"

; ---- 打包输出目录名 --------------------------------------------------------
; 两条通道各用各的目录，安装包不会互相覆盖：
;   正式版（npm run electron:build）       → release
;   Vue 3.6 预览（npm run electron:buildnew）→ release36
; 由 electron/inno/compile.mjs 用 ISCC 的 /DAppDir=xxx 覆盖；
; 直接双击/手跑 ISCC.exe 时走下面的默认值 release。
#ifndef AppDir
  #define AppDir "release"
#endif

; ---- Vue 3.6 预览通道开关 ------------------------------------------------
; 由 compile.mjs 的 --vue36 传 /DVue36 打开（CI 的 package-vue36 任务走这条）。
; 打开后：安装包文件名加 -Vue36 后缀（避免与正式版同名互相覆盖）、安装页标题与
; 提示语都标明「测试版」。AppId / 安装目录刻意不变 —— 两个通道是同一个应用的
; 两个构建，装哪个就是哪个，不需要并存两份。
#ifdef Vue36
  #define SetupSuffix "-Vue36"
#else
  #define SetupSuffix ""
#endif

[Setup]
; AppId 写死为固定 GUID，切勿更改——它决定“同一应用的升级/卸载识别”，
; 每次变化会导致生成新的独立安装项、旧版不被覆盖。
AppId={{C3F1A9B2-4D5E-4F60-8A7B-1C2D3E4F5A6B}
AppName=班集
AppVersion={#MyAppVersion}
AppVerName=班集 {#MyAppVersion}
AppPublisher=无聊的小洋葱
AppPublisherURL=https://github.com/onion383/classnest
AppSupportURL=https://github.com/onion383/classnest
AppUpdatesURL=https://github.com/onion383/classnest/releases
VersionInfoVersion={#MyAppVersion}

; 安装到系统 Program Files（需管理员权限）。{autopf} 在 64 位安装模式下解析为
; C:\Program Files，安装时会请求 UAC。
DefaultDirName={autopf}\班集
DefaultGroupName=班集
DisableProgramGroupPage=yes
; 默认权限模式：请求管理员权限（会弹 UAC）
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible

; 输出：固定文件名「ClassNest-Setup-x.y.z.exe」，便于更新逻辑按资产名匹配（*-Setup-*.exe）。
; Vue 3.6 预览通道多一段 -Vue36，两个包挂在同一个 Release 下也不会撞名。
OutputDir=..\..\{#AppDir}
OutputBaseFilename=ClassNest{#SetupSuffix}-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
SetupLogging=yes
; 沿用上次的安装目录（机器级 Program Files\班集），同一 AppId 下可直接覆盖升级。
UsePreviousAppDir=yes

; ---- 图标 -------------------------------------------------------------------
SetupIconFile=..\installer-assets\installer.ico
UninstallDisplayIcon={app}\{#MyAppExeName}

; ---- 页面裁剪：欢迎 / 目录 / 就绪页全部不要，改用自绘安装页 ------------------
; 目录页与任务页通过 [Code] 的 ShouldSkipPage 跳过（保留控件以便代码读取/写入安装路径）。
DisableWelcomePage=yes
DisableReadyPage=yes

; ---- modern 观感向导 --------------------------------------------------------
; WizardStyle=modern 使用左侧大图（164x314）与右上角小图（55x55），界面更现代清爽。
WizardStyle=modern
WizardImageFile=wizard-large.bmp
WizardSmallImageFile=wizard-small.bmp
WizardImageStretch=no

; ---- 升级必备：静默安装时自动关闭旧进程、装完自动重启 ----------------------
CloseApplications=yes
RestartApplications=yes

; 防止多个安装实例并发（用 ASCII 名，免 UAC 下不涉及 Global 命名空间权限）
SetupMutex=classnest-setup

[Languages]
; 用仓库内的译文（相对本 .iss 所在目录），不依赖 Inno 安装目录的 Languages 语言包
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"; Flags: checkedonce

[Files]
; 自绘界面用到的运行时资源（不落盘到安装目录，仅解压到临时目录供 [Code] 读取）。
; 关键：必须排在应用文件之前——使其位于固实压缩流的“开头”。
; 否则它们落在流末尾，InitializeWizard 里的 ExtractTemporaryFile 会被迫解压
; 整条 300MB+ 的固实流（lzma2/max 约 4~9 秒），导致安装程序启动极慢。
; nocompression 让这三个小文件不参与压缩、单独存储，读取无需触碰大流。
Source: "..\app-icon.png"; DestDir: "{tmp}"; Flags: dontcopy nocompression
Source: "..\installer-assets\field-bg.png"; DestDir: "{tmp}"; Flags: dontcopy nocompression
Source: "..\installer-assets\license.txt"; DestDir: "{tmp}"; Flags: dontcopy nocompression
; 整目录拷贝 electron-builder 的未打包产物（{#AppDir}\win-unpacked）
; Excludes：不把 .gitignore 装进安装目录
Source: "..\..\{#AppDir}\win-unpacked\*"; DestDir: "{app}"; Excludes: ".gitignore"; Flags: ignoreversion recursesubdirs createallsubdirs
; 卸载页的 logo：上面那条 app-icon.png 是 dontcopy（只编进安装包），而卸载端
; 不能 ExtractTemporaryFile（安装包已不在），所以额外落一份到安装目录供卸载时读。
; 排在整目录条目之后：它不参与安装启动时的 ExtractTemporaryFile，不影响冷启动耗时。
Source: "..\app-icon.png"; DestDir: "{app}"; DestName: "uninstall-logo.png"; Flags: ignoreversion nocompression

[InstallDelete]
; 覆盖安装前清掉旧版遗留文件。[Files] 只复制、不做目录镜像同步，新版里没有的
; 旧文件会一直留在 {app}：最明显的是主程序改名前的 班集.exe（约 250MB），
; 其次是整个 resources（app.asar / app.asar.unpacked / node_modules 里删掉的依赖）。
; 三条守卫见 [Code] 的 IsClassNestUpgrade：只在确为「上一次班集安装目录」时执行。
; 官方明确反对 {app}\* 通配（怕用户装错目录时误删），所以这里只删明确列出的两项。
; 以后改 electron-builder.json 的 executableName，必须在这里补一行旧 exe 名。
Type: files; Name: "{app}\班集.exe"; Check: IsClassNestUpgrade
Type: filesandordirs; Name: "{app}\resources"; Check: IsClassNestUpgrade

[Icons]
Name: "{group}\班集"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 班集"; Filename: "{uninstallexe}"; Parameters: "/SILENT /CUSTOMUNINSTALL"
Name: "{autodesktop}\班集"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[UninstallDelete]
; 低版本系统提示页的「不再提示」开关：由 [Code] 在 %ProgramData%\班集\ 下写一个
; 机器级标记文件（SkipOsVersionWarning.flag），卸载时在此清理。
Type: files; Name: "{commonappdata}\班集\SkipOsVersionWarning.flag"

[Run]
; 安装后预热（2026-10-31）：起一次后端再退出，把 Electron 运行时（exe/dll/pak）、
; 后端 163 个模块与 better-sqlite3 原生模块都读进系统文件缓存。
; 目的不是建库（实测空库只需 ~100ms），而是消掉「装完第一次双击」的冷盘 + 杀软首扫成本：
; 实测安装后首次启动后端就绪 8356ms，同一份代码第二/三次分别 3190ms / 44ms。
; runhidden —— 不弹窗口；waituntilterminated —— 必须等它退出，否则用户装完立刻双击
; 会和预热进程抢单实例锁（后到者直接退出，表现为「点了没反应」）。
; 应用侧对应 electron/main/main.js 的 --warmup 分支，20 秒超时后自行退出。
; runasoriginaluser —— 用「发起安装的那个用户」的普通令牌运行，不要继承安装器的管理员令牌：
;   预热只是把 {app} 里的文件读进缓存，普通用户对 Program Files 本来就有读/执行权限，
;   提权跑没有额外收益，却让整套 Electron + 本地后端在管理员上下文里过一遍（攻击面放大）。
Filename: "{app}\{#MyAppExeName}"; Parameters: "--warmup"; StatusMsg: "正在预热程序组件（让首次启动更快）..."; Flags: runasoriginaluser runhidden waituntilterminated

; 安装完成后可选启动（静默安装时跳过）
; runasoriginaluser —— 否则这里启动的班集继承安装器的管理员令牌并整场运行；
;   若由 IT 管理员用别人账号提权代装，数据还会落进管理员的 %APPDATA% 而不是真实使用者的。
Filename: "{app}\{#MyAppExeName}"; Description: "启动 班集"; Flags: runasoriginaluser nowait postinstall skipifsilent

[Code]
const
  GWL_STYLE = -16;
  GWL_EXSTYLE = -20;
  WS_BORDER = $00800000;
  WS_EX_CLIENTEDGE = $00000200;
  SWP_NOSIZE = $0001;
  SWP_NOMOVE = $0002;
  SWP_NOZORDER = $0004;
  SWP_FRAMECHANGED = $0020;
  { 低版本系统判定阈值：Windows 10 1709 的 build 号 }
  OS_WARN_MIN_BUILD = 16299;
  { 「不再提示」的机器级标记文件目录/文件名（%ProgramData%\班集\） }
  OS_WARN_FLAG_DIR = '{commonappdata}\班集';
  OS_WARN_FLAG_FILE = 'SkipOsVersionWarning.flag';
  { 提示文案用色：柔和红 #B91C1C（TColor 为 BGR 排列） }
  OS_WARN_TEXT_COLOR = $1C1CB9;
  { 「获取最新的 Windows」打开的下载页 }
  OS_DOWNLOAD_URL = 'https://www.microsoft.com/zh-cn/software-download/windows11';

  { ---- 卸载侧 ---- }
  { 自定义卸载开关：与 /SILENT 一起加进卸载快捷方式和卸载注册表项。
    /SILENT 抑制 Inno 自带的确认框与「卸载完成」提示（进度窗仍显示），
    带这个开关才弹自绘卸载页；直接双击 unins000.exe / 系统静默卸载则回退默认行为。 }
  UNINSTALL_SWITCH = '/CUSTOMUNINSTALL';
  { 用户取消勾选「保留用户数据」时写的标记。卸载是两阶段进程，用文件把选择
    从 InitializeUninstall 传到 usPostUninstall，比全局变量更保险。 }
  UNINSTALL_FLAG_FILE = '{tmp}\classnest-remove-data.flag';
  { 卸载注册表键名 = [Setup] AppId 的 GUID + '_is1'，必须与 AppId 保持一致。
    机器级安装（PrivilegesRequired=admin）→ HKLM。 }
  UNINSTALL_REG_KEY = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{C3F1A9B2-4D5E-4F60-8A7B-1C2D3E4F5A6B}_is1';
  { 提示文字：中性灰 / 警示红（沿用低版本提示页的柔和红） }
  UNINSTALL_HINT_GRAY = $5A5A5A;

{ 卸载端没有 WizardForm，不能用 FlipAndCenterIfNeeded 相对向导居中，
  直接按屏幕尺寸摆到中间。 }
function GetSystemMetrics(nIndex: Integer): Integer;
  external 'GetSystemMetrics@user32.dll stdcall';

function GetWindowLong(hWnd: HWND; nIndex: Integer): Longint;
  external 'GetWindowLongW@user32.dll stdcall';
function SetWindowLong(hWnd: HWND; nIndex: Integer; dwNewLong: Longint): Longint;
  external 'SetWindowLongW@user32.dll stdcall';
function SetWindowPos(hWnd: HWND; hWndInsertAfter: HWND; X, Y, cx, cy: Integer;
  uFlags: UINT): BOOL;
  external 'SetWindowPos@user32.dll stdcall';

var
  CustomPage: TWizardPage;
  LogoImage: TBitmapImage;
  TitleLabel: TNewStaticText;
  { Vue 3.6 预览通道专属的两行提示；非该通道时不创建，HintH / HintGap 为 0，布局与原来一致 }
  Vue36Hint1: TNewStaticText;
  Vue36Hint2: TNewStaticText;
  PathLabel: TNewStaticText;
  FieldBg: TBitmapImage;
  PathEdit: TNewEdit;
  BrowseButton: TNewButton;
  LicenseCheck: TNewCheckBox;
  EditFixed: Boolean;
  { 重入守卫：程序化修改 Checked 会再次触发 OnClick，用它阻断递归弹窗 }
  LicenseOpening: Boolean;

  { ---- 低版本系统提示页 ---- }
  OsWarnPage: TWizardPage;
  OsWarnLogo: TBitmapImage;
  OsWarnTitle: TNewStaticText;
  OsWarnMsg: TNewStaticText;
  OsWarnGetWin: TNewLinkLabel;
  OsWarnRemember: TNewCheckBox;
  { 是否需要展示提示页：低于 Win10 1709 且用户未勾选过「不再提示」 }
  OsWarningNeeded: Boolean;
  { 向导「取消」按钮的原始文案：提示页临时改成「退出程序」，切回安装页时还原。
    注意：DFM 里三个向导按钮的文案只是占位符 '*'，真实文案由 Inno 在切换页面时才填入，
    所以不能在 InitializeWizard 里读取——要等进入提示页时（文案已填好）再记下。 }
  OrigCancelCaption: String;
  { 是否已把「取消」临时改成「退出程序」：只有改过才需要在安装页还原 }
  CancelCaptionOverridden: Boolean;
  { 点「获取最新的 Windows」时置位：跳过退出确认框，直接关闭安装程序 }
  SkipExitConfirm: Boolean;

  { ---- 卸载页 ---- }
  { OnClick 回调要访问勾选框与提示文字，Pascal Script 没有闭包，只能放全局 }
  UninstallKeepCheck: TNewCheckBox;
  UninstallHint: TNewStaticText;
  { 用户是否取消了「保留用户数据」：在 ShowModal 之后、Form.Free 之前取出 }
  RemoveUserData: Boolean;

{ ---- 覆盖安装前的旧文件清理守卫 -------------------------------------------
  给 InstallDelete 的每条都挂这个 Check。Inno 的 Files 段只复制、不做目录镜像同步，
  新版没有的旧文件会一直留在安装目录里（旧主程序 班集.exe 约 250MB 最明显），
  安装目录会越装越大。卸载日志默认 append，最终卸载虽能删干净，但使用期间一直占着。
  这里只删明确列出的两项，再加三层守卫，避免用户把安装路径选到盘根 / 别的目录时误删。 }
function IsClassNestUpgrade(): Boolean;
var
  D: String;
begin
  Result := False;
  D := ExpandConstant('{app}');
  { 1) 不是盘根（D:\ 之类） }
  if Length(D) <= 3 then
    Exit;
  { 2) 必须有上次安装留下的卸载日志：首次安装、或用户随手选的目录都没有 }
  if not FileExists(D + '\unins000.dat') then
    Exit;
  { 3) 必须有班集主程序（当前名或历史名），排除同名巧合 }
  if not (FileExists(D + '\{#MyAppExeName}') or
          FileExists(D + '\班集.exe')) then
    Exit;
  Result := True;
end;

{ 去掉输入框的原生边框（WS_BORDER / WS_EX_CLIENTEDGE），让它融入圆角背景图 }
procedure MakeBorderlessEdit(const AEdit: TNewEdit);
var
  L: Longint;
begin
  L := GetWindowLong(AEdit.Handle, GWL_STYLE);
  SetWindowLong(AEdit.Handle, GWL_STYLE, L and (not WS_BORDER));
  L := GetWindowLong(AEdit.Handle, GWL_EXSTYLE);
  SetWindowLong(AEdit.Handle, GWL_EXSTYLE, L and (not WS_EX_CLIENTEDGE));
  SetWindowPos(AEdit.Handle, 0, 0, 0, 0, 0,
    SWP_NOSIZE or SWP_NOMOVE or SWP_NOZORDER or SWP_FRAMECHANGED);
end;

{ 系统是否低于 Windows 10 1709：非 Win10（Win7/8.1 等）一律算低；Win10 则比 build 号 }
function IsOsVersionTooLow(): Boolean;
var
  V: TWindowsVersion;
begin
  GetWindowsVersionEx(V);
  if V.Major > 10 then
    Result := False
  else if V.Major = 10 then
    Result := V.Build < OS_WARN_MIN_BUILD
  else
    Result := True;
end;

{ 用户是否已勾选过「不再提示」：检查机器级标记文件是否存在（卸载时由 [UninstallDelete] 清理）。
  改用标记文件而非注册表：在 [Code] 里调用 RegValueExists 时，根键常量（HKEY_*/HKA）
  的类型与 RootKey: Integer 形参不匹配，运行时会直接抛「Type Mismatch」。 }
function OsWarnSkipped(): Boolean;
begin
  Result := FileExists(ExpandConstant(OS_WARN_FLAG_DIR + '\' + OS_WARN_FLAG_FILE));
end;

{ 「不再提示」勾选框：勾选即写标记文件，取消勾选即删除，下次运行安装包据此跳过提示页。
  写到 ProgramData（机器级）。 }
procedure OsWarnRememberClick(Sender: TObject);
var
  Dir, FlagPath: String;
begin
  Dir := ExpandConstant(OS_WARN_FLAG_DIR);
  FlagPath := Dir + '\' + OS_WARN_FLAG_FILE;
  if OsWarnRemember.Checked then
  begin
    ForceDirectories(Dir);
    SaveStringToFile(FlagPath, '1', False);
  end
  else
    DeleteFile(FlagPath);
end;

{ 点「获取最新的 Windows」：用默认浏览器打开系统下载页，随后直接退出安装程序。
  用 ShellExecAsOriginalUser：安装包已改为免提权运行，该函数此时等价于 ShellExec，
  保留它没有副作用（万一以后又改回管理员模式也不用再动这里）。 }
procedure OsWarnGetWinClick(Sender: TObject; const Link: string; LinkType: TSysLinkType);
var
  ErrorCode: Integer;
  URL: String;
begin
  if LinkType = sltURL then
    URL := Link
  else
    URL := OS_DOWNLOAD_URL;
  if not ShellExecAsOriginalUser('open', URL, '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode) then
    MsgBox('未能打开浏览器，请手动访问：' + URL, mbError, MB_OK);
  { 置位后由 CancelButtonClick 跳过退出确认框，静默关闭 }
  SkipExitConfirm := True;
  WizardForm.Close;
end;

{ 用户协议弹窗：点「同意」返回 True（mrYes），点「不同意」返回 False（mrNo） }
function ShowLicenseDialog(): Boolean;
var
  Form: TSetupForm;
  Memo: TNewMemo;
  BtnAgree, BtnDisagree: TNewButton;
  Lines: TArrayOfString;
  BtnW, I: Integer;
begin
  Result := False;
  { 尺寸与安装向导窗口保持一致：按“客户区”对齐，使两个窗口的外框尺寸完全相同 }
  Form := CreateCustomForm(ScaleX(1), ScaleY(1), False, False);
  Form.ClientWidth := WizardForm.ClientWidth;
  Form.ClientHeight := WizardForm.ClientHeight;
  try
    Form.Caption := '用户协议';

    Memo := TNewMemo.Create(Form);
    Memo.Parent := Form;
    Memo.Left := ScaleX(12);
    Memo.Top := ScaleY(12);
    Memo.Width := Form.ClientWidth - ScaleX(24);
    Memo.Height := Form.ClientHeight - ScaleY(12 + 25 + 12 + 12);
    Memo.ScrollBars := ssVertical;
    Memo.ReadOnly := True;
    if LoadStringsFromFile(ExpandConstant('{tmp}\license.txt'), Lines) then
    begin
      Memo.Lines.Clear;
      for I := 0 to GetArrayLength(Lines) - 1 do
        Memo.Lines.Add(Lines[I]);
    end
    else
      Memo.Lines.Text := '未能加载用户协议文件，请检查安装包完整性。';

    BtnW := Form.CalculateButtonWidth(['同意', '不同意']);

    BtnDisagree := TNewButton.Create(Form);
    BtnDisagree.Parent := Form;
    BtnDisagree.Caption := '不同意';
    BtnDisagree.ModalResult := mrNo;
    BtnDisagree.Width := BtnW;
    BtnDisagree.Height := ScaleY(25);
    BtnDisagree.Left := Form.ClientWidth - ScaleX(12) - BtnDisagree.Width;
    BtnDisagree.Top := Form.ClientHeight - ScaleY(12) - BtnDisagree.Height;

    BtnAgree := TNewButton.Create(Form);
    BtnAgree.Parent := Form;
    BtnAgree.Caption := '同意';
    BtnAgree.ModalResult := mrYes;
    BtnAgree.Default := True;
    BtnAgree.Width := BtnW;
    BtnAgree.Height := BtnDisagree.Height;
    BtnAgree.Left := BtnDisagree.Left - ScaleX(8) - BtnAgree.Width;
    BtnAgree.Top := BtnDisagree.Top;

    Form.ActiveControl := BtnAgree;
    Form.FlipAndCenterIfNeeded(True, WizardForm, False);

    Result := Form.ShowModal() = mrYes;
  finally
    Form.Free();
  end;
end;

{ 勾选框点击：不直接切换，而是弹协议；仅「同意」才勾上（「不同意」保持未勾选） }
procedure LicenseCheckClick(Sender: TObject);
begin
  { 程序化修改 Checked 会再次触发本 OnClick；用守卫保证只处理一次 }
  if LicenseOpening then
    Exit;
  LicenseOpening := True;
  try
    LicenseCheck.Checked := False;
    if ShowLicenseDialog() then
      LicenseCheck.Checked := True;
    WizardForm.NextButton.Enabled := LicenseCheck.Checked;
  finally
    LicenseOpening := False;
  end;
end;

{ 「浏览...」：选择安装目录并写回输入框 }
procedure BrowseButtonClick(Sender: TObject);
var
  Dir: String;
begin
  Dir := PathEdit.Text;
  if BrowseForFolder('请选择安装目录', Dir, True) then
    PathEdit.Text := Dir;
end;

procedure InitializeWizard();
var
  SW, SH, LogoSize, TitleH, RowH, CheckH: Integer;
  Gap1, Gap2, Gap3, Gap4, BlockH, Top0, RowTop, HintH, HintGap: Integer;
  FieldW, BtnW, LabelW, RowLeft, CheckW, MsgH, LinkH, LinkW: Integer;
  Measure: TNewStaticText;
begin
  ExtractTemporaryFile('app-icon.png');
  ExtractTemporaryFile('field-bg.png');
  ExtractTemporaryFile('license.txt');

  { ---------- 低版本系统提示页（排在安装页之前；版本达标或已勾选「不再提示」时跳过） ---------- }
  { 调试/预览用：命令行加 /OSWARN=1 时无条件展示提示页（忽略系统版本与「不再提示」） }
  if Pos('/OSWARN', Uppercase(GetCmdTail())) > 0 then
    OsWarningNeeded := True
  else
    OsWarningNeeded := IsOsVersionTooLow() and (not OsWarnSkipped());

  OsWarnPage := CreateCustomPage(wpWelcome, '', '');
  SW := OsWarnPage.Surface.Width;
  SH := OsWarnPage.Surface.Height;

  LogoSize := ScaleX(88);
  TitleH := ScaleY(32);
  CheckH := ScaleY(18);
  Gap1 := ScaleY(16);
  Gap2 := ScaleY(26);
  Gap3 := ScaleY(24);
  MsgH := ScaleY(58);
  LinkH := ScaleY(20);
  Gap4 := ScaleY(8);

  BlockH := LogoSize + Gap1 + TitleH + Gap2 + MsgH + Gap3 + LinkH + Gap4 + CheckH;
  Top0 := (SH - BlockH) div 2;
  if Top0 < ScaleY(10) then
    Top0 := ScaleY(10);

  { 1) logo（水平居中） }
  OsWarnLogo := TBitmapImage.Create(OsWarnPage);
  OsWarnLogo.Parent := OsWarnPage.Surface;
  OsWarnLogo.AutoSize := False;
  OsWarnLogo.Stretch := True;
  OsWarnLogo.Width := LogoSize;
  OsWarnLogo.Height := LogoSize;
  OsWarnLogo.Left := (SW - LogoSize) div 2;
  OsWarnLogo.Top := Top0;
  OsWarnLogo.PngImage.LoadFromFile(ExpandConstant('{tmp}\app-icon.png'));

  { 2) 标题「班集」（水平居中） }
  OsWarnTitle := TNewStaticText.Create(OsWarnPage);
  OsWarnTitle.Parent := OsWarnPage.Surface;
  OsWarnTitle.AutoSize := False;
  OsWarnTitle.WordWrap := False;
  OsWarnTitle.Alignment := taCenter;
  OsWarnTitle.Left := 0;
  OsWarnTitle.Width := SW;
  OsWarnTitle.Height := TitleH;
  OsWarnTitle.Top := Top0 + LogoSize + Gap1;
  OsWarnTitle.Font.Size := 15;
  OsWarnTitle.Font.Style := [fsBold];
  OsWarnTitle.Caption := '班集';

  { 3) 提示正文（居中、自动换行、警示红字） }
  OsWarnMsg := TNewStaticText.Create(OsWarnPage);
  OsWarnMsg.Parent := OsWarnPage.Surface;
  OsWarnMsg.AutoSize := False;
  OsWarnMsg.WordWrap := True;
  OsWarnMsg.Alignment := taCenter;
  OsWarnMsg.Left := ScaleX(6);
  OsWarnMsg.Width := SW - ScaleX(12);
  OsWarnMsg.Height := MsgH;
  OsWarnMsg.Top := Top0 + LogoSize + Gap1 + TitleH + Gap2;
  OsWarnMsg.Font.Size := 10;
  OsWarnMsg.Font.Color := OS_WARN_TEXT_COLOR;
  OsWarnMsg.Caption :=
    '检测到您正在运行的系统版本过低，可能导致软件异常或崩溃，' +
    '建议将系统升级到 Windows 10 1709 或更高版本';

  { 4) 「获取最新的 Windows」链接（居中；点击用默认浏览器打开下载页并退出安装程序）
     注意：TNewLinkLabel 内部是 Windows SysLink 控件，Caption 必须写成 <a ...>文字</a>
     这种锚点标记才会渲染成可点链接；传纯文本时整段文字都不可点，点击毫无反应。 }
  Measure := TNewStaticText.Create(OsWarnPage);
  Measure.Parent := OsWarnPage.Surface;
  Measure.AutoSize := True;
  Measure.Caption := '获取最新的 Windows';
  LinkW := Measure.Width;
  Measure.Free;

  OsWarnGetWin := TNewLinkLabel.Create(OsWarnPage);
  OsWarnGetWin.Parent := OsWarnPage.Surface;
  OsWarnGetWin.AutoSize := False;
  { 按量出的文字宽度水平居中（SysLink 自己绘制，不依赖 Alignment） }
  OsWarnGetWin.Left := (SW - LinkW) div 2;
  OsWarnGetWin.Width := LinkW;
  OsWarnGetWin.Height := LinkH;
  OsWarnGetWin.Top := Top0 + LogoSize + Gap1 + TitleH + Gap2 + MsgH + Gap3;
  OsWarnGetWin.UseVisualStyle := True;
  OsWarnGetWin.Caption := '<a href="' + OS_DOWNLOAD_URL + '">获取最新的 Windows</a>';
  OsWarnGetWin.OnLinkClick := @OsWarnGetWinClick;

  { 5) 「不再提示」勾选框（水平居中） }
  Measure := TNewStaticText.Create(OsWarnPage);
  Measure.Parent := OsWarnPage.Surface;
  Measure.AutoSize := True;
  Measure.Caption := '不再提示';
  CheckW := Measure.Width + ScaleX(22);
  Measure.Free;

  OsWarnRemember := TNewCheckBox.Create(OsWarnPage);
  OsWarnRemember.Parent := OsWarnPage.Surface;
  OsWarnRemember.Caption := '不再提示';
  OsWarnRemember.Width := CheckW;
  OsWarnRemember.Top := Top0 + LogoSize + Gap1 + TitleH + Gap2 + MsgH + Gap3 + LinkH + Gap4;
  OsWarnRemember.Left := (SW - CheckW) div 2;
  OsWarnRemember.OnClick := @OsWarnRememberClick;

  { ---------- 自绘安装页 ---------- }
  { 自绘安装页：空标题/副标题，避免与居中大标题重复。
    注意：CreateCustomPage 是「紧跟 AfterID 之后插入」，若这里仍用 wpWelcome，
    安装页会插到提示页之前、顺序颠倒；故锚在提示页之后。 }
  CustomPage := CreateCustomPage(OsWarnPage.ID, '', '');
  SW := CustomPage.Surface.Width;
  SH := CustomPage.Surface.Height;

  LogoSize := ScaleX(88);
  TitleH := ScaleY(32);
  RowH := ScaleY(32);
  CheckH := ScaleY(18);
  Gap1 := ScaleY(16);
  Gap2 := ScaleY(26);
  Gap3 := ScaleY(24);

  { Vue 3.6 预览通道在标题下多两行提示；非该通道时两者为 0，
    下面 BlockH / RowTop 的算式退化成原样，安装页布局逐像素不变。
    HintH 按「两行文案各最多折两行」留量：9pt 中文在 417px 的 Surface 上约 34 字/行，
    两句各 40 字上下，允许折行才不会右侧被截断。 }
  HintH := 0;
  HintGap := 0;
#ifdef Vue36
  HintH := ScaleY(76);
  HintGap := ScaleY(12);
#endif

  { 竖直居中：先算内容块总高，再取居中起点 }
  BlockH := LogoSize + Gap1 + TitleH + Gap2 + HintH + HintGap + RowH + Gap3 + CheckH;
  Top0 := (SH - BlockH) div 2;
  if Top0 < ScaleY(10) then
    Top0 := ScaleY(10);

  { 1) logo（水平居中） }
  LogoImage := TBitmapImage.Create(CustomPage);
  LogoImage.Parent := CustomPage.Surface;
  LogoImage.AutoSize := False;
  LogoImage.Stretch := True;
  LogoImage.Width := LogoSize;
  LogoImage.Height := LogoSize;
  LogoImage.Left := (SW - LogoSize) div 2;
  LogoImage.Top := Top0;
  LogoImage.PngImage.LoadFromFile(ExpandConstant('{tmp}\app-icon.png'));

  { 2) 标题（水平居中） }
  TitleLabel := TNewStaticText.Create(CustomPage);
  TitleLabel.Parent := CustomPage.Surface;
  TitleLabel.AutoSize := False;
  TitleLabel.WordWrap := False;
  TitleLabel.Alignment := taCenter;
  TitleLabel.Left := 0;
  TitleLabel.Width := SW;
  TitleLabel.Height := TitleH;
  TitleLabel.Top := Top0 + LogoSize + Gap1;
  TitleLabel.Font.Size := 15;
  TitleLabel.Font.Style := [fsBold];
#ifdef Vue36
  TitleLabel.Caption := '安装 班集 Vue 3.6 预览版';
#else
  TitleLabel.Caption := '安装 班集 预览版';
#endif

  { Vue 3.6 预览通道专属提示：两行居中，字号比标题小一号，位置紧跟标题下方 }
#ifdef Vue36
  Vue36Hint1 := TNewStaticText.Create(CustomPage);
  Vue36Hint1.Parent := CustomPage.Surface;
  Vue36Hint1.AutoSize := False;
  Vue36Hint1.WordWrap := True;
  Vue36Hint1.Alignment := taCenter;
  Vue36Hint1.Left := ScaleX(18);
  Vue36Hint1.Width := SW - ScaleX(36);
  Vue36Hint1.Height := ScaleY(36);
  Vue36Hint1.Top := Top0 + LogoSize + Gap1 + TitleH + Gap2;
  Vue36Hint1.Font.Size := 9;
  Vue36Hint1.Caption := '该版本为Vue 3.6 新版本测试版本，可能会有不稳定性，仅供体验使用。';

  Vue36Hint2 := TNewStaticText.Create(CustomPage);
  Vue36Hint2.Parent := CustomPage.Surface;
  Vue36Hint2.AutoSize := False;
  Vue36Hint2.WordWrap := True;
  Vue36Hint2.Alignment := taCenter;
  Vue36Hint2.Left := ScaleX(18);
  Vue36Hint2.Width := SW - ScaleX(36);
  Vue36Hint2.Height := ScaleY(36);
  Vue36Hint2.Top := Vue36Hint1.Top + ScaleY(38);
  Vue36Hint2.Font.Size := 9;
  Vue36Hint2.Caption := '目前不推荐这个版本作为主力版本使用，如需主力使用，请下载其他版本';
#endif

  RowTop := Top0 + LogoSize + Gap1 + TitleH + Gap2 + HintH + HintGap;

  { 3) 安装路径：标签 + 圆角输入框 + 浏览按钮，整行水平居中 }
  FieldW := ScaleX(260);
  BtnW := ScaleX(78);

  PathLabel := TNewStaticText.Create(CustomPage);
  PathLabel.Parent := CustomPage.Surface;
  PathLabel.AutoSize := True;
  PathLabel.Caption := '安装路径';
  LabelW := PathLabel.Width;

  RowLeft := (SW - (LabelW + ScaleX(10) + FieldW + ScaleX(10) + BtnW)) div 2;
  if RowLeft < ScaleX(8) then
    RowLeft := ScaleX(8);

  PathLabel.Left := RowLeft;
  PathLabel.Top := RowTop + (RowH - PathLabel.Height) div 2;

  FieldBg := TBitmapImage.Create(CustomPage);
  FieldBg.Parent := CustomPage.Surface;
  FieldBg.AutoSize := False;
  FieldBg.Stretch := True;
  FieldBg.Left := RowLeft + LabelW + ScaleX(10);
  FieldBg.Top := RowTop;
  FieldBg.Width := FieldW;
  FieldBg.Height := RowH;
  FieldBg.PngImage.LoadFromFile(ExpandConstant('{tmp}\field-bg.png'));

  PathEdit := TNewEdit.Create(CustomPage);
  PathEdit.Parent := CustomPage.Surface;
  PathEdit.Left := FieldBg.Left + ScaleX(9);
  PathEdit.Width := FieldW - ScaleX(18);
  PathEdit.Top := RowTop + (RowH - PathEdit.Height) div 2;
  PathEdit.Text := ExpandConstant('{autopf}\班集');

  BrowseButton := TNewButton.Create(CustomPage);
  BrowseButton.Parent := CustomPage.Surface;
  BrowseButton.Caption := '浏览...';
  BrowseButton.Left := FieldBg.Left + FieldW + ScaleX(10);
  BrowseButton.Top := RowTop;
  BrowseButton.Width := BtnW;
  BrowseButton.Height := RowH;
  BrowseButton.OnClick := @BrowseButtonClick;

  { 4) 同意用户协议（水平居中） }
  { 用 TNewStaticText 量出文案宽度（它支持 AutoSize），再加上勾选框本体宽度，保证整行居中 }
  Measure := TNewStaticText.Create(CustomPage);
  Measure.Parent := CustomPage.Surface;
  Measure.AutoSize := True;
  Measure.Caption := '我已阅读并同意《用户协议》';
  CheckW := Measure.Width + ScaleX(22);
  Measure.Free;

  LicenseCheck := TNewCheckBox.Create(CustomPage);
  LicenseCheck.Parent := CustomPage.Surface;
  LicenseCheck.Caption := '我已阅读并同意《用户协议》';
  LicenseCheck.Width := CheckW;
  LicenseCheck.Top := RowTop + RowH + Gap3;
  LicenseCheck.Left := (SW - CheckW) div 2;
  LicenseCheck.OnClick := @LicenseCheckClick;
end;

{ 把底部向导按钮（上一步 / 安装 / 取消）排成等宽、等间距的一排：
  Inno 默认按各按钮自身文案单独算宽度，三个文案长短不一（且「上一步」在部分页还隐藏），
  视觉上间距就忽宽忽窄；这里统一取三者所需的最大宽度，再从右往左等距摆放。
  注意：CalculateButtonWidth 的参数是开放数组，只能传「内联数组字面量」[xxx]；
  传静态数组变量会在运行时抛 Type Mismatch，所以这里逐个文案单独量宽取最大值。 }
procedure LayoutWizardButtons();
var
  Gap, Right, W, T: Integer;
begin
  W := 0;
  if WizardForm.BackButton.Visible then
  begin
    T := WizardForm.CalculateButtonWidth([WizardForm.BackButton.Caption]);
    if T > W then
      W := T;
  end;
  if WizardForm.NextButton.Visible then
  begin
    T := WizardForm.CalculateButtonWidth([WizardForm.NextButton.Caption]);
    if T > W then
      W := T;
  end;
  if WizardForm.CancelButton.Visible then
  begin
    T := WizardForm.CalculateButtonWidth([WizardForm.CancelButton.Caption]);
    if T > W then
      W := T;
  end;
  if W <= 0 then
    Exit;

  { 沿用 Inno 自身的右边距：以「取消」按钮右边缘作为整排右边界 }
  Right := WizardForm.CancelButton.Left + WizardForm.CancelButton.Width;
  Gap := ScaleX(8);

  { 从右往左依次摆放：取消 → 安装 → 上一步 }
  if WizardForm.CancelButton.Visible then
  begin
    Right := Right - W;
    WizardForm.CancelButton.Left := Right;
    WizardForm.CancelButton.Width := W;
    Right := Right - Gap;
  end;
  if WizardForm.NextButton.Visible then
  begin
    Right := Right - W;
    WizardForm.NextButton.Left := Right;
    WizardForm.NextButton.Width := W;
    Right := Right - Gap;
  end;
  if WizardForm.BackButton.Visible then
  begin
    Right := Right - W;
    WizardForm.BackButton.Left := Right;
    WizardForm.BackButton.Width := W;
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = OsWarnPage.ID then
  begin
    { 提示页：底部按钮临时改为「退出程序」（左，高亮）/「忽略」（右）。
      进入本页时 Inno 已把「取消」的真实文案填好，此刻记下它以便切回安装页还原；
      只在首次进入时记，避免从安装页返回时把「退出程序」当成原始值记下。 }
    if not CancelCaptionOverridden then
    begin
      OrigCancelCaption := WizardForm.CancelButton.Caption;
      CancelCaptionOverridden := True;
    end;
    WizardForm.NextButton.Caption := '忽略';
    WizardForm.NextButton.Enabled := True;
    WizardForm.NextButton.Default := False;
    WizardForm.CancelButton.Caption := '退出程序';
    WizardForm.CancelButton.Default := True;
    LayoutWizardButtons();
  end
  else if CurPageID = CustomPage.ID then
  begin
    { 首次显示时去掉输入框原生边框（此时控件句柄才真正创建） }
    if not EditFixed then
    begin
      MakeBorderlessEdit(PathEdit);
      EditFixed := True;
    end;
    WizardForm.NextButton.Caption := '安装';
    WizardForm.NextButton.Default := True;
    WizardForm.NextButton.Enabled := LicenseCheck.Checked;
    { 只有提示页临时改过「取消」文案时才还原，否则保持 Inno 自己的文案（不要写回占位符 '*'） }
    if CancelCaptionOverridden then
      WizardForm.CancelButton.Caption := OrigCancelCaption;
    WizardForm.CancelButton.Default := False;
    LayoutWizardButtons();
  end;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = wpSelectDir) or (PageID = wpSelectTasks);
  { 低版本提示页仅在「系统过低且未勾选不再提示」时出现 }
  if PageID = OsWarnPage.ID then
    Result := not OsWarningNeeded;
end;

{ 点「退出程序」/关闭向导：提示页上不再弹「确定要退出安装吗」确认框，直接退出 }
procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  if SkipExitConfirm or (CurPageID = OsWarnPage.ID) then
    Confirm := False;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = CustomPage.ID then
  begin
    { 静默安装（/SILENT、/VERYSILENT，自动更新走的就是这条）下无人勾选协议，
      若仍按未勾选处理会直接 Result:=False，导致整个安装中止（日志：
      Failed to proceed to next wizard page; aborting），故静默时跳过校验。 }
    if (not WizardSilent) and (not LicenseCheck.Checked) then
    begin
      Result := False;
      Exit;
    end;
    { 把我们自绘的输入框内容同步给真正的安装目录控件 }
    WizardForm.DirEdit.Text := PathEdit.Text;
  end;
end;

{ ============================================================================
  卸载侧：自绘卸载页 + 「保留用户数据」真开关
  ----------------------------------------------------------------------------
  两条入口（开始菜单快捷方式、卸载注册表项 UninstallString）都带
  /SILENT /CUSTOMUNINSTALL。/SILENT 抑制 Inno 自带的确认框与完成提示
  （进度窗仍显示），/CUSTOMUNINSTALL 表示由本脚本弹卸载页。
  Inno 卸载端既不支持自定义向导页，也不能 ExtractTemporaryFile，
  所以卸载页用 CreateCustomForm 造独立模态窗体，logo 从安装目录里
  额外落下的 uninstall-logo.png 读取。 ======================================== }

function HasCustomUninstallSwitch(): Boolean;
begin
  Result := Pos(Uppercase(UNINSTALL_SWITCH), Uppercase(GetCmdTail())) > 0;
end;

{ 数据目录可以被设置页整体搬走，路径记在 userData 根的 app-config.json。
  LoadStringsFromFile 支持无 BOM 的 UTF-8，中文路径不会乱码。
  saveAppConfig 用 JSON.stringify 写盘，Windows 路径里的反斜杠会写成两个，
  取出来要还原成单个。 }
function ReadConfiguredDataDir(const UserDataRoot: String): String;
var
  Lines: TArrayOfString;
  I, P: Integer;
  S, V: String;
begin
  Result := '';
  if not LoadStringsFromFile(UserDataRoot + '\app-config.json', Lines) then
    Exit;
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    S := Trim(Lines[I]);
    if Copy(S, 1, Length('"dataDir"')) = '"dataDir"' then
    begin
      V := Trim(Copy(S, Pos(':', S) + 1, Length(S)));
      if Copy(V, Length(V), 1) = ',' then
        V := Copy(V, 1, Length(V) - 1);
      V := Trim(V);
      if Length(V) < 2 then
        Exit;
      if (V[1] = '"') and (V[Length(V)] = '"') then
        V := Copy(V, 2, Length(V) - 2);
      while Pos('\\', V) > 0 do
      begin
        P := Pos('\\', V);
        V := Copy(V, 1, P - 1) + '\' + Copy(V, P + 2, Length(V));
      end;
      Result := V;
      Exit;
    end;
  end;
end;

{ 只认「确实是班集数据目录」的路径：core/index.db 或 core/db-master.key。
  这两个判据与设置页数据搬迁的预检一致，也用来防止配置写坏、或提权后
  userData 落到别的账户时误删无关目录。 }
function LooksLikeClassNestDataDir(const Dir: String): Boolean;
begin
  Result := FileExists(Dir + '\core\index.db') or
            FileExists(Dir + '\core\db-master.key');
end;

{ 再挡一层明显的系统位置：盘根、Windows、Program Files、ProgramData。
  不挡 Users —— 默认数据目录就在用户目录下。 }
function IsProtectedDir(const Dir: String): Boolean;
var
  U: String;
begin
  U := Uppercase(Dir);
  Result := (Length(U) <= 3) or
            (Pos(':\WINDOWS', U) = 2) or
            (Pos(':\PROGRAM FILES', U) = 2) or
            (Pos(':\PROGRAMDATA', U) = 2);
end;

{ userData 根必须真的有班集留下的东西才删 }
function IsExpectedUserDataRoot(const Dir: String): Boolean;
begin
  Result := DirExists(Dir + '\data') or DirExists(Dir + '\core') or
            FileExists(Dir + '\app-config.json') or
            FileExists(Dir + '\setup-incomplete');
end;

{ 勾选框状态变化时更新提示文字 }
procedure KeepDataCheckClick(Sender: TObject);
begin
  if UninstallKeepCheck.Checked then
  begin
    UninstallHint.Caption := '重装后可继续使用原有账号';
    UninstallHint.Font.Color := UNINSTALL_HINT_GRAY;
  end
  else
  begin
    UninstallHint.Caption := '将删除账号库、上传文件与相册，不可恢复；请先退出班集';
    UninstallHint.Font.Color := OS_WARN_TEXT_COLOR;
  end;
end;

{ 自绘卸载页：版式照抄安装页（88px logo 居中、15pt 加粗标题、居中勾选框、
  底部按钮，整体垂直居中）。返回 True = 用户点了「卸载 班集」。 }
function ShowUninstallDialog(): Boolean;
var
  Form: TSetupForm;
  Logo: TBitmapImage;
  Title: TNewStaticText;
  BtnCancel, BtnUninstall: TNewButton;
  Measure: TNewStaticText;
  SW, SH, LogoSize, TitleH, CheckH, HintH, BtnH: Integer;
  Gap1, Gap2, Gap3, Gap4, BlockH, Top0, RowTop: Integer;
  BtnW, CheckW: Integer;
  LogoPath: String;
begin
  Result := False;
  RemoveUserData := False;
  Form := CreateCustomForm(460, 360, False, False);
  try
    Form.Caption := '卸载 班集';
    Form.Left := (GetSystemMetrics(0) - Form.Width) div 2;
    Form.Top := (GetSystemMetrics(1) - Form.Height) div 2;
    SW := Form.ClientWidth;
    SH := Form.ClientHeight;

    LogoSize := ScaleX(88);
    TitleH := ScaleY(32);
    CheckH := ScaleY(20);
    HintH := ScaleY(20);
    BtnH := ScaleY(30);
    Gap1 := ScaleY(16);
    Gap2 := ScaleY(26);
    Gap3 := ScaleY(10);
    Gap4 := ScaleY(24);

    BlockH := LogoSize + Gap1 + TitleH + Gap2 + CheckH + Gap3 + HintH + Gap4 + BtnH;
    Top0 := (SH - BlockH) div 2;
    if Top0 < ScaleY(10) then
      Top0 := ScaleY(10);

    Logo := TBitmapImage.Create(Form);
    Logo.Parent := Form;
    Logo.AutoSize := False;
    Logo.Stretch := True;
    Logo.Width := LogoSize;
    Logo.Height := LogoSize;
    Logo.Left := (SW - LogoSize) div 2;
    Logo.Top := Top0;
    LogoPath := ExpandConstant('{app}\uninstall-logo.png');
    if FileExists(LogoPath) then
      Logo.PngImage.LoadFromFile(LogoPath);

    Title := TNewStaticText.Create(Form);
    Title.Parent := Form;
    Title.AutoSize := False;
    Title.WordWrap := False;
    Title.Alignment := taCenter;
    Title.Left := 0;
    Title.Width := SW;
    Title.Height := TitleH;
    Title.Top := Top0 + LogoSize + Gap1;
    Title.Font.Size := 15;
    Title.Font.Style := [fsBold];
    Title.Caption := '班集 预览版';

    RowTop := Top0 + LogoSize + Gap1 + TitleH + Gap2;

    Measure := TNewStaticText.Create(Form);
    Measure.Parent := Form;
    Measure.AutoSize := True;
    Measure.Caption := '保留用户数据';
    CheckW := Measure.Width + ScaleX(22);
    Measure.Free;

    UninstallKeepCheck := TNewCheckBox.Create(Form);
    UninstallKeepCheck.Parent := Form;
    UninstallKeepCheck.Caption := '保留用户数据';
    UninstallKeepCheck.Checked := True;
    UninstallKeepCheck.Width := CheckW;
    UninstallKeepCheck.Left := (SW - CheckW) div 2;
    UninstallKeepCheck.Top := RowTop;
    UninstallKeepCheck.OnClick := @KeepDataCheckClick;

    UninstallHint := TNewStaticText.Create(Form);
    UninstallHint.Parent := Form;
    UninstallHint.AutoSize := False;
    UninstallHint.WordWrap := False;
    UninstallHint.Alignment := taCenter;
    UninstallHint.Left := 0;
    UninstallHint.Width := SW;
    UninstallHint.Height := HintH;
    UninstallHint.Top := RowTop + CheckH + Gap3;
    UninstallHint.Font.Size := 9;
    UninstallHint.Font.Color := UNINSTALL_HINT_GRAY;
    UninstallHint.Caption := '重装后可继续使用原有账号';

    BtnW := ScaleX(110);
    BtnCancel := TNewButton.Create(Form);
    BtnCancel.Parent := Form;
    BtnCancel.Caption := '取消';
    BtnCancel.ModalResult := mrNo;
    BtnCancel.Width := BtnW;
    BtnCancel.Height := BtnH;
    BtnCancel.Left := (SW - (BtnW * 2 + ScaleX(10))) div 2;
    BtnCancel.Top := RowTop + CheckH + Gap3 + HintH + Gap4;

    BtnUninstall := TNewButton.Create(Form);
    BtnUninstall.Parent := Form;
    BtnUninstall.Caption := '卸载 班集';
    BtnUninstall.ModalResult := mrYes;
    BtnUninstall.Default := True;
    BtnUninstall.Width := BtnW;
    BtnUninstall.Height := BtnH;
    BtnUninstall.Left := BtnCancel.Left + BtnW + ScaleX(10);
    BtnUninstall.Top := BtnCancel.Top;
    Form.ActiveControl := BtnUninstall;

    Result := Form.ShowModal() = mrYes;
    RemoveUserData := Result and (not UninstallKeepCheck.Checked);
  finally
    Form.Free();
  end;
end;

{ 卸载入口：只有带自定义开关才弹自绘页。直接双击 unins000.exe、
  系统静默卸载（/VERYSILENT）都保持 Inno 默认行为，且一律保留数据。 }
function InitializeUninstall(): Boolean;
var
  FlagPath: String;
begin
  Result := True;
  RemoveUserData := False;
  FlagPath := ExpandConstant(UNINSTALL_FLAG_FILE);
  DeleteFile(FlagPath);
  if not HasCustomUninstallSwitch() then
    Exit;
  Result := ShowUninstallDialog();
  if not Result then
    Exit;
  if RemoveUserData then
    SaveStringToFile(FlagPath, '1', False);
end;

{ 真正删数据放在 usPostUninstall：程序文件已移除、卸载已基本成功，
  不会出现「软件还在、数据没了」的半套状态。 }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  FlagPath, UserDataRoot, DataDir: String;
begin
  if CurUninstallStep <> usPostUninstall then
    Exit;
  FlagPath := ExpandConstant(UNINSTALL_FLAG_FILE);
  if not FileExists(FlagPath) then
    Exit;
  DeleteFile(FlagPath);

  UserDataRoot := ExpandConstant('{userappdata}') + '\classnest';

  { 1) 数据目录：含设置页搬走后的自定义 dataDir }
  DataDir := ReadConfiguredDataDir(UserDataRoot);
  if (DataDir <> '') and (not IsProtectedDir(DataDir)) and
     LooksLikeClassNestDataDir(DataDir) then
  begin
    if DelTree(DataDir, True, True, True) then
      Log('已删除数据目录：' + DataDir)
    else
      Log('数据目录未能完全删除（可能有文件正被占用）：' + DataDir);
  end
  else
    Log('跳过数据目录（配置缺失或安全校验未通过）：' + DataDir);

  { 2) userData 根：app-config.json、日志、缩略图缓存、更新包等 }
  if IsExpectedUserDataRoot(UserDataRoot) then
  begin
    if DelTree(UserDataRoot, True, True, True) then
      Log('已删除用户配置目录：' + UserDataRoot)
    else
      Log('用户配置目录未能完全删除（可能有文件正被占用）：' + UserDataRoot);
  end;
end;

{ 安装结束后把自定义开关追加到卸载注册表项，让「设置 → 应用 → 卸载」
  也走自绘页。Inno 每次覆盖安装都会重写这两个值，所以每次 ssPostInstall
  都要写；已带开关时跳过，避免重复追加。 }
procedure AppendCustomUninstallSwitch(const ValueName: String);
var
  S: String;
begin
  if not RegQueryStringValue(HKEY_LOCAL_MACHINE, UNINSTALL_REG_KEY,
                             ValueName, S) then
  begin
    Log('未读到卸载注册表值 ' + ValueName + '，跳过追加自定义卸载开关');
    Exit;
  end;
  if Pos(Uppercase(UNINSTALL_SWITCH), Uppercase(S)) > 0 then
    Exit;
  if Pos('/SILENT', Uppercase(S)) = 0 then
    S := S + ' /SILENT';
  S := S + ' ' + UNINSTALL_SWITCH;
  if not RegWriteStringValue(HKEY_LOCAL_MACHINE, UNINSTALL_REG_KEY,
                             ValueName, S) then
    Log('写入卸载注册表值 ' + ValueName + ' 失败');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    AppendCustomUninstallSwitch('UninstallString');
    AppendCustomUninstallSwitch('QuietUninstallString');
  end;
end;