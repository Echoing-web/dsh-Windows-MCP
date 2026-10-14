# dsh-windows-mcp x DeepSeek Harness —— 插件安装 / 配置装配脚本
#
# 与 scripts/provision-windows-mcp.ps1 的分工：
#   provision-windows-mcp.ps1  创建独立 Python 环境并安装 windows-mcp（只动 venv）
#   install-windows-mcp.ps1    检查环境 + 装配 DSH 侧配置（本文件，只动 DSH 配置）
#
# 本脚本的三条硬规则：
#   1. 幂等：profile 的 cordis.patch.yml 里只要已经声明过 id `mcp-winmcp`，就跳过，
#      绝不重复插入。同一个 id 被两层 insert 会让 Loader 直接报
#      `duplicate loader entry id: mcp-winmcp` 起不来。
#   2. 只写“覆盖行”，不写 `insert:`。bundle 的 cordis.patch.yml 已经 insert 了
#      mcp-winmcp；profile 层能做的且安全的只有按 id 覆盖（改 command 路径等）。
#   3. 除非显式给 -ApplyOverride，否则不写任何文件，只打印建议片段。
#
# 用法：
#   pwsh -File install-windows-mcp.ps1                       # 只检查 + 打印建议
#   pwsh -File install-windows-mcp.ps1 -ApplyOverride        # 需要时追加覆盖行（先备份）
#   pwsh -File install-windows-mcp.ps1 -ProfileName web -SkipVerify
#
# 退出码：0 成功（含“无需改动”）；1 环境不可用；2 参数/路径错误。

