# Probe: toolbox expand (fixed-window model).
# The toolbox is a FIXED 520x784 DIP window (+16px shadow margin each side =
# 552x816), resizable:false. Opening/closing the menu never resizes or moves it:
# the icon sits at the center (236,368) in content coords, and the panel appears
# in one of the four reserved quadrants. This probe asserts:
#   - the window rect stays identical before / during / after the menu toggle
#   - the yellow icon centroid does not jump or leave the screen
#   - the menu panel actually becomes visible somewhere around the icon
# ASCII only (PowerShell 5.1 reads scripts as ANSI).
# Usage: powershell -ExecutionPolicy Bypass -File testjs\probe\widget-expand-probe.ps1
# The app must be running with the floating toolbox enabled, in icon state.

param(
  [int]$SettleMs = 1000,
  [int]$FrameMs = 20
)

Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public class ToolProbe {
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }

  private static IntPtr _found = IntPtr.Zero;
  private static int _minW, _maxW, _minH, _maxH;

  private static bool Cb(IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h)) return true;
    var sb = new StringBuilder(128);
    GetClassNameW(h, sb, 128);
    if (sb.ToString() != "Chrome_WidgetWin_1") return true;
    RECT r;
    if (!GetWindowRect(h, out r)) return true;
    int w = r.right - r.left, ht = r.bottom - r.top;
    if (w >= _minW && w <= _maxW && ht >= _minH && ht <= _maxH) { _found = h; return false; }
    return true;
  }

  public static IntPtr Find(int minW, int maxW, int minH, int maxH) {
    _minW = minW; _maxW = maxW; _minH = minH; _maxH = maxH; _found = IntPtr.Zero;
    EnumWindows(Cb, IntPtr.Zero);
    return _found;
  }

  // Both windows share the title "XiaoZuJian"; distinguish by geometry.
  // Toolbox: 552x816 DIP (+ DPI scale), resizable:false.
  // Desktop widget: 320 DIP wide, ~95% of work-area height, resizable:true.
  // Accept the fixed toolbox size within a DPI-scaled tolerance; reject the
  // wide-but-short and narrow-but-tall desktop widget shapes.
  private static bool CbTitle(IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h)) return true;
    var sb = new StringBuilder(128);
    GetClassNameW(h, sb, 128);
    if (sb.ToString() != "Chrome_WidgetWin_1") return true;
    var tt = new StringBuilder(128);
    GetWindowTextW(h, tt, 128);
    if (!tt.ToString().Contains("\u5C0F\u7EC4\u4EF6")) return true;
    RECT r;
    if (!GetWindowRect(h, out r)) return true;
    int w = r.right - r.left, ht = r.bottom - r.top;
    // scale from width, then require height to match the same scale
    double sc = w / 552.0;
    if (sc < 0.6 || sc > 3.5) return true;
    if (Math.Abs(ht - 816 * sc) > 40 * sc) return true;
    _found = h;
    return false;
  }

  public static IntPtr FindToolbox() {
    _found = IntPtr.Zero;
    EnumWindows(CbTitle, IntPtr.Zero);
    return _found;
  }

  public static RECT Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return r; }

  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(140);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(40);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }

  // Count pixels differing by more than tol in any channel between two same-size
  // bitmaps. Used to prove the menu panel actually appeared/disappeared: the fixed
  // window never resizes, so a large diff can only come from panel contents.
  public static int DiffPixels(Bitmap a, Bitmap b, int tol) {
    if (a.Width != b.Width || a.Height != b.Height) return -1;
    int diff = 0;
    var da = a.LockBits(new Rectangle(0, 0, a.Width, a.Height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
    var db = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
    int stride = da.Stride, w = a.Width, h = a.Height;
    byte[] ba = new byte[stride * h], bb = new byte[stride * h];
    Marshal.Copy(da.Scan0, ba, 0, ba.Length);
    Marshal.Copy(db.Scan0, bb, 0, bb.Length);
    a.UnlockBits(da); b.UnlockBits(db);
    for (int y = 0; y < h; y++) {
      int row = y * stride;
      for (int x = 0; x < w; x++) {
        int i = row + x * 3;
        if (Math.Abs(ba[i] - bb[i]) > tol || Math.Abs(ba[i+1] - bb[i+1]) > tol || Math.Abs(ba[i+2] - bb[i+2]) > tol) diff++;
      }
    }
    return diff;
  }

  // Centroid of pixels close to (tr,tg,tb); -1 when nothing matches.
  public static void FindColor(Bitmap bmp, int tr, int tg, int tb, int tol,
                               out double cx, out double cy, out int count) {
    cx = -1; cy = -1; count = 0;
    var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height),
                            ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
    int stride = data.Stride, w = bmp.Width, h = bmp.Height;
    byte[] buf = new byte[stride * h];
    Marshal.Copy(data.Scan0, buf, 0, buf.Length);
    bmp.UnlockBits(data);
    long sx = 0, sy = 0;
    for (int y = 0; y < h; y++) {
      int row = y * stride;
      for (int x = 0; x < w; x++) {
        int i = row + x * 3;
        int b = buf[i], g = buf[i + 1], r = buf[i + 2];
        if (Math.Abs(r - tr) <= tol && Math.Abs(g - tg) <= tol && Math.Abs(b - tb) <= tol) {
          sx += x; sy += y; count++;
        }
      }
    }
    if (count > 0) { cx = (double)sx / count; cy = (double)sy / count; }
  }
}
'@ -ReferencedAssemblies System.Drawing

