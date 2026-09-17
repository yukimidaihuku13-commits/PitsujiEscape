// GameState.js
// ゲームの「唯一の真実の状態」を作るモジュール。
// ここに定義されていない状態はどこにも保持しないことをルールとする。

export const SAVE_VERSION = 1;

export function createInitialState() {
  return {
    saveVersion: SAVE_VERSION,

    // 進行状態
    phase: "start",      // "start" | "story" | "play"
    playPart: 0,          // 0 = 未開始
    storyPart: null,

    // 現在表示中の視点(view)ID
    currentView: null,

    // アイテム関連（A章の自動追跡方式）
    inventory: [],            // 現在持っているitemIdの配列（取得順）
    everObtainedItems: [],    // 一度でも入手したitemIdの配列（消費済みでも残る）
    itemUsageLog: {},         // { itemId: [spotId, ...] } どこで使ったかの履歴

    // 純粋な進行フラグ（アイテムに紐付かないもの）
    flags: {},

    // 段ボール箱などクリック回数を数える箇所
    clickCounts: {},

    // BGM状態（将来のPart7以降で使用）
    bgmState: { unlockedTracks: [], currentTrack: null }
  };
}

// selectedItemId はあえて GameState に含めず、実行時のみのメモリ変数として
// main.js 側で管理する（セーブ対象外にするための設計）。
