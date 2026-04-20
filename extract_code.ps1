param(
    # Varsayılan: bu script’in bulunduğu klasör (CEVIRI proje kökü)
    [string]$TargetPath = (Split-Path -Parent $PSCommandPath),
    # Çıktıyı dosyaya yazmak isterseniz: -OutFile out.txt
    [string]$OutFile = ""
)

$excludeDirFragments = @(
    '\.git\',
    '\node_modules\',
    '\dist\',
    '\.code-review-graph\'
)

$includeExt = @(
    '.ts', '.tsx', '.js', '.jsx', '.json',
    '.css', '.html', '.md',
    '.yml', '.yaml',
    '.ps1', '.sh',
    '.txt', '.env', '.gitignore'
)

if (-not (Test-Path -LiteralPath $TargetPath)) {
    throw "TargetPath bulunamadı: $TargetPath"
}

$files =
    Get-ChildItem -Path $TargetPath -Recurse -File |
    Where-Object {
        $full = $_.FullName
        foreach ($frag in $excludeDirFragments) {
            if ($full.Contains($frag)) { return $false }
        }
        $ext = $_.Extension.ToLowerInvariant()
        return ($includeExt -contains $ext) -or ($includeExt -contains $_.Name)
    } |
    Sort-Object FullName

if ($OutFile) {
    if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force }
    foreach ($f in $files) {
        Add-Content -LiteralPath $OutFile -Value ("--- FILE: " + $f.FullName)
        Add-Content -LiteralPath $OutFile -Value (Get-Content -LiteralPath $f.FullName -Raw)
        Add-Content -LiteralPath $OutFile -Value ""
    }
    Write-Host ("Yazıldı: " + (Resolve-Path -LiteralPath $OutFile))
    exit 0
}

foreach ($f in $files) {
    Write-Host ("--- FILE: " + $f.FullName)
    Get-Content -LiteralPath $f.FullName
    Write-Host ""
}
