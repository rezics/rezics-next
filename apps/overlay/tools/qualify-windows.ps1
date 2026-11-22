[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Overlay', 'Launcher', 'Evidence')]
    [string] $Mode,
    [string] $Overlay,
    [string] $Launcher,
    [string] $Fixture,
    [string] $OutputDirectory = (Join-Path $PSScriptRoot '../../../.temp/windows-qualification'),
    [string] $EvidenceDirectory,
    [ValidateRange(30, 1800)]
    [int] $OperatorSeconds = 300
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'QualificationEvidence.ps1')
if ($Mode -eq 'Evidence') {
    if (-not $Launcher) { throw 'Supply -Launcher with the candidate executable to check its artifacts.' }
    $Result = Get-WindowsQualification $Launcher $(if ($EvidenceDirectory) { $EvidenceDirectory } else { $OutputDirectory })
    $Result | ConvertTo-Json -Depth 8
    if (-not $Result.ready) { exit 1 }
    exit 0
}
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitProcess -or
    [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64' -or -not [Environment]::UserInteractive) {
    throw 'Run from an interactive Windows x64 desktop using 64-bit Windows PowerShell.'
}

$RunRoot = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) ([Guid]::NewGuid().ToString())
$null = New-Item -ItemType Directory -Path $RunRoot -Force
$Owned = [Collections.Generic.List[Diagnostics.Process]]::new()
$Captured = [Collections.Generic.List[object]]::new()
$Observations = [Collections.Generic.List[object]]::new()
$Report = [ordered]@{
    schemaVersion = 1; platform = 'windows-x64'
    startedAt = [DateTime]::UtcNow.ToString('o'); mode = $Mode
    machine = [Environment]::OSVersion.VersionString; status = 'failed'; artifacts = [ordered]@{}
}
$PackagedRun = $null
$NoWindow = [IntPtr]::Zero
$Hotkey = [ushort[]]@(0x11, 0x10, 0x20)
$AlternateHotkey = [ushort[]]@(0x11, 0x10, 0x78)
Write-Host "Qualification evidence will be written to $RunRoot."

function Assert-Observed($Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}

function Write-Observation([string] $Id, [string] $Name) {
    $Observations.Add([ordered]@{ id = $Id; name = $Name })
    Write-Host "PASS $Name"
}

function Wait-Observed([string] $Name, [scriptblock] $Probe, [int] $Seconds = 10) {
    $Clock = [Diagnostics.Stopwatch]::StartNew()
    do {
        $Value = & $Probe
        if ($Value) { return $Value }
        Start-Sleep -Milliseconds 100
    } while ($Clock.Elapsed.TotalSeconds -lt $Seconds)
    throw "Timed out waiting for $Name."
}

function Confirm-For([string] $Message, [scriptblock] $Invariant) {
    $Clock = [Diagnostics.Stopwatch]::StartNew()
    do {
        Assert-Observed (& $Invariant) $Message
        Start-Sleep -Milliseconds 60
    } while ($Clock.ElapsedMilliseconds -lt 500)
}

function Start-Controlled([string] $Path, [string] $Arguments, [string] $Directory, [bool] $ReadPipe, $EnvironmentOverrides = @{}) {
    $Start = [Diagnostics.ProcessStartInfo]::new($Path, $Arguments)
    $Start.WorkingDirectory = $Directory
    $Start.UseShellExecute = $false
    $Start.RedirectStandardInput = $ReadPipe
    $Start.RedirectStandardOutput = $true
    $Start.RedirectStandardError = $true
    foreach ($Key in $EnvironmentOverrides.Keys) {
        if ($null -eq $EnvironmentOverrides[$Key]) { $Start.EnvironmentVariables.Remove($Key) }
        else { $Start.EnvironmentVariables[$Key] = $EnvironmentOverrides[$Key] }
    }
    $Process = [Diagnostics.Process]::Start($Start)
    $null = $Process.Handle
    $Owned.Add($Process)
    $Captured.Add(@{ pid = $Process.Id; stderr = $Process.StandardError.ReadToEndAsync() })
    if (-not $ReadPipe) { $Captured.Add(@{ pid = $Process.Id; stdout = $Process.StandardOutput.ReadToEndAsync() }) }
    return $Process
}

function Read-OwnedLine($Process, [string] $Name, [int] $Seconds = 15) {
    $Line = $Process.StandardOutput.ReadLineAsync()
    Assert-Observed ($Line.Wait([TimeSpan]::FromSeconds($Seconds))) "Timed out reading $Name."
    Assert-Observed (-not [string]::IsNullOrEmpty($Line.Result)) "The process closed its pipe while waiting for $Name."
    return $Line.Result
}

function Get-Window($Process, [string] $Title, [switch] $Visible) {
    return Wait-Observed $Title {
        $Handle = [QualificationWindows]::Find($Process.Id, $Title)
        if ($Handle -ne $NoWindow -and (-not $Visible -or [QualificationWindows]::IsWindowVisible($Handle))) { $Handle }
    }
}

function Click-Center([IntPtr] $Window) {
    $Bounds = [QualificationWindows]::Bounds($Window, $true)
    [QualificationWindows]::Click(
        [int](($Bounds.Left + $Bounds.Right) / 2), [int](($Bounds.Top + $Bounds.Bottom) / 2),
        $Window, $NoWindow
    )
}

function Focus-Controlled([IntPtr] $Window) {
    if ([QualificationWindows]::Foreground() -ne $Window) { Click-Center $Window }
    $null = Wait-Observed 'controlled foreground window' { [QualificationWindows]::Foreground() -eq $Window }
}

function Open-Overlay([IntPtr] $GameWindow, [IntPtr] $OverlayWindow, [ushort[]] $Keys = $Hotkey) {
    Focus-Controlled $GameWindow
    $Clock = [Diagnostics.Stopwatch]::StartNew()
    $LastPress = -1000
    do {
        $Foreground = [QualificationWindows]::Foreground()
        if ([QualificationWindows]::IsWindowVisible($OverlayWindow) -and $Foreground -eq $OverlayWindow) { return }
        if ($Foreground -eq $GameWindow -and ($Clock.ElapsedMilliseconds - $LastPress) -ge 1000) {
            [QualificationWindows]::Press($GameWindow, $Keys)
            $LastPress = $Clock.ElapsedMilliseconds
        }
        Start-Sleep -Milliseconds 70
    } while ($Clock.ElapsedMilliseconds -lt 14000)
    throw 'The selected shortcut did not open a visible interactive Overlay for the controlled game.'
}

