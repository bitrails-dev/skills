<#
.SYNOPSIS
    Retrieves and displays installation commands for favorite agent skills.

.DESCRIPTION
    Get-SkillCommands is a maintenance and CLI utility that parses the skills
    registry (skills-registry.json) and outputs formatted, copy-pasteable
    commands for installing skills like gsd-core, mattpocock, and context-mode.
    It supports multiple installation methods (Skills CLI, npx skill install,
    and custom commands).

.PARAMETER Skill
    The ID or name of the skill to retrieve commands for (e.g. 'gsd-core', 'mattpocock', 'context-mode').

.PARAMETER All
    Switch to output commands for all registered skills.

.PARAMETER List
    Switch to list all skills currently registered in the catalog.

.PARAMETER Method
    Filter displayed commands by method: 'All' (default), 'Recommended', 'NpxSkills', 'NpxSkill', 'Custom'.

.PARAMETER Copy
    Copies the recommended installation command of the specified skill to the clipboard.

.EXAMPLE
    .\Get-SkillCommands.ps1 -Skill gsd-core
    Displays all installation commands and post-install steps for gsd-core.

.EXAMPLE
    .\Get-SkillCommands.ps1 -List
    Lists all skills registered in the registry.

.EXAMPLE
    .\Get-SkillCommands.ps1 -Skill mattpocock -Copy
    Displays commands for mattpocock and copies the primary command to the clipboard.

.EXAMPLE
    .\Get-SkillCommands.ps1 -All
    Displays commands for every registered skill.
#>

