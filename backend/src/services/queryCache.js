export class QueryCache {
  constructor({ ttlMs = 20_000 } = {}) {
    this.ttlMs = ttlMs;
    this.store = new Map();
  }

  get(key) {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (hit.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return hit.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + Math.max(100, Number(ttlMs) || this.ttlMs),
    });
  }

  clear() {
    this.store.clear();
  }
}
