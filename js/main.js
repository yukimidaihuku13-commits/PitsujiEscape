// main.js
// データ読み込み → 状態初期化 → UIコールバック配線、を行うエントリーポイント。
// ロジック本体(Engine)とDOM描画(Renderer)を繋ぐ「配線」だけに責務を絞る。

import { createInitialState } from "./state/GameState.js";
import { Engine } from "./engine/ActionExec.js";
import { resolveActions } from "./engine/RuleResolver.js";
import * as Navigator from "./nav/Navigator.js";
import * as Inventory from "./inventory/Inventory.js";
import * as SaveManager from "./save/SaveManager.js";
import * as Renderer from "./ui/Renderer.js";
import { MessageQueue } from "./ui/DialogueBox.js";
import { renderNumericCodeGimmick } from "./gimmick/NumericCodeGimmick.js";

const DATA_FILES = {
  itemsById: "data/items.json",
  viewsById: "data/views.json",
  spotsById: "data/spots.json",
  playPartsById: "data/playParts.json",
  storyPartsById: "data/storyParts.json",
  gimmicksById: "data/gimmicks.json",
  hintsById: "data/hints.json"
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
      if (el) el.textContent = item.text;
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
    messageLog.push(text);
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
      onIconTap
    });
  }

  const ui = {
    queueMessage,
    playSE: (id) => console.log(`[SE] ${id}（音声アセット未定）`),
    openGimmick: (gimmickId) => openGimmick(gimmickId),
    closeGimmick: () => closeGimmick(),
    enterStoryPart: (storyPartId) => enterStoryPart(storyPartId),
    enterPlayPart: (part) => enterPlayPart(part),
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
    Inventory.toggleSelectItem(ctx, itemId);
    drawPlay();
  }

  function onIconTap(key) {
    if (key === "log") showLogModal();
    else if (key === "hint") showHintModal();
    else if (key === "settings") showSettingsModal();
  }

  function openGimmick(gimmickId) {
    const gimmick = data.gimmicksById[gimmickId];
    if (!gimmick) {
      console.error(`[main] 存在しないgimmick: ${gimmickId}`);
      return;
    }
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

    if (gimmick.type === "numericCode") {
      renderNumericCodeGimmick(gimmickContainer, gimmick, (correct) => {
        engine.resolveGimmickResult(gimmickId, correct);
      });
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

  function showHintModal() {
    const { overlay, box } = Renderer.renderModalWrap(modalRoot);
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = `ヒント（Part${state.playPart}）`;
    box.appendChild(title);
    const hint = data.hintsById[state.playPart];
    const list = document.createElement("div");
    list.className = "hint-list";
    if (!hint || hint.steps.length === 0) {
      list.textContent = "（このパートのヒントは未設定です）";
    } else {
      hint.steps.forEach((step) => {
        const line = document.createElement("div");
        line.className = "hint-line";
        line.textContent = `・${step}`;
        list.appendChild(line);
      });
    }
    box.appendChild(list);
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
    drawPlay();
    part.startMessages.forEach((t) => queueMessage(t));
  }

  function startGame() {
    state.phase = "play";
    state.playPart = 1;
    state.currentView = "roomPiguma";
    SaveManager.save(state);
    enterPlayPart(data.playPartsById[1]);
  }

  // 想定外の連打・多重タップ対策:
  // メッセージ/ストーリーが表示待ちの間は、他の操作より先にメッセージ送りを優先する
  root.addEventListener(
    "click",
    (e) => {
      if (state.phase === "play" && msgQueue.isBusy()) {
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
    Renderer.renderStart(root, () => startGame());
  } else if (state.phase === "story") {
    enterStoryPart(state.storyPart);
  } else if (state.phase === "play") {
    drawPlay();
  } else {
    Renderer.renderStart(root, () => startGame());
  }
}

main();
