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
 * playParts.json の notYetMessage を解決する。
 * 単純な文字列（固定文言）と、[{ when, text }, ...]（状態に応じて変わる文言。
 * spot.rulesと同じ書式で先頭から評価し最初に一致したものを使う）の両方を許容する。
 * @returns {string|null}
 */
export function resolveMessage(messageDef, state, ctx) {
  if (messageDef == null) return null;
  if (typeof messageDef === "string") return messageDef;
  for (const entry of messageDef) {
    if (evaluate(entry.when, state, ctx)) {
      if (typeof entry.text !== "string") {
        console.error("[resolveMessage] textが文字列ではありません:", entry);
        return null;
      }
      return entry.text;
    }
  }
  return null;
}
