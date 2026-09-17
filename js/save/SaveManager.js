// SaveManager.js
// C章の方針: 「一連のアクション完了後」「シーン遷移直後」「パート切替直後」にのみ
// GameState全体をまるごと上書き保存する。selectedItemId は保存しない
// （main.js側のメモリ変数のため、そもそもここには含まれない）。

import { SAVE_VERSION } from "../state/GameState.js";

const SAVE_KEY = "pitsujiEscapeGame_save";

export function save(state) {
  try {
    const json = JSON.stringify(state);
    localStorage.setItem(SAVE_KEY, json);
    return true;
  } catch (e) {
    console.error("[SaveManager] 保存に失敗しました", e);
    return false;
  }
}

/**
 * @returns {object|null} 有効なセーブデータがあればstate、無ければnull
 */
export function load() {
  try {
    const json = localStorage.getItem(SAVE_KEY);
    if (!json) return null;
    const state = JSON.parse(json);
    if (!state || state.saveVersion !== SAVE_VERSION) {
      console.warn("[SaveManager] セーブデータのバージョンが不一致のため破棄します");
      clear();
      return null;
    }
    return state;
  } catch (e) {
    console.error("[SaveManager] 読み込みに失敗しました。セーブデータを破棄します", e);
    clear();
    return null;
  }
}

export function clear() {
  localStorage.removeItem(SAVE_KEY);
}
