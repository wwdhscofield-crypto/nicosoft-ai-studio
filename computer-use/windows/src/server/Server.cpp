#include "server/Server.h"

#include <windows.h>
#include <objbase.h>

#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <thread>

#include "accessibility/UiaTree.h"
#include "capture/ImageEncoder.h"
#include "capture/ScreenCapture.h"
#include "capture/ScreenStreamer.h"
#include "input/InputSynthesizer.h"
#include "overlay/Overlay.h"
#include "permissions/Permissions.h"
#include "support/Version.h"

namespace nicosoft {
namespace {

// Fixed per-machine pipe, overridable via NSAI_CUA_PIPE (mirrors the macOS
// helper's NSAI_CUA_SOCKET override).
std::wstring resolvePipeName() {
  std::wstring name = L"\\\\.\\pipe\\nicosoft_nscu";
  wchar_t buf[512];
  DWORD n = GetEnvironmentVariableW(L"NSAI_CUA_PIPE", buf, 512);
  if (n > 0 && n < 512) name.assign(buf, n);
  return name;
}

}  // namespace

Server::Server() : pipeName_(resolvePipeName()) {
  // Hold the process in a multithreaded apartment for the helper's whole
  // lifetime. C++/WinRT caches activation factories per-process; each
  // per-connection thread briefly joins/leaves the MTA, and if the last
  // CoUninitialize tore the MTA down it would invalidate that cache — the next
  // WGC capture would then dereference a stale factory and crash. Keeping one
  // reference here anchors the MTA (and the cache) until the helper exits.
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);

  // P0: liveness probe. Same result shape as the macOS helper's `ping`.
  rpc_.on("ping", [](const json&) -> json {
    return json{{"name", kName}, {"pong", true}, {"version", kVersion}};
  });

  // Capture one frame of the primary monitor → base64 PNG (full resolution; the
  // Studio side downscales and maps coordinates, as on macOS).
  rpc_.on("screenshot", [](const json&) -> json {
    CapturedFrame frame;
    if (!capturePrimaryMonitor(frame)) throw std::runtime_error("screen capture failed");
    std::string png =
        encodePngBase64(frame.bgra.data(), frame.width, frame.height, frame.rowPitch);
    return json{{"pngBase64", png},
                {"width", frame.width},
                {"height", frame.height},
                {"scale", 1.0}};
  });

  // Input synthesis (SendInput). Coordinate-based for P1; element-index
  // targeting arrives with UI Automation in a later batch.
  rpc_.on("perform_action", [](const json& p) -> json {
    const std::string action = p.value("action", std::string());

    // Focus/frontmost-aware typing into a specific element (the WeChat fix):
    // SetFocus, then paste (Ctrl+V) only when the element is focused AND its app
    // is foreground; otherwise write the value directly via UIA (frontmost-
    // independent, no window reorder). Mirrors the macOS performType.
    if ((action == "type" || action == "type_text") && p.contains("index") &&
        p["index"].is_number_integer()) {
      const int idx = p["index"].get<int>();
      const std::string text = p.value("text", std::string());
      // Decide BEFORE touching focus. Windows UIA SetFocus() yanks the window to
      // the foreground (unlike macOS AX setFocused), so it must not run before we
      // check whether the element's app is already foreground.
      if (uia::elementAppIsForeground(idx)) {
        // Foreground app: focus the element, then Ctrl+V lands in it.
        uia::focusElement(idx);
        Sleep(40);
        if (uia::elementHasKeyboardFocus(idx)) {
          input::typeText(text);
          return json{{"ok", true}, {"method", "paste"}, {"focused", true}, {"length", (int)text.size()}};
        }
        if (uia::setElementValue(idx, text)) {
          return json{{"ok", true}, {"method", "setvalue"}, {"focused", false}, {"length", (int)text.size()}};
        }
        input::typeText(text);
        return json{{"ok", true}, {"method", "paste-unverified"}, {"focused", false}, {"length", (int)text.size()}};
      }
      // Background app: write directly via UIA — never Ctrl+V (it would land in
      // the FOREGROUND app's focused field) and never SetFocus (it would yank
      // this window to the foreground and reorder windows). This is the WeChat
      // multi-window fix: text goes to the RIGHT field without stealing focus.
      if (uia::setElementValue(idx, text)) {
        return json{{"ok", true}, {"method", "setvalue"}, {"focused", false}, {"length", (int)text.size()}};
      }
      throw std::runtime_error("background element has no writable value pattern (cannot type safely)");
    }

    // Coordinate contract: the Studio tool (and the macOS helper) send `coordinate: [x, y]` in
    // screenshot pixels — NOT scalar x/y. Element index still wins when present (element center).
    int x = 0, y = 0;
    if (p.contains("coordinate") && p["coordinate"].is_array() && p["coordinate"].size() >= 2) {
      x = p["coordinate"][0].get<int>();
      y = p["coordinate"][1].get<int>();
    }
    if (p.contains("index") && p["index"].is_number_integer()) {
      int cx = 0, cy = 0;
      if (!uia::elementCenter(p["index"].get<int>(), cx, cy))
        throw std::runtime_error("element index not found or off-screen");
      x = cx;
      y = cy;
    }
    if (action == "click") {
      // Tool sends `clickCount` (2 = double, 3 = triple), not `count`.
      input::click(x, y, p.value("button", std::string("left")), p.value("clickCount", 1));
    } else if (action == "move") {
      input::moveMouse(x, y);
    } else if (action == "type" || action == "type_text") {
      input::typeText(p.value("text", std::string()));
    } else if (action == "key") {
      const std::string key = p.value("key", std::string());
      if (!input::pressKey(key)) throw std::runtime_error("unknown key: " + key);
    } else if (action == "scroll") {
      // Tool sends `direction` + `amount` (lines), not dx/dy. Map to wheel deltas exactly like the
      // macOS ScrollDirection.deltas (Actions.swift): "down" reveals content below → negative dy
      // (Windows MOUSEEVENTF_WHEEL: positive = away from user = up, so the signs line up).
      const std::string dir = p.value("direction", std::string("down"));
      const int mag = static_cast<int>(std::lround(p.value("amount", 3.0)));
      int dx = 0, dy = 0;
      if (dir == "up") dy = mag;
      else if (dir == "down") dy = -mag;
      else if (dir == "left") dx = mag;
      else if (dir == "right") dx = -mag;
      else dy = -mag;  // default: down
      input::scroll(x, y, dx, dy);
    } else if (action == "drag") {
      // Tool sends `start: [x, y]` + `end: [x, y]` (screenshot pixels), not x/y/toX/toY.
      int sx = x, sy = y, ex = x, ey = y;
      if (p.contains("start") && p["start"].is_array() && p["start"].size() >= 2) {
        sx = p["start"][0].get<int>();
        sy = p["start"][1].get<int>();
      }
      if (p.contains("end") && p["end"].is_array() && p["end"].size() >= 2) {
        ex = p["end"][0].get<int>();
        ey = p["end"][1].get<int>();
      }
      input::drag(sx, sy, ex, ey, p.value("button", std::string("left")));
    } else if (action == "wait") {
      // Tool sends `duration` in SECONDS (macOS: action.duration), clamped to 30, not `ms`.
      double secs = p.value("duration", 0.5);
      if (secs < 0) secs = 0;
      if (secs > 30) secs = 30;
      Sleep(static_cast<DWORD>(secs * 1000.0));
    } else {
      throw std::runtime_error("unknown action: " + action);
    }
    return json{{"ok", true}, {"action", action}};
  });

