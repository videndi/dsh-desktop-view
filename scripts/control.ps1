# dsh-desktop-view input helper.
#
# One short-lived Windows PowerShell process per action. The host writes a JSON
# request (action + arguments) and this script answers with a JSON result, so no
# localized console text is ever parsed. Coordinates are physical pixels: the
# process is DPI aware before any input is sent.
param(
  [Parameter(Mandatory = $true)][string]$Request,
  [Parameter(Mandatory = $true)][string]$OutJson
)

$ErrorActionPreference = 'Stop'

function Fail([string]$message) {
  $payload = [ordered]@{ ok = $false; error = $message }
  [System.IO.File]::WriteAllText($OutJson, ($payload | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
  exit 1
}

function Has-Prop($object, [string]$name) {
  if ($null -eq $object) { return $false }
  $property = $object.PSObject.Properties[$name]
  return ($null -ne $property) -and ($null -ne $property.Value)
}

$cs = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class DvWindowInfo {
    public IntPtr Handle;
    public string Title;
    public string ClassName;
    public int ProcessId;
    public int X;
    public int Y;
    public int Width;
    public int Height;
    public bool Minimized;
    public bool Foreground;
}

public static class DvInput {
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool PostMessageW(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool doAttach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    const uint INPUT_MOUSE = 0;
    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800;
    const uint MOUSEEVENTF_HWHEEL = 0x01000;

    static int InputSize { get { return Marshal.SizeOf(typeof(INPUT)); } }

    public static void DpiAware() { SetProcessDPIAware(); }

    public static int[] VirtualScreen() {
        return new int[] { GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79) };
    }

    public static int[] Cursor() {
        POINT point;
        if (!GetCursorPos(out point)) return null;
        return new int[] { point.X, point.Y };
    }

    public static bool MoveTo(int x, int y) { return SetCursorPos(x, y); }

    static void MouseEvent(uint flags, uint data) {
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.u.mi.dwFlags = flags;
        input.u.mi.mouseData = data;
        SendInput(1, new INPUT[] { input }, InputSize);
    }

    public static void Button(string button, bool down) {
        uint flags;
        if (button == "right") flags = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
        else if (button == "middle") flags = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
        else flags = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
        MouseEvent(flags, 0);
    }

    public static void Wheel(int delta, bool horizontal) {
        MouseEvent(horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, unchecked((uint)delta));
    }

    static void KeyEvent(ushort vk, ushort scan, uint flags) {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.u.ki.wVk = vk;
        input.u.ki.wScan = scan;
        input.u.ki.dwFlags = flags;
        SendInput(1, new INPUT[] { input }, InputSize);
    }

    public static void KeyDown(int vk, bool extended) {
        KeyEvent((ushort)vk, 0, extended ? KEYEVENTF_EXTENDEDKEY : 0u);
    }

    public static void KeyUp(int vk, bool extended) {
        KeyEvent((ushort)vk, 0, (extended ? KEYEVENTF_EXTENDEDKEY : 0u) | KEYEVENTF_KEYUP);
    }

    public static void TypeChar(char value) {
        KeyEvent(0, (ushort)value, KEYEVENTF_UNICODE);
        KeyEvent(0, (ushort)value, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
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

    public static int WindowProcessId(IntPtr hWnd) {
        uint processId;
        GetWindowThreadProcessId(hWnd, out processId);
        return (int)processId;
    }

    public static bool WindowExists(IntPtr hWnd) { return IsWindow(hWnd); }

    public static List<DvWindowInfo> Windows() {
        List<DvWindowInfo> windows = new List<DvWindowInfo>();
        IntPtr foreground = GetForegroundWindow();
        EnumWindowsProc callback = delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            string title = WindowTitle(hWnd);
            if (title.Length == 0) return true;
            RECT rect;
            GetWindowRect(hWnd, out rect);
            DvWindowInfo info = new DvWindowInfo();
            info.Handle = hWnd;
            info.Title = title;
            info.ClassName = WindowClass(hWnd);
            info.ProcessId = WindowProcessId(hWnd);
            info.X = rect.Left;
            info.Y = rect.Top;
            info.Width = rect.Right - rect.Left;
            info.Height = rect.Bottom - rect.Top;
            info.Minimized = IsIconic(hWnd);
            info.Foreground = hWnd == foreground;
            windows.Add(info);
            return true;
        };
        EnumWindows(callback, IntPtr.Zero);
        GC.KeepAlive(callback);
        return windows;
    }

    public static bool Focus(IntPtr hWnd) {
        if (IsIconic(hWnd)) ShowWindow(hWnd, 9);
        ShowWindow(hWnd, 5);
        uint foregroundPid;
        IntPtr foreground = GetForegroundWindow();
        uint foregroundThread = GetWindowThreadProcessId(foreground, out foregroundPid);
        uint currentThread = GetCurrentThreadId();
        bool attached = false;
        try {
            if (foregroundThread != currentThread) {
                attached = AttachThreadInput(foregroundThread, currentThread, true);
            }
            BringWindowToTop(hWnd);
            bool raised = SetForegroundWindow(hWnd);
            if (!raised) {
                // A synthetic ALT press releases the foreground lock on most systems.
                KeyEvent(0x12, 0, 0);
                KeyEvent(0x12, 0, KEYEVENTF_KEYUP);
                raised = SetForegroundWindow(hWnd);
            }
        } finally {
            if (attached) AttachThreadInput(foregroundThread, currentThread, false);
        }
        return GetForegroundWindow() == hWnd;
    }

    public static void Minimize(IntPtr hWnd) { ShowWindow(hWnd, 6); }
    public static void Maximize(IntPtr hWnd) { ShowWindow(hWnd, 3); }
    public static void Restore(IntPtr hWnd) { ShowWindow(hWnd, 9); }
    public static void Close(IntPtr hWnd) { PostMessageW(hWnd, 0x0010, IntPtr.Zero, IntPtr.Zero); }
}
'@

try {
  Add-Type -TypeDefinition $cs | Out-Null
  [DvInput]::DpiAware() | Out-Null
} catch {
  Fail "cannot load the input helper: $($_.Exception.Message)"
}

if (-not (Test-Path -LiteralPath $Request)) { Fail "request file not found: $Request" }
try {
  $req = Get-Content -LiteralPath $Request -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  Fail "cannot read the request: $($_.Exception.Message)"
}
if (-not (Has-Prop $req 'action')) { Fail 'the request has no action' }
$action = [string]$req.action

$script:processNames = @{}
function Get-ProcessNameCached([int]$processId) {
  if ($processId -le 0) { return '' }
  if (-not $script:processNames.ContainsKey($processId)) {
    $name = ''
    try { $name = (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { }
    $script:processNames[$processId] = $name
  }
  return $script:processNames[$processId]
}

function Format-Handle([IntPtr]$handle) {
  return ('0x{0:X8}' -f $handle.ToInt64())
}

function Get-WindowRef([IntPtr]$handle) {
  $processId = [DvInput]::WindowProcessId($handle)
  return [ordered]@{
    hwnd        = (Format-Handle $handle)
    title       = [DvInput]::WindowTitle($handle)
    className   = [DvInput]::WindowClass($handle)
    processId   = $processId
    processName = (Get-ProcessNameCached $processId)
  }
}

function Convert-WindowInfo($window) {
  return [ordered]@{
    hwnd        = (Format-Handle $window.Handle)
    title       = $window.Title
    className   = $window.ClassName
    processId   = $window.ProcessId
    processName = (Get-ProcessNameCached $window.ProcessId)
    x           = $window.X
    y           = $window.Y
    width       = $window.Width
    height      = $window.Height
    minimized   = [bool]$window.Minimized
    foreground  = [bool]$window.Foreground
  }
}

function Get-Pointer {
  $point = [DvInput]::Cursor()
  return [ordered]@{ x = $point[0]; y = $point[1] }
}

function Assert-Point([int]$x, [int]$y) {
  $screen = [DvInput]::VirtualScreen()
  $right = $screen[0] + $screen[2]
  $bottom = $screen[1] + $screen[3]
  if ($x -lt $screen[0] -or $x -ge $right -or $y -lt $screen[1] -or $y -ge $bottom) {
    Fail ('point (x={0}, y={1}) is outside the desktop; the virtual screen is {2}x{3} starting at ({4}, {5})' -f $x, $y, $screen[2], $screen[3], $screen[0], $screen[1])
  }
}

function Parse-Handle([string]$text) {
  $clean = $text.Trim()
  if ($clean.StartsWith('0x') -or $clean.StartsWith('0X')) { $clean = $clean.Substring(2) }
  if ($clean.Length -eq 0) { Fail "window handle is empty" }
  try { return [IntPtr]([Convert]::ToInt64($clean, 16)) } catch { Fail "window handle is not hexadecimal: $text" }
}

function Resolve-Window {
  if (Has-Prop $req 'hwnd') {
    $handle = Parse-Handle ([string]$req.hwnd)
    if (-not [DvInput]::WindowExists($handle)) { Fail ("no window with handle " + [string]$req.hwnd) }
    return $handle
  }
  if (Has-Prop $req 'title') {
    $needle = ([string]$req.title).ToLower()
    $hits = @([DvInput]::Windows() | Where-Object { $_.Title.ToLower().Contains($needle) })
    if ($hits.Count -eq 0) { Fail ("no visible window title contains '" + [string]$req.title + "'") }
    return $hits[0].Handle
  }
  Fail 'a window operation needs a title or an hwnd'
}

$result = $null

try {
  switch ($action) {
    'move' {
      Assert-Point ([int]$req.x) ([int]$req.y)
      [DvInput]::MoveTo([int]$req.x, [int]$req.y) | Out-Null
      Start-Sleep -Milliseconds 40
      $result = [ordered]@{ ok = $true; action = 'move'; to = (Get-Pointer) }
    }
    'click' {
      $button = if (Has-Prop $req 'button') { [string]$req.button } else { 'left' }
      if (@('left', 'right', 'middle') -notcontains $button) { Fail "unknown mouse button: $button" }
      $count = if (Has-Prop $req 'count') { [int]$req.count } else { 1 }
      if ($count -lt 1 -or $count -gt 5) { Fail 'count must be between 1 and 5' }
      if ((Has-Prop $req 'x') -and (Has-Prop $req 'y')) {
        Assert-Point ([int]$req.x) ([int]$req.y)
        [DvInput]::MoveTo([int]$req.x, [int]$req.y) | Out-Null
        Start-Sleep -Milliseconds 35
      }
      for ($i = 0; $i -lt $count; $i++) {
        if ($i -gt 0) { Start-Sleep -Milliseconds 45 }
        [DvInput]::Button($button, $true)
        Start-Sleep -Milliseconds 20
        [DvInput]::Button($button, $false)
      }
      Start-Sleep -Milliseconds 70
      $result = [ordered]@{ ok = $true; action = 'click'; button = $button; count = $count; at = (Get-Pointer) }
    }
    'drag' {
      $button = if (Has-Prop $req 'button') { [string]$req.button } else { 'left' }
      if (@('left', 'right', 'middle') -notcontains $button) { Fail "unknown mouse button: $button" }
      $fromX = [int]$req.fromX
      $fromY = [int]$req.fromY
      $toX = [int]$req.toX
      $toY = [int]$req.toY
      Assert-Point $fromX $fromY
      Assert-Point $toX $toY
      $steps = if (Has-Prop $req 'steps') { [int]$req.steps } else { 12 }
      $steps = [Math]::Min([Math]::Max($steps, 4), 60)
      $duration = if (Has-Prop $req 'durationMs') { [int]$req.durationMs } else { 350 }
      $duration = [Math]::Min([Math]::Max($duration, 0), 5000)
      $pause = [Math]::Max(1, [int]($duration / $steps))
      [DvInput]::MoveTo($fromX, $fromY) | Out-Null
      Start-Sleep -Milliseconds 50
      [DvInput]::Button($button, $true)
      Start-Sleep -Milliseconds 80
      for ($i = 1; $i -le $steps; $i++) {
        $ratio = $i / $steps
        $x = [int][Math]::Round($fromX + ($toX - $fromX) * $ratio)
        $y = [int][Math]::Round($fromY + ($toY - $fromY) * $ratio)
        [DvInput]::MoveTo($x, $y) | Out-Null
        Start-Sleep -Milliseconds $pause
      }
      Start-Sleep -Milliseconds 80
      [DvInput]::Button($button, $false)
      Start-Sleep -Milliseconds 70
      $result = [ordered]@{ ok = $true; action = 'drag'; button = $button; steps = $steps; at = (Get-Pointer) }
    }
    'scroll' {
      $delta = [int]$req.delta
      if ($delta -eq 0) { Fail 'delta must be non-zero' }
      $horizontal = if (Has-Prop $req 'horizontal') { [bool]$req.horizontal } else { $false }
      if ((Has-Prop $req 'x') -and (Has-Prop $req 'y')) {
        Assert-Point ([int]$req.x) ([int]$req.y)
        [DvInput]::MoveTo([int]$req.x, [int]$req.y) | Out-Null
        Start-Sleep -Milliseconds 35
      }
      [DvInput]::Wheel($delta * 120, $horizontal)
      Start-Sleep -Milliseconds 70
      $result = [ordered]@{ ok = $true; action = 'scroll'; delta = $delta; horizontal = $horizontal; at = (Get-Pointer) }
    }
    'type' {
      $text = [string]$req.text
      if ($text.Length -eq 0) { Fail 'text must not be empty' }
      $interval = if (Has-Prop $req 'intervalMs') { [int]$req.intervalMs } else { 8 }
      $interval = [Math]::Min([Math]::Max($interval, 0), 1000)
      $typed = 0
      foreach ($ch in $text.ToCharArray()) {
        if ($ch -eq "`r") { continue }
        elseif ($ch -eq "`n") {
          [DvInput]::KeyDown(0x0D, $false)
          [DvInput]::KeyUp(0x0D, $false)
        }
        elseif ($ch -eq "`t") {
          [DvInput]::KeyDown(0x09, $false)
          [DvInput]::KeyUp(0x09, $false)
        }
        else {
          [DvInput]::TypeChar($ch)
        }
        $typed++
        if ($interval -gt 0) { Start-Sleep -Milliseconds $interval }
      }
      Start-Sleep -Milliseconds 50
      $result = [ordered]@{ ok = $true; action = 'type'; chars = $typed }
    }
    'key' {
      $modifiers = @()
      if (Has-Prop $req 'modifierVks') { foreach ($value in $req.modifierVks) { $modifiers += [int]$value } }
      $keyVk = [int]$req.keyVk
      $extended = if (Has-Prop $req 'extended') { [bool]$req.extended } else { $false }
      foreach ($modifier in $modifiers) {
        [DvInput]::KeyDown([int]$modifier, $false)
        Start-Sleep -Milliseconds 15
      }
      [DvInput]::KeyDown($keyVk, $extended)
      Start-Sleep -Milliseconds 35
      [DvInput]::KeyUp($keyVk, $extended)
      Start-Sleep -Milliseconds 15
      for ($i = $modifiers.Count - 1; $i -ge 0; $i--) {
        [DvInput]::KeyUp([int]$modifiers[$i], $false)
        Start-Sleep -Milliseconds 10
      }
      Start-Sleep -Milliseconds 50
      $result = [ordered]@{ ok = $true; action = 'key' }
    }
    'windows' {
      $filter = if (Has-Prop $req 'filter') { ([string]$req.filter).ToLower() } else { '' }
      $limit = if (Has-Prop $req 'limit') { [int]$req.limit } else { 60 }
      $limit = [Math]::Min([Math]::Max($limit, 1), 200)
      $all = @([DvInput]::Windows())
      $matched = @($all | Where-Object { $filter -eq '' -or $_.Title.ToLower().Contains($filter) })
      $items = @()
      foreach ($window in ($matched | Select-Object -First $limit)) {
        $items += (Convert-WindowInfo $window)
      }
      $result = [ordered]@{
        ok        = $true
        action    = 'windows'
        windows   = $items
        total     = $matched.Count
        truncated = ($matched.Count -gt $items.Count)
      }
    }
    'window' {
      $operation = [string]$req.operation
      $handle = Resolve-Window
      $before = Get-WindowRef $handle
      $focused = $false
      switch ($operation) {
        'focus' {
          $focused = [DvInput]::Focus($handle)
          Start-Sleep -Milliseconds 150
        }
        'minimize' { [DvInput]::Minimize($handle); Start-Sleep -Milliseconds 120 }
        'maximize' { [DvInput]::Maximize($handle); Start-Sleep -Milliseconds 120 }
        'restore' { [DvInput]::Restore($handle); Start-Sleep -Milliseconds 120 }
        'close' { [DvInput]::Close($handle); Start-Sleep -Milliseconds 120 }
        default { Fail "unknown window operation: $operation" }
      }
      $result = [ordered]@{
        ok      = $true
        action  = $operation
        window  = $before
        focused = [bool]$focused
        closed  = (-not [DvInput]::WindowExists($handle))
      }
    }
    default { Fail "unknown action: $action" }
  }

  $result.pointer = Get-Pointer
  $result.foreground = Get-WindowRef ([DvInput]::GetForegroundWindow())

  [System.IO.File]::WriteAllText($OutJson, ($result | ConvertTo-Json -Depth 8 -Compress), (New-Object System.Text.UTF8Encoding($false)))
  exit 0
} catch {
  Fail $_.Exception.Message
}
