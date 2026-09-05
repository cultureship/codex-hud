import AppKit

final class CodexHUDMenuBar: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private var statusItem: NSStatusItem!
  private var hudProcess: Process?
  private var logHandle: FileHandle?
  private var restartRequested = false

  private let runtimeDirectory = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/CodexHUD/runtime", isDirectory: true)

  private var launcherURL: URL {
    runtimeDirectory.appendingPathComponent("codex-hud-macos.mjs")
  }

  private var logURL: URL {
    let support = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/CodexHUD", isDirectory: true)
    try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
    return support.appendingPathComponent("launcher.log")
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    statusItem.button?.title = "HUD"
    statusItem.button?.image = NSImage(systemSymbolName: "gauge.with.dots.needle.50percent", accessibilityDescription: "Codex HUD")
    statusItem.button?.image?.isTemplate = true
    statusItem.button?.toolTip = "Codex HUD"
    statusItem.menu = makeMenu()
    startHUD(nil)
  }

  func applicationWillTerminate(_ notification: Notification) {
    stopHUD(nil)
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    let running = hudProcess?.isRunning == true
    menu.addItem(withTitle: running ? "Codex HUD is running" : "Codex HUD is stopped", action: nil, keyEquivalent: "").isEnabled = false
    menu.addItem(NSMenuItem.separator())

    let start = menu.addItem(withTitle: running ? "Restart Codex HUD" : "Start Codex HUD", action: #selector(startHUD(_:)), keyEquivalent: "")
    start.target = self
    let stop = menu.addItem(withTitle: "Stop Codex HUD", action: #selector(stopHUD(_:)), keyEquivalent: "")
    stop.target = self
    stop.isEnabled = running

    menu.addItem(NSMenuItem.separator())
    let logs = menu.addItem(withTitle: "Show Launcher Log", action: #selector(showLog(_:)), keyEquivalent: "")
    logs.target = self
    let folder = menu.addItem(withTitle: "Open Project Folder", action: #selector(openProject(_:)), keyEquivalent: "")
    folder.target = self
    menu.addItem(NSMenuItem.separator())
    let quit = menu.addItem(withTitle: "Quit Codex HUD", action: #selector(quit(_:)), keyEquivalent: "q")
    quit.target = self
  }

  @objc private func startHUD(_ sender: Any?) {
    if let process = hudProcess, process.isRunning {
      restartRequested = true
      process.terminate()
      return
    }
    do {
      try installRuntime()
    } catch {
      showError("Could not prepare the HUD runtime: \(error.localizedDescription)")
      return
    }
    guard let node = nodeExecutable() else {
      showError("Node.js 20 or newer was not found. Install Node.js or set CODEX_HUD_NODE before launching the menu bar app.")
      return
    }

    FileManager.default.createFile(atPath: logURL.path, contents: nil)
    guard let log = FileHandle(forWritingAtPath: logURL.path) else {
      showError("Could not open \(logURL.path) for logging.")
      return
    }
    log.seekToEndOfFile()

    let process = Process()
    process.executableURL = URL(fileURLWithPath: node)
    process.arguments = [launcherURL.path, "--project-dir", runtimeDirectory.path]
    process.currentDirectoryURL = runtimeDirectory
    process.standardOutput = log
    process.standardError = log
    process.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        self?.logHandle?.closeFile()
        self?.logHandle = nil
        self?.hudProcess = nil
        if self?.restartRequested == true {
          self?.restartRequested = false
          self?.startHUD(nil)
        }
      }
    }

    do {
      try process.run()
      hudProcess = process
      logHandle = log
    } catch {
      log.closeFile()
      showError("Could not start Codex HUD: \(error.localizedDescription)")
    }
  }

  @objc private func stopHUD(_ sender: Any?) {
    restartRequested = false
    guard let process = hudProcess, process.isRunning else { return }
    process.terminate()
  }

  @objc private func showLog(_ sender: Any?) {
    NSWorkspace.shared.open(logURL)
  }

  @objc private func openProject(_ sender: Any?) {
    NSWorkspace.shared.open(runtimeDirectory)
  }

  @objc private func quit(_ sender: Any?) {
    NSApp.terminate(nil)
  }

  private func nodeExecutable() -> String? {
    let environment = ProcessInfo.processInfo.environment
    let candidates = [
      environment["CODEX_HUD_NODE"],
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ].compactMap { $0 }
    return candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) })
  }

  private func installRuntime() throws {
    let manager = FileManager.default
    try manager.createDirectory(at: runtimeDirectory, withIntermediateDirectories: true)
    for (name, extensionName, replaceExisting) in [
      ("codex-hud-macos", "mjs", true),
      ("hud", "js", true),
      ("config", "json", false),
    ] {
      guard let source = Bundle.main.url(forResource: name, withExtension: extensionName) else {
        throw NSError(domain: "CodexHUD", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing bundled \(name).\(extensionName)."])
      }
      let destination = runtimeDirectory.appendingPathComponent("\(name).\(extensionName)")
      if replaceExisting, manager.fileExists(atPath: destination.path) {
        try manager.removeItem(at: destination)
      }
      if !manager.fileExists(atPath: destination.path) {
        try manager.copyItem(at: source, to: destination)
      }
    }
  }

  private func makeMenu() -> NSMenu {
    let menu = NSMenu()
    menu.delegate = self
    return menu
  }

  private func showError(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "Codex HUD"
    alert.informativeText = message
    alert.alertStyle = .critical
    alert.runModal()
  }
}

@main
enum CodexHUDApplication {
  private static let delegate = CodexHUDMenuBar()

  static func main() {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    application.delegate = delegate
    application.run()
  }
}
