// Renderer.js
// GameStateを「読むだけ」で画面を再構築する。ここでは状態を変更しない。
// 背景・アイテム画像等の実アセットは未確定のため、第一試作では
// ラベルテキスト＋プレースホルダー矩形で表現する。

import { getArrowsForView } from "../nav/Navigator.js";
import { hasMatchingRule, resolveBackground } from "../engine/RuleResolver.js";

const ARROW_SYMBOL = { up: "▲", down: "▼", left: "◀", right: "▶" };

// 背景/立ち絵の実ファイルが用意できていない、またはパス指定ミスで読み込みに
// 失敗した場合に、無言で真っ白/真っ黒になるのを防ぐための共通ヘルパー。
// 画像パスが無ければそもそも呼ばず、呼び出し側でプレースホルダーテキストを出す。
function createImageLayer(className, path, onError) {
  const img = document.createElement("img");
  img.className = className;
  img.src = path;
  img.alt = "";
  img.addEventListener("error", () => {
    img.classList.add(className + "--error");
    if (onError) onError();
  });
  return img;
}

function createPortraitPlaceholder(speaker) {
  const portrait = document.createElement("div");
  portrait.className = "portrait-box";
  portrait.textContent = `${speaker}\n(立ち絵仮)`;
  return portrait;
}

// position指定ホットスポットの座標合わせデバッグ表示（枠線＋ラベル文字）。
// リリース前にfalseにする（or この分岐ごと削除する）とデバッグ表示だけ消える。
const DEBUG_SHOW_HOTSPOT_LABELS = true;

// スタート画面の、各パートへ直接ジャンプできるデバッグボタン群。
// リリース前にfalseにする（or この分岐ごと削除する）と非表示にできる。
const DEBUG_SHOW_JUMP_BUTTONS = true;

export function renderStart(root, opts) {
  const { onStart, onJumpToPlayPart, onJumpToStoryPart, playPartIds, storyPartIds } = opts;
  root.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "start-screen";

  const title = document.createElement("div");
  title.className = "start-title";
  title.textContent = "ぴつじ脱出ゲーム\n（タップしてスタート）";
  title.addEventListener("click", onStart);
  wrap.appendChild(title);

  if (DEBUG_SHOW_JUMP_BUTTONS) {
    const panel = document.createElement("div");
    panel.className = "start-debug-panel";

    const label = document.createElement("div");
    label.className = "start-debug-label";
    label.textContent = "デバッグ: 直接ジャンプ（セーブ内容は上書きされます）";
    panel.appendChild(label);

    panel.appendChild(createJumpRow("PlayPart", playPartIds, onJumpToPlayPart));
    panel.appendChild(createJumpRow("StoryPart", storyPartIds, onJumpToStoryPart));

    wrap.appendChild(panel);
  }

  root.appendChild(wrap);
}

function createJumpRow(prefix, ids, onJump) {
  const row = document.createElement("div");
  row.className = "start-debug-row";
  [...ids].sort((a, b) => a - b).forEach((id) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "start-debug-btn";
    btn.textContent = `${prefix}${id}`;
    btn.addEventListener("click", () => onJump(id));
    row.appendChild(btn);
  });
  return row;
}

