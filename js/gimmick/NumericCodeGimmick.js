// NumericCodeGimmick.js
// タップのみで完結する数字コード入力ギミック（キーボード入力は使用しない）。
// 入力方式は「半角数字のみ・完全一致判定」で確定（0章-3のご回答に基づく）。

export function renderNumericCodeGimmick(container, gimmickDef, onResult) {
  let input = "";

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

    const pad = document.createElement("div");
    pad.className = "gimmick-numpad";
    for (let n = 0; n <= 9; n++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gimmick-key";
      btn.textContent = String(n);
      btn.addEventListener("click", () => {
        if (input.length < gimmickDef.digits) {
          input += String(n);
          draw();
        }
      });
      pad.appendChild(btn);
    }
    container.appendChild(pad);

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
  }

  draw();
}
