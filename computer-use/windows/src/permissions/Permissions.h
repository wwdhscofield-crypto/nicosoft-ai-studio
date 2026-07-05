#pragma once
//
// Permission status. Windows has no TCC gate (unlike macOS), so capture/input
// just work; permission_status always reports "granted" to keep the JSON-RPC
// contract identical, and adds integrityLevel + uiAccess so the Studio side can
// tell whether the helper can drive elevated/high-integrity windows (UIPI).
#include "ipc/JsonRpc.h"

namespace nicosoft {
namespace perms {

json status();

}  // namespace perms
}  // namespace nicosoft