function Wait-Returned([IntPtr] $GameWindow, [IntPtr] $OverlayWindow) {
    $null = Wait-Observed 'hidden Overlay and returned game focus' {
        -not [QualificationWindows]::IsWindowVisible($OverlayWindow) -and [QualificationWindows]::Foreground() -eq $GameWindow
    }
}

function Test-GameModal($Game, [IntPtr] $GameWindow, [IntPtr] $OverlayWindow) {
    [QualificationWindows]::Press($GameWindow, [ushort[]]@(0x77))
    $Prompt = Get-Window $Game 'REZICS qualification game prompt' -Visible
    $null = Wait-Observed 'modal prompt with Overlay hidden' {
        [QualificationWindows]::Foreground() -eq $Prompt -and
            -not [QualificationWindows]::IsWindowVisible($OverlayWindow)
    }
    [QualificationWindows]::Press($Prompt, $Hotkey)
    Confirm-For 'The game modal prompt lost focus to the Overlay hotkey.' {
        [QualificationWindows]::Foreground() -eq $Prompt -and
            -not [QualificationWindows]::IsWindowVisible($OverlayWindow)
    }
    [QualificationWindows]::Press($Prompt, [ushort[]]@(0x0D))
    $null = Wait-Observed 'dismissed modal prompt and returned game focus' {
        -not [QualificationWindows]::IsWindowVisible($Prompt) -and
            [QualificationWindows]::Foreground() -eq $GameWindow
    }
}

function Get-Control([IntPtr] $Window, [string] $Name, [int] $Seconds = 10, $ControlType = $null) {
    return Wait-Observed "the accessible control '$Name'" {
        $Root = [System.Windows.Automation.AutomationElement]::FromHandle($Window)
        $NameCondition = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::NameProperty, $Name
        )
        $Condition = $NameCondition
        if ($ControlType) {
            $TypeCondition = [System.Windows.Automation.PropertyCondition]::new(
                [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ControlType
            )
            $Condition = [System.Windows.Automation.AndCondition]::new(
                [System.Windows.Automation.Condition[]] @($NameCondition, $TypeCondition)
            )
        }
        $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $Condition)
    } $Seconds
}

function Click-Control($Control, [IntPtr] $Window, [IntPtr] $OtherAllowed = [IntPtr]::Zero) {
    $Bounds = $Control.Current.BoundingRectangle
    Assert-Observed (-not $Bounds.IsEmpty) 'The accessible control has no visible bounds.'
    [QualificationWindows]::Click(
        [int](($Bounds.Left + $Bounds.Right) / 2), [int](($Bounds.Top + $Bounds.Bottom) / 2),
        $Window, $OtherAllowed
    )
}

function Set-LauncherShortcut([IntPtr] $LauncherWindow, [IntPtr] $GameWindow, [string] $Label) {
    [QualificationWindows]::SetMinimized($GameWindow, $true)
    try {
        $null = Wait-Observed 'minimized controlled game' { [QualificationWindows]::IsIconic($GameWindow) }
        Focus-Controlled $LauncherWindow
        $Selector = Get-Control $LauncherWindow 'Overlay shortcut' -ControlType ([System.Windows.Automation.ControlType]::ComboBox)
        Click-Control $Selector $LauncherWindow
        $Option = Get-Control $LauncherWindow $Label
        Click-Control $Option $LauncherWindow
    } finally {
        [QualificationWindows]::SetMinimized($GameWindow, $false)
    }
    $null = Wait-Observed 'restored controlled game' { -not [QualificationWindows]::IsIconic($GameWindow) }
}

function Send-Session($Process, $Session) {
    $Process.StandardInput.WriteLine((@{ v = 1; type = 'session'; session = $Session } | ConvertTo-Json -Compress -Depth 8))
    $Process.StandardInput.Flush()
}

function Assert-SessionStatus($Process, $Session, [bool] $Attached) {
    $Status = Read-OwnedLine $Process 'Overlay session status' | ConvertFrom-Json
    Assert-Observed ($Status.v -eq 1 -and $Status.type -ceq 'session-status' -and
        $Status.sessionId -ceq $Session.sessionId -and $Status.attached -is [bool] -and
        $Status.attached -eq $Attached) 'Unexpected Overlay session status.'
}

function Read-ClickCount([string] $Directory, [switch] $Sibling) {
    $Filename = if ($Sibling) { 'qualification-sibling-pointer.txt' } else { 'qualification-pointer.txt' }
    $Path = Join-Path $Directory $Filename
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    return @(Get-Content -LiteralPath $Path).Count
}

function Test-BorderlessHud([IntPtr] $GameWindow, [IntPtr] $OverlayWindow, [string] $Title, [string] $FixtureHome) {
    $Client = [QualificationWindows]::Bounds($GameWindow, $true).ToString()
    [QualificationWindows]::Press($GameWindow, [ushort[]]@(0x76))
    try {
        $null = Wait-Observed 'HUD remains above the borderless game with unchanged client bounds' {
            [QualificationWindows]::IsTopmost($GameWindow) -and
                [QualificationWindows]::IsWindowVisible($OverlayWindow) -and
                [QualificationWindows]::IsAbove($OverlayWindow, $GameWindow) -and
                [QualificationWindows]::Foreground() -eq $GameWindow -and
                [QualificationWindows]::Bounds($GameWindow, $true).ToString() -eq $Client -and
                [QualificationWindows]::Bounds($OverlayWindow, $false).ToString() -eq $Client
        }
        $Before = Read-ClickCount $FixtureHome
        Click-Control (Get-Control $OverlayWindow $Title) $GameWindow $OverlayWindow
        $null = Wait-Observed 'HUD click reaches the borderless game' {
            [QualificationWindows]::Foreground() -eq $GameWindow -and (Read-ClickCount $FixtureHome) -gt $Before
        }
        Open-Overlay $GameWindow $OverlayWindow
        Click-Control (Get-Control $OverlayWindow 'Pin compact view') $OverlayWindow
        $null = Wait-Observed 'repinned HUD sits above the borderless game' {
            [QualificationWindows]::IsWindowVisible($OverlayWindow) -and
                [QualificationWindows]::IsAbove($OverlayWindow, $GameWindow) -and
                [QualificationWindows]::Foreground() -eq $GameWindow
        }
    } finally {
        if ([QualificationWindows]::Foreground() -eq $GameWindow -and [QualificationWindows]::IsTopmost($GameWindow)) {
            [QualificationWindows]::Press($GameWindow, [ushort[]]@(0x76))
        }
    }
    $null = Wait-Observed 'HUD remains above the restored windowed game' {
        -not [QualificationWindows]::IsTopmost($GameWindow) -and
            [QualificationWindows]::IsWindowVisible($OverlayWindow) -and
            [QualificationWindows]::IsAbove($OverlayWindow, $GameWindow) -and
            [QualificationWindows]::Foreground() -eq $GameWindow -and
            [QualificationWindows]::Bounds($GameWindow, $true).ToString() -eq $Client -and
            [QualificationWindows]::Bounds($OverlayWindow, $false).ToString() -eq $Client
    }
    Write-Observation 'borderless-hud-order' 'HUD stays above the foreground game through windowed and topmost borderless changes with pointer pass-through'
}

