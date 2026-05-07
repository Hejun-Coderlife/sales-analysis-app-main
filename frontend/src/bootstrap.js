import "./config/feature-flags.js";
import { initV2Bridge } from "./bridge/v2-bridge.js";

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    initV2Bridge();
  });
} else {
  initV2Bridge();
}
