param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $scriptDir "config.json"
$hudPath = Join-Path $scriptDir "hud.js"
$logPath = Join-Path $scriptDir "launcher.log"

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

function Clear-OldLogEntries {
  if (-not (Test-Path -LiteralPath $logPath -PathType Leaf)) { return }
  $cutoff = (Get-Date).AddDays(-7)
  $retained = New-Object System.Collections.Generic.List[string]
  $removed = 0
  foreach ($line in [IO.File]::ReadAllLines($logPath, [Text.Encoding]::UTF8)) {
    $timestamp = [DateTime]::MinValue
    $isTimestamped = $line.Length -ge 23 -and [DateTime]::TryParseExact(
      $line.Substring(0, 23),
      "yyyy-MM-dd HH:mm:ss.fff",
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::AssumeLocal,
      [ref]$timestamp
    )
    if ($isTimestamped -and $timestamp -lt $cutoff) {
      $removed++
      continue
    }
    $null = $retained.Add($line)
  }
  if ($removed -gt 0) {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllLines($logPath, $retained, $utf8)
    Write-Log "Removed $removed log entries older than seven days"
  }
}

try {
  if (-not (Test-Path -LiteralPath $configPath)) { Fail "Missing config.json" }
  if (-not (Test-Path -LiteralPath $hudPath)) { Fail "Missing hud.js" }
  $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
  $requestedPort = [int]$config.debugPort
  if ($requestedPort -lt 1024 -or $requestedPort -gt 65535) { Fail "debugPort must be between 1024 and 65535" }
  $pollIntervalMs = [Math]::Max(1000, [int]$config.pollIntervalMs)
  $longContextThresholdProperty = $config.PSObject.Properties["longContextThresholdTokens"]
  $longContextThresholdTokens = if ($null -ne $longContextThresholdProperty) { [long]$longContextThresholdProperty.Value } else { 272000 }
  if ($longContextThresholdTokens -le 0) { Fail "longContextThresholdTokens must be greater than zero" }
  $hotReloadProperty = $config.PSObject.Properties["hotReload"]
  if ($null -ne $hotReloadProperty -and $hotReloadProperty.Value -isnot [bool]) {
    Fail "hotReload must be true or false"
  }
  $hotReload = $null -eq $hotReloadProperty -or [bool]$hotReloadProperty.Value
  $cleanupOldLogsProperty = $config.PSObject.Properties["cleanupOldLogs"]
  if ($null -ne $cleanupOldLogsProperty -and $cleanupOldLogsProperty.Value -isnot [bool]) {
    Fail "cleanupOldLogs must be true or false"
  }
  $cleanupOldLogs = $null -eq $cleanupOldLogsProperty -or [bool]$cleanupOldLogsProperty.Value
  $cleanupOldLedgerProperty = $config.PSObject.Properties["cleanupOldLedger"]
  if ($null -ne $cleanupOldLedgerProperty -and $cleanupOldLedgerProperty.Value -isnot [bool]) {
    Fail "cleanupOldLedger must be true or false"
  }
  $cleanupOldLedger = $null -eq $cleanupOldLedgerProperty -or [bool]$cleanupOldLedgerProperty.Value
  $uiTemplateProperty = $config.PSObject.Properties["uiTemplate"]
  $uiTemplate = if ($null -ne $uiTemplateProperty) { [int]$uiTemplateProperty.Value } else { 1 }
  if ($uiTemplate -notin @(1, 2)) { Fail "uiTemplate must be 1 or 2" }
  $transparentProperty = $config.PSObject.Properties["transparent"]
  if ($null -ne $transparentProperty -and $transparentProperty.Value -isnot [bool]) {
    Fail "transparent must be true or false"
  }
  $transparent = $null -ne $transparentProperty -and [bool]$transparentProperty.Value
} catch {
  Fail "Invalid configuration: $($_.Exception.Message)"
}

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\codex-hud-launcher", [ref]$createdNew)
if (-not $createdNew) {
  Write-Log "Another launcher instance is already running"
  exit 0
}
if ($cleanupOldLogs) { Clear-OldLogEntries }

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

