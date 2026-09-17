// Renderer.js
// GameStateを「読むだけ」で画面を再構築する。ここでは状態を変更しない。
// 背景・アイテム画像等の実アセットは未確定のため、第一試作では
// ラベルテキスト＋プレースホルダー矩形で表現する。

import { getArrowsForView } from "../nav/Navigator.js";
import { hasMatchingRule } from "../engine/RuleResolver.js";

const ARROW_SYMBOL = { up: "▲", down: "▼", left: "◀", right: "▶" };

// position指定ホットスポットの座標合わせデバッグ表示（枠線＋ラベル文字）。
// リリース前にfalseにする（or この分岐ごと削除する）とデバッグ表示だけ消える。
const DEBUG_SHOW_HOTSPOT_LABELS = true;

export function renderStart(root, onStart) {
  root.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "start-screen";
  wrap.textContent = "ぴつじ脱出ゲーム\n（タップしてスタート）";
  wrap.addEventListener("click", onStart);
  root.appendChild(wrap);
}

export function renderPlay(root, opts) {
  const { state, ctx, data, currentMessage, onSpotTap, onArrowTap, onItemTap, onIconTap } = opts;
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
  root.appendChild(inv);

  const main = document.createElement("div");
  main.className = "scene-main";
  if (view && view.background) {
    main.style.backgroundImage = `url("${view.background}")`;
    main.style.backgroundSize = "cover";
    main.style.backgroundPosition = "center";
    main.style.backgroundColor = "transparent";
  } else {
    main.style.backgroundImage = "none";
    main.style.backgroundColor = "";
  }
  const sceneLabel = document.createElement("div");
  sceneLabel.className = "scene-label";
  sceneLabel.textContent = view ? `[${view.label}]${view.background ? "" : "（背景仮）"}` : "";
  main.appendChild(sceneLabel);

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
  root.appendChild(arrowsRow);

  const footer = document.createElement("div");
  footer.className = "footer-row";
  const face = document.createElement("div");
  face.className = "face-box";
  face.textContent = "表情\n(TBD)";
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
  if (line && line.bgImage) {
    main.style.backgroundImage = `url("${line.bgImage}")`;
    main.style.backgroundSize = "cover";
    main.style.backgroundPosition = "center";
  } else {
    main.style.backgroundImage = "none";
  }
  const bgLabel = document.createElement("div");
  bgLabel.className = "scene-label";
  bgLabel.textContent = line && line.bg ? `[BG]${line.bgImage ? "" : "（背景仮）"}${line.bg}` : "";
  main.appendChild(bgLabel);

  if (line && line.speaker) {
    if (line.portraitImage) {
      const img = document.createElement("img");
      img.className = "portrait-img";
      img.src = line.portraitImage;
      img.alt = line.speaker;
      main.appendChild(img);
    } else {
      const portrait = document.createElement("div");
      portrait.className = "portrait-box";
      portrait.textContent = `${line.speaker}\n(立ち絵仮)`;
      main.appendChild(portrait);
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
