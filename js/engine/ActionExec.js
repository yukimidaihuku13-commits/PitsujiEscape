// ActionExec.js
// spots.json / gimmicks.json のactions配列を実行するエンジン本体。
// UIそのものは持たず、`ui` に渡されたコールバック経由でのみ画面に触れる。

import { evaluate } from "./ConditionEval.js";
import * as Inventory from "../inventory/Inventory.js";
import * as Navigator from "../nav/Navigator.js";
import * as SaveManager from "../save/SaveManager.js";

export class Engine {
  /**
   * @param {object} state GameState（可変オブジェクト）
   * @param {object} data { itemsById, viewsById, spotsById, playPartsById, storyPartsById, gimmicksById, transitions }
   * @param {object} ctx { selectedItemId }
   * @param {object} ui  { queueMessage, playSE, openGimmick, closeGimmick, enterStoryPart, enterPlayPart, requestRender }
   */
  constructor(state, data, ctx, ui) {
    this.state = state;
    this.data = data;
    this.ctx = ctx;
    this.ui = ui;
  }

  runActions(actions, currentSpotId) {
    for (const action of actions) {
      this.runAction(action, currentSpotId);
    }
    this.ui.requestRender();
    // C章の方針: 一連のアクションが完了したタイミングでのみ全体を保存する
    SaveManager.save(this.state);
  }

  runAction(action, currentSpotId) {
    switch (action.type) {
      case "message":
        this.ui.queueMessage(action.text);
        break;
      case "se":
        this.ui.playSE(action.id || "");
        break;
      case "setFlag":
        this.state.flags[action.flag] = action.value;
        break;
      case "giveItem":
        Inventory.giveItem(this.state, action.item);
        break;
      case "consumeSelectedItem":
        Inventory.consumeSelectedItem(this.state, this.ctx, this.data.itemsById, currentSpotId);
        break;
      case "clickCountIncrement": {
        const key = action.spot || currentSpotId;
        this.state.clickCounts[key] = (this.state.clickCounts[key] || 0) + 1;
        break;
      }
      case "moveTo":
        Navigator.moveToView(this.state, this.data.viewsById, action.target);
        break;
      case "triggerGimmick":
        this.ui.openGimmick(action.target);
        break;
      case "attemptPartClear":
        this.attemptPartClear();
        break;
      default:
        console.warn("[Engine] 未知のアクションtype:", action.type, action);
    }
  }

  attemptPartClear() {
    const part = this.data.playPartsById[this.state.playPart];
    if (!part) {
      console.error(`[Engine] 存在しないPlayPart: ${this.state.playPart}`);
      return;
    }
    const ok = evaluate(part.clearCondition, this.state, this.ctx);
    if (ok) {
      this.ui.playSE("click");
      this.clearCurrentPart(part);
    } else if (part.notYetMessage) {
      this.ui.queueMessage(part.notYetMessage);
    }
  }

  clearCurrentPart(part) {
    Inventory.discardRemainInPartItems(this.state, this.data.itemsById);
    this.ctx.selectedItemId = null;
    SaveManager.save(this.state);
    this.goToStoryPart(part.nextStoryPart);
  }

  goToStoryPart(storyPartId) {
    this.state.phase = "story";
    this.state.storyPart = storyPartId;
    SaveManager.save(this.state);
    this.ui.enterStoryPart(storyPartId);
  }

  advanceToPlayPart(playPartId) {
    this.state.phase = "play";
    this.state.playPart = playPartId;
    this.state.storyPart = null;
    SaveManager.save(this.state);
    const part = this.data.playPartsById[playPartId];
    if (!part) {
      console.warn(`[Engine] PlayPart${playPartId} は未実装です（試作範囲外）`);
      return;
    }
    this.ui.enterPlayPart(part);
  }

  resolveGimmickResult(gimmickId, isCorrect) {
    const gimmick = this.data.gimmicksById[gimmickId];
    const actions = isCorrect ? gimmick.onSuccess : gimmick.onFail;
    this.runActions(actions, gimmickId);
    if (isCorrect) this.ui.closeGimmick();
  }
}
