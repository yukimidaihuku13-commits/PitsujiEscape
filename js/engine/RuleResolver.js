// RuleResolver.js
// spot.rules を先頭から評価し、最初に条件が真になったルールのactionsを返す。
// どのルールにもマッチしない場合は、想定外の操作順に対する安全策として
// 既定のフォールバックメッセージ（7-4対応）を返す。ここでのフォールバックは
// spots.json 側に個別記述する必要がない＝データの書き漏れによるバグを防ぐ。

import { evaluate } from "./ConditionEval.js";

export const DEFAULT_FALLBACK_MESSAGE = "今は何も起きないx";

export function resolveActions(spot, state, ctx) {
  for (const rule of spot.rules) {
    if (evaluate(rule.when, state, ctx)) {
      return rule.actions;
    }
  }
  return [{ type: "message", text: spot.defaultMessage || DEFAULT_FALLBACK_MESSAGE }];
}
