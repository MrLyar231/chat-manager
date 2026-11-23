param(
  [string]$Token = $env:RENDER_TOKEN,
  [string]$RepoUrl = 'https://github.com/MrLyar231/chat-manager'
)

$ErrorActionPreference = 'Stop'
$headers = @{ Authorization = "Bearer $Token"; 'Content-Type' = 'application/json' }
$base = 'https://api.render.com/v1'

function Api($method, $path, $body) {
  $params = @{ Method = $method; Uri = "$base$path"; Headers = $headers; TimeoutSec = 60 }
  if ($body) { $params.Body = ($body | ConvertTo-Json -Depth 10) }
  try {
    $r = Invoke-RestMethod @params
    return $r
  } catch {
    Write-Host "API ERROR $method $path : $($_.Exception.Message)"
    if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
    throw
  }
}

Write-Host '1) Owners...'
$owners = Api 'GET' '/owners'
$owners | ConvertTo-Json -Depth 6
$ownerId = $owners[0].owner.id

Write-Host "2) Creating web service for owner $ownerId..."
$serviceBody = @{
  type = 'web_service'
  name = 'chat-manager'
  ownerId = $ownerId
  repo = $RepoUrl
  branch = 'main'
  serviceDetails = @{
    runtime = 'node'
    plan = 'free'
    repo = $RepoUrl
    branch = 'main'
    rootDir = 'server'
    envSpecificDetails = @{
      buildCommand = 'npm install && cd ../client && npm install && npm run build'
      startCommand = 'npm start'
    }
    envVars = @(
      @{ key = 'DB_PATH'; value = '/data/chat.db' },
      @{ key = 'CLIENT_DIST'; value = '../client/dist' },
      @{ key = 'JWT_SECRET'; value = (-join ((48..57) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })) }
    )
  }
}
$service = Api 'POST' '/services' $serviceBody
$service | ConvertTo-Json -Depth 8
