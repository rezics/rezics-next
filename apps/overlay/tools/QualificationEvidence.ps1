$MinecraftClientFilename = 'minecraft-client-id.txt'

function Get-LauncherArtifacts([string] $Executable) {
    $Resources = Join-Path (Split-Path -Parent $Executable) 'resources'
    $Artifacts = [ordered]@{
        launcher = (Get-FileHash -LiteralPath $Executable).Hash
        archive = (Get-FileHash -LiteralPath (Join-Path $Resources 'app.asar')).Hash
        overlay = (Get-FileHash -LiteralPath (Join-Path $Resources 'rezics-overlay.exe')).Hash
    }
    $Loader = Join-Path $Resources 'WebView2Loader.dll'
    if (Test-Path -LiteralPath $Loader -PathType Leaf) {
        $Artifacts['webview2Loader'] = (Get-FileHash -LiteralPath $Loader).Hash
    }
    $Client = Join-Path $Resources $MinecraftClientFilename
    if (Test-Path -LiteralPath $Client -PathType Leaf) {
        $Artifacts['minecraftClient'] = (Get-FileHash -LiteralPath $Client).Hash
    }
    $HostCommand = Join-Path (Split-Path -Parent $Executable) 'rezics-launcher-host.exe'
    if (Test-Path -LiteralPath $HostCommand -PathType Leaf) {
        $Artifacts['launcherHost'] = (Get-FileHash -LiteralPath $HostCommand).Hash
    }
    return $Artifacts
}

function Get-EvidenceField($Record, [string] $Name) {
    if ($Record -is [Collections.IDictionary]) { return $Record[$Name] }
    if ($null -ne $Record -and $Record.PSObject.Properties[$Name]) { return $Record.$Name }
}

function Test-EvidenceArtifacts($Reported, $Expected, [string[]] $Keys) {
    foreach ($Key in $Keys) {
        $Digest = Get-EvidenceField $Reported $Key
        if ($Digest -isnot [string] -or $Digest -notmatch '^[a-f0-9]{64}$' -or $Digest -ne $Expected[$Key]) {
            return $false
        }
    }
    return $true
}

$NativeEvidenceChecks = @{
    Overlay = @(
        'ready', 'session-binding', 'hotkey-bounds', 'tab-escape', 'return-to-game', 'destination', 'click-through-hud',
        'reopen-hud', 'borderless-hud-order', 'game-modal-focus', 'unrelated-foreground', 'same-process-foreground', 'resume-hud', 'minimized-hud',
        'interactive-foreground-loss', 'mirrored-game-bounds',
        'stale-session', 'large-panel-snapshot', 'game-and-pipe-close'
    )
    Launcher = @(
        'packaged-window', 'packaged-session', 'shortcut-recovery', 'webview2-process-recovery',
        'packaged-host', 'diagnostics-and-backup', 'restore'
    )
}

function Read-EvidenceReport([string] $Path) {
    try {
        $Data = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
        if ($Data -is [pscustomobject]) { return $Data }
    } catch {
        # Treat unreadable and malformed reports as unverified.
    }
}

function Test-EvidenceChecks($Recorded, [string[]] $Required) {
    foreach ($Check in $Required) {
        if ($Recorded -cnotcontains $Check) { return $false }
    }
    return $true
}

