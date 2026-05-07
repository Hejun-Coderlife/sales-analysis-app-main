function readQueryFlag(name) {
  const url = new URL(window.location.href);
  const value = url.searchParams.get(name);
  if (value == null) return null;
  const normalized = String(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function readLocalStorageFlag(name, fallback = false) {
  try {
    const value = window.localStorage.getItem(name);
    if (value == null) return fallback;
    return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
  } catch (_error) {
    return fallback;
  }
}

const queryV2 = readQueryFlag("useV2Analytics");

export const featureFlags = {
  enableV2Upload: queryV2 ?? readLocalStorageFlag("enableV2Upload", false),
  enableVirtualizedTable: readLocalStorageFlag("enableVirtualizedTable", true),
  enableParityChecker: readLocalStorageFlag("enableParityChecker", true),
};

window.__analyticsFeatureFlags = featureFlags;
