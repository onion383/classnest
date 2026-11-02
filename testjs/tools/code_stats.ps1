<#
Git 代码与文档统计
功能：
1. git ls-files 读取文件列表（自动遵循 .gitignore）
2. 逐个统计每个代码文件：原始行数、代码行（已排除注释与空行）、字符数
3. 代码文件明细按代码行降序
4. 汇总维度：按后缀、按目录/模块
5. 报告导出为 Markdown：doc/development/code-stats.md
6. 代码与文档分开统计：代码按后缀白名单（源码/样式/标记/脚本/配置），文档单独统计 doc/ 与仓库根目录的 Markdown（原始行 / 非空行 / 字符数）；锁文件、资源等排除
7. 文档统计单独成板块：按子目录汇总 + 文件明细，不含代码量口径
8. 报告自身也计入文档：先生成占位版本，再把正文的行数 / 字符数反算回自身行，迭代到数值一致

说明：不依赖 ThreadJob 等第三方模块，兼容 Windows PowerShell 5.1 与 PowerShell 7+。
#>
param(
    # 非交互调用（CI、管道、Agent）时传 -NoPause，避免末尾 Read-Host 挂住
    [switch]$NoPause
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

# 脚本位于 testjs/tools/，仓库根在上三级（原先放在仓库根，只需一级）
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
Set-Location -LiteralPath $root

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "Git 代码与文档统计（代码行 / 原始行 / 字符数）" -ForegroundColor Cyan
Write-Host "自动遵循 .gitignore；文档单独统计 doc/ 与仓库根目录的 Markdown" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# ---- 取 git 跟踪文件 ----
$fileList = @()
try {
    # core.quotepath=false：避免中文文件名被转义成带引号的八进制串，导致 Path.GetFileName 抛「非法字符」
    $fileList = @(git -c core.quotepath=false ls-files 2>$null)
} catch {
    $fileList = @()
}
if ($fileList.Count -eq 0) {
    Write-Host "❌ 当前目录不是 git 仓库，或没有被 git 跟踪的文件" -ForegroundColor Red
    try { Read-Host "`n按回车退出" } catch { }
    exit
}

# ---- 仅统计纯手写代码：按后缀白名单（源码 / 样式 / 标记 / 脚本 / 配置）----
# 白名单之外的（文档 md/txt、图片/字体/压缩包/二进制等）一律排除；锁文件另按文件名排除
$codeExt = @(
    '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue',
    '.css', '.scss', '.sass', '.less',
    '.html', '.htm',
    '.json', '.iss',
    '.sh', '.bash', '.ps1', '.bat', '.cmd',
    '.py', '.rb', '.go', '.rs', '.java', '.cs', '.c', '.cpp', '.h', '.hpp',
    '.php', '.kt', '.swift', '.sql'
)

# 生成物按文件名排除（即使后缀在白名单里也不统计），例如锁文件
$excludeNames = @('package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml')

$sourceFiles = @()
$skippedCount = 0
foreach ($f in $fileList) {
    $name = [System.IO.Path]::GetFileName($f).ToLower()
    if ($excludeNames -contains $name) { $skippedCount++; continue }
    if ($codeExt -contains [System.IO.Path]::GetExtension($f).ToLower()) {
        $sourceFiles += $f
    } else {
        $skippedCount++
    }
}

# ---- 文档统计：单独板块，统计 doc/ 与仓库根目录的 Markdown ----
# 与代码统计分开：文档不计「代码行」，用「原始行 / 非空行 / 字符数」衡量。
# 按文件系统扫描，未提交的新文档也会计入；排除编辑器配置（.obsidian）与
# 不入库的过程性材料（doc/开发文档）。统计报告自身先排除，生成正文后再补入（见两遍法）。
$docFiles = @()
$docRoot = Join-Path $root 'doc'
if (Test-Path -LiteralPath $docRoot) {
    $docFiles = @(
        Get-ChildItem -LiteralPath $docRoot -Recurse -File -Filter '*.md' |
            Where-Object {
                $_.FullName -notmatch '\\\.obsidian\\' -and
                $_.FullName -notmatch '\\开发文档\\' -and
                $_.Name -ne '仓库代码数量统计.md' -and
                $_.Name -ne 'code-stats.md'
            } |
            ForEach-Object { $_.FullName.Substring($root.Length + 1) -replace '\\', '/' }
    )
}
# 仓库根目录的 Markdown（README.md 等文档入口）一并计入；LICENSE.md 属于法律文本，不计
$rootDocFiles = @(
    Get-ChildItem -LiteralPath $root -File -Filter '*.md' |
        Where-Object { $_.Name -ne 'LICENSE.md' -and $_.Name -ne 'code-stats.md' } |
        ForEach-Object { $_.Name }
)
$docFiles = @($docFiles + $rootDocFiles)

# 行注释前缀（按后缀）——统计“代码行”时用于剔除整行注释
function Get-LineCommentPrefixes {
    param([string]$Ext)
    switch ($Ext) {
        { $_ -in '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue',
                  '.css', '.scss', '.sass', '.less',
                  '.java', '.cs', '.c', '.cpp', '.h', '.hpp',
                  '.php', '.go', '.rs', '.kt', '.swift' } { return @('//') }
        { $_ -in '.sh', '.bash', '.ps1', '.py', '.rb' } { return @('#') }
        '.iss'  { return @(';') }
        '.sql'  { return @('--') }
        default { return @() }
    }
}

# ---- 单个文件统计 ----
function Measure-OneFile {
    param([string]$RelPath)

    $full = Join-Path $root $RelPath
    $text = ''
    try {
        # ReadAllText 自动识别 BOM，无 BOM 时按 UTF-8 解码；二进制也不会抛异常
        $text = [System.IO.File]::ReadAllText($full)
    } catch {
        # 无法读取（权限/占用/已删除）按空文件处理，避免整个脚本中断
        $text = ''
    }

    # 后缀（无后缀归为“无后缀”）
    $ext = [System.IO.Path]::GetExtension($RelPath)
    if ([string]::IsNullOrEmpty($ext)) { $ext = '无后缀' }

    # 原始行数：换行符个数；结尾有换行则末行不计为空行
    if ($text.Length -eq 0) {
        $rawLines = 0
    } else {
        $rawLines = ($text -split "`n").Count
        if ($text.EndsWith("`n")) { $rawLines-- }
    }

    # 代码行：先剥离块注释（/* */ 与 <!-- -->），再去掉整行注释与空行
    $prefixes = Get-LineCommentPrefixes -Ext $ext
    $stripped = $text -replace '(?s)/\*.*?\*/', '' -replace '(?s)<!--.*?-->', ''
    $codeLines = 0
    foreach ($ln in ($stripped -split "`n")) {
        $t = $ln.Trim()
        if ($t -eq '') { continue }
        $isComment = $false
        foreach ($p in $prefixes) {
            if ($t.StartsWith($p)) { $isComment = $true; break }
        }
        if (-not $isComment) { $codeLines++ }
    }

    # 模块：取路径第一段（顶层目录）；根目录下的文件归为“(根目录)”
    # testjs 作为一个整体模块统计，不再按 units/smoke/probe/tools 细分
    $norm = $RelPath -replace '\\', '/'
    $slash = $norm.IndexOf('/')
    $module = if ($slash -lt 0) { '(根目录)' } else { $norm.Substring(0, $slash) }

    [PSCustomObject]@{
        FilePath = $RelPath
        Module   = $module
        Ext      = $ext
        Lines    = $rawLines
        Code     = $codeLines
        Chars    = $text.Length
    }
}

# ---- 单个文档统计 ----
# 文档没有注释语法，因此以「非空行」作为有效行；Markdown 表格、代码围栏都按内容行计入。
function Measure-OneDoc {
    param([string]$RelPath)

    $full = Join-Path $root $RelPath
    $text = ''
    try {
        $text = [System.IO.File]::ReadAllText($full)
    } catch {
        $text = ''
    }

    if ($text.Length -eq 0) {
        $rawLines = 0
        $nonEmpty = 0
    } else {
        # 原始行数：换行符个数；结尾有换行则末行不计为空行
        $rawLines = ($text -split "`n").Count
        if ($text.EndsWith("`n")) { $rawLines-- }
        $nonEmpty = 0
        foreach ($ln in ($text -split "`n")) {
            if ($ln.Trim() -ne '') { $nonEmpty++ }
        }
    }

    # 模块：doc/ 下的第一段子目录；直接放在 doc/ 根下的归为「(doc 根目录)」；仓库根目录的归为「(仓库根目录)」
    $normalizedPath = $RelPath -replace '\\', '/'
    if ($normalizedPath -like 'doc/*') {
        $norm = $normalizedPath.Substring(3).TrimStart('/')
        $slash = $norm.IndexOf('/')
        $module = if ($slash -lt 0 -or $norm.Length -eq 0) { '(doc 根目录)' } else { 'doc/' + $norm.Substring(0, $slash) }
    } else {
        $module = '(仓库根目录)'
    }

    [PSCustomObject]@{
        FilePath = $RelPath
        Module   = $module
        Ext      = '.md'
        Lines    = $rawLines
        NonEmpty = $nonEmpty
        Chars    = $text.Length
    }
}

Write-Host "⏳ 正在统计 $($sourceFiles.Count) 个源码文件、$($docFiles.Count + 1) 个文档（含报告自身；已排除 $skippedCount 个非源码文件）..."
$allResult = @()
foreach ($f in $sourceFiles) {
    $allResult += Measure-OneFile -RelPath $f
}

$sorted = @($allResult | Sort-Object -Property Code -Descending)

# ---- 汇总（按指定字段分组小计）----
function Group-Summary {
    param($Items, [string]$KeyName)
    $Items | Group-Object -Property $KeyName | ForEach-Object {
        [PSCustomObject]@{
            Key   = $_.Name
            Count = $_.Count
            Lines = ($_.Group | Measure-Object -Property Lines -Sum).Sum
            Code  = ($_.Group | Measure-Object -Property Code  -Sum).Sum
            Chars = ($_.Group | Measure-Object -Property Chars -Sum).Sum
        }
    } | Sort-Object -Property Code -Descending
}

$byExt    = @(Group-Summary -Items $allResult -KeyName 'Ext')
$byModule = @(Group-Summary -Items $allResult -KeyName 'Module')

$totalFiles = $allResult.Count
$totalLines = ($allResult | Measure-Object -Property Lines -Sum).Sum
$totalCode  = ($allResult | Measure-Object -Property Code  -Sum).Sum
$totalChars = ($allResult | Measure-Object -Property Chars -Sum).Sum

# ---- 文档基础数据：doc/ 下 Markdown，暂不含本报告自身 ----
$docBaseResult = @()
foreach ($f in $docFiles) {
    $docBaseResult += Measure-OneDoc -RelPath $f
}

# ---- 报告自身：先留一行占位（数值为 0），生成正文后反算行数/字符数再回填 ----
$selfDocPath = 'doc/development/code-stats.md'
$selfDoc = [PSCustomObject]@{
    FilePath = $selfDocPath
    Module   = 'doc/development'
    Ext      = '.md'
    Lines    = 0
    NonEmpty = 0
    Chars    = 0
}

# 把「生成出来的报告正文」当作一个文档来度量（不读盘，避免受文件尚未写完影响）
function Measure-TextDoc {
    param([string]$Text)
    if ($Text.Length -eq 0) {
        return [PSCustomObject]@{ Lines = 0; NonEmpty = 0; Chars = 0 }
    }
    $rawLines = ($Text -split "`n").Count
    if ($Text.EndsWith("`n")) { $rawLines-- }
    $nonEmpty = 0
    foreach ($ln in ($Text -split "`n")) {
        if ($ln.Trim() -ne '') { $nonEmpty++ }
    }
    return [PSCustomObject]@{ Lines = $rawLines; NonEmpty = $nonEmpty; Chars = $Text.Length }
}

# ---- 生成报告正文 ----
# 传入报告自身的统计值后，文档合计、仓库合计与正文里的自身行都随之更新；
# 外层用两遍法反复调用，直到「正文自身的统计值」与传入值一致。
function New-Report {
    param($SelfDoc)

    $docResult = @($docBaseResult)
    if ($SelfDoc) { $docResult += $SelfDoc }

    $docSorted = @($docResult | Sort-Object -Property NonEmpty -Descending)
    $docByModule = @(
        $docResult | Group-Object -Property Module | ForEach-Object {
            [PSCustomObject]@{
                Key      = $_.Name
                Count    = $_.Count
                Lines    = ($_.Group | Measure-Object -Property Lines    -Sum).Sum
                NonEmpty = ($_.Group | Measure-Object -Property NonEmpty -Sum).Sum
                Chars    = ($_.Group | Measure-Object -Property Chars    -Sum).Sum
            }
        } | Sort-Object -Property NonEmpty -Descending
    )

    $docTotalFiles    = $docResult.Count
    $docTotalLines    = ($docResult | Measure-Object -Property Lines    -Sum).Sum
    $docTotalNonEmpty = ($docResult | Measure-Object -Property NonEmpty -Sum).Sum
    $docTotalChars    = ($docResult | Measure-Object -Property Chars    -Sum).Sum

    # 仓库汇总：代码 + 文档（含报告自身）
    $repoTotalFiles = $totalFiles + $docTotalFiles
    $repoTotalLines = $totalCode + $docTotalNonEmpty
    $repoRawLines   = $totalLines + $docTotalLines
    $repoTotalChars = $totalChars + $docTotalChars

    $md = New-Object System.Collections.Generic.List[string]
    $md.Add('# 代码与文档统计报告')
    $md.Add('')
    $md.Add("> 生成时间：$generatedAt")
    $md.Add("> 代码：$totalFiles 文件 / $totalCode 行")
    $md.Add("> 文档：$docTotalFiles 文件 / $docTotalNonEmpty 非空行")
    $md.Add('')

    $md.Add('## 全局汇总')
    $md.Add('')
    $md.Add('### 代码')
    $md.Add('')
    $md.Add('| 指标 | 数值 |')
    $md.Add('| --- | :---: |')
    $md.Add("| 代码文件数 | $totalFiles |")
    $md.Add("| 代码总行数（排除注释与空行） | $totalCode |")
    $md.Add("| 代码原始总行数 | $totalLines |")
    $md.Add("| 代码总字符数 | $totalChars |")
    $md.Add("| 已排除非源码文件 | $skippedCount |")
    $md.Add('')
    $md.Add('### 文档')
    $md.Add('')
    $md.Add('| 指标 | 数值 |')
    $md.Add('| --- | :---: |')
    $md.Add("| 文档文件数 | $docTotalFiles |")
    $md.Add("| 文档有效行数（排除空行） | $docTotalNonEmpty |")
    $md.Add("| 文档原始总行数 | $docTotalLines |")
    $md.Add("| 文档总字符数 | $docTotalChars |")
    $md.Add('')
    $md.Add('### 仓库')
    $md.Add('')
    $md.Add('| 指标 | 数值 |')
    $md.Add('| --- | :---: |')
    $md.Add("| 仓库总文件数（代码 + 文档） | $repoTotalFiles |")
    $md.Add("| 仓库有效总行数（代码行 + 文档非空行） | $repoTotalLines |")
    $md.Add("| 仓库原始总行数（代码 + 文档） | $repoRawLines |")
    $md.Add("| 仓库总字符数（代码 + 文档） | $repoTotalChars |")
    $md.Add('')
    $md.Add('---')
    $md.Add('')

    $md.Add('## 文档统计（doc/ 与仓库根目录）')
    $md.Add('')
    $md.Add('统计范围为 doc/ 与仓库根目录的 Markdown（doc/ 内排除 `.obsidian` 与 `doc/开发文档`，根目录不含 `LICENSE.md`）；**包含本报告自身**，自身数值由生成两遍后反算。')
    $md.Add('')
    $md.Add('| 指标 | 数值 |')
    $md.Add('| --- | :---: |')
    $md.Add("| 文档文件数 | $docTotalFiles |")
    $md.Add("| 文档有效行数（排除空行） | $docTotalNonEmpty |")
    $md.Add("| 文档原始总行数 | $docTotalLines |")
    $md.Add("| 文档总字符数 | $docTotalChars |")
    $md.Add('')
    $md.Add('### 按子目录')
    $md.Add('')
    $md.Add('| 序号 | 子目录 | 文件数 | 非空行 | 原始行 | 字符数 |')
    $md.Add('| :---: | --- | :---: | :---: | :---: | :---: |')
    $i = 0
    foreach ($g in $docByModule) {
        $i++
        $md.Add("| $i | $($g.Key) | $($g.Count) | $($g.NonEmpty) | $($g.Lines) | $($g.Chars) |")
    }
    $md.Add('')
    $md.Add('### 文件明细（按非空行降序）')
    $md.Add('')
    $md.Add('| 序号 | 文件名 | 非空行 | 原始行 | 字符数 | 文件路径 |')
    $md.Add('| :---: | --- | :---: | :---: | :---: | --- |')
    $i = 0
    foreach ($item in $docSorted) {
        $i++
        $md.Add("| $i | $([System.IO.Path]::GetFileName($item.FilePath)) | $($item.NonEmpty) | $($item.Lines) | $($item.Chars) | $($item.FilePath) |")
    }
    $md.Add('')
    $md.Add('---')
    $md.Add('')

    $md.Add('## 代码')
    $md.Add('')
    $md.Add('### 按目录/模块汇总')
    $md.Add('')
    $md.Add('| 序号 | 模块 | 文件数 | 代码行 | 原始行 | 字符数 |')
    $md.Add('| :---: | --- | :---: | :---: | :---: | :---: |')
    $i = 0
    foreach ($g in $byModule) {
        $i++
        $md.Add("| $i | $($g.Key) | $($g.Count) | $($g.Code) | $($g.Lines) | $($g.Chars) |")
    }
    $md.Add('')
    $md.Add('### 按后缀汇总')
    $md.Add('')
    $md.Add('| 序号 | 后缀 | 文件数 | 代码行 | 原始行 | 字符数 |')
    $md.Add('| :---: | --- | :---: | :---: | :---: | :---: |')
    $i = 0
    foreach ($g in $byExt) {
        $i++
        $md.Add("| $i | $($g.Key) | $($g.Count) | $($g.Code) | $($g.Lines) | $($g.Chars) |")
    }
    $md.Add('')
    $md.Add('### 文件明细（按代码行降序）')
    $md.Add('')
    $md.Add('| 序号 | 文件名 | 代码行 | 原始行 | 字符数 | 后缀 | 模块 | 文件路径 |')
    $md.Add('| :---: | --- | :---: | :---: | :---: | --- | --- | --- |')
    $i = 0
    foreach ($item in $sorted) {
        $i++
        $md.Add("| $i | $([System.IO.Path]::GetFileName($item.FilePath)) | $($item.Code) | $($item.Lines) | $($item.Chars) | $($item.Ext) | $($item.Module) | $($item.FilePath) |")
    }
    $md.Add('')
    $md.Add('---')

    [PSCustomObject]@{
        Text             = ($md -join "`r`n")
        DocSorted        = $docSorted
        DocByModule      = $docByModule
        DocTotalFiles    = $docTotalFiles
        DocTotalLines    = $docTotalLines
        DocTotalNonEmpty = $docTotalNonEmpty
        DocTotalChars    = $docTotalChars
        RepoTotalFiles   = $repoTotalFiles
        RepoTotalLines   = $repoTotalLines
        RepoRawLines     = $repoRawLines
        RepoTotalChars   = $repoTotalChars
    }
}

# ---- 两遍法：正文里的自身统计值与生成结果一致为止 ----
$generatedAt = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$report = New-Report -SelfDoc $selfDoc
for ($pass = 0; $pass -lt 5; $pass++) {
    # 落盘时会在正文末尾补一个换行，度量时按最终文件内容计算
    $measured = Measure-TextDoc -Text ($report.Text + "`r`n")
    if ($measured.Lines -eq $selfDoc.Lines -and
        $measured.NonEmpty -eq $selfDoc.NonEmpty -and
        $measured.Chars -eq $selfDoc.Chars) { break }
    $selfDoc = [PSCustomObject]@{
        FilePath = $selfDocPath
        Module   = 'doc/development'
        Ext      = '.md'
        Lines    = $measured.Lines
        NonEmpty = $measured.NonEmpty
        Chars    = $measured.Chars
    }
    $report = New-Report -SelfDoc $selfDoc
}
$docByModule      = $report.DocByModule
$docSorted        = $report.DocSorted
$docTotalFiles    = $report.DocTotalFiles
$docTotalLines    = $report.DocTotalLines
$docTotalNonEmpty = $report.DocTotalNonEmpty
$docTotalChars    = $report.DocTotalChars
$repoTotalFiles   = $report.RepoTotalFiles
$repoTotalLines   = $report.RepoTotalLines
$repoRawLines     = $report.RepoRawLines
$repoTotalChars   = $report.RepoTotalChars

# ---- 控制台输出：文件明细 ----
Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "文件列表【按代码行从大到小排序】"
Write-Host "序号`t文件名`t代码行`t原始行`t字符数`t后缀`t文件路径"
Write-Host "======================================" -ForegroundColor Cyan
$i = 0
foreach ($item in $sorted) {
    $i++
    Write-Host ("{0,4}`t{1}`t{2}`t{3}`t{4}`t{5}`t{6}" -f $i, [System.IO.Path]::GetFileName($item.FilePath), $item.Code, $item.Lines, $item.Chars, $item.Ext, $item.FilePath)
}

# ---- 控制台输出：按后缀汇总 ----
Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "【按后缀汇总统计】"
Write-Host "序号`t后缀`t文件数`t代码行`t原始行`t字符数"
Write-Host "======================================" -ForegroundColor Cyan
$i = 0
foreach ($g in $byExt) {
    $i++
    Write-Host ("{0,4}`t{1}`t{2}`t{3}`t{4}`t{5}" -f $i, $g.Key, $g.Count, $g.Code, $g.Lines, $g.Chars)
}

# ---- 控制台输出：按目录/模块汇总 ----
Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "【按目录/模块汇总统计】"
Write-Host "序号`t模块`t文件数`t代码行`t原始行`t字符数"
Write-Host "======================================" -ForegroundColor Cyan
$i = 0
foreach ($g in $byModule) {
    $i++
    Write-Host ("{0,4}`t{1}`t{2}`t{3}`t{4}`t{5}" -f $i, $g.Key, $g.Count, $g.Code, $g.Lines, $g.Chars)
}

# ---- 控制台输出：全局汇总 ----
Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "全局汇总"
Write-Host "—— 代码 ——"
Write-Host "代码文件数：$totalFiles"
Write-Host "代码行（已排除注释与空行）：$totalCode"
Write-Host "代码原始总行数：$totalLines"
Write-Host "代码总字符数：$totalChars"
Write-Host "已排除非源码文件：$skippedCount"
Write-Host "======================================" -ForegroundColor Cyan

# ---- 控制台输出：文档统计（单独板块）----
Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "【文档统计】doc/ 与仓库根目录的 Markdown（与代码分开统计）"
Write-Host "序号`t子目录`t文件数`t非空行`t原始行`t字符数"
Write-Host "======================================" -ForegroundColor Cyan
$i = 0
foreach ($g in $docByModule) {
    $i++
    Write-Host ("{0,4}`t{1}`t{2}`t{3}`t{4}`t{5}" -f $i, $g.Key, $g.Count, $g.NonEmpty, $g.Lines, $g.Chars)
}
Write-Host ""
Write-Host "—— 文档 ——"
Write-Host "文档文件数：$docTotalFiles"
Write-Host "文档有效行数（已排除空行）：$docTotalNonEmpty"
Write-Host "文档原始总行数：$docTotalLines"
Write-Host "文档总字符数：$docTotalChars"
Write-Host "======================================" -ForegroundColor Cyan

# ---- 控制台输出：文档明细 ----
Write-Host ""
Write-Host "文档列表【按非空行从大到小排序】"
Write-Host "序号`t文件名`t非空行`t原始行`t字符数`t文件路径"
$i = 0
foreach ($item in $docSorted) {
    $i++
    Write-Host ("{0,4}`t{1}`t{2}`t{3}`t{4}`t{5}" -f $i, [System.IO.Path]::GetFileName($item.FilePath), $item.NonEmpty, $item.Lines, $item.Chars, $item.FilePath)
}

# ---- 控制台输出：仓库汇总 ----
Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "—— 仓库 ——"
Write-Host "仓库总文件数（代码 + 文档）：$repoTotalFiles"
Write-Host "仓库有效总行数（代码行 + 文档非空行）：$repoTotalLines"
Write-Host "仓库原始总行数：$repoRawLines"
Write-Host "仓库总字符数：$repoTotalChars"
Write-Host "======================================" -ForegroundColor Cyan

# ---- 导出 Markdown 报告（正文已在两遍法中生成）----
$reportPath = 'doc\development\code-stats.md'
$reportFileText = $report.Text + "`r`n"
[System.IO.File]::WriteAllText((Join-Path $root $reportPath), $reportFileText, (New-Object System.Text.UTF8Encoding($true)))
Write-Host "`n✅ 报告已保存到：$reportPath"


# 仅在交互式终端等待回车；被管道/自动化调用时直接结束（避免 NonInteractive 报错）
if (-not $NoPause) {
    try { Read-Host "`n统计完成，按回车退出" } catch { }
}