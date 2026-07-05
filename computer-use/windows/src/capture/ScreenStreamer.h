#pragma once
//
// Warm screen streaming via a persistent WGC capture session — the Windows
// counterpart of macOS's ScreenStreamer. A free-threaded frame pool keeps the
// latest frame; next() blocks until a frame newer than `after` arrives (so the
// caller sees the screen only when it actually changes — installers, spinners,
// downloads). Mirrors the macOS stop-race fix: frames delivered after stop() are
// dropped.
#include <cstdint>
#include <vector>

namespace nicosoft {
namespace stream {

struct Frame {
  std::vector<uint8_t> bgra;  // rowPitch bytes/row
  int width = 0;
  int height = 0;
  int rowPitch = 0;
  long long index = 0;
};

// Start the warm session if not already running; returns the current frame index.
long long start();

// Block until a frame with index > `after` is available (or timeout). Returns
// false on timeout or if streaming was stopped.
bool nextFrame(long long after, int timeoutMs, Frame& out);

// Stop the session and release resources; late frames are dropped.
void stop();

bool running();

}  // namespace stream
}  // namespace nicosoft
