# 把当前分支发到自托管服务器（步步解 · 101.33.230.189）
#
#   .\scripts\deploy-server.ps1                # 发当前 HEAD（先自动 fetch，落后就快进）
#   .\scripts\deploy-server.ps1 -Pull          # 先 git pull --ff-only origin main 再发
#   .\scripts\deploy-server.ps1 -Force         # 服务器已是这个版本也重发
#   .\scripts\deploy-server.ps1 -DryRun        # 只打包、打印将要执行的命令，不连服务器
#   .\scripts\deploy-server.ps1 -SshKey C:\Users\me\.ssh\bubujie_deploy   # 用密钥，不输密码
#
# 会问两次服务器密码（scp 一次、ssh 一次）；配了 -SshKey 或 ssh-agent 就完全不问。
#
# 为什么是"打包上传"而不是服务器上 git pull：那台机器没有仓库、也没有 GitHub 凭据，
# 而且线上只该跑"你验过的这一棵树"，不该现场解析。

param(
  [string]$ServerHost = '101.33.230.189',
  [string]$User = 'ubuntu',
  [string]$AppDir = '/opt/bubujie',
  [string]$SshKey = '',
  [switch]$Pull,
  [switch]$Force,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "✗ $msg" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 1. 代码状态
Step '1. 代码状态'
if ($Pull) {
  git fetch --quiet origin
  if ($LASTEXITCODE -ne 0) { Fail 'git fetch 失败' }
  $behind = (git rev-list --count 'HEAD..@{u}').Trim()
  if ($behind -ne '0') {
    Write-Host "落后远端 $behind 个提交，快进中…"
    git pull --ff-only
    if ($LASTEXITCODE -ne 0) { Fail 'git pull --ff-only 失败（本地有分叉，先手工处理）' }
  } else {
    Write-Host '已经是最新的 origin 版本'
  }
}

$rev = (git rev-parse --short HEAD).Trim()
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
$dirty = git status --porcelain | Where-Object { $_ -notmatch '^\?\?' }
Write-Host "分支 $branch · 版本 $rev"
if ($dirty) {
  Write-Host "⚠ 有未提交改动，它们也会被打包发上去：" -ForegroundColor Yellow
  $dirty | Select-Object -First 8 | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
}

# ---------------------------------------------------------------- 2. 连接参数
# 默认用仓库里的部署密钥（.deploy-key/，已授权到服务器、已收紧 ACL 且被 gitignore）；
# 没有这把 key 就退回交互式输密码 —— 两种都能跑，脚本不挑。
if (-not $SshKey) {
  $defaultKey = Join-Path $root '.deploy-key\bubujie_deploy'
  if (Test-Path $defaultKey) { $SshKey = $defaultKey }
}
$sshOpts = @('-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=15')
if ($SshKey) {
  $sshOpts += @('-i', $SshKey, '-o', 'IdentitiesOnly=yes')
  Write-Host "用密钥：$SshKey"
} else {
  Write-Host '没找到部署密钥，会提示输入服务器密码（scp 一次、ssh 一次）' -ForegroundColor Yellow
}
$target = "$User@$ServerHost"

# ---------------------------------------------------------------- 3. 远端是不是已经这个版本
# 先判版本再打包：包有 40 MB，白打一次不值。
Step '3. 远端版本'
$remoteRev = (& ssh @sshOpts $target "cat $AppDir/.deployed-rev 2>/dev/null || echo none" 2>$null | Select-Object -Last 1)
$remoteRev = if ($remoteRev) { $remoteRev.Trim() } else { 'none' }
Write-Host "远端：$remoteRev"
if ($remoteRev -eq $rev -and -not $Force) {
  Write-Host "`n✓ 服务器已经是 $rev，不用发（要强制重发加 -Force）" -ForegroundColor Green
  exit 0
}

# ---------------------------------------------------------------- 4. 打包
Step '4. 打包'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$tar = Join-Path $env:TEMP "bubujie-app-$stamp.tar.gz"
$paths = @('package.json', 'server', 'src', 'public', 'scripts/smoke-usage.mjs')
tar -czf $tar @paths
if ($LASTEXITCODE -ne 0) { Fail '打包失败' }
$mb = [math]::Round((Get-Item $tar).Length / 1MB, 1)
Write-Host "包：$tar（$mb MB）"

$remoteTar = "/tmp/bubujie-app-$stamp.tar.gz"

$remoteCmd = @(
  "set -e"
  "sudo mkdir -p $AppDir"
  "sudo tar -xzf $remoteTar -C $AppDir"
  "sudo chown -R ${User}:${User} $AppDir"
  "echo '$rev' | sudo tee $AppDir/.deployed-rev >/dev/null"
  "sudo systemctl restart bubujie"
  "sleep 3"
  "systemctl is-active bubujie"
  "curl -fsS --max-time 8 http://127.0.0.1:5173/api/health | head -c 80"
  "echo"
  "rm -f $remoteTar"
) -join ' && '

if ($DryRun) {
  Step 'DryRun：以下命令不会执行'
  Write-Host "scp $($sshOpts -join ' ') `"$tar`" ${target}:$remoteTar"
  Write-Host "ssh $($sshOpts -join ' ') $target `"$remoteCmd`""
  Remove-Item $tar -Force -ErrorAction SilentlyContinue
  exit 0
}

# ---------------------------------------------------------------- 5. 上传 + 重启
Step '5. 上传'
& scp @sshOpts $tar "${target}:$remoteTar"
if ($LASTEXITCODE -ne 0) { Fail 'scp 失败（密码/网络/密钥问题）' }
Remove-Item $tar -Force -ErrorAction SilentlyContinue

Step '6. 解包 + 重启 + 自检'
& ssh @sshOpts $target $remoteCmd
if ($LASTEXITCODE -ne 0) { Fail '远端部署命令失败（看上面的输出）' }

# ---------------------------------------------------------------- 7. 公网自检
Step '7. 公网自检'
$ok = $false
for ($i = 1; $i -le 5; $i += 1) {
  try {
    $h = Invoke-RestMethod -Uri "http://$ServerHost/api/health" -TimeoutSec 8
    if ($h.ok) { $ok = $true; Write-Host "health ok · engine=$($h.engine) · model=$($h.model)"; break }
  } catch { Start-Sleep -Seconds 2 }
}
if (-not $ok) { Fail "公网 /api/health 打不通（服务可能起来了，但 80 端口/安全组有问题）" }

Write-Host "`n✓ 已上线：$rev（$branch）" -ForegroundColor Green
Write-Host "  学生 http://$ServerHost/pilot.html"
Write-Host "  看板 http://$ServerHost/admin.html"
