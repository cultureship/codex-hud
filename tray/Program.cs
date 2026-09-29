using System.Diagnostics;
using System.Management;

namespace CodexHud.Tray;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new TrayContext());
    }
}

internal sealed class TrayContext : ApplicationContext
{
    private readonly NotifyIcon _notifyIcon;
    private readonly string _root;
    private readonly string _script;
    private readonly string _log;
    private Process? _launcher;

    public TrayContext()
    {
        _root = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        _script = Path.Combine(_root, "codex-hud.ps1");
        _log = Path.Combine(_root, "launcher.log");

        var menu = new ContextMenuStrip();
        menu.Items.Add("Restart Codex HUD", null, (_, _) => Restart());
        menu.Items.Add("Stop Codex HUD", null, (_, _) => Stop());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Show Launcher Log", null, (_, _) => OpenFile(_log));
        menu.Items.Add("Open Project Folder", null, (_, _) => OpenFile(_root));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit Codex HUD", null, (_, _) => Exit());

        var iconPath = Path.Combine(_root, "openai.ico");
        _notifyIcon = new NotifyIcon
        {
            Icon = File.Exists(iconPath) ? new Icon(iconPath) : SystemIcons.Application,
            Text = "Codex HUD",
            ContextMenuStrip = menu,
            Visible = true,
        };
        _notifyIcon.DoubleClick += (_, _) => Restart();
        Restart();
    }

    private void Restart()
    {
        Stop();
        if (!File.Exists(_script))
        {
            MessageBox.Show($"Missing codex-hud.ps1 in {_root}", "Codex HUD", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        var start = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            WorkingDirectory = _root,
        };
        start.ArgumentList.Add("-NoProfile");
        start.ArgumentList.Add("-ExecutionPolicy");
        start.ArgumentList.Add("Bypass");
        start.ArgumentList.Add("-WindowStyle");
        start.ArgumentList.Add("Hidden");
        start.ArgumentList.Add("-File");
        start.ArgumentList.Add(_script);
        try
        {
            _launcher = Process.Start(start);
            _notifyIcon.ShowBalloonTip(1500, "Codex HUD", "HUD launcher started", ToolTipIcon.Info);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "Codex HUD", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void Stop()
    {
        try
        {
            if (_launcher is { HasExited: false }) _launcher.Kill(true);
        }
        catch { }
        _launcher?.Dispose();
        _launcher = null;

        // Covers a launcher that was started by an earlier tray instance.
        try
        {
            using var searcher = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'powershell.exe'");
            foreach (ManagementObject process in searcher.Get())
            {
                var commandLine = process["CommandLine"]?.ToString() ?? "";
                if (commandLine.Contains(_script, StringComparison.OrdinalIgnoreCase))
                {
                    Process.GetProcessById(Convert.ToInt32(process["ProcessId"])).Kill(true);
                }
            }
        }
        catch { }
    }

    private static void OpenFile(string path)
    {
        try
        {
            Process.Start(new ProcessStartInfo { FileName = path, UseShellExecute = true });
        }
        catch { }
    }

    private void Exit()
    {
        Stop();
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
        Application.Exit();
    }
}