function Test-CrossDisplayBounds([IntPtr] $GameWindow, [IntPtr] $OverlayWindow) {
    $Displays = @([QualificationWindows]::OtherDisplays($GameWindow))
    if ($Displays.Count -eq 0) { return }
    $Start = [QualificationWindows]::Bounds($GameWindow, $false)
    $StartDpi = [QualificationWindows]::GetDpiForWindow($GameWindow)
    $MixedDpi = $false
    try {
        foreach ($Display in $Displays) {
            $DisplayWidth = $Display.Right - $Display.Left
            $DisplayHeight = $Display.Bottom - $Display.Top
            $Width = [Math]::Min($Start.Right - $Start.Left, [Math]::Floor($DisplayWidth * 0.55))
            $Height = [Math]::Min($Start.Bottom - $Start.Top, [Math]::Floor($DisplayHeight * 0.55))
            $Destination = $Display
            $Destination.Left = $Display.Left + ($DisplayWidth - $Width) / 2
            $Destination.Top = $Display.Top + ($DisplayHeight - $Height) / 2
            $Destination.Right = $Destination.Left + $Width
            $Destination.Bottom = $Destination.Top + $Height
            [QualificationWindows]::MoveTo($GameWindow, $Destination)
            $null = Wait-Observed 'interactive Overlay tracks the game on the next display' {
                $Client = [QualificationWindows]::Bounds($GameWindow, $true)
                $X = ($Client.Left + $Client.Right) / 2
                $Y = ($Client.Top + $Client.Bottom) / 2
                $X -ge $Display.Left -and $X -lt $Display.Right -and
                    $Y -ge $Display.Top -and $Y -lt $Display.Bottom -and
                    [QualificationWindows]::Foreground() -eq $OverlayWindow -and
                    [QualificationWindows]::Bounds($OverlayWindow, $false).ToString() -eq $Client.ToString() -and
                    [QualificationWindows]::GetDpiForWindow($OverlayWindow) -eq
                        [QualificationWindows]::GetDpiForWindow($GameWindow)
            }
            if ([QualificationWindows]::GetDpiForWindow($GameWindow) -ne $StartDpi) {
                $MixedDpi = $true
                break
            }
        }
    } finally {
        [QualificationWindows]::MoveTo($GameWindow, $Start)
    }
    $null = Wait-Observed 'interactive Overlay tracks the game back to its first display' {
        [QualificationWindows]::Foreground() -eq $OverlayWindow -and
            [QualificationWindows]::GetDpiForWindow($OverlayWindow) -eq $StartDpi -and
            [QualificationWindows]::Bounds($OverlayWindow, $false).ToString() -eq
                [QualificationWindows]::Bounds($GameWindow, $true).ToString()
    }
    if ($MixedDpi) {
        Write-Observation 'mixed-dpi-bounds' 'the interactive Overlay kept its input and followed a game across displays with different DPI'
    }
}

