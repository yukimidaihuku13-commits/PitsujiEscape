// PhoneDialGimmick.js
// 電話ギミック(gimmickPhone)用。gimmick.txt「電話ギミック」の解除方法に対応。
// 電話画像の上のボタン(0〜9・#・*)をタップして番号を入力し、受話器ボタンで発信する。
// 発信した番号が正解なら成功、それ以外は失敗として onResult(false, 入力番号) を返す
// （特定の番号だけ別の失敗メッセージを出す処理は gimmicks.json の failCases 側で行う）。
// 発信後は入力をクリアする。キーボード入力は使用しない。

const DEBUG_SHOW_ANSWER = true;

export function renderPhoneDialGimmick(container, gimmickDef, onResult) {
  let input = "";
  const maxLength = gimmickDef.maxLength || 12;

  function setPos(el, position) {
    el.style.left = `${position.x}%`;
    el.style.top = `${position.y}%`;
    el.style.width = `${position.width}%`;
    el.style.height = `${position.height}%`;
  }

  function draw() {
    container.innerHTML = "";

    const title = document.createElement("div");
    title.className = "gimmick-title";
    title.textContent = gimmickDef.label || "電話";
    container.appendChild(title);

    const wrap = document.createElement("div");
    wrap.className = "gimmick-image-wrap";

    const img = document.createElement("img");
    img.className = "gimmick-image";
    img.src = gimmickDef.image;
    img.alt = gimmickDef.label || "";
    img.addEventListener("error", () => img.classList.add("gimmick-image--error"));
    wrap.appendChild(img);

    // 画像上部の表示窓に入力中の番号を出す
    const display = document.createElement("div");
    display.className = "gimmick-key-hotspot gimmick-key-hotspot--result gimmick-phone-display";
    setPos(display, gimmickDef.displayPosition);
    display.textContent = input;
    wrap.appendChild(display);

    gimmickDef.keypad.forEach(({ key, position }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gimmick-key-hotspot";
      setPos(btn, position);
      btn.textContent = key;
      btn.addEventListener("click", () => {
        if (input.length < maxLength) {
          input += key;
          draw();
        }
      });
      wrap.appendChild(btn);
    });

    const callBtn = document.createElement("button");
    callBtn.type = "button";
    callBtn.className = "gimmick-key-hotspot";
    setPos(callBtn, gimmickDef.callPosition);
    callBtn.textContent = "発信";
    callBtn.disabled = input.length === 0;
    callBtn.addEventListener("click", () => {
      const dialed = input;
      input = "";
      draw();
      onResult(dialed === gimmickDef.answer, dialed);
    });
    wrap.appendChild(callBtn);

    container.appendChild(wrap);

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
