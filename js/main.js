// main.js
// データ読み込み → 状態初期化 → UIコールバック配線、を行うエントリーポイント。
// ロジック本体(Engine)とDOM描画(Renderer)を繋ぐ「配線」だけに責務を絞る。

import { createInitialState } from "./state/GameState.js";
import { Engine } from "./engine/ActionExec.js";
import { evaluate } from "./engine/ConditionEval.js";
import { resolveActions, resolveMessage } from "./engine/RuleResolver.js";
import * as Navigator from "./nav/Navigator.js";
import * as SaveManager from "./save/SaveManager.js";
import * as Renderer from "./ui/Renderer.js";
import { MessageQueue } from "./ui/DialogueBox.js";
import * as AudioManager from "./audio/AudioManager.js";
import { renderNumericCodeGimmick } from "./gimmick/NumericCodeGimmick.js";
import { renderLetterSelectGimmick } from "./gimmick/LetterSelectGimmick.js";
import { renderTapRegionsGimmick } from "./gimmick/TapRegionsGimmick.js";
import { renderChatSelectGimmick } from "./gimmick/ChatSelectGimmick.js";
import { renderPhoneDialGimmick } from "./gimmick/PhoneDialGimmick.js";

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

// 回線が極端に遅い/応答が返ってこない場合に、無言で固まり続けないようにするための上限時間。
const FETCH_TIMEOUT_MS = 20000;

