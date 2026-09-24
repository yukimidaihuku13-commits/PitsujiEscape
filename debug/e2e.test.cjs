// e2e.test.cjs
// 実際のブラウザ(Chrome)でゲームを操作するデバッグ用テスト。
//   前提: このフォルダをローカルサーバーで配信していること
//         playwright-core がインストールされていること（npm i playwright-core）
//   実行: BASE_URL=<配信しているURL> node debug/e2e.test.cjs
//         （一部だけ実行する場合: TEST_IDS=S-01,S-02 を併せて指定）
// スクリーンショットは debug/screenshots/ に保存する。
// サーバーのURL・ポート番号はソースに埋め込まない方針のため、環境変数 BASE_URL で必ず指定する。

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright-core");

const BASE = process.env.BASE_URL;
if (!BASE) {
  console.error("環境変数 BASE_URL に、ゲームを配信しているURLを指定してください（例: BASE_URL=<URL> node debug/e2e.test.cjs）");
  process.exit(1);
}
const SAVE_KEY = "pitsujiEscapeGame_save";
const SHOT_DIR = path.join(__dirname, "screenshots");
fs.mkdirSync(SHOT_DIR, { recursive: true });

const WAIT = 320; // 画面切替直後のタップガード(250ms)より長く待つ

function baseState(over = {}) {
  return Object.assign({
    saveVersion: 3, phase: "play", playPart: 2, storyPart: null, currentView: "viewDesk",
    inventory: [], everObtainedItems: [], itemUsageLog: {}, flags: {}, clickCounts: {},
    bgmState: { unlockedTracks: ["default"], currentTrack: "default" }, hintRevealCounts: {}, notePage: 0
  }, over);
}

// ---- ページ操作ヘルパー ----
function helpers(page) {
  const h = {
    async load(state) {
      await page.goto(BASE);
      await page.evaluate(([k, s]) => { localStorage.clear(); if (s) localStorage.setItem(k, JSON.stringify(s)); }, [SAVE_KEY, state || null]);
      await page.reload();
      await page.waitForSelector(".header-icons, .start-screen");
      await page.waitForTimeout(WAIT);
    },
    async click(locator) { await locator.click({ timeout: 3000 }); await page.waitForTimeout(WAIT); },
    spot: (label) => page.locator(".spot-hotspot, .spot-btn").filter({ hasText: new RegExp(`^${label}$`) }),
    item: (name) => page.locator(".inventory-bar .inventory-item").filter({ hasText: new RegExp(`^${name}$`) }),
    async tapSpot(label) { await h.click(h.spot(label)); },
    async tapItem(name) { await h.click(h.item(name)); },
    msg: () => page.textContent("#footer-message").then((t) => (t || "").trim()),
    // 表示中メッセージを全て読み進め、読んだ内容を返す
    async readAll(max = 15) {
      const out = [];
      for (let i = 0; i < max; i++) {
        const t = await h.msg();
        if (!t) break;
        out.push(t);
        await page.locator("#footer-message").click();
        await page.waitForTimeout(60);
      }
      return out;
    },
    inv: () => page.$$eval(".inventory-bar .inventory-item", (els) => els.map((e) => e.textContent)),
    selected: () => page.$$eval(".inventory-bar .inventory-item.selected", (els) => els.map((e) => e.textContent)),
    save: () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), SAVE_KEY),
    view: () => page.evaluate((k) => (JSON.parse(localStorage.getItem(k) || "{}").currentView), SAVE_KEY),
    modalCount: () => page.locator(".modal-overlay").count(),
    storyText: () => page.textContent(".story-footer").then((t) => (t || "").trim()),
    async arrow(sym) { await h.click(page.locator(".arrow-btn").filter({ hasText: sym })); },
    async shot(name) { await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) }); }
  };
  return h;
}

