// ConditionEval.js
// spots.json 等の "when" 条件オブジェクトを、現在のGameStateに対して評価する。
// この関数は状態を一切変更しない（副作用なし）。

/**
 * @param {object} cond 条件オブジェクト（{} は常に true）
 * @param {object} state GameState
 * @param {object} ctx { selectedItemId }
 * @returns {boolean}
 */
export function evaluate(cond, state, ctx) {
  if (!cond || Object.keys(cond).length === 0) return true;

  if (cond.allOf) return cond.allOf.every((c) => evaluate(c, state, ctx));
  if (cond.anyOf) return cond.anyOf.some((c) => evaluate(c, state, ctx));

  if ("playPart" in cond && !evalNumberCond(cond.playPart, state.playPart)) return false;

  if ("flag" in cond) {
    for (const [key, expected] of Object.entries(cond.flag)) {
      const actual = !!state.flags[key];
      if (actual !== !!expected) return false;
    }
  }

  if ("selectedItem" in cond && ctx.selectedItemId !== cond.selectedItem) return false;

  if ("notSelectedItem" in cond && ctx.selectedItemId === cond.notSelectedItem) return false;

  if ("hasItem" in cond && !state.inventory.includes(cond.hasItem)) return false;

  if ("everObtained" in cond && !state.everObtainedItems.includes(cond.everObtained)) return false;

  if ("usedOn" in cond) {
    const log = state.itemUsageLog[cond.usedOn.item] || [];
    if (!log.includes(cond.usedOn.spot)) return false;
  }

  // "usedOn"は特定spotへの使用だが、こちらはスポットを問わず一度でも使用したか
  // （＝itemUsageLogに何らかの記録があるか）を見る。
  if ("everUsed" in cond) {
    const log = state.itemUsageLog[cond.everUsed] || [];
    if (log.length === 0) return false;
  }

  if ("clickCount" in cond) {
    const count = state.clickCounts[cond.clickCount.spot] || 0;
    if (!(count >= cond.clickCount.gte)) return false;
  }

  if ("bgmTrack" in cond && state.bgmState.currentTrack !== cond.bgmTrack) return false;

  return true;
}

function evalNumberCond(spec, value) {
  if (typeof spec === "number") return value === spec;
  if ("eq" in spec) return value === spec.eq;
  if ("gt" in spec) return value > spec.gt;
  if ("gte" in spec) return value >= spec.gte;
  if ("lt" in spec) return value < spec.lt;
  if ("lte" in spec) return value <= spec.lte;
  return true;
}