function Test-StandaloneOverlay([string] $Executable, [string] $FixtureExe, [string] $FixtureHome) {
    $Game = Start-Controlled $FixtureExe '--with-sibling' $FixtureHome $true
    $Peer = Start-Controlled $FixtureExe '--peer' $FixtureHome $true
    $Line = Read-OwnedLine $Game 'fixture ready'
    Assert-Observed ($Line -match '^fixture-ready (\d+) (\d+) (\d+)$') 'The fixture did not identify its process and HWND.'
    Assert-Observed ([int] $Matches[1] -eq $Game.Id) 'The fixture reported an unexpected process ID.'
    $Started = [long] $Matches[2]
    $GameWindow = Get-Window $Game 'REZICS qualification game'
    Assert-Observed ($GameWindow.ToInt64() -eq [long] $Matches[3]) 'The controlled fixture HWND did not match its window.'
    $SiblingWindow = Get-Window $Game 'REZICS qualification sibling' -Visible
    Assert-Observed ([QualificationWindows]::IsMirroredDpiUnaware($SiblingWindow)) 'Build the fixture from the current source for the mirrored-window check.'
    $PeerWindow = Get-Window $Peer 'REZICS qualification peer'
    $Native = Start-Controlled $Executable '' (Split-Path -Parent $Executable) $true @{
        LOCALAPPDATA = (Join-Path $RunRoot 'webview-profile')
    }
    $Ready = Read-OwnedLine $Native 'Overlay ready frame' 35 | ConvertFrom-Json
    if ($Ready.v -eq 1 -and $Ready.type -ceq 'webview2-unavailable') {
        if (Get-EvidenceField $Ready 'runtimeDetected') {
            throw 'Microsoft Edge WebView2 is available. Overlay could not initialize it. Review the Overlay process diagnostics.'
        }
        throw 'Overlay could not start WebView2. Install or repair the Microsoft Edge WebView2 Runtime before running this fixture again.'
    }
    Assert-Observed ($Ready.v -eq 1 -and $Ready.type -ceq 'ready' -and $Ready.sessionFrameLimit -eq 32768 -and
        (Get-EvidenceField $Ready 'shortcut') -ceq 'ctrl-shift-space') 'The native ready frame must confirm the default shortcut and session frame limit.'
    $OverlayWindow = Get-Window $Native 'REZICS Overlay'
    Assert-Observed (-not [QualificationWindows]::IsWindowVisible($OverlayWindow)) 'Overlay was visible before the game session.'
    Write-Observation 'ready' 'native WebView2 v1 ready and initial hidden mode'

    $Session = @{
        sessionId = [Guid]::NewGuid().ToString(); instanceId = 'qualification-game'; pid = $Game.Id
        startedAt = $Started; title = 'Windows qualification session'
        destinations = @(@{ id = 'guide'; label = 'Qualification guide' })
    }
    Send-Session $Native $Session
    Assert-SessionStatus $Native $Session $true
    Write-Observation 'session-binding' 'Overlay confirmed binding the exact live game process'
    Focus-Controlled $GameWindow
    Test-GameModal $Game $GameWindow $OverlayWindow
    Wait-Returned $GameWindow $OverlayWindow
    Open-Overlay $GameWindow $OverlayWindow
    $null = Get-Control $OverlayWindow $Session.title
    $originalBounds = [QualificationWindows]::Bounds($GameWindow, $true).ToString()
    Assert-Observed ([QualificationWindows]::Bounds($OverlayWindow, $false).ToString() -eq $originalBounds) 'Overlay does not match the game client area.'
    [QualificationWindows]::Move($GameWindow)
    $null = Wait-Observed 'repositioned and resized game client bounds' {
        $Moved = [QualificationWindows]::Bounds($GameWindow, $true).ToString()
        $Moved -ne $originalBounds -and [QualificationWindows]::Bounds($OverlayWindow, $false).ToString() -eq $Moved
    }
    Write-Observation 'hotkey-bounds' 'Ctrl+Shift+Space opens captured input and matches moving client bounds'
    Test-CrossDisplayBounds $GameWindow $OverlayWindow

    $ReturnFocus = {
        $Focused = [System.Windows.Automation.AutomationElement]::FocusedElement
        $Focused -and $Focused.Current.Name.StartsWith('Return to game')
    }
    [QualificationWindows]::Press($OverlayWindow, [ushort[]]@(0x09))
    $null = Wait-Observed 'keyboard focus on Return to game' $ReturnFocus
    [QualificationWindows]::Press($OverlayWindow, [ushort[]]@(0x1B))
    Wait-Returned $GameWindow $OverlayWindow
    Write-Observation 'tab-escape' 'Tab focus and Escape return to the game'

    Open-Overlay $GameWindow $OverlayWindow
    $null = Get-Control $OverlayWindow $Session.title
    [QualificationWindows]::Press($OverlayWindow, [ushort[]]@(0x09))
    $null = Wait-Observed 'keyboard focus on Return to game' $ReturnFocus
    [QualificationWindows]::Press($OverlayWindow, [ushort[]]@(0x0D))
    Wait-Returned $GameWindow $OverlayWindow
    Write-Observation 'return-to-game' 'Return to game is reachable by keyboard'

    Open-Overlay $GameWindow $OverlayWindow
    Click-Control (Get-Control $OverlayWindow 'Qualification guide') $OverlayWindow
    $Destination = Read-OwnedLine $Native 'Overlay destination frame' | ConvertFrom-Json
    Assert-Observed ($Destination.v -eq 1 -and $Destination.type -ceq 'open-destination' -and
        $Destination.sessionId -ceq $Session.sessionId -and $Destination.destination -ceq 'guide') 'Unexpected destination frame.'
    Wait-Returned $GameWindow $OverlayWindow
    Write-Observation 'destination' 'destination action stays on the v1 pipe with its live session identity'

    Open-Overlay $GameWindow $OverlayWindow
    Click-Control (Get-Control $OverlayWindow 'Pin compact view') $OverlayWindow
    $null = Wait-Observed 'visible HUD with game foreground' {
        [QualificationWindows]::IsWindowVisible($OverlayWindow) -and [QualificationWindows]::Foreground() -eq $GameWindow
    }
    $Hud = Get-Control $OverlayWindow $Session.title
    $Before = Read-ClickCount $FixtureHome
    Click-Control $Hud $GameWindow $OverlayWindow
    $null = Wait-Observed 'HUD click delivered to game' { (Read-ClickCount $FixtureHome) -gt $Before }
    Write-Observation 'click-through-hud' 'compact HUD is click-through while the game keeps focus'
    Test-BorderlessHud $GameWindow $OverlayWindow $Session.title $FixtureHome

    Open-Overlay $GameWindow $OverlayWindow
    Click-Control (Get-Control $OverlayWindow 'Pin compact view') $OverlayWindow
    $null = Wait-Observed 'visible HUD again' {
        [QualificationWindows]::IsWindowVisible($OverlayWindow) -and [QualificationWindows]::Foreground() -eq $GameWindow
    }
    Write-Observation 'reopen-hud' 'the same hotkey reopens interactive mode from HUD'

    Test-GameModal $Game $GameWindow $OverlayWindow
    $null = Wait-Observed 'HUD resumes over the original game after the modal prompt' {
        [QualificationWindows]::IsWindowVisible($OverlayWindow) -and
            [QualificationWindows]::Foreground() -eq $GameWindow -and
            [QualificationWindows]::Bounds($OverlayWindow, $false).ToString() -eq
                [QualificationWindows]::Bounds($GameWindow, $true).ToString()
    }
    Write-Observation 'game-modal-focus' 'the owned modal prompt keeps focus and the pinned HUD resumes on dismissal'

    Focus-Controlled $PeerWindow
    $null = Wait-Observed 'hidden HUD when switching to the peer' { -not [QualificationWindows]::IsWindowVisible($OverlayWindow) }
    [QualificationWindows]::Press($PeerWindow, $Hotkey)
    Confirm-For 'An unrelated foreground process opened the Overlay.' {
        -not [QualificationWindows]::IsWindowVisible($OverlayWindow) -and [QualificationWindows]::Foreground() -eq $PeerWindow
    }
    Write-Observation 'unrelated-foreground' 'unrelated window hides HUD and cannot open the game Overlay'

    Focus-Controlled $SiblingWindow
    [QualificationWindows]::Press($SiblingWindow, $Hotkey)
    Confirm-For 'A sibling window in the game process reopened the pinned HUD.' {
        -not [QualificationWindows]::IsWindowVisible($OverlayWindow) -and
            [QualificationWindows]::Foreground() -eq $SiblingWindow
    }
    Write-Observation 'same-process-foreground' 'the suspended HUD hotkey leaves a sibling window of the same process alone'

    [QualificationWindows]::Move($GameWindow)
    Focus-Controlled $GameWindow
    $null = Wait-Observed 'pinned HUD reappeared on the moved game with game focus' {
        [QualificationWindows]::IsWindowVisible($OverlayWindow) -and
            [QualificationWindows]::Foreground() -eq $GameWindow -and
            [QualificationWindows]::Bounds($OverlayWindow, $false).ToString() -eq [QualificationWindows]::Bounds($GameWindow, $true).ToString()
    }
    $Before = Read-ClickCount $FixtureHome
    Click-Control (Get-Control $OverlayWindow $Session.title) $GameWindow $OverlayWindow
    $null = Wait-Observed 'resumed HUD delivered pointer to game' { (Read-ClickCount $FixtureHome) -gt $Before }
    Write-Observation 'resume-hud' 'returning to the same moved game restores click-through HUD with game focus'

    [QualificationWindows]::SetMinimized($GameWindow, $true)
    $null = Wait-Observed 'minimized game hides pinned HUD' {
        [QualificationWindows]::IsIconic($GameWindow) -and -not [QualificationWindows]::IsWindowVisible($OverlayWindow)
    }
    [QualificationWindows]::SetMinimized($GameWindow, $false)
    $null = Wait-Observed 'game window restored' { -not [QualificationWindows]::IsIconic($GameWindow) }
    Focus-Controlled $GameWindow
    $null = Wait-Observed 'pinned HUD returns from minimize with game focus' {
        [QualificationWindows]::IsWindowVisible($OverlayWindow) -and [QualificationWindows]::Foreground() -eq $GameWindow
    }
    Write-Observation 'minimized-hud' 'minimizing suspends the pinned HUD until the restored game takes focus'

    Open-Overlay $GameWindow $OverlayWindow
    $null = Get-Control $OverlayWindow $Session.title
    [QualificationWindows]::Press($OverlayWindow, [ushort[]]@(0x09))
    $null = Wait-Observed 'keyboard focus inside the Overlay WebView' $ReturnFocus
    Focus-Controlled $PeerWindow
    $null = Wait-Observed 'interactive Overlay hid while the other window kept focus' {
        -not [QualificationWindows]::IsWindowVisible($OverlayWindow) -and [QualificationWindows]::Foreground() -eq $PeerWindow
    }
    Focus-Controlled $GameWindow
    Confirm-For 'The interactive Overlay reopened without a hotkey.' {
        -not [QualificationWindows]::IsWindowVisible($OverlayWindow) -and [QualificationWindows]::Foreground() -eq $GameWindow
    }
    Write-Observation 'interactive-foreground-loss' 'interactive input closes on focus loss and stays closed on return'

    Open-Overlay $SiblingWindow $OverlayWindow
    $null = Get-Control $OverlayWindow $Session.title
    $null = Wait-Observed 'bounds on a mirrored game using Windows DPI scaling' {
        [QualificationWindows]::Bounds($OverlayWindow, $false).ToString() -eq
            [QualificationWindows]::Bounds($SiblingWindow, $true).ToString()
    }
    [QualificationWindows]::Press($OverlayWindow, [ushort[]]@(0x1B))
    Wait-Returned $SiblingWindow $OverlayWindow
    $Before = Read-ClickCount $FixtureHome -Sibling
    Click-Center $SiblingWindow
    $null = Wait-Observed 'pointer input returned to the mirrored game' { (Read-ClickCount $FixtureHome -Sibling) -gt $Before }
    Write-Observation 'mirrored-game-bounds' 'Overlay matched a mirrored, DPI-unaware game and returned keyboard and pointer input'

    Open-Overlay $GameWindow $OverlayWindow
    $Stale = $Session.Clone()
    $Stale.startedAt -= 1
    Send-Session $Native $Stale
    Assert-SessionStatus $Native $Stale $false
    $null = Wait-Observed 'stale binding dismissed' { -not [QualificationWindows]::IsWindowVisible($OverlayWindow) }
    Focus-Controlled $GameWindow
    [QualificationWindows]::Press($GameWindow, $Hotkey)
    Confirm-For 'Overlay accepted a timestamp older than its process.' { -not [QualificationWindows]::IsWindowVisible($OverlayWindow) }
    Write-Observation 'stale-session' 'a stale session cannot bind the controlled PID'

    Send-Session $Native $Session
    Assert-SessionStatus $Native $Session $true
    Open-Overlay $GameWindow $OverlayWindow
    $LargeSession = $Session.Clone()
    $LargeSession.panels = @(1..8 | ForEach-Object {
        @{ id = "fixture.panel-$_"; title = "Qualification panel $_"; text = 'Guide ' + ([string] [char] 1 * 390); destination = 'guide' }
    })
    $LargeFrame = @{ v = 1; type = 'session'; session = $LargeSession } | ConvertTo-Json -Compress -Depth 8
    $Size = [Text.Encoding]::UTF8.GetByteCount($LargeFrame)
    Assert-Observed ($Size -gt 16384 -and $Size -le $Ready.sessionFrameLimit) 'The fixture did not construct a session frame above the legacy limit.'
    Send-Session $Native $LargeSession
    $null = Get-Control $OverlayWindow 'Qualification panel 8'
    Assert-Observed ([QualificationWindows]::Foreground() -eq $OverlayWindow) 'The panel update changed game or Overlay focus.'
    Write-Observation 'large-panel-snapshot' 'the same visible session received all eight panels above the legacy frame limit'

    [QualificationWindows]::Close($GameWindow)
    Assert-Observed ($Game.WaitForExit(5000) -and $Game.ExitCode -eq 0) 'The controlled window did not exit normally.'
    $null = Wait-Observed 'closed game hides Overlay' { -not [QualificationWindows]::IsWindowVisible($OverlayWindow) }
    $Native.StandardInput.Close()
    Assert-Observed ($Native.WaitForExit(6000) -and $Native.ExitCode -eq 0) 'Overlay did not stop when the Launcher pipe closed.'
    Write-Observation 'game-and-pipe-close' 'normal game close hides Overlay and closing the pipe ends its process'
}

