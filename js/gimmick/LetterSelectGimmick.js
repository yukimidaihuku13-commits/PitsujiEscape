// LetterSelectGimmick.js
// 玄関ドアの電子錠(gimmickLockEntrance)用。各行の文字盤から1文字ずつ選び、
// 上から順につなげた文字列が答えと一致するか判定する（NumericCodeGimmick.jsと
// 同じ「画像＋座標指定ホットスポット」方式）。

// 正解をデバッグ表示するかどうか。リリース前にfalseにする（or この行ごと削除する）と
// デバッグ用の正解表示だけが消える（NumericCodeGimmick.jsと同じ方針）。
const DEBUG_SHOW_ANSWER = true;

export function renderLetterSelectGimmick(container, gimmickDef, onResult) {
  // 行ごとに選択中インデックス(未選択はnull)を保持する。
  const selected = gimmickDef.rows.map(() => null);

  function currentCode() {
    return selected.map((i, rowIdx) => (i === null ? null : gimmickDef.rows[rowIdx].letters[i].char));
  }

  function draw() {
    container.innerHTML = "";

    const title = document.createElement("div");
    title.className = "gimmick-title";
    title.textContent = gimmickDef.label || "文字を選択";
    container.appendChild(title);

    const wrap = document.createElement("div");
    wrap.className = "gimmick-image-wrap";

    const img = document.createElement("img");
    img.className = "gimmick-image";
    img.src = gimmickDef.image;
    img.alt = gimmickDef.label || "";
    img.addEventListener("error", () => img.classList.add("gimmick-image--error"));
    wrap.appendChild(img);

    gimmickDef.rows.forEach((row, rowIdx) => {
      row.letters.forEach((letter, letterIdx) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "gimmick-key-hotspot";
        if (selected[rowIdx] === letterIdx) btn.classList.add("gimmick-key-hotspot--selected");
        btn.style.left = `${letter.position.x}%`;
        btn.style.top = `${letter.position.y}%`;
        btn.style.width = `${letter.position.width}%`;
        btn.style.height = `${letter.position.height}%`;
        btn.textContent = letter.char;
        btn.addEventListener("click", () => {
          // 同じ文字をもう一度選ぶと選択解除。別の文字を選ぶとその行の選択を差し替える。
          selected[rowIdx] = selected[rowIdx] === letterIdx ? null : letterIdx;
          draw();
        });
        wrap.appendChild(btn);
      });

      const resultBtn = document.createElement("div");
      resultBtn.className = "gimmick-key-hotspot gimmick-key-hotspot--result";
      resultBtn.style.left = `${row.resultPosition.x}%`;
      resultBtn.style.top = `${row.resultPosition.y}%`;
      resultBtn.style.width = `${row.resultPosition.width}%`;
      resultBtn.style.height = `${row.resultPosition.height}%`;
      resultBtn.textContent = selected[rowIdx] === null ? "" : row.letters[selected[rowIdx]].char;
      wrap.appendChild(resultBtn);
    });

    container.appendChild(wrap);

    const controls = document.createElement("div");
    controls.className = "gimmick-controls";

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "クリア";
    clearBtn.addEventListener("click", () => {
      selected.fill(null);
      draw();
    });
    controls.appendChild(clearBtn);

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.textContent = "決定";
    submitBtn.disabled = selected.some((i) => i === null);
    submitBtn.addEventListener("click", () => {
      const code = currentCode().join("");
      onResult(code === gimmickDef.answer);
      selected.fill(null);
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
