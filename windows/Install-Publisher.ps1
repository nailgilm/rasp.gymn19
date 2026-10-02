[CmdletBinding()]
param(
    [string]$PackageRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$PrivateKey = (Join-Path $PSScriptRoot 'schedule_publisher_ed25519')
)

$ErrorActionPreference = 'Stop'
$target = 'C:\ProgramData\Gymn19Schedule'
New-Item -ItemType Directory -Path $target -Force | Out-Null
$scriptSource = Join-Path $PSScriptRoot 'Publish-Schedule.ps1'
$scriptTarget = Join-Path $target 'Publish-Schedule.ps1'
# Windows PowerShell 5.1 требует BOM для корректного чтения русских строк.
[IO.File]::WriteAllText($scriptTarget, [IO.File]::ReadAllText($scriptSource), [Text.UTF8Encoding]::new($true))
Copy-Item $PrivateKey (Join-Path $target 'schedule_publisher_ed25519') -Force

$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl = Get-Acl (Join-Path $target 'schedule_publisher_ed25519')
$acl.SetAccessRuleProtection($true, $false)
$rule = [Security.AccessControl.FileSystemAccessRule]::new($user, 'Read', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl (Join-Path $target 'schedule_publisher_ed25519') $acl

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\ProgramData\Gymn19Schedule\Publish-Schedule.ps1"'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Gymn19 Schedule Publisher' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Опубликовать расписание.lnk'))
$shortcut.TargetPath = 'powershell.exe'
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\Gymn19Schedule\Publish-Schedule.ps1" -Force'
$shortcut.WorkingDirectory = $target
$shortcut.Description = 'Обновить расписание на локальном сайте'
$shortcut.Save()

Write-Host 'Автопубликация установлена. Проверка выполняется каждые 5 минут.'
