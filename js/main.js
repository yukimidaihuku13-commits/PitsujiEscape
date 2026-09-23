// main.js
// データ読み込み → 状態初期化 → UIコールバック配線、を行うエントリーポイント。
// ロジック本体(Engine)とDOM描画(Renderer)を繋ぐ「配線」だけに責務を絞る。

import { createInitialState } from "./state/GameState.js";
import { Engine } from "./engine/ActionExec.js";
import { resolveActions, resolveMessage } from "./engine/RuleResolver.js";
import * as Navigator from "./nav/Navigator.js";
import * as Inventory from "./inventory/Inventory.js";
import * as SaveManager from "./save/SaveManager.js";
import * as Renderer from "./ui/Renderer.js";
import { MessageQueue } from "./ui/DialogueBox.js";
import { renderNumericCodeGimmick } from "./gimmick/NumericCodeGimmick.js";
import { renderLetterSelectGimmick } from "./gimmick/LetterSelectGimmick.js";
import { renderTapRegionsGimmick } from "./gimmick/TapRegionsGimmick.js";
import { renderChatFormGimmick } from "./gimmick/ChatFormGimmick.js";

const DATA_FILES = {
  itemsById: "data/items.json",
  viewsById: "data/views.json",
  spotsById: "data/spots.json",
  playPartsById: "data/playParts.json",
  storyPartsById: "data/storyParts.json",
  gimmicksById: "data/gimmicks.json",
  hintsById: "data/hints.json",
  bgmById: "data/bgm.json"
};

async function loadAllData() {
  const entries = await Promise.all(
    Object.entries(DATA_FILES).map(async ([key, path]) => {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`${path} の読み込みに失敗しました (${res.status})`);
      const json = await res.json();
      return [key, keyBy(json)];
    })
  );
  const data = Object.fromEntries(entries);

  const transitionsRes = await fetch("data/transitions.json");
  data.transitions = await transitionsRes.json();

  return data;
}

function keyBy(list) {
  const map = {};
  for (const item of list) {
    const key = item.id ?? item.playPart;
    map[key] = item;
  }
  return map;
}