function Add-ThreadSelectionListenerType {
  if (("CodexHud.ThreadSelectionListener" -as [type])) { return }
  Add-Type -AssemblyName System.Web.Extensions
  Add-Type -ReferencedAssemblies @("System.dll", "System.Core.dll", "System.Web.Extensions.dll") -TypeDefinition @"
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace CodexHud {
  public sealed class ThreadSelectionListener : IDisposable {
    private readonly ClientWebSocket socket = new ClientWebSocket();
    private readonly CancellationTokenSource cancellation = new CancellationTokenSource();
    private readonly ConcurrentQueue<string> selectedThreads = new ConcurrentQueue<string>();
    private readonly JavaScriptSerializer json = new JavaScriptSerializer();
    private Task pump;
    private string error = "";

    public ThreadSelectionListener(string webSocketUrl, string bindingName, string watcherSource) {
      socket.Options.Proxy = null;
      socket.ConnectAsync(new Uri(webSocketUrl), cancellation.Token).GetAwaiter().GetResult();
      Send(910001, "Runtime.enable", new Dictionary<string, object>()).GetAwaiter().GetResult();
      Send(910002, "Runtime.addBinding", new Dictionary<string, object> { { "name", bindingName } }).GetAwaiter().GetResult();
      Send(910003, "Page.addScriptToEvaluateOnNewDocument", new Dictionary<string, object> { { "source", watcherSource } }).GetAwaiter().GetResult();
      Send(910004, "Runtime.evaluate", new Dictionary<string, object> { { "expression", watcherSource } }).GetAwaiter().GetResult();
      pump = Task.Run((Func<Task>)ReceiveLoop);
    }

    public bool IsAlive {
      get { return error.Length == 0 && socket.State == WebSocketState.Open && pump != null && !pump.IsCompleted; }
    }

    public string Error { get { return error; } }

    public bool TryTake(out string threadId) {
      return selectedThreads.TryDequeue(out threadId);
    }

    private async Task Send(int id, string method, Dictionary<string, object> parameters) {
      Dictionary<string, object> command = new Dictionary<string, object>();
      command["id"] = id;
      command["method"] = method;
      command["params"] = parameters;
      byte[] bytes = Encoding.UTF8.GetBytes(json.Serialize(command));
      await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, cancellation.Token);
    }

    private async Task ReceiveLoop() {
      byte[] buffer = new byte[65536];
      try {
        while (!cancellation.IsCancellationRequested && socket.State == WebSocketState.Open) {
          using (MemoryStream stream = new MemoryStream()) {
            WebSocketReceiveResult result;
            do {
              result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellation.Token);
              if (result.MessageType == WebSocketMessageType.Close) return;
              stream.Write(buffer, 0, result.Count);
            } while (!result.EndOfMessage);
            if (result.MessageType == WebSocketMessageType.Text) {
              ProcessMessage(Encoding.UTF8.GetString(stream.ToArray()));
            }
          }
        }
      } catch (OperationCanceledException) {
      } catch (Exception exception) {
        error = exception.Message;
      }
    }

    private void ProcessMessage(string text) {
      try {
        Dictionary<string, object> message = json.DeserializeObject(text) as Dictionary<string, object>;
        if (message == null || !message.ContainsKey("method") || Convert.ToString(message["method"]) != "Runtime.bindingCalled") return;
        Dictionary<string, object> parameters = message["params"] as Dictionary<string, object>;
        if (parameters == null || !parameters.ContainsKey("name") || Convert.ToString(parameters["name"]) != "__codexHudThreadChanged") return;
        string payload = parameters.ContainsKey("payload") ? Convert.ToString(parameters["payload"]) : "";
        Guid parsed;
        if (payload.Length == 36 && Guid.TryParse(payload, out parsed)) selectedThreads.Enqueue(payload);
      } catch {
      }
    }

    public void Dispose() {
      cancellation.Cancel();
      try { socket.Abort(); } catch { }
      try { if (pump != null) pump.Wait(500); } catch { }
      socket.Dispose();
      cancellation.Dispose();
    }
  }
}
"@
}

$threadWatcherSource = @'
(() => {
  if (window.top !== window || !/^app:\/\/-\//i.test(location.href)) return;
  window.__codexHudThreadSelectionWatcher?.disconnect?.();
  const binding = "__codexHudThreadChanged";
  const state = { last: "", observer: null, queued: false };
  const selectedThreadId = () => {
    const value = document
      .querySelector('[data-app-action-sidebar-thread-selected="true"][data-app-action-sidebar-thread-id]')
      ?.getAttribute('data-app-action-sidebar-thread-id') || "";
    return value.replace(/^local:/, "");
  };
  const emit = () => {
    state.queued = false;
    const threadId = selectedThreadId();
    if (!/^[0-9a-f-]{36}$/i.test(threadId) || threadId === state.last) return;
    state.last = threadId;
    try { window[binding]?.(threadId); } catch {}
  };
  const schedule = () => {
    if (state.queued) return;
    state.queued = true;
    queueMicrotask(emit);
  };
  state.observer = new MutationObserver(schedule);
  state.observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      "data-app-action-sidebar-thread-selected",
      "data-app-action-sidebar-thread-active",
      "data-app-action-sidebar-thread-id",
      "aria-current",
    ],
  });
  window.__codexHudThreadSelectionWatcher = {
    disconnect() { state.observer?.disconnect(); },
  };
  schedule();
})()
'@

