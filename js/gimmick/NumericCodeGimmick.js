// NumericCodeGimmick.js
// タップのみで完結する数字コード入力ギミック（キーボード入力は使用しない）。
// 入力方式は「半角数字のみ・完全一致判定」で確定（0章-3のご回答に基づく）。
//
// gimmickDef.image + gimmickDef.keypad が指定されている場合は、実際のギミック画像の上に
// 数字ホットスポットを重ねて表示する（Renderer.jsのspot-hotspotと同じ「矩形に軽く色を
// つけて文字を表示」という方針）。指定が無い場合は従来の汎用テンキーにフォールバックする。

// 正解をデバッグ表示するかどうか。リリース前にfalseにする（or この行ごと削除する）と
// デバッグ用の正解表示だけが消える（Renderer.jsのDEBUG_SHOW_HOTSPOT_LABELSと同じ方針）。
const DEBUG_SHOW_ANSWER = true;

export function renderNumericCodeGimmick(container, gimmickDef, onResult) {
  let input = "";

  function appendDigit(digit) {
    if (input.length < gimmickDef.digits) {
      input += digit;
      draw();
    }
  }

  function drawImageKeypad(parent) {
    const wrap = document.createElement("div");
    wrap.className = "gimmick-image-wrap";

    const img = document.createElement("img");
    img.className = "gimmick-image";
    img.src = gimmickDef.image;
    img.alt = gimmickDef.label || "";
    img.addEventListener("error", () => {
      img.classList.add("gimmick-image--error");
    });
    wrap.appendChild(img);

    gimmickDef.keypad.forEach(({ digit, position }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gimmick-key-hotspot";
      btn.style.left = `${position.x}%`;
      btn.style.top = `${position.y}%`;
      btn.style.width = `${position.width}%`;
      btn.style.height = `${position.height}%`;
      btn.textContent = digit;
      btn.addEventListener("click", () => appendDigit(digit));
      wrap.appendChild(btn);
    });

    parent.appendChild(wrap);
  }

  function drawGenericNumpad(parent) {
    const pad = document.createElement("div");
    pad.className = "gimmick-numpad";
    for (let n = 0; n <= 9; n++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gimmick-key";
      btn.textContent = String(n);
      btn.addEventListener("click", () => appendDigit(String(n)));
      pad.appendChild(btn);
    }
    parent.appendChild(pad);
  }

  function draw() {
    container.innerHTML = "";

    const title = document.createElement("div");
    title.className = "gimmick-title";
    title.textContent = gimmickDef.label || "暗証番号を入力";
    container.appendChild(title);

    const display = document.createElement("div");
    display.className = "gimmick-display";
    display.textContent = input.padEnd(gimmickDef.digits, "_").split("").join(" ");
    container.appendChild(display);

    if (gimmickDef.image && gimmickDef.keypad) {
      drawImageKeypad(container);
    } else {
      drawGenericNumpad(container);
    }

    const controls = document.createElement("div");
    controls.className = "gimmick-controls";

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "クリア";
    clearBtn.addEventListener("click", () => {
      input = "";
      draw();
    });
    controls.appendChild(clearBtn);

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.textContent = "決定";
    submitBtn.disabled = input.length !== gimmickDef.digits;
    submitBtn.addEventListener("click", () => {
      const correct = input === gimmickDef.answer;
      onResult(correct);
      input = "";
      draw();
    });
    controls.appendChild(submitBtn);

    container.appendChild(controls);

    if (DEBUG_SHOW_ANSWER) {
      const debugAnswer = document.createElement("div");
      debugAnswer.className = "gimmick-debug-answer";
      debugAnswer.textContent = `[DEBUG] 正解: ${gimmickDef.answer}`;
      container.appendChild(debugAnswer);
    }
  }

  draw();
}