function Get-NativeFixtureEvidence($Reports, [string] $FixtureMode, $Candidate, [bool] $Unreadable) {
    if ($FixtureMode -eq 'Launcher' -and -not $Candidate.Contains('launcherHost')) {
        return @{ status = 'missing'; reason = 'The candidate lacks the packaged Launcher host executable.' }
    }
    $Keys = if ($FixtureMode -eq 'Overlay') {
        @('overlay') + @($Candidate.Keys | Where-Object { $_ -eq 'webview2Loader' })
    } else {
        @($Candidate.Keys)
    }
    $ForMode = @($Reports | Where-Object { (Get-EvidenceField $_ 'mode') -eq $FixtureMode })
    $MatchesCandidate = foreach ($Item in $ForMode) {
        if ((Get-EvidenceField $Item 'schemaVersion') -ne 1 -or
            (Get-EvidenceField $Item 'platform') -cne 'windows-x64' -or
            (Get-EvidenceField $Item 'runtime') -cne 'native' -or
            -not (Test-EvidenceArtifacts (Get-EvidenceField $Item 'artifacts') $Candidate $Keys)) { continue }
        $Timestamp = Get-EvidenceField $Item 'finishedAt'
        $Finished = [DateTimeOffset]::MinValue
        if ($Timestamp -is [DateTime]) {
            [pscustomobject]@{ report = $Item; finished = [DateTimeOffset] $Timestamp }
        } elseif ($Timestamp -is [string] -and [DateTimeOffset]::TryParse($Timestamp, [ref] $Finished)) {
            [pscustomobject]@{ report = $Item; finished = $Finished }
        }
    }
    $Latest = $MatchesCandidate | Sort-Object -Property finished -Descending | Select-Object -First 1
    if (-not $Latest) {
        if ($ForMode.Count -gt 0 -or $Unreadable) {
            return @{ status = 'unverified'; reason = 'No native fixture report matches the candidate artifacts.' }
        }
        return @{ status = 'missing'; reason = 'No report was supplied for this fixture.' }
    }
    $Result = Get-EvidenceField $Latest.report 'status'
    if ($Result -ceq 'failed') { return @{ status = 'failed'; finishedAt = $Latest.finished.ToString('o') } }
    $Observations = foreach ($Observation in (Get-EvidenceField $Latest.report 'observations')) {
        Get-EvidenceField $Observation 'id'
    }
    if ($Result -cne 'passed' -or -not (Test-EvidenceChecks $Observations $NativeEvidenceChecks[$FixtureMode])) {
        return @{ status = 'unverified'; reason = 'The candidate report lacks a passing verdict or the required observations.' }
    }
    return @{ status = 'passed'; finishedAt = $Latest.finished.ToString('o') }
}

function Get-LicensedLaneEvidence($Report, [string] $Lane, [string] $Version, $Candidate, [bool] $Present, [bool] $ClientConfigured) {
    if (-not $Present) { return @{ status = 'missing'; reason = 'No licensed Minecraft report was supplied.' } }
    if ((Get-EvidenceField $Report 'schemaVersion') -ne 1 -or
        (Get-EvidenceField $Report 'platform') -cne 'windows-x64' -or
        -not (Test-EvidenceArtifacts (Get-EvidenceField $Report 'artifacts') $Candidate @($Candidate.Keys))) {
        return @{ status = 'unverified'; reason = 'The licensed report is unreadable or does not match the candidate artifacts.' }
    }
    $Entries = @((Get-EvidenceField $Report 'lanes') | Where-Object { (Get-EvidenceField $_ 'loader') -ceq $Lane })
    if ($Entries.Count -eq 0) { return @{ status = 'missing'; reason = 'The licensed lane was not recorded.' } }
    if ($Entries.Count -ne 1) { return @{ status = 'unverified'; reason = 'The report has duplicate entries for this lane.' } }
    $Record = $Entries[0]
    $Result = Get-EvidenceField $Record 'status'
    $Reason = Get-EvidenceField $Record 'reason'
    if ($Result -ceq 'blocked' -and $Reason -is [string] -and -not [string]::IsNullOrWhiteSpace($Reason)) {
        return @{ status = 'blocked'; reason = 'The tester recorded a missing prerequisite.' }
    }
    $Build = Get-EvidenceField $Report 'windowsBuild'
    if ((Get-EvidenceField $Report 'runtime') -cne 'native' -or $Build -isnot [string] -or $Build -notmatch '^\d{5}(?:\.\d+)?$') {
        return @{ status = 'unverified'; reason = 'The lane lacks a native Windows build record.' }
    }
    if ($Result -ceq 'failed' -and $Reason -is [string] -and -not [string]::IsNullOrWhiteSpace($Reason)) {
        return @{ status = 'failed'; reason = 'The native licensed attempt recorded a failure.' }
    }
    if ($Result -ceq 'passed' -and -not $ClientConfigured) {
        return @{ status = 'unverified'; reason = 'The candidate lacks a packaged Microsoft public-client application ID.' }
    }

    $Game = Get-EvidenceField $Record 'gameVersion'
    $Loader = Get-EvidenceField $Record 'loaderVersion'
    $Java = Get-EvidenceField $Record 'java'
    $JavaMajor = Get-EvidenceField $Java 'major'
    $JavaPolicy = Get-EvidenceField $Java 'policy'
    $ValidGame = if ($Lane -eq 'vanilla') {
        $Game -is [string] -and $Game -match '^\d+(?:\.\d+)+$' -and (Get-EvidenceField $Record 'releaseType') -ceq 'release'
    } else { $Game -ceq $Version -and $Loader -is [string] -and $Loader -match '^[0-9][A-Za-z0-9.+-]{0,63}$' }
    $Checks = @('licensed-sign-in', 'install-or-import', 'progress', 'cancel-and-retry', 'repair',
        'world-entry', 'second-launch', 'selected-world-restore')
    if ($Lane -ne 'vanilla') { $Checks += @('compatible-content', 'content-interruption-and-retry') }
    if ($Result -cne 'passed' -or -not $ValidGame -or
        $JavaPolicy -cnotin @('managed', 'custom') -or ($JavaMajor -isnot [int] -and $JavaMajor -isnot [long]) -or
        $JavaMajor -lt 1 -or -not (Test-EvidenceChecks (Get-EvidenceField $Record 'checks') $Checks)) {
        return @{ status = 'unverified'; reason = 'The lane lacks exact selections or the required licensed outcomes.' }
    }
    return @{ status = 'passed'; gameVersion = $Game; loaderVersion = $Loader; java = @{ major = $JavaMajor; policy = $JavaPolicy } }
}

