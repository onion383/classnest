# Probe: toolbox expand direction / icon anchoring.
# Moves the floating toolbox to the bottom-right corner, clicks the icon, samples
# the yellow icon while the menu expands, and asserts:
#   - the icon stays at the same screen position (no jump / no off-screen push)
#   - the window grows left and up (right/bottom edges stay anchored)
#   - closing returns to the same icon position without a jump
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
    // desktop widget is tall (>800 physical), the toolbox is not
    if (r.bottom - r.top > 800) return true;
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

# ---- locate the floating toolbox by its window title, normalizing to icon state ----
$hwnd = [ToolProbe]::FindToolbox()
if ($hwnd -eq [IntPtr]::Zero) {
  Write-Output "toolbox window not found. Start the app with the floating toolbox enabled."
  exit 2
}

$r0 = Get-Rect $hwnd
$w0 = $r0.right - $r0.left
$h0 = $r0.bottom - $r0.top
# expanded menu is 332x392 DIP (300 + 2*16 shadow); icon state is 80x80 DIP
if ($w0 -gt 200) {
  $scale0 = $w0 / 332.0
  Report ("toolbox is expanded ({0}x{1}); closing it first" -f $w0, $h0)
  [ToolProbe]::Click([int]($r0.left + 4 * $scale0), [int]($r0.top + 4 * $scale0))
  # wait until it really collapses; never continue with an expanded-window scale
  $deadline = (Get-Date).AddMilliseconds(2500)
  do {
    Start-Sleep -Milliseconds 100
    $r0 = Get-Rect $hwnd
  } while ((($r0.right - $r0.left) -gt 200) -and ((Get-Date) -lt $deadline))
  if (($r0.right - $r0.left) -gt 200) {
    Write-Output "FAIL  could not collapse the toolbox before the test"
    exit 3
  }
}

$winW = $r0.right - $r0.left
$winH = $r0.bottom - $r0.top
$scale = $winW / 80.0   # icon-state window is 80 DIP (48 + 2*16)
if ($scale -lt 0.8 -or $scale -gt 3.0) {
  Write-Output "FAIL  unexpected icon-state size {0}x{1} (scale={2})" -f $winW, $winH, $scale
  exit 3
}
Report ("window hwnd=0x{0:X} rect={1},{2} {3}x{4} scale={5:N2}" -f [int64]$hwnd, $r0.left, $r0.top, $winW, $winH, $scale)
$originX = $r0.left
$originY = $r0.top

# ---- place it near the bottom-right corner (forces left + up expansion) ----
$tx = $wa.Right - $winW
$ty = $wa.Bottom - $winH - [int](40 * $scale)
[void][ToolProbe]::SetWindowPos($hwnd, [IntPtr]::Zero, $tx, $ty, 0, 0, 0x0001 -bor 0x0004 -bor 0x0010)
Start-Sleep -Milliseconds 500
$r1 = Get-Rect $hwnd
Report ("moved to {0},{1}" -f $r1.left, $r1.top)

$iconCx = [int]($r1.left + (16 + 24) * $scale)
$iconCy = [int]($r1.top + (16 + 24) * $scale)
$half = [int](45 * $scale)
$base = Find-Icon $iconCx $iconCy $half
if (-not $base) {
  Write-Output "FAIL  icon color not found before click (rect=$($r1.left),$($r1.top))"
  exit 4
}
$iconCx = [int]$base[0]
$iconCy = [int]$base[1]
Report ("icon baseline={0},{1} pixels={2}" -f $iconCx, $iconCy, $base[2])

# ---- open the menu and watch the icon ----
[ToolProbe]::Click($iconCx, $iconCy)
$open = Measure-Motion $iconCx $iconCy $half $SettleMs
$r2 = Get-Rect $hwnd
$openW = $r2.right - $r2.left
$openH = $r2.bottom - $r2.top

Report ("open: rect={0},{1} {2}x{3} dx={4} dy={5} upLeft={6}" -f $r2.left, $r2.top, $openW, $openH, ($r2.left - $r1.left), ($r2.top - $r1.top), ($r2.left - $openW))
Report ("open: icon maxDev={0:N1} lost={1}/{2} last={3},{4}" -f $open.MaxDev, $open.Lost, ($open.Frames + $open.Lost), $open.Last[0], $open.Last[1])

if ($open.MaxDev -gt 15 * $scale) { Fail ("icon jumped {0:N1}px while opening" -f $open.MaxDev) }
if ($open.Last -and ([Math]::Abs($open.Last[0] - $iconCx) -gt 8 * $scale -or [Math]::Abs($open.Last[1] - $iconCy) -gt 8 * $scale)) {
  Fail ("icon ended at {0},{1} (was {2},{3})" -f $open.Last[0], $open.Last[1], $iconCx, $iconCy)
}
if ($open.Lost -gt 2) { Fail ("icon lost in {0} frames (pushed away / clipped)" -f $open.Lost) }
if ([Math]::Abs($openW - 332 * $scale) -gt 12 * $scale) { Fail ("expanded width {0}px, expected ~{1}px" -f $openW, [int](332 * $scale)) }
if ([Math]::Abs($openH - 392 * $scale) -gt 12 * $scale) { Fail ("expanded height {0}px, expected ~{1}px" -f $openH, [int](392 * $scale)) }
if ([Math]::Abs(($r2.right - $r1.right)) -gt 12 * $scale) { Fail ("right edge moved by {0}px (should stay anchored)" -f ($r2.right - $r1.right)) }
if ([Math]::Abs(($r2.bottom - $r1.bottom)) -gt 12 * $scale) { Fail ("bottom edge moved by {0}px (should stay anchored)" -f ($r2.bottom - $r1.bottom)) }
if ($r2.right -gt $wa.Right + 20 * $scale -or $r2.bottom -gt $wa.Bottom + 20 * $scale) { Fail "expanded window exceeds the work area" }

# ---- close via the padding strip (outside the panel / icon) ----
$closeX = [int]($r2.left + 4 * $scale)
$closeY = [int]($r2.top + 4 * $scale)
[ToolProbe]::Click($closeX, $closeY)
$close = Measure-Motion $iconCx $iconCy $half $SettleMs
$r3 = Get-Rect $hwnd
Report ("close: rect={0},{1} {2}x{3}" -f $r3.left, $r3.top, ($r3.right - $r3.left), ($r3.bottom - $r3.top))
Report ("close: icon maxDev={0:N1} lost={1} last={2},{3}" -f $close.MaxDev, $close.Lost, $close.Last[0], $close.Last[1])
if ($close.MaxDev -gt 15 * $scale) { Fail ("icon jumped {0:N1}px while closing" -f $close.MaxDev) }
if ($close.Last -and ([Math]::Abs($close.Last[0] - $iconCx) -gt 8 * $scale -or [Math]::Abs($close.Last[1] - $iconCy) -gt 8 * $scale)) {
  Fail ("icon did not return to {0},{1}" -f $iconCx, $iconCy)
}
if ([Math]::Abs(($r3.right - $r3.left) - $winW) -gt 12 * $scale) { Fail "window did not shrink back to icon size" }

Write-Output "failures=$($script:fail)"
# restore the toolbox to the position it had before the probe
[void][ToolProbe]::SetWindowPos($hwnd, [IntPtr]::Zero, $originX, $originY, 0, 0, 0x0001 -bor 0x0004 -bor 0x0010)
if ($script:fail -gt 0) { exit 1 }
Write-Output "PASS"
exit 0
