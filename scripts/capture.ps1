# dsh-desktop-view capture helper.
#
# One short-lived Windows PowerShell process per observation: reads the pointer,
# monitor layout and window titles, and (in snapshot mode) writes a PNG of the
# chosen region. All output is one UTF-8 JSON document written to -OutJson so the
# host never has to parse localized console text.
param(
  [ValidateSet('snapshot', 'cursor')][string]$Mode = 'snapshot',
  [string]$OutJson,
  [string]$OutPng = '',
  [int]$MonitorIndex = 0,
  [int]$MaxWidth = 0,
  [int]$MarkCursor = 1
)

$ErrorActionPreference = 'Stop'

function Fail([string]$message) {
  $payload = [ordered]@{ ok = $false; error = $message }
  if ($OutJson) {
    [System.IO.File]::WriteAllText($OutJson, ($payload | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
  }
  exit 1
}

if (-not $OutJson) { exit 2 }

$cs = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class DvMonitorInfo {
    public int Index;
    public int X;
    public int Y;
    public int Width;
    public int Height;
    public bool Primary;
}

public static class DvNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);

    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO info);
    [DllImport("user32.dll")] public static extern uint GetDpiForSystem();

    public static List<DvMonitorInfo> Monitors() {
        List<DvMonitorInfo> monitors = new List<DvMonitorInfo>();
        MonitorEnumProc callback = delegate(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data) {
            MONITORINFO info = new MONITORINFO();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (GetMonitorInfo(hMonitor, ref info)) {
                DvMonitorInfo entry = new DvMonitorInfo();
                entry.Index = monitors.Count + 1;
                entry.X = info.rcMonitor.Left;
                entry.Y = info.rcMonitor.Top;
                entry.Width = info.rcMonitor.Right - info.rcMonitor.Left;
                entry.Height = info.rcMonitor.Bottom - info.rcMonitor.Top;
                entry.Primary = (info.dwFlags & 1u) != 0u;
                monitors.Add(entry);
            }
            return true;
        };
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
        GC.KeepAlive(callback);
        return monitors;
    }

    public static string WindowTitle(IntPtr hWnd) {
        StringBuilder text = new StringBuilder(1024);
        GetWindowTextW(hWnd, text, text.Capacity);
        return text.ToString();
    }

    public static string WindowClass(IntPtr hWnd) {
        StringBuilder text = new StringBuilder(512);
        GetClassNameW(hWnd, text, text.Capacity);
        return text.ToString();
    }

    public static int[] CursorPosition() {
        POINT point;
        if (!GetCursorPos(out point)) return null;
        return new int[] { point.X, point.Y };
    }

    public static IntPtr WindowAt(int x, int y) {
        POINT point;
        point.X = x;
        point.Y = y;
        IntPtr hWnd = WindowFromPoint(point);
        if (hWnd == IntPtr.Zero) return IntPtr.Zero;
        // GA_ROOT: report the top-level window a point control belongs to.
        return GetAncestor(hWnd, 2u);
    }

    public static int WindowProcessId(IntPtr hWnd) {
        uint processId;
        GetWindowThreadProcessId(hWnd, out processId);
        return (int)processId;
    }
}
'@

try {
  Add-Type -TypeDefinition $cs | Out-Null
} catch {
  Fail "cannot load the desktop helper: $($_.Exception.Message)"
}

try { [DvNative]::SetProcessDPIAware() | Out-Null } catch { }

