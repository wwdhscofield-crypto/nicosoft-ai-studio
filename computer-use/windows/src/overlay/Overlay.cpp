#include "overlay/Overlay.h"

#include <windows.h>
#include <objidl.h>  // IStream, referenced by gdiplus.h (stripped by WIN32_LEAN_AND_MEAN)

#include <algorithm>
// gdiplus.h references min/max in namespace Gdiplus, but we build with NOMINMAX.
namespace Gdiplus {
using std::max;
using std::min;
}  // namespace Gdiplus
#include <gdiplus.h>

#include <cstdint>

namespace nicosoft {
namespace {

HWND g_hwnd = nullptr;
HHOOK g_hook = nullptr;
ULONG_PTR g_gdiplusToken = 0;
const wchar_t* kClass = L"NicoSoftCuaOverlay";
const wchar_t* kText =
    L"NicoSoft Computer Use is controlling this PC — press Esc to dismiss";
constexpr UINT WM_CUA_SHOW = WM_APP + 1;
constexpr UINT WM_CUA_HIDE = WM_APP + 2;
constexpr int kWidth = 640;
constexpr int kHeight = 46;

// Paint the banner into a 32bpp DIB with per-pixel alpha (background 50%
// translucent, text fully opaque) and push it via UpdateLayeredWindow.
void render(HWND hwnd) {
  using namespace Gdiplus;

  BITMAPINFO bi{};
  bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bi.bmiHeader.biWidth = kWidth;
  bi.bmiHeader.biHeight = -kHeight;  // top-down
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB;

  HDC screen = GetDC(nullptr);
  HDC mem = CreateCompatibleDC(screen);
  void* bits = nullptr;
  HBITMAP dib = CreateDIBSection(screen, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  HGDIOBJ oldBmp = SelectObject(mem, dib);

  {
    Graphics g(mem);
    g.SetSmoothingMode(SmoothingModeAntiAlias);
    g.SetTextRenderingHint(TextRenderingHintAntiAlias);
    g.Clear(Color(0, 0, 0, 0));

    // Rounded, 50%-translucent background.
    const int r = 12;
    GraphicsPath path;
    path.AddArc(0, 0, 2 * r, 2 * r, 180, 90);
    path.AddArc(kWidth - 2 * r, 0, 2 * r, 2 * r, 270, 90);
    path.AddArc(kWidth - 2 * r, kHeight - 2 * r, 2 * r, 2 * r, 0, 90);
    path.AddArc(0, kHeight - 2 * r, 2 * r, 2 * r, 90, 90);
    path.CloseFigure();
    SolidBrush bg(Color(128, 24, 24, 28));
    g.FillPath(&bg, &path);

    // Fully-opaque text.
    FontFamily family(L"Segoe UI");
    Font font(&family, 11, FontStyleBold, UnitPoint);
    SolidBrush textBrush(Color(255, 240, 240, 245));
    StringFormat sf;
    sf.SetAlignment(StringAlignmentCenter);
    sf.SetLineAlignment(StringAlignmentCenter);
    RectF rc(0, 0, (REAL)kWidth, (REAL)kHeight);
    g.DrawString(kText, -1, &font, rc, &sf, &textBrush);
  }

  // UpdateLayeredWindow wants premultiplied alpha.
  auto* px = static_cast<uint32_t*>(bits);
  for (int i = 0; i < kWidth * kHeight; ++i) {
    uint32_t p = px[i];
    uint32_t a = (p >> 24) & 0xff;
    uint32_t rr = ((p >> 16) & 0xff) * a / 255;
    uint32_t gg = ((p >> 8) & 0xff) * a / 255;
    uint32_t bb = (p & 0xff) * a / 255;
    px[i] = (a << 24) | (rr << 16) | (gg << 8) | bb;
  }

  RECT wr{};
  GetWindowRect(hwnd, &wr);
  POINT ptDst{wr.left, wr.top};
  POINT ptSrc{0, 0};
  SIZE size{kWidth, kHeight};
  BLENDFUNCTION blend{AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
  UpdateLayeredWindow(hwnd, screen, &ptDst, &size, mem, &ptSrc, 0, &blend, ULW_ALPHA);

  SelectObject(mem, oldBmp);
  DeleteObject(dib);
  DeleteDC(mem);
  ReleaseDC(nullptr, screen);
}

void positionTopCenter(HWND hwnd) {
  int sw = GetSystemMetrics(SM_CXSCREEN);
  SetWindowPos(hwnd, HWND_TOPMOST, (sw - kWidth) / 2, 24, kWidth, kHeight, SWP_NOACTIVATE);
}

LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_CUA_SHOW:
      positionTopCenter(hwnd);
      render(hwnd);
      ShowWindow(hwnd, SW_SHOWNA);
      return 0;
    case WM_CUA_HIDE:
      ShowWindow(hwnd, SW_HIDE);
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

LRESULT CALLBACK keyboardHook(int code, WPARAM wp, LPARAM lp) {
  if (code == HC_ACTION && (wp == WM_KEYDOWN || wp == WM_SYSKEYDOWN)) {
    auto* kb = reinterpret_cast<KBDLLHOOKSTRUCT*>(lp);
    if (kb && kb->vkCode == VK_ESCAPE && g_hwnd && IsWindowVisible(g_hwnd)) {
      PostMessageW(g_hwnd, WM_CUA_HIDE, 0, 0);
    }
  }
  return CallNextHookEx(g_hook, code, wp, lp);
}

}  // namespace

Overlay& Overlay::instance() {
  static Overlay overlay;
  return overlay;
}

void Overlay::init() {
  Gdiplus::GdiplusStartupInput si;
  Gdiplus::GdiplusStartup(&g_gdiplusToken, &si, nullptr);

  HINSTANCE inst = GetModuleHandleW(nullptr);
  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = wndProc;
  wc.hInstance = inst;
  wc.lpszClassName = kClass;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  RegisterClassExW(&wc);

  // Click-through (WS_EX_TRANSPARENT), topmost, non-activating, per-pixel alpha
  // (WS_EX_LAYERED painted via UpdateLayeredWindow).
  g_hwnd = CreateWindowExW(
      WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
      kClass, L"", WS_POPUP, 0, 0, kWidth, kHeight, nullptr, nullptr, inst, nullptr);
  if (g_hwnd) {
    // Keep the banner out of the helper's own WGC screenshots (Win10 2004+).
    SetWindowDisplayAffinity(g_hwnd, WDA_EXCLUDEFROMCAPTURE);
  }
  // Global Esc to dismiss the banner (requires this thread's message loop).
  g_hook = SetWindowsHookExW(WH_KEYBOARD_LL, keyboardHook, inst, 0);
}

void Overlay::setActive(bool on) {
  if (g_hwnd) PostMessageW(g_hwnd, on ? WM_CUA_SHOW : WM_CUA_HIDE, 0, 0);
}

}  // namespace nicosoft
