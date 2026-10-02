[CmdletBinding()]
param(
    [string]$Source = 'S:\Расписание.rtt',
    [string]$RectorExe = 'C:\Program Files (x86)\Rector\Rector.exe',
    [string]$Server = '172.16.13.35',
    [string]$ServerUser = 'schedule-publisher',
    [string]$IdentityFile = 'C:\ProgramData\Gymn19Schedule\schedule_publisher_ed25519',
    [string]$StateRoot = 'C:\ProgramData\Gymn19Schedule',
    [switch]$Force,
    [switch]$NoUpload
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$logFile = Join-Path $StateRoot 'publish.log'
$stateFile = Join-Path $StateRoot 'state.json'
$workRoot = Join-Path $StateRoot 'work'

function Write-Log([string]$Message) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Message"
    Write-Output $line
    [IO.File]::AppendAllText($logFile, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

function Get-WindowTextValue([IntPtr]$Handle) {
    $text = [Text.StringBuilder]::new(512)
    [void][ScheduleNative]::GetWindowText($Handle, $text, $text.Capacity)
    $text.ToString()
}

function Get-WindowClassValue([IntPtr]$Handle) {
    $text = [Text.StringBuilder]::new(256)
    [void][ScheduleNative]::GetClassName($Handle, $text, $text.Capacity)
    $text.ToString()
}

function Get-TopWindows([int]$ProcessId) {
    $result = [Collections.Generic.List[object]]::new()
    [ScheduleNative]::EnumWindows({
        param($handle, $param)
        [uint32]$windowProcess = 0
        [void][ScheduleNative]::GetWindowThreadProcessId($handle, [ref]$windowProcess)
        if ($windowProcess -eq $ProcessId) {
            $result.Add([pscustomobject]@{
                Handle = $handle
                Class = Get-WindowClassValue $handle
                Text = Get-WindowTextValue $handle
            })
        }
        return $true
    }, [IntPtr]::Zero) | Out-Null
    $result
}

function Wait-Window([int]$ProcessId, [string]$Class = '', [string]$Title = '', [int]$TimeoutSeconds = 20) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $match = Get-TopWindows $ProcessId | Where-Object {
            (!$Class -or $_.Class -eq $Class) -and (!$Title -or $_.Text -like "*$Title*")
        } | Select-Object -First 1
        if ($match) { return $match }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw "Окно $Class '$Title' не появилось за $TimeoutSeconds секунд"
}

function Find-UiaElement([int]$ProcessId, [string]$Name) {
    $desktop = [Windows.Automation.AutomationElement]::RootElement
    $processCondition = [Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId)
    $nameCondition = [Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::NameProperty, $Name)
    $condition = [Windows.Automation.AndCondition]::new($processCondition, $nameCondition)
    $desktop.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
}

function Invoke-UiaButton([int]$ProcessId, [string]$Name, [int]$TimeoutSeconds = 15) {
    $desktop = [Windows.Automation.AutomationElement]::RootElement
    $processCondition = [Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId)
    $nameCondition = [Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::NameProperty, $Name)
    $condition = [Windows.Automation.AndCondition]::new($processCondition, $nameCondition)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $button = $desktop.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
        if (!$button) { Start-Sleep -Milliseconds 250 }
    } while (!$button -and (Get-Date) -lt $deadline)
    if (!$button) { throw "Кнопка '$Name' не найдена" }
    $pattern = $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    Start-Sleep -Milliseconds 650
}

function Select-UiaItem([int]$ProcessId, [string]$Name, [int]$TimeoutSeconds = 15) {
    $desktop = [Windows.Automation.AutomationElement]::RootElement
    $processCondition = [Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId)
    $nameCondition = [Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::NameProperty, $Name)
    $condition = [Windows.Automation.AndCondition]::new($processCondition, $nameCondition)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $item = $desktop.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
        if (!$item) { Start-Sleep -Milliseconds 250 }
    } while (!$item -and (Get-Date) -lt $deadline)
    if (!$item) { throw "Раздел '$Name' не найден" }
    $item.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select()
    Start-Sleep -Milliseconds 650
}

function Click-WindowPoint([IntPtr]$Window, [int]$OffsetX, [int]$OffsetY) {
    $rect = [ScheduleNative+RECT]::new()
    if (![ScheduleNative]::GetWindowRect($Window, [ref]$rect)) { throw 'Не удалось определить положение окна' }
    [void][ScheduleNative]::SetForegroundWindow($Window)
    Start-Sleep -Milliseconds 300
    [void][ScheduleNative]::SetCursorPos($rect.Left + $OffsetX, $rect.Top + $OffsetY)
    [ScheduleNative]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
    [ScheduleNative]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
}