function Get-WindowsQualification([string] $Executable, [string] $EvidenceDirectory) {
    $Executable = (Resolve-Path -LiteralPath $Executable).Path
    $Candidate = Get-LauncherArtifacts $Executable
    $Client = Join-Path (Split-Path -Parent $Executable) "resources/$MinecraftClientFilename"
    $ClientConfigured = $false
    if ($Candidate.Contains('minecraftClient')) {
        $ClientId = [IO.File]::ReadAllText($Client).Trim()
        $Parsed = [guid]::Empty
        $ClientConfigured = [guid]::TryParseExact($ClientId, 'D', [ref] $Parsed)
    }
    $Authentication = if ($ClientConfigured) { @{ status = 'configured' } } else {
        @{ status = 'blocked'; reason = 'Package the approved Microsoft public-client application ID for Minecraft sign-in.' }
    }
    $FixtureReports = @()
    $Unreadable = $false
    if (Test-Path -LiteralPath $EvidenceDirectory -PathType Container) {
        $Folders = @($EvidenceDirectory) + @(Get-ChildItem -LiteralPath $EvidenceDirectory -Directory | ForEach-Object { $_.FullName })
        foreach ($Folder in $Folders) {
            $Path = Join-Path $Folder 'qualification.json'
            if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { continue }
            $Data = Read-EvidenceReport $Path
            if ($Data) { $FixtureReports += $Data } else { $Unreadable = $true }
        }
    }
    $LicensedPath = Join-Path $EvidenceDirectory 'licensed-minecraft.json'
    $HasLicensedReport = Test-Path -LiteralPath $LicensedPath -PathType Leaf
    $LicensedReport = if ($HasLicensedReport) { Read-EvidenceReport $LicensedPath }
    $Fixtures = [ordered]@{
        overlay = Get-NativeFixtureEvidence $FixtureReports 'Overlay' $Candidate $Unreadable
        launcher = Get-NativeFixtureEvidence $FixtureReports 'Launcher' $Candidate $Unreadable
    }
    $Lanes = [ordered]@{
        vanilla = Get-LicensedLaneEvidence $LicensedReport 'vanilla' '' $Candidate $HasLicensedReport $ClientConfigured
        fabric = Get-LicensedLaneEvidence $LicensedReport 'fabric' '1.21.1' $Candidate $HasLicensedReport $ClientConfigured
        forge = Get-LicensedLaneEvidence $LicensedReport 'forge' '1.20.1' $Candidate $HasLicensedReport $ClientConfigured
        neoforge = Get-LicensedLaneEvidence $LicensedReport 'neoforge' '1.21.1' $Candidate $HasLicensedReport $ClientConfigured
    }
    $Incomplete = @((@($Fixtures.Values) + @($Lanes.Values)) | Where-Object { $_.status -ne 'passed' })
    return [ordered]@{
        ready = $ClientConfigured -and $Incomplete.Count -eq 0
        artifacts = $Candidate; authentication = $Authentication; fixtures = $Fixtures; licensed = $Lanes
    }
}