function New-ThreadSelectionListener([string]$webSocketUrl, [int]$port) {
  Assert-SafeWebSocketUrl $webSocketUrl $port
  Add-ThreadSelectionListenerType
  return New-Object CodexHud.ThreadSelectionListener($webSocketUrl, "__codexHudThreadChanged", $threadWatcherSource)
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
$ledgerPath = Join-Path $scriptDir "usage-ledger.json"
$ledgerSources = @{}
$ledgerRecords = New-Object System.Collections.ArrayList
$ledgerKeys = @{}
$ledgerNeedsSave = $false
$costSummary = @{ today = [double]0; week = [double]0 }
$rolloutWatcher = $null
$rolloutEventSources = @("CodexHud.RolloutChanged", "CodexHud.RolloutCreated")

function Get-LedgerRetentionStart {
  $today = (Get-Date).Date
  $daysSinceMonday = (([int]$today.DayOfWeek + 6) % 7)
  return $today.AddDays(-$daysSinceMonday - 7)
}

function Test-LedgerTimestampRetained([string]$timestamp) {
  if (-not $cleanupOldLedger) { return $true }
  try {
    $parsed = [DateTimeOffset]::Parse($timestamp, [Globalization.CultureInfo]::InvariantCulture)
    return $parsed.ToLocalTime().LocalDateTime -ge (Get-LedgerRetentionStart)
  } catch {
    return $true
  }
}

function Initialize-UsageLedger {
  if (-not (Test-Path -LiteralPath $ledgerPath -PathType Leaf)) { return }
  $loaded = Get-Content -Raw -Encoding UTF8 -LiteralPath $ledgerPath | ConvertFrom-Json
  if ([int]$loaded.version -lt 2) { $script:ledgerNeedsSave = $true }
  if ($loaded.sources) {
    foreach ($property in $loaded.sources.PSObject.Properties) {
      $ledgerSources[$property.Name] = [long]$property.Value
    }
  }
  foreach ($record in @($loaded.records)) {
    if (-not $record.key -or $ledgerKeys.ContainsKey([string]$record.key)) { continue }
    if (-not (Test-LedgerTimestampRetained ([string]$record.timestamp))) {
      $script:ledgerNeedsSave = $true
      continue
    }
    $normalizedRecord = [pscustomobject]@{
      key = [string]$record.key
      timestamp = [string]$record.timestamp
      model = [string]$record.model
      input_tokens = [long]$record.input_tokens
      cached_input_tokens = [long]$record.cached_input_tokens
      output_tokens = [long]$record.output_tokens
    }
    $null = $ledgerRecords.Add($normalizedRecord)
    $ledgerKeys[[string]$record.key] = $true
  }
}

function Save-UsageLedger {
  $document = @{
    version = 2
    sources = $ledgerSources
    records = @($ledgerRecords.ToArray())
  }
  $json = $document | ConvertTo-Json -Depth 10
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($ledgerPath, $json, $utf8)
}

function Import-RolloutUsage($file) {
  $match = [Regex]::Match($file.Name, "([0-9a-fA-F-]{36})\.jsonl$")
  if (-not $match.Success) { return }
  $threadId = $match.Groups[1].Value.ToLowerInvariant()
  $model = ""
  $stream = $null
  $reader = $null
  try {
    $stream = New-Object System.IO.FileStream(
      $file.FullName,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
    )
    $reader = New-Object System.IO.StreamReader($stream, [Text.Encoding]::UTF8, $true)
    while (($line = $reader.ReadLine()) -ne $null) {
      if ($line.IndexOf('"type":"turn_context"', [StringComparison]::Ordinal) -ge 0) {
        try {
          $row = $line | ConvertFrom-Json
          if ($row.payload.model) { $model = [string]$row.payload.model }
        } catch {}
      } elseif ($line.IndexOf('"type":"token_count"', [StringComparison]::Ordinal) -ge 0) {
        try {
          $row = $line | ConvertFrom-Json
          $lastUsage = $row.payload.info.last_token_usage
          $totalUsage = $row.payload.info.total_token_usage
          if (-not $lastUsage -or -not $totalUsage -or -not $model) { continue }
          if (-not (Test-LedgerTimestampRetained ([string]$row.timestamp))) { continue }
          $key = "${threadId}:$([long]$totalUsage.total_tokens)"
          if ($ledgerKeys.ContainsKey($key)) { continue }
          $record = [pscustomobject]@{
            key = $key
            timestamp = [string]$row.timestamp
            model = $model
            input_tokens = [long]$lastUsage.input_tokens
            cached_input_tokens = [long]$lastUsage.cached_input_tokens
            output_tokens = [long]$lastUsage.output_tokens
          }
          $null = $ledgerRecords.Add($record)
          $ledgerKeys[$key] = $true
        } catch {}
      }
    }
  } finally {
    if ($reader) { $reader.Dispose() }
    if ($stream) { $stream.Dispose() }
  }
}

function Get-ConfiguredPrice([string]$model, [long]$inputTokens) {
  $modelName = $model.ToLowerInvariant()
  $price = $null
  foreach ($property in $config.prices.PSObject.Properties) {
    $key = $property.Name.ToLowerInvariant()
    if ($modelName -eq $key) {
      $price = $property.Value
      break
    }
  }
  if ($null -eq $price) {
    foreach ($property in $config.prices.PSObject.Properties) {
      $key = $property.Name.ToLowerInvariant()
      if ($modelName.StartsWith("$key-", [StringComparison]::Ordinal)) {
        $price = $property.Value
        break
      }
    }
  }
  if ($null -eq $price) { return $null }
  $longContextProperty = $price.PSObject.Properties["longContext"]
  if ($inputTokens -gt $longContextThresholdTokens -and $null -ne $longContextProperty) {
    return $longContextProperty.Value
  }
  return $price
}

function Get-PriceValue($price, [string]$name, [double]$fallback) {
  $property = $price.PSObject.Properties[$name]
  if ($null -eq $property) { return $fallback }
  return [double]$property.Value
}

function Get-LedgerRecordCost($record) {
  $inputTokens = [long]$record.input_tokens
  $cachedTokens = [Math]::Min([long]$record.cached_input_tokens, $inputTokens)
  $uncachedTokens = [Math]::Max([long]0, $inputTokens - $cachedTokens)
  $price = Get-ConfiguredPrice ([string]$record.model) $inputTokens
  if ($null -eq $price) { return [double]0 }
  $inputPrice = Get-PriceValue $price "input" 0
  $cachedPrice = Get-PriceValue $price "cachedInput" $inputPrice
  $outputPrice = Get-PriceValue $price "output" 0
  $multiplier = if ($null -ne $config.priceMultiplier) { [double]$config.priceMultiplier } else { [double]1 }
  if ([double]::IsNaN($multiplier) -or [double]::IsInfinity($multiplier) -or $multiplier -lt 0) { $multiplier = 1 }
  return $multiplier * (
    $uncachedTokens * $inputPrice +
    $cachedTokens * $cachedPrice +
    [long]$record.output_tokens * $outputPrice
  ) / 1000000
}

function Update-CostSummary {
  $now = Get-Date
  $todayStart = $now.Date
  $daysSinceMonday = (([int]$now.DayOfWeek + 6) % 7)
  $weekStart = $todayStart.AddDays(-$daysSinceMonday)
  $todayCost = [double]0
  $weekCost = [double]0
  foreach ($record in $ledgerRecords) {
    try {
      $timestamp = [DateTimeOffset]::Parse([string]$record.timestamp, [Globalization.CultureInfo]::InvariantCulture)
      $localTime = $timestamp.ToLocalTime().LocalDateTime
      if ($localTime -lt $weekStart) { continue }
      $cost = Get-LedgerRecordCost $record
      $weekCost += $cost
      if ($localTime -ge $todayStart) { $todayCost += $cost }
    } catch {}
  }
  $script:costSummary = @{ today = $todayCost; week = $weekCost }
}

function Sync-UsageLedger {
  $changed = $false
  if (Test-Path -LiteralPath $sessionRoot -PathType Container) {
    $files = Get-ChildItem -LiteralPath $sessionRoot -Recurse -Filter "rollout-*.jsonl" -File -ErrorAction SilentlyContinue
    foreach ($file in $files) {
      $knownLength = if ($ledgerSources.ContainsKey($file.FullName)) { [long]$ledgerSources[$file.FullName] } else { [long]-1 }
      if ($knownLength -eq [long]$file.Length) { continue }
      Import-RolloutUsage $file
      $ledgerSources[$file.FullName] = [long]$file.Length
      $changed = $true
    }
  }
  if ($changed -or $ledgerNeedsSave) {
    Save-UsageLedger
    $script:ledgerNeedsSave = $false
  }
  Update-CostSummary
}

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

function New-UsageTable {
  return @{ input_tokens = [long]0; cached_input_tokens = [long]0; output_tokens = [long]0; total_tokens = [long]0 }
}

function New-PricingUsageTable {
  return @{ standard = New-UsageTable; long_context = New-UsageTable }
}

function New-RolloutParserState {
  return @{
    Offset = [long]0
    LastToken = $null
    LastModel = ""
    LastCumulativeTotal = [long]-1
    TieredUsage = New-PricingUsageTable
    CurrentTurnId = ""
    CurrentTurnActive = $false
    CurrentTurnUsage = New-UsageTable
    CurrentTurnPricingUsage = New-PricingUsageTable
    LastCompletedTurnUsage = New-UsageTable
    LastCompletedTurnPricingUsage = New-PricingUsageTable
  }
}

function Copy-UsageTable($usage) {
  return @{
    input_tokens = [long]$usage.input_tokens
    cached_input_tokens = [long]$usage.cached_input_tokens
    output_tokens = [long]$usage.output_tokens
    total_tokens = [long]$usage.total_tokens
  }
}

function Copy-PricingUsageTable($usage) {
  return @{
    standard = Copy-UsageTable $usage.standard
    long_context = Copy-UsageTable $usage.long_context
  }
}

function Add-UsageToTable($table, $usage) {
  $table.input_tokens += [long]$usage.input_tokens
  $table.cached_input_tokens += [long]$usage.cached_input_tokens
  $table.output_tokens += [long]$usage.output_tokens
  $table.total_tokens += [long]$usage.total_tokens
}

function Update-RolloutParserState($state, [string]$line) {
  if ($line.IndexOf('"type":"task_started"', [StringComparison]::Ordinal) -ge 0) {
    try {
      $row = $line | ConvertFrom-Json
      if ($row.payload.type -eq "task_started") {
        $state.CurrentTurnId = [string]$row.payload.turn_id
        $state.CurrentTurnActive = $true
        $state.CurrentTurnUsage = New-UsageTable
        $state.CurrentTurnPricingUsage = New-PricingUsageTable
      }
    } catch {}
  } elseif (
    $line.IndexOf('"type":"task_complete"', [StringComparison]::Ordinal) -ge 0 -or
    $line.IndexOf('"type":"turn_aborted"', [StringComparison]::Ordinal) -ge 0
  ) {
    try {
      $row = $line | ConvertFrom-Json
      if ($row.payload.type -in @("task_complete", "turn_aborted") -and [string]$row.payload.turn_id -eq $state.CurrentTurnId) {
        if ([long]$state.CurrentTurnUsage.total_tokens -gt 0) {
          $state.LastCompletedTurnUsage = Copy-UsageTable $state.CurrentTurnUsage
          $state.LastCompletedTurnPricingUsage = Copy-PricingUsageTable $state.CurrentTurnPricingUsage
        }
        $state.CurrentTurnActive = $false
      }
    } catch {}
  } elseif ($line.IndexOf('"type":"token_count"', [StringComparison]::Ordinal) -ge 0) {
    try {
      $row = $line | ConvertFrom-Json
      if ($row.payload.type -ne "token_count" -or -not $row.payload.info) { return }
      $state.LastToken = $row.payload
      $lastUsage = $row.payload.info.last_token_usage
      $totalUsage = $row.payload.info.total_token_usage
      if (-not $lastUsage -or -not $totalUsage) { return }
      $cumulativeTotal = [long]$totalUsage.total_tokens
      if ($cumulativeTotal -eq $state.LastCumulativeTotal) { return }
      if ([long]$state.LastCumulativeTotal -lt 0) {
        $baseline = @{
          input_tokens = [Math]::Max([long]0, [long]$totalUsage.input_tokens - [long]$lastUsage.input_tokens)
          cached_input_tokens = [Math]::Max([long]0, [long]$totalUsage.cached_input_tokens - [long]$lastUsage.cached_input_tokens)
          output_tokens = [Math]::Max([long]0, [long]$totalUsage.output_tokens - [long]$lastUsage.output_tokens)
          total_tokens = [Math]::Max([long]0, $cumulativeTotal - [long]$lastUsage.total_tokens)
        }
        if ([long]$baseline.total_tokens -gt 0) {
          # A missing/deleted history base has no request boundaries, so retain its cumulative usage in the standard tier.
          Add-UsageToTable $state.TieredUsage.standard $baseline
        }
      }
      $tierName = if ([long]$lastUsage.input_tokens -gt $longContextThresholdTokens) { "long_context" } else { "standard" }
      Add-UsageToTable $state.TieredUsage[$tierName] $lastUsage
      if ($state.CurrentTurnId) {
        Add-UsageToTable $state.CurrentTurnUsage $lastUsage
        Add-UsageToTable $state.CurrentTurnPricingUsage[$tierName] $lastUsage
      }
      $state.LastCumulativeTotal = $cumulativeTotal
    } catch {}
  } elseif ($line.IndexOf('"type":"turn_context"', [StringComparison]::Ordinal) -ge 0) {
    try {
      $row = $line | ConvertFrom-Json
      if ($row.payload.model) { $state.LastModel = [string]$row.payload.model }
    } catch {}
  }
}

function Get-RolloutSessionMeta([string]$path) {
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
    $line = $reader.ReadLine()
    if (-not $line) { return $null }
    $row = $line | ConvertFrom-Json
    if ($row.type -ne "session_meta") { return $null }
    return $row.payload
  } catch {
    return $null
  } finally {
    if ($reader) { $reader.Dispose() }
    if ($stream) { $stream.Dispose() }
  }
}