function Save-DialogFile([IntPtr]$Dialog, [string]$Path) {
    $children = [Collections.Generic.List[object]]::new()
    [ScheduleNative]::EnumChildWindows($Dialog, {
        param($handle, $param)
        $children.Add([pscustomobject]@{
            Handle = $handle
            Class = Get-WindowClassValue $handle
            Text = Get-WindowTextValue $handle
        })
        return $true
    }, [IntPtr]::Zero) | Out-Null
    $edit = $children | Where-Object Class -eq 'Edit' | Select-Object -First 1
    $save = $children | Where-Object { $_.Class -eq 'Button' -and $_.Text -like '*хранить*' } | Select-Object -First 1
    if (!$edit -or !$save) { throw 'Не удалось управлять окном сохранения' }
    [void][ScheduleNative]::SendMessageText($edit.Handle, 0x000C, [IntPtr]::Zero, $Path)
    Start-Sleep -Milliseconds 250
    [void][ScheduleNative]::SendMessage($save.Handle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
}

function Export-RectorHtml([string]$Snapshot, [string]$Destination, [string]$ViewName, [int]$ViewTabX) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $process = Start-Process -FilePath $RectorExe -ArgumentList ('"' + $Snapshot + '"') -PassThru
    try {
        $main = Wait-Window $process.Id 'TRector3Form' '' 25
        Select-UiaItem $process.Id 'Расписание'
        Click-WindowPoint $main.Handle $ViewTabX 85
        Start-Sleep -Milliseconds 500
        # Кнопка печати в штатном окне «Ректор» 800x600.
        Click-WindowPoint $main.Handle 291 116
        [void](Wait-Window $process.Id '' 'Мастер печати' 15)
        $printButton = $null
        foreach ($step in 1..7) {
            $printButton = Find-UiaElement $process.Id 'Печать...'
            if ($printButton) { break }
            Invoke-UiaButton $process.Id 'Вперед'
        }
        if (!$printButton) { throw "Не найден последний шаг экспорта '$ViewName'" }
        Invoke-UiaButton $process.Id 'Печать...'
        $saveDialog = Wait-Window $process.Id '#32770' 'Сохранение' 20
        Save-DialogFile $saveDialog.Handle (Join-Path $Destination 'index.htm')

        $deadline = (Get-Date).AddSeconds(35)
        do {
            Start-Sleep -Milliseconds 500
            $indexReady = Test-Path (Join-Path $Destination 'index.html')
            $pageCount = @(Get-ChildItem $Destination -Filter 'index*.html' -File -ErrorAction SilentlyContinue).Count
        } while ((!$indexReady -or $pageCount -lt 1) -and (Get-Date) -lt $deadline)
        if (!$indexReady -or $pageCount -lt 1) { throw "«Ректор» не создал HTML-экспорт '$ViewName'" }
        Start-Sleep -Seconds 2
    }
    finally {
        if (!$process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    }
}

New-Item -ItemType Directory -Path $StateRoot, $workRoot -Force | Out-Null
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
if (!('ScheduleNative' -as [type])) {
    Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ScheduleNative {
    public delegate bool EnumCallback(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback c, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumCallback c, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Auto, EntryPoint="SendMessage")] public static extern IntPtr SendMessageText(IntPtr h, uint m, IntPtr w, string l);
    public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
}

try {
    if (!(Test-Path -LiteralPath $Source)) { throw "Файл расписания не найден: $Source" }
    if (!(Test-Path -LiteralPath $RectorExe)) { throw "Программа «Ректор» не найдена: $RectorExe" }
    $sourceItem = Get-Item -LiteralPath $Source
    $sourceHash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.ToLowerInvariant()
    if (!$Force -and (Test-Path $stateFile)) {
        $previous = Get-Content $stateFile -Raw | ConvertFrom-Json
        if ($previous.sha256 -eq $sourceHash) {
            Write-Log 'Изменений нет, публикация не требуется.'
            exit 0
        }
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $runRoot = Join-Path $workRoot $stamp
    $exportRoot = Join-Path $runRoot 'data'
    New-Item -ItemType Directory -Path $exportRoot -Force | Out-Null
    $snapshot = Join-Path $runRoot 'schedule.rtt'
    Copy-Item -LiteralPath $Source -Destination $snapshot -Force
    Write-Log "Обнаружено новое расписание ($($sourceItem.LastWriteTime)). Начат экспорт."
    Export-RectorHtml $snapshot (Join-Path $exportRoot 'classes') 'Классы' 36
    Export-RectorHtml $snapshot (Join-Path $exportRoot 'teachers') 'Учителя' 91
    Export-RectorHtml $snapshot (Join-Path $exportRoot 'rooms') 'Кабинеты' 145
    # Совместимость с первой версией сайта во время атомарного обновления.
    Copy-Item (Join-Path $exportRoot 'classes\index*.html') $exportRoot -Force

    [ordered]@{
        source = $sourceItem.Name
        sourceModified = $sourceItem.LastWriteTime.ToString('o')
        published = (Get-Date).ToString('o')
        sha256 = $sourceHash
    } | ConvertTo-Json | Set-Content (Join-Path $exportRoot 'version.json') -Encoding utf8

    if (!$NoUpload) {
        if (!(Test-Path $IdentityFile)) { throw "Ключ публикации не найден: $IdentityFile" }
        $archive = Join-Path $runRoot 'schedule-data.tar'
        & tar.exe -cf $archive -C $exportRoot .
        if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать архив публикации' }
        $remoteArchive = "/srv/schedule-web/uploads/$stamp.tar"
        & scp.exe -q -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i $IdentityFile $archive "${ServerUser}@${Server}:$remoteArchive"
        if ($LASTEXITCODE -ne 0) { throw 'Не удалось передать расписание на сервер' }
        & ssh.exe -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i $IdentityFile "${ServerUser}@${Server}" "/srv/schedule-web/bin/activate-release '$remoteArchive' '$stamp'"
        if ($LASTEXITCODE -ne 0) { throw 'Сервер не активировал новую версию расписания' }
    }

    [ordered]@{ sha256 = $sourceHash; published = (Get-Date).ToString('o') } |
        ConvertTo-Json | Set-Content $stateFile -Encoding utf8
        Write-Log "Расписание успешно опубликовано. Файлов: $(@(Get-ChildItem $exportRoot -File -Recurse).Count)."
}
catch {
    Write-Log "ОШИБКА: $($_.Exception.Message)"
    exit 1
}