function Get-OwnedChild($Owner, [string] $Expected, [int] $Id = 0, [long] $StartedAt = 0) {
    $Children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($Owner.process.Id)"
    foreach ($Child in $Children) {
        if (($Id -ne 0 -and $Child.ProcessId -ne $Id) -or $Child.ExecutablePath -ne $Expected) { continue }
        $Process = $null
        try {
            $Process = [Diagnostics.Process]::GetProcessById([int] $Child.ProcessId)
            $null = $Process.Handle
            if ($Process.MainModule.FileName -eq $Expected -and $Process.StartTime -ge $Owner.startedAt -and
                ($StartedAt -eq 0 -or ([DateTimeOffset] $Process.StartTime).ToUnixTimeMilliseconds() -eq $StartedAt)) {
                $Owned.Add($Process)
                return $Process
            }
        } catch [InvalidOperationException], [ArgumentException] {
            # A starting process can exit while Windows resolves its PID.
        }
        if ($Process) { $Process.Dispose() }
    }
}

function Stop-ControlledWebViewBrowser($LauncherProcess, [string] $DataDirectory) {
    $DirectoryArgument = '(?:^|\s)"?--user-data-dir=(?:"{0}"|{0}"?)(?:\s|$)' -f (
        [regex]::Escape($DataDirectory) + '(?:\\EBWebView)?'
    )
    $Browser = Wait-Observed 'WebView2 browser for the isolated Overlay profile' {
        $Candidates = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" | Where-Object {
            $_.CommandLine -match $DirectoryArgument -and $_.CommandLine -notmatch '(?:^|\s)"?--type='
        })
        if ($Candidates.Count -ne 1) { return }
        $Entry = $Candidates[0]
        $Process = $null
        try {
            $Process = [Diagnostics.Process]::GetProcessById([int] $Entry.ProcessId)
            $null = $Process.Handle
            $RecordedStart = ([DateTimeOffset] $Entry.CreationDate).ToUnixTimeMilliseconds()
            $ActualStart = ([DateTimeOffset] $Process.StartTime).ToUnixTimeMilliseconds()
            if (-not $Process.HasExited -and $Process.StartTime -ge $LauncherProcess.StartTime -and
                [Math]::Abs($RecordedStart - $ActualStart) -le 1 -and
                $Process.MainModule.FileName -eq $Entry.ExecutablePath) {
                $Owned.Add($Process)
                return $Process
            }
        } catch [InvalidOperationException], [ArgumentException], [ComponentModel.Win32Exception] {
            # The process can exit while Windows resolves its identity.
        }
        if ($Process) { $Process.Dispose() }
    }
    $Browser.Kill()
    Assert-Observed ($Browser.WaitForExit(6000)) 'The isolated WebView2 browser did not exit.'
}