[void][ToolProbe]::SetProcessDPIAware()
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

$script:fail = 0
function Fail([string]$msg) { Write-Output "FAIL  $msg"; $script:fail++ }
function Report([string]$msg) { Write-Output "info  $msg" }

function Get-Rect($h) { return [ToolProbe]::Rect($h) }

# Capture a box around (cx,cy) and return icon centroid in screen coords, or $null.
function Find-Icon([int]$cx, [int]$cy, [int]$half) {
  $l = [Math]::Max($wa.Left, $cx - $half)
  $t = [Math]::Max($wa.Top, $cy - $half)
  $r = [Math]::Min($wa.Right - 1, $cx + $half)
  $b = [Math]::Min($wa.Bottom - 1, $cy + $half)
  $ww = $r - $l + 1
  $hh = $b - $t + 1
  if ($ww -le 0 -or $hh -le 0) { return $null }
  $bmp = New-Object System.Drawing.Bitmap $ww, $hh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($l, $t, 0, 0, (New-Object System.Drawing.Size $ww, $hh))
  $g.Dispose()
  $ccx = 0.0; $ccy = 0.0; $n = 0
  [ToolProbe]::FindColor($bmp, 255, 224, 138, 18, [ref]$ccx, [ref]$ccy, [ref]$n)
  $bmp.Dispose()
  # the fab circle is ~1800 px at 100%; smaller than this is the note icon / noise
  if ($n -lt 400) { return $null }
  return @(($l + $ccx), ($t + $ccy), $n)
}

# Snapshot the whole window rect (screen-composited) for panel diffing.
function Grab-Window([int]$l, [int]$t, [int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($l, $t, 0, 0, (New-Object System.Drawing.Size $w, $h))
  $g.Dispose()
  return $bmp
}

function Measure-Motion([int]$cx, [int]$cy, [int]$half, [int]$ms) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $maxDev = 0.0
  $lost = 0
  $frames = 0
  $last = $null
  while ($sw.ElapsedMilliseconds -lt $ms) {
    $p = Find-Icon $cx $cy $half
    if ($p) {
      $d = [Math]::Sqrt([Math]::Pow($p[0] - $cx, 2) + [Math]::Pow($p[1] - $cy, 2))
      if ($d -gt $maxDev) { $maxDev = $d }
      $last = $p
      $frames++
    } else {
      $lost++
    }
    Start-Sleep -Milliseconds $FrameMs
  }
  return @{ MaxDev = $maxDev; Lost = $lost; Frames = $frames; Last = $last }
}