async function fetchJson(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(path, { signal: controller.signal });
    if (!res.ok) throw new Error(`${path} の読み込みに失敗しました (${res.status})`);
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`${path} の読み込みがタイムアウトしました`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function loadAllData() {
  const entries = await Promise.all(
    Object.entries(DATA_FILES).map(async ([key, path]) => [key, keyBy(await fetchJson(path))])
  );
  const data = Object.fromEntries(entries);
  data.transitions = await fetchJson("data/transitions.json");
  data.audio = await fetchJson("data/audio.json");
  data.credits = await fetchJson("data/credits.json");
  return data;
}

// 古いセーブデータ(項目追加前のもの・削除済みのviewを指しているもの)を読み込んでも
// 画面が真っ白にならないよう、足りない項目を初期値で補い、存在しないviewは
// そのパートの開始視点へ戻す。
// 手で書き換えられた等で型が壊れているセーブは、進行位置が不正なら破棄(null)し、
// 個々の項目が壊れている場合は初期値に置き換える（起動できなくなるのを防ぐ）。
function normalizeLoadedState(loaded, data) {
  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) return null;
  const init = createInitialState();
  const state = { ...init, ...loaded };
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const strArray = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string"))] : []);
  if (!["start", "story", "play", "end"].includes(state.phase)) return null;
  if (state.phase === "play" && !data.playPartsById[state.playPart]) return null;
  if (state.phase === "story" && !data.storyPartsById[state.storyPart]) return null;
  for (const key of ["flags", "clickCounts", "itemUsageLog", "hintRevealCounts"]) if (!isObj(state[key])) state[key] = init[key];
  for (const [k, v] of Object.entries(state.itemUsageLog)) state.itemUsageLog[k] = strArray(v);
  state.everObtainedItems = strArray(state.everObtainedItems);
  if (!isObj(state.bgmState)) state.bgmState = init.bgmState;
  state.bgmState.unlockedTracks = strArray(state.bgmState.unlockedTracks).filter((id) => data.bgmById[id]);
  if (!state.bgmState.unlockedTracks.includes("default")) state.bgmState.unlockedTracks.unshift("default");
  if (!state.bgmState.unlockedTracks.includes(state.bgmState.currentTrack)) state.bgmState.currentTrack = "default";
  if (!Number.isInteger(state.notePage) || state.notePage < 0) state.notePage = 0;
  // 削除されたアイテム(音楽CD・ぴつじの写真等)を持ったままのセーブは、そのアイテムを取り除く。
  state.inventory = strArray(state.inventory).filter((id) => data.itemsById[id]);
  if (state.phase === "play" && !data.viewsById[state.currentView]) {
    const part = data.playPartsById[state.playPart];
    console.warn(`[main] セーブデータのview(${state.currentView})が存在しないため開始視点に戻します`);
    state.currentView = part ? part.startView : null;
    state.notePage = 0;
  }
  const view = data.viewsById[state.currentView];
  if (view && view.pages && state.notePage >= view.pages.length) state.notePage = 0;
  return state;
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

  root.textContent = "読み込み中…";
  let data;
  try {
    data = await loadAllData();
  } catch (e) {
    console.error(e);
    root.textContent = "";
    const msg = document.createElement("div");
    msg.className = "load-error";
    msg.textContent = `データの読み込みに失敗しました。通信環境を確認して再読み込みしてください。\n(${e.message})`;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "再読み込み";
    retry.addEventListener("click", () => location.reload());
    root.append(msg, retry);
    return;
  }

  const saveAvailable = SaveManager.isAvailable();
  if (!saveAvailable) console.warn("[main] この環境ではlocalStorageが使えないため、セーブされません");

  const state = normalizeLoadedState(SaveManager.load(), data) || createInitialState();
  const ctx = { selectedItemId: null };
  const messageLog = [];

  let currentModalStatusEl = null;
  let currentModalOverlay = null;

  // 拡大表示済みのアイテム。「選択 → 同じアイテムをタップで拡大表示 → さらにタップで選択解除」
  // の2段目を済ませたかどうかを判定するために使う(選択が別アイテムに移ったら無効)。
  let zoomShownItemId = null;

  // 表情タップのループ表示用カウンタ { "パート番号:faceMessageの添字": 次に出す行 }
  const faceCycleIndex = {};

  // 自動クリア待ち(パート6)。メッセージを読み終えた時点でストーリーへ移る。
  let pendingAutoClear = false;

  // 操作パート開始時メッセージの表示中。読み終えるまで、メッセージ送りと設定ボタン以外の
  // 操作(矢印・クリックポイント・所持品・表情・ログ・ヒント等)を受け付けない。
  let startMessagesPending = false;

  // 画面(視点/フェーズ)が切り替わった直後の短時間は、タップを受け付けない。
  // 素早い連続タップの2打目が、切替後の画面の別ボタンに誤って当たるのを防ぐ。
  const TAP_GUARD_MS = 250;
  let tapGuardUntil = 0;
  let lastScreenKey = null;
  function markScreen(key) {
    if (key !== lastScreenKey) {
      lastScreenKey = key;
      tapGuardUntil = Date.now() + TAP_GUARD_MS;
    }
  }

  // メッセージキューには台詞({text})の他に、画像表示({image})・効果音({se})も積める。
  // 「メッセージ → 画像 → メッセージ」のような演出を、ゲームクリックポイント.txtの記載順どおりに
  // 1つずつ見せるため。画像は閉じた時点で、効果音は鳴らした時点で次へ進む。
  const msgQueue = new MessageQueue(
    (item) => {
      if (item && item.se != null) {
        playSENow(item.se);
        msgQueue.advance();
        return;
      }
      const el = document.getElementById("footer-message");
      if (el) el.textContent = (item && item.text) || "";
      if (item && item.image) openQueuedImage(item);
      if (item && item.gimmick) openQueuedGimmick(item);
    },
    () => {
      startMessagesPending = false;
      if (pendingAutoClear) runPendingAutoClear();
    }
  );

  const storyQueue = new MessageQueue(
    (line) => {
      markScreen("story");
      if (line && line.bgm) {
        baseBgm = line.bgm;
        refreshBgm();
      }
      if (line && line.se) AudioManager.playSE(line.se);
      drawStoryLine(line);
    },
    () => {
      const story = data.storyPartsById[state.storyPart];
      engine.advanceToPlayPart(story.nextPlayPart);
    }
  );

  // ゲームタイトル（ゲーム概要.txt【ゲームタイトル】）。プロローグ(ストーリーパート1)が
  // 終わるまでは「ぴつじ脱出ゲーム」、終了後は「ぴつじを部屋から脱出させるゲーム」。
  function gameTitle() {
    const afterPrologue = state.phase === "story" ? state.storyPart >= 2 : state.playPart >= 2;
    return afterPrologue ? "ぴつじを部屋から脱出させるゲーム" : "ぴつじ脱出ゲーム";
  }

  // ストーリーの早送り: ONの間、1行ずつ一定間隔で自動的に送る。もう一度押すと停止。
  // ストーリーパートの最後まで進んだ(＝ストーリー以外の画面になった)時点で自動的に解除する。
  const FAST_FORWARD_INTERVAL_MS = 150;
  let fastForwardTimer = null;

  function drawStoryLine(line) {
    Renderer.renderStory(root, line, {
      title: gameTitle(),
      onIconTap,
      fastForwarding: fastForwardTimer !== null,
      onFastForward: toggleFastForward
    });
  }

  function toggleFastForward() {
    if (fastForwardTimer !== null) {
      stopFastForward();
      drawStoryLine(storyQueue.current);
      return;
    }
    fastForwardTimer = setInterval(() => {
      if (state.phase !== "story" || !storyQueue.isBusy()) {
        stopFastForward();
        return;
      }
      storyQueue.advance();
      if (state.phase !== "story") stopFastForward();
    }, FAST_FORWARD_INTERVAL_MS);
    drawStoryLine(storyQueue.current);
  }

  function stopFastForward() {
    if (fastForwardTimer !== null) {
      clearInterval(fastForwardTimer);
      fastForwardTimer = null;
    }
  }

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
    logMessage(text);
    if (currentModalStatusEl) {
      currentModalStatusEl.textContent = text;
      return;
    }
    msgQueue.enqueue({ text });
    if (msgQueue.current === null) msgQueue.advance();
  }

  function drawPlay() {
    markScreen(`play:${state.currentView}`);
    const currentText = (msgQueue.current && msgQueue.current.text) || "";
    Renderer.renderPlay(root, {
      state,
      ctx,
      data,
      currentMessage: currentText,
      title: gameTitle(),
      onSpotTap,
      onArrowTap,
      onItemTap,
      onIconTap,
      onFaceTap,
      onNotePageTap,
      onNoteClose
    });
  }

  const ui = {
    queueMessage,
    // メッセージ表示待ちがある間は、その後ろに積んで順番に鳴らす（ギミック表示中は即時）。
    playSE: (id) => {
      if (msgQueue.isBusy() && !currentModalStatusEl) msgQueue.enqueue({ se: id });
      else playSENow(id);
    },
    // 先に読むメッセージがある場合は、読み終えてからギミックを開く（資料の記載順: メッセージ → ギミック）
    openGimmick: (gimmickId) => {
      if (msgQueue.isBusy() && !currentModalStatusEl) msgQueue.enqueue({ gimmick: gimmickId });
      else openGimmick(gimmickId);
    },
    closeGimmick: () => closeGimmick(),
    enterStoryPart: (storyPartId) => enterStoryPart(storyPartId),
    enterPlayPart: (part) => enterPlayPart(part),
    enterEnding: () => renderEnding(),
    showImageModal: (opts) => showImageModal(opts),
    openBgmMenu: () => openBgmMenu(),
    requestRender: () => {
      if (state.phase === "play") drawPlay();
    },
    scheduleAutoClear: () => {
      pendingAutoClear = true;
      if (!msgQueue.isBusy()) runPendingAutoClear();
    }
  };

  function runPendingAutoClear() {
    pendingAutoClear = false;
    closeAllModals();
    engine.runAutoClear();
  }

  function closeAllModals() {
    modalRoot.innerHTML = "";
    currentModalOverlay = null;
    currentModalStatusEl = null;
  }

  const engine = new Engine(state, data, ctx, ui);

  // 効果音の再生。音声ファイルの割り当ては data/audio.json（未割り当てのキーはログのみ）。
  function playSENow(id) {
    AudioManager.playSE(id);
  }

  // 画面操作(所持品・ヘッダーアイコン)のSE。どの音を使うかは data/audio.json の ui で指定する。
  function playUiSE(key) {
    const id = data.audio.ui && data.audio.ui[key];
    if (id) AudioManager.playSE(id);
  }

  // ---- BGM ----
  // 流れるBGMは次の優先順で決まる。
  //   1. 画像表示中だけ流すBGM(パーティー画像等) … imageBgmTrack (bgm.jsonのid)
  //   2. オーディオで選んだ曲(「通常」以外)       … state.bgmState.currentTrack
  //   3. 操作パート/ストーリーのBGM                … baseBgm (audio.jsonのBGMキー)
  let baseBgm = null;
  let imageBgmTrack = null;

  function bgmSoundOfTrack(trackId) {
    const track = data.bgmById[trackId];
    return track ? track.sound || null : null;
  }

  // 操作パートのBGM(playParts.json の bgm)。指定が無いパートは直前のパートのBGMを引き継ぐ。
  function partBgm(partId) {
    for (let i = partId; i >= 1; i--) {
      const part = data.playPartsById[i];
      if (part && part.bgm) return part.bgm;
    }
    return null;
  }

  function refreshBgm() {
    if (state.phase === "start") {
      AudioManager.stopBgm();
      return;
    }
    let key = baseBgm;
    if (imageBgmTrack) key = bgmSoundOfTrack(imageBgmTrack);
    else if (state.bgmState.currentTrack && state.bgmState.currentTrack !== "default") key = bgmSoundOfTrack(state.bgmState.currentTrack);
    AudioManager.playBgm(key);
  }

  function onSpotTap(spotId) {
    if (msgQueue.isBusy() || pendingAutoClear) return; // 想定外の連打に対する保険
    const spot = data.spotsById[spotId];
    if (!spot) {
      console.error(`[main] 存在しないspot: ${spotId}`);
      return;
    }
    const actions = resolveActions(spot, state, ctx);
    engine.runActions(actions, spotId);
  }

  function onArrowTap(targetViewId) {
    if (msgQueue.isBusy() || pendingAutoClear) return;
    const ok = Navigator.moveToView(state, data.viewsById, targetViewId);
    if (ok) {
      drawPlay();
      SaveManager.save(state);
    }
  }

  // 所持品アイコンのタップ:
  //   未選択のアイテム → そのアイテムを選択（別アイテム選択中なら選択が移る）
  //   選択中のアイテム → 拡大画像を表示（選択は解除しない）
  //   拡大表示済みの選択中アイテム → 選択解除
  function onItemTap(itemId) {
    if (msgQueue.isBusy() || pendingAutoClear) return;
    if (ctx.selectedItemId !== itemId) {
      playUiSE("itemSelect");
      ctx.selectedItemId = itemId;
      zoomShownItemId = null;
    } else if (zoomShownItemId !== itemId) {
      zoomShownItemId = itemId;
      showItemZoom(itemId);
    } else {
      ctx.selectedItemId = null;
      zoomShownItemId = null;
    }
    drawPlay();
  }

  // アイテム拡大表示。画像の下に説明文を出し、画面のどこかをタップすると説明文が
  // 消えて閉じるボタンが出る（説明文が複数行ある場合はタップ毎に次の行へ）。
  // 拡大画像が未用意の間は、アイテム名のプレースホルダーで代用する。
  function showItemZoom(itemId) {
    const item = data.itemsById[itemId];
    if (!item) return;
    const { overlay, box } = Renderer.renderModalWrap(modalRoot);
    box.classList.add("item-zoom-box");

    const name = document.createElement("div");
    name.className = "item-zoom-name";
    name.textContent = item.name;
    box.appendChild(name);

    // 画像部分。実画像(image)が無い間は placeholder の文言(無ければアイテム名)で代用する。
    let imageEl = null;
    function drawImage(image, placeholderText) {
      const placeholder = createModalImagePlaceholder(placeholderText || `${item.name}\n（拡大画像 仮）`);
      let el = placeholder;
      if (image) {
        el = document.createElement("img");
        el.className = "item-zoom-image";
        el.src = image;
        el.alt = item.name;
        el.addEventListener("error", () => el.replaceWith(placeholder));
      }
      if (imageEl && imageEl.isConnected) imageEl.replaceWith(el);
      else box.appendChild(el);
      imageEl = el;
    }

    // zoomPages: タップする度に画像と説明文が切り替わるアイテム(ぴさぎの名刺の表/裏)。
    // 最後のページの次は最初のページに戻る。閉じるボタンは常に表示する。
    if (Array.isArray(item.zoomPages) && item.zoomPages.length > 0) {
      let pageIndex = 0;
      const pageMsgEl = document.createElement("div");
      pageMsgEl.className = "item-zoom-message";
      const pageCloseBtn = document.createElement("button");
      pageCloseBtn.type = "button";
      pageCloseBtn.className = "item-zoom-close";
      pageCloseBtn.textContent = "閉じる";
      pageCloseBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeModal(overlay);
      });
      const showPage = () => {
        const page = item.zoomPages[pageIndex];
        drawImage(page.image, page.placeholder);
        pageMsgEl.textContent = page.text || "";
        if (page.text) logMessage(page.text);
        box.append(pageMsgEl, pageCloseBtn);
      };
      showPage();
      const pageOpenedAt = Date.now();
      overlay.addEventListener("click", (e) => {
        if (e.target === pageCloseBtn) return;
        if (Date.now() - pageOpenedAt < TAP_GUARD_MS) return;
        pageIndex = (pageIndex + 1) % item.zoomPages.length;
        showPage();
      });
      return;
    }

    drawImage(item.image, (resolveMessage(item.placeholder, state, ctx) || [])[0]);

    const lines = resolveMessage(item.description, state, ctx) || [];
    lines.forEach((t) => logMessage(t));
    let lineIndex = 0;

    const msgEl = document.createElement("div");
    msgEl.className = "item-zoom-message";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "item-zoom-close";
    closeBtn.textContent = "閉じる";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeModal(overlay);
    });

    function showLine() {
      if (lineIndex < lines.length) {
        msgEl.textContent = lines[lineIndex];
        if (!msgEl.isConnected) box.appendChild(msgEl);
      } else {
        msgEl.remove();
        box.appendChild(closeBtn);
      }
    }
    showLine();

    // 開いた直後の素早い2打目で、説明文を読む前に消えてしまわないよう少しだけ間を置く。
    const openedAt = Date.now();
    overlay.addEventListener("click", (e) => {
      if (e.target === closeBtn) return;
      if (Date.now() - openedAt < TAP_GUARD_MS) return;
      if (lineIndex < lines.length) {
        lineIndex++;
        showLine();
      }
    });
  }

  function onIconTap(key) {
    playUiSE("headerIcon");
    if (key === "log") showLogModal();
    else if (key === "hint") showHintModal();
    else if (key === "settings") showSettingsModal();
  }

  // ゲーム概要.txt「キャラ顔画像：タップすると次やる事のメッセージ(台詞)が表示される」対応。
  // 現在のPlayPartの「まだやることが残っている」メッセージを、配信用カメラをタップした
  // 時と同じ文言で表示する（新しい文言を別途持たない＝表記ゆれの発生源を増やさない）。
  // 文言は playParts.json の faceMessage で定義する（ゲームシステム.txt「表情タップ時メッセージ」）。
  //   { when, text }   1行
  //   { when, texts }  複数行を順に表示
  //   { when, cycle }  タップ毎に1行ずつ変化し、最後の次は先頭に戻る(ループ)
  function onFaceTap() {
    if (msgQueue.isBusy() || pendingAutoClear) return;
    const part = data.playPartsById[state.playPart];
    const defs = (part && part.faceMessage) || [];
    const idx = defs.findIndex((d) => evaluate(d.when, state, ctx));
    if (idx < 0) {
      queueMessage("特に伝えることはないようだ");
      return;
    }
    const def = defs[idx];
    if (Array.isArray(def.cycle) && def.cycle.length > 0) {
      const key = `${state.playPart}:${idx}`;
      const n = faceCycleIndex[key] || 0;
      queueMessage(def.cycle[n % def.cycle.length]);
      faceCycleIndex[key] = (n + 1) % def.cycle.length;
    } else if (Array.isArray(def.texts)) {
      def.texts.forEach((t) => queueMessage(t));
    } else {
      queueMessage(def.text);
    }
  }

  // 調査ノートのページ画像タップ。表示中ページのonTapルールを実行する。
  function onNotePageTap() {
    if (msgQueue.isBusy() || pendingAutoClear) return;
    const view = data.viewsById[state.currentView];
    const page = view && view.pages && view.pages[state.notePage || 0];
    if (!page) return;
    engine.runActions(resolveActions({ rules: page.onTap || [] }, state, ctx), page.id);
  }

  // 調査ノートを閉じる。次に開く時はページ1左から（Engine.openNoteで0に戻す）。
  function onNoteClose() {
    if (pendingAutoClear) return;
    msgQueue.clear();
    const view = data.viewsById[state.currentView];
    state.notePage = 0;
    Navigator.moveToView(state, data.viewsById, (view && view.returnView) || "viewDesk");
    drawPlay();
    SaveManager.save(state);
  }

  // キューの順番が回ってきたギミックを開く。ギミックより後ろに積まれていたメッセージは
  // ギミック画面内の表示欄に出す（ギミックを開くとキューは空になるため）。
  function openQueuedGimmick(item) {
    const rest = msgQueue.queue.splice(0);
    openGimmick(item.gimmick);
    for (const q of rest) {
      if (q.text) queueMessage(q.text);
      else if (q.se != null) playSENow(q.se);
    }
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

    const onResult = (correct, input) => engine.resolveGimmickResult(gimmickId, correct, input);
    if (gimmick.type === "numericCode") {
      renderNumericCodeGimmick(gimmickContainer, gimmick, onResult);
    } else if (gimmick.type === "letterSelect") {
      renderLetterSelectGimmick(gimmickContainer, gimmick, onResult);
    } else if (gimmick.type === "tapRegions") {
      renderTapRegionsGimmick(gimmickContainer, gimmick, onResult);
    } else if (gimmick.type === "chatSelect") {
      renderChatSelectGimmick(gimmickContainer, gimmick, onResult);
    } else if (gimmick.type === "phoneDial") {
      renderPhoneDialGimmick(gimmickContainer, gimmick, onResult);
    } else {
      gimmickContainer.textContent = `未実装のギミックtype: ${gimmick.type}`;
    }
  }

  function closeGimmick() {
    if (currentModalOverlay) {
      closeModal(currentModalOverlay);
      currentModalOverlay = null;
    }
    currentModalStatusEl = null;
    if (state.phase === "play") drawPlay();
  }

  // 表示アクション用モーダル。実画像がまだ無い間はcaptionをそのままプレースホルダーとして
  // 見せる（未準備の画像は適当な文字等で表示、の方針）。
  // 「基本は再クリックで画像を消す」(ゲームクリックポイント.txt)に合わせ、×ボタンに加えて
  // 画面のどこをタップしても閉じる（開いた直後の素早い2打目では閉じない）。
  // 表示アクションはメッセージキュー経由で順番に出す（前のメッセージを読み終えてから画像が出る）。
  function showImageModal(opts) {
    msgQueue.enqueue({ image: opts });
    if (msgQueue.current === null) msgQueue.advance();
  }

  // キューの順番が回ってきた画像を表示する。閉じたらキューの次へ進む。
  // opts.text: 画像の下に出す台詞 / opts.bgm: 表示中だけ流すBGM(閉じると元の曲に戻す)
  function openQueuedImage(item) {
    const opts = item.image;
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
    if (opts.text) {
      const textEl = document.createElement("div");
      textEl.className = "item-zoom-message";
      textEl.textContent = opts.text;
      box.appendChild(textEl);
      logMessage(opts.text);
    }
    if (opts.bgm) {
      imageBgmTrack = opts.bgm;
      refreshBgm();
    }
    addModalCloseButton(box, overlay);
    const openedAt = Date.now();
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      if (opts.bgm) {
        imageBgmTrack = null;
        refreshBgm();
      }
      if (msgQueue.current === item) msgQueue.advance();
    };
    overlay.addEventListener("click", () => {
      if (Date.now() - openedAt >= TAP_GUARD_MS && overlay.isConnected) closeModal(overlay);
    });
    // 画面タップ・×ボタンのどちらで閉じた場合も、閉じた時点でキューを次へ進める
    new MutationObserver((_, obs) => {
      if (!overlay.isConnected) {
        obs.disconnect();
        finish();
      }
    }).observe(modalRoot, { childList: true });
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
        refreshBgm();
        SaveManager.save(state);
        closeModal(overlay);
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
    // SE・BGMのON/OFF（ゲームのセーブとは別に保存される）
    const audioSettings = document.createElement("div");
    audioSettings.className = "settings-audio";
    [["se", "効果音(SE)"], ["bgm", "BGM"]].forEach(([kind, label]) => {
      const row = document.createElement("div");
      row.className = "settings-row";
      const name = document.createElement("span");
      name.textContent = label;
      const toggle = document.createElement("button");
      toggle.type = "button";
      const draw = () => {
        const on = AudioManager.getSettings()[kind];
        toggle.textContent = on ? "ON" : "OFF";
        toggle.className = "settings-toggle" + (on ? " settings-toggle--on" : "");
      };
      toggle.addEventListener("click", () => {
        AudioManager.setEnabled(kind, !AudioManager.getSettings()[kind]);
        draw();
      });
      draw();
      row.append(name, toggle);
      audioSettings.appendChild(row);
    });
    box.appendChild(audioSettings);

    // 著作権表記（data/credits.json）
    const credits = document.createElement("div");
    credits.className = "settings-credits";
    const creditsTitle = document.createElement("div");
    creditsTitle.className = "settings-credits-title";
    creditsTitle.textContent = "著作権表記";
    credits.appendChild(creditsTitle);
    (data.credits.lines || []).forEach((c) => {
      const line = document.createElement("div");
      line.className = "settings-credits-line";
      line.textContent = c.text;
      if (c.url) {
        const link = document.createElement("a");
        link.href = c.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = c.url;
        line.append(document.createElement("br"), link);
      }
      credits.appendChild(line);
    });
    box.appendChild(credits);
    if (!saveAvailable) {
      const warn = document.createElement("div");
      warn.className = "save-warning";
      warn.textContent = "ブラウザの設定(Cookie・サイトデータのブロック等)により、この環境では進行状況がセーブされません。";
      box.appendChild(warn);
    }
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

  // メッセージをログにだけ積む（直前と全く同じ文言は積まない＝同じスポットの連打対策）。
  // 長時間同じパートで遊んでもメモリ・ログ画面が肥大化しないよう、古いものから捨てる。
  const MESSAGE_LOG_MAX = 200;
  function logMessage(text) {
    if (typeof text === "string" && messageLog[messageLog.length - 1] !== text) messageLog.push(text);
    if (messageLog.length > MESSAGE_LOG_MAX) messageLog.splice(0, messageLog.length - MESSAGE_LOG_MAX);
  }

  function addModalCloseButton(box, overlay) {
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal-close-btn";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeModal(overlay);
    });
    box.appendChild(closeBtn);
  }

  // モーダルを閉じる。閉じた直後の短時間はゲーム画面へのタップを無視する
  // （閉じるボタン等の素早い連打の2打目が下の画面に届き、成功メッセージ等を
  // 読む前に送ってしまう不具合の対策）。
  function closeModal(overlay) {
    overlay.remove();
    tapGuardUntil = Date.now() + TAP_GUARD_MS;
  }

  function enterStoryPart(storyPartId) {
    const story = data.storyPartsById[storyPartId];
    if (!story) {
      console.error(`[main] 存在しないStoryPart: ${storyPartId}`);
      return;
    }
    storyQueue.clear();
    // ストーリー開始時点では直前の操作パートのBGMを流し続ける（行に bgm があればそこで切り替わる）
    imageBgmTrack = null;
    baseBgm = partBgm(storyPartId);
    refreshBgm();
    story.lines.forEach((line) => storyQueue.enqueue(line));
    storyQueue.advance();
  }

  function enterPlayPart(part) {
    // ログが操作パートをまたいで際限なく伸びないよう、パート開始時にリセットする。
    messageLog.length = 0;
    zoomShownItemId = null;
    pendingAutoClear = false;
    imageBgmTrack = null;
    baseBgm = partBgm(part.id);
    refreshBgm();
    drawPlay();
    startMessagesPending = part.startMessages.length > 0;
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

  // エンディング画面。「タイトルへ戻る」でセーブを消して最初から遊べるようにする。
  function renderEnding() {
    markScreen("end");
    Renderer.renderEnding(root, {
      onBackToTitle: () => {
        SaveManager.clear();
        Object.assign(state, createInitialState());
        ctx.selectedItemId = null;
        renderStartScreen();
      }
    });
  }

  function renderStartScreen() {
    AudioManager.stopBgm();
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
  // ヘッダーのログ/ヒント/設定アイコンはメッセージ送りの対象外とし、そのまま各処理へ通す
  // （ストーリー中に設定ボタンが押せなかった不具合の修正）。
  // 自動クリア待ち(パート6)の間は、メッセージ送り以外の操作を受け付けない。
  root.addEventListener(
    "click",
    (e) => {
      // 設定ボタンはいつでも押せる（開始時メッセージの表示中・ストーリー中・画面切替直後も含む）
      if (e.target.closest && e.target.closest('[data-icon="settings"]')) return;
      if (Date.now() < tapGuardUntil) {
        e.stopPropagation();
        return;
      }
      if (state.phase === "play" && startMessagesPending) {
        // 開始時メッセージを読み終えるまでは、ヘッダーのログ/ヒントは反応させず、
        // それ以外の場所のタップは全てメッセージ送りにする。
        if (!(e.target.closest && e.target.closest(".header-icons"))) msgQueue.advance();
        e.stopPropagation();
        return;
      }
      if (e.target.closest && e.target.closest(".header-icons, .ff-btn")) return;
      if (state.phase === "play" && pendingAutoClear) {
        msgQueue.advance();
        e.stopPropagation();
      } else if (state.phase === "play" && msgQueue.isBusy()) {
        const actionable =
          e.target.closest && e.target.closest(".spot-btn, .spot-hotspot, .arrow-btn, .inventory-item, .note-page, .note-close-btn");
        // 画像表示が控えている間は、スポット等のタップでキューを捨てない（演出・BGM追加の
        // メッセージを見逃さないよう、通常のメッセージ送りとして扱う）。
        const hasQueuedImage = msgQueue.queue.some((q) => q.image || q.gimmick);
        if (actionable && !hasQueuedImage) {
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

  // 同じゲームを複数のタブ/ウィンドウで開いた場合: 別のタブがセーブを書き換えたら、
  // このタブは古い状態のまま上書きしないよう操作を止め、再読み込みを促す（BGMの二重再生も止める）。
  window.addEventListener("storage", (e) => {
    if (e.key !== SaveManager.SAVE_KEY || e.newValue === e.oldValue) return;
    AudioManager.stopBgm();
    AudioManager.setSuspended("otherTab", true);
    closeAllModals();
    const { box } = Renderer.renderModalWrap(modalRoot);
    box.classList.add("other-tab-box");
    const msg = document.createElement("div");
    msg.textContent = "別のタブ(ウィンドウ)でゲームが進みました。このタブは再読み込みしてください。";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "item-zoom-close";
    btn.textContent = "再読み込み";
    btn.addEventListener("click", () => location.reload());
    box.append(msg, btn);
    SaveManager.setReadOnly(true);
  });
  // タブが裏に回った(別アプリ・別タブ表示中)間はBGMを止め、戻ったら再開する。
  document.addEventListener("visibilitychange", () => AudioManager.setSuspended("hidden", document.hidden));

  // 初期表示
  AudioManager.init(data.audio);
  if (state.phase === "start") {
    renderStartScreen();
  } else if (state.phase === "story") {
    enterStoryPart(state.storyPart);
  } else if (state.phase === "end") {
    renderEnding();
  } else if (state.phase === "play") {
    baseBgm = partBgm(state.playPart);
    refreshBgm();
    drawPlay();
    // 自動クリア条件を満たした直後(メッセージを読み終える前)にリロードされた場合の救済
    engine.checkAutoClear();
  } else {
    renderStartScreen();
  }
}

main();
