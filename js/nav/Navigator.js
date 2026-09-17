// Navigator.js
// 「現在のview(scene)は常に1つだけ」という原則で、遷移をここに集約する。
// zoom/door/pan はここでは区別なく currentView の差し替えとして扱う
// （演出の違いはRenderer側の責務とする）。

import { evaluate } from "../engine/ConditionEval.js";

export function canAccessView(view, state) {
  if (!view.accessCondition) return true;
  return evaluate(view.accessCondition, state, {});
}

/**
 * @returns {boolean} 遷移に成功したか
 */
export function moveToView(state, viewsById, targetId) {
  const view = viewsById[targetId];
  if (!view) {
    console.error(`[Navigator] 存在しないview: ${targetId}`);
    return false;
  }
  if (!canAccessView(view, state)) {
    console.warn(`[Navigator] 現時点ではアクセス不可のview: ${targetId}`);
    return false;
  }
  state.currentView = targetId;
  return true;
}

/**
 * 現在のviewから使える矢印移動の一覧を返す（accessConditionも考慮）。
 */
export function getArrowsForView(transitions, viewsById, viewId, state) {
  return transitions.filter((t) => {
    if (t.view !== viewId) return false;
    if (t.condition && !evaluate(t.condition, state, {})) return false;
    const targetView = viewsById[t.target];
    if (targetView && !canAccessView(targetView, state)) return false;
    return true;
  });
}