// ---- ランナー ----
const results = [];
let browser;
const ONLY = process.env.TEST_IDS ? new Set(process.env.TEST_IDS.split(",").map((x) => x.trim())) : null;
async function test(id, title, fn, ctxOpts = {}) {
  if (ONLY && !ONLY.has(id)) return;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, ...ctxOpts.context });
  if (ctxOpts.init) await context.addInitScript(ctxOpts.init);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text()) && !(ctxOpts.allowConsoleError)) errors.push("console: " + m.text()); });
  if (ctxOpts.route) await ctxOpts.route(page);
  try {
    await fn(page, helpers(page));
    if (errors.length) throw new Error("JSエラー: " + errors.join(" | "));
    results.push({ id, title, ok: true });
  } catch (e) {
    results.push({ id, title, ok: false, err: e.message.split("\n")[0] });
    try { await page.screenshot({ path: path.join(SHOT_DIR, `NG_${id}.png`) }); } catch {}
  }
  await context.close();
}
function eq(a, b, label = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${label} 期待値: ${y} / 実際: ${x}`); }
function ok(c, label) { if (!c) throw new Error(label); }

(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });

  // ===================== I: アイテムアイコン（修正依頼） =====================
  const itemsState = baseState({ playPart: 3, inventory: ["itemFrozenBluePaper", "itemToastedBread"], everObtainedItems: ["itemBluePaper", "itemFrozenBluePaper", "itemBread", "itemToastedBread"] });

  await test("I-01", "タップで選択（拡大表示はまだ出ない）", async (page, h) => {
    await h.load(itemsState);
    await h.tapItem("冷凍後の青い紙");
    eq(await h.selected(), ["冷凍後の青い紙"]);
    eq(await h.modalCount(), 0, "モーダル");
  });
  await test("I-02", "選択中に同じアイテム → 拡大画像＋説明文。選択は解除されない", async (page, h) => {
    await h.load(itemsState);
    await h.tapItem("冷凍後の青い紙");
    await h.tapItem("冷凍後の青い紙");
    eq(await h.modalCount(), 1, "モーダル");
    eq((await page.textContent(".item-zoom-message")).trim(), "紙に4桁の数字が書かれている「3952」");
    ok(await page.locator(".item-zoom-box .modal-image-placeholder").count() === 1, "拡大画像(代替)が無い");
    eq(await page.locator(".item-zoom-close").count(), 0, "説明文表示中に閉じるボタンが出ている");
    await h.shot("I-02_item_zoom");
    eq(await h.selected(), ["冷凍後の青い紙"], "選択が外れた");
  });
  await test("I-03", "拡大表示中: 画面タップで説明文が消えて閉じるボタン → 押すと閉じる", async (page, h) => {
    await h.load(itemsState);
    await h.tapItem("焼かれた食パン");
    await h.tapItem("焼かれた食パン");
    await page.mouse.click(30, 120); await page.waitForTimeout(WAIT);
    eq(await page.locator(".item-zoom-message").count(), 0, "説明文が残っている");
    eq(await page.locator(".item-zoom-close").count(), 1, "閉じるボタンが無い");
    await h.shot("I-03_item_zoom_close");
    await page.mouse.click(30, 120); await page.waitForTimeout(WAIT);
    eq(await h.modalCount(), 1, "閉じるボタン以外のタップで閉じた");
    await h.click(page.locator(".item-zoom-close"));
    eq(await h.modalCount(), 0, "閉じない");
    eq(await h.selected(), ["焼かれた食パン"], "閉じた後に選択が外れた");
  });
  await test("I-04", "拡大表示後、さらに同じアイテム → 選択解除", async (page, h) => {
    await h.load(itemsState);
    await h.tapItem("焼かれた食パン");
    await h.tapItem("焼かれた食パン");
    await page.mouse.click(30, 120); await page.waitForTimeout(WAIT);
    await h.click(page.locator(".item-zoom-close"));
    await h.tapItem("焼かれた食パン");
    eq(await h.selected(), []);
    eq(await h.modalCount(), 0);
  });
  await test("I-05", "選択中に別アイテム → 選択が移る（拡大はされない）。移った先を再タップで拡大", async (page, h) => {
    await h.load(itemsState);
    await h.tapItem("冷凍後の青い紙");
    await h.tapItem("焼かれた食パン");
    eq(await h.selected(), ["焼かれた食パン"]);
    eq(await h.modalCount(), 0);
    await h.tapItem("焼かれた食パン");
    eq(await h.modalCount(), 1);
    eq((await page.textContent(".item-zoom-message")).trim(), "パンにりんごの記号が焼き付いている");
  });
  await test("I-06", "拡大→別アイテム→元のアイテム: 元のアイテムは再度「選択」から始まる", async (page, h) => {
    await h.load(itemsState);
    await h.tapItem("冷凍後の青い紙"); await h.tapItem("冷凍後の青い紙");
    await page.mouse.click(30, 120); await page.waitForTimeout(WAIT);
    await h.click(page.locator(".item-zoom-close"));
    await h.tapItem("焼かれた食パン");
    await h.tapItem("冷凍後の青い紙");
    eq(await h.selected(), ["冷凍後の青い紙"]);
    eq(await h.modalCount(), 0);
  });
  await test("I-07", "絵: 部屋が赤い時と通常時で説明文が変わる", async (page, h) => {
    await h.load(baseState({ playPart: 4, currentView: "roomB2", inventory: ["itemIllust"], everObtainedItems: ["itemIllust"] }));
    await h.tapItem("絵"); await h.tapItem("絵");
    eq((await page.textContent(".item-zoom-message")).trim(), "何の変哲もない絵に見える");
    await page.mouse.click(30, 120); await page.waitForTimeout(WAIT);
    await h.click(page.locator(".item-zoom-close"));
    await h.tapItem("絵"); // 選択解除
    await h.tapSpot("電気スイッチ");
    await h.readAll();
    await h.tapItem("絵"); await h.tapItem("絵");
    ok((await page.textContent(".item-zoom-message")).includes("ESCAPE"), "赤い部屋でESCAPEが出ない");
  });
  await test("I-08", "アイテム選択中にクリックポイントで使用 → 消費され選択解除", async (page, h) => {
    await h.load(baseState({ playPart: 2, currentView: "viewPitsujiDoor", inventory: ["itemChocolate"], everObtainedItems: ["itemChocolate"] }));
    await h.tapItem("チョコレート");
    await h.tapSpot("ドア下隙間");
    eq(await h.readAll(), ["チョコレートに釣られてドアの近くに来た気配がする", "部屋に戻ってぴつじに脱出を呼びかけるっぴ！"]);
    eq(await h.inv(), []);
  });
  await test("I-09", "拡大表示を開いた直後の素早いタップでは説明文が消えない", async (page, h) => {
    await h.load(itemsState);
    await h.tapItem("焼かれた食パン");
    await h.item("焼かれた食パン").click();
    await page.mouse.click(30, 120); // 250ms以内の2打目
    eq(await page.locator(".item-zoom-message").count(), 1, "説明文を読む前に消えた");
  });

  // ===================== N: 調査ノート（修正依頼） =====================
  await test("N-01", "ノートを開くとページ1左の画像とメッセージ。タップで1右→2左→2右", async (page, h) => {
    await h.load(baseState({ playPart: 2 }));
    await h.readAll();
    await h.tapSpot("調査ノート");
    eq(await h.view(), "viewNote");
    ok((await page.textContent(".note-page")).includes("1ページ左"), "1左ではない");
    eq(await h.msg(), "ぴつじはチョコレートが好きと……");
    await h.shot("N-01_note_1left");
    const seen = [];
    for (let i = 0; i < 3; i++) { await h.click(page.locator(".note-page")); seen.push([(await page.textContent(".note-page")).split("\n")[0].trim(), await h.msg()]); }
    eq(seen, [["調査ノート 1ページ右", "ぴつじはふかふかなものが好きだったな……"], ["調査ノート 2ページ左", "ぴつじの友達を調べたページだっぴ"], ["調査ノート 2ページ右", "ぴつじの友達の調査もしたっぴ"]]);
    eq(await page.locator(".arrow-btn").count(), 0, "ノートに矢印が出ている");
    ok(await page.locator(".note-close-btn").isVisible(), "閉じるボタンが無い");
  });
  await test("N-02", "PlayPart6: 2右で何度タップしても先へ進まない", async (page, h) => {
    await h.load(baseState({ playPart: 6 }));
    await h.readAll();
    await h.tapSpot("調査ノート");
    for (let i = 0; i < 8; i++) await h.click(page.locator(".note-page"));
    ok((await page.textContent(".note-page")).includes("2ページ右"), "2右以外");
    eq(await h.inv(), []);
  });
  await test("N-03", "PlayPart7: 2右で3回タップ → 3左、写真入手。3左からは進まない", async (page, h) => {
    await h.load(baseState({ playPart: 7 }));
    await h.readAll();
    await h.tapSpot("調査ノート");
    for (let i = 0; i < 3; i++) await h.click(page.locator(".note-page"));
    await h.click(page.locator(".note-page"));
    eq(await h.msg(), "貼り付いてて次のページが中々めくれないッピ");
    await h.click(page.locator(".note-page"));
    await h.click(page.locator(".note-page"));
    eq(await h.readAll(), ["次のページがめくれたっぴ！", "ぴつじと仲間達が楽しそうにパーティーしてる写真だっぴ"]);
    ok((await page.textContent(".note-page")).includes("3ページ左"), "3左ではない");
    eq(await h.inv(), ["写真"]);
    await h.shot("N-03_note_3left");
    await h.click(page.locator(".note-page"));
    ok((await page.textContent(".note-page")).includes("3ページ左"), "3左から移動した");
    eq(await h.msg(), "ぴぐまとぴさぎはパーティーで楽器担当だっぴ");
    eq(await h.inv(), ["写真"], "写真を重複入手");
  });
  await test("N-04", "閉じるボタン → 机拡大へ戻る。再度開くとページ1左から", async (page, h) => {
    await h.load(baseState({ playPart: 3 }));
    await h.readAll();
    await h.tapSpot("調査ノート");
    await h.click(page.locator(".note-page"));
    await h.click(page.locator(".note-page"));
    await h.click(page.locator(".note-close-btn"));
    eq(await h.view(), "viewDesk");
    await h.tapSpot("調査ノート");
    ok((await page.textContent(".note-page")).includes("1ページ左"), "1左から再開しない");
  });
  await test("N-05", "ノート表示中にリロードしても表示が崩れない", async (page, h) => {
    await h.load(baseState({ playPart: 3, currentView: "viewNote", notePage: 2 }));
    ok((await page.textContent(".note-page")).includes("2ページ左"), "ページが復元されない");
    await h.click(page.locator(".note-close-btn"));
    eq(await h.view(), "viewDesk");
  });
  await test("N-06", "旧セーブ(viewNote1)から再開 → 机拡大に戻して継続", async (page, h) => {
    const s = baseState({ playPart: 3, currentView: "viewNote1" }); delete s.notePage;
    await h.load(s);
    eq((await page.textContent(".scene-label")).trim().startsWith("[机拡大]"), true);
  });
  await test("N-07", "PlayPart1ではノート・ゲーム機・下矢印が出ない", async (page, h) => {
    await h.load(baseState({ playPart: 1 }));
    eq(await h.spot("調査ノート").count(), 0);
    eq(await h.spot("ゲーム機").count(), 0);
    eq(await page.locator(".arrow-btn").count(), 0);
  });

  // ===================== M: 開始時/表情タップ時メッセージ =====================
  const startMsgs = {
    1: ["さて……"],
    2: ["なんで脱出しないッピ……？", "お腹空いてるっぴ？", "ぴつじの好きな食べ物を渡すっぴ！", "それでぴつじもやる気出すっぴ！"],
    3: ["ドアの鍵を開けるっぴ！"],
    4: ["こうなったら玄関のドアを開けてやるっぴ！！", "ヒントは確か……あっ！！！？チョコレートもヒントだったッピ！", "さっきぴつじに渡しちゃったッピ……"],
    5: ["ぴつじはすっかり落ち込んでるッピ", "元気出そうなもの渡すっぴ"],
    6: ["こうなったらぴつじに詳しい人を呼ぶっぴ！！！"],
    7: ["ぴつじの目が覚めるようなパーティーを開くっぴ！！"],
    8: ["楽しそうな音が聞こえてくるっぴ"]
  };
  await test("M-01", "各PlayPart開始時メッセージ(1〜8)", async (page, h) => {
    await h.load(null);
    for (let p = 1; p <= 8; p++) {
      await page.evaluate(() => localStorage.clear());
      await page.reload(); await page.waitForSelector(".start-debug-btn");
      await h.click(page.locator(".start-debug-btn").filter({ hasText: new RegExp(`^PlayPart${p}$`) }));
      eq(await h.readAll(), startMsgs[p], `part${p}`);
    }
  });
  await test("M-02", "表情タップ: PlayPart1/6/7 は固定文言", async (page, h) => {
    const exp = { 1: "画面をタップするっぴ", 6: "ぴつじの友達を呼び出してやるっぴ！", 7: "ぴつじの目が覚めるようなパーティーを開くっぴ！！" };
    for (const p of [1, 6, 7]) {
      await h.load(baseState({ playPart: p }));
      await h.click(page.locator(".face-box"));
      eq(await h.readAll(), [exp[p]], `part${p}`);
      await h.click(page.locator(".face-box"));
      eq(await h.readAll(), [exp[p]], `part${p} 2回目`);
    }
  });
  await test("M-03", "表情タップ: PlayPart2 チョコ入手前/入手後/使用後", async (page, h) => {
    const cases = [
      [{}, "ぴつじの好きな食べ物探すっぴ～"],
      [{ inventory: ["itemChocolate"], everObtainedItems: ["itemChocolate"] }, "ぴつじにこのチョコを渡すっぴ～"],
      [{ everObtainedItems: ["itemChocolate"], itemUsageLog: { itemChocolate: ["spotPitsujiDoorGap"] } }, "今度こそ脱出ゲームして貰うっぴ！やり直しっぴ！！"]
    ];
    for (const [over, exp] of cases) {
      await h.load(baseState({ playPart: 2, ...over }));
      await h.click(page.locator(".face-box"));
      eq(await h.readAll(), [exp]);
    }
  });
  await test("M-04", "表情タップ: PlayPart3/4 解除前は3行ループ、解除後は固定", async (page, h) => {
    const data = {
      3: [["ドアの鍵開けるっぴ～", "暗証番号忘れたッピ", "この部屋にヒントがあるはずっぴ！"], "doorBUnlocked", "今度こそ脱出ゲームして貰うっぴ！"],
      4: [["玄関の鍵開けるっぴ～", "チョコレートは無くてもどうにかなるはずっぴ", "がんばるっぴ～！"], "doorEntranceUnlocked", "ぴつじに部屋から出て貰うっぴ！！"]
    };
    for (const p of [3, 4]) {
      const [cycle, flag, after] = data[p];
      await h.load(baseState({ playPart: p }));
      const got = [];
      for (let i = 0; i < 4; i++) { await h.click(page.locator(".face-box")); got.push(...(await h.readAll())); }
      eq(got, [...cycle, cycle[0]], `part${p} ループ`);
      await h.load(baseState({ playPart: p, flags: { [flag]: true } }));
      await h.click(page.locator(".face-box"));
      eq(await h.readAll(), [after], `part${p} 解除後`);
    }
  });
  await test("M-05", "表情タップ: PlayPart5 渡す前は2行ループ(片方だけ渡してもループ)、両方渡した後も2行ループ", async (page, h) => {
    await h.load(baseState({ playPart: 5, itemUsageLog: { itemCushion: ["spotPitsujiWindow"] }, everObtainedItems: ["itemCushion"] }));
    const got = [];
    for (let i = 0; i < 3; i++) { await h.click(page.locator(".face-box")); got.push(...(await h.readAll())); }
    eq(got, ["ぴつじの元気を出すっぴ～", "ぴつじの好きな物は調査済みっぴ～！", "ぴつじの元気を出すっぴ～"]);
    await h.load(baseState({ playPart: 5, itemUsageLog: { itemCushion: ["spotPitsujiWindow"], itemLargeTowel: ["spotPitsujiWindow"] } }));
    const got2 = [];
    for (let i = 0; i < 3; i++) { await h.click(page.locator(".face-box")); got2.push(...(await h.readAll())); }
    eq(got2, ["ぴつじに呼びかけてみるっぴ！！", "そろそろいけるっぴ！！", "ぴつじに呼びかけてみるっぴ！！"]);
  });
  await test("M-06", "表情: PlayPart8はぴつじ。文言「楽しそうな音が聞こえるっぴ」／PlayPart1〜7は黒ぴぐま", async (page, h) => {
    await h.load(baseState({ playPart: 8, currentView: "roomPitsuji" }));
    ok((await page.textContent(".face-box")).startsWith("ぴつじ"), "表情がぴつじではない");
    await h.click(page.locator(".face-box"));
    eq(await h.readAll(), ["楽しそうな音が聞こえるっぴ"]);
    await h.load(baseState({ playPart: 7 }));
    ok((await page.textContent(".face-box")).startsWith("黒ぴぐま"), "表情が黒ぴぐまではない");
  });
  await test("M-07", "ヘッダーのタイトル: プロローグ(ストーリー1)までは旧タイトル、以降は新タイトル", async (page, h) => {
    await h.load(baseState({ playPart: 1 }));
    eq((await page.textContent(".header-title")).trim(), "ぴつじ脱出ゲーム", "PlayPart1");
    await h.load(baseState({ phase: "story", storyPart: 1, playPart: 1 }));
    eq((await page.textContent(".header-title")).trim(), "ぴつじ脱出ゲーム", "StoryPart1");
    await h.load(baseState({ phase: "story", storyPart: 2, playPart: 2 }));
    eq((await page.textContent(".header-title")).trim(), "ぴつじを部屋から脱出させるゲーム", "StoryPart2");
    await h.load(baseState({ playPart: 2 }));
    eq((await page.textContent(".header-title")).trim(), "ぴつじを部屋から脱出させるゲーム", "PlayPart2");
    await h.shot("M-07_header_title");
    for (const label of ["ログ", "ヒント", "設定"]) ok(await page.locator(".header-icons .icon-btn").filter({ hasText: label }).isVisible(), `${label}が見えない`);
  });
  await test("M-08", "早送り: 押すと1行ずつ自動送り、もう一度押すと停止、最後まで行くと操作パートへ進み解除", async (page, h) => {
    await h.load(null);
    await h.click(page.locator(".start-debug-btn").filter({ hasText: /^StoryPart2$/ }));
    const first = await page.textContent(".story-footer div:last-child");
    await h.click(page.locator(".ff-btn"));
    ok((await page.textContent(".ff-btn")).includes("停止"), "早送り中の表示にならない");
    await page.waitForTimeout(500);
    await page.locator(".ff-btn").click();
    await page.waitForTimeout(400);
    const stopped = await page.textContent(".story-footer div:last-child");
    ok(stopped !== first, "自動送りされていない");
    await page.waitForTimeout(500);
    eq(await page.textContent(".story-footer div:last-child"), stopped, "停止しても送られ続ける");
    await h.shot("M-08_fast_forward");
    await h.click(page.locator(".ff-btn"));
    await page.waitForTimeout(8000);
    eq((await h.save()).phase, "play", "最後まで早送りされない");
    eq((await h.save()).playPart, 3);
    eq(await h.readAll(), ["ドアの鍵を開けるっぴ！"], "早送りが操作パートのメッセージまで送ってしまった");
  });

  // ===================== S: ストーリー中の設定ボタン =====================
  await test("S-01", "ストーリー中に設定ボタンが押せる。押してもストーリーは進まない", async (page, h) => {
    await h.load(null);
    await h.click(page.locator(".start-debug-btn").filter({ hasText: /^StoryPart1$/ }));
    const before = await h.storyText();
    await h.click(page.locator(".story-header .icon-btn"));
    eq(await h.modalCount(), 1, "設定が開かない");
    ok((await page.textContent(".modal-box")).includes("設定"), "設定モーダルではない");
    await h.shot("S-01_story_settings");
    await h.click(page.locator(".modal-close-btn"));
    eq(await h.storyText(), before, "設定操作でストーリーが進んだ");
    await page.locator(".story-footer").click(); await page.waitForTimeout(100);
    ok((await h.storyText()) !== before, "設定を閉じた後にストーリーが進まない");
  });
  await test("S-02", "メッセージ表示中(開始時メッセージ以外)でもログ/ヒント/設定が開ける（メッセージは送られない）", async (page, h) => {
    await h.load(baseState({ playPart: 3 }));
    await h.click(page.locator(".face-box"));
    const m = await h.msg();
    ok(m.length > 0, "メッセージが出ていない");
    for (const label of ["ログ", "ヒント", "設定"]) {
      await h.click(page.locator(".header-icons .icon-btn").filter({ hasText: label }));
      eq(await h.modalCount(), 1, `${label}が開かない`);
      await h.click(page.locator(".modal-close-btn"));
    }
    eq(await h.msg(), m, "メッセージが送られた");
  });

  await test("S-03", "開始時メッセージ中: 矢印・クリックポイント・所持品・表情・ログ・ヒントは反応せず、タップはメッセージ送りになる", async (page, h) => {
    await h.load(null);
    await h.click(page.locator(".start-debug-btn").filter({ hasText: /^PlayPart2$/ }));
    eq(await h.msg(), "なんで脱出しないッピ……？");
    await h.arrow("▼");
    eq(await h.view(), "viewDesk", "開始時メッセージ中に矢印で移動できた");
    eq(await h.msg(), "お腹空いてるっぴ？", "矢印タップでメッセージが送られない");
    await h.tapSpot("調査ノート");
    eq(await h.view(), "viewDesk", "開始時メッセージ中にノートが開いた");
    eq(await h.msg(), "ぴつじの好きな食べ物を渡すっぴ！");
    for (const label of ["ログ", "ヒント"]) {
      await h.click(page.locator(".header-icons .icon-btn").filter({ hasText: label }));
      eq(await h.modalCount(), 0, `開始時メッセージ中に${label}が開いた`);
    }
    eq(await h.msg(), "ぴつじの好きな食べ物を渡すっぴ！", "ログ/ヒントのタップでメッセージが送られた");
    await h.click(page.locator(".face-box"));
    eq(await h.msg(), "それでぴつじもやる気出すっぴ！", "表情タップがメッセージ送りにならない");
    await h.click(page.locator("#footer-message"));
    eq(await h.msg(), "", "開始時メッセージが終わらない");
    await h.arrow("▼");
    eq(await h.view(), "roomPiguma", "読み終えた後に矢印で移動できない");
  });
  await test("S-04", "開始時メッセージ中でも設定ボタンは押せる（メッセージは送られない・画面切替直後でも押せる）", async (page, h) => {
    await h.load(null);
    await page.locator(".start-debug-btn").filter({ hasText: /^PlayPart4$/ }).click();
    await page.locator('.header-icons [data-icon="settings"]').click(); // 画面切替直後(250ms以内)
    eq(await h.modalCount(), 1, "設定が開かない");
    ok((await page.textContent(".modal-box")).includes("設定"), "設定モーダルではない");
    await page.waitForTimeout(320);
    await h.click(page.locator(".modal-close-btn"));
    eq(await h.msg(), "こうなったら玄関のドアを開けてやるっぴ！！", "設定操作でメッセージが送られた");
  });
  await test("S-05", "ストーリー終了→操作パート開始時メッセージも読み終えるまで操作不可", async (page, h) => {
    await h.load(null);
    await h.click(page.locator(".start-debug-btn").filter({ hasText: /^StoryPart2$/ }));
    for (let i = 0; i < 60 && (await h.save()).phase === "story"; i++) { await page.locator(".story-footer").click(); await page.waitForTimeout(30); }
    await page.waitForTimeout(320);
    eq(await h.msg(), "ドアの鍵を開けるっぴ！");
    await h.arrow("▼");
    eq(await h.view(), "viewDesk", "開始時メッセージ中に移動できた");
    eq(await h.msg(), "");
    await h.arrow("▼");
    eq(await h.view(), "roomPiguma");
  });
  await test("S-06", "開始時メッセージ以外のメッセージ中は、従来どおりクリックポイント/矢印で即操作できる", async (page, h) => {
    await h.load(baseState({ playPart: 3 }));
    await h.click(page.locator(".face-box"));
    ok((await h.msg()).length > 0, "メッセージが出ていない");
    await h.arrow("▼");
    eq(await h.view(), "roomPiguma", "通常メッセージ中に矢印が効かない");
  });

  // ===================== A: 操作パート6の自動クリア / 写真消去 =====================
  await test("A-01", "PlayPart6: 名刺を電話に使っただけではクリアしない", async (page, h) => {
    await h.load(baseState({ playPart: 6, currentView: "viewPhoneStand", inventory: ["itemPisagiCard", "itemPhotoPitsuji"], everObtainedItems: ["itemPisagiCard", "itemCamera", "itemPhotoPitsuji"], itemUsageLog: { itemCamera: ["spotPitsujiWindow"] } }));
    await h.readAll();
    await h.tapItem("ぴさぎの名刺");
    await h.tapSpot("電話");
    eq(await h.readAll(), ["留守番電話だ。すぐ来てほしいとメッセージを残しておこう"]);
    eq((await h.save()).phase, "play", "名刺だけでクリアした");
    eq(await h.inv(), ["ぴつじの写真"]);
  });
  await test("A-02", "PlayPart6: チャットで番号(2/131)と写真を送信 → メッセージを読むとストーリー6", async (page, h) => {
    await h.load(baseState({ playPart: 6, inventory: ["itemPhotoPitsuji"], everObtainedItems: ["itemPisagiCard", "itemCamera", "itemPhotoPitsuji"], itemUsageLog: { itemPisagiCard: ["spotPhone"], itemCamera: ["spotPitsujiWindow"] } }));
    await h.readAll();
    await h.tapSpot("ゲーム機");
    const keys = page.locator(".gimmick-numpad .gimmick-key");
    await h.click(keys.filter({ hasText: /^2$/ }));
    await h.click(page.locator(".gimmick-chat-field").nth(1));
    for (const d of ["1", "3", "1"]) await h.click(keys.filter({ hasText: new RegExp(`^${d}$`) }));
    await h.shot("A-02_chat");
    await h.click(page.locator(".gimmick-controls button").filter({ hasText: "添付へ進む" }));
    await h.click(page.locator(".gimmick-chat-items .inventory-item").filter({ hasText: "ぴつじの写真" }));
    await h.click(page.locator(".gimmick-controls button").filter({ hasText: "送信" }));
    eq(await h.modalCount(), 0, "ギミックが閉じない");
    eq(await h.msg(), "送信したっぴ！");
    eq(await h.inv(), [], "ぴつじの写真が残っている");
    eq((await h.save()).phase, "play", "メッセージを読む前にストーリーへ移った");
    await page.locator("#footer-message").click(); await page.waitForTimeout(WAIT);
    eq((await h.save()).phase, "story", "ストーリーへ移らない");
    eq((await h.save()).storyPart, 6);
    eq(await page.locator(".story-footer").count(), 1, "ストーリー画面ではない");
  });
  await test("A-03", "PlayPart6: 番号を間違えると数字が消えて再入力", async (page, h) => {
    await h.load(baseState({ playPart: 6, inventory: ["itemPhotoPitsuji"] }));
    await h.readAll();
    await h.tapSpot("ゲーム機");
    const keys = page.locator(".gimmick-numpad .gimmick-key");
    await h.click(keys.filter({ hasText: /^3$/ }));
    await h.click(page.locator(".gimmick-chat-field").nth(1));
    for (const d of ["1", "3", "1"]) await h.click(keys.filter({ hasText: new RegExp(`^${d}$`) }));
    await h.click(page.locator(".gimmick-controls button").filter({ hasText: "添付へ進む" }));
    ok((await page.textContent(".modal-box")).includes("住所が間違えているみたいだ"), "エラーメッセージなし");
    eq(await page.locator(".gimmick-chat-field-value").allTextContents(), ["_", "_ _ _"]);
  });
  await test("A-04", "PlayPart6: 自動クリア待ちの間、他のクリックポイントは反応しない", async (page, h) => {
    await h.load(baseState({ playPart: 6, currentView: "viewPhoneStand", inventory: ["itemPisagiCard"], flags: { chatGimmickCleared: true }, everObtainedItems: ["itemPisagiCard", "itemPhotoPitsuji"] }));
    await h.tapItem("ぴさぎの名刺");
    await h.tapSpot("電話");
    await h.spot("電話台引き出し").click(); await page.waitForTimeout(WAIT);
    eq((await h.save()).phase, "story", "メッセージ送りでストーリーへ移らない");
    ok(!(await h.save()).everObtainedItems.includes("itemBlackLight"), "待機中に別スポットが反応した");
  });
  await test("A-05", "PlayPart6: クリア条件達成後(メッセージ未読)にリロード → ストーリー6へ", async (page, h) => {
    await h.load(baseState({ playPart: 6, currentView: "viewDesk", flags: { chatGimmickCleared: true }, itemUsageLog: { itemPisagiCard: ["spotPhone"] } }));
    eq((await h.save()).phase, "story");
  });
  await test("A-06", "PlayPart7開始時に ぴつじの写真 が所持品に無い", async (page, h) => {
    await h.load(null);
    await h.click(page.locator(".start-debug-btn").filter({ hasText: /^PlayPart6$/ }));
    await page.evaluate((k) => { const s = JSON.parse(localStorage.getItem(k)); s.inventory = ["itemPhotoPitsuji"]; s.everObtainedItems = ["itemPhotoPitsuji"]; s.itemUsageLog = { itemPisagiCard: ["spotPhone"] }; localStorage.setItem(k, JSON.stringify(s)); }, SAVE_KEY);
    await page.reload(); await page.waitForTimeout(WAIT);
    await h.readAll();
    await h.tapSpot("ゲーム機");
    const keys = page.locator(".gimmick-numpad .gimmick-key");
    await h.click(keys.filter({ hasText: /^2$/ }));
    await h.click(page.locator(".gimmick-chat-field").nth(1));
    for (const d of ["1", "3", "1"]) await h.click(keys.filter({ hasText: new RegExp(`^${d}$`) }));
    await h.click(page.locator(".gimmick-controls button").filter({ hasText: "添付へ進む" }));
    await h.click(page.locator(".gimmick-chat-items .inventory-item").first());
    await h.click(page.locator(".gimmick-controls button").filter({ hasText: "送信" }));
    await h.readAll();
    for (let i = 0; i < 40 && (await h.save()).phase === "story"; i++) { await page.locator(".story-footer").click(); await page.waitForTimeout(40); }
    await page.waitForTimeout(WAIT);
    eq((await h.save()).playPart, 7);
    eq(await h.inv(), []);
  });

  // ===================== C: クリックポイント位置（目視用スクリーンショット＋タップ確認） =====================
  await test("C-01", "部屋B1: ドアA/玄関ドア/電子錠 の位置", async (page, h) => {
    await h.load(baseState({ playPart: 4, currentView: "roomB1" }));
    await h.shot("C-01_roomB1");
    await h.tapSpot("玄関ドアの電子錠");
    ok((await page.textContent(".modal-box")).includes("玄関ドアの電子錠"), "電子錠ギミックが開かない");
    await h.shot("C-01_gimmickEntrance");
  });
  await test("C-05", "電気スイッチ: 部屋B2で赤くすると部屋B1も赤い。ローテーブル拡大・部屋A1は赤くならない", async (page, h) => {
    await h.load(baseState({ playPart: 4, currentView: "roomB2" }));
    await h.readAll();
    await h.tapSpot("電気スイッチ"); await h.readAll();
    eq(await page.locator(".scene-tint").count(), 1, "B2が赤くない");
    await h.arrow("◀");
    eq(await page.locator(".scene-tint").count(), 1, "B1が赤くない");
    await h.shot("C-05_roomB1_red");
    await h.tapSpot("ドアA");
    eq(await page.locator(".scene-tint").count(), 0, "部屋A1が赤い");
  });
  await test("C-02", "部屋B2: ローテーブル/ソファ の位置", async (page, h) => {
    await h.load(baseState({ playPart: 4, currentView: "roomB2" }));
    await h.shot("C-02_roomB2");
    await h.tapSpot("ローテーブル");
    eq(await h.view(), "viewLowTable");
  });
  await test("C-03", "黒ぴぐま部屋: ベッド範囲(左下角固定で縮小)・ぴぐまと重なっても両方タップ可", async (page, h) => {
    await h.load(baseState({ playPart: 7, currentView: "roomPiguma" }));
    await h.shot("C-03_roomPiguma");
    await h.tapSpot("ぴぐま");
    eq(await h.readAll(), ["うきうきしていてなんだか楽しそうだっぴ"]);
    await h.tapSpot("ベッド");
    eq(await h.view(), "viewBed");
  });
  await test("C-04", "玄関ドアギミック: ESCAPEを選んで正解 / 間違いで不正解", async (page, h) => {
    await h.load(baseState({ playPart: 4, currentView: "roomB1" }));
    await h.tapSpot("玄関ドアの電子錠");
    const rows = [["R", "I", "C", "E"], ["P", "A", "S", "T", "A"], ["C", "A", "K", "E"], ["T", "O", "A", "S", "T"], ["P", "I", "Z", "Z", "A"], ["S", "C", "O", "N", "E"]];
    const pick = [3, 2, 0, 2, 0, 4];
    const hs = page.locator(".gimmick-image-wrap .gimmick-key-hotspot:not(.gimmick-key-hotspot--result)");
    let idx = 0;
    const wrong = [0, 0, 0, 0, 0, 0];
    for (let r = 0; r < 6; r++) { await hs.nth(idx + wrong[r]).click(); idx += rows[r].length; }
    await h.click(page.locator(".gimmick-controls button").filter({ hasText: "決定" }));
    eq(await page.textContent(".gimmick-status"), "違ったッピ……");
    idx = 0;
    for (let r = 0; r < 6; r++) { await hs.nth(idx + pick[r]).click(); idx += rows[r].length; }
    await h.shot("C-04_entrance_ESCAPE");
    await h.click(page.locator(".gimmick-controls button").filter({ hasText: "決定" }));
    eq(await h.modalCount(), 0);
    eq(await h.readAll(), ["カチッと音がして鍵が開いた", "玄関のロックが解除されたっぴ！"]);
  });

  // ===================== F: 通しプレイ（全パートのクリア条件） =====================
  await test("F-01", "スタート→PlayPart1〜8→エンディングまで通しでクリアできる", async (page, h) => {
    await h.load(null);
    const story = async () => { for (let i = 0; i < 60 && (await h.save()).phase === "story"; i++) { await page.locator(".story-footer").click(); await page.waitForTimeout(30); } await page.waitForTimeout(WAIT); };
    const part = async () => (await h.save()).playPart;
    await h.click(page.locator(".start-title"));
    await h.readAll();
    await h.tapSpot("配信用カメラ"); await story();
    // Part2
    eq(await part(), 2, "part2");
    await h.readAll();
    await h.arrow("▼"); await h.arrow("▼"); // desk → roomPiguma → roomA2
    await h.arrow("◀"); await h.tapSpot("冷蔵庫"); await h.tapSpot("冷蔵庫"); await h.readAll();
    await h.arrow("▼"); await h.arrow("▶"); await h.tapSpot("ぴつじ部屋のドア");
    await h.tapItem("チョコレート"); await h.tapSpot("ドア下隙間"); await h.readAll();
    await h.arrow("▼"); await h.tapSpot("黒ぴぐま部屋のドア"); await h.tapSpot("机"); await h.tapSpot("配信用カメラ"); await story();
    // Part3
    eq(await part(), 3, "part3");
    await h.readAll();
    await h.arrow("▼"); await h.arrow("▼"); await h.arrow("◀");
    await h.tapSpot("ドアBの電子錠");
    for (const d of ["3", "9", "5", "2"]) await h.click(page.locator(".gimmick-key-hotspot").filter({ hasText: new RegExp(`^${d}$`) }));
    await h.click(page.locator(".gimmick-controls button").filter({ hasText: "決定" }));
    await h.readAll();
    await h.arrow("▶"); await h.tapSpot("黒ぴぐま部屋のドア"); await h.tapSpot("机"); await h.tapSpot("配信用カメラ"); await story();
    // Part4
    eq(await part(), 4, "part4");
    await h.readAll();
    await h.arrow("▼"); await h.arrow("▼"); await h.arrow("◀"); await h.tapSpot("ドアB");
    eq(await h.view(), "roomB1");
    await h.tapSpot("玄関ドアの電子錠");
    const rows = [4, 5, 4, 5, 5, 5], pick = [3, 2, 0, 2, 0, 4];
    const hs = page.locator(".gimmick-image-wrap .gimmick-key-hotspot:not(.gimmick-key-hotspot--result)");
    let idx = 0; for (let r = 0; r < 6; r++) { await hs.nth(idx + pick[r]).click(); idx += rows[r]; }
    await h.click(page.locator(".gimmick-controls button").filter({ hasText: "決定" }));
    await h.readAll();
    await h.tapSpot("ドアA"); await h.arrow("▶"); await h.tapSpot("黒ぴぐま部屋のドア"); await h.tapSpot("机"); await h.tapSpot("配信用カメラ"); await story();
    // Part5
    eq(await part(), 5, "part5");
    await h.readAll();
    await h.arrow("▼"); await h.tapSpot("ベッド"); await h.tapSpot("ベッドマット"); await h.readAll(); await h.arrow("▼");
    await h.arrow("▼"); await h.tapSpot("棚"); await h.tapSpot("工具箱"); await h.readAll(); await h.arrow("▼");
    await h.arrow("◀"); await h.tapSpot("テーブル"); await h.tapSpot("椅子"); await h.readAll(); await h.arrow("▼"); await h.arrow("▶");
    await h.tapSpot("ぴつじ部屋のドア");
    await h.tapItem("プラスドライバー"); await h.tapSpot("ドア小窓"); await h.readAll();
    await h.tapItem("クッション"); await h.tapSpot("ドア小窓"); await h.readAll();
    await h.tapItem("タオルケット"); await h.tapSpot("ドア小窓"); await h.readAll();
    await h.arrow("▼"); await h.tapSpot("黒ぴぐま部屋のドア"); await h.tapSpot("机"); await h.tapSpot("配信用カメラ"); await story();
    // Part6
    eq(await part(), 6, "part6");
    await h.readAll();
    await h.arrow("▼"); await h.tapSpot("本棚"); await h.shot("F-01_bookshelf_image"); await page.mouse.click(195, 150); await page.waitForTimeout(WAIT);
    eq(await h.modalCount(), 0, "画像表示が画面タップで閉じない");
    eq(await h.readAll(), ["そういえば名刺をしおり代わりにしてたっぴ"]);
    await h.tapSpot("ベッド"); await h.tapSpot("ベッド下"); await h.readAll(); await h.arrow("▼");
    await h.arrow("▼"); await h.tapSpot("ぴつじ部屋のドア"); await h.tapItem("カメラ"); await h.tapSpot("ドア小窓"); await h.readAll(); await h.arrow("▼");
    await h.arrow("◀"); await h.tapSpot("ドアB"); await h.tapSpot("電話台"); await h.tapItem("ぴさぎの名刺"); await h.tapSpot("電話"); await h.readAll();
    eq(await part(), 6, "名刺だけでクリア");
    await h.arrow("▼"); await h.tapSpot("ドアA"); await h.arrow("▶"); await h.tapSpot("黒ぴぐま部屋のドア"); await h.tapSpot("机");
    await h.tapSpot("ゲーム機");
    const keys = page.locator(".gimmick-numpad .gimmick-key");
    await h.click(keys.filter({ hasText: /^2$/ })); await h.click(page.locator(".gimmick-chat-field").nth(1));
    for (const d of ["1", "3", "1"]) await h.click(keys.filter({ hasText: new RegExp(`^${d}$`) }));
    await h.click(page.locator(".gimmick-controls button").filter({ hasText: "添付へ進む" }));
    await h.click(page.locator(".gimmick-chat-items .inventory-item").filter({ hasText: "ぴつじの写真" }));
    await h.click(page.locator(".gimmick-controls button").filter({ hasText: "送信" }));
    await h.readAll(); await story();
    // Part7
    eq(await part(), 7, "part7");
    eq(await h.inv(), [], "part7開始時に所持品が残っている");
    await h.readAll();
    await h.tapSpot("調査ノート");
    for (let i = 0; i < 6; i++) await h.click(page.locator(".note-page"));
    await h.readAll(); await h.click(page.locator(".note-close-btn"));
    eq(await h.inv(), ["写真"]);
    await h.arrow("▼"); await h.arrow("▼"); await h.arrow("◀"); await h.tapSpot("ドアB");
    await h.tapItem("写真"); await h.tapSpot("ぴさぎ");
    for (const r of await page.locator(".gimmick-image-wrap .gimmick-key-hotspot").all()) await r.click();
    await h.click(page.locator(".gimmick-controls button").filter({ hasText: "決定" }));
    await h.readAll();
    await h.tapSpot("ぴさぎ"); await page.locator(".modal-close-btn").click(); await page.waitForTimeout(WAIT);
    eq(await h.readAll(), ["これを買ってきて欲しい！", "任せるっぴ！", "タンバリンは任せるっぴ！"]);
    eq(await h.inv(), ["マラカス"]);
    await h.tapSpot("ドアA"); await h.arrow("▶"); await h.tapSpot("黒ぴぐま部屋のドア");
    await h.tapItem("マラカス"); await h.tapSpot("ぴぐま"); await h.readAll();
    eq(await h.inv(), ["音楽CD"]);
    await h.arrow("▼"); await h.arrow("◀"); await h.tapSpot("ドアB"); await h.arrow("▶");
    await h.tapItem("音楽CD"); await h.tapSpot("オーディオ"); await h.readAll();
    await h.tapSpot("オーディオ");
    await h.click(page.locator(".bgm-track-btn").filter({ hasText: "HAPPY" }));
    await h.arrow("◀"); await h.tapSpot("ドアA"); await h.arrow("▶"); await h.tapSpot("黒ぴぐま部屋のドア"); await h.tapSpot("机"); await h.tapSpot("配信用カメラ"); await story();
    // Part8
    eq(await part(), 8, "part8");
    await h.readAll();
    await h.tapSpot("ぴつじ部屋の出口");
    for (let i = 0; i < 40; i++) { const s = await page.$(".story-footer"); if (!s) break; await s.click(); await page.waitForTimeout(30); }
    await page.waitForTimeout(WAIT);
    eq((await h.save()).phase, "end", "エンディングに到達しない");
    ok((await page.textContent(".end-screen")).includes("おしまい"), "エンディング画面が出ない");
    await h.shot("F-01_ending");
    await page.reload(); await page.waitForTimeout(WAIT);
    ok(await page.locator(".end-screen").count() === 1, "リロードでエンディング画面が復元されない");
    await h.click(page.locator(".end-back-btn"));
    ok(await page.locator(".start-screen .start-title").count() === 1, "タイトルに戻らない");
    eq(await h.save(), null, "セーブが消えていない");
  });

  // ===================== E: 異常系 =====================
  await test("E-01", "Web応答が遅い(データ3秒遅延): 読み込み中表示 → 正常に開始", async (page, h) => {
    await page.goto(BASE);
    ok((await page.textContent("#app")).includes("読み込み中"), "読み込み中表示が無い");
    await page.waitForSelector(".start-screen", { timeout: 10000 });
    await h.click(page.locator(".start-title"));
    eq(await h.msg(), "さて……");
  }, { route: (page) => page.route("**/data/*.json", async (r) => { await new Promise((res) => setTimeout(res, 3000)); await r.continue(); }) });
  await test("E-02", "Web応答が返らない(タイムアウト): エラー表示と再読み込みボタン", async (page, h) => {
    await page.goto(BASE);
    await page.waitForSelector(".load-error", { timeout: 25000 });
    ok((await page.textContent(".load-error")).includes("タイムアウト"), "タイムアウト表示なし");
    ok(await page.locator("#app button").filter({ hasText: "再読み込み" }).isVisible(), "再読み込みボタンなし");
  }, { route: (page) => page.route("**/data/spots.json", () => {}), allowConsoleError: true });
  await test("E-03", "データ取得がサーバーエラー(500): エラー表示", async (page, h) => {
    await page.goto(BASE);
    await page.waitForSelector(".load-error", { timeout: 5000 });
    ok((await page.textContent(".load-error")).includes("500"), "ステータス表示なし");
  }, { route: (page) => page.route("**/data/items.json", (r) => r.fulfill({ status: 500, body: "err" })), allowConsoleError: true });
  await test("E-04", "背景画像が遅い(5秒遅延): 画像待ちの間も操作できる", async (page, h) => {
    await h.load(baseState({ playPart: 2 }));
    await h.readAll();
    await h.arrow("▼");
    eq(await h.view(), "roomPiguma");
    await h.tapSpot("本棚");
    eq(await h.readAll(), ["最近のお気に入りはホームズの踊る人形だ"]);
  }, { route: (page) => page.route("**/assets/**", async (r) => { await new Promise((res) => setTimeout(res, 5000)); await r.continue().catch(() => {}); }) });
  await test("E-05", "背景画像が404: エラー表示のラベルになり操作は可能", async (page, h) => {
    await h.load(baseState({ playPart: 2, currentView: "roomPiguma" }));
    ok((await page.textContent(".scene-label")).includes("読み込みに失敗"), "失敗表示なし");
    await h.tapSpot("机");
    eq(await h.view(), "viewDesk");
  }, { route: (page) => page.route("**/assets/backgrounds/**", (r) => r.fulfill({ status: 404, body: "" })) });
  const blockStorage = () => {
    const thrower = () => { throw new DOMException("The operation is insecure.", "SecurityError"); };
    Object.defineProperty(window, "localStorage", { get: thrower, configurable: true });
  };
  await test("E-06", "Cookie/サイトデータ無効(localStorage例外): 起動・プレイでき、設定に警告", async (page, h) => {
    await page.goto(BASE);
    await page.waitForSelector(".start-screen", { timeout: 5000 });
    await h.click(page.locator(".start-title"));
    eq(await h.readAll(), ["さて……"]);
    await h.tapSpot("配信用カメラ");
    ok(await page.locator(".story-footer").count() === 1, "ストーリーへ進まない");
    await h.click(page.locator(".story-header .icon-btn"));
    ok((await page.textContent(".modal-box")).includes("セーブされません"), "警告なし");
  }, { init: blockStorage, allowConsoleError: true });
  await test("E-07", "Cookie無効環境で「セーブデータを削除」を押してもエラーで止まらない", async (page, h) => {
    await page.goto(BASE);
    await page.waitForSelector(".start-screen", { timeout: 5000 });
    await h.click(page.locator(".start-title"));
    page.once("dialog", (d) => d.accept());
    await h.click(page.locator(".header-icons .icon-btn").filter({ hasText: "設定" }));
    await page.locator(".danger-btn").click();
    await page.waitForSelector(".start-screen", { timeout: 5000 });
  }, { init: blockStorage, allowConsoleError: true });
  await test("E-08", "壊れたセーブデータ / 旧バージョン: 破棄してスタート画面", async (page, h) => {
    await page.goto(BASE);
    for (const bad of ["{broken json", JSON.stringify({ saveVersion: 1, phase: "play" })]) {
      await page.evaluate(([k, v]) => localStorage.setItem(k, v), [SAVE_KEY, bad]);
      await page.reload();
      await page.waitForSelector(".start-screen", { timeout: 5000 });
    }
  }, { allowConsoleError: true });
  await test("E-09", "連打: スタート画面を素早く5連打しても開始メッセージは1回分", async (page, h) => {
    await h.load(null);
    const t = await page.locator(".start-title").boundingBox();
    for (let i = 0; i < 5; i++) await page.mouse.click(t.x + t.width / 2, t.y + t.height / 2);
    await page.waitForTimeout(WAIT);
    eq(await h.readAll(), ["さて……"]);
  });
  await test("E-10", "連打: 配信用カメラを素早く10連打しても、ストーリーが1行目から始まる", async (page, h) => {
    await h.load(baseState({ playPart: 1 }));
    const box = await h.spot("配信用カメラ").boundingBox();
    for (let i = 0; i < 10; i++) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(WAIT);
    eq(await page.textContent(".story-footer div:last-child"), "ここは……？");
  });
  await test("E-11", "連打: 調査ノートをダブルタップしてもページ1左が飛ばされない", async (page, h) => {
    await h.load(baseState({ playPart: 3 }));
    await h.readAll();
    const box = await h.spot("調査ノート").boundingBox();
    await page.mouse.click(box.x + 5, box.y + 5); await page.mouse.click(box.x + 5, box.y + 5);
    await page.waitForTimeout(WAIT);
    ok((await page.textContent(".note-page")).includes("1ページ左"), "1左が飛ばされた");
  });
  await test("E-12", "連打: 下矢印を素早く連打しても1画面分しか移動しない", async (page, h) => {
    await h.load(baseState({ playPart: 2 }));
    await h.readAll();
    const box = await page.locator(".arrow-btn").boundingBox();
    for (let i = 0; i < 4; i++) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(WAIT);
    eq(await h.view(), "roomPiguma");
  });
  await test("E-13", "連打: 冷蔵庫(チョコ)を10連打してもチョコは1個・メッセージ破綻なし", async (page, h) => {
    await h.load(baseState({ playPart: 2, currentView: "viewRefrigerator" }));
    await h.readAll();
    const box = await h.spot("冷蔵庫").boundingBox();
    for (let i = 0; i < 10; i++) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    eq(await h.inv(), ["チョコレート"]);
    const s = await h.save();
    eq(s.inventory, ["itemChocolate"]);
    ok((await h.msg()).length > 0, "メッセージが空");
  });
  await test("E-14", "連打: 電子錠Bの決定を連打しても成功処理は1回", async (page, h) => {
    await h.load(baseState({ playPart: 3, currentView: "roomA1" }));
    await h.readAll();
    await h.tapSpot("ドアBの電子錠");
    for (const d of ["3", "9", "5", "2"]) await page.locator(".gimmick-key-hotspot").filter({ hasText: new RegExp(`^${d}$`) }).click();
    await page.locator(".gimmick-controls button").filter({ hasText: "決定" }).scrollIntoViewIfNeeded();
    const btn = await page.locator(".gimmick-controls button").filter({ hasText: "決定" }).boundingBox();
    for (let i = 0; i < 5; i++) await page.mouse.click(btn.x + 10, btn.y + 10);
    await page.waitForTimeout(WAIT);
    const got = await h.readAll();
    eq(got, ["カチッと音がして鍵が開いた", "ロックが解除されたっぴ！", "ぴつじを脱出させるっぴ！"]);
    eq(await h.modalCount(), 0);
  });
  await test("E-15", "連打: 所持品アイコンを素早く6連打してもモーダルは1枚、状態も破綻しない", async (page, h) => {
    await h.load(itemsState);
    const box = await h.item("焼かれた食パン").boundingBox();
    for (let i = 0; i < 6; i++) await page.mouse.click(box.x + 5, box.y + 5);
    await page.waitForTimeout(WAIT);
    ok((await h.modalCount()) <= 1, "モーダルが複数開いた");
    eq(await h.selected(), ["焼かれた食パン"]);
  });
  await test("E-16", "連打: 表情を連打してもループ順が崩れない（メッセージ送り→次の行）", async (page, h) => {
    await h.load(baseState({ playPart: 3 }));
    const box = await page.locator(".face-box").boundingBox();
    const got = [];
    for (let i = 0; i < 6; i++) { await page.mouse.click(box.x + 5, box.y + 5); const t = await h.msg(); if (t) got.push(t); }
    const uniq = got.filter((t, i) => t !== got[i - 1]);
    eq(uniq.slice(0, 3), ["ドアの鍵開けるっぴ～", "暗証番号忘れたッピ", "この部屋にヒントがあるはずっぴ！"]);
  });
  await test("E-17", "連打: チャットの送信を連打しても成功は1回・ストーリーへ正常に移る", async (page, h) => {
    await h.load(baseState({ playPart: 6, inventory: ["itemPhotoPitsuji"], itemUsageLog: { itemPisagiCard: ["spotPhone"] } }));
    await h.readAll();
    await h.tapSpot("ゲーム機");
    const keys = page.locator(".gimmick-numpad .gimmick-key");
    await keys.filter({ hasText: /^2$/ }).click(); await page.locator(".gimmick-chat-field").nth(1).click();
    for (const d of ["1", "3", "1"]) await keys.filter({ hasText: new RegExp(`^${d}$`) }).click();
    await page.locator(".gimmick-controls button").filter({ hasText: "添付へ進む" }).click();
    await page.locator(".gimmick-chat-items .inventory-item").first().click();
    const b = await page.locator(".gimmick-controls button").filter({ hasText: "送信" }).boundingBox();
    for (let i = 0; i < 5; i++) await page.mouse.click(b.x + 10, b.y + 10);
    await page.waitForTimeout(WAIT);
    const s = await h.save();
    ok(s.phase === "story" || (await h.msg()) === "送信したっぴ！", "状態が不正");
    eq(await h.modalCount(), 0);
  });
  await test("E-18", "連打: ヒントの同じ行を連打しても1行しか開かない（誤って先のヒントまで開かない）", async (page, h) => {
    await h.load(baseState({ playPart: 3 }));
    await h.click(page.locator(".header-icons .icon-btn").filter({ hasText: "ヒント" }));
    const first = await page.locator(".hint-line--masked").first().boundingBox();
    for (let i = 0; i < 4; i++) await page.mouse.click(first.x + 5, first.y + 5);
    await page.waitForTimeout(100);
    eq((await h.save()).hintRevealCounts["3"], 1);
    await page.locator(".hint-line--masked").first().click();
    eq((await h.save()).hintRevealCounts["3"], 2, "次の行が開かない");
  });
  await test("E-19", "アイテムを持たずにBGM選択: HAPPYは未入手で選べない", async (page, h) => {
    await h.load(baseState({ playPart: 7, currentView: "roomB2" }));
    await h.readAll();
    await h.tapSpot("オーディオ");
    ok(await page.locator(".bgm-track-btn").filter({ hasText: "HAPPY" }).isDisabled(), "HAPPYが選べる");
  });
  await test("E-20", "画面サイズが小さい端末(320x568)でもノート閉じるボタン・所持品が表示される", async (page, h) => {
    await h.load(baseState({ playPart: 3, currentView: "viewNote", inventory: ["itemBread"] }));
    ok(await page.locator(".note-close-btn").isVisible(), "閉じるボタンが見えない");
    const b = await page.locator(".note-close-btn").boundingBox();
    ok(b.y + b.height <= 568, "閉じるボタンが画面外");
    await h.shot("E-20_small_note");
  }, { context: { viewport: { width: 320, height: 568 } } });

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "OK  " : "NG  "} ${r.id} ${r.title}${r.ok ? "" : "\n       → " + r.err}`);
  console.log(`\n${results.length}件中 ${results.length - failed.length}件OK / ${failed.length}件NG`);
  process.exitCode = failed.length ? 1 : 0;
})();