[CmdletBinding(DefaultParameterSetName = 'BySkill')]
param(
    [Parameter(Position = 0, ParameterSetName = 'BySkill', Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [string]$Skill,

    [Parameter(ParameterSetName = 'List', Mandatory = $true)]
    [switch]$List,

    [Parameter(ParameterSetName = 'All', Mandatory = $true)]
    [switch]$All,

    [Parameter(Mandatory = $false)]
    [ValidateSet('All', 'Recommended', 'NpxSkills', 'NpxSkill', 'Custom')]
    [string]$Method = 'All',

    [Parameter(Mandatory = $false)]
    [switch]$Copy
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Locate the registry relative to this script file
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RegistryPath = Join-Path -Path $ScriptDir -ChildPath '..\data\skills-registry.json'

if (-not (Test-Path -Path $RegistryPath)) {
    Write-Error "Skills registry file not found at: '$RegistryPath'"
    return
}

try {
    $RawJson = Get-Content -Path $RegistryPath -Raw -Encoding utf8
    $Registry = ConvertFrom-Json -InputObject $RawJson
}
catch {
    Write-Error "Failed to parse skills registry JSON: $_"
    return
}

$SkillsMap = $Registry.skills

# Helper to format a single skill's output
function Show-SkillEntry {
    param (
        [Parameter(Mandatory = $true)]
        [PSCustomObject]$Entry,
        [Parameter(Mandatory = $true)]
        [string]$SelectedMethod,
        [Parameter(Mandatory = $false)]
        [switch]$CopyToClipboard
    )

    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host " Skill: $($Entry.displayName) [$($Entry.id)]" -ForegroundColor Green
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host " Description: $($Entry.description)" -ForegroundColor Gray
    Write-Host " Repository:  $($Entry.repository)" -ForegroundColor DarkCyan
    Write-Host " Category:    $($Entry.category)" -ForegroundColor DarkYellow
    Write-Host "------------------------------------------------------------" -ForegroundColor DarkGray

    # Helper function to get property value safely
    function Get-PropValue {
        param($Obj, [string]$PropName)
        if ($null -ne $Obj -and $Obj.PSObject.Properties[$PropName]) {
            return $Obj.$PropName
        }
        return $null
    }

    $PrimaryCommandToCopy = $null

    # 1. Custom / Recommended Commands
    $customCmds = Get-PropValue $Entry 'customCommands'
    if ($customCmds -and ($SelectedMethod -in @('All', 'Recommended', 'Custom'))) {
        Write-Host "`n[Custom / Official Commands]:" -ForegroundColor Yellow
        foreach ($cmd in $customCmds) {
            $isRec = if (Get-PropValue $cmd 'recommended') { " (RECOMMENDED)" } else { "" }
            Write-Host "  - $(Get-PropValue $cmd 'name')$isRec" -ForegroundColor White
            Write-Host "    $(Get-PropValue $cmd 'command')" -ForegroundColor Magenta
            $desc = Get-PropValue $cmd 'description'
            if ($desc) {
                Write-Host "    Note: $desc" -ForegroundColor DarkGray
            }
            if ((Get-PropValue $cmd 'recommended') -and -not $PrimaryCommandToCopy) {
                $PrimaryCommandToCopy = Get-PropValue $cmd 'command'
            }
        }
    }

    # 2. Standard Skills CLI (npx skills add)
    $npxSkills = Get-PropValue $Entry 'npxSkills'
    if ($npxSkills -and ($SelectedMethod -in @('All', 'NpxSkills'))) {
        Write-Host "`n[Skills CLI (skills.sh Standard)]:" -ForegroundColor Yellow
        $globalCmd = Get-PropValue $npxSkills 'global'
        if ($globalCmd) {
            Write-Host "  Global Install:" -ForegroundColor White
            Write-Host "    $globalCmd" -ForegroundColor Magenta
            if (-not $PrimaryCommandToCopy) { $PrimaryCommandToCopy = $globalCmd }
        }
        $localCmd = Get-PropValue $npxSkills 'local'
        if ($localCmd) {
            Write-Host "  Project-Local Install:" -ForegroundColor White
            Write-Host "    $localCmd" -ForegroundColor Magenta
        }
        $specificEx = Get-PropValue $npxSkills 'specificExample'
        if ($specificEx) {
            Write-Host "  Specific Sub-Skill Example:" -ForegroundColor White
            Write-Host "    $specificEx" -ForegroundColor Magenta
        }
    }

    # 3. Shorthand npx skill install
    $npxSkillInstall = Get-PropValue $Entry 'npxSkillInstall'
    if ($npxSkillInstall -and ($SelectedMethod -in @('All', 'NpxSkill'))) {
        Write-Host "`n[Shorthand Installer (npx skill install)]:" -ForegroundColor Yellow
        Write-Host "  $(Get-PropValue $npxSkillInstall 'command')" -ForegroundColor Magenta
        $notes = Get-PropValue $npxSkillInstall 'notes'
        if ($notes) {
            Write-Host "  Note: $notes" -ForegroundColor DarkGray
        }
    }

    # 4. Post-Install Steps
    $postInstall = Get-PropValue $Entry 'postInstall'
    if ($postInstall) {
        Write-Host "`n[Post-Install Verification]:" -ForegroundColor Yellow
        foreach ($step in $postInstall) {
            Write-Host "  * $step" -ForegroundColor Cyan
        }
    }

    if ($CopyToClipboard -and $PrimaryCommandToCopy) {
        try {
            Set-Clipboard -Value $PrimaryCommandToCopy
            Write-Host "`n[✓] Copied to clipboard: '$PrimaryCommandToCopy'" -ForegroundColor Green
        }
        catch {
            Write-Warning "Could not copy to clipboard: $_"
        }
    }
}

# Handle -List switch
if ($List) {
    Write-Host "`nRegistered Favorite Skills in catalog:" -ForegroundColor Cyan
    Write-Host "------------------------------------------------------------" -ForegroundColor DarkGray
    foreach ($property in $SkillsMap.PSObject.Properties) {
        $entry = $property.Value
        Write-Host ("  {0,-15} : {1}" -f $entry.id, $entry.displayName) -ForegroundColor White
    }
    Write-Host "------------------------------------------------------------" -ForegroundColor DarkGray
    Write-Host "Run with -Skill <id> to view commands or edit 'data/skills-registry.json' to add more.`n" -ForegroundColor Gray
    return
}

# Handle -All switch
if ($All) {
    foreach ($property in $SkillsMap.PSObject.Properties) {
        Show-SkillEntry -Entry $property.Value -SelectedMethod $Method -CopyToClipboard:$false
    }
    Write-Host ""
    return
}

# Handle single skill
if ([string]::IsNullOrWhiteSpace($Skill)) {
    # If no skill passed, show usage and list
    Write-Host "`nNo skill specified. Available skills:" -ForegroundColor Yellow
    foreach ($property in $SkillsMap.PSObject.Properties) {
        $entry = $property.Value
        Write-Host ("  - {0,-15} ({1})" -f $entry.id, $entry.displayName) -ForegroundColor White
    }
    Write-Host "`nUsage:" -ForegroundColor Gray
    Write-Host "  .\Get-SkillCommands.ps1 -Skill gsd-core" -ForegroundColor Gray
    Write-Host "  .\Get-SkillCommands.ps1 -All" -ForegroundColor Gray
    Write-Host "  .\Get-SkillCommands.ps1 -List`n" -ForegroundColor Gray
    return
}

$NormalizedKey = $Skill.Trim().ToLowerInvariant()
$MatchedEntry = $null

foreach ($property in $SkillsMap.PSObject.Properties) {
    if ($property.Name.ToLowerInvariant() -eq $NormalizedKey -or $property.Value.id.ToLowerInvariant() -eq $NormalizedKey) {
        $MatchedEntry = $property.Value
        break
    }
}

if (-not $MatchedEntry) {
    Write-Error "Skill '$Skill' not found in registry. Use -List to inspect registered skills."
    return
}

Show-SkillEntry -Entry $MatchedEntry -SelectedMethod $Method -CopyToClipboard:$Copy