function Get-RolloutThreadIdFromFile([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return "" }
  $meta = Get-RolloutSessionMeta $path
  $threadId = if ($meta) { [string]$meta.session_id } else { "" }
  if ($threadId -match "^[0-9a-fA-F-]{36}$") { return $threadId }
  return ""
}

function Find-RolloutHistoryFile([string]$currentPath, [string]$threadId, [long]$minimumLength) {
  if ($threadId -notmatch "^[0-9a-fA-F-]{36}$") { return $null }
  $candidates = Get-ChildItem -LiteralPath $sessionRoot -Recurse -Filter "rollout-*$threadId*.jsonl" -File -ErrorAction SilentlyContinue |
    Where-Object {
      -not [string]::Equals($_.FullName, $currentPath, [StringComparison]::OrdinalIgnoreCase) -and
      ($minimumLength -le 0 -or [long]$_.Length -ge $minimumLength)
    } |
    Sort-Object LastWriteTime -Descending
  foreach ($candidate in $candidates) {
    $meta = Get-RolloutSessionMeta $candidate.FullName
    if ($meta -and [string]$meta.session_id -eq $threadId) { return $candidate.FullName }
  }
  return $null
}

function Import-RolloutStateFile($state, [string]$path, [long]$byteLimit, [long]$ordinalLimit, $visited) {
  $visitKey = $path.ToLowerInvariant()
  if ($visited.ContainsKey($visitKey)) { return }
  $visited[$visitKey] = $true

  $meta = Get-RolloutSessionMeta $path
  $history = if ($meta) { $meta.PSObject.Properties["history_base"] } else { $null }
  if ($history -and $history.Value) {
    $historyThreadId = [string]$history.Value.thread_id
    $byteProperty = $history.Value.PSObject.Properties["end_byte_offset"]
    $ordinalProperty = $history.Value.PSObject.Properties["end_ordinal_exclusive"]
    $historyByteLimit = if ($byteProperty) { [long]$byteProperty.Value } else { [long]-1 }
    $historyOrdinalLimit = if ($ordinalProperty) { [long]$ordinalProperty.Value } else { [long]-1 }
    $historyPath = Find-RolloutHistoryFile $path $historyThreadId $historyByteLimit
    if ($historyPath) {
      Import-RolloutStateFile $state $historyPath $historyByteLimit $historyOrdinalLimit $visited
    }
  }

  $file = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
  if (-not $file) { return }
  $readLength = [long]$file.Length
  if ($byteLimit -ge 0) { $readLength = [Math]::Min($readLength, $byteLimit) }
  if ($readLength -le 0) { return }
  if ($readLength -gt [int]::MaxValue) { throw "Rollout history segment is too large to parse" }

  $stream = $null
  try {
    $stream = New-Object System.IO.FileStream(
      $path,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
    )
    $bytes = New-Object byte[] ([int]$readLength)
    $read = 0
    while ($read -lt $bytes.Length) {
      $count = $stream.Read($bytes, $read, $bytes.Length - $read)
      if ($count -le 0) { break }
      $read += $count
    }
    $lastNewline = -1
    for ($index = $read - 1; $index -ge 0; $index--) {
      if ($bytes[$index] -eq 10) { $lastNewline = $index; break }
    }
    if ($lastNewline -lt 0) { return }
    $text = [Text.Encoding]::UTF8.GetString($bytes, 0, $lastNewline + 1)
    foreach ($line in $text.Split([char]10)) {
      if ($line.Length -le 0) { continue }
      $trimmed = $line.TrimEnd([char]13)
      if ($ordinalLimit -ge 0) {
        try {
          $row = $trimmed | ConvertFrom-Json
          $ordinal = $row.PSObject.Properties["ordinal"]
          if ($ordinal -and [long]$ordinal.Value -ge $ordinalLimit) { continue }
        } catch {}
      }
      Update-RolloutParserState $state $trimmed
    }
  } finally {
    if ($stream) { $stream.Dispose() }
  }
}

