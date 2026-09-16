# 安全部署 cohub-cordis preset 到用户 preset 根（幂等、内容级覆盖，不产生嵌套）
# 用法: pwsh -File scripts/deploy-preset.ps1 [-PresetName cohub-cordis]
param(
  [string]$PresetName = 'cohub-cordis'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$src = Join-Path $repo "presets\$PresetName"
$dst = Join-Path $env:USERPROFILE ".dsh\.agent-presets\$PresetName"

if (-not (Test-Path $src)) { throw "源 preset 不存在: $src" }

# 先清掉可能存在的旧目录/嵌套残留，再整目录复制
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
Copy-Item $src $dst -Recurse -Force

# 防御：若出现同名嵌套目录（Copy-Item 的经典陷阱），删除它
$nested = Join-Path $dst $PresetName
if (Test-Path $nested) {
  Remove-Item $nested -Recurse -Force
  Write-Warning "检测并移除了嵌套目录: $nested"
}

Write-Host "已部署 $PresetName -> $dst"
Get-ChildItem $dst -Recurse -File |
  ForEach-Object { "  " + $_.FullName.Replace("$dst\", '') + "  (" + $_.Length + "B)" }
