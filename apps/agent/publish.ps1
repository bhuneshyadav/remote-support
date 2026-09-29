param(
    [Parameter(Mandatory = $true)]
    [string]$SupportApiBaseUrl
)

$apiUri = $null
if (
    -not [Uri]::TryCreate($SupportApiBaseUrl, [UriKind]::Absolute, [ref]$apiUri) -or
    $apiUri.Scheme -ne [Uri]::UriSchemeHttps -or
    $apiUri.AbsolutePath -ne "/" -or
    $apiUri.Query -or
    $apiUri.Fragment
) {
    throw "SupportApiBaseUrl must be an HTTPS origin, such as https://api.example.com."
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outputDirectory = Join-Path $PSScriptRoot "..\..\artifacts\RemoteSupportAgent-$stamp"
$archivePath = Join-Path $PSScriptRoot "..\..\artifacts\RemoteSupportAgent-$stamp.zip"
$projectPath = Join-Path $PSScriptRoot "RemoteSupportAgent.csproj"

dotnet publish $projectPath --configuration Release --runtime win-x64 --self-contained true --output $outputDirectory
if ($LASTEXITCODE -ne 0) {
    throw "The Windows agent publish failed."
}

@{
    RemoteSupportApiBaseUrl = $apiUri.GetLeftPart([UriPartial]::Authority)
} | ConvertTo-Json | Set-Content -Path (Join-Path $outputDirectory "appsettings.json") -Encoding utf8

Compress-Archive -Path (Join-Path $outputDirectory "*") -DestinationPath $archivePath -CompressionLevel Optimal
Write-Host "Agent package created: $archivePath"