function Initialize-RolloutParserHistory($state, [string]$path) {
  $meta = Get-RolloutSessionMeta $path
  if (-not $meta) { return }
  $history = $meta.PSObject.Properties["history_base"]
  if (-not $history -or -not $history.Value) { return }
  $historyThreadId = [string]$history.Value.thread_id
  $byteProperty = $history.Value.PSObject.Properties["end_byte_offset"]
  $ordinalProperty = $history.Value.PSObject.Properties["end_ordinal_exclusive"]
  $byteLimit = if ($byteProperty) { [long]$byteProperty.Value } else { [long]-1 }
  $ordinalLimit = if ($ordinalProperty) { [long]$ordinalProperty.Value } else { [long]-1 }
  $historyPath = Find-RolloutHistoryFile $path $historyThreadId $byteLimit
  if (-not $historyPath) { return }
  $visited = @{}
  $visited[$path.ToLowerInvariant()] = $true
  Import-RolloutStateFile $state $historyPath $byteLimit $ordinalLimit $visited
}

function New-RolloutSnapshot($state) {
  if (-not $state.LastToken) { return $null }
  $state.LastToken.info | Add-Member -NotePropertyName pricing_tier_usage -NotePropertyValue $state.TieredUsage -Force
  $state.LastToken.info | Add-Member -NotePropertyName current_turn_usage -NotePropertyValue $state.CurrentTurnUsage -Force
  $state.LastToken.info | Add-Member -NotePropertyName current_turn_pricing_usage -NotePropertyValue $state.CurrentTurnPricingUsage -Force
  $state.LastToken.info | Add-Member -NotePropertyName last_completed_turn_usage -NotePropertyValue $state.LastCompletedTurnUsage -Force
  $state.LastToken.info | Add-Member -NotePropertyName last_completed_turn_pricing_usage -NotePropertyValue $state.LastCompletedTurnPricingUsage -Force
  $state.LastToken.info | Add-Member -NotePropertyName current_turn_active -NotePropertyValue $state.CurrentTurnActive -Force
  $state.LastToken.info | Add-Member -NotePropertyName current_turn_id -NotePropertyValue $state.CurrentTurnId -Force
  return @{ model = $state.LastModel; payload = $state.LastToken }
}

