// ActionExec.js
// spots.json / gimmicks.json のactions配列を実行するエンジン本体。
// UIそのものは持たず、`ui` に渡されたコールバック経由でのみ画面に触れる。

import { evaluate } from "./ConditionEval.js";
import { resolveActions, resolveMessage } from "./RuleResolver.js";
import * as Inventory from "../inventory/Inventory.js";
import * as Navigator from "../nav/Navigator.js";
import * as SaveManager from "../save/SaveManager.js";

export class Engine {
  /**
   * @param {object} state GameState（可変オブジェクト）
   * @param {object} data { itemsById, viewsById, spotsById, playPartsById, storyPartsById, gimmicksById, transitions }
   * @param {object} ctx { selectedItemId }
   * @param {object} ui  { queueMessage, playSE, openGimmick, closeGimmick, enterStoryPart, enterPlayPart, requestRender, scheduleAutoClear, enterEnding }
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
    this.checkAutoClear();
  }

  runAction(action, currentSpotId) {
    switch (action.type) {
      case "message":
        // textsが指定されている場合は、その中からランダムに1つ選んで表示する
        // （例: 本棚のホームズ談義、ランダムに1つ）。
        if (action.texts) {
          const pick = action.texts[Math.floor(Math.random() * action.texts.length)];
          this.ui.queueMessage(pick);
        } else {
          this.ui.queueMessage(action.text);
        }
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
      case "consumeItem":
        // 選択操作を介さずに特定アイテムを使用済みにする（例: チャット画面ギミックに添付した写真）。
        Inventory.consumeItem(this.state, this.ctx, action.item, action.spot || currentSpotId);
        break;
      case "clickCountIncrement": {
        const key = action.spot || currentSpotId;
        this.state.clickCounts[key] = (this.state.clickCounts[key] || 0) + 1;
        break;
      }
      case "resetClickCount": {
        const key = action.spot || currentSpotId;
        this.state.clickCounts[key] = 0;
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
      case "showImageModal":
        // 表示: アイテム画像等を見せるアクション。実画像が無い間はcaptionをそのまま
        // プレースホルダーとして見せる（image未指定でも成立する）。
        this.ui.showImageModal({ image: action.image || null, caption: action.caption || "" });
        break;
      case "unlockBgmTrack": {
        const tracks = this.state.bgmState.unlockedTracks;
        if (!tracks.includes(action.track)) tracks.push(action.track);
        break;
      }
      case "setBgmTrack":
        this.state.bgmState.currentTrack = action.track;
        break;
      case "openBgmMenu":
        this.ui.openBgmMenu();
        break;
      case "openNote":
        this.openNote();
        break;
      case "notePageNext":
        this.showNotePage((this.state.notePage || 0) + 1);
        break;
      default:
        console.warn("[Engine] 未知のアクションtype:", action.type, action);
    }
  }

  // 調査ノート(views.json の layoutType:"note")を開く。毎回1ページ目(ページ1左)から始める。
  openNote() {
    const noteView = this.getNoteView();
    if (!noteView) {
      console.error("[Engine] ノート視点(layoutType:note)が見つかりません");
      return;
    }
    if (!Navigator.moveToView(this.state, this.data.viewsById, noteView.id)) return;
    this.showNotePage(0);
  }

  // 指定ページを表示し、そのページのonShowアクションを実行する。
  // 最後のページより先には進まない（範囲外の指定は無視する）。
  showNotePage(index) {
    const noteView = this.getNoteView();
    if (!noteView || index < 0 || index >= noteView.pages.length) return;
    const page = noteView.pages[index];
    this.state.notePage = index;
    // 「タップ回数は連続。他処理が入ったら再度数え直し」: ページを表示し直すたびに数え直す
    this.state.clickCounts[page.id] = 0;
    for (const action of resolveActions({ rules: page.onShow || [] }, this.state, this.ctx)) {
      this.runAction(action, page.id);
    }
  }

  getNoteView() {
    return Object.values(this.data.viewsById).find((v) => v.layoutType === "note") || null;
  }

  // 配信用カメラを押さなくても、クリア条件を満たした時点で自動的にクリアするPlayPart
  // (playParts.json の autoClear:true。現状は操作パート6のみ)。直前のメッセージを
  // 読み終えてからストーリーに移れるよう、実際の遷移タイミングはUI側に委ねる。
  checkAutoClear() {
    if (this.state.phase !== "play") return;
    const part = this.data.playPartsById[this.state.playPart];
    if (!part || !part.autoClear) return;
    if (evaluate(part.clearCondition, this.state, this.ctx)) this.ui.scheduleAutoClear();
  }

  // scheduleAutoClearを受けたUI側が、メッセージを読み終えたタイミングで呼ぶ。
  runAutoClear() {
    if (this.state.phase !== "play") return;
    const part = this.data.playPartsById[this.state.playPart];
    if (!part || !evaluate(part.clearCondition, this.state, this.ctx)) return;
    this.clearCurrentPart(part);
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
    } else {
      const msgs = resolveMessage(part.notYetMessage, this.state, this.ctx);
      if (msgs) msgs.forEach((m) => this.ui.queueMessage(m));
    }
  }

  clearCurrentPart(part) {
    Inventory.discardRemainInPartItems(this.state, this.data.itemsById);
    this.ctx.selectedItemId = null;
    this.state.notePage = 0;
    // 電気スイッチ等で変えた部屋の色(views.json の tintFlag)は、操作パートをまたがず元に戻す。
    for (const view of Object.values(this.data.viewsById)) {
      if (view.tintFlag) delete this.state.flags[view.tintFlag];
    }
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
    // 最後のストーリー(nextPlayPart:null)の後はエンディング(phase:"end")で止める。
    // 以前は存在しないPlayPart9へ進もうとして、真っ白な画面・壊れたセーブになっていた。
    if (playPartId == null) {
      this.state.phase = "end";
      this.state.storyPart = null;
      SaveManager.save(this.state);
      this.ui.enterEnding();
      return;
    }
    this.state.phase = "play";
    this.state.playPart = playPartId;
    this.state.storyPart = null;
    const part = this.data.playPartsById[playPartId];
    if (!part) {
      console.warn(`[Engine] PlayPart${playPartId} は未実装です（試作範囲外）`);
      SaveManager.save(this.state);
      return;
    }
    // currentViewは各PlayPartのstartView(playParts.json)で毎回明示的に設定する。
    // 前のパートの位置を引き継ぐ実装だと、ストーリーパートを経由した通常の進行以外
    // (デバッグジャンプ等)でcurrentViewが未設定のままになり、背景/クリックポイントが
    // 何も表示されなくなる（8-1で発覚した不具合）。
    if (part.startView) {
      this.state.currentView = part.startView;
    } else {
      console.warn(`[Engine] PlayPart${playPartId} にstartViewが設定されていません`);
    }
    SaveManager.save(this.state);
    this.ui.enterPlayPart(part);
  }

  resolveGimmickResult(gimmickId, isCorrect) {
    const gimmick = this.data.gimmicksById[gimmickId];
    if (isCorrect) {
      // 先にギミックを閉じてから成功メッセージを流す。閉じる前に流すと、モーダル用の
      // 即時表示(currentModalStatusEl)を素通りしてしまい、後続のメッセージで
      // 直前のメッセージが一瞬で上書きされ続けて実質読めなくなる（7-8対応）。
      this.ui.closeGimmick();
      this.runActions(gimmick.onSuccess, gimmickId);
    } else {
      this.runActions(gimmick.onFail, gimmickId);
    }
  }
}