function Test-PackagedLauncher([string] $Executable, [string] $Sidecar, [string] $FixtureExe, [string] $FixtureHome) {
    $Reservation = Start-Controlled $FixtureExe '--hold-default-hotkey' $FixtureHome $true
    Assert-Observed ((Read-OwnedLine $Reservation 'default shortcut reservation') -ceq 'hotkey-held') 'The fixture did not reserve the default shortcut.'
    $Profile = Join-Path $RunRoot 'launcher-profile'
    $WebViewProfile = Join-Path $RunRoot 'webview-profile'
    $LauncherProcess = Start-Controlled $Executable ('--user-data-dir="' + $Profile + '"') (Split-Path $Executable) $false @{
        REZICS_OVERLAY_PATH = $null
        REZICS_CATALOG_URL = 'http://127.0.0.1:9'
        REZICS_WEB_URL = 'http://127.0.0.1:9'
        LOCALAPPDATA = $WebViewProfile
        WEBVIEW2_USER_DATA_FOLDER = $null
    }
    $Owner = @{ process = $LauncherProcess; startedAt = $LauncherProcess.StartTime }
    $script:PackagedRun = @{ owner = $Owner; fixture = $FixtureExe; overlay = $Sidecar }
    $LauncherWindow = Get-Window $LauncherProcess 'REZICS Launcher' -Visible
    $null = Wait-Observed 'isolated Chromium profile directory' { Test-Path -LiteralPath $Profile -PathType Container }
    Write-Observation 'packaged-window' 'packaged Launcher displayed its own desktop window'
    Write-Host "In Launcher, open Library, choose Installed, import Other local game from $FixtureExe, then Play."
    Write-Host 'After Play, leave Launcher and the controlled game uncovered while the script verifies shortcut recovery.'
    $Marker = Join-Path $FixtureHome 'qualification-session.json'
    $OwnedGame = Wait-Observed 'game launched by this packaged Launcher' {
        if (Test-Path -LiteralPath $Marker) {
            $Identity = Get-Content -Raw -LiteralPath $Marker | ConvertFrom-Json
            Get-OwnedChild $Owner $FixtureExe $Identity.pid $Identity.startedAt
        }
    } $OperatorSeconds
    $GameWindow = Get-Window $OwnedGame 'REZICS qualification game'
    $null = Get-Control $LauncherWindow 'Overlay could not register Ctrl+Shift+Space. Choose another shortcut or retry.' 30
    Set-LauncherShortcut $LauncherWindow $GameWindow 'Ctrl+Shift+F9'
    $null = Get-Control $LauncherWindow 'Restart Overlay' 30
    $Native = Wait-Observed 'packaged sidecar child using the alternate shortcut' { Get-OwnedChild $Owner $Sidecar } 30
    $OverlayWindow = Get-Window $Native 'REZICS Overlay'
    $Preference = Get-Content -Raw -LiteralPath (Join-Path $Profile 'overlay-preferences.json') | ConvertFrom-Json
    Assert-Observed ((Get-EvidenceField $Preference 'shortcut') -ceq 'ctrl-shift-f9') 'Launcher did not save the alternate shortcut.'
    Assert-Observed (-not $Reservation.HasExited) 'The fixture released Ctrl+Shift+Space before the switch was verified.'
    Open-Overlay $GameWindow $OverlayWindow $AlternateHotkey
    [QualificationWindows]::Press($OverlayWindow, [ushort[]]@(0x1B))
    Wait-Returned $GameWindow $OverlayWindow
    Write-Observation 'packaged-session' 'packaged Launcher forwarded the exact live game session to Overlay'

    $Reservation.StandardInput.Close()
    Assert-Observed ($Reservation.WaitForExit(5000) -and $Reservation.ExitCode -eq 0) 'The fixture could not release the default shortcut.'
    Set-LauncherShortcut $LauncherWindow $GameWindow 'Ctrl+Shift+Space'
    $null = Wait-Observed 'alternate sidecar retired' { $Native.HasExited }
    $null = Get-Control $LauncherWindow 'Restart Overlay' 30
    $Native = Wait-Observed 'packaged sidecar with the restored default shortcut' { Get-OwnedChild $Owner $Sidecar } 30
    $OverlayWindow = Get-Window $Native 'REZICS Overlay'
    Open-Overlay $GameWindow $OverlayWindow
    [QualificationWindows]::Press($OverlayWindow, [ushort[]]@(0x1B))
    Wait-Returned $GameWindow $OverlayWindow
    Write-Observation 'shortcut-recovery' 'reserved default reported a conflict, F9 opened Overlay over the same game, and the released default worked again'

    Open-Overlay $GameWindow $OverlayWindow
    $null = Get-Control $OverlayWindow 'Pin compact view'
    Stop-ControlledWebViewBrowser $LauncherProcess (Join-Path $WebViewProfile 'REZICS\Overlay')
    Assert-Observed ($Native.WaitForExit(10000) -and $Native.ExitCode -ne 0) 'Overlay did not exit after its WebView2 browser failed.'
    Wait-Returned $GameWindow $OverlayWindow
    Assert-Observed (-not $OwnedGame.HasExited) 'The game ended when its Overlay failed.'
    $Clicks = Read-ClickCount $FixtureHome
    Click-Center $GameWindow
    $null = Wait-Observed 'game receives input after WebView2 fails' { (Read-ClickCount $FixtureHome) -gt $Clicks }
    $Previous = $Native
    $Native = Wait-Observed 'replacement sidecar for the same game' {
        $Child = Get-OwnedChild $Owner $Sidecar
        if ($Child -and $Child.Id -ne $Previous.Id) { $Child }
    } 30
    $OverlayWindow = Get-Window $Native 'REZICS Overlay'
    $null = Get-Control $LauncherWindow 'Restart Overlay' 30
    Open-Overlay $GameWindow $OverlayWindow
    $null = Get-Control $OverlayWindow 'Pin compact view'
    [QualificationWindows]::Press($OverlayWindow, [ushort[]]@(0x1B))
    Wait-Returned $GameWindow $OverlayWindow
    Write-Observation 'webview2-process-recovery' 'WebView2 failure returned game focus and Launcher attached a replacement to the same game'

    $Instances = Join-Path $Profile 'instances'
    $Instance = Wait-Observed 'record in the isolated Launcher profile' {
        foreach ($Directory in (Get-ChildItem -LiteralPath $Instances -Directory -ErrorAction SilentlyContinue)) {
            $RecordFile = Join-Path $Directory.FullName 'instance.json'
            if (Test-Path -LiteralPath $RecordFile) {
                $Record = Get-Content -Raw -LiteralPath $RecordFile | ConvertFrom-Json
                if ($Record.kind -ceq 'local' -and $Record.executable -eq $FixtureExe) { return $Directory.FullName }
            }
        }
    }
    $HostCommand = Join-Path (Split-Path -Parent $Executable) 'rezics-launcher-host.exe'
    Assert-Observed (Test-Path -LiteralPath $HostCommand -PathType Leaf) 'The packaged Launcher host command is missing.'
    $HostProcess = Start-Controlled $HostCommand ('--data-dir "{0}" list-installed' -f $Profile) $RunRoot $true
    $HostProcess.StandardInput.Close()
    $InstalledJson = Read-OwnedLine $HostProcess 'the packaged host installation list'
    Assert-Observed ($HostProcess.WaitForExit(5000) -and $HostProcess.ExitCode -eq 0) 'The packaged host command did not exit successfully.'
    $Installed = @($InstalledJson | ConvertFrom-Json)
    $InstanceId = Split-Path -Leaf $Instance
    $Reported = @($Installed | Where-Object { $_.id -ceq $InstanceId -and $_.kind -ceq 'local' })
    Assert-Observed ($Reported.Count -eq 1) 'The packaged host did not report the running Launcher instance.'
    Write-Observation 'packaged-host' 'the installed command queried the same local instance while desktop Launcher owned the profile'
    $Save = Join-Path $FixtureHome 'saves/checkpoint.txt'
    $Original = [IO.File]::ReadAllBytes($Save)
    [QualificationWindows]::Close($GameWindow)
    Assert-Observed ($OwnedGame.WaitForExit(5000) -and $OwnedGame.ExitCode -eq 0) 'The controlled game did not exit normally.'
    $null = Wait-Observed 'exit log in the isolated profile' {
        $LogFile = Join-Path $Instance 'last-launch.json'
        if (Test-Path -LiteralPath $LogFile) {
            $Log = Get-Content -Raw -LiteralPath $LogFile | ConvertFrom-Json
            $Log.state -ceq 'exited' -and $Log.exitCode -eq 0 -and $Log.output.Contains('fixture-exit')
        }
    }
    $null = Wait-Observed 'packaged sidecar ended after game exit' { $Native.HasExited }
    $Snapshots = Join-Path $Instance 'snapshots'
    $null = Wait-Observed 'automatic exit backup' {
        foreach ($Folder in (Get-ChildItem -LiteralPath $Snapshots -Directory -ErrorAction SilentlyContinue)) {
            if (Test-Path -LiteralPath (Join-Path $Folder.FullName 'snapshot.json')) { return $true }
        }
    }
    Write-Observation 'diagnostics-and-backup' 'game exit retained real diagnostics and an automatic backup'

    [IO.File]::WriteAllText($Save, "Changed by the qualification after game exit.`n")
    Write-Host 'In Launcher Saves, preview the existing backup and select Restore this backup.'
    $Expected = [Convert]::ToBase64String($Original)
    $null = Wait-Observed 'original checkpoint restored from Launcher' {
        (Test-Path -LiteralPath $Save) -and [Convert]::ToBase64String([IO.File]::ReadAllBytes($Save)) -ceq $Expected
    } $OperatorSeconds
    $null = Wait-Observed 'pre-restore recovery snapshot' {
        foreach ($Folder in (Get-ChildItem -LiteralPath $Snapshots -Directory)) {
            $Manifest = Join-Path $Folder.FullName 'snapshot.json'
            if (Test-Path -LiteralPath $Manifest) {
                $Snapshot = Get-Content -Raw -LiteralPath $Manifest | ConvertFrom-Json
                if ($Snapshot.PSObject.Properties['label'] -and $Snapshot.label -ceq 'Before restore') { return $true }
            }
        }
    }
    Write-Observation 'restore' 'save preview and restore returned the exact fixture bytes and kept recovery history'
}

