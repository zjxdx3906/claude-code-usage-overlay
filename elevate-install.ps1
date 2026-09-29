# 以管理员身份运行：把 managed-settings.json 装到 Claude Code 认的位置
# 结果会写进同目录的 install-result.txt，方便事后核对到底成没成
$ErrorActionPreference = 'Stop'
$log = Join-Path $PSScriptRoot 'install-result.txt'

try {
    $target = 'C:\Program Files\ClaudeCode'
    $source = Join-Path $PSScriptRoot 'managed-settings.json'

    if (-not (Test-Path $source)) { throw "找不到源文件 $source" }

    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Copy-Item -Force $source (Join-Path $target 'managed-settings.json')

    $ok = Test-Path (Join-Path $target 'managed-settings.json')
    if (-not $ok) { throw '复制后文件不存在' }

    "OK`n时间: $(Get-Date -Format o)`n目标: $target\managed-settings.json`n大小: $((Get-Item (Join-Path $target 'managed-settings.json')).Length) 字节" |
        Out-File -Encoding utf8 $log
}
catch {
    "FAIL`n时间: $(Get-Date -Format o)`n原因: $($_.Exception.Message)" |
        Out-File -Encoding utf8 $log
}

# 提权窗口停留 4 秒，方便你看到结果
Start-Sleep -Seconds 4
