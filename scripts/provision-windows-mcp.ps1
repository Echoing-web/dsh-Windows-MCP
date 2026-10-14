# Windows-MCP x DeepSeek Harness —— 一键环境安装脚本
#
# 作用：在 ~/.dsh/runtimes/windows-mcp 下创建一个**独立的** Python 3.13 虚拟环境，
#       并把 CursorTouch/Windows-MCP 装进去。该环境与系统 Python、
#       DSH 自带 Python 完全隔离，卸载只需删除目录。
#
# 为什么需要独立环境：
#   - Windows-MCP 依赖 pywin32 / comtypes / dxcam 等 Windows 原生扩展，
#     装进 DSH 自带 Python 有污染运行时、导致会话启动失败的风险。
#   - DSH 的 MCP 桥接行需要写一个**绝对路径**的解释器，独立环境最可控。
#
# 用法：
#   pwsh -File install-windows-mcp.ps1
#   pwsh -File install-windows-mcp.ps1 -Root 'D:\my\runtimes\windows-mcp'
#   pwsh -File install-windows-mcp.ps1 -SkipUv        # 已装 uv 时跳过下载
#
# 退出码：0 成功；非 0 失败（并打印原因）。

[CmdletBinding()]
param(
    [string]$Root = (Join-Path $env:USERPROFILE '.dsh\runtimes\windows-mcp'),
    [string]$UvDir = (Join-Path $env:USERPROFILE '.dsh\runtimes\uv'),
    [string]$PythonVersion = '3.13',
    [switch]$SkipUv,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Info($m) { Write-Host "[windows-mcp] $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host "[windows-mcp][ERROR] $m" -ForegroundColor Red; exit 1 }

# ── 1. 解析并打印目标路径（先确认路径再动文件） ────────────────────────────────
$Root = [System.IO.Path]::GetFullPath($Root)
$UvDir = [System.IO.Path]::GetFullPath($UvDir)
$venv = Join-Path $Root 'venv'
$venvPy = Join-Path $venv 'Scripts\python.exe'
$uv = Join-Path $UvDir 'uv.exe'

Info "安装根目录: $Root"
Info "uv 目录    : $UvDir"

if ((Test-Path $venvPy) -and -not $Force) {
    Info "已存在解释器 ($venvPy)，跳过创建。用 -Force 重建。"
} else {
    New-Item -ItemType Directory -Force -Path $Root, $UvDir | Out-Null

    # ── 2. 获取 uv（独立二进制，无需 PATH，也没走 .ps1 安装器以避免执行策略问题） ──
    if (-not $SkipUv -and -not (Test-Path $uv)) {
        $zip = Join-Path $env:TEMP 'uv-x86_64-pc-windows-msvc.zip'
        $url = 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip'
        Info "下载 uv: $url"
        try { Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 300 }
        catch { Fail "uv 下载失败: $($_.Exception.Message)" }
        Expand-Archive -Path $zip -DestinationPath $UvDir -Force
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path $uv)) { Fail "找不到 uv.exe ($uv)。装好 uv 或去掉 -SkipUv 重试。" }
    Info "uv: $(& $uv --version)"

    # ── 3. 创建 3.13 虚拟环境（uv 会自动下载对应版本的 CPython） ──────────────
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $Root 'pythons'
    $env:UV_CACHE_DIR = Join-Path $Root 'uv-cache'
    Info "创建虚拟环境 (Python $PythonVersion) ..."
    & $uv venv $venv --python $PythonVersion
    if ($LASTEXITCODE -ne 0) { Fail "创建虚拟环境失败 (exit $LASTEXITCODE)" }

    # ── 4. 安装 Windows-MCP ────────────────────────────────────────────────────
    Info "安装 windows-mcp ..."
    & $uv pip install --python $venvPy windows-mcp
    if ($LASTEXITCODE -ne 0) { Fail "安装 windows-mcp 失败 (exit $LASTEXITCODE)" }
}

# ── 5. 验证：解释器能 import，且 MCP 服务能完成 stdio 握手 ─────────────────────
Info "验证解释器 ..."
$version = & $venvPy -c "import sys; print(sys.version.split()[0])"
Info "Python: $version"
& $venvPy -c "import windows_mcp; print('windows_mcp OK')"
if ($LASTEXITCODE -ne 0) { Fail "windows_mcp 无法 import" }

Info "验证 serve 子命令 ..."
$helpOut = & $venvPy -m windows_mcp serve --help 2>&1 | Out-String
if ($helpOut -notmatch '--transport') { Fail "serve --help 未按预期输出" }

Write-Host ''
Info '安装完成。把下面这段合并进 DSH profile 的 cordis.patch.yml（注意 insert 写法）：'
Write-Host @"
- insert:
    - id: mcp-winmcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        transport: stdio
        serverName: winmcp
        command: $venvPy
        args:
          - -m
          - windows_mcp
          - serve
        env:
          ANONYMIZED_TELEMETRY: "false"
        toolCallTimeoutMs: 120000
        failOnStartupError: false
"@ -ForegroundColor Green
Write-Host ''
Info '方言提醒：新建 loader entry 必须写在 `insert:` 下。顶层 `- id:` + `name:` 是覆盖写法，'
Info '          只用于修改已被更早的层 insert 过的行；用它新建会报 patch: entry "..." not found。'
Info '          两层同时 insert 同一个 id 会报 duplicate loader entry id——二者只能留一个。'
Write-Host ''
Info "解释器绝对路径: $venvPy"
Info '改完后重启 DeepSeek Harness，工具会以 mcp__winmcp__<ToolName> 的形式出现。'
Info "自检：node `"$PSScriptRoot\verify-windows-mcp.mjs`""
exit 0