try {
    Add-Type -Path (Join-Path $PSScriptRoot 'QualificationWindows.cs')
    if ([QualificationWindows]::IsWine()) {
        $Report['runtime'] = 'wine'
        throw 'Native release qualification requires Windows x64 and WebView2.'
    }
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
    $Report['runtime'] = 'native'
    $FixtureHome = Join-Path $RunRoot 'game'
    $null = New-Item -ItemType Directory -Path $FixtureHome
    $FixtureExe = Join-Path $FixtureHome 'window-fixture.exe'
    if ($Fixture) {
        Copy-Item -LiteralPath (Resolve-Path -LiteralPath $Fixture).Path -Destination $FixtureExe
    } else {
        $Source = Join-Path $PSScriptRoot 'window-fixture.c'
        $Msvc = Get-Command cl.exe -ErrorAction SilentlyContinue
        if ($Msvc) {
            Push-Location $FixtureHome
            try { & $Msvc.Source /nologo /W4 /TC "/Fe$FixtureExe" $Source /link User32.lib Gdi32.lib }
            finally { Pop-Location }
        } else {
            $Gcc = Get-Command gcc.exe
            & $Gcc.Source -std=c11 -Wall -Wextra -Werror $Source -o $FixtureExe -luser32 -lgdi32
        }
        Assert-Observed ($LASTEXITCODE -eq 0) 'Could not build the Win32 fixture.'
    }
    $Report.artifacts['fixture'] = (Get-FileHash -LiteralPath $FixtureExe).Hash
    if ($Mode -eq 'Overlay') {
        Assert-Observed $Overlay 'Supply -Overlay with the Windows x64 sidecar executable.'
        $Sidecar = (Resolve-Path -LiteralPath $Overlay).Path
        $Report.artifacts['overlay'] = (Get-FileHash -LiteralPath $Sidecar).Hash
        $Loader = Join-Path (Split-Path -Parent $Sidecar) 'WebView2Loader.dll'
        if (Test-Path -LiteralPath $Loader -PathType Leaf) {
            $Report.artifacts['webview2Loader'] = (Get-FileHash -LiteralPath $Loader).Hash
        }
        Test-StandaloneOverlay $Sidecar $FixtureExe $FixtureHome
    } else {
        Assert-Observed $Launcher 'Supply -Launcher with the unpacked or installed Windows Launcher executable.'
        $Packaged = (Resolve-Path -LiteralPath $Launcher).Path
        $Resources = Join-Path (Split-Path -Parent $Packaged) 'resources'
        $Sidecar = (Resolve-Path -LiteralPath (Join-Path $Resources 'rezics-overlay.exe')).Path
        $Report.artifacts = Get-LauncherArtifacts $Packaged
        $Report.artifacts['fixture'] = (Get-FileHash -LiteralPath $FixtureExe).Hash
        Test-PackagedLauncher $Packaged $Sidecar $FixtureExe $FixtureHome
    }
    $Report.status = 'passed'
} catch {
    $Report['error'] = $_.Exception.Message
    throw
} finally {
    $CleanupProblems = [Collections.Generic.List[string]]::new()
    if ($PackagedRun) {
        try {
            $null = Get-OwnedChild $PackagedRun.owner $PackagedRun.overlay
            $null = Get-OwnedChild $PackagedRun.owner $PackagedRun.fixture
        } catch {
            $CleanupProblems.Add("Could not recheck the controlled Launcher children: $($_.Exception.Message)")
        }
    }
    for ($Index = $Owned.Count - 1; $Index -ge 0; $Index--) {
        $Process = $Owned[$Index]
        try {
            if (-not $Process.HasExited) {
                $Process.Kill()
                if (-not $Process.WaitForExit(5000)) { $CleanupProblems.Add("Owned process $($Process.Id) did not stop.") }
            }
        } catch {
            $CleanupProblems.Add("Could not clean owned process $($Process.Id): $($_.Exception.Message)")
        }
    }
    foreach ($Capture in $Captured) {
        foreach ($Stream in @('stdout', 'stderr')) {
            if ($Capture.ContainsKey($Stream)) {
                try {
                    $Task = $Capture[$Stream]
                    if ($Task.Wait(2000) -and $Task.Status -eq 'RanToCompletion') {
                        $Task.Result | Set-Content -Encoding utf8 -LiteralPath (Join-Path $RunRoot "$($Capture.pid)-$Stream.log")
                    }
                } catch {
                    Write-Warning "Could not retain $Stream for owned process $($Capture.pid)."
                }
            }
        }
    }
    foreach ($Process in $Owned) { $Process.Dispose() }
    $FailedWhileCleaning = $Report.status -eq 'passed' -and $CleanupProblems.Count -gt 0
    if ($CleanupProblems.Count -gt 0) {
        $Report.status = 'failed'
        $Report['cleanupErrors'] = $CleanupProblems.ToArray()
        foreach ($Problem in $CleanupProblems) { Write-Warning $Problem }
    }
    $Report['observations'] = $Observations.ToArray()
    $Report['finishedAt'] = [DateTime]::UtcNow.ToString('o')
    $Report | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $RunRoot 'qualification.json')
    if ($FailedWhileCleaning) { throw 'The qualification passed its observations and failed process cleanup.' }
}
