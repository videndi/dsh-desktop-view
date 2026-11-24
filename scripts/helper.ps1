# dsh-desktop-view persistent helper.
#
# One long-lived Windows PowerShell process that the host keeps open and talks to
# over stdin/stdout, one JSON object per line. Starting a process (and compiling
# the P/Invoke helpers) costs ~700 ms; after that a command costs a few
# milliseconds, which is what makes the see -> act -> verify loop feel live.
#
#   {"id":1,"cmd":"ping"}
#   {"id":2,"cmd":"grab","path":"C:/tmp/f.png","maxWidth":960}
#   {"id":3,"cmd":"click","x":10,"y":20}
#
# The process answers exactly one line per request. Anything that would print to
# the console on its own is redirected, so stdout stays a clean protocol channel.
param(
  [string]$StopFile = ''
)

$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

$cs = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class HvMonitor {
    public int Index, X, Y, Width, Height;
    public bool Primary;
}

public sealed class HvWindow {
    public IntPtr Handle;
    public string Title, ClassName;
    public int ProcessId;
    public int X, Y, Width, Height;
    public bool Minimized, Foreground;
}

public static class Hv {
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
    [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);

    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool on);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr h, ref MONITORINFO info);
    [DllImport("user32.dll")] static extern uint GetDpiForSystem();

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_EXTENDED = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
    const uint MDOWN_L = 0x0002, MUP_L = 0x0004, MDOWN_R = 0x0008, MUP_R = 0x0010, MDOWN_M = 0x0020, MUP_M = 0x0040;
    const uint WHEEL = 0x0800, HWHEEL = 0x01000;

    public static void DpiAware() { SetProcessDPIAware(); }

    public static int[] Cursor() {
        POINT p;
        if (!GetCursorPos(out p)) return null;
        return new int[] { p.X, p.Y };
    }

    public static bool MoveTo(int x, int y) { return SetCursorPos(x, y); }

    static void Mouse(uint flags, uint data) {
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.u.mi.dwFlags = flags;
        input.u.mi.mouseData = data;
        SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void Button(string button, bool down) {
        uint f;
        if (button == "right") f = down ? MDOWN_R : MUP_R;
        else if (button == "middle") f = down ? MDOWN_M : MUP_M;
        else f = down ? MDOWN_L : MUP_L;
        Mouse(f, 0);
    }

    public static void Wheel(int delta, bool horizontal) {
        Mouse(horizontal ? HWHEEL : WHEEL, unchecked((uint)delta));
    }

    static void KeyEvent(ushort vk, ushort scan, uint flags) {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.u.ki.wVk = vk;
        input.u.ki.wScan = scan;
        input.u.ki.dwFlags = flags;
        SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void KeyDown(int vk, bool extended) { KeyEvent((ushort)vk, 0, extended ? KEYEVENTF_EXTENDED : 0u); }
    public static void KeyUp(int vk, bool extended) { KeyEvent((ushort)vk, 0, (extended ? KEYEVENTF_EXTENDED : 0u) | KEYEVENTF_KEYUP); }

    public static void TypeChar(char c) {
        KeyEvent(0, (ushort)c, KEYEVENTF_UNICODE);
        KeyEvent(0, (ushort)c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
    }

    public static string WindowTitle(IntPtr h) {
        StringBuilder sb = new StringBuilder(1024);
        GetWindowTextW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string WindowClass(IntPtr h) {
        StringBuilder sb = new StringBuilder(512);
        GetClassNameW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static int WindowProcessId(IntPtr h) {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        return (int)pid;
    }

    public static bool WindowExists(IntPtr h) { return IsWindow(h); }

    public static IntPtr WindowAt(int x, int y) {
        POINT p;
        p.X = x;
        p.Y = y;
        IntPtr h = WindowFromPoint(p);
        if (h == IntPtr.Zero) return IntPtr.Zero;
        return GetAncestor(h, 2u);
    }

    public static int[] WindowRect(IntPtr h) {
        RECT r;
        if (!GetWindowRect(h, out r)) return null;
        return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
    }

    public static List<HvWindow> Windows() {
        List<HvWindow> list = new List<HvWindow>();
        IntPtr fg = GetForegroundWindow();
        EnumWindowsProc cb = delegate(IntPtr h, IntPtr l) {
            if (!IsWindowVisible(h)) return true;
            string title = WindowTitle(h);
            if (title.Length == 0) return true;
            RECT r;
            GetWindowRect(h, out r);
            HvWindow w = new HvWindow();
            w.Handle = h;
            w.Title = title;
            w.ClassName = WindowClass(h);
            w.ProcessId = WindowProcessId(h);
            w.X = r.Left; w.Y = r.Top; w.Width = r.Right - r.Left; w.Height = r.Bottom - r.Top;
            w.Minimized = IsIconic(h);
            w.Foreground = h == fg;
            list.Add(w);
            return true;
        };
        EnumWindows(cb, IntPtr.Zero);
        GC.KeepAlive(cb);
        return list;
    }

    public static List<HvMonitor> Monitors() {
        List<HvMonitor> list = new List<HvMonitor>();
        MonitorEnumProc cb = delegate(IntPtr hm, IntPtr hdc, ref RECT r, IntPtr d) {
            MONITORINFO info = new MONITORINFO();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (GetMonitorInfo(hm, ref info)) {
                HvMonitor m = new HvMonitor();
                m.Index = list.Count + 1;
                m.X = info.rcMonitor.Left; m.Y = info.rcMonitor.Top;
                m.Width = info.rcMonitor.Right - info.rcMonitor.Left;
                m.Height = info.rcMonitor.Bottom - info.rcMonitor.Top;
                m.Primary = (info.dwFlags & 1u) != 0u;
                list.Add(m);
            }
            return true;
        };
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
        GC.KeepAlive(cb);
        return list;
    }

    public static int[] VirtualScreen() {
        return new int[] { GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79) };
    }

    public static int Dpi() {
        try { return (int)GetDpiForSystem(); } catch { return 96; }
    }

    public static bool Focus(IntPtr h) {
        if (IsIconic(h)) ShowWindow(h, 9);
        ShowWindow(h, 5);
        uint pid;
        IntPtr fg = GetForegroundWindow();
        uint fgThread = GetWindowThreadProcessId(fg, out pid);
        uint me = GetCurrentThreadId();
        bool attached = false;
        try {
            if (fgThread != me) attached = AttachThreadInput(fgThread, me, true);
            BringWindowToTop(h);
            if (!SetForegroundWindow(h)) {
                KeyEvent(0x12, 0, 0);
                KeyEvent(0x12, 0, KEYEVENTF_KEYUP);
                SetForegroundWindow(h);
            }
        } finally {
            if (attached) AttachThreadInput(fgThread, me, false);
        }
        return GetForegroundWindow() == h;
    }

    public static void Minimize(IntPtr h) { ShowWindow(h, 6); }
    public static void Maximize(IntPtr h) { ShowWindow(h, 3); }
    public static void Restore(IntPtr h) { ShowWindow(h, 9); }
    public static void Close(IntPtr h) { PostMessageW(h, 0x0010, IntPtr.Zero, IntPtr.Zero); }
}
'@

# --- capture ---------------------------------------------------------------

$captureSource = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class HvCapture {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    static byte[] Fingerprint(Bitmap bitmap) {
        using (Bitmap small = new Bitmap(32, 18, PixelFormat.Format24bppRgb)) {
            using (Graphics g = Graphics.FromImage(small)) {
                g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                g.DrawImage(bitmap, 0, 0, 32, 18);
            }
            byte[] gray = new byte[32 * 18];
            int i = 0;
            for (int y = 0; y < 18; y++) {
                for (int x = 0; x < 32; x++) {
                    Color c = small.GetPixel(x, y);
                    gray[i++] = (byte)((c.R * 299 + c.G * 587 + c.B * 114) / 1000);
                }
            }
            return gray;
        }
    }

    static string Sign(byte[] gray) {
        uint hash = 2166136261u;
        foreach (byte value in gray) hash = (hash ^ value) * 16777619u;
        return hash.ToString("x8");
    }

    public static string Grab(string path, int x, int y, int w, int h, int maxWidth, bool markCursor, int cursorX, int cursorY, int quality) {
        SetProcessDPIAware();
        Bitmap source = new Bitmap(w, h, PixelFormat.Format24bppRgb);
        using (Graphics g = Graphics.FromImage(source)) {
            g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
        }
        Bitmap output = source;
        int outW = w, outH = h;
        if (maxWidth > 0 && w > maxWidth) {
            outW = maxWidth;
            outH = (int)Math.Round((double)h * maxWidth / w);
            output = new Bitmap(outW, outH, PixelFormat.Format24bppRgb);
            using (Graphics g = Graphics.FromImage(output)) {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(source, 0, 0, outW, outH);
            }
        }
        double scale = (double)outW / w;
        if (markCursor) {
            int cx = (int)Math.Round((cursorX - x) * scale);
            int cy = (int)Math.Round((cursorY - y) * scale);
            if (cx >= 0 && cy >= 0 && cx < outW && cy < outH) {
                using (Graphics g = Graphics.FromImage(output)) {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    int r = 16;
                    using (Pen white = new Pen(Color.White, 5)) g.DrawEllipse(white, cx - r, cy - r, 2 * r, 2 * r);
                    using (Pen red = new Pen(Color.FromArgb(220, 38, 38), 2)) {
                        g.DrawEllipse(red, cx - r, cy - r, 2 * r, 2 * r);
                        g.DrawLine(red, cx - r - 10, cy, cx - r - 3, cy);
                        g.DrawLine(red, cx + r + 3, cy, cx + r + 10, cy);
                        g.DrawLine(red, cx, cy - r - 10, cx, cy - r - 3);
                        g.DrawLine(red, cx, cy + r + 3, cx, cy + r + 10);
                    }
                }
            }
        }
        byte[] fingerprint = Fingerprint(output);
        string signature = Sign(fingerprint);
        bool jpeg = path.ToLowerInvariant().EndsWith(".jpg") || path.ToLowerInvariant().EndsWith(".jpeg");
        if (jpeg) {
            ImageCodecInfo codec = null;
            foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) {
                if (c.FormatID == ImageFormat.Jpeg.Guid) { codec = c; break; }
            }
            using (EncoderParameters parameters = new EncoderParameters(1)) {
                parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                output.Save(path, codec, parameters);
            }
        } else {
            output.Save(path, ImageFormat.Png);
        }
        int bytes = (int)new System.IO.FileInfo(path).Length;
        if (output != source) { output.Dispose(); source.Dispose(); }
        else { source.Dispose(); }
        return outW + "x" + outH + ":" + bytes + ":" + signature + ":" + Convert.ToBase64String(fingerprint);
    }
}
'@

function Write-Line($object) {
  $json = $object | ConvertTo-Json -Depth 8 -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Fail($id, $message) {
  Write-Line ([ordered]@{ id = $id; ok = $false; error = [string]$message })
}

try {
  Add-Type -AssemblyName System.Drawing | Out-Null
  $drawingAssembly = [System.Drawing.Bitmap].Assembly.Location
  Add-Type -TypeDefinition $cs | Out-Null
  Add-Type -TypeDefinition $captureSource -ReferencedAssemblies $drawingAssembly | Out-Null
  [Hv]::DpiAware() | Out-Null
} catch {
  Write-Line ([ordered]@{ id = 0; ok = $false; error = "helper failed to load: $($_.Exception.Message)" })
  exit 1
}

$uiaReady = $false
try {
  Add-Type -AssemblyName UIAutomationClient | Out-Null
  Add-Type -AssemblyName UIAutomationTypes | Out-Null
  $uiaReady = $true
} catch { }

$processNames = @{}
function Get-ProcessNameCached([int]$processId) {
  if ($processId -le 0) { return '' }
  if (-not $processNames.ContainsKey($processId)) {
    $name = ''
    try { $name = (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { }
    $processNames[$processId] = $name
  }
  return $processNames[$processId]
}

function Format-Handle([IntPtr]$handle) { return ('0x{0:X8}' -f $handle.ToInt64()) }

function Get-WindowRef([IntPtr]$handle) {
  $pid2 = [Hv]::WindowProcessId($handle)
  return [ordered]@{
    hwnd        = (Format-Handle $handle)
    title       = [Hv]::WindowTitle($handle)
    className   = [Hv]::WindowClass($handle)
    processId   = $pid2
    processName = (Get-ProcessNameCached $pid2)
  }
}

function Get-Pointer {
  $p = [Hv]::Cursor()
  return [ordered]@{ x = $p[0]; y = $p[1] }
}

function Assert-Point([int]$x, [int]$y) {
  $screen = [Hv]::VirtualScreen()
  $right = $screen[0] + $screen[2]
  $bottom = $screen[1] + $screen[3]
  if ($x -lt $screen[0] -or $x -ge $right -or $y -lt $screen[1] -or $y -ge $bottom) {
    throw ('point (x={0}, y={1}) is outside the desktop; the virtual screen is {2}x{3} starting at ({4}, {5})' -f $x, $y, $screen[2], $screen[3], $screen[0], $screen[1])
  }
}

function Stop-Requested {
  if (-not $StopFile) { return $false }
  return Test-Path -LiteralPath $StopFile
}

# --- UIA -------------------------------------------------------------------

function Get-UiaTree([IntPtr]$handle, [int]$depth, [int]$max, $point) {
  if (-not $uiaReady) { throw 'UI Automation is not available in this Windows PowerShell' }
  $all = New-Object System.Collections.ArrayList
  $walkDepth = [Math]::Min([Math]::Max($depth, 1), 8)
  $budget = [Math]::Min([Math]::Max($max, 1), 400)

  $root = $null
  if ($null -ne $point) {
    $p = New-Object System.Windows.Point($point[0], $point[1])
    $root = [System.Windows.Automation.AutomationElement]::FromPoint($p)
  } elseif ($handle -ne [IntPtr]::Zero) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  } else {
    $root = [System.Windows.Automation.AutomationElement]::FocusedElement
  }
  if ($null -eq $root) { throw 'no UI Automation element at that window or point' }

  function Add-Node($element, [int]$level) {
    if ($all.Count -ge $budget) { return }
    $current = $element.Current
    $rect = $current.BoundingRectangle
    if (-not $current.IsOffscreen -or $level -eq 0) {
      [void]$all.Add([ordered]@{
        name         = [string]$current.Name
        type         = ([string]$current.ControlType.ProgrammaticName -replace '^ControlType\.', '')
        automationId = [string]$current.AutomationId
        className    = [string]$current.ClassName
        x            = [int][Math]::Round($rect.X)
        y            = [int][Math]::Round($rect.Y)
        width        = [int][Math]::Round($rect.Width)
        height       = [int][Math]::Round($rect.Height)
        enabled      = [bool]$current.IsEnabled
        offscreen    = [bool]$current.IsOffscreen
        depth        = $level
      })
    }
    if ($level -ge $walkDepth) { return }
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $child = $walker.GetFirstChild($element)
    while ($null -ne $child -and $all.Count -lt $budget) {
      Add-Node $child ($level + 1)
      $child = $walker.GetNextSibling($child)
    }
  }

  Add-Node $root 0
  return $all
}

# --- main loop -------------------------------------------------------------

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }

  $request = $null
  try { $request = $line | ConvertFrom-Json } catch { Write-Line ([ordered]@{ id = 0; ok = $false; error = 'request is not valid JSON' }); continue }
  $id = 0
  try { $id = [int]$request.id } catch { }
  $cmd = [string]$request.cmd

  try {
    switch ($cmd) {
      'ping' {
        Write-Line ([ordered]@{ id = $id; ok = $true; pid = $PID; dpi = [Hv]::Dpi(); uia = $uiaReady })
      }
      'info' {
        $screen = [Hv]::VirtualScreen()
        $monitors = @()
        foreach ($m in [Hv]::Monitors()) {
          $monitors += [ordered]@{ index = $m.Index; x = $m.X; y = $m.Y; width = $m.Width; height = $m.Height; primary = [bool]$m.Primary }
        }
        Write-Line ([ordered]@{
          id = $id; ok = $true
          virtualScreen = [ordered]@{ x = $screen[0]; y = $screen[1]; width = $screen[2]; height = $screen[3] }
          monitors = $monitors
          dpi = [Hv]::Dpi()
          pointer = (Get-Pointer)
          foreground = (Get-WindowRef ([Hv]::GetForegroundWindow()))
        })
      }
      'grab' {
        $path = [string]$request.path
        if (-not $path) { throw 'grab needs a path' }
        $maxWidth = if ($null -ne $request.maxWidth) { [int]$request.maxWidth } else { 0 }
        $mark = [bool]$request.markCursor
        $screen = [Hv]::VirtualScreen()
        $x = $screen[0]; $y = $screen[1]; $w = $screen[2]; $h = $screen[3]
        if ($null -ne $request.monitor -and [int]$request.monitor -gt 0) {
          $monitors = @([Hv]::Monitors())
          $target = $monitors | Where-Object { $_.Index -eq [int]$request.monitor }
          if ($null -eq $target) { throw "monitor $($request.monitor) does not exist" }
          $x = $target.X; $y = $target.Y; $w = $target.Width; $h = $target.Height
        }
        $pointer = [Hv]::Cursor()
        $cursorX = $pointer[0]; $cursorY = $pointer[1]
        $quality = if ($null -ne $request.quality) { [Math]::Min([Math]::Max([int]$request.quality, 40), 95) } else { 80 }
        $result = [HvCapture]::Grab($path, $x, $y, $w, $h, $maxWidth, $mark, $cursorX, $cursorY, $quality)
        $parts = $result.Split(':')
        $dims = $parts[0].Split('x')
        Write-Line ([ordered]@{
          id = $id; ok = $true
          path = $path
          width = [int]$dims[0]; height = [int]$dims[1]; bytes = [int]$parts[1]
          signature = [string]$parts[2]
          fingerprint = [string]$parts[3]
          sourceWidth = $w; sourceHeight = $h
          cursor = [ordered]@{ x = $cursorX; y = $cursorY }
          region = [ordered]@{ x = $x; y = $y; width = $w; height = $h }
          foreground = (Get-WindowRef ([Hv]::GetForegroundWindow()))
        })
      }
      'move' {
        if (Stop-Requested) { throw 'emergency stop is on' }
        Assert-Point ([int]$request.x) ([int]$request.y)
        [Hv]::MoveTo([int]$request.x, [int]$request.y) | Out-Null
        Write-Line ([ordered]@{ id = $id; ok = $true; pointer = (Get-Pointer); foreground = (Get-WindowRef ([Hv]::GetForegroundWindow())) })
      }
      'click' {
        if (Stop-Requested) { throw 'emergency stop is on' }
        $button = if ($request.button) { [string]$request.button } else { 'left' }
        $count = if ($null -ne $request.count) { [int]$request.count } else { 1 }
        if ($null -ne $request.x) {
          Assert-Point ([int]$request.x) ([int]$request.y)
          [Hv]::MoveTo([int]$request.x, [int]$request.y) | Out-Null
          Start-Sleep -Milliseconds 20
        }
        for ($i = 0; $i -lt $count; $i++) {
          if ($i -gt 0) { Start-Sleep -Milliseconds 40 }
          [Hv]::Button($button, $true)
          Start-Sleep -Milliseconds 15
          [Hv]::Button($button, $false)
        }
        Start-Sleep -Milliseconds 45
        Write-Line ([ordered]@{ id = $id; ok = $true; pointer = (Get-Pointer); foreground = (Get-WindowRef ([Hv]::GetForegroundWindow())) })
      }
      'drag' {
        if (Stop-Requested) { throw 'emergency stop is on' }
        $button = if ($request.button) { [string]$request.button } else { 'left' }
        $fx = [int]$request.fromX; $fy = [int]$request.fromY; $tx = [int]$request.toX; $ty = [int]$request.toY
        Assert-Point $fx $fy; Assert-Point $tx $ty
        $steps = if ($null -ne $request.steps) { [Math]::Min([Math]::Max([int]$request.steps, 4), 60) } else { 12 }
        $duration = if ($null -ne $request.durationMs) { [Math]::Min([Math]::Max([int]$request.durationMs, 0), 5000) } else { 300 }
        $pause = [Math]::Max(1, [int]($duration / $steps))
        [Hv]::MoveTo($fx, $fy) | Out-Null
        Start-Sleep -Milliseconds 30
        [Hv]::Button($button, $true)
        Start-Sleep -Milliseconds 60
        for ($i = 1; $i -le $steps; $i++) {
          $k = $i / $steps
          [Hv]::MoveTo([int][Math]::Round($fx + ($tx - $fx) * $k), [int][Math]::Round($fy + ($ty - $fy) * $k)) | Out-Null
          Start-Sleep -Milliseconds $pause
        }
        Start-Sleep -Milliseconds 60
        [Hv]::Button($button, $false)
        Start-Sleep -Milliseconds 50
        Write-Line ([ordered]@{ id = $id; ok = $true; pointer = (Get-Pointer); foreground = (Get-WindowRef ([Hv]::GetForegroundWindow())) })
      }
      'scroll' {
        if (Stop-Requested) { throw 'emergency stop is on' }
        $delta = [int]$request.delta
        if ($delta -eq 0) { throw 'delta must be non-zero' }
        $horizontal = [bool]$request.horizontal
        if ($null -ne $request.x) {
          Assert-Point ([int]$request.x) ([int]$request.y)
          [Hv]::MoveTo([int]$request.x, [int]$request.y) | Out-Null
          Start-Sleep -Milliseconds 20
        }
        [Hv]::Wheel($delta * 120, $horizontal)
        Start-Sleep -Milliseconds 50
        Write-Line ([ordered]@{ id = $id; ok = $true; pointer = (Get-Pointer); foreground = (Get-WindowRef ([Hv]::GetForegroundWindow())) })
      }
      'type' {
        if (Stop-Requested) { throw 'emergency stop is on' }
        $text = [string]$request.text
        if ($text.Length -eq 0) { throw 'text must not be empty' }
        $interval = if ($null -ne $request.intervalMs) { [Math]::Min([Math]::Max([int]$request.intervalMs, 0), 1000) } else { 6 }
        $typed = 0
        foreach ($ch in $text.ToCharArray()) {
          if ($ch -eq "`r") { continue }
          elseif ($ch -eq "`n") { [Hv]::KeyDown(0x0D, $false); [Hv]::KeyUp(0x0D, $false) }
          elseif ($ch -eq "`t") { [Hv]::KeyDown(0x09, $false); [Hv]::KeyUp(0x09, $false) }
          else { [Hv]::TypeChar($ch) }
          $typed++
          if ($interval -gt 0) { Start-Sleep -Milliseconds $interval }
        }
        Start-Sleep -Milliseconds 30
        Write-Line ([ordered]@{ id = $id; ok = $true; typed = $typed; pointer = (Get-Pointer); foreground = (Get-WindowRef ([Hv]::GetForegroundWindow())) })
      }
      'key' {
        if (Stop-Requested) { throw 'emergency stop is on' }
        $vks = @()
        if ($null -ne $request.modifierVks) { foreach ($v in $request.modifierVks) { $vks += [int]$v } }
        $keyVk = [int]$request.keyVk
        $extended = [bool]$request.extended
        foreach ($vk in $vks) { [Hv]::KeyDown($vk, $false); Start-Sleep -Milliseconds 10 }
        [Hv]::KeyDown($keyVk, $extended)
        Start-Sleep -Milliseconds 25
        [Hv]::KeyUp($keyVk, $extended)
        Start-Sleep -Milliseconds 10
        for ($i = $vks.Count - 1; $i -ge 0; $i--) { [Hv]::KeyUp($vks[$i], $false); Start-Sleep -Milliseconds 8 }
        Start-Sleep -Milliseconds 30
        Write-Line ([ordered]@{ id = $id; ok = $true; pointer = (Get-Pointer); foreground = (Get-WindowRef ([Hv]::GetForegroundWindow())) })
      }
      'windowAt' {
        $handle = [Hv]::WindowAt([int]$request.x, [int]$request.y)
        Write-Line ([ordered]@{ id = $id; ok = $true; window = (Get-WindowRef $handle) })
      }
      'windows' {
        $filter = if ($request.filter) { ([string]$request.filter).ToLower() } else { '' }
        $limit = if ($null -ne $request.limit) { [Math]::Min([Math]::Max([int]$request.limit, 1), 200) } else { 60 }
        $all = @([Hv]::Windows())
        $matched = @($all | Where-Object { $filter -eq '' -or $_.Title.ToLower().Contains($filter) })
        $items = @()
        foreach ($w in ($matched | Select-Object -First $limit)) {
          $items += [ordered]@{
            hwnd = (Format-Handle $w.Handle); title = $w.Title; className = $w.ClassName
            processId = $w.ProcessId; processName = (Get-ProcessNameCached $w.ProcessId)
            x = $w.X; y = $w.Y; width = $w.Width; height = $w.Height
            minimized = [bool]$w.Minimized; foreground = [bool]$w.Foreground
          }
        }
        Write-Line ([ordered]@{ id = $id; ok = $true; windows = $items; total = $matched.Count; truncated = ($matched.Count -gt $items.Count) })
      }
      'window' {
        if (Stop-Requested) { throw 'emergency stop is on' }
        $operation = [string]$request.operation
        $handle = [IntPtr]::Zero
        if ($request.hwnd) {
          $clean = ([string]$request.hwnd).Trim()
          if ($clean.StartsWith('0x') -or $clean.StartsWith('0X')) { $clean = $clean.Substring(2) }
          $handle = [IntPtr]([Convert]::ToInt64($clean, 16))
          if (-not [Hv]::WindowExists($handle)) { throw "no window with handle $($request.hwnd)" }
        } elseif ($request.title) {
          $needle = ([string]$request.title).ToLower()
          $hits = @([Hv]::Windows() | Where-Object { $_.Title.ToLower().Contains($needle) })
          if ($hits.Count -eq 0) { throw "no visible window title contains '$($request.title)'" }
          $handle = $hits[0].Handle
        } else { throw 'a window operation needs a title or an hwnd' }

        $before = Get-WindowRef $handle
        $focused = $false
        switch ($operation) {
          'focus' { $focused = [Hv]::Focus($handle); Start-Sleep -Milliseconds 120 }
          'minimize' { [Hv]::Minimize($handle); Start-Sleep -Milliseconds 90 }
          'maximize' { [Hv]::Maximize($handle); Start-Sleep -Milliseconds 90 }
          'restore' { [Hv]::Restore($handle); Start-Sleep -Milliseconds 90 }
          'close' { [Hv]::Close($handle); Start-Sleep -Milliseconds 90 }
          default { throw "unknown window operation: $operation" }
        }
        Write-Line ([ordered]@{
          id = $id; ok = $true; action = $operation; window = $before
          focused = [bool]$focused; closed = (-not [Hv]::WindowExists($handle))
          pointer = (Get-Pointer); foreground = (Get-WindowRef ([Hv]::GetForegroundWindow()))
        })
      }
      'uia' {
        $handle = [IntPtr]::Zero
        if ($request.hwnd) {
          $clean = ([string]$request.hwnd).Trim()
          if ($clean.StartsWith('0x') -or $clean.StartsWith('0X')) { $clean = $clean.Substring(2) }
          $handle = [IntPtr]([Convert]::ToInt64($clean, 16))
        } elseif ($request.title) {
          $needle = ([string]$request.title).ToLower()
          $hits = @([Hv]::Windows() | Where-Object { $_.Title.ToLower().Contains($needle) })
          if ($hits.Count -eq 0) { throw "no visible window title contains '$($request.title)'" }
          $handle = $hits[0].Handle
        }
        $point = $null
        if ($null -ne $request.x) { $point = @([int]$request.x, [int]$request.y) }
        $depth = if ($null -ne $request.depth) { [int]$request.depth } else { 4 }
        $max = if ($null -ne $request.max) { [int]$request.max } else { 120 }
        $nodes = Get-UiaTree $handle $depth $max $point
        Write-Line ([ordered]@{ id = $id; ok = $true; nodes = $nodes; count = $nodes.Count })
      }
      'quit' {
        Write-Line ([ordered]@{ id = $id; ok = $true })
        exit 0
      }
      default { throw "unknown command: $cmd" }
    }
  } catch {
    Fail $id $_.Exception.Message
  }
}
