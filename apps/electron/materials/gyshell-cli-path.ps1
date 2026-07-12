param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Add', 'Remove')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [ValidateSet('User', 'Machine')]
  [string]$Scope,

  [Parameter(Mandatory = $true)]
  [string]$Entry
)

$ErrorActionPreference = 'Stop'

function Normalize-PathEntry([string]$Value) {
  if ($null -eq $Value) { return '' }
  return $Value.Trim().Trim('"').TrimEnd('\')
}

if ([string]::IsNullOrWhiteSpace($Entry)) {
  throw 'The GyShell CLI PATH entry cannot be empty.'
}

$normalizedEntry = Normalize-PathEntry $Entry
$hive = if ($Scope -eq 'Machine') {
  [Microsoft.Win32.Registry]::LocalMachine
} else {
  [Microsoft.Win32.Registry]::CurrentUser
}
$subKey = if ($Scope -eq 'Machine') {
  'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
} else {
  'Environment'
}

$key = $hive.OpenSubKey($subKey, $true)
if ($null -eq $key) {
  throw "Unable to open the $Scope environment registry key."
}

try {
  $rawPath = [string]$key.GetValue(
    'Path',
    '',
    [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
  )
  try {
    $valueKind = $key.GetValueKind('Path')
  } catch {
    $valueKind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  }
  if ($valueKind -ne [Microsoft.Win32.RegistryValueKind]::String -and
      $valueKind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) {
    $valueKind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  }

  $parts = @($rawPath.Split([char]';'))
  $matchingIndexes = @()
  for ($index = 0; $index -lt $parts.Count; $index += 1) {
    if ([string]::Equals(
      (Normalize-PathEntry $parts[$index]),
      $normalizedEntry,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
      $matchingIndexes += $index
    }
  }

  if ($Action -eq 'Add') {
    if ($matchingIndexes.Count -eq 0) {
      $nextPath = if ([string]::IsNullOrEmpty($rawPath)) {
        $Entry
      } elseif ($rawPath.EndsWith(';')) {
        "$rawPath$Entry"
      } else {
        "$rawPath;$Entry"
      }
      $key.SetValue('Path', $nextPath, $valueKind)
      Write-Output "Added GyShell CLI to $Scope PATH."
    } elseif ($matchingIndexes.Count -gt 1) {
      $firstMatch = $matchingIndexes[0]
      $kept = @(
        for ($index = 0; $index -lt $parts.Count; $index += 1) {
          if (($matchingIndexes -notcontains $index) -or $index -eq $firstMatch) {
            $parts[$index]
          }
        }
      )
      $nextPath = [string]::Join(';', [string[]]$kept)
      $key.SetValue('Path', $nextPath, $valueKind)
      Write-Output "Removed duplicate GyShell CLI entries from $Scope PATH."
    } else {
      Write-Output "GyShell CLI is already present in $Scope PATH."
    }
  } else {
    if ($matchingIndexes.Count -gt 0) {
      $kept = @(
        for ($index = 0; $index -lt $parts.Count; $index += 1) {
          if ($matchingIndexes -notcontains $index) { $parts[$index] }
        }
      )
      $nextPath = [string]::Join(';', [string[]]$kept)
      $key.SetValue('Path', $nextPath, $valueKind)
      Write-Output "Removed GyShell CLI from $Scope PATH."
    } else {
      Write-Output "GyShell CLI was not present in $Scope PATH."
    }
  }
} finally {
  $key.Dispose()
}
