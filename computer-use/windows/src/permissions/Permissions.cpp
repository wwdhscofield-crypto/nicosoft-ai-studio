#include "permissions/Permissions.h"

#include <windows.h>

#include <vector>

namespace nicosoft {
namespace perms {

json status() {
  // Contract parity with macOS: capture + input need no grant on Windows.
  json j{{"screenRecording", "granted"}, {"accessibility", "granted"}};

  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return j;

  // Integrity level (medium/high/low/system) — governs which windows UIPI lets
  // us drive: a medium-integrity helper cannot input into elevated windows.
  DWORD size = 0;
  GetTokenInformation(token, TokenIntegrityLevel, nullptr, 0, &size);
  if (size > 0) {
    std::vector<BYTE> buf(size);
    if (GetTokenInformation(token, TokenIntegrityLevel, buf.data(), size, &size)) {
      auto* label = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(buf.data());
      DWORD count = *GetSidSubAuthorityCount(label->Label.Sid);
      DWORD rid = *GetSidSubAuthority(label->Label.Sid, count - 1);
      const char* level = "medium";
      if (rid >= SECURITY_MANDATORY_SYSTEM_RID) level = "system";
      else if (rid >= SECURITY_MANDATORY_HIGH_RID) level = "high";
      else if (rid >= SECURITY_MANDATORY_MEDIUM_RID) level = "medium";
      else level = "low";
      j["integrityLevel"] = level;
    }
  }

  DWORD uiAccess = 0, uiSize = sizeof(uiAccess);
  if (GetTokenInformation(token, TokenUIAccess, &uiAccess, uiSize, &uiSize)) {
    j["uiAccess"] = (uiAccess != 0);
  }

  CloseHandle(token);
  return j;
}

}  // namespace perms
}  // namespace nicosoft