  // UI Automation: element tree + app/window enumeration.
  rpc_.on("ui_tree", [](const json& p) -> json {
    return uia::snapshot(p.value("pid", 0), p.value("window", -1));
  });
  rpc_.on("list_windows", [](const json& p) -> json { return uia::listWindows(p.value("pid", 0)); });
  rpc_.on("list_apps", [](const json&) -> json { return uia::listApps(); });
  rpc_.on("frontmost_window", [](const json&) -> json { return uia::frontmostWindow(); });

  // Permissions (no TCC on Windows) + warm screen streaming.
  rpc_.on("permission_status", [](const json&) -> json { return perms::status(); });
  rpc_.on("start_capture", [](const json& p) -> json {
    // The Studio tool reads back `fps` (the macOS helper returns it too). Windows streaming is
    // change-driven (a frame is produced when the screen changes, not on a fixed clock), so fps is
    // echoed as the caller's requested cap rather than a hard frame rate.
    const int fps = p.value("fps", 10);
    return json{{"ok", true}, {"fps", fps}, {"frameIndex", stream::start()}};
  });
  rpc_.on("next_capture", [](const json& p) -> json {
    long long after = p.value("after", (long long)0);
    stream::Frame f;
    if (!stream::nextFrame(after, 10000, f))
      throw std::runtime_error("no new frame (streaming stopped or 10s timeout)");
    std::string png = encodePngBase64(f.bgra.data(), f.width, f.height, f.rowPitch);
    // Field names mirror the macOS helper's next_capture (Server.swift): the Studio tool reads
    // `base64` (NOT `pngBase64` — that's the screenshot verb's field), plus `mime` and `scale`.
    return json{{"base64", png},
                {"mime", "image/png"},
                {"width", f.width},
                {"height", f.height},
                {"scale", 1.0},
                {"frameIndex", f.index}};
  });
  rpc_.on("stop_capture", [](const json&) -> json {
    stream::stop();
    return json{{"ok", true}};
  });

  // Overlay banner — Studio raises/lowers it via set_active as runs start/finish.
  rpc_.on("set_active", [](const json& p) -> json {
    Overlay::instance().setActive(p.value("active", false));
    return json{{"ok", true}};
  });

  listener_ = std::make_unique<NamedPipeListener>(
      pipeName_, [this](const std::string& line) { return rpc_.handleLine(line); });
}

void Server::run() {
  std::printf("%s %s ready \xE2\x80\x94 pipe %ls\n", kName, kVersion, pipeName_.c_str());
  std::fflush(stdout);

  // The overlay window and the global Esc hook need a message loop on this
  // thread, so the pipe accept loop moves to a background thread and the main
  // thread pumps messages.
  Overlay::instance().init();
  std::thread([this] { listener_->run(); }).detach();

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
}

Server::~Server() {
  stream::stop();
  CoUninitialize();
}

}  // namespace nicosoft
