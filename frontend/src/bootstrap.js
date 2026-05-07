import "./config/feature-flags.js";
import { initAuthUiGuard } from "./auth/ui-guard.js";
import { initV2Bridge } from "./bridge/v2-bridge.js";

async function boot() {
  try {
    await initAuthUiGuard();
  } catch (error) {
    console.error("[auth-ui] init failed", error);
  }
  initV2Bridge();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void boot();
  });
} else {
  void boot();
}
