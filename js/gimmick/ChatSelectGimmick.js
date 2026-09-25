// ChatSelectGimmick.js
// ゲーム画面(チャット)ギミック(gimmickPcGame)用。gimmick.txt「チャット画面」の解除方法に対応。
// 1. ゲームのフレンド一覧から、送り先(ぴぐま)を選ぶ
// 2. 地図画像を見ながら、文章の穴埋め[A][B]を候補から選ぶ
//    A・Bが両方埋まった時点で答え合わせをし、間違い/正解のメッセージを出す
// 3. 証拠写真(カメラでパソコンに転送された、ぴつじの写真)を添付する
// 4. 送信ボタンを押す（A・Bが正解で、写真を添付している時のみ押せる）
// キーボード入力は使用しない。

const DEBUG_SHOW_ANSWER = true;

export function renderChatSelectGimmick(container, gimmickDef, onResult) {
  let stage = "friends"; // "friends" | "chat"
  const values = {}; // { A: "サーカステント", ... }
  let focusedKey = gimmickDef.blanks[0]?.key || null;
  let attached = false;
  let status = "";
  let statusOk = false;

  const allFilled = () => gimmickDef.blanks.every((b) => values[b.key]);
  const allCorrect = () => gimmickDef.blanks.every((b) => values[b.key] === b.answer);

  function draw() {
    container.innerHTML = "";

    const title = document.createElement("div");
    title.className = "gimmick-title";
    title.textContent = gimmickDef.label || "ゲーム画面";
    container.appendChild(title);

    if (stage === "friends") drawFriends();
    else drawChat();

    if (status) {
      const statusEl = document.createElement("div");
      statusEl.className = "gimmick-status" + (statusOk ? " gimmick-status--ok" : "");
      statusEl.textContent = status;
      container.appendChild(statusEl);
    }

    if (DEBUG_SHOW_ANSWER) {
      const debugAnswer = document.createElement("div");
      debugAnswer.className = "gimmick-debug-answer";
      debugAnswer.textContent = `[DEBUG] 正解: ${gimmickDef.blanks.map((b) => `${b.key}.${b.answer}`).join(" / ")} ＋写真添付`;
      container.appendChild(debugAnswer);
    }
  }

  function drawFriends() {
    const note = document.createElement("div");
    note.className = "gimmick-chat-note";
    note.textContent = "メッセージを送る相手を選ぶ";
    container.appendChild(note);

    const row = document.createElement("div");
    row.className = "gimmick-chat-items";
    const friendBtn = document.createElement("button");
    friendBtn.type = "button";
    friendBtn.className = "inventory-item";
    friendBtn.textContent = gimmickDef.friendLabel || "ぴぐま";
    friendBtn.addEventListener("click", () => {
      stage = "chat";
      draw();
    });
    row.appendChild(friendBtn);
    container.appendChild(row);
  }

  function drawChat() {
    const wrap = document.createElement("div");
    wrap.className = "gimmick-image-wrap";
    if (gimmickDef.image) {
      const img = document.createElement("img");
      img.className = "gimmick-image gimmick-chat-map";
      img.src = gimmickDef.image;
      img.alt = "地図";
      img.addEventListener("error", () => img.classList.add("gimmick-image--error"));
      wrap.appendChild(img);
    }
    container.appendChild(wrap);

    // 文章。{A}{B}の部分は選択中の文字列(未選択なら[ A ])のボタンにする。
    const chat = document.createElement("div");
    chat.className = "gimmick-chat-lines";
    gimmickDef.lines.forEach((line) => {
      const lineEl = document.createElement("div");
      line.split(/(\{[A-Za-z]+\})/).forEach((part) => {
        const m = part.match(/^\{([A-Za-z]+)\}$/);
        if (!m) {
          lineEl.appendChild(document.createTextNode(part));
          return;
        }
        const key = m[1];
        const blankBtn = document.createElement("button");
        blankBtn.type = "button";
        blankBtn.className = "gimmick-chat-blank" + (focusedKey === key ? " gimmick-chat-blank--focused" : "");
        blankBtn.textContent = values[key] ? `${key}:${values[key]}` : `[ ${key} ]`;
        blankBtn.addEventListener("click", () => {
          focusedKey = key;
          draw();
        });
        lineEl.appendChild(blankBtn);
      });
      chat.appendChild(lineEl);
    });
    if (attached) {
      const attachEl = document.createElement("div");
      attachEl.className = "gimmick-chat-attached";
      attachEl.textContent = `📎 ${gimmickDef.attachLabel || "写真"}`;
      chat.appendChild(attachEl);
    }
    container.appendChild(chat);

    // 選択中の穴埋めに入れる候補
    if (focusedKey) {
      const optLabel = document.createElement("div");
      optLabel.className = "gimmick-chat-note";
      optLabel.textContent = `[ ${focusedKey} ] に入る言葉を選ぶ`;
      container.appendChild(optLabel);
      const opts = document.createElement("div");
      opts.className = "gimmick-chat-items";
      gimmickDef.options.forEach((opt) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "inventory-item" + (values[focusedKey] === opt ? " selected" : "");
        btn.textContent = opt;
        btn.addEventListener("click", () => selectOption(opt));
        opts.appendChild(btn);
      });
      container.appendChild(opts);
    }

    const controls = document.createElement("div");
    controls.className = "gimmick-controls";

    const attachBtn = document.createElement("button");
    attachBtn.type = "button";
    attachBtn.textContent = attached ? "添付を外す" : "写真を添付";
    attachBtn.addEventListener("click", () => {
      attached = !attached;
      draw();
    });
    controls.appendChild(attachBtn);

    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.textContent = "送信";
    sendBtn.disabled = !(allCorrect() && attached);
    sendBtn.addEventListener("click", () => onResult(true));
    controls.appendChild(sendBtn);

    container.appendChild(controls);
  }

  function selectOption(opt) {
    values[focusedKey] = opt;
    // 次の未入力の穴埋めへ移る（全部埋まっていればそのまま）
    const next = gimmickDef.blanks.find((b) => !values[b.key]);
    if (next) focusedKey = next.key;
    statusOk = allFilled() && allCorrect();
    if (allFilled()) {
      status = allCorrect()
        ? (gimmickDef.correctMessages || []).join("\n")
        : gimmickDef.wrongMessage || "";
    } else {
      status = "";
    }
    draw();
  }

  draw();
}
