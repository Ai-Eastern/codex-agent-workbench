param(
  [Parameter(Mandatory=$true)][string]$CodexRoot,
  [Parameter(Mandatory=$true)][string]$NodePath,
  [switch]$DisableLegacy
)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$codexDirectory = [IO.Path]::GetFullPath($CodexRoot)
$skillDirectory = Join-Path $codexDirectory 'skills'
$source = Join-Path $repository 'skills/codex-project-workbench'
$target = Join-Path $skillDirectory 'codex-project-workbench'
if (!(Test-Path -LiteralPath (Join-Path $source 'SKILL.md'))) { throw 'Source Skill missing' }
if (!(Test-Path -LiteralPath $NodePath)) { throw 'Node executable missing' }
if (Test-Path -LiteralPath $target) { throw 'New Skill is already installed; compare and explicitly update it instead of overwriting' }
$legacy = @('eastern-general-manager','eastern-project-dispatcher','eastern-task-dispatcher','eastern-worker','eastern-reviewer')
$backup = Join-Path $codexDirectory ('disabled-skills/legacy-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$records = @()
if ($DisableLegacy) {
  foreach ($name in $legacy) {
    $oldPath = [IO.Path]::GetFullPath((Join-Path $skillDirectory $name))
    if (!$oldPath.StartsWith($skillDirectory + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Legacy source escapes Skill root' }
    if (Test-Path -LiteralPath $oldPath) {
      if ((Get-Item -LiteralPath $oldPath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Legacy Skill root is a link' }
      $files = @(Get-ChildItem -LiteralPath $oldPath -Recurse -File | ForEach-Object {
        if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Legacy Skill contains a link' }
        @{ relative=[IO.Path]::GetRelativePath($oldPath,$_.FullName); sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
      })
      $records += @{name=$name; original=$oldPath; backup=(Join-Path $backup $name); files=$files}
    }
  }
}
New-Item -ItemType Directory -Path $skillDirectory -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Recurse
$registry = Join-Path $repository '.local/projects.json'
@{ schemaVersion=1; repository=$repository; node=[IO.Path]::GetFullPath($NodePath); cli=(Join-Path $repository 'src/cli.mjs'); registry=$registry } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $target 'runtime.json') -Encoding utf8
if ($DisableLegacy) {
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  @{createdAt=(Get-Date -Format o); installed=$target; legacy=$records} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $backup 'manifest.json') -Encoding utf8
  foreach ($record in $records) {
    $destination = [IO.Path]::GetFullPath($record.backup)
    if (!$destination.StartsWith([IO.Path]::GetFullPath($backup) + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Backup target escapes named backup directory' }
    Move-Item -LiteralPath $record.original -Destination $destination
    foreach ($file in $record.files) {
      if ((Get-FileHash -LiteralPath (Join-Path $destination $file.relative) -Algorithm SHA256).Hash -ne $file.sha256) { throw 'Legacy backup verification failed' }
    }
  }
}
@{status='INSTALLED'; skill=$target; disabled=@($records | ForEach-Object {$_.name}); backup=$(if($DisableLegacy){$backup}else{$null}); note='Existing conversation prompts remain in history; explicitly read the new entry on the next turn.'} | ConvertTo-Json -Depth 5