function Get-RolloutSnapshot([string]$threadId) {
  $path = Find-RolloutFile $threadId
  if (-not $path) { return $null }
  $file = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
  if (-not $file) { return $null }
  if ($rolloutSnapshotCache.ContainsKey($path)) {
    $state = $rolloutSnapshotCache[$path]
  } else {
    $state = New-RolloutParserState
    Initialize-RolloutParserHistory $state $path
  }
  if ([long]$file.Length -lt [long]$state.Offset) {
    $state = New-RolloutParserState
    Initialize-RolloutParserHistory $state $path
  }
  $remaining = [long]$file.Length - [long]$state.Offset
  if ($remaining -le 0) { return New-RolloutSnapshot $state }
  if ($remaining -gt [int]::MaxValue) { throw "Rollout append is too large to parse" }

  $stream = $null
  try {
    $stream = New-Object System.IO.FileStream(
      $path,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
    )
    $null = $stream.Seek([long]$state.Offset, [IO.SeekOrigin]::Begin)
    $bytes = New-Object byte[] ([int]$remaining)
    $read = 0
    while ($read -lt $bytes.Length) {
      $count = $stream.Read($bytes, $read, $bytes.Length - $read)
      if ($count -le 0) { break }
      $read += $count
    }
    $lastNewline = -1
    for ($index = $read - 1; $index -ge 0; $index--) {
      if ($bytes[$index] -eq 10) { $lastNewline = $index; break }
    }
    if ($lastNewline -ge 0) {
      $text = [Text.Encoding]::UTF8.GetString($bytes, 0, $lastNewline + 1)
      foreach ($line in $text.Split([char]10)) {
        if ($line.Length -gt 0) { Update-RolloutParserState $state $line.TrimEnd([char]13) }
      }
      $state.Offset = [long]$state.Offset + $lastNewline + 1
    }
  } finally {
    if ($stream) { $stream.Dispose() }
  }
  $rolloutSnapshotCache[$path] = $state
  return New-RolloutSnapshot $state
}