# ---- locate the fixed-size toolbox window ----
$hwnd = [ToolProbe]::FindToolbox()
if ($hwnd -eq [IntPtr]::Zero) {
  Write-Output "toolbox window not found (fixed 552x816 at 100% DPI expected). Start the app with the floating toolbox enabled."
  exit 2
}

$r0 = Get-Rect $hwnd
$winW = $r0.right - $r0.left
$winH = $r0.bottom - $r0.top
$scale = $winW / 552.0
if ($scale -lt 0.6 -or $scale -gt 3.5) {
  Write-Output "FAIL  unexpected toolbox size {0}x{1} (scale={2})" -f $winW, $winH, $scale
  exit 3
}
Report ("window hwnd=0x{0:X} rect={1},{2} {3}x{4} scale={5:N2}" -f [int64]$hwnd, $r0.left, $r0.top, $winW, $winH, $scale)
$originX = $r0.left
$originY = $r0.top

# ---- place it near the bottom-right corner (panel usually opens left/up) ----
$tx = $wa.Right - $winW
$ty = $wa.Bottom - $winH - [int](40 * $scale)
[void][ToolProbe]::SetWindowPos($hwnd, [IntPtr]::Zero, $tx, $ty, 0, 0, 0x0001 -bor 0x0004 -bor 0x0010)
Start-Sleep -Milliseconds 500
$r1 = Get-Rect $hwnd
Report ("moved to {0},{1}" -f $r1.left, $r1.top)
if ([Math]::Abs(($r1.right - $r1.left) - $winW) -gt 4 -or [Math]::Abs(($r1.bottom - $r1.top) - $winH) -gt 4) {
  Fail "toolbox is resizable (size changed when moved); expected a fixed window"
}

# Icon center: window rect includes the 16px shadow margin; content offset is
# (236,368) for the icon's top-left, plus half the 48px icon => (260,392) in
# content coords, so (276,408) in window-rect coords at 100% DPI.
$iconCx = [int]($r1.left + (16 + 236 + 24) * $scale)
$iconCy = [int]($r1.top + (16 + 368 + 24) * $scale)
$half = [int](45 * $scale)
$base = Find-Icon $iconCx $iconCy $half
if (-not $base) {
  Write-Output "FAIL  icon color not found near window center ({0},{1}); rect={2},{3}" -f $iconCx, $iconCy, $r1.left, $r1.top
  exit 4
}
$iconCx = [int]$base[0]
$iconCy = [int]$base[1]
Report ("icon baseline={0},{1} pixels={2}" -f $iconCx, $iconCy, $base[2])

# Baseline screenshot of the fixed window area; panel appearance is measured
# as a large pixel diff against it (window never resizes or moves).
$shotClosed = Grab-Window $r1.left $r1.top $winW $winH

# ---- open the menu: window must stay put, icon must not jump ----
[ToolProbe]::Click($iconCx, $iconCy)
$open = Measure-Motion $iconCx $iconCy $half $SettleMs
$r2 = Get-Rect $hwnd
$openW = $r2.right - $r2.left
$openH = $r2.bottom - $r2.top

Report ("open: rect={0},{1} {2}x{3} dx={4} dy={5}" -f $r2.left, $r2.top, $openW, $openH, ($r2.left - $r1.left), ($r2.top - $r1.top))
Report ("open: icon maxDev={0:N1} lost={1}/{2} last={3},{4}" -f $open.MaxDev, $open.Lost, ($open.Frames + $open.Lost), $open.Last[0], $open.Last[1])
$shotOpen = Grab-Window $r2.left $r2.top $winW $winH
$panelDiff = [ToolProbe]::DiffPixels($shotClosed, $shotOpen, 18)
Report ("panel diff pixels={0}" -f $panelDiff)
# panel is ~228x310 DIP; at 100% that is ~70k pixels of surface color.
if ($panelDiff -lt [int](20000 * $scale * $scale)) {
  Fail ("menu panel did not appear (only {0} pixels changed; expected >= {1})" -f $panelDiff, [int](20000 * $scale * $scale))
}