async function main() {
  const root = document.getElementById("app");
  const modalRoot = document.getElementById("modal-root");

  let data;
  try {
    data = await loadAllData();
  } catch (e) {
    root.textContent = "データの読み込みに失敗しました。ローカルサーバー経由で開いていますか？(file://直接開きはfetchが失敗します)";
    console.error(e);
    return;
  }

  const state = SaveManager.load() || createInitialState();
  const ctx = { selectedItemId: null };
  const messageLog = [];

  let currentModalStatusEl = null;
  let currentModalOverlay = null;

  const msgQueue = new MessageQueue(
    (item) => {
      const el = document.getElementById("footer-message");
      if (el) el.textContent = item ? item.text : "";
    },
    () => {}
  );

  const storyQueue = new MessageQueue(
    (line) => Renderer.renderStory(root, line),
    () => {
      const story = data.storyPartsById[state.storyPart];
      engine.advanceToPlayPart(story.nextPlayPart);
    }
  );

  function queueMessage(text) {
    if (text == null) return;
    // 万が一メッセージ定義の解決に失敗して文字列以外(オブジェクト等)が渡ってきた場合、
    // textContentへの代入で "[object Object]" のような表示になり原因が分かりにくい。
    // ここで弾いてコンソールに実値を残す（再現待ちのデバッグ用）。
    if (typeof text !== "string") {
      console.error("[main] queueMessageに文字列以外が渡されました:", text);
      return;
    }
    // ログが際限なく伸びるのを防ぐため、直前と全く同じ文言が連続する場合は
    // ログには積まない（同じスポットの連打対策）。表示自体は毎回きちんと行う。
    if (messageLog[messageLog.length - 1] !== text) {
      messageLog.push(text);
    }
    if (currentModalStatusEl) {
      currentModalStatusEl.textContent = text;
      return;
    }
    msgQueue.enqueue({ text });
    if (msgQueue.current === null) msgQueue.advance();
  }

  function drawPlay() {
    const currentText = msgQueue.current ? msgQueue.current.text : "";
    Renderer.renderPlay(root, {
      state,
      ctx,
      data,
      currentMessage: currentText,
      onSpotTap,
      onArrowTap,
      onItemTap,
      onIconTap,
      onFaceTap
    });
  }

  const ui = {
    queueMessage,
    playSE: (id) => console.log(`[SE] ${id}（音声アセット未定）`),
    openGimmick: (gimmickId) => openGimmick(gimmickId),
    closeGimmick: () => closeGimmick(),
    enterStoryPart: (storyPartId) => enterStoryPart(storyPartId),
    enterPlayPart: (part) => enterPlayPart(part),
    showImageModal: (opts) => showImageModal(opts),
    openBgmMenu: () => openBgmMenu(),
    requestRender: () => {
      if (state.phase === "play") drawPlay();
    }
  };

  const engine = new Engine(state, data, ctx, ui);

  function onSpotTap(spotId) {
    if (msgQueue.isBusy()) return; // 想定外の連打に対する保険
    const spot = data.spotsById[spotId];
    if (!spot) {
      console.error(`[main] 存在しないspot: ${spotId}`);
      return;
    }
    const actions = resolveActions(spot, state, ctx);
    engine.runActions(actions, spotId);
  }

  function onArrowTap(targetViewId) {
    if (msgQueue.isBusy()) return;
    const ok = Navigator.moveToView(state, data.viewsById, targetViewId);
    if (ok) {
      drawPlay();
      SaveManager.save(state);
    }
  }

  function onItemTap(itemId) {
    if (msgQueue.isBusy()) return;
    const wasSelected = ctx.selectedItemId === itemId;
    Inventory.toggleSelectItem(ctx, itemId);
    // アイテムを選択した瞬間(=手に取ってよく見た瞬間)だけ、アイテムに書かれている
    // 内容(itemsById[].inspectMessage)を表示する。選択解除時には出さない。
    if (!wasSelected && ctx.selectedItemId === itemId) {
      const item = data.itemsById[itemId];
      const msgs = item && resolveMessage(item.inspectMessage, state, ctx);
      if (msgs) msgs.forEach((m) => queueMessage(m));
    }
    drawPlay();
  }

  function onIconTap(key) {
    if (key === "log") showLogModal();
    else if (key === "hint") showHintModal();
    else if (key === "settings") showSettingsModal();
  }

  // ゲーム概要.txt「キャラ顔画像：タップすると次やる事のメッセージ(台詞)が表示される」対応。
  // 現在のPlayPartの「まだやることが残っている」メッセージを、配信用カメラをタップした
  // 時と同じ文言で表示する（新しい文言を別途持たない＝表記ゆれの発生源を増やさない）。
  function onFaceTap() {
    if (msgQueue.isBusy()) return;
    const part = data.playPartsById[state.playPart];
    const msgs = part && resolveMessage(part.notYetMessage, state, ctx);
    if (msgs) msgs.forEach((m) => queueMessage(m));
    else queueMessage("特に伝えることはないようだ");
  }

  function openGimmick(gimmickId) {
    const gimmick = data.gimmicksById[gimmickId];
    if (!gimmick) {
      console.error(`[main] 存在しないgimmick: ${gimmickId}`);
      return;
    }
    // ギミックを開く直前まで表示待ちだったメッセージは、モーダルに隠れて
    // 実質読めないまま取り残される。閉じた後に亡霊のように再表示されないよう、
    // ここで表示中キューを空にしておく（7-8対応）。
    msgQueue.clear();
    const { overlay, box } = Renderer.renderModalWrap(modalRoot);
    currentModalOverlay = overlay;

    const statusEl = document.createElement("div");
    statusEl.className = "gimmick-status";
    box.appendChild(statusEl);
    currentModalStatusEl = statusEl;

    const closeBtn = document.createElement("button");
    closeBtn.className = "modal-close-btn";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => closeGimmick());
    box.appendChild(closeBtn);

    const gimmickContainer = document.createElement("div");
    box.appendChild(gimmickContainer);

    const onResult = (correct) => engine.resolveGimmickResult(gimmickId, correct);
    if (gimmick.type === "numericCode") {
      renderNumericCodeGimmick(gimmickContainer, gimmick, onResult);
    } else if (gimmick.type === "letterSelect") {
      renderLetterSelectGimmick(gimmickContainer, gimmick, onResult);
    } else if (gimmick.type === "tapRegions") {
      renderTapRegionsGimmick(gimmickContainer, gimmick, onResult);
    } else if (gimmick.type === "chatForm") {
      renderChatFormGimmick(gimmickContainer, gimmick, { inventory: state.inventory, itemsById: data.itemsById }, onResult);
    } else {
      gimmickContainer.textContent = `未実装のギミックtype: ${gimmick.type}`;
    }
  }

  function closeGimmick() {
    if (currentModalOverlay) {
      currentModalOverlay.remove();
      currentModalOverlay = null;
    }
    currentModalStatusEl = null;
    if (state.phase === "play") drawPlay();
  }

  // 表示アクション用モーダル。実画像がまだ無い間はcaptionをそのままプレースホルダーとして
  // 見せる（未準備の画像は適当な文字等で表示、の方針）。閉じるのは×ボタンから。
  function showImageModal(opts) {
    const { overlay, box } = Renderer.renderModalWrap(modalRoot);
    if (opts.image) {
      const img = document.createElement("img");
      img.className = "modal-image";
      img.src = opts.image;
      img.alt = opts.caption || "";
      img.addEventListener("error", () => {
        img.replaceWith(createModalImagePlaceholder(opts.caption));
      });
      box.appendChild(img);
    } else {
      box.appendChild(createModalImagePlaceholder(opts.caption));
    }
    addModalCloseButton(box, overlay);
  }

  function createModalImagePlaceholder(caption) {
    const placeholder = document.createElement("div");
    placeholder.className = "gimmick-image-placeholder modal-image-placeholder";
    placeholder.textContent = caption || "（画像 仮）";
    return placeholder;
  }

  function openBgmMenu() {
    const { overlay, box } = Renderer.renderModalWrap(modalRoot);
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = "BGMを選ぶ";
    box.appendChild(title);

    const list = document.createElement("div");
    list.className = "bgm-list";
    Object.values(data.bgmById).forEach((track) => {
      const unlocked = state.bgmState.unlockedTracks.includes(track.id);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bgm-track-btn" + (state.bgmState.currentTrack === track.id ? " selected" : "");
      btn.textContent = unlocked ? track.label : `${track.label}（未入手）`;
      btn.disabled = !unlocked;
      btn.addEventListener("click", () => {
        state.bgmState.currentTrack = track.id;
        SaveManager.save(state);
        overlay.remove();
        drawPlay();
      });
      list.appendChild(btn);
    });
    box.appendChild(list);
    addModalCloseButton(box, overlay);
  }

  function showLogModal() {
    const { overlay, box } = Renderer.renderModalWrap(modalRoot);
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = "ログ";
    box.appendChild(title);
    const list = document.createElement("div");
    list.className = "log-list";
    if (messageLog.length === 0) {
      list.textContent = "（まだログはありません）";
    } else {
      messageLog.forEach((t) => {
        const line = document.createElement("div");
        line.className = "log-line";
        line.textContent = t;
        list.appendChild(line);
      });
    }
    box.appendChild(list);
    addModalCloseButton(box, overlay);
  }

  // ヒントの行を隠すためのマスク文字。「タップ毎に捲れていく」(ゲーム概要.txt)対応。
  const HINT_MASK = "??????";

  function showHintModal() {
    const { overlay, box } = Renderer.renderModalWrap(modalRoot);
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = `ヒント（Part${state.playPart}）`;
    box.appendChild(title);

    const note = document.createElement("div");
    note.className = "hint-note";
    note.textContent = "タップでヒントが表示されます";
    box.appendChild(note);

    const list = document.createElement("div");
    list.className = "hint-list";
    box.appendChild(list);

    function drawList() {
      list.innerHTML = "";
      const hint = data.hintsById[state.playPart];
      if (!hint || hint.steps.length === 0) {
        list.textContent = "（このパートのヒントは未設定です）";
        return;
      }
      const revealed = state.hintRevealCounts[state.playPart] || 0;
      hint.steps.forEach((step, i) => {
        const line = document.createElement("div");
        if (i < revealed) {
          line.className = "hint-line";
          line.textContent = `・${step}`;
        } else {
          line.className = "hint-line hint-line--masked";
          line.textContent = `・${HINT_MASK}`;
          line.addEventListener("click", () => {
            // 常に「今表示されている中で一番上の隠れている行」を開放する＝1行ずつ順番に捲れる
            const current = state.hintRevealCounts[state.playPart] || 0;
            if (current < hint.steps.length) {
              state.hintRevealCounts[state.playPart] = current + 1;
              SaveManager.save(state);
              drawList();
            }
          });
        }
        list.appendChild(line);
      });
    }

    drawList();
    addModalCloseButton(box, overlay);
  }

  function showSettingsModal() {
    const { overlay, box } = Renderer.renderModalWrap(modalRoot);
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = "設定";
    box.appendChild(title);
    const note = document.createElement("div");
    note.textContent = "音量調整・著作権表示は試作段階では未実装です。";
    box.appendChild(note);
    const resetBtn = document.createElement("button");
    resetBtn.className = "danger-btn";
    resetBtn.textContent = "セーブデータを削除して最初から";
    resetBtn.addEventListener("click", () => {
      if (confirm("セーブデータを削除して最初からやり直します。よろしいですか？")) {
        SaveManager.clear();
        location.reload();
      }
    });
    box.appendChild(resetBtn);
    addModalCloseButton(box, overlay);
  }

  function addModalCloseButton(box, overlay) {
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal-close-btn";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => overlay.remove());
    box.appendChild(closeBtn);
  }

  function enterStoryPart(storyPartId) {
    const story = data.storyPartsById[storyPartId];
    if (!story) {
      console.error(`[main] 存在しないStoryPart: ${storyPartId}`);
      return;
    }
    storyQueue.clear();
    story.lines.forEach((line) => storyQueue.enqueue(line));
    storyQueue.advance();
  }

  function enterPlayPart(part) {
    // ログが操作パートをまたいで際限なく伸びないよう、パート開始時にリセットする。
    messageLog.length = 0;
    drawPlay();
    part.startMessages.forEach((t) => queueMessage(t));
  }

  function startGame() {
    const part = data.playPartsById[1];
    state.phase = "play";
    state.playPart = 1;
    state.currentView = part.startView;
    SaveManager.save(state);
    enterPlayPart(part);
  }

  // デバッグ用: スタート画面から任意のPlayPart/StoryPartへ直接ジャンプする。
  // 通常プレイの状態(所持品・フラグ・選択中アイテム・表示待ちメッセージ等)を
  // 引きずらないよう、毎回まっさらな状態から対象のパートへ入り直す
  // (=そのパート単体のテストがしやすいようにする)。
  function jumpToPlayPart(playPartId) {
    const part = data.playPartsById[playPartId];
    if (!part) {
      console.error(`[main] 存在しないPlayPart: ${playPartId}`);
      return;
    }
    Object.assign(state, createInitialState());
    ctx.selectedItemId = null;
    msgQueue.clear();
    storyQueue.clear();
    state.phase = "play";
    state.playPart = playPartId;
    state.currentView = part.startView;
    SaveManager.save(state);
    enterPlayPart(part);
  }

  function jumpToStoryPart(storyPartId) {
    const story = data.storyPartsById[storyPartId];
    if (!story) {
      console.error(`[main] 存在しないStoryPart: ${storyPartId}`);
      return;
    }
    Object.assign(state, createInitialState());
    ctx.selectedItemId = null;
    msgQueue.clear();
    storyQueue.clear();
    state.phase = "story";
    state.storyPart = storyPartId;
    SaveManager.save(state);
    enterStoryPart(storyPartId);
  }

  function renderStartScreen() {
    Renderer.renderStart(root, {
      onStart: startGame,
      onJumpToPlayPart: jumpToPlayPart,
      onJumpToStoryPart: jumpToStoryPart,
      playPartIds: Object.keys(data.playPartsById).map(Number),
      storyPartIds: Object.keys(data.storyPartsById).map(Number)
    });
  }

  // 想定外の連打・多重タップ対策:
  // メッセージ/ストーリーが表示待ちの間は、他の操作より先にメッセージ送りを優先する。
  // ただし別のクリックポイント(spot)・矢印・所持品アイテムをタップした場合は例外で、
  // そのタップで前のメッセージを消すと同時に、新しい操作も同じタップ内で実行する
  // （矢印/所持品だけ対象外だと、スポットは1タップで進むのに矢印は2タップ必要になる
  // という不整合になっていたため、実機確認の上で揃えた）。
  root.addEventListener(
    "click",
    (e) => {
      if (state.phase === "play" && msgQueue.isBusy()) {
        const actionable = e.target.closest && e.target.closest(".spot-btn, .spot-hotspot, .arrow-btn, .inventory-item");
        if (actionable) {
          msgQueue.clear();
          return; // 伝播を止めず、各要素側のクリック処理へそのまま進める
        }
        msgQueue.advance();
        e.stopPropagation();
      } else if (state.phase === "story" && storyQueue.isBusy()) {
        storyQueue.advance();
        e.stopPropagation();
      }
    },
    true
  );

  // 初期表示
  if (state.phase === "start") {
    renderStartScreen();
  } else if (state.phase === "story") {
    enterStoryPart(state.storyPart);
  } else if (state.phase === "play") {
    drawPlay();
  } else {
    renderStartScreen();
  }
}

main();
