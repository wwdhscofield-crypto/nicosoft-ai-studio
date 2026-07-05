# NsComputerUseHelper (Windows) — pure C++ / MSVC.
#
# The Windows counterpart of computer-use/macOS. Protocol layer (JSON-RPC over a
# named pipe) is platform-neutral and mirrors the macOS helper's contract; the
# capability layer (WGC capture, SendInput, UI Automation) is Win32/COM/WinRT.
#
# Build constraints (fixed): x64 only, static CRT (/MT) so the .exe runs without
# a VC++ redistributable. Dependencies come from vcpkg (x64-windows-static).
cmake_minimum_required(VERSION 3.21)
project(NsComputerUseHelper LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Use the /EHa exception model so catch(...) can also contain structured (SEH)
# exceptions — access violations from WGC/UIA/COM — after _set_se_translator
# turns them into C++ exceptions. Replaces the default /EHsc.
if(MSVC)
  string(REPLACE "/EHsc" "/EHa" CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS}")
  if(NOT CMAKE_CXX_FLAGS MATCHES "/EHa")
    string(APPEND CMAKE_CXX_FLAGS " /EHa")
  endif()
endif()

# /MT static runtime is selected via CMAKE_MSVC_RUNTIME_LIBRARY (see CMakePresets.json).
# CMP0091 (NEW by default on CMake 3.15+) makes that variable authoritative.

find_package(nlohmann_json CONFIG REQUIRED)

add_executable(NsComputerUseHelper
  src/main.cpp
  src/server/Server.cpp
  src/ipc/RpcServer.cpp
  src/ipc/NamedPipeListener.cpp
  src/capture/ScreenCapture.cpp
  src/capture/ScreenStreamer.cpp
  src/capture/ImageEncoder.cpp
  src/input/InputSynthesizer.cpp
  src/input/KeyCodes.cpp
  src/accessibility/ElementRegistry.cpp
  src/accessibility/UiaTree.cpp
  src/overlay/Overlay.cpp
  src/permissions/Permissions.cpp
)

target_include_directories(NsComputerUseHelper PRIVATE src)

target_link_libraries(NsComputerUseHelper PRIVATE
  nlohmann_json::nlohmann_json
  d3d11        # D3D11CreateDevice + CreateDirect3D11DeviceFromDXGIDevice
  dxgi         # IDXGIDevice
  windowscodecs # WIC PNG encode
  ole32        # CoCreateInstance / CreateStreamOnHGlobal / CoInitializeEx
  runtimeobject # WinRT activation (RoGetActivationFactory) for C++/WinRT
  gdiplus      # GDI+ for the overlay banner (per-pixel alpha: 50% bg, opaque text)
)

target_compile_definitions(NsComputerUseHelper PRIVATE
  UNICODE _UNICODE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
)

if(MSVC)
  target_compile_options(NsComputerUseHelper PRIVATE /W4 /permissive- /utf-8)
endif()
