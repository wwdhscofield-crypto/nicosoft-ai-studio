#include "capture/ScreenStreamer.h"

#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#include <chrono>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <vector>

namespace nicosoft {
namespace stream {
namespace {

namespace wgc = winrt::Windows::Graphics::Capture;
namespace wgdx = winrt::Windows::Graphics::DirectX;
namespace wg3d = winrt::Windows::Graphics::DirectX::Direct3D11;
using winrt::com_ptr;
using winrt::check_hresult;

struct StreamState {
  com_ptr<ID3D11Device> device;
  com_ptr<ID3D11DeviceContext> context;
  wg3d::IDirect3DDevice rtDevice{nullptr};
  wgc::Direct3D11CaptureFramePool framePool{nullptr};
  wgc::GraphicsCaptureSession session{nullptr};
  winrt::event_token token{};

  std::mutex mtx;
  std::condition_variable cv;
  bool running = false;
  long long frameIndex = 0;
  std::vector<uint8_t> bgra;
  int width = 0, height = 0, rowPitch = 0;
};
StreamState g;

com_ptr<ID3D11Texture2D> surfaceTexture(const wg3d::IDirect3DSurface& surface) {
  auto access =
      surface.as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
  com_ptr<ID3D11Texture2D> tex;
  check_hresult(access->GetInterface(winrt::guid_of<ID3D11Texture2D>(), tex.put_void()));
  return tex;
}

// Runs on a WGC pool thread. Copies the frame to CPU and bumps the index.
void onFrameArrived(const wgc::Direct3D11CaptureFramePool& pool,
                    const winrt::Windows::Foundation::IInspectable&) {
  auto frame = pool.TryGetNextFrame();
  if (!frame) return;
  std::lock_guard<std::mutex> lock(g.mtx);
  if (!g.running) return;  // drop frames delivered after stop() (macOS parity)
  try {
    com_ptr<ID3D11Texture2D> tex = surfaceTexture(frame.Surface());
    D3D11_TEXTURE2D_DESC desc{};
    tex->GetDesc(&desc);
    D3D11_TEXTURE2D_DESC staged = desc;
    staged.Usage = D3D11_USAGE_STAGING;
    staged.BindFlags = 0;
    staged.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    staged.MiscFlags = 0;
    com_ptr<ID3D11Texture2D> staging;
    if (FAILED(g.device->CreateTexture2D(&staged, nullptr, staging.put()))) return;
    g.context->CopyResource(staging.get(), tex.get());
    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (FAILED(g.context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped))) return;
    g.width = (int)desc.Width;
    g.height = (int)desc.Height;
    g.rowPitch = (int)mapped.RowPitch;
    g.bgra.resize((size_t)mapped.RowPitch * desc.Height);
    std::memcpy(g.bgra.data(), mapped.pData, g.bgra.size());
    g.context->Unmap(staging.get(), 0);
    g.frameIndex++;
    g.cv.notify_all();
  } catch (...) {
    // ignore a bad frame; the next one will retry
  }
}

}  // namespace

long long start() {
  std::lock_guard<std::mutex> lock(g.mtx);
  if (g.running) return g.frameIndex;

  check_hresult(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                  D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
                                  g.device.put(), nullptr, g.context.put()));
  com_ptr<IDXGIDevice> dxgiDevice = g.device.as<IDXGIDevice>();
  com_ptr<::IInspectable> inspectable;
  check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.get(), inspectable.put()));
  g.rtDevice = inspectable.as<wg3d::IDirect3DDevice>();

  HMONITOR hmon = MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY);
  auto interop =
      winrt::get_activation_factory<wgc::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  wgc::GraphicsCaptureItem item{nullptr};
  check_hresult(interop->CreateForMonitor(hmon, winrt::guid_of<wgc::GraphicsCaptureItem>(),
                                          winrt::put_abi(item)));

  auto size = item.Size();
  g.framePool = wgc::Direct3D11CaptureFramePool::CreateFreeThreaded(
      g.rtDevice, wgdx::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size);
  g.session = g.framePool.CreateCaptureSession(item);
  g.token = g.framePool.FrameArrived(
      winrt::Windows::Foundation::TypedEventHandler<wgc::Direct3D11CaptureFramePool,
                                                    winrt::Windows::Foundation::IInspectable>(
          onFrameArrived));

  g.running = true;
  g.frameIndex = 0;
  g.session.StartCapture();
  return g.frameIndex;
}

bool nextFrame(long long after, int timeoutMs, Frame& out) {
  std::unique_lock<std::mutex> lock(g.mtx);
  bool ok = g.cv.wait_for(lock, std::chrono::milliseconds(timeoutMs),
                          [after] { return !g.running || g.frameIndex > after; });
  if (!ok || !g.running || g.frameIndex <= after) return false;
  out.bgra = g.bgra;
  out.width = g.width;
  out.height = g.height;
  out.rowPitch = g.rowPitch;
  out.index = g.frameIndex;
  return true;
}

void stop() {
  wgc::GraphicsCaptureSession session{nullptr};
  wgc::Direct3D11CaptureFramePool pool{nullptr};
  winrt::event_token token{};
  {
    std::lock_guard<std::mutex> lock(g.mtx);
    if (!g.running) return;
    g.running = false;
    session = g.session;
    pool = g.framePool;
    token = g.token;
    g.session = nullptr;
    g.framePool = nullptr;
    g.cv.notify_all();
  }
  // Close outside the lock: a handler may be mid-flight; running=false makes it
  // drop its frame, and detaching FrameArrived stops further callbacks.
  if (pool) pool.FrameArrived(token);
  if (session) session.Close();
  if (pool) pool.Close();

  std::lock_guard<std::mutex> lock(g.mtx);
  g.rtDevice = nullptr;
  g.context = nullptr;
  g.device = nullptr;
  g.bgra.clear();
  g.frameIndex = 0;
}

bool running() {
  std::lock_guard<std::mutex> lock(g.mtx);
  return g.running;
}

}  // namespace stream
}  // namespace nicosoft
