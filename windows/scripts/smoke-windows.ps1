param(
    [string]$AppPath = (Join-Path $PSScriptRoot '..\target\release\coucou.exe'),
    [string]$HookPath = (Join-Path $PSScriptRoot '..\target\release\coucou-hook.exe')
)
$ErrorActionPreference = 'Stop'
if (Get-Process coucou -ErrorAction SilentlyContinue) { throw 'Close the running Coucou app before this isolated smoke test.' }
$taskSmokeRoot = Join-Path $PSScriptRoot ("..\target\smoke-" + [guid]::NewGuid().ToString('N'))
foreach ($folder in @('config\Coucou','data','profile','codex\sessions')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $taskSmokeRoot $folder) | Out-Null
}
$taskSmokeRoot = (Resolve-Path -LiteralPath $taskSmokeRoot).Path
$testSettings = @{
    soundEnabled=$false; soundVolume=0; autoCloseInterval=120; absenceInterval=180
    activeIntegrations=@(); screen='primary'; autostart=$false; hooksInstalled=$false
    model='claude-sonnet-4-6'; showIntegrationPills=$false; chatProvider='codex'
    clickupWorkspace=''; clickupList=''; quietUntil=0; notificationPreferences=@{}; reducedMotion=$true
} | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $taskSmokeRoot 'config\Coucou\settings.json'),$testSettings,[Text.UTF8Encoding]::new($false))

function New-TestProcessInfo([string]$Path,[string]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName=(Resolve-Path -LiteralPath $Path).Path
    $info.Arguments=$Arguments
    $info.UseShellExecute=$false
    $info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
    $info.EnvironmentVariables['APPDATA']=Join-Path $taskSmokeRoot 'config'
    $info.EnvironmentVariables['LOCALAPPDATA']=Join-Path $taskSmokeRoot 'data'
    $info.EnvironmentVariables['USERPROFILE']=Join-Path $taskSmokeRoot 'profile'
    $info.EnvironmentVariables['CODEX_HOME']=Join-Path $taskSmokeRoot 'codex'
    return $info
}
function Test-TerminalFallback([string]$Reason) {
    $info=New-TestProcessInfo $HookPath 'PermissionRequest'
    $info.RedirectStandardInput=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $timer=[Diagnostics.Stopwatch]::StartNew()
    $relay=[Diagnostics.Process]::Start($info)
    try {
        $relay.StandardInput.WriteLine((@{hook_event_name='PermissionRequest';session_id='smoke-session';cwd=$taskSmokeRoot;tool_name='Read';tool_use_id='smoke-read';tool_input=@{file_path='test.txt'}} | ConvertTo-Json -Compress))
        $relay.StandardInput.Close()
        if (!$relay.WaitForExit(3000)) { $relay.Kill();$relay.WaitForExit();throw "$Reason did not return promptly" }
        $output=$relay.StandardOutput.ReadToEnd()
        if ($relay.ExitCode -ne 0 -or $output.Trim() -or $timer.Elapsed.TotalSeconds -gt 2) { throw "$Reason failed: exit=$($relay.ExitCode), elapsed=$($timer.Elapsed.TotalSeconds)s" }
        "$Reason returned to the terminal in $([math]::Round($timer.Elapsed.TotalMilliseconds)) ms without a decision."
    } finally { $relay.Dispose() }
}

$taskApp=[Diagnostics.Process]::Start((New-TestProcessInfo $AppPath '--show'))
try {
    Start-Sleep -Seconds 8
    $taskApp.Refresh()
    if ($taskApp.HasExited) { throw "Bundled app exited: $($taskApp.ExitCode)" }
    $logPath=Join-Path $taskSmokeRoot 'data\Coucou\coucou.log'
    if (!(Test-Path -LiteralPath $logPath)) { throw 'The app did not complete startup.' }
    'Bundled app startup passed.'
    Test-TerminalFallback 'Quiet mode'
    $second=[Diagnostics.Process]::Start((New-TestProcessInfo $AppPath '--show'))
    try {
        if (!$second.WaitForExit(5000)) { $second.Kill();$second.WaitForExit();throw 'Second activation did not exit.' }
        if ($second.ExitCode -ne 0) { throw 'Second activation failed.' }
        $taskApp.Refresh();if($taskApp.HasExited){throw 'Activation stopped the original app.'}
        'Second --show activation passed.'
    } finally { $second.Dispose() }
    Get-Content -LiteralPath $logPath
} finally {
    if (!$taskApp.HasExited) { $taskApp.Kill();$taskApp.WaitForExit() }
    $taskApp.Dispose()
}
Test-TerminalFallback 'Closed app'
"Isolated test files: $taskSmokeRoot"