function Install-Hud(
  [string]$webSocketUrl,
  [string]$source,
  [bool]$installForNewDocuments,
  [bool]$forceReload,
  [int]$port,
  [string]$fallbackThreadId = "",
  [string]$preferredThreadId = ""
) {
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
    if ($preferredThreadId -match "^[0-9a-fA-F-]{36}$") {
      $threadId = $preferredThreadId
    } elseif (-not $threadId -and $fallbackThreadId) {
      $threadId = $fallbackThreadId
    }
    $snapshot = Get-RolloutSnapshot $threadId
    $usageLoaded = $false
    $inspectPayload = @{
      cost_summary = $costSummary
      __codex_hud_context = @{
        thread_id = $threadId
        usage_available = $false
      }
    }
    if ($snapshot) {
      $inspectPayload.model = $snapshot.model
      $inspectPayload.payload = $snapshot.payload
      $inspectPayload.__codex_hud_context.usage_available = $true
      $usageLoaded = $true
    }
    $snapshotJson = $inspectPayload | ConvertTo-Json -Compress -Depth 20
    $id++
    Send-CdpCommand $socket $id "Runtime.evaluate" @{
      expression = "window.__codexHud?.inspect($snapshotJson)"
      returnByValue = $false
    } | Out-Null
    $null = $socket.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "done", [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    return [pscustomobject]@{ ThreadId = $threadId; UsageLoaded = $usageLoaded }
  } finally {
    $socket.Dispose()
  }
}

