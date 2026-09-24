// Inventory.js
// アイテムの取得・使用・消費・変化・残存破棄をこの1箇所に集約する。
// 「アイテムごとの個別処理コード」を書かないことがバグを減らす設計の核。

export function giveItem(state, itemId) {
  if (!state.inventory.includes(itemId)) state.inventory.push(itemId);
  if (!state.everObtainedItems.includes(itemId)) state.everObtainedItems.push(itemId);
}

export function removeItem(state, itemId) {
  state.inventory = state.inventory.filter((id) => id !== itemId);
}

/**
 * 選択中アイテムを、現在タップしているspotに対して使用する。
 * persistence の値に応じて消失/変化/残存の挙動を自動で切り替える。
 */
export function consumeSelectedItem(state, ctx, itemsById, currentSpotId) {
  const itemId = ctx.selectedItemId;
  if (!itemId) return; // 想定外の呼び出し（未選択）に対する安全策
  const item = itemsById[itemId];
  if (!item) return;

  if (!state.itemUsageLog[itemId]) state.itemUsageLog[itemId] = [];
  if (!state.itemUsageLog[itemId].includes(currentSpotId)) {
    state.itemUsageLog[itemId].push(currentSpotId);
  }

  if (item.persistence === "consumed") {
    removeItem(state, itemId);
  } else if (item.persistence === "transform") {
    removeItem(state, itemId);
    if (item.transformsTo) giveItem(state, item.transformsTo);
  }
  // "remainInPart" の場合はここでは何もしない（パート切替時にまとめて破棄）

  ctx.selectedItemId = null;
}

/**
 * 選択操作を介さずに、指定アイテムを指定spot(またはギミック)で使用済みにして所持品から消す。
 * チャット画面ギミックへの写真添付のように、ギミック内でアイテムを使うケース用。
 */
export function consumeItem(state, ctx, itemId, spotId) {
  if (!state.itemUsageLog[itemId]) state.itemUsageLog[itemId] = [];
  if (!state.itemUsageLog[itemId].includes(spotId)) state.itemUsageLog[itemId].push(spotId);
  removeItem(state, itemId);
  if (ctx.selectedItemId === itemId) ctx.selectedItemId = null;
}

/**
 * PlayPart切替時に、残存(remainInPart)アイテムを全て所持品から取り除く。
 * ゲームアイテム.txt の「操作パート切り替わり時に残存アイテムは全て消す」に対応。
 */
export function discardRemainInPartItems(state, itemsById) {
  state.inventory = state.inventory.filter((id) => {
    const item = itemsById[id];
    return !(item && item.persistence === "remainInPart");
  });
}
