$targetPath = 'c:\Users\Bremer\1\FilterKonfiguratorSearch'
$files = Get-ChildItem -Path $targetPath -Recurse -File | Where-Object { $_.FullName -notmatch '\.code-review-graph' }
foreach ($f in $files) {
    Write-Host ("--- FILE: " + $f.FullName)
    Get-Content $f.FullName
    Write-Host ""
}
