using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

// A plain Win32 surface for mpv. Chromium must not composite over this window.
sealed class VideoHost : Form {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get {
      var p = base.CreateParams;
      p.ExStyle |= 0x08000080; // WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW
      return p;
    }
  }
  VideoHost() {
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    AutoScaleMode = AutoScaleMode.None;
    StartPosition = FormStartPosition.Manual;
    BackColor = Color.Black;
    Text = "Nen video surface";
  }
  void Command(string line) {
    if (line == "show") {
      Show();
      SetWindowPos(Handle, new IntPtr(1), 0, 0, 0, 0, 0x0013); // HWND_BOTTOM, no activation, move or resize
    }
    else if (line == "hide") Hide();
    else if (line == "close") { Close(); Application.ExitThread(); }
    else {
      var parts = line.Split(' ');
      int x, y, width, height;
      if (parts.Length == 5 && parts[0] == "bounds" &&
          int.TryParse(parts[1], out x) && int.TryParse(parts[2], out y) &&
          int.TryParse(parts[3], out width) && int.TryParse(parts[4], out height) &&
          width > 0 && height > 0)
        Bounds = new Rectangle(x, y, width, height);
    }
  }
  [STAThread] static void Main() {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    using (var host = new VideoHost()) {
      Console.WriteLine(host.Handle.ToInt64());
      Console.Out.Flush();
      var input = new Thread(() => {
        string line;
        while ((line = Console.ReadLine()) != null) {
          var command = line;
          try { host.BeginInvoke(new Action(() => host.Command(command))); }
          catch (InvalidOperationException) { return; }
        }
        try { host.BeginInvoke(new Action(() => host.Command("close"))); }
        catch (InvalidOperationException) { }
      });
      input.IsBackground = true;
      input.Start();
      Application.Run();
    }
  }
}
