#pragma once
//
// On-screen "this PC is being controlled" banner — the Windows counterpart of
// the macOS overlay. A click-through, topmost, layered window with a global Esc
// hook to dismiss it, excluded from WGC capture so it never shows up in the
// helper's own screenshots. init() must run on the thread that pumps messages
// (Server::run's main thread); setActive() is safe to call from any thread.
namespace nicosoft {

class Overlay {
 public:
  static Overlay& instance();

  void init();            // main/UI thread: create the hidden banner + Esc hook
  void setActive(bool on);  // any thread: show/hide (marshalled to the UI thread)

 private:
  Overlay() = default;
};

}  // namespace nicosoft
