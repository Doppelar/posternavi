// ルートの計算を画面と別の流れで行う（計算中も画面が固まらないように）。
import { planRoutes } from "./tsp.js";

self.onmessage = (e) => {
  try {
    const { start, stops, options } = e.data;
    self.postMessage({ result: planRoutes(start, stops, options) });
  } catch (err) {
    self.postMessage({ error: String(err?.message || err) });
  }
};