try {
  Write-Log "Launcher started"
  Initialize-UsageLedger
  Sync-UsageLedger
  Write-Log "Usage ledger ready with $($ledgerRecords.Count) request records"
  $runtimeConfig = @{
    prices = $config.prices
    priceMultiplier = if ($null -ne $config.priceMultiplier) { [double]$config.priceMultiplier } else { 1.0 }
    activeTurnColor = if ($null -ne $config.activeTurnColor) { [string]$config.activeTurnColor } else { "#f59e0b" }
    longContextThresholdTokens = $longContextThresholdTokens
    uiTemplate = $uiTemplate
    transparent = $transparent
  } | ConvertTo-Json -Compress -Depth 20
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

  if (Test-Path -LiteralPath $sessionRoot -PathType Container) {
    $rolloutWatcher = New-Object System.IO.FileSystemWatcher($sessionRoot, "rollout-*.jsonl")
    $rolloutWatcher.IncludeSubdirectories = $true
    $rolloutWatcher.NotifyFilter = [IO.NotifyFilters]::FileName -bor [IO.NotifyFilters]::LastWrite -bor [IO.NotifyFilters]::Size
    $rolloutWatcher.InternalBufferSize = 32768
    $null = Register-ObjectEvent -InputObject $rolloutWatcher -EventName Changed -SourceIdentifier $rolloutEventSources[0]
    $null = Register-ObjectEvent -InputObject $rolloutWatcher -EventName Created -SourceIdentifier $rolloutEventSources[1]
    $rolloutWatcher.EnableRaisingEvents = $true
    Write-Log "Listening for rollout file changes"
  }

  $targetRevisions = @{}
  $observedCodex = $false
  $startupDeadline = (Get-Date).AddSeconds(25)
  $missingStreak = 0
  $lastLoggedThreadId = ""
  $threadListener = $null
  $listenerTargetId = ""
  $target = $null
  $rolloutSyncPending = $false
  $rolloutSyncDue = [DateTime]::MinValue
  $rolloutSyncPath = ""

  while ($true) {
    try {
      Ensure-CodexWindowControls (Get-MainCodexProcess)
      try {
        Sync-UsageLedger
      } catch {
        Write-Log "Usage ledger update failed: $($_.Exception.Message)"
      }
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
      $installParameters = @{
        webSocketUrl = [string]$target.webSocketDebuggerUrl
        source = $hudSource
        installForNewDocuments = $needsReload
        forceReload = $needsReload
        port = $debugPort
        fallbackThreadId = $lastLoggedThreadId
      }
      $sync = Install-Hud @installParameters
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
      if ($null -eq $threadListener -or $listenerTargetId -ne $targetId -or -not $threadListener.IsAlive) {
        if ($null -ne $threadListener) {
          $listenerError = [string]$threadListener.Error
          $threadListener.Dispose()
          if ($listenerError) { Write-Log "Sidebar listener disconnected: $listenerError" }
        }
        $threadListener = New-ThreadSelectionListener ([string]$target.webSocketDebuggerUrl) $debugPort
        $listenerTargetId = $targetId
        Write-Log "Listening for sidebar thread changes in renderer target $targetId"
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

    $pollDeadline = [DateTime]::UtcNow.AddMilliseconds($pollIntervalMs)
    while ([DateTime]::UtcNow -lt $pollDeadline) {
      foreach ($sourceIdentifier in $rolloutEventSources) {
        foreach ($rolloutEvent in @(Get-Event -SourceIdentifier $sourceIdentifier -ErrorAction SilentlyContinue)) {
          $changedPath = [string]$rolloutEvent.SourceEventArgs.FullPath
          Remove-Event -EventIdentifier $rolloutEvent.EventIdentifier -ErrorAction SilentlyContinue
          if ($lastLoggedThreadId -and $changedPath.IndexOf($lastLoggedThreadId, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $rolloutSyncPending = $true
            $rolloutSyncDue = [DateTime]::UtcNow.AddMilliseconds(100)
          } elseif ($sourceIdentifier -eq $rolloutEventSources[1]) {
            $rolloutSyncPending = $true
            $rolloutSyncPath = $changedPath
            $rolloutSyncDue = [DateTime]::UtcNow.AddMilliseconds(100)
          }
        }
      }
      if ($rolloutSyncPending -and [DateTime]::UtcNow -ge $rolloutSyncDue -and $null -ne $target) {
        try {
          $preferredThreadId = if ($rolloutSyncPath) { Get-RolloutThreadIdFromFile $rolloutSyncPath } else { "" }
          if ($rolloutSyncPath -and -not $preferredThreadId) {
            $rolloutSyncDue = [DateTime]::UtcNow.AddMilliseconds(100)
            continue
          }
          $eventSync = Install-Hud ([string]$target.webSocketDebuggerUrl) $hudSource $false $false $debugPort $lastLoggedThreadId $preferredThreadId
          if ($eventSync.ThreadId) {
            if ($eventSync.ThreadId -ne $lastLoggedThreadId) {
              Write-Log "New rollout synchronized to thread $($eventSync.ThreadId); rollout usage loaded=$($eventSync.UsageLoaded)"
            }
            $lastLoggedThreadId = $eventSync.ThreadId
          }
          $rolloutSyncPending = $false
          $rolloutSyncPath = ""
        } catch {
          Write-Log "Rollout change synchronization failed: $($_.Exception.Message)"
          $rolloutSyncPending = $false
          $rolloutSyncPath = ""
          break
        }
      }
      if ($null -eq $threadListener) {
        Start-Sleep -Milliseconds 75
        continue
      }
      if (-not $threadListener.IsAlive) {
        $listenerError = [string]$threadListener.Error
        $threadListener.Dispose()
        $threadListener = $null
        $listenerTargetId = ""
        if ($listenerError) { Write-Log "Sidebar listener disconnected: $listenerError" }
        break
      }

      $selectedThreadId = ""
      $newestThreadId = ""
      while ($threadListener.TryTake([ref]$selectedThreadId)) {
        $newestThreadId = $selectedThreadId
      }
      if ($newestThreadId -and $newestThreadId -ne $lastLoggedThreadId) {
        try {
          $eventSync = Install-Hud ([string]$target.webSocketDebuggerUrl) $hudSource $false $false $debugPort $lastLoggedThreadId $newestThreadId
          if ($eventSync.ThreadId) {
            $lastLoggedThreadId = $eventSync.ThreadId
            Write-Log "Sidebar switch synchronized to thread $($eventSync.ThreadId); rollout usage loaded=$($eventSync.UsageLoaded)"
          }
        } catch {
          Write-Log "Sidebar switch synchronization failed: $($_.Exception.Message)"
          break
        }
      }
      Start-Sleep -Milliseconds 75
    }
  }
} catch {
  Write-Log "FATAL $($_.Exception.Message)"
  exit 1
} finally {
  foreach ($sourceIdentifier in $rolloutEventSources) {
    try { Unregister-Event -SourceIdentifier $sourceIdentifier -ErrorAction SilentlyContinue } catch {}
    try { Get-Event -SourceIdentifier $sourceIdentifier -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue } catch {}
  }
  if ($null -ne $rolloutWatcher) {
    try { $rolloutWatcher.Dispose() } catch {}
  }
  if ($null -ne $threadListener) {
    try { $threadListener.Dispose() } catch {}
  }
  if ($createdNew) {
    try { $mutex.ReleaseMutex() } catch {}
  }
  $mutex.Dispose()
}
