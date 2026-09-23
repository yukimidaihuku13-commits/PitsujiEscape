// RuleResolver.js
// spot.rules を先頭から評価し、最初に条件が真になったルールのactionsを返す。
// どのルールにもマッチしない場合は、想定外の操作順に対する安全策として
// 既定のフォールバックメッセージ（7-4対応）を返す。ここでのフォールバックは
// spots.json 側に個別記述する必要がない＝データの書き漏れによるバグを防ぐ。

import { evaluate } from "./ConditionEval.js";

export const DEFAULT_FALLBACK_MESSAGE = "今は何も起きない";

export function resolveActions(spot, state, ctx) {
  for (const rule of spot.rules) {
    if (evaluate(rule.when, state, ctx)) {
      return rule.actions;
    }
  }
  return [{ type: "message", text: spot.defaultMessage || DEFAULT_FALLBACK_MESSAGE }];
}

/**
 * このspotが「今の状態でタップして意味のある反応をするか」を返す。
 * どのルールにもマッチしない（＝既定のフォールバックしか出ない）場合はfalse。
 * Renderer側でクリックポイントの表示/非表示を切り替えるために使う。
 */
export function hasMatchingRule(spot, state, ctx) {
  return spot.rules.some((rule) => evaluate(rule.when, state, ctx));
}

/**
 * playParts.json の notYetMessage を解決する。3つの書式を許容する。
 *   1. "文言"                              固定・1行
 *   2. ["文言1", "文言2"]                  固定・複数行（順に表示）
 *   3. [{ when, text }, { when, texts }]   状態に応じて変わる文言。spot.rulesと同じ書式で
 *                                          先頭から評価し最初に一致したものを使う
 * @returns {string[]|null} 表示すべき行の配列（無ければnull）。呼び出し側は順にqueueMessageする。
 */
export function resolveMessage(messageDef, state, ctx) {
  if (messageDef == null) return null;
  if (typeof messageDef === "string") return [messageDef];
  if (Array.isArray(messageDef) && typeof messageDef[0] === "string") return messageDef;
  for (const entry of messageDef) {
    if (evaluate(entry.when, state, ctx)) {
      if (Array.isArray(entry.texts)) return entry.texts;
      if (typeof entry.text === "string") return [entry.text];
      console.error("[resolveMessage] text(s)が不正です:", entry);
      return null;
    }
  }
  return null;
}

/**
 * views.json の背景を解決する。view.backgroundVariants（[{when, background}, ...]、
 * 先頭から評価し最初に一致したもの）があればそれを優先し、無ければview.backgroundを使う
 * （タオルケット除去後のベッド等、状態によって背景が変わるケース用）。
 * @returns {string|undefined}
 */
export function resolveBackground(view, state, ctx) {
  if (!view) return undefined;
  if (view.backgroundVariants) {
    for (const variant of view.backgroundVariants) {
      if (evaluate(variant.when, state, ctx)) return variant.background;
    }
  }
  return view.background;
}