function Get-WindowInfo($handle) {
  if ($null -eq $handle -or $handle -eq [IntPtr]::Zero) {
    return [ordered]@{ title = ''; className = ''; processId = 0; processName = '' }
  }
  $procId = [DvNative]::WindowProcessId($handle)
  $procName = ''
  if ($procId -gt 0) {
    try { $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
  }
  return [ordered]@{
    title       = [DvNative]::WindowTitle($handle)
    className   = [DvNative]::WindowClass($handle)
    processId   = $procId
    processName = $procName
  }
}

try {
  $monitors = @([DvNative]::Monitors())
  if ($monitors.Count -eq 0) { Fail 'no display monitor was reported by the desktop' }

  $cursorXY = [DvNative]::CursorPosition()
  if ($null -eq $cursorXY) { Fail 'cannot read the pointer position' }

  $vx = [int]::MaxValue
  $vy = [int]::MaxValue
  $vr = [int]::MinValue
  $vb = [int]::MinValue
  foreach ($m in $monitors) {
    if ($m.X -lt $vx) { $vx = $m.X }
    if ($m.Y -lt $vy) { $vy = $m.Y }
    if (($m.X + $m.Width) -gt $vr) { $vr = $m.X + $m.Width }
    if (($m.Y + $m.Height) -gt $vb) { $vb = $m.Y + $m.Height }
  }

  $rx = $vx
  $ry = $vy
  $rw = $vr - $vx
  $rh = $vb - $vy
  $kind = 'virtual-desktop'
  if ($MonitorIndex -gt 0) {
    $target = $null
    foreach ($m in $monitors) { if ($m.Index -eq $MonitorIndex) { $target = $m } }
    if ($null -eq $target) { Fail "monitor $MonitorIndex does not exist; this desktop has $($monitors.Count) monitor(s)" }
    $rx = $target.X
    $ry = $target.Y
    $rw = $target.Width
    $rh = $target.Height
    $kind = "monitor $MonitorIndex"
  }
  if ($rw -le 0 -or $rh -le 0) { Fail "the chosen region has no area ($($rw)x$($rh))" }

  $outW = $rw
  $outH = $rh
  if ($MaxWidth -gt 0 -and $rw -gt $MaxWidth) {
    $outW = $MaxWidth
    $outH = [int][Math]::Round($rh * $MaxWidth / $rw)
  }
  $imageScale = $outW / $rw

  $cursorX = $cursorXY[0]
  $cursorY = $cursorXY[1]
  $onImage = ($cursorX -ge $rx) -and ($cursorX -lt ($rx + $rw)) -and ($cursorY -ge $ry) -and ($cursorY -lt ($ry + $rh))
  $imageX = [int][Math]::Round(($cursorX - $rx) * $imageScale)
  $imageY = [int][Math]::Round(($cursorY - $ry) * $imageScale)

  $foreground = Get-WindowInfo ([DvNative]::GetForegroundWindow())
  $underCursor = Get-WindowInfo ([DvNative]::WindowAt($cursorX, $cursorY))

  $imageInfo = $null
  if ($Mode -eq 'snapshot') {
    if (-not $OutPng) { Fail 'snapshot mode requires an output image path' }
    Add-Type -AssemblyName System.Drawing
    $bitmap = $null
    $graphics = $null
    try {
      $bitmap = New-Object -TypeName System.Drawing.Bitmap -ArgumentList $rw, $rh
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen($rx, $ry, 0, 0, (New-Object -TypeName System.Drawing.Size -ArgumentList $rw, $rh), [System.Drawing.CopyPixelOperation]::SourceCopy)

      if ($outW -ne $rw -or $outH -ne $rh) {
        $resized = New-Object -TypeName System.Drawing.Bitmap -ArgumentList $outW, $outH
        $resizeGraphics = [System.Drawing.Graphics]::FromImage($resized)
        $resizeGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $resizeGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $resizeGraphics.DrawImage($bitmap, 0, 0, $outW, $outH)
        $resizeGraphics.Dispose()
        $graphics.Dispose()
        $bitmap.Dispose()
        $bitmap = $resized
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      }

      if ($MarkCursor -eq 1 -and $onImage) {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $radius = 18
        $ring = New-Object -TypeName System.Drawing.Pen -ArgumentList ([System.Drawing.Color]::White), 4
        $mark = [System.Drawing.Color]::FromArgb(255, 220, 38, 38)
        $dot = New-Object -TypeName System.Drawing.Pen -ArgumentList $mark, 2
        $dotBrush = New-Object -TypeName System.Drawing.SolidBrush -ArgumentList $mark
        $graphics.DrawEllipse($ring, ($imageX - $radius), ($imageY - $radius), (2 * $radius), (2 * $radius))
        $graphics.DrawEllipse($dot, ($imageX - $radius), ($imageY - $radius), (2 * $radius), (2 * $radius))
        $graphics.DrawLine($ring, ($imageX - $radius - 10), $imageY, ($imageX - $radius - 3), $imageY)
        $graphics.DrawLine($ring, ($imageX + $radius + 3), $imageY, ($imageX + $radius + 10), $imageY)
        $graphics.DrawLine($ring, $imageX, ($imageY - $radius - 10), $imageX, ($imageY - $radius - 3))
        $graphics.DrawLine($ring, $imageX, ($imageY + $radius + 3), $imageX, ($imageY + $radius + 10))
        $graphics.FillEllipse($dotBrush, ($imageX - 2), ($imageY - 2), 4, 4)
        $ring.Dispose()
        $dot.Dispose()
        $dotBrush.Dispose()
      }

      $bitmap.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
      $imageInfo = [ordered]@{
        path         = $OutPng
        width        = $outW
        height       = $outH
        sourceWidth  = $rw
        sourceHeight = $rh
        scale        = [Math]::Round($imageScale, 4)
        bytes        = (Get-Item -LiteralPath $OutPng).Length
      }
    } finally {
      if ($null -ne $graphics) { $graphics.Dispose() }
      if ($null -ne $bitmap) { $bitmap.Dispose() }
    }
  }

  $dpi = 96
  try {
    $reported = [DvNative]::GetDpiForSystem()
    if ($reported -gt 0) { $dpi = $reported }
  } catch { $dpi = 96 }

  $monitorView = @()
  foreach ($m in $monitors) {
    $monitorView += [ordered]@{
      index   = $m.Index
      x       = $m.X
      y       = $m.Y
      width   = $m.Width
      height  = $m.Height
      primary = [bool]$m.Primary
    }
  }

  $result = [ordered]@{
    ok               = $true
    mode             = $Mode
    capturedAt       = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
    region           = [ordered]@{ x = $rx; y = $ry; width = $rw; height = $rh; kind = $kind }
    virtualScreen    = [ordered]@{ x = $vx; y = $vy; width = ($vr - $vx); height = ($vb - $vy) }
    monitors         = $monitorView
    dpiScale         = [Math]::Round($dpi / 96.0, 3)
    cursor           = [ordered]@{ screenX = $cursorX; screenY = $cursorY; imageX = $imageX; imageY = $imageY; onImage = [bool]$onImage }
    foregroundWindow = $foreground
    windowUnderCursor = $underCursor
  }
  if ($null -ne $imageInfo) { $result.image = $imageInfo }

  [System.IO.File]::WriteAllText($OutJson, ($result | ConvertTo-Json -Depth 8 -Compress), (New-Object System.Text.UTF8Encoding($false)))
  exit 0
} catch {
  Fail $_.Exception.Message
}
