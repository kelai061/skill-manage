param([Parameter(Mandatory = $true)][string]$Payload)
$ErrorActionPreference = 'Stop'
$taskUpdate = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
$taskChanged = [Collections.Generic.List[object]]::new()
$taskRestart = $null
$taskWaitingDone = $false

function Inside-Path([string]$base, [string]$relative) {
  $resolved = [IO.Path]::GetFullPath((Join-Path $base $relative))
  $prefix = [IO.Path]::GetFullPath($base).TrimEnd('\') + '\'
  if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escaped update directory' }
  return $resolved
}

function Assert-NoLink([string]$location) {
  $itemPath = [IO.Path]::GetFullPath($location)
  while ($itemPath) {
    if ((Test-Path -LiteralPath $itemPath) -and ((Get-Item -LiteralPath $itemPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'Update destination contains a link'
    }
    $parent = [IO.Path]::GetDirectoryName($itemPath)
    if ($parent -eq $itemPath) { break }
    $itemPath = $parent
  }
}

function Copy-Retry([string]$source, [string]$destination) {
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try { Copy-Item -LiteralPath $source -Destination $destination -Force; return }
    catch { if ($attempt -eq 59) { throw }; Start-Sleep -Milliseconds 250 }
  }
}

try {
  $taskJob = [IO.Path]::GetFullPath($taskUpdate.job)
  $taskFile = Inside-Path $taskJob ([IO.Path]::GetFileName($taskUpdate.file))
  if ($taskFile -ne $taskUpdate.file) { throw 'Invalid update file' }
  $taskStream = [IO.File]::OpenRead($taskFile)
  $taskSha = [Security.Cryptography.SHA256]::Create()
  try { $taskDigest = [BitConverter]::ToString($taskSha.ComputeHash($taskStream)).Replace('-', '').ToLowerInvariant() }
  finally { $taskStream.Dispose(); $taskSha.Dispose() }
  if ($taskDigest -ne $taskUpdate.checksum) { throw 'Checksum mismatch' }
  $taskTarget = [IO.Path]::GetFullPath($taskUpdate.target)
  if ($taskTarget.TrimEnd('\') -eq [IO.Path]::GetPathRoot($taskTarget).TrimEnd('\')) { throw 'Invalid destination' }
  Assert-NoLink $taskTarget

  if ($taskUpdate.mode -eq 'directory') {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $taskExpanded = Inside-Path $taskJob 'expanded'
    New-Item -ItemType Directory -Path $taskExpanded | Out-Null
    $taskArchive = [IO.Compression.ZipFile]::OpenRead($taskFile)
    try {
      if ($taskArchive.Entries.Count -gt 20000) { throw 'Too many archive entries' }
      [long]$taskUnpacked = 0
      foreach ($entry in $taskArchive.Entries) {
        $entryPath = $entry.FullName.Replace('/', '\')
        if ($entryPath -notmatch '^SkillAtelier\\' -or $entryPath -match '(^|\\)(\.\.?|SkillAtelier-data|\.git|\.env)(\\|$)' -or $entryPath.Contains(':')) { throw 'Invalid archive path' }
        if ((($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Archive contains a link' }
        $null = Inside-Path $taskExpanded $entryPath
        $taskUnpacked += $entry.Length
        if ($taskUnpacked -gt 2147483648) { throw 'Archive is too large' }
      }
    } finally { $taskArchive.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($taskFile, $taskExpanded)
    $taskSource = Inside-Path $taskExpanded 'SkillAtelier'
    $taskPackage = Get-Content -LiteralPath (Join-Path $taskSource 'resources\app\package.json') -Raw | ConvertFrom-Json
    if ($taskPackage.version -ne $taskUpdate.version -or -not (Test-Path -LiteralPath (Join-Path $taskSource 'SkillAtelier.exe'))) { throw 'Archive version mismatch' }
    $taskRestart = Join-Path $taskTarget 'SkillAtelier.exe'
    if (-not (Test-Path -LiteralPath $taskRestart)) { throw 'Existing app was not found' }
  } elseif ($taskUpdate.mode -eq 'portable') {
    if (-not (Test-Path -LiteralPath $taskTarget -PathType Leaf)) { throw 'Existing portable executable was not found' }
    $taskRestart = $taskTarget
  } elseif ($taskUpdate.mode -eq 'setup') {
    $taskRestart = Join-Path $taskTarget 'SkillAtelier.exe'
    if (-not (Test-Path -LiteralPath $taskRestart)) { throw 'Existing installation was not found' }
  } else { throw 'Unknown installation type' }

  # A handshake keeps the running application open if preparation fails.
  [IO.File]::WriteAllText($taskUpdate.armed, 'ready')
  $taskParent = Get-Process -Id $taskUpdate.parentPid -ErrorAction SilentlyContinue
  if ($taskParent) { $taskParent.WaitForExit() }
  $taskWaitingDone = $true

  if ($taskUpdate.mode -eq 'setup') {
    $taskInstaller = Start-Process -FilePath $taskFile -ArgumentList @('/S', '--updated', ('/D=' + $taskTarget)) -WindowStyle Hidden -Wait -PassThru
    if ($taskInstaller.ExitCode -ne 0) { throw ('Installer failed: ' + $taskInstaller.ExitCode) }
  } elseif ($taskUpdate.mode -eq 'portable') {
    $taskBackup = Inside-Path $taskJob 'previous.exe'
    Copy-Retry $taskTarget $taskBackup
    $taskChanged.Add(@{ destination = $taskTarget; backup = $taskBackup })
    Copy-Retry $taskFile $taskTarget
  } else {
    $taskBackupRoot = Inside-Path $taskJob 'backup'
    foreach ($entry in Get-ChildItem -LiteralPath $taskSource -Recurse -File -Force) {
      $relative = $entry.FullName.Substring($taskSource.Length + 1)
      $destination = Inside-Path $taskTarget $relative
      Assert-NoLink $destination
      if (Test-Path -LiteralPath $destination -PathType Container) { throw 'Destination is a directory' }
      $backup = $null
      if (Test-Path -LiteralPath $destination) {
        $backup = Inside-Path $taskBackupRoot $relative
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($backup)) -Force | Out-Null
        Copy-Retry $destination $backup
      }
      $taskChanged.Add(@{ destination = $destination; backup = $backup })
      New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
      Copy-Retry $entry.FullName $destination
    }
  }
  @{ success = $true; version = $taskUpdate.version } | ConvertTo-Json | Set-Content -LiteralPath $taskUpdate.result -Encoding UTF8
} catch {
  $taskFailure = $_.Exception.Message
  $taskRollbackFailed = $false
  for ($i = $taskChanged.Count - 1; $i -ge 0; $i--) {
    $change = $taskChanged[$i]
    try {
      if ($change.backup) { Copy-Retry $change.backup $change.destination }
      elseif (Test-Path -LiteralPath $change.destination -PathType Leaf) { Remove-Item -LiteralPath $change.destination -Force }
    } catch { $taskRollbackFailed = $true }
  }
  @{ success = $false; version = $taskUpdate.version; error = $taskFailure; rollbackFailed = $taskRollbackFailed } |
    ConvertTo-Json | Set-Content -LiteralPath $taskUpdate.result -Encoding UTF8
} finally {
  if ($taskWaitingDone -and $taskRestart -and (Test-Path -LiteralPath $taskRestart)) {
    foreach ($name in @('ELECTRON_RUN_AS_NODE', 'PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_APP_FILENAME')) {
      [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    try {
      $null = Start-Process -FilePath $taskRestart -WorkingDirectory ([IO.Path]::GetDirectoryName($taskRestart)) -WindowStyle Hidden -PassThru
      [IO.File]::WriteAllText((Join-Path $taskJob 'restarted'), 'started')
    } catch {
      @{ success = $false; version = $taskUpdate.version; error = ('Restart failed: ' + $_.Exception.Message) } |
        ConvertTo-Json | Set-Content -LiteralPath $taskUpdate.result -Encoding UTF8
    }
  }
}
