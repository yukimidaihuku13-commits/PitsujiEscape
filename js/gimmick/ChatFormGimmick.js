// ChatFormGimmick.js
// チャット画面ギミック(gimmickPcGame)用。
// 1. 番地の数値を欄ごとに入力する
// 2. 「添付」を押すと数値が検証される。間違っていれば数値をクリアしてやり直し
// 3. 数値が正しければ、所持品から添付するアイテムを選ぶ
// 4. 「送信」を押すとアイテムが検証される。間違っていれば添付をやり直し
// 5. 両方正しければ成功として扱う
//
// 実画像(チャット画面イラスト)は未用意のため、フィールドをテキストベースで表示する
// (Gimmick.csv「画像:未」に対応した仮実装)。

const DEBUG_SHOW_ANSWER = true;

export function renderChatFormGimmick(container, gimmickDef, context, onResult) {
  const values = gimmickDef.numberFields.map(() => "");
  let focused = 0;
  let stage = "numbers"; // "numbers" | "attach"
  let attachedItemId = null;
  let status = "";

  function draw() {
    container.innerHTML = "";

    const title = document.createElement("div");
    title.className = "gimmick-title";
    title.textContent = gimmickDef.label || "チャット画面";
    container.appendChild(title);

    const note = document.createElement("div");
    note.className = "gimmick-image-placeholder gimmick-chat-note";
    note.textContent = "（チャット画面 仮）";
    container.appendChild(note);

    const fieldsRow = document.createElement("div");
    fieldsRow.className = "gimmick-chat-fields";
    gimmickDef.numberFields.forEach((field, i) => {
      const box = document.createElement("button");
      box.type = "button";
      box.className = "gimmick-chat-field" + (stage === "numbers" && focused === i ? " gimmick-chat-field--focused" : "");
      box.disabled = stage !== "numbers";
      const label = document.createElement("div");
      label.className = "gimmick-chat-field-label";
      label.textContent = field.label;
      box.appendChild(label);
      const value = document.createElement("div");
      value.className = "gimmick-chat-field-value";
      value.textContent = values[i].padEnd(field.digits, "_").split("").join(" ");
      box.appendChild(value);
      box.addEventListener("click", () => {
        focused = i;
        draw();
      });
      fieldsRow.appendChild(box);
    });
    container.appendChild(fieldsRow);

    if (stage === "numbers") {
      const pad = document.createElement("div");
      pad.className = "gimmick-numpad";
      for (let n = 0; n <= 9; n++) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "gimmick-key";
        btn.textContent = String(n);
        btn.addEventListener("click", () => {
          const digits = gimmickDef.numberFields[focused].digits;
          if (values[focused].length < digits) {
            values[focused] += String(n);
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
        values[focused] = "";
        draw();
      });
      controls.appendChild(clearBtn);

      const attachBtn = document.createElement("button");
      attachBtn.type = "button";
      attachBtn.textContent = "添付へ進む";
      attachBtn.disabled = values.some((v, i) => v.length !== gimmickDef.numberFields[i].digits);
      attachBtn.addEventListener("click", () => {
        const allCorrect = values.every((v, i) => v === gimmickDef.numberFields[i].answer);
        if (allCorrect) {
          status = "";
          stage = "attach";
        } else {
          status = gimmickDef.wrongNumberMessage || "住所が間違えているみたいだ";
          values.fill("");
          focused = 0;
        }
        draw();
      });
      controls.appendChild(attachBtn);

      container.appendChild(controls);
    } else {
      const attachLabel = document.createElement("div");
      attachLabel.className = "gimmick-status";
      attachLabel.textContent = attachedItemId
        ? `添付: ${context.itemsById[attachedItemId]?.name || attachedItemId}`
        : "添付するアイテムを所持品から選んでください";
      container.appendChild(attachLabel);

      const itemRow = document.createElement("div");
      itemRow.className = "gimmick-chat-items";
      if (context.inventory.length === 0) {
        const empty = document.createElement("div");
        empty.className = "gimmick-status";
        empty.textContent = "（所持品がありません）";
        itemRow.appendChild(empty);
      }
      context.inventory.forEach((itemId) => {
        const item = context.itemsById[itemId];
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "inventory-item" + (attachedItemId === itemId ? " selected" : "");
        btn.textContent = item ? item.name : itemId;
        btn.addEventListener("click", () => {
          attachedItemId = itemId;
          draw();
        });
        itemRow.appendChild(btn);
      });
      container.appendChild(itemRow);

      const controls = document.createElement("div");
      controls.className = "gimmick-controls";

      const backBtn = document.createElement("button");
      backBtn.type = "button";
      backBtn.textContent = "番地入力に戻る";
      backBtn.addEventListener("click", () => {
        stage = "numbers";
        status = "";
        draw();
      });
      controls.appendChild(backBtn);

      const sendBtn = document.createElement("button");
      sendBtn.type = "button";
      sendBtn.textContent = "送信";
      sendBtn.disabled = !attachedItemId;
      sendBtn.addEventListener("click", () => {
        if (attachedItemId === gimmickDef.requiredItem) {
          onResult(true);
        } else {
          status = gimmickDef.wrongItemMessage || "添付するアイテムが間違えているみたいだ";
          attachedItemId = null;
          draw();
        }
      });
      controls.appendChild(sendBtn);

      container.appendChild(controls);
    }

    if (status) {
      const statusEl = document.createElement("div");
      statusEl.className = "gimmick-status";
      statusEl.textContent = status;
      container.appendChild(statusEl);
    }

    if (DEBUG_SHOW_ANSWER) {
      const debugAnswer = document.createElement("div");
      debugAnswer.className = "gimmick-debug-answer";
      const nums = gimmickDef.numberFields.map((f) => f.answer).join(", ");
      const itemName = context.itemsById[gimmickDef.requiredItem]?.name || gimmickDef.requiredItem;
      debugAnswer.textContent = `[DEBUG] 正解: ${nums} / 添付: ${itemName}`;
      container.appendChild(debugAnswer);
    }
  }

  draw();
}
