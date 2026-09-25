// TapRegionsGimmick.js
// 写真ギミック(gimmickPhoto)用。画像上の正解範囲を全てタップすると解除できる。
// ・正解位置は一度見つけたら選択解除されない(gimmick.txt仕様)
// ・正解以外をタップした場合は一時的なメッセージを出す
// ・実画像(gimmick_Photo等)が未用意の間は、プレースホルダー矩形の上に
//   ラベル付きホットスポットを重ねて表示する。

const DEBUG_SHOW_ANSWER = true;

export function renderTapRegionsGimmick(container, gimmickDef, onResult) {
  const found = new Set();
  let missMessage = "";

  function draw() {
    container.innerHTML = "";

    const title = document.createElement("div");
    title.className = "gimmick-title";
    title.textContent = gimmickDef.label || "写真から探す";
    container.appendChild(title);

    const wrap = document.createElement("div");
    wrap.className = "gimmick-image-wrap";

    if (gimmickDef.image) {
      const img = document.createElement("img");
      img.className = "gimmick-image";
      img.src = gimmickDef.image;
      img.alt = gimmickDef.label || "";
      img.addEventListener("error", () => img.classList.add("gimmick-image--error"));
      wrap.appendChild(img);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "gimmick-image gimmick-image-placeholder";
      placeholder.textContent = "（写真画像 仮）";
      wrap.appendChild(placeholder);
    }

    gimmickDef.regions.forEach((region) => {
      const isFound = found.has(region.key);
      const btn = document.createElement("button");
      btn.type = "button";
      // 実画像がある場合、見つける前の正解範囲は見えないようにする（デバッグ表示中は枠を出す）。
      // 見つけた正解範囲は〇で囲む（gimmick.txt。〇の画像が用意されたら差し替え）。
      const hidden = !isFound && gimmickDef.image && !DEBUG_SHOW_ANSWER;
      btn.className = "gimmick-key-hotspot" + (isFound ? " gimmick-key-hotspot--selected gimmick-key-hotspot--circle" : "") + (hidden ? " gimmick-key-hotspot--hidden" : "");
      btn.style.left = `${region.position.x}%`;
      btn.style.top = `${region.position.y}%`;
      btn.style.width = `${region.position.width}%`;
      btn.style.height = `${region.position.height}%`;
      // 実画像がある場合は絵が隠れないよう文字を出さない（デバッグ表示中のみ見つけた物の名前を出す）
      if (!gimmickDef.image) btn.textContent = isFound ? region.label : "?";
      else btn.textContent = isFound && DEBUG_SHOW_ANSWER ? region.label : "";
      btn.addEventListener("click", () => {
        // 正解位置は再タップしても選択解除されない(gimmick.txt仕様)。
        if (!isFound) found.add(region.key);
        missMessage = "";
        draw();
      });
      wrap.appendChild(btn);
    });

    // 正解範囲以外のタップ = ホットスポットが無い場所へのタップとして、
    // 画像全体にクリックリスナーを張り、規定のホットスポット以外を拾う。
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap || (gimmickDef.image ? e.target.classList.contains("gimmick-image") : e.target.classList.contains("gimmick-image-placeholder"))) {
        missMessage = gimmickDef.missMessage || "ここではないようだ";
        draw();
      }
    });

    container.appendChild(wrap);

    if (missMessage) {
      const miss = document.createElement("div");
      miss.className = "gimmick-status";
      miss.textContent = missMessage;
      container.appendChild(miss);
    }

    const controls = document.createElement("div");
    controls.className = "gimmick-controls";

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.textContent = "決定";
    submitBtn.disabled = found.size < gimmickDef.regions.length;
    submitBtn.addEventListener("click", () => {
      onResult(true);
    });
    controls.appendChild(submitBtn);

    container.appendChild(controls);

    if (DEBUG_SHOW_ANSWER) {
      const debugAnswer = document.createElement("div");
      debugAnswer.className = "gimmick-debug-answer";
      debugAnswer.textContent = `[DEBUG] 正解位置: ${gimmickDef.regions.map((r) => r.label).join(" / ")}`;
      container.appendChild(debugAnswer);
    }
  }

  draw();
}