[CmdletBinding()]
param(
    [string]$ProfileName = 'desktop',
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
    [string]$PluginPath = (Split-Path -Parent $PSScriptRoot),
    [string]$RowId = 'mcp-winmcp',
    [string]$ServerName = 'winmcp',
    [switch]$ApplyOverride,
    [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "[install-windows-mcp] $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "[install-windows-mcp] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[install-windows-mcp][WARN] $m" -ForegroundColor Yellow }
function Fail($m, $code = 1) { Write-Host "[install-windows-mcp][ERROR] $m" -ForegroundColor Red; exit $code }

# ── 1. 解析路径（先确认路径，再考虑动文件） ────────────────────────────────────
$DshHome = [System.IO.Path]::GetFullPath($DshHome)
$ProfileDir = Join-Path $DshHome "profiles\$ProfileName"
$ProfilePatch = Join-Path $ProfileDir 'cordis.patch.yml'
$ProfilePackage = Join-Path $ProfileDir 'package.json'
$VenvPython = Join-Path $DshHome 'runtimes\windows-mcp\venv\Scripts\python.exe'
$ProvisionScript = Join-Path $PluginPath 'scripts\provision-windows-mcp.ps1'

Info "DSH_HOME    : $DshHome"
Info "profile     : $ProfileDir"
Info "插件目录    : $PluginPath"
Info "解释器      : $VenvPython"

if (-not (Test-Path $ProfileDir)) { Fail "profile 目录不存在：$ProfileDir" 2 }
if (-not (Test-Path $ProfilePackage)) { Fail "profile package.json 不存在：$ProfilePackage" 2 }

# ── 2. 解释器与环境验证 ───────────────────────────────────────────────────────
if (-not (Test-Path $VenvPython)) {
    $provisionHint = @"
找不到托管解释器：$VenvPython
先运行环境安装脚本：
  pwsh -File "$ProvisionScript"
或者把你的 Python 3.13+ 路径写进 profile 的 cordis.patch.yml（-ApplyOverride 可自动追加覆盖行）。
"@
    Fail $provisionHint 1
}
Ok "解释器存在"

if (-not $SkipVerify) {
    & $VenvPython -c "import windows_mcp, sys; print('import OK', sys.version.split()[0])"
    if ($LASTEXITCODE -ne 0) { Fail "该解释器无法 import windows_mcp（先跑 provision 脚本或换解释器）" 1 }
    $helpOut = & $VenvPython -m windows_mcp serve --help 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $helpOut -notmatch '--transport') { Fail "windows_mcp serve --help 输出不符合预期" 1 }
    Ok "windows_mcp 可 import，serve 子命令存在"
} else {
    Warn "已跳过 import / serve 验证（-SkipVerify）"
}

# ── 3. 检测 profile 是否已声明该行（幂等核心） ────────────────────────────────
$patchText = if (Test-Path $ProfilePatch) { Get-Content -Raw -LiteralPath $ProfilePatch } else { '' }
$declarationPattern = "(?m)^\s*-?\s*id:\s*['""]?" + [Regex]::Escape($RowId) + "['""]?\s*$"
$declarations = [Regex]::Matches($patchText, $declarationPattern)
$declaredCount = $declarations.Count

# bundle 是否已注册（注册了才由 bundle 的 cordis.patch.yml 负责 insert）
$packageText = Get-Content -Raw -LiteralPath $ProfilePackage
$bundleRegistered = $packageText -match '"dsh-windows-mcp"'

# ── 4. 需要打印 / 追加的覆盖片段 ──────────────────────────────────────────────
$overrideFragment = @"
- id: $RowId
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    transport: stdio
    serverName: $ServerName
    command: '$VenvPython'
    args:
      - -m
      - windows_mcp
      - serve
    toolCallTimeoutMs: 120000
    failOnStartupError: false
"@

$insertFragment = @"
- insert:
    - id: $RowId
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: $ServerName
        command: '$VenvPython'
        args:
          - -m
          - windows_mcp
          - serve
        toolCallTimeoutMs: 120000
        failOnStartupError: false
"@

Write-Host ''
if ($declaredCount -gt 0) {
    Ok "profile 已声明 id '$RowId'（$declaredCount 处），跳过写入 —— 不重复、不覆盖用户已有配置。"
    Info "查看当前声明："
    foreach ($m in $declarations) {
        $line = ($patchText.Substring(0, $m.Index) -split "`n").Count
        Info "  $ProfilePatch : 第 $line 行"
    }
    Write-Host ''
    Info "如需把行切到本机的解释器路径，手工在 profile 的 cordis.patch.yml 里按 id 覆盖："
    Write-Host $overrideFragment -ForegroundColor Green
    exit 0
}

if ($bundleRegistered) {
    Ok "profile 已注册 bundle 'dsh-windows-mcp'，桥接行由 bundle 的 cordis.patch.yml 用 insert 提供。"
    Info "无需在 profile 里再加 insert（重复 insert 会报 duplicate loader entry id）。"
    if (-not $ApplyOverride) {
        Write-Host ''
        Info "仅当你需要覆盖 command 路径时，把下面这段加进 profile 的 cordis.patch.yml："
        Write-Host $overrideFragment -ForegroundColor Green
        Info "（加 -ApplyOverride 可自动追加，追加前会备份。）"
        exit 0
    }
} else {
    Warn "profile 的 package.json 里没有发现 'dsh-windows-mcp'（bundle 未注册）。"
    Info "先把它作为 bundle 安装，例如："
    Info "  dsh plugin --profile $ProfileName add `"$PluginPath`""
    Info "或者手工把 `"dsh-windows-mcp`" 加进 profile package.json 的 dsh.profile.bundles。"
    Info "bundle 安装后，桥接行由 bundle 的 cordis.patch.yml 负责 insert，profile 层不需要再写。"
    if (-not $ApplyOverride) {
        Write-Host ''
        Info "如果你的部署确实不走 bundle（只拷目录），才需要手工把下面这段 insert 加进 profile 的 cordis.patch.yml："
        Write-Host $insertFragment -ForegroundColor Yellow
        Warn "注意：同一个 id 只能被一个层 insert！此时 bundle 的 cordis.patch.yml 必须不被加载。"
        exit 0
    }
}

# ── 5. 追加覆盖行（先备份，只追加，不改动已有内容） ───────────────────────────
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$ProfilePatch.bak-$timestamp"
Copy-Item -LiteralPath $ProfilePatch -Destination $backup -Force
Info "已备份：$backup"

$stamp = "# dsh-windows-mcp: 覆盖 $RowId 的 command 路径（install-windows-mcp.ps1 @ $timestamp）"
Add-Content -LiteralPath $ProfilePatch -Value "`n$stamp`n$overrideFragment" -Encoding utf8
Ok "已追加覆盖行到 $ProfilePatch"

Write-Host ''
Info "下一步："
Info "  1) 重启 DeepSeek Harness（或在已开启 profile patch 热重载的环境里等它生效）"
Info "  2) 用 /winmcp 查看状态，/winmcp probe 做一次真实握手"
Info "  3) 工具应出现在模型工具表里，名字形如 mcp__${ServerName}__Snapshot"
exit 0
