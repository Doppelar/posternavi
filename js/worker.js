// ルートの計算を画面と別の流れで行う（計算中も画面が固まらないように）。
import { solve } from "./solve.js";

self.onmessage = async (e) => {
  try {
    self.postMessage({ result: await solve(e.data) });
  } catch (err) {
    self.postMessage({ error: String(err?.message || err) });
  }
};