if ($open.MaxDev -gt 15 * $scale) { Fail ("icon jumped {0:N1}px while opening" -f $open.MaxDev) }
if ($open.Last -and ([Math]::Abs($open.Last[0] - $iconCx) -gt 8 * $scale -or [Math]::Abs($open.Last[1] - $iconCy) -gt 8 * $scale)) {
  Fail ("icon ended at {0},{1} (was {2},{3})" -f $open.Last[0], $open.Last[1], $iconCx, $iconCy)
}
if ($open.Lost -gt 2) { Fail ("icon lost in {0} frames (pushed away / clipped)" -f $open.Lost) }
if ([Math]::Abs(($r2.left - $r1.left)) -gt 4 -or [Math]::Abs(($r2.top - $r1.top)) -gt 4) {
  Fail ("window moved on open by {0},{1} (fixed-window model: must not move)" -f ($r2.left - $r1.left), ($r2.top - $r1.top))
}
if ([Math]::Abs($openW - $winW) -gt 4 -or [Math]::Abs($openH - $winH) -gt 4) {
  Fail ("window resized on open to {0}x{1} (expected {2}x{3})" -f $openW, $openH, $winW, $winH)
}
if ($r2.right -gt $wa.Right + 20 * $scale -or $r2.bottom -gt $wa.Bottom + 20 * $scale) { Fail "window exceeds the work area" }

# ---- close by clicking the icon again (fixed window: no padding-strip trick) ----
[ToolProbe]::Click($iconCx, $iconCy)
$close = Measure-Motion $iconCx $iconCy $half $SettleMs
$r3 = Get-Rect $hwnd
Report ("close: rect={0},{1} {2}x{3}" -f $r3.left, $r3.top, ($r3.right - $r3.left), ($r3.bottom - $r3.top))
Report ("close: icon maxDev={0:N1} lost={1} last={2},{3}" -f $close.MaxDev, $close.Lost, $close.Last[0], $close.Last[1])
$shotClosed2 = Grab-Window $r3.left $r3.top $winW $winH
$closeDiff = [ToolProbe]::DiffPixels($shotOpen, $shotClosed2, 18)
Report ("close diff pixels={0}" -f $closeDiff)
if ($closeDiff -lt [int](20000 * $scale * $scale)) {
  Fail ("menu panel did not disappear (only {0} pixels changed)" -f $closeDiff)
}
$shotClosed.Dispose(); $shotOpen.Dispose(); $shotClosed2.Dispose()
if ($close.MaxDev -gt 15 * $scale) { Fail ("icon jumped {0:N1}px while closing" -f $close.MaxDev) }
if ($close.Last -and ([Math]::Abs($close.Last[0] - $iconCx) -gt 8 * $scale -or [Math]::Abs($close.Last[1] - $iconCy) -gt 8 * $scale)) {
  Fail ("icon did not return to {0},{1}" -f $iconCx, $iconCy)
}
if ([Math]::Abs(($r3.right - $r3.left) - $winW) -gt 4 -or [Math]::Abs(($r3.bottom - $r3.top) - $winH) -gt 4) {
  Fail "window resized on close (fixed-window model: must stay the same size)"
}
if ([Math]::Abs(($r3.left - $r1.left)) -gt 4 -or [Math]::Abs(($r3.top - $r1.top)) -gt 4) {
  Fail "window moved on close (fixed-window model: must not move)"
}

Write-Output "failures=$($script:fail)"
# restore the toolbox to the position it had before the probe
[void][ToolProbe]::SetWindowPos($hwnd, [IntPtr]::Zero, $originX, $originY, 0, 0, 0x0001 -bor 0x0004 -bor 0x0010)
if ($script:fail -gt 0) { exit 1 }
Write-Output "PASS"
exit 0