export function renderPlay(root, opts) {
  const { state, ctx, data, currentMessage, onSpotTap, onArrowTap, onItemTap, onIconTap, onFaceTap } = opts;
  root.innerHTML = "";

  const view = data.viewsById[state.currentView];

  const header = document.createElement("div");
  header.className = "header-icons";
  [
    ["log", "ログ"],
    ["hint", "ヒント"],
    ["settings", "設定"]
  ].forEach(([key, label]) => {
    const btn = document.createElement("button");
    btn.className = "icon-btn";
    btn.textContent = label;
    btn.addEventListener("click", () => onIconTap(key));
    header.appendChild(btn);
  });
  root.appendChild(header);

  const main = document.createElement("div");
  main.className = "scene-main";

  // 所持品バーも矢印と同じく、背景画像の上に重ねる透明なオーバーレイにする。
  const inv = document.createElement("div");
  inv.className = "inventory-bar";
  if (state.inventory.length === 0) {
    const empty = document.createElement("span");
    empty.className = "inventory-empty";
    empty.textContent = "（所持品なし）";
    inv.appendChild(empty);
  }
  state.inventory.forEach((itemId) => {
    const item = data.itemsById[itemId];
    const btn = document.createElement("button");
    btn.className = "inventory-item" + (ctx.selectedItemId === itemId ? " selected" : "");
    btn.textContent = item ? item.name : itemId;
    btn.addEventListener("click", () => onItemTap(itemId));
    inv.appendChild(btn);
  });
  main.appendChild(inv);

  const background = resolveBackground(view, state, ctx);

  const sceneLabel = document.createElement("div");
  sceneLabel.className = "scene-label";
  sceneLabel.textContent = view ? `[${view.label}]${background ? "" : "（背景仮）"}` : "";

  if (background) {
    const bgImg = createImageLayer("scene-bg-img", background, () => {
      sceneLabel.textContent = `[${view.label}]（背景画像の読み込みに失敗しました）`;
    });
    main.appendChild(bgImg);
  }
  main.appendChild(sceneLabel);

  // 電気スイッチ等、部屋の色を変えるフラグが立っている場合の色オーバーレイ。
  // 対応する差分画像を用意していないビュー向けの、画像に頼らない表現方法。
  if (view && view.tintFlag && state.flags[view.tintFlag]) {
    const tint = document.createElement("div");
    tint.className = "scene-tint scene-tint--red";
    main.appendChild(tint);
  }

  // 座標(position)が指定されているspotは画像上にホットスポットとして配置し、
  // 指定が無いspotはこれまで通り下に縦一覧で表示する（両方混在してもよい＝
  // 一部のspotだけ先に座標合わせをする、という進め方が可能）。
  const spotList = document.createElement("div");
  spotList.className = "spot-list";
  (view ? view.spots : []).forEach((spotId) => {
    const spot = data.spotsById[spotId];
    if (!spot) return;
    // 今の状態でどのルールにもマッチしない（＝何も起きない）spotは選択肢として出さない
    if (!hasMatchingRule(spot, state, ctx)) return;

    const btn = document.createElement("button");
    btn.addEventListener("click", () => onSpotTap(spotId));

    if (spot.position) {
      btn.className = "spot-hotspot" + (DEBUG_SHOW_HOTSPOT_LABELS ? " spot-hotspot--debug" : "");
      btn.style.left = `${spot.position.x}%`;
      btn.style.top = `${spot.position.y}%`;
      btn.style.width = `${spot.position.width}%`;
      btn.style.height = `${spot.position.height}%`;
      if (DEBUG_SHOW_HOTSPOT_LABELS) btn.textContent = spot.label;
      main.appendChild(btn);
    } else {
      btn.className = "spot-btn";
      btn.textContent = spot.label;
      spotList.appendChild(btn);
    }
  });
  // 矢印は背景画像の上に重ねる透明ボタンとして配置する（scene-mainの子＝画像が
  // 透けて見える）。scene-main配下に置くので、座標メモ用リスナーより後で追加する
  // 必要はないが、判定対象から除外されるよう先にsceneLabel/mainのみを見ている
  // 座標メモ用リスナー（下記）はe.targetで絞り込んでいるため影響しない。
  const arrowsRow = document.createElement("div");
  arrowsRow.className = "arrows-row";
  const arrows = getArrowsForView(data.transitions, data.viewsById, state.currentView, state);
  arrows.forEach((t) => {
    const btn = document.createElement("button");
    btn.className = "arrow-btn";
    btn.textContent = ARROW_SYMBOL[t.direction] || t.direction;
    btn.addEventListener("click", () => onArrowTap(t.target));
    arrowsRow.appendChild(btn);
  });
  main.appendChild(arrowsRow);

  main.appendChild(spotList);
  root.appendChild(main);

  // 座標合わせ用の補助機能: 背景の上をタップした場所の%座標をコンソールに出す。
  // spots.json の position を決めるときの参考値として使う（本番機能ではない）。
  main.addEventListener("click", (e) => {
    if (e.target !== main && e.target !== sceneLabel) return;
    const rect = main.getBoundingClientRect();
    const xPct = (((e.clientX - rect.left) / rect.width) * 100).toFixed(1);
    const yPct = (((e.clientY - rect.top) / rect.height) * 100).toFixed(1);
    console.log(`[座標メモ] x: ${xPct}%, y: ${yPct}%`);
  });

  const footer = document.createElement("div");
  footer.className = "footer-row";
  const face = document.createElement("button");
  face.className = "face-box";
  face.textContent = "表情\n(TBD)";
  face.addEventListener("click", () => onFaceTap && onFaceTap());
  footer.appendChild(face);
  const msg = document.createElement("div");
  msg.className = "footer-message";
  msg.id = "footer-message";
  msg.textContent = currentMessage || "";
  footer.appendChild(msg);
  root.appendChild(footer);
}

export function renderStory(root, line) {
  root.innerHTML = "";

  const header = document.createElement("div");
  header.className = "header-icons story-header";
  const btn = document.createElement("button");
  btn.className = "icon-btn";
  btn.textContent = "設定";
  header.appendChild(btn);
  root.appendChild(header);

  const main = document.createElement("div");
  main.className = "scene-main story-main";

  const bgLabel = document.createElement("div");
  bgLabel.className = "scene-label";
  bgLabel.textContent = line && line.bg ? `[BG]${line.bgImage ? "" : "（背景仮）"}${line.bg}` : "";

  if (line && line.bgImage) {
    const bgImg = createImageLayer("scene-bg-img", line.bgImage, () => {
      bgLabel.textContent = `[BG]（背景画像の読み込みに失敗しました）${line.bg || ""}`;
    });
    main.appendChild(bgImg);
  }
  main.appendChild(bgLabel);

  if (line && line.speaker) {
    if (line.portraitImage) {
      const img = createImageLayer("portrait-img", line.portraitImage, () => {
        img.replaceWith(createPortraitPlaceholder(line.speaker));
      });
      img.alt = line.speaker;
      main.appendChild(img);
    } else {
      main.appendChild(createPortraitPlaceholder(line.speaker));
    }
  }
  root.appendChild(main);

  const footer = document.createElement("div");
  footer.className = "footer-message story-footer";
  footer.id = "footer-message";
  if (line) {
    if (line.speaker) {
      const speakerEl = document.createElement("div");
      speakerEl.className = "speaker-name";
      speakerEl.textContent = line.speaker;
      footer.appendChild(speakerEl);
    }
    const textEl = document.createElement("div");
    textEl.textContent = line.text || "";
    footer.appendChild(textEl);
  }
  root.appendChild(footer);
}

export function renderModalWrap(root) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  overlay.appendChild(box);
  root.appendChild(overlay);
  return { overlay, box };
}
