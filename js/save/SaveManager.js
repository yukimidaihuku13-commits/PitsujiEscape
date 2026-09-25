// SaveManager.js
// C章の方針: 「一連のアクション完了後」「シーン遷移直後」「パート切替直後」にのみ
// GameState全体をまるごと上書き保存する。selectedItemId は保存しない
// （main.js側のメモリ変数のため、そもそもここには含まれない）。

import { SAVE_VERSION } from "../state/GameState.js";

export const SAVE_KEY = "pitsujiEscapeGame_save";

// 別のタブでゲームが進んだ後は、古い状態で上書きしないよう保存を止める（main.js の storage イベント）。
let readOnly = false;
export function setReadOnly(value) {
  readOnly = !!value;
}

export function save(state) {
  if (readOnly) return false;
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

// Cookie/サイトデータをブロックしている環境では、localStorageへのアクセス自体が
// 例外(SecurityError)になる。clear()もload()のcatch内から呼ばれるため、ここで
// 例外を握りつぶさないとゲーム全体の起動が止まってしまう。
export function clear() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch (e) {
    console.error("[SaveManager] セーブデータの削除に失敗しました", e);
  }
}

/** この環境でセーブ(localStorage)が使えるかを返す。 */
export function isAvailable() {
  try {
    const probe = "__pitsujiEscapeGame_probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch (e) {
    return false;
  }
}
