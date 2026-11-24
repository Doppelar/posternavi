// 端末内の保存（localStorage）。サーバーには何も送らない。
const KEY = "posternavi:v1";

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** 保存できなければ false（容量がいっぱい・プライベートブラウズなど）。 */
export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clear() {
  try { localStorage.removeItem(KEY); } catch { /* 消せなくても続ける */ }
}
