param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $scriptDir "config.json"
$hudPath = Join-Path $scriptDir "hud.js"
$logDir = Join-Path $scriptDir "logs"
$logPath = Join-Path $logDir "launcher.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
if (-not (Test-Path -LiteralPath $logPath)) {
  New-Item -ItemType File -Path $logPath | Out-Null
}

function Write-Log([string]$message) {
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $message
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Fail([string]$message) {
  Write-Log "ERROR $message"
  exit 1
}

try {
  if (-not (Test-Path -LiteralPath $configPath)) { Fail "Missing config.json" }
  if (-not (Test-Path -LiteralPath $hudPath)) { Fail "Missing hud.js" }
  $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
  $requestedPort = [int]$config.debugPort
  if ($requestedPort -lt 1024 -or $requestedPort -gt 65535) { Fail "debugPort must be between 1024 and 65535" }
  $pollIntervalMs = [Math]::Max(1000, [int]$config.pollIntervalMs)
  $hotReloadProperty = $config.PSObject.Properties["hotReload"]
  if ($null -ne $hotReloadProperty -and $hotReloadProperty.Value -isnot [bool]) {
    Fail "hotReload must be true or false"
  }
  $hotReload = $null -eq $hotReloadProperty -or [bool]$hotReloadProperty.Value
} catch {
  Fail "Invalid configuration: $($_.Exception.Message)"
}

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\codex-hud-launcher", [ref]$createdNew)
if (-not $createdNew) {
  Write-Log "Another launcher instance is already running"
  exit 0
}

function Get-MainCodexProcess {
  @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" -ErrorAction SilentlyContinue) |
    Where-Object {
      $_.ExecutablePath -match "(?i)(OpenAI\.Codex|OpenAI\\Codex)" -and
      $_.CommandLine -notmatch "(?:^|\s)--type="
    } |
    Select-Object -First 1
}

function Get-DebugPortFromProcess($process) {
  if ($null -ne $process -and $process.CommandLine -match "--remote-debugging-port(?:=|\s+)(\d+)") {
    return [int]$Matches[1]
  }
  return 0
}

function Add-WindowControlType {
  if (("CodexHud.WindowControls" -as [type])) { return }
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace CodexHud {
  public static class WindowControls {
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr64(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern IntPtr SetWindowLongPtr64(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    public static bool EnsureSystemMenu(IntPtr window) {
      if (window == IntPtr.Zero) return false;
      const int GWL_STYLE = -16;
      const long WS_SYSMENU = 0x00080000L;
      const uint FLAGS = 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020;
      long style = GetWindowLongPtr64(window, GWL_STYLE).ToInt64();
      if ((style & WS_SYSMENU) == 0) {
        SetWindowLongPtr64(window, GWL_STYLE, new IntPtr(style | WS_SYSMENU));
        SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, FLAGS);
        return true;
      }
      return false;
    }
  }
}
"@
}

function Ensure-CodexWindowControls($process) {
  if ($null -eq $process) { return }
  try {
    Add-WindowControlType
    $nativeProcess = Get-Process -Id $process.ProcessId -ErrorAction Stop
    if ([CodexHud.WindowControls]::EnsureSystemMenu($nativeProcess.MainWindowHandle)) {
      Write-Log "Ensured native window controls for Codex process $($process.ProcessId)"
    }
  } catch {
    Write-Log "Window control repair skipped: $($_.Exception.Message)"
  }
}

function Test-LoopbackPort([int]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync("127.0.0.1", $port)
    return $task.Wait(400) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Get-CdpTargets([int]$port) {
  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.UseProxy = $false
  $client = New-Object System.Net.Http.HttpClient($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(2)
  try {
    $json = $client.GetStringAsync("http://127.0.0.1:$port/json").GetAwaiter().GetResult()
    return @($json | ConvertFrom-Json)
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }
}

function Select-CodexTarget($targets) {
  $pages = @($targets | Where-Object {
    $_.type -eq "page" -and
    $_.webSocketDebuggerUrl -and
    $_.url -match "^app://-/index\.html" -and
    $_.url -notmatch "(?i)(avatar-overlay|quick-chat)"
  })
  if (-not $pages) { return $null }
  return $pages | Sort-Object @{ Expression = { if ($_.url -eq "app://-/index.html") { 0 } else { 1 } } } | Select-Object -First 1
}

function Add-ActivationType {
  if (("CodexHud.NativeActivation" -as [type])) { return }
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace CodexHud {
  [Flags]
  public enum ActivateOptions : uint { None = 0 }

  [ComImport, Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IApplicationActivationManager {
    [PreserveSig]
    int ActivateApplication(
      [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
      [MarshalAs(UnmanagedType.LPWStr)] string arguments,
      ActivateOptions options,
      out uint processId);
    [PreserveSig]
    int ActivateForFile(IntPtr appUserModelId, IntPtr itemArray, IntPtr verb, out uint processId);
    [PreserveSig]
    int ActivateForProtocol(IntPtr appUserModelId, IntPtr itemArray, out uint processId);
  }

  public static class NativeActivation {
    public static uint Activate(string appUserModelId, string arguments) {
      Type type = Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C"));
      object instance = Activator.CreateInstance(type);
      try {
        IApplicationActivationManager manager = (IApplicationActivationManager)instance;
        uint processId;
        int result = manager.ActivateApplication(appUserModelId, arguments, ActivateOptions.None, out processId);
        Marshal.ThrowExceptionForHR(result);
        return processId;
      } finally {
        if (instance != null && Marshal.IsComObject(instance)) Marshal.FinalReleaseComObject(instance);
      }
    }
  }
}
"@
}

function Find-CodexPackage {
  $packages = foreach ($name in @("OpenAI.Codex", "OpenAI.CodexBeta", "OpenAI.ChatGPT-Desktop")) {
    Get-AppxPackage -Name $name -ErrorAction SilentlyContinue
  }
  return @($packages) | Sort-Object Version -Descending | Select-Object -First 1
}

function Start-CodexWithCdp([int]$port) {
  $arguments = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$port --remote-allow-origins=http://127.0.0.1:$port"
  $configuredPath = [string]$config.codexPath
  if ($configuredPath -and (Test-Path -LiteralPath $configuredPath -PathType Leaf)) {
    $process = Start-Process -FilePath $configuredPath -ArgumentList $arguments -PassThru
    Write-Log "Started standalone Codex process $($process.Id) on CDP port $port"
    return
  }

  $package = Find-CodexPackage
  if (-not $package) { Fail "No supported Codex Microsoft Store package was found" }
  Add-ActivationType
  $appUserModelId = "$($package.PackageFamilyName)!App"
  $processId = [CodexHud.NativeActivation]::Activate($appUserModelId, $arguments)
  Write-Log "Activated package $($package.Name) as process $processId on CDP port $port"
}

function Assert-SafeWebSocketUrl([string]$url, [int]$port) {
  $uri = [Uri]$url
  if ($uri.Scheme -notin @("ws", "wss")) { throw "Unsafe CDP WebSocket scheme" }
  $address = $null
  if (-not [System.Net.IPAddress]::TryParse($uri.Host, [ref]$address) -or -not [System.Net.IPAddress]::IsLoopback($address)) {
    throw "CDP WebSocket is not bound to loopback"
  }
  if ($uri.Port -ne $port) { throw "CDP WebSocket port mismatch" }
}

function Receive-CdpResponse($socket, [int]$commandId) {
  while ($true) {
    $stream = New-Object System.IO.MemoryStream
    try {
      do {
        $buffer = New-Object byte[] 65536
        $segment = [ArraySegment[byte]]::new($buffer)
        $result = $socket.ReceiveAsync($segment, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
        if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
          throw "CDP WebSocket closed before command response"
        }
        $stream.Write($buffer, 0, $result.Count)
      } while (-not $result.EndOfMessage)
      $text = [Text.Encoding]::UTF8.GetString($stream.ToArray())
      $message = $text | ConvertFrom-Json
      $idProperty = $message.PSObject.Properties["id"]
      if ($null -ne $idProperty -and [int]$idProperty.Value -eq $commandId) {
        $errorProperty = $message.PSObject.Properties["error"]
        if ($null -ne $errorProperty -and $null -ne $errorProperty.Value) {
          throw "CDP error: $($errorProperty.Value.message)"
        }
        return $message
      }
    } finally {
      $stream.Dispose()
    }
  }
}

function Send-CdpCommand($socket, [int]$id, [string]$method, $parameters) {
  $payload = @{ id = $id; method = $method; params = $parameters } | ConvertTo-Json -Compress -Depth 20
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $segment = [ArraySegment[byte]]::new($bytes)
  $null = $socket.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  return Receive-CdpResponse $socket $id
}

$sessionRoot = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".codex\sessions"
$rolloutPathCache = @{}
$rolloutSnapshotCache = @{}

function Get-CdpValue($response) {
  $outer = $response.PSObject.Properties["result"]
  if ($null -eq $outer -or $null -eq $outer.Value) { return $null }
  $inner = $outer.Value.PSObject.Properties["result"]
  if ($null -eq $inner -or $null -eq $inner.Value) { return $null }
  $value = $inner.Value.PSObject.Properties["value"]
  if ($null -eq $value) { return $null }
  return $value.Value
}

function Get-TextSha256([string]$text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($text)
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "")
  } finally {
    $sha.Dispose()
  }
}

function Find-RolloutFile([string]$threadId) {
  if ($threadId -notmatch "^[0-9a-fA-F-]{36}$" -or -not (Test-Path -LiteralPath $sessionRoot -PathType Container)) {
    return $null
  }
  if ($rolloutPathCache.ContainsKey($threadId)) {
    $cachedPath = [string]$rolloutPathCache[$threadId]
    if (Test-Path -LiteralPath $cachedPath -PathType Leaf) { return $cachedPath }
    $rolloutPathCache.Remove($threadId)
  }
  $file = Get-ChildItem -LiteralPath $sessionRoot -Recurse -Filter "rollout-*$threadId*.jsonl" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($file) {
    $rolloutPathCache[$threadId] = $file.FullName
    return $file.FullName
  }
  return $null
}

function Get-RolloutSnapshot([string]$threadId) {
  $path = Find-RolloutFile $threadId
  if (-not $path) { return $null }
  $file = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
  if (-not $file) { return $null }
  if ($rolloutSnapshotCache.ContainsKey($path)) {
    $cached = $rolloutSnapshotCache[$path]
    if ([long]$cached.Length -eq [long]$file.Length) { return $cached.Snapshot }
  }

  $lastToken = $null
  $lastModel = ""
  $stream = $null
  $reader = $null
  try {
    $stream = New-Object System.IO.FileStream(
      $path,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
    )
    $reader = New-Object System.IO.StreamReader($stream, [Text.Encoding]::UTF8, $true)
    while (($line = $reader.ReadLine()) -ne $null) {
      if ($line.IndexOf('"type":"token_count"', [StringComparison]::Ordinal) -ge 0) {
        try {
          $row = $line | ConvertFrom-Json
          if ($row.payload.type -eq "token_count" -and $row.payload.info) { $lastToken = $row.payload }
        } catch {}
      } elseif ($line.IndexOf('"type":"turn_context"', [StringComparison]::Ordinal) -ge 0) {
        try {
          $row = $line | ConvertFrom-Json
          if ($row.payload.model) { $lastModel = [string]$row.payload.model }
        } catch {}
      }
    }
  } finally {
    if ($reader) { $reader.Dispose() }
    if ($stream) { $stream.Dispose() }
  }
  if (-not $lastToken) { return $null }
  $snapshot = @{ model = $lastModel; payload = $lastToken }
  $rolloutSnapshotCache[$path] = @{ Length = [long]$file.Length; Snapshot = $snapshot }
  return $snapshot
}

function Install-Hud([string]$webSocketUrl, [string]$source, [bool]$installForNewDocuments, [bool]$forceReload, [int]$port) {
  Assert-SafeWebSocketUrl $webSocketUrl $port
  $socket = New-Object System.Net.WebSockets.ClientWebSocket
  try {
    $socket.Options.Proxy = $null
    $null = $socket.ConnectAsync([Uri]$webSocketUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    $id = 1
    Send-CdpCommand $socket $id "Runtime.enable" @{} | Out-Null
    if ($installForNewDocuments) {
      $id++
      Send-CdpCommand $socket $id "Page.addScriptToEvaluateOnNewDocument" @{ source = $source } | Out-Null
    }
    $id++
    $evaluationSource = $source
    if ($forceReload) {
      $evaluationSource = "try { window.__codexHud?.destroy?.(); } catch {}`n$source"
    }
    $response = Send-CdpCommand $socket $id "Runtime.evaluate" @{
      expression = $evaluationSource
      returnByValue = $true
      awaitPromise = $false
    }
    $resultProperty = $response.PSObject.Properties["result"]
    if ($null -eq $resultProperty -or $null -eq $resultProperty.Value) {
      throw "CDP Runtime.evaluate returned no result"
    }
    $exceptionProperty = $resultProperty.Value.PSObject.Properties["exceptionDetails"]
    if ($null -ne $exceptionProperty -and $null -ne $exceptionProperty.Value) {
      throw "HUD evaluation failed: $($exceptionProperty.Value.text)"
    }
    $id++
    $threadResponse = Send-CdpCommand $socket $id "Runtime.evaluate" @{
      expression = 'document.querySelector(''[data-app-action-sidebar-thread-selected="true"][data-app-action-sidebar-thread-id]'')?.getAttribute(''data-app-action-sidebar-thread-id'')?.replace(/^local:/, '''') || '''''
      returnByValue = $true
    }
    $threadId = [string](Get-CdpValue $threadResponse)
    $snapshot = Get-RolloutSnapshot $threadId
    $usageLoaded = $false
    if ($snapshot) {
      $snapshotJson = $snapshot | ConvertTo-Json -Compress -Depth 20
      $id++
      Send-CdpCommand $socket $id "Runtime.evaluate" @{
        expression = "window.__codexHud?.inspect($snapshotJson)"
        returnByValue = $false
      } | Out-Null
      $usageLoaded = $true
    }
    $null = $socket.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "done", [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    return [pscustomobject]@{ ThreadId = $threadId; UsageLoaded = $usageLoaded }
  } finally {
    $socket.Dispose()
  }
}

try {
  Write-Log "Launcher started"
  $runtimeConfig = @{ prices = $config.prices } | ConvertTo-Json -Compress -Depth 20
  $hudSource = ""
  $hudRevision = ""

  $mainProcess = Get-MainCodexProcess
  if ($mainProcess) {
    $debugPort = Get-DebugPortFromProcess $mainProcess
    if (-not $debugPort) {
      Fail "Codex is already running without CDP. Exit Codex completely, then run this launcher again."
    }
    Write-Log "Attaching to running Codex process $($mainProcess.ProcessId) on CDP port $debugPort"
  } else {
    $debugPort = $requestedPort
    if (Test-LoopbackPort $debugPort) { Fail "Configured CDP port $debugPort is already in use" }
    Start-CodexWithCdp $debugPort
  }
  Ensure-CodexWindowControls $mainProcess

  $targetRevisions = @{}
  $observedCodex = $false
  $startupDeadline = (Get-Date).AddSeconds(25)
  $missingStreak = 0
  $lastLoggedThreadId = ""

  while ($true) {
    try {
      Ensure-CodexWindowControls (Get-MainCodexProcess)
      if (-not $hudRevision -or $hotReload) {
        $nextSource = Get-Content -Raw -Encoding UTF8 -LiteralPath $hudPath
        $nextRevision = Get-TextSha256 $nextSource
        if ($nextRevision -ne $hudRevision) {
          $nextSource = $nextSource.Replace("__CODEX_HUD_CONFIG__", $runtimeConfig)
          if ($hudRevision) { Write-Log "hud.js change detected; scheduling hot reload" }
          $hudSource = $nextSource
          $hudRevision = $nextRevision
        }
      }
      $targets = Get-CdpTargets $debugPort
      $target = Select-CodexTarget $targets
      if (-not $target) { throw "Codex renderer target is not ready" }
      $observedCodex = $true
      $missingStreak = 0
      $targetId = [string]$target.id
      $isNewTarget = -not $targetRevisions.ContainsKey($targetId)
      $needsReload = $isNewTarget -or [string]$targetRevisions[$targetId] -ne $hudRevision
      $sync = Install-Hud ([string]$target.webSocketDebuggerUrl) $hudSource $isNewTarget $needsReload $debugPort
      $targetRevisions[$targetId] = $hudRevision
      if ($isNewTarget) {
        Write-Log "HUD injected into renderer target $($target.id)"
      } elseif ($needsReload) {
        Write-Log "HUD hot reloaded in renderer target $($target.id)"
      }
      if ($sync.ThreadId -and $sync.ThreadId -ne $lastLoggedThreadId) {
        $lastLoggedThreadId = $sync.ThreadId
        Write-Log "HUD bound to active thread $($sync.ThreadId); rollout usage loaded=$($sync.UsageLoaded)"
      }
    } catch {
      $missingStreak++
      if (-not $observedCodex -and (Get-Date) -gt $startupDeadline) {
        throw "Timed out waiting for the Codex renderer: $($_.Exception.Message)"
      }
      if ($observedCodex -and $missingStreak -ge 3 -and -not (Get-MainCodexProcess)) {
        Write-Log "Codex exited; launcher is stopping"
        break
      }
      Write-Log "Waiting for renderer: $($_.Exception.Message)"
    }
    Start-Sleep -Milliseconds $pollIntervalMs
  }
} catch {
  Write-Log "FATAL $($_.Exception.Message)"
  exit 1
} finally {
  if ($createdNew) {
    try { $mutex.ReleaseMutex() } catch {}
  }
  $mutex.Dispose()
}
