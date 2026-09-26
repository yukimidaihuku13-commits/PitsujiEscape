// e2e.test.cjs
// 実際のブラウザ(Chrome)でゲームを操作するデバッグ用テスト。
//   前提: このフォルダをローカルサーバーで配信していること
//         playwright-core がインストールされていること（npm i playwright-core）
//   実行: BASE_URL=<配信しているURL> node debug/e2e.test.cjs
//         （一部だけ実行する場合: TEST_IDS=S-01,S-02 を併せて指定）
// スクリーンショットは debug/screenshots/ に保存する。
// サーバーのURL・ポート番号はソースに埋め込まない方針のため、環境変数 BASE_URL で必ず指定する。
//
// 音声(SE/BGM)の検証: ページ内の Audio を差し替えて、再生されたSEと「今鳴っているBGM(ループ再生中の音声)」を
// 記録する（AUDIO_SPY）。BGMが2つ同時に鳴った瞬間があれば maxBgm が2以上になる。

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright-core");

const BASE = process.env.BASE_URL;
if (!BASE) {
  console.error("環境変数 BASE_URL に、ゲームを配信しているURLを指定してください（例: BASE_URL=<URL> node debug/e2e.test.cjs）");
  process.exit(1);
}
const ROOT = path.join(__dirname, "..");
const SAVE_KEY = "pitsujiEscapeGame_save";
const AUDIO_KEY = "pitsujiEscapeGame_audioSettings";
const SHOT_DIR = path.join(__dirname, "screenshots");
fs.mkdirSync(SHOT_DIR, { recursive: true });

const WAIT = 320; // 画面切替直後のタップガード(250ms)より長く待つ
const load = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", f), "utf8"));
const DATA = { views: load("views.json"), spots: load("spots.json"), items: load("items.json"), playParts: load("playParts.json") };

function baseState(over = {}) {
  return Object.assign({
    saveVersion: 3, phase: "play", playPart: 2, storyPart: null, currentView: "viewDesk",
    inventory: [], everObtainedItems: [], itemUsageLog: {}, flags: {}, clickCounts: {},
    bgmState: { unlockedTracks: ["default"], currentTrack: "default" }, hintRevealCounts: {}, notePage: 0
  }, over);
}

// ---- 音声の記録（ページ読み込み前に仕込む） ----
function AUDIO_SPY() {
  const log = [];
  const all = [];
  let maxBgm = 0;
  const name = (a) => decodeURIComponent((a.src || "").split("/").pop());
  const playing = () => all.filter((a) => a.loop && !a.paused).map(name);
  const Orig = window.Audio;
  function SpyAudio(src) {
    const a = new Orig(src);
    all.push(a);
    a.addEventListener("pause", () => log.push({ ev: "pause", src: name(a), loop: a.loop }));
    a.addEventListener("playing", () => { maxBgm = Math.max(maxBgm, playing().length); });
    return a;
  }
  SpyAudio.prototype = Orig.prototype;
  window.Audio = SpyAudio;
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    log.push({ ev: "play", src: name(this), loop: this.loop, volume: this.volume });
    const p = origPlay.call(this);
    p.then(() => { maxBgm = Math.max(maxBgm, playing().length); }).catch((e) => log.push({ ev: "fail", src: name(this), name: e.name }));
    return p;
  };
  window.__audio = {
    se: () => log.filter((l) => l.ev === "play" && !l.loop).map((l) => l.src.replace(/\.mp3$/, "")),
    bgm: () => playing().map((s) => s.replace(/\.mp3$/, "")),
    bgmVolume: () => all.filter((a) => a.loop && !a.paused).map((a) => Math.round(a.volume * 100) / 100),
    seVolume: () => log.filter((l) => l.ev === "play" && !l.loop).map((l) => Math.round(l.volume * 100) / 100),
    maxBgm: () => Math.max(maxBgm, playing().length),
    fails: () => log.filter((l) => l.ev === "fail"),
    reset: () => { log.length = 0; maxBgm = playing().length; }
  };
}

// ---- ページ操作ヘルパー ----
function helpers(page) {
  const h = {
    async load(state, { keepAudioSettings = false } = {}) {
      await page.goto(BASE);
      await page.evaluate(([k, s, ak, keep]) => {
        const a = localStorage.getItem(ak);
        localStorage.clear();
        if (keep && a) localStorage.setItem(ak, a);
        if (s) localStorage.setItem(k, JSON.stringify(s));
      }, [SAVE_KEY, state || null, AUDIO_KEY, keepAudioSettings]);
      await page.reload();
      await page.waitForSelector(".header-icons, .start-screen, .story-footer");
      await page.waitForTimeout(WAIT);
    },
    // アイテム入手時の拡大画像(.item-get-box)は、既存テストの流れを変えないよう既定で自動的に閉じる。
    // 入手画像そのものを確かめるテストでは h.autoCloseGet = false にする。閉じたアイテム名は h.gotItems に記録。
    autoCloseGet: true,
    gotItems: [],
    async closeGet() {
      for (let i = 0; i < 5 && (await page.locator(".item-get-box").count()); i++) {
        h.gotItems.push(((await page.textContent(".item-get-box .item-zoom-name")) || "").trim());
        await page.waitForTimeout(WAIT);
        await page.mouse.click(20, 80);
        await page.waitForTimeout(WAIT);
      }
    },
    async click(locator) { await locator.click({ timeout: 3000 }); await page.waitForTimeout(WAIT); if (h.autoCloseGet) await h.closeGet(); },
    spot: (label) => page.locator(".spot-hotspot, .spot-btn").filter({ hasText: new RegExp(`^${label}$`) }),
    item: (name) => page.locator(".inventory-bar .inventory-item").filter({ hasText: new RegExp(`^${name}$`) }),
    async tapSpot(label) { await h.click(h.spot(label)); },
    async tapItem(name) { await h.click(h.item(name)); },
    async useItem(name, spot) { await h.tapItem(name); await h.tapSpot(spot); },
    msg: () => page.textContent("#footer-message").then((t) => (t || "").trim()),
    // 表示中メッセージを全て読み進め、読んだ内容を返す（画像表示が出たらそこで止まる）
    async readAll(max = 20) {
      const out = [];
      for (let i = 0; i < max; i++) {
        if (h.autoCloseGet && (await page.locator(".item-get-box").count())) { await h.closeGet(); continue; }
        if (await h.modalCount()) break;
        const t = await h.msg();
        if (!t) break;
        out.push(t);
        await page.locator("#footer-message").click();
        await page.waitForTimeout(60);
      }
      return out;
    },
    // メッセージと「表示」画像を順に最後まで進める。画像は "[画像]キャプション" として記録する
    async readThrough(max = 30) {
      const out = [];
      for (let i = 0; i < max; i++) {
        if (h.autoCloseGet && (await page.locator(".item-get-box").count())) { await h.closeGet(); continue; }
        if (await h.modalCount()) {
          const cap = (await page.textContent(".modal-box")).replace("×", "").trim();
          out.push(`[画像]${cap}`);
          await page.waitForTimeout(WAIT);
          await page.mouse.click(20, 80);
          await page.waitForTimeout(WAIT);
          continue;
        }
        const t = await h.msg();
        if (!t) break;
        out.push(t);
        await page.locator("#footer-message").click();
        await page.waitForTimeout(80);
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
    async shot(name) { await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) }); },
    async story(max = 80) {
      await h.readAll();
      for (let i = 0; i < max && (await h.save())?.phase === "story"; i++) { await page.locator(".story-footer").click(); await page.waitForTimeout(40); }
      await page.waitForTimeout(WAIT);
    },
    async openSettings() { await h.click(page.locator('.header-icons [data-icon="settings"]')); },
    // 音量の段階を選ぶ（label: "効果音" / "BGM"、level: "大" / "中" / "小" / "消"）
    async setLevel(label, level) { await h.click(page.locator(".settings-row").filter({ hasText: label }).locator(".settings-level").filter({ hasText: level })); },
    levels: () => page.$$eval(".settings-level--on", (els) => els.map((e) => e.textContent)),
    // 音声
    se: () => page.evaluate(() => window.__audio.se()),
    bgm: () => page.evaluate(() => window.__audio.bgm()),
    maxBgm: () => page.evaluate(() => window.__audio.maxBgm()),
    audioReset: () => page.evaluate(() => window.__audio.reset()),
    // ギミック操作
    async dialPhone(number) {
      for (const k of number) await page.locator("button.gimmick-key-hotspot").filter({ hasText: new RegExp(`^${k.replace(/[*#]/g, "\\$&")}$`) }).click();
      await h.click(page.locator("button.gimmick-key-hotspot").filter({ hasText: "発信" }));
    },
    async chatGame(a, b, attach = true) {
      await h.click(page.locator(".gimmick-friends-list .inventory-item").filter({ hasText: /^ぴかくま$/ }));
      await h.click(page.locator(".gimmick-chat-blank").first());
      await h.click(page.locator(".gimmick-chat-items .inventory-item").filter({ hasText: new RegExp(`^${a}$`) }));
      await h.click(page.locator(".gimmick-chat-blank").nth(1));
      await h.click(page.locator(".gimmick-chat-items .inventory-item").filter({ hasText: new RegExp(`^${b}$`) }));
      if (attach) await h.click(page.locator(".gimmick-controls button").filter({ hasText: "写真を添付" }));
    },
    fruit: () => page.textContent(".gimmick-selector-display").then((t) => (t || "").trim()),
    async selectFruit(name) {
      for (let i = 0; i < 6 && (await h.fruit()) !== name; i++) await page.locator('.gimmick-selector-btn[data-dir="down"]').click();
      if ((await h.fruit()) !== name) throw new Error(`果物 ${name} を選べない`);
    },
    async doorB(code = "3952", fruit = "りんご") {
      await h.selectFruit(fruit);
      for (const d of code) await page.locator("button.gimmick-key-hotspot").filter({ hasText: new RegExp(`^${d}$`) }).click();
      await h.click(page.locator(".gimmick-controls button").filter({ hasText: "決定" }));
    },
    async entrance(pick = [3, 2, 0, 2, 0, 4]) {
      const rows = [4, 5, 4, 5, 5, 5];
      const hs = page.locator(".gimmick-image-wrap .gimmick-key-hotspot:not(.gimmick-key-hotspot--result)");
      let idx = 0;
      for (let r = 0; r < 6; r++) { await hs.nth(idx + pick[r]).click(); idx += rows[r]; }
      await h.click(page.locator(".gimmick-controls button").filter({ hasText: "決定" }));
    }
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
  await context.addInitScript(AUDIO_SPY);
  if (ctxOpts.init) await context.addInitScript(ctxOpts.init);
  const page = await context.newPage();
  const errors = [];
  const watch = (p) => {
    p.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text()) && !(ctxOpts.allowConsoleError)) errors.push("console: " + m.text()); });
  };
  watch(page);
  if (ctxOpts.route) await ctxOpts.route(page);
  const started = Date.now();
  try {
    await fn(page, helpers(page), { context, watch });
    if (errors.length) throw new Error("JSエラー: " + errors.slice(0, 3).join(" | "));
    results.push({ id, title, ok: true, ms: Date.now() - started });
  } catch (e) {
    results.push({ id, title, ok: false, err: e.message.split("\n")[0] });
    try { await page.screenshot({ path: path.join(SHOT_DIR, `NG_${id}.png`) }); } catch {}
  }
  await context.close();
}
function eq(a, b, label = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${label} 期待値: ${y} / 実際: ${x}`); }
function ok(c, label) { if (!c) throw new Error(label); }

(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const { hasMatchingRule } = await import(path.join(ROOT, "js/engine/RuleResolver.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));

  // ===================== I: 所持品・アイテム拡大表示 =====================
  const itemsState = baseState({ playPart: 3, inventory: ["itemFrozenBluePaper", "itemToastedBread"], everObtainedItems: ["itemBluePaper", "itemFrozenBluePaper", "itemBread", "itemToastedBread"] });

  await test("I-01", "タップで選択（拡大表示はまだ出ない）・選択時にSE(Se_ItemIcon)", async (page, h) => {
    await h.load(itemsState);
    await h.audioReset();
    await h.tapItem("冷凍後の青い紙");
    eq(await h.selected(), ["冷凍後の青い紙"]);
    eq(await h.modalCount(), 0, "モーダル");
    eq(await h.se(), ["Se_ItemIcon"], "選択SE");
  });
  await test("I-02", "選択中に同じアイテム → 拡大画像(仮枠に中身)＋説明文。選択は解除されない。拡大・解除ではSEが鳴らない", async (page, h) => {
    await h.load(itemsState);
    await h.tapItem("冷凍後の青い紙");
    await h.audioReset();
    await h.tapItem("冷凍後の青い紙");
    eq(await h.modalCount(), 1, "モーダル");
    eq((await page.textContent(".item-zoom-message")).trim(), "数字が書かれているっぴ！");
    ok((await page.textContent(".item-zoom-box .modal-image-placeholder")).includes("3952"), "仮枠に数字が無い");
    eq(await page.locator(".item-zoom-close").count(), 0, "説明文表示中に閉じるボタンが出ている");
    await h.shot("I-02_item_zoom");
    eq(await h.selected(), ["冷凍後の青い紙"], "選択が外れた");
    eq(await h.se(), [], "拡大表示でSEが鳴った");
  });
  await test("I-03", "拡大表示中: 画面タップで説明文が消えて閉じるボタン → 押すと閉じる", async (page, h) => {
    await h.load(itemsState);
    await h.tapItem("焼かれた食パン");
    await h.tapItem("焼かれた食パン");
    await page.mouse.click(30, 120); await page.waitForTimeout(WAIT);
    eq(await page.locator(".item-zoom-message").count(), 0, "説明文が残っている");
    eq(await page.locator(".item-zoom-close").count(), 1, "閉じるボタンが無い");
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
    eq((await page.textContent(".item-zoom-message")).trim(), "模様が出てきたっぴ！");
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
  await test("I-07", "絵: 部屋が赤い時と通常時で説明文・仮枠の中身が変わる", async (page, h) => {
    await h.load(baseState({ playPart: 4, currentView: "roomB2", inventory: ["itemIllust"], everObtainedItems: ["itemIllust"] }));
    await h.tapItem("絵"); await h.tapItem("絵");
    eq((await page.textContent(".item-zoom-message")).trim(), "このままだと何もわからないっぴ～");
    ok(!(await page.textContent(".item-zoom-box")).includes("ESCAPE"), "通常時にESCAPEが見える");
    await page.mouse.click(30, 120); await page.waitForTimeout(WAIT);
    await h.click(page.locator(".item-zoom-close"));
    await h.tapItem("絵"); // 選択解除
    await h.tapSpot("電気スイッチ");
    eq(await h.readAll(), ["部屋が赤くなったっぴ"]);
    await h.tapItem("絵"); await h.tapItem("絵");
    eq((await page.textContent(".item-zoom-message")).trim(), "これを覚えとくっぴ！");
    ok((await page.textContent(".item-zoom-box")).includes("ESCAPE"), "赤い部屋でESCAPEが出ない");
  });
  await test("I-08", "アイテム選択中にクリックポイントで使用 → 消費され選択解除・SE", async (page, h) => {
    await h.load(baseState({ playPart: 2, currentView: "viewPitsujiDoor", inventory: ["itemChocolate"], everObtainedItems: ["itemChocolate"] }));
    await h.tapItem("チョコレート");
    await h.audioReset();
    await h.tapSpot("ドア下隙間");
    eq(await h.se(), [], "メッセージを読む前にSEが鳴った");
    eq(await h.readAll(), ["ここからシュッと入れるっぴ！", "チョコレートに釣られて動いた気配がするっぴ～！", "部屋に戻ってぴつじに脱出させるっぴ！"]);
    eq(await h.se(), ["Se_ChocoTrhow"]);
    eq(await h.inv(), []);
    eq(await h.selected(), []);
  });
  await test("I-09", "拡大表示を開いた直後の素早いタップでは説明文が消えない", async (page, h) => {
    await h.load(itemsState);
    await h.tapItem("焼かれた食パン");
    await h.item("焼かれた食パン").click();
    await page.mouse.click(30, 120); // 250ms以内の2打目
    eq(await page.locator(".item-zoom-message").count(), 1, "説明文を読む前に消えた");
  });
  await test("I-10", "ぴさぎの名刺: タップで表→裏→表と切り替わる。閉じるボタンは常に表示", async (page, h) => {
    await h.load(baseState({ playPart: 6, inventory: ["itemPisagiCard"], everObtainedItems: ["itemPisagiCard"] }));
    await h.tapItem("ぴさぎの名刺"); await h.tapItem("ぴさぎの名刺");
    const read = async () => [(await page.textContent(".item-zoom-message")).trim(), (await page.textContent(".item-zoom-box .modal-image-placeholder")).includes("7*27")];
    eq(await read(), ["ぴさぎは仕事人っぴ！", true]);
    ok(await page.locator(".item-zoom-close").isVisible(), "表で閉じるボタンが無い");
    await page.mouse.click(30, 120); await page.waitForTimeout(WAIT);
    eq(await read(), ["留守番電話にメッセージを残してください、ッピ……？", false]);
    await h.shot("I-10_card_back");
    await page.mouse.click(30, 120); await page.waitForTimeout(WAIT);
    eq(await read(), ["ぴさぎは仕事人っぴ！", true], "裏の次が表に戻らない");
    await h.click(page.locator(".item-zoom-close"));
    eq(await h.modalCount(), 0);
  });
  await test("I-11", "全アイテムの拡大表示で説明文が出る（空・undefined にならない）", async (page, h) => {
    const all = DATA.items.map((i) => i.id);
    await h.load(baseState({ playPart: 7, inventory: all, everObtainedItems: all }));
    for (const it of DATA.items) {
      await h.tapItem(it.name); await h.tapItem(it.name);
      const t = (await page.textContent(".item-zoom-message")).trim();
      ok(t && !/undefined|\[object/.test(t), `${it.name}: 説明文 "${t}"`);
      if (await page.locator(".item-zoom-close").count() === 0) { await page.mouse.click(30, 120); await page.waitForTimeout(WAIT); }
      if (await page.locator(".item-zoom-message").count() && !(await page.locator(".item-zoom-close").count())) { await page.mouse.click(30, 120); await page.waitForTimeout(WAIT); }
      await h.click(page.locator(".item-zoom-close"));
      await h.tapItem(it.name); // 選択解除
    }
  });

  // ===================== I-20〜: アイテム入手時の拡大画像・不正解位置での使用 =====================
  await test("I-20", "入手時: 拡大画像(アイテム名＋仮枠)が出て、タップで閉じると続きのメッセージへ進む", async (page, h) => {
    h.autoCloseGet = false;
    await h.load(baseState({ playPart: 3, currentView: "viewTable" }));
    await h.tapSpot("テーブルの上");
    eq(await page.locator(".item-get-box").count(), 1, "入手画像が出ない");
    eq((await page.textContent(".item-get-box .item-zoom-name")).trim(), "食パン");
    ok((await page.textContent(".item-get-box .modal-image-placeholder")).includes("食パン"), "仮枠にアイテム名が無い");
    eq(await h.msg(), "", "入手画像の表示中に次のメッセージが出ている");
    eq(await h.inv(), ["食パン"], "所持品に入っていない");
    await h.shot("I-20_item_get");
    await page.mouse.click(200, 700); await page.waitForTimeout(WAIT);
    eq(await h.modalCount(), 0, "タップで閉じない");
    eq(await h.readAll(), ["食べたいけどこれは謎のヒントっぴ～"]);
    eq(await h.selected(), [], "入手で選択状態になった");
  });
  await test("I-21", "入手画像: 開いた直後の素早いタップでは閉じない / ×でも閉じる / 取得済みの再タップでは出ない", async (page, h) => {
    h.autoCloseGet = false;
    await h.load(baseState({ playPart: 2, currentView: "viewRefrigerator" }));
    await h.spot("冷蔵庫").click();
    await page.mouse.click(200, 700);
    eq(await page.locator(".item-get-box").count(), 1, "開いた直後のタップで閉じた");
    await page.waitForTimeout(WAIT);
    await h.click(page.locator(".item-get-box .modal-close-btn"));
    eq(await h.modalCount(), 0, "×で閉じない");
    eq(await h.readAll(), ["ぴつじの好きなチョコレートっぴ！", "これをぴつじに渡すっぴ！"]);
    await h.tapSpot("冷蔵庫");
    eq(await h.modalCount(), 0, "取得済みなのに入手画像が出た");
    eq(await h.readAll(), ["つい開けてしまうっぴ……何も入ってないッピ"]);
  });
  await test("I-22", "変化アイテム: 食パンをトースターで使うと、焼き上がりの後に「焼かれた食パン」の入手画像", async (page, h) => {
    h.autoCloseGet = false;
    await h.load(baseState({ playPart: 3, currentView: "viewToaster", inventory: ["itemBread"], everObtainedItems: ["itemBread"] }));
    await h.useItem("食パン", "トースター");
    eq(await h.msg(), "パンを焼くっぴ～");
    await page.locator("#footer-message").click(); await page.waitForTimeout(WAIT);
    eq((await page.textContent(".item-get-box .item-zoom-name")).trim(), "焼かれた食パン");
    await page.mouse.click(200, 700); await page.waitForTimeout(WAIT);
    eq(await h.readAll(), ["お腹空いたけど食べる前にヒント見るっぴ！", "後で美味しくいただくっぴ～！"]);
    eq(await h.inv(), ["焼かれた食パン"]);
  });
  await test("I-23", "不正解位置: 選択中アイテムを正解位置以外で使っても消費されず、選択も外れない", async (page, h) => {
    const cases = [
      { st: { playPart: 2, currentView: "viewToaster", inventory: ["itemChocolate"] }, item: "チョコレート", spot: "トースター", id: "itemChocolate" },
      { st: { playPart: 2, currentView: "viewPitsujiDoor", inventory: ["itemChocolate"] }, item: "チョコレート", spot: "ドアノブ", id: "itemChocolate" },
      { st: { playPart: 3, currentView: "viewRefrigerator", inventory: ["itemBread"] }, item: "食パン", spot: "冷凍庫", id: "itemBread" },
      { st: { playPart: 5, currentView: "viewPitsujiDoor", inventory: ["itemCushion"] }, item: "クッション", spot: "ドア下隙間", id: "itemCushion" },
      { st: { playPart: 5, currentView: "viewBed", inventory: ["itemLargeTowel"] }, item: "タオルケット", spot: "ベッド下", id: "itemLargeTowel" },
      { st: { playPart: 7, currentView: "roomPiguma", inventory: ["itemTambourine"] }, item: "タンバリン", spot: "ぴぐま", id: "itemTambourine" }
    ];
    for (const c of cases) {
      await h.load(baseState({ ...c.st, everObtainedItems: [...c.st.inventory] }));
      await h.useItem(c.item, c.spot);
      await h.readAll();
      eq(await h.inv(), [c.item], `${c.spot}で${c.item}が消費された`);
      eq((await h.save()).itemUsageLog[c.id] || [], [], `${c.spot}で${c.item}が使用記録された`);
      eq(await h.selected(), [c.item], `${c.spot}で${c.item}の選択が外れた`);
    }
  });

  // ===================== N: 調査ノート =====================
  await test("N-01", "ノートを開くとページ1左の画像とメッセージ(SE)。タップで1右→2左→2右(各SE)", async (page, h) => {
    await h.load(baseState({ playPart: 2 }));
    await h.audioReset();
    await h.tapSpot("調査ノート");
    eq(await h.view(), "viewNote");
    ok((await page.textContent(".note-page")).includes("1ページ左"), "1左ではない");
    eq(await h.msg(), "調査によるとぴつじはチョコ好きっぴ");
    eq(await h.se(), ["Se_Note"], "開く時のSE");
    await h.shot("N-01_note_1left");
    const seen = [];
    for (let i = 0; i < 3; i++) { await h.click(page.locator(".note-page")); seen.push([(await page.textContent(".note-page")).split("\n")[0].trim(), await h.msg()]); }
    eq(seen, [["調査ノート 1ページ右", "ぴつじはふかふかも好きらしいっぴ"], ["調査ノート 2ページ左", "ぴつじの友達のぴさぎについても調べたっぴ"], ["調査ノート 2ページ右", "ぴつじの友達のぴぐまについても調べたっぴ"]]);
    eq((await h.se()).length, 4, "ページめくりSEの回数");
    eq(await page.locator(".arrow-btn").count(), 0, "ノートに矢印が出ている");
    ok(await page.locator(".note-close-btn").isVisible(), "閉じるボタンが無い");
  });
  await test("N-02", "PlayPart6: 2右で何度タップしても先へ進まない", async (page, h) => {
    await h.load(baseState({ playPart: 6 }));
    await h.tapSpot("調査ノート");
    for (let i = 0; i < 8; i++) await h.click(page.locator(".note-page"));
    ok((await page.textContent(".note-page")).includes("2ページ右"), "2右以外");
    eq(await h.inv(), []);
  });
  await test("N-03", "PlayPart7: 2右で3回タップ → 3左、写真入手。3左からは進まない", async (page, h) => {
    await h.load(baseState({ playPart: 7 }));
    await h.tapSpot("調査ノート");
    for (let i = 0; i < 3; i++) await h.click(page.locator(".note-page"));
    await h.click(page.locator(".note-page"));
    eq(await h.msg(), "貼り付いてて次のページが中々めくれないッピ");
    await h.click(page.locator(".note-page"));
    await h.click(page.locator(".note-page"));
    eq(await h.readAll(), ["次のページがめくれたっぴ！", "写真が張り付いててめくりにくかったっぴねえ", "パーティーしてる写真を手にいれたっぴ！"]);
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
  await test("N-07", "PlayPart1ではノート・パソコン・下矢印が出ない", async (page, h) => {
    await h.load(baseState({ playPart: 1 }));
    eq(await h.spot("調査ノート").count(), 0);
    eq(await h.spot("パソコン").count(), 0);
    eq(await page.locator(".arrow-btn").count(), 0);
  });

  // ===================== M: 開始時/表情タップ時メッセージ =====================
  const startMsgs = Object.fromEntries(DATA.playParts.map((p) => [p.id, p.startMessages]));
  await test("M-01", "各PlayPart開始時メッセージ(1〜8)", async (page, h) => {
    await h.load(null);
    eq(startMsgs[6], ["仕方ないッピ～", "ぴつじに詳しい人を呼びだすっぴ！！"], "資料と不一致");
    for (let p = 1; p <= 8; p++) {
      await page.evaluate(() => localStorage.clear());
      await page.reload(); await page.waitForSelector(".start-debug-btn");
      await h.click(page.locator(".start-debug-btn").filter({ hasText: new RegExp(`^PlayPart${p}$`) }));
      eq(await h.readAll(), startMsgs[p], `part${p}`);
    }
  });
  const faceRead = async (page, h, n) => { const got = []; for (let i = 0; i < n; i++) { await h.click(page.locator(".face-box")); got.push(...(await h.readAll())); } return got; };
  await test("M-02", "表情タップ: PlayPart1/8 固定、6 は2行ループ", async (page, h) => {
    await h.load(baseState({ playPart: 1 }));
    eq(await faceRead(page, h, 2), ["……", "……"]);
    await h.load(baseState({ playPart: 6 }));
    eq(await faceRead(page, h, 3), ["ぴつじの友達を呼び出してやるっぴ！", "友達のことは調査済みっぴ～", "ぴつじの友達を呼び出してやるっぴ！"]);
  });
  await test("M-03", "表情タップ: PlayPart2 チョコ入手前/入手後/使用後", async (page, h) => {
    const cases = [
      [{}, "ぴつじの好きな食べ物探すっぴ～"],
      [{ inventory: ["itemChocolate"], everObtainedItems: ["itemChocolate"] }, "ぴつじにこのチョコを渡すっぴ～"],
      [{ everObtainedItems: ["itemChocolate"], itemUsageLog: { itemChocolate: ["spotPitsujiDoorGap"] } }, "今度こそ脱出ゲームして貰うっぴ！やり直しっぴ！！"]
    ];
    for (const [over, exp] of cases) {
      await h.load(baseState({ playPart: 2, ...over }));
      eq(await faceRead(page, h, 1), [exp]);
    }
  });
  await test("M-04", "表情タップ: PlayPart3/4 解除前は3行ループ、解除後は固定", async (page, h) => {
    const d = {
      3: [["ドアの鍵開けるっぴ～", "暗証番号忘れたッピ", "この部屋にヒントがあるはずっぴ！"], "doorBUnlocked", "今度こそ脱出して貰うっぴ！三度目の正直っぴ！"],
      4: [["玄関の鍵開けるっぴ～", "チョコレートは無くてもどうにかなるはずっぴ", "がんばるっぴ～！"], "doorEntranceUnlocked", "今度こそ脱出っぴ！やるっぴよー！！"]
    };
    for (const p of [3, 4]) {
      const [cycle, flag, after] = d[p];
      await h.load(baseState({ playPart: p }));
      eq(await faceRead(page, h, 4), [...cycle, cycle[0]], `part${p} ループ`);
      await h.load(baseState({ playPart: p, flags: { [flag]: true } }));
      eq(await faceRead(page, h, 1), [after], `part${p} 解除後`);
    }
  });
  await test("M-05", "表情タップ: PlayPart5 渡す前(片方だけでも)は2行ループ、両方渡した後は固定", async (page, h) => {
    await h.load(baseState({ playPart: 5, itemUsageLog: { itemCushion: ["spotPitsujiWindow"] }, everObtainedItems: ["itemCushion"] }));
    eq(await faceRead(page, h, 3), ["ぴつじの元気を出すっぴ～", "ぴつじの好きな物は調査済みっぴ～！", "ぴつじの元気を出すっぴ～"]);
    await h.load(baseState({ playPart: 5, itemUsageLog: { itemCushion: ["spotPitsujiWindow"], itemLargeTowel: ["spotPitsujiWindow"] } }));
    eq(await faceRead(page, h, 2), ["今度こそいけるっぴ！ぴつじ脱出ゲームっぴ！！", "今度こそいけるっぴ！ぴつじ脱出ゲームっぴ！！"]);
  });
  await test("M-06", "表情: PlayPart8はぴつじ「楽しそうな音が聞こえてくるっぴ」／PlayPart1〜7は黒ぴぐま", async (page, h) => {
    await h.load(baseState({ playPart: 8, currentView: "roomPitsuji" }));
    ok((await page.textContent(".face-box")).startsWith("ぴつじ"), "表情がぴつじではない");
    eq(await faceRead(page, h, 1), ["楽しそうな音が聞こえてくるっぴ"]);
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
    await h.click(page.locator(".ff-btn"));
    await page.waitForTimeout(8000);
    eq((await h.save()).phase, "play", "最後まで早送りされない");
    eq((await h.save()).playPart, 3);
    eq(await h.readAll(), ["ドアの鍵を開けるっぴ！", "BGM The Da がオーディオに追加された", "BGM bo-tto がオーディオに追加された"], "早送りが操作パートのメッセージまで送ってしまった");
    ok((await h.maxBgm()) <= 1, "早送り中にBGMが二重再生");
  });
  await test("M-09", "表情タップ: PlayPart7 HAPPY追加前 / 追加後・変更前 / 変更後", async (page, h) => {
    await h.load(baseState({ playPart: 7 }));
    eq(await faceRead(page, h, 2), ["パーティーするっぴ！楽しい雰囲気作るっぴ～！", "パーティーするっぴ！楽しい雰囲気作るっぴ～！"]);
    await h.load(baseState({ playPart: 7, bgmState: { unlockedTracks: ["default", "happy"], currentTrack: "default" } }));
    eq(await faceRead(page, h, 3), ["さっきの音楽最高だったっぴ～！", "パーティーには楽しい音楽が欠かせないっぴ！", "さっきの音楽最高だったっぴ～！"]);
    await h.load(baseState({ playPart: 7, bgmState: { unlockedTracks: ["default", "happy"], currentTrack: "happy" } }));
    eq(await faceRead(page, h, 2), ["これなら賑やかでぴつじも目を覚ますっぴ！", "ぴつじの脱出ゲームが始まるっぴ！"]);
  });

  // ===================== S: 開始時メッセージ・設定ボタン =====================
  await test("S-01", "ストーリー中に設定ボタンが押せる(SE)。押してもストーリーは進まない", async (page, h) => {
    await h.load(null);
    await h.click(page.locator(".start-debug-btn").filter({ hasText: /^StoryPart1$/ }));
    const before = await h.storyText();
    await h.audioReset();
    await h.click(page.locator(".story-header .icon-btn"));
    eq(await h.modalCount(), 1, "設定が開かない");
    ok((await page.textContent(".modal-box")).includes("設定"), "設定モーダルではない");
    eq(await h.se(), ["Se_SelectIcon"], "設定ボタンのSE");
    await h.shot("S-01_story_settings");
    await h.click(page.locator(".modal-close-btn"));
    eq(await h.storyText(), before, "設定操作でストーリーが進んだ");
    await page.locator(".story-footer").click(); await page.waitForTimeout(100);
    ok((await h.storyText()) !== before, "設定を閉じた後にストーリーが進まない");
  });
  await test("S-02", "メッセージ表示中(開始時メッセージ以外)でもログ/ヒント/設定が開ける（メッセージは送られない・各SE）", async (page, h) => {
    await h.load(baseState({ playPart: 3 }));
    await h.click(page.locator(".face-box"));
    const m = await h.msg();
    ok(m.length > 0, "メッセージが出ていない");
    await h.audioReset();
    for (const label of ["ログ", "ヒント", "設定"]) {
      await h.click(page.locator(".header-icons .icon-btn").filter({ hasText: label }));
      eq(await h.modalCount(), 1, `${label}が開かない`);
      await h.click(page.locator(".modal-close-btn"));
    }
    eq(await h.msg(), m, "メッセージが送られた");
    eq(await h.se(), ["Se_SelectIcon", "Se_SelectIcon", "Se_SelectIcon"]);
  });
  await test("S-03", "開始時メッセージ中: 矢印・クリックポイント・所持品・表情・ログ・ヒントは反応せず、タップはメッセージ送り（SEも鳴らない）", async (page, h) => {
    await h.load(null);
    await h.click(page.locator(".start-debug-btn").filter({ hasText: /^PlayPart2$/ }));
    await h.audioReset();
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
    eq(await h.se(), [], "開始時メッセージ中にSEが鳴った");
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
    await page.locator('.header-icons [data-icon="settings"]').click();
    eq(await h.modalCount(), 1, "設定が開かない");
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
    // 開始時メッセージの後に、ストーリー2で流れたBGMがオーディオに追加されたことを知らせる
    eq(await h.msg(), "BGM The Da がオーディオに追加された");
    await h.arrow("▼");
    eq(await h.msg(), "BGM bo-tto がオーディオに追加された");
    await h.arrow("▼");
    eq(await h.view(), "viewDesk", "BGM追加のメッセージ中に移動できた");
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
  await test("S-07", "設定画面: SE/BGMの音量(大・中・小・消、初期値は中)と著作権表記(効果音ラボ様・OtoLogic様、サイト名のみ・リンクなし)が表示される", async (page, h) => {
    await h.load(baseState({ playPart: 3 }));
    await h.openSettings();
    const t = await page.textContent(".modal-box");
    ok(t.includes("効果音(SE)") && t.includes("BGM"), "音量設定が無い");
    for (const kind of ["効果音", "BGM"]) eq(await page.locator(".settings-row").filter({ hasText: kind }).locator(".settings-level").allTextContents(), ["大", "中", "小", "消"], kind);
    ok(t.includes("SE：効果音ラボ　様") && t.includes("BGM：OtoLogic　様"), "著作権表記が無い");
    ok(!/CC/.test(t), "CC表記がある");
    eq(await h.levels(), ["中", "中"], "初期値が中ではない");
    // 著作権表記はサイト名のみ。外部サイトへのリンク・URLは表示しない
    eq(await page.locator(".settings-credits a").count(), 0, "著作権表記にリンクがある");
    ok(!/https?:\/\//.test(t), "著作権表記にURLがある");
    await h.shot("S-07_settings");
  });

  // ===================== A: 操作パート6 =====================
  const p6 = (over = {}) => baseState({ playPart: 6, ...over });
  await test("A-01", "電話ギミック: 7*27は不在 / 他の番号は存在しない / #7*27で成功（入力は発信毎に消える・SE）", async (page, h) => {
    await h.load(p6({ currentView: "viewPhoneStand" }));
    await h.tapSpot("電話");
    ok((await page.textContent(".modal-box")).includes("ぴさぎを呼び出すっぴ！"), "起動メッセージが無い");
    await h.shot("A-01_phone");
    await h.audioReset();
    await h.dialPhone("7*27");
    ok((await page.textContent(".modal-box")).includes("ぴさぎは不在みたいだッピ"), "不在メッセージが無い");
    eq((await page.textContent(".gimmick-phone-display")).trim(), "", "発信後に番号が消えない");
    await h.dialPhone("123");
    ok((await page.textContent(".modal-box")).includes("「この番号は存在しない」ってメッセージが流れてるッピ"), "存在しない番号のメッセージが無い");
    eq((await h.save()).flags.phoneGimmickCleared, undefined, "失敗で解除");
    await h.dialPhone("#7*27");
    eq(await h.modalCount(), 0, "成功でギミックが閉じない");
    eq(await h.readAll(), ["ぴつじは預かってるっぴ", "速く助けにくるっぴ", "困ってるっぴ！"]);
    eq((await h.save()).phase, "play", "電話だけでクリアした");
    await h.tapSpot("電話");
    eq(await h.readAll(), ["あとはぴさぎが来るのを待つだけだっぴ～"]);
  });
  await test("A-02", "ゲーム画面: カメラ使用前は起動しない / ぴかくま選択→A/B選択(誤り→メッセージ、正解→メッセージ)→写真添付→送信 → 電話済みならストーリー6", async (page, h) => {
    await h.load(p6({ flags: { phoneGimmickCleared: true } }));
    await h.tapSpot("パソコン");
    eq(await h.readAll(), ["ぴぐまを呼び出す準備をするっぴ～", "悪戯じゃない証拠にぴつじの写真もつけるっぴ"]);
    eq(await h.modalCount(), 0, "カメラ使用前に起動した");
    await h.load(p6({ flags: { phoneGimmickCleared: true }, everObtainedItems: ["itemCamera"], itemUsageLog: { itemCamera: ["spotPitsujiWindow"] } }));
    await h.tapSpot("パソコン");
    eq(await h.modalCount(), 0, "メッセージを読む前にギミックが開いた");
    eq(await h.readAll(), ["ぴぐまを呼び出すっぴ！", "どうせならちょっと謎解きの要素も加えるっぴ～"]);
    eq(await h.modalCount(), 1, "メッセージを読んだ後にギミックが開かない");
    await h.chatGame("お寺", "サーカステント", false);
    ok((await page.textContent(".modal-box")).includes("これではこの場所が間違えて伝わってるっぴ"), "誤りメッセージが無い");
    ok(await page.locator(".gimmick-controls button").filter({ hasText: "送信" }).isDisabled(), "誤りで送信できる");
    await h.click(page.locator(".gimmick-chat-blank").first());
    await h.click(page.locator(".gimmick-chat-items .inventory-item").filter({ hasText: /^サーカステント$/ }));
    await h.click(page.locator(".gimmick-chat-blank").nth(1));
    await h.click(page.locator(".gimmick-chat-items .inventory-item").filter({ hasText: /^お寺$/ }));
    const t = await page.textContent(".modal-box");
    ok(t.includes("これで良しっぴ") && t.includes("あとは写真を添付してぴぐまを呼ぶっぴ"), "正解メッセージが無い");
    ok(await page.locator(".gimmick-controls button").filter({ hasText: "送信" }).isDisabled(), "写真なしで送信できる");
    await h.click(page.locator(".gimmick-controls button").filter({ hasText: "写真を添付" }));
    await h.shot("A-02_chat");
    await h.audioReset();
    await h.click(page.locator(".gimmick-controls button").filter({ hasText: "送信" }));
    eq(await h.modalCount(), 0, "ギミックが閉じない");
    eq(await h.msg(), "これでぴぐまを呼び出せたっぴ～");
    eq((await h.save()).phase, "play", "メッセージを読む前にストーリーへ移った");
    await page.locator("#footer-message").click(); await page.waitForTimeout(WAIT);
    eq((await h.save()).phase, "story", "ストーリーへ移らない");
    eq((await h.save()).storyPart, 6);
  });
  await test("A-03", "パソコン: ゲーム画面クリア後・電話前は「次はぴさぎ」メッセージ", async (page, h) => {
    await h.load(p6({ flags: { chatGimmickCleared: true } }));
    await h.audioReset();
    await h.tapSpot("パソコン");
    eq(await h.readAll(), ["これでぴぐまは呼び出せたっぴ！", "次はぴさぎを呼び出すっぴ～"]);
    eq(await h.se(), ["Se_ChangeSelect"]);
  });
  await test("A-04", "自動クリア待ちの間、他のクリックポイントは反応せずメッセージ送りになる", async (page, h) => {
    await h.load(p6({ currentView: "viewPhoneStand", flags: { chatGimmickCleared: true } }));
    await h.tapSpot("電話");
    await h.dialPhone("#7*27");
    eq(await h.msg(), "ぴつじは預かってるっぴ");
    await h.spot("電話台引き出し").click(); await page.waitForTimeout(WAIT);
    eq(await h.msg(), "速く助けにくるっぴ", "待機中に別スポットが反応した");
    await h.spot("電話台引き出し").click(); await page.waitForTimeout(WAIT);
    await h.spot("電話台引き出し").click(); await page.waitForTimeout(WAIT);
    eq((await h.save()).phase, "story", "メッセージ送りでストーリーへ移らない");
  });
  await test("A-05", "クリア条件達成後(メッセージ未読)にリロード → ストーリー6へ", async (page, h) => {
    await h.load(p6({ flags: { chatGimmickCleared: true, phoneGimmickCleared: true } }));
    eq((await h.save()).phase, "story");
  });
  await test("A-06", "カメラ: ベッド下で入手→小窓で使用(SE)→消える。段ボールは2回目で宛先画像", async (page, h) => {
    await h.load(p6({ currentView: "viewBed" }));
    await h.tapSpot("ベッド下");
    eq(await h.readAll(), ["カメラ見つけたっぴー！"]);
    await h.arrow("▼"); await h.arrow("▼"); await h.tapSpot("ぴつじ部屋のドア");
    await h.tapItem("カメラ");
    await h.audioReset();
    await h.tapSpot("ドア小窓");
    eq(await h.se(), ["Se_Camerea"]);
    eq(await h.readAll(), ["ぴつじの様子を撮影するピ", "証拠写真にするっぴ！"]);
    eq(await h.inv(), []);
    await h.arrow("▼");
    await h.tapSpot("段ボール箱");
    eq(await h.readAll(), ["下の段のダンボール見ればわかるっぴ～"]);
    await h.tapSpot("段ボール箱");
    ok((await page.textContent(".modal-box")).includes("隣に誤配された時の箱っぴ～"), "宛先画像に台詞が無い");
    await h.shot("A-06_cardboard");
  });

  // ===================== G: 操作パート7 =====================
  await test("G-01", "写真ギミック: ハズレは「ここじゃないっぴねえ」→両方選んで決定 → 買い出し(メッセージ・画像2枚)→マラカス・タンバリン入手", async (page, h) => {
    await h.load(baseState({ playPart: 7, currentView: "roomB1", inventory: ["itemPhoto"], everObtainedItems: ["itemPhoto"] }));
    eq(await h.readThrough(), [], "余計なメッセージ");
    await h.tapSpot("ぴさぎ");
    eq(await h.readAll(), ["「必要なものを買ってくるっぴ」って言ってるぴ", "「買うものの見た目を教えるっぴ」っぴ？"]);
    await h.useItem("写真", "ぴさぎ");
    const wrap = await page.locator(".gimmick-image-wrap").boundingBox();
    await page.mouse.click(wrap.x + 5, wrap.y + wrap.height - 5); await page.waitForTimeout(WAIT);
    ok((await page.textContent(".modal-box")).includes("ここじゃないっぴねえ"), "ハズレのメッセージが無い");
    for (const r of await page.locator(".gimmick-image-wrap .gimmick-key-hotspot").all()) await r.click();
    await h.click(page.locator(".gimmick-controls button").filter({ hasText: "決定" }));
    const seq = await h.readThrough();
    eq(seq.map((s) => s.replace(/×$/, "")), [
      "これとこれ、買ってきて欲しいっぴ！",
      "「ぴさぎに任せるっぴー！」って言って玄関から出てったっぴ",
      "[画像]風のように去るぴさぎ（画像仮）",
      "「ただいまっぴ～！」ぴさぎが帰って来たっぴ。",
      "速いっぴ。瞬足っぴ！",
      "[画像]マラカスとタンバリンを持ったぴさぎ（画像仮）",
      "なかなかやるっぴね！"
    ]);
    eq(h.gotItems, ["マラカス", "タンバリン"], "入手画像");
    eq(await h.inv(), ["マラカス", "タンバリン"]);
    await h.tapSpot("ぴさぎ");
    eq(await h.readAll(), ["ぴさぎがやる気に満ちた目で見てくるっぴ"]);
  });
  await test("G-02", "楽器: 逆に渡すと断られる → タンバリン(ぴさぎ)→マラカス(ぴぐま)でパーティー画像(台詞)→閉じると「BGM HAPPY がオーディオに追加された」→HAPPY選択可", async (page, h) => {
    await h.load(baseState({ playPart: 7, currentView: "roomB1", inventory: ["itemMaracas", "itemTambourine"], everObtainedItems: ["itemPhoto", "itemMaracas", "itemTambourine"], itemUsageLog: { itemPhoto: ["spotPisagi"] }, flags: { gimmickPhotoCleared: true } }));
    await h.useItem("マラカス", "ぴさぎ");
    eq(await h.readAll(), ["「ぴさぎはこっちじゃないっぴ！」って顔で見てるっぴ"]);
    await h.tapItem("マラカス"); // 選択解除（拡大→解除の順序のため2回）
    if ((await h.modalCount())) { await page.mouse.click(20, 80); await page.waitForTimeout(WAIT); if (await page.locator(".item-zoom-close").count()) await h.click(page.locator(".item-zoom-close")); await h.tapItem("マラカス"); }
    await h.tapItem("タンバリン");
    await h.audioReset();
    await h.tapSpot("ぴさぎ");
    eq(await h.se(), ["SE_TambourineRoll"]);
    eq(await h.readAll(), ["これを任せたっぴ！", "あとはぴぐまっぴ～！"]);
    await h.tapSpot("ぴさぎ");
    eq(await h.readAll(), ["楽しそうにタンバリン叩いてるっぴ～"]);
    await h.tapSpot("ドアA"); await h.arrow("▶"); await h.tapSpot("黒ぴぐま部屋のドア");
    await h.tapSpot("ぴぐま");
    eq(await h.readAll(), ["ぴぐまがわくわくしてるっぴ！"]);
    await h.tapItem("マラカス");
    await h.audioReset();
    await h.tapSpot("ぴぐま");
    eq(await h.msg(), "ぴぐまがマラカスを振り出したっぴ～");
    await page.locator("#footer-message").click(); await page.waitForTimeout(WAIT);
    eq(await h.se(), ["SE_MaracasRoll"], "マラカスSE");
    eq(await h.modalCount(), 1, "パーティー画像が出ない");
    ok((await page.textContent(".modal-box")).includes("のりのりだっぴ～！"), "画像の台詞が無い");
    await h.shot("G-02_party");
    await page.mouse.click(20, 80); await page.waitForTimeout(WAIT);
    eq(await h.readAll(), ["BGM HAPPY がオーディオに追加された", "最後に部屋を賑やかにするっぴ！"]);
    await h.tapSpot("ぴぐま");
    eq(await h.readAll(), ["マラカスのりのりだっぴ～"]);
    await h.arrow("▼"); await h.arrow("◀"); await h.tapSpot("ドアB"); await h.arrow("▶");
    await h.tapSpot("オーディオ");
    ok(!(await page.locator(".bgm-track-btn").filter({ hasText: "HAPPY" }).isDisabled()), "HAPPYが選べない");
    await h.click(page.locator(".bgm-track-btn").filter({ hasText: "HAPPY" }));
    eq((await h.save()).bgmState.currentTrack, "happy");
  });
  await test("G-03", "パーティー画像を開いたままリロード: HAPPYは追加済みで、画像は閉じた状態で再開", async (page, h) => {
    await h.load(baseState({ playPart: 7, currentView: "roomPiguma", inventory: ["itemMaracas"], everObtainedItems: ["itemMaracas", "itemTambourine"], itemUsageLog: { itemTambourine: ["spotPisagi"] }, flags: { gimmickPhotoCleared: true } }));
    await h.useItem("マラカス", "ぴぐま");
    await page.locator("#footer-message").click(); await page.waitForTimeout(WAIT);
    eq(await h.modalCount(), 1);
    await page.reload(); await page.waitForTimeout(800);
    eq(await h.modalCount(), 0, "リロード後もモーダルが残る");
    ok((await h.save()).bgmState.unlockedTracks.includes("happy"), "HAPPYが追加されていない");
    await h.tapSpot("ぴぐま");
    eq(await h.readAll(), ["マラカスのりのりだっぴ～"]);
  });

  // ===================== DB: ドアBの電子錠（果物の切替） =====================
  await test("DB-01", "ドアBの電子錠: ▲▼で果物が切り替わり(ループ)、果物ごとに数字の並びが変わる。切替で入力は消える", async (page, h) => {
    await h.load(baseState({ playPart: 3, currentView: "roomA1" }));
    await h.tapSpot("ドアBの電子錠");
    const keys = () => page.$$eval("button.gimmick-key-hotspot:not(.gimmick-selector-btn)", (els) => els.map((e) => e.textContent).join(""));
    const seen = [];
    for (let i = 0; i < 5; i++) {
      seen.push([await h.fruit(), await keys()]);
      await page.locator('.gimmick-selector-btn[data-dir="down"]').click();
    }
    eq(seen, [["ぶどう", "123456789"], ["バナナ", "357924618"], ["りんご", "419237865"], ["みかん", "987615324"], ["桃", "691582473"]]);
    eq(await h.fruit(), "ぶどう", "▼で先頭に戻らない");
    await page.locator('.gimmick-selector-btn[data-dir="up"]').click();
    eq(await h.fruit(), "桃", "▲で末尾に戻らない");
    await h.shot("DB-01_doorB_fruit");
    await page.locator("button.gimmick-key-hotspot").filter({ hasText: /^6$/ }).click();
    ok((await page.textContent(".gimmick-display")).includes("6"), "入力されない");
    await page.locator('.gimmick-selector-btn[data-dir="down"]').click();
    eq((await page.textContent(".gimmick-display")).replace(/\s/g, ""), "____", "果物を切り替えても入力が残る");
  });
  await test("DB-02", "ドアBの電子錠: りんご以外で3952は不正解 / りんごで3952は正解", async (page, h) => {
    await h.load(baseState({ playPart: 3, currentView: "roomA1" }));
    await h.tapSpot("ドアBの電子錠");
    for (const f of ["ぶどう", "バナナ", "みかん", "桃"]) {
      await h.doorB("3952", f);
      eq(await h.modalCount(), 1, `${f}で解除された`);
      eq((await page.locator(".gimmick-status").first().textContent()).trim(), "違ったッピ……", f);
      ok(!(await h.save()).flags.doorBUnlocked, `${f}で解除フラグ`);
    }
    await h.doorB("3952", "りんご");
    eq(await h.modalCount(), 0, "りんごで解除されない");
    ok((await h.save()).flags.doorBUnlocked, "解除フラグが立たない");
  });

  // ===================== C: クリックポイント位置 =====================
  await test("C-01", "部屋B1: ドアA/玄関ドア/電子錠 の位置", async (page, h) => {
    await h.load(baseState({ playPart: 4, currentView: "roomB1" }));
    await h.shot("C-01_roomB1");
    await h.tapSpot("玄関ドアの電子錠");
    ok((await page.textContent(".modal-box")).includes("玄関ドアの電子錠"), "電子錠ギミックが開かない");
    await h.shot("C-01_gimmickEntrance");
  });
  await test("C-02", "部屋B2: ローテーブル/ソファ の位置", async (page, h) => {
    await h.load(baseState({ playPart: 4, currentView: "roomB2" }));
    await h.shot("C-02_roomB2");
    await h.tapSpot("ローテーブル");
    eq(await h.view(), "viewLowTable");
  });
  await test("C-03", "黒ぴぐま部屋: ベッド・ぴぐまが重なっても両方タップ可", async (page, h) => {
    await h.load(baseState({ playPart: 7, currentView: "roomPiguma" }));
    await h.shot("C-03_roomPiguma");
    await h.tapSpot("ぴぐま");
    eq(await h.readAll(), ["ぴぐまがわくわくしてるっぴ！"]);
    await h.tapSpot("ベッド");
    eq(await h.view(), "viewBed");
  });
  await test("C-04", "玄関ドアギミック: 間違いで不正解 / ESCAPEで正解(SE Se_LockOpen・「開いたっぴ～」)", async (page, h) => {
    await h.load(baseState({ playPart: 4, currentView: "roomB1" }));
    await h.tapSpot("玄関ドアの電子錠");
    await h.entrance([0, 0, 0, 0, 0, 0]);
    eq(await page.locator(".gimmick-status").first().textContent(), "違ったッピ……");
    await h.audioReset();
    await h.entrance();
    eq(await h.modalCount(), 0);
    eq(await h.readAll(), ["開いたっぴ～"]);
    eq(await h.se(), ["Se_LockOpen"]);
    await h.tapSpot("玄関ドア");
    eq(await h.readAll(), ["ぴつじも楽々出られるっぴ！", "今度こそ脱出っぴ～！"]);
  });
  await test("C-05", "電気スイッチ(SE): 部屋B2で赤くすると部屋B1も赤い。ローテーブル拡大・部屋A1は赤くならない", async (page, h) => {
    await h.load(baseState({ playPart: 4, currentView: "roomB2" }));
    await h.audioReset();
    await h.tapSpot("電気スイッチ"); await h.readAll();
    eq(await h.se(), ["Se_Switch"]);
    eq(await page.locator(".scene-tint").count(), 1, "B2が赤くない");
    await h.arrow("◀");
    eq(await page.locator(".scene-tint").count(), 1, "B1が赤くない");
    await h.shot("C-05_roomB1_red");
    await h.tapSpot("ドアA");
    eq(await page.locator(".scene-tint").count(), 0, "部屋A1が赤い");
  });

  // ===================== SW: 全クリックポイント網羅（ブラウザ） =====================
  // 各操作パート×移動できる全視点で、表示されるクリックポイントが設計(ルール)どおりか、
  // タップして何らかの反応(メッセージ/画面移動/モーダル/ストーリー)があり、JSエラーが無いかを確認する。
  // アイテム選択ケース: 各クリックポイントに「使用対象外のアイテム」を選択してタップしても消費されないことも確認する。
  await test("SW-01", "全パート×全視点×全クリックポイントのタップ（未選択／使用対象外アイテム選択）", async (page, h) => {
    const ctxStub = { selectedItemId: null };
    const problems = [];
    let taps = 0;
    for (let p = 1; p <= 8; p++) {
      const probe = { playPart: p, flags: {}, everObtainedItems: [], itemUsageLog: {}, clickCounts: {}, bgmState: { unlockedTracks: ["default"], currentTrack: "default" }, inventory: [] };
      const views = DATA.views.filter((v) => v.layoutType === "play" && (!v.accessCondition || (v.accessCondition.playPart.gte || 0) <= p));
      for (const v of views) {
        const expected = v.spots.map((id) => DATA.spots.find((s) => s.id === id)).filter((s) => hasMatchingRule(s, { ...probe, currentView: v.id }, ctxStub));
        await h.load(baseState({ playPart: p, currentView: v.id }));
        const shown = await page.$$eval(".spot-hotspot, .spot-btn", (els) => els.map((e) => e.textContent));
        if (JSON.stringify(shown.sort()) !== JSON.stringify(expected.map((s) => s.label).sort())) problems.push(`part${p}/${v.id}: 表示 ${shown} / 期待 ${expected.map((s) => s.label)}`);
        for (const spot of expected) {
          for (const withItem of [false, true]) {
            const other = DATA.items.find((i) => !i.usableOn.includes(spot.id));
            await h.load(baseState({ playPart: p, currentView: v.id, inventory: withItem ? [other.id] : [], everObtainedItems: withItem ? [other.id] : [] }));
            if (withItem) await h.tapItem(other.name);
            const before = await h.save();
            await h.click(h.spot(spot.label));
            taps++;
            const after = await h.save();
            const reacted = (await h.msg()) || (await h.modalCount()) || after.currentView !== before.currentView || after.phase !== before.phase || after.inventory.length !== before.inventory.length;
            if (!reacted) problems.push(`part${p}/${v.id}/${spot.label}${withItem ? "/" + other.name : ""}: 反応なし`);
            if (withItem && after.phase === "play" && !after.inventory.includes(other.id)) problems.push(`part${p}/${spot.label}: 使用対象外の ${other.name} が消えた`);
            const m = await h.msg();
            if (/undefined|\[object/.test(m)) problems.push(`part${p}/${spot.label}: 不正な文言 ${m}`);
            if ((await h.maxBgm()) > 1) problems.push(`part${p}/${spot.label}: BGM二重再生`);
          }
        }
      }
    }
    ok(taps > 150, `タップ数が少ない ${taps}`);
    eq(problems.slice(0, 10), []);
  });

  // ===================== F: 通しプレイ（通常パス） =====================
  await test("F-01", "スタート→PlayPart1〜8→エンディングまで通しでクリア（BGMの切替・二重再生なし・セーブ容量）", async (page, h) => {
    await h.load(null);
    const part = async () => (await h.save()).playPart;
    const bgmLog = [];
    const noteBgm = async (label) => { bgmLog.push([label, (await h.bgm()).join("+")]); };
    await h.click(page.locator(".start-title"));
    await h.readAll();
    await h.tapSpot("配信用カメラ");
    await noteBgm("story1開始");
    await h.story(); await noteBgm("part2");
    // Part2
    eq(await part(), 2, "part2");
    await h.readAll();
    await h.arrow("▼"); await h.arrow("▼");
    await h.arrow("◀"); await h.tapSpot("冷蔵庫"); await h.tapSpot("冷蔵庫"); await h.readAll();
    await h.arrow("▼"); await h.arrow("▶"); await h.tapSpot("ぴつじ部屋のドア");
    await h.useItem("チョコレート", "ドア下隙間"); await h.readAll();
    await h.arrow("▼"); await h.tapSpot("黒ぴぐま部屋のドア"); await h.tapSpot("机"); await h.tapSpot("配信用カメラ");
    eq(await h.msg(), "始めるっぴ～！", "クリア時の台詞");
    await h.story(); await noteBgm("part3");
    // Part3
    eq(await part(), 3, "part3");
    await h.readAll();
    await h.arrow("▼"); await h.arrow("▼"); await h.tapSpot("壁の貼り紙"); await h.readAll();
    await h.arrow("◀"); await h.tapSpot("冷蔵庫"); await h.useItem("青い紙", "冷凍庫"); await h.readAll(); await h.arrow("▼");
    await h.tapSpot("テーブル"); await h.tapSpot("テーブルの上"); await h.readAll(); await h.arrow("▼");
    await h.tapSpot("トースター"); await h.useItem("食パン", "トースター"); await h.readAll(); await h.arrow("▼");
    eq((await h.inv()).sort(), ["冷凍後の青い紙", "焼かれた食パン"].sort());
    await h.tapSpot("ドアBの電子錠");
    await h.doorB();
    await h.readAll();
    await h.arrow("▶"); await h.tapSpot("黒ぴぐま部屋のドア"); await h.tapSpot("机"); await h.tapSpot("配信用カメラ"); await h.story(); await noteBgm("part4");
    // Part4
    eq(await part(), 4, "part4");
    eq(await h.inv(), [], "残存アイテムが消えない");
    await h.readAll();
    await h.arrow("▼"); await h.arrow("▼"); await h.arrow("◀"); await h.tapSpot("ドアB");
    eq(await h.view(), "roomB1");
    await h.tapSpot("電話台"); await h.tapSpot("電話台引き出し"); await h.readAll();
    await h.useItem("ブラックライト", "電話"); await h.readThrough(); await h.arrow("▼");
    await h.arrow("▶"); await h.tapSpot("ソファ"); await h.readAll(); await h.tapSpot("電気スイッチ"); await h.readAll();
    await h.tapSpot("ローテーブル"); await h.useItem("ブラックライト", "塩"); await h.readThrough(); await h.arrow("▼");
    await h.arrow("◀");
    await h.tapSpot("玄関ドアの電子錠");
    await h.entrance();
    await h.readAll();
    await h.tapSpot("ドアA"); await h.arrow("▶"); await h.tapSpot("黒ぴぐま部屋のドア"); await h.tapSpot("机"); await h.tapSpot("配信用カメラ"); await h.story(); await noteBgm("part5");
    // Part5
    eq(await part(), 5, "part5");
    await h.readAll();
    await h.arrow("▼"); await h.tapSpot("ベッド"); await h.tapSpot("ベッドマット"); await h.readAll(); await h.arrow("▼");
    await h.arrow("▼"); await h.tapSpot("棚"); await h.tapSpot("工具箱"); await h.readAll(); await h.arrow("▼");
    await h.arrow("◀"); await h.tapSpot("テーブル"); await h.tapSpot("椅子"); await h.readAll(); await h.arrow("▼"); await h.arrow("▶");
    await h.tapSpot("ぴつじ部屋のドア");
    await h.useItem("プラスドライバー", "ドア小窓"); await h.readAll();
    await h.useItem("クッション", "ドア小窓"); await h.readAll();
    await h.useItem("タオルケット", "ドア小窓"); await h.readAll();
    await h.arrow("▼"); await h.tapSpot("黒ぴぐま部屋のドア"); await h.tapSpot("机"); await h.tapSpot("配信用カメラ"); await h.story(); await noteBgm("part6");
    // Part6
    eq(await part(), 6, "part6");
    await h.readAll();
    await h.arrow("▼"); await h.tapSpot("本棚");
    eq(await h.readThrough(), ["名刺をしおり代わりにしてたっぴ！", "[画像]しおりが挟まっている本（画像仮）"], "本棚");
    await h.tapSpot("ベッド"); await h.tapSpot("ベッド下"); await h.readAll(); await h.arrow("▼");
    await h.arrow("▼"); await h.tapSpot("ぴつじ部屋のドア"); await h.useItem("カメラ", "ドア小窓"); await h.readAll(); await h.arrow("▼");
    await h.tapSpot("棚"); await h.tapSpot("引き出し"); await h.readAll(); await h.arrow("▼");
    await h.arrow("◀"); await h.tapSpot("ドアB"); await h.tapSpot("電話台"); await h.tapSpot("電話");
    await h.dialPhone("#7*27"); await h.readAll();
    eq(await part(), 6, "電話だけでクリア");
    await h.arrow("▼"); await h.tapSpot("ドアA"); await h.arrow("▶"); await h.tapSpot("黒ぴぐま部屋のドア"); await h.tapSpot("机");
    await h.tapSpot("パソコン"); await h.readAll();
    await h.chatGame("サーカステント", "お寺");
    await h.click(page.locator(".gimmick-controls button").filter({ hasText: "送信" }));
    await h.story(); await noteBgm("part7");
    // Part7
    eq(await part(), 7, "part7");
    eq(await h.inv(), [], "part7開始時に所持品が残っている");
    await h.readAll();
    await h.tapSpot("調査ノート");
    for (let i = 0; i < 6; i++) await h.click(page.locator(".note-page"));
    await h.readAll(); await h.click(page.locator(".note-close-btn"));
    eq(await h.inv(), ["写真"]);
    await h.arrow("▼"); await h.arrow("▼"); await h.arrow("◀"); await h.tapSpot("ドアB");
    await h.useItem("写真", "ぴさぎ");
    for (const r of await page.locator(".gimmick-image-wrap .gimmick-key-hotspot").all()) await r.click();
    await h.click(page.locator(".gimmick-controls button").filter({ hasText: "決定" }));
    await h.readThrough();
    eq(await h.inv(), ["マラカス", "タンバリン"]);
    await h.useItem("タンバリン", "ぴさぎ"); await h.readAll();
    await h.tapSpot("ドアA"); await h.arrow("▶"); await h.tapSpot("黒ぴぐま部屋のドア");
    await h.useItem("マラカス", "ぴぐま");
    await page.locator("#footer-message").click(); await page.waitForTimeout(WAIT);
    await noteBgm("パーティー画像表示中");
    await h.readThrough(); await noteBgm("パーティー画像を閉じた後");
    await h.arrow("▼"); await h.arrow("◀"); await h.tapSpot("ドアB"); await h.arrow("▶");
    await h.tapSpot("オーディオ");
    await h.click(page.locator(".bgm-track-btn").filter({ hasText: "HAPPY" })); await noteBgm("HAPPY選択後");
    await h.arrow("◀"); await h.tapSpot("ドアA"); await h.arrow("▶"); await h.tapSpot("黒ぴぐま部屋のドア"); await h.tapSpot("机"); await h.tapSpot("配信用カメラ");
    eq(await h.msg(), "最後の勝負っぴー！！");
    await h.story(); await noteBgm("part8");
    // Part8
    eq(await part(), 8, "part8");
    await h.readAll();
    await h.audioReset();
    await h.tapSpot("ぴつじ部屋の出口");
    for (let i = 0; i < 40; i++) { const s = await page.$(".story-footer"); if (!s) break; await s.click(); await page.waitForTimeout(30); }
    await page.waitForTimeout(WAIT);
    ok((await h.se()).includes("Se_DoorOpen1"), "ストーリー8のドアSEが鳴らない");
    eq((await h.save()).phase, "end", "エンディングに到達しない");
    ok((await page.textContent(".end-screen")).includes("おしまい"), "エンディング画面が出ない");
    const size = await page.evaluate((k) => localStorage.getItem(k).length, SAVE_KEY);
    ok(size < 4096, `セーブデータが大きい: ${size}`);
    await h.shot("F-01_ending");
    eq(bgmLog, [
      ["story1開始", "BGM_The Dark Eternal Night"], ["part2", "BGM_Candy Crush"], ["part3", "BGM_Candy Crush"],
      ["part4", "BGM_tie no wa"], ["part5", "BGM_tie no wa"], ["part6", "BGM_dotabatare-su slow"], ["part7", "BGM_dotabatare-su slow"],
      ["パーティー画像表示中", ""], ["パーティー画像を閉じた後", "BGM_dotabatare-su slow"], ["HAPPY選択後", ""], ["part8", ""]
    ], "BGMの流れ");
    ok((await h.maxBgm()) <= 1, "BGMが二重に流れた瞬間がある");
    await page.reload(); await page.waitForTimeout(WAIT);
    ok(await page.locator(".end-screen").count() === 1, "リロードでエンディング画面が復元されない");
    await h.click(page.locator(".end-back-btn"));
    ok(await page.locator(".start-screen .start-title").count() === 1, "タイトルに戻らない");
    eq(await h.save(), null, "セーブが消えていない");
    eq(await h.bgm(), [], "タイトルでBGMが止まらない");
  });

  // ===================== F: 2周目（リロードせずに「タイトルへ戻る」から遊び直す） =====================
  // 表情タップのループ位置は実行時のみの状態のため、リロードすれば必ず1行目に戻る。
  // 同じタブのまま2周目を始めた場合も1行目から表示されること（前回の続きにならないこと）を確認する。
  const faceTap = async (page, h) => { await h.click(page.locator(".face-box")); const t = await h.msg(); await h.readAll(); return t; };
  const P3_FACE = ["ドアの鍵開けるっぴ～", "暗証番号忘れたッピ", "この部屋にヒントがあるはずっぴ！"];
  // スタート画面 → PlayPart1 → PlayPart2 → PlayPart3（開始時メッセージを読み終えた状態）
  const playTitleToPart3 = async (page, h) => {
    await h.click(page.locator(".start-title"));
    await h.readAll();
    await h.tapSpot("配信用カメラ"); await h.story();
    eq((await h.save()).playPart, 2, "part2");
    await h.readAll();
    await h.arrow("▼"); await h.arrow("▼");
    await h.arrow("◀"); await h.tapSpot("冷蔵庫"); await h.tapSpot("冷蔵庫"); await h.readAll();
    await h.arrow("▼"); await h.arrow("▶"); await h.tapSpot("ぴつじ部屋のドア");
    await h.useItem("チョコレート", "ドア下隙間"); await h.readAll();
    await h.arrow("▼"); await h.tapSpot("黒ぴぐま部屋のドア"); await h.tapSpot("机"); await h.tapSpot("配信用カメラ"); await h.story();
    eq((await h.save()).playPart, 3, "part3");
    await h.readAll();
  };
  // PlayPart3(机拡大) → エンディング（F-01と同じ手順。リロードしない）
  const playPart3ToEnding = async (page, h) => {
    await h.arrow("▼"); await h.arrow("▼"); await h.tapSpot("壁の貼り紙"); await h.readAll();
    await h.arrow("◀"); await h.tapSpot("冷蔵庫"); await h.useItem("青い紙", "冷凍庫"); await h.readAll(); await h.arrow("▼");
    await h.tapSpot("テーブル"); await h.tapSpot("テーブルの上"); await h.readAll(); await h.arrow("▼");
    await h.tapSpot("トースター"); await h.useItem("食パン", "トースター"); await h.readAll(); await h.arrow("▼");
    await h.tapSpot("ドアBの電子錠"); await h.doorB(); await h.readAll();
    await h.arrow("▶"); await h.tapSpot("黒ぴぐま部屋のドア"); await h.tapSpot("机"); await h.tapSpot("配信用カメラ"); await h.story();
    eq((await h.save()).playPart, 4, "part4");
    await h.readAll();
    await h.arrow("▼"); await h.arrow("▼"); await h.arrow("◀"); await h.tapSpot("ドアB");
    await h.tapSpot("電話台"); await h.tapSpot("電話台引き出し"); await h.readAll();
    await h.useItem("ブラックライト", "電話"); await h.readThrough(); await h.arrow("▼");
    await h.arrow("▶"); await h.tapSpot("ソファ"); await h.readAll(); await h.tapSpot("電気スイッチ"); await h.readAll();
    await h.tapSpot("ローテーブル"); await h.useItem("ブラックライト", "塩"); await h.readThrough(); await h.arrow("▼");
    await h.arrow("◀"); await h.tapSpot("玄関ドアの電子錠"); await h.entrance(); await h.readAll();
    await h.tapSpot("ドアA"); await h.arrow("▶"); await h.tapSpot("黒ぴぐま部屋のドア"); await h.tapSpot("机"); await h.tapSpot("配信用カメラ"); await h.story();
    eq((await h.save()).playPart, 5, "part5");
    await h.readAll();
    await h.arrow("▼"); await h.tapSpot("ベッド"); await h.tapSpot("ベッドマット"); await h.readAll(); await h.arrow("▼");
    await h.arrow("▼"); await h.tapSpot("棚"); await h.tapSpot("工具箱"); await h.readAll(); await h.arrow("▼");
    await h.arrow("◀"); await h.tapSpot("テーブル"); await h.tapSpot("椅子"); await h.readAll(); await h.arrow("▼"); await h.arrow("▶");
    await h.tapSpot("ぴつじ部屋のドア");
    await h.useItem("プラスドライバー", "ドア小窓"); await h.readAll();
    await h.useItem("クッション", "ドア小窓"); await h.readAll();
    await h.useItem("タオルケット", "ドア小窓"); await h.readAll();
    await h.arrow("▼"); await h.tapSpot("黒ぴぐま部屋のドア"); await h.tapSpot("机"); await h.tapSpot("配信用カメラ"); await h.story();
    eq((await h.save()).playPart, 6, "part6");
    await h.readAll();
    await h.arrow("▼"); await h.tapSpot("本棚"); await h.readThrough();
    await h.tapSpot("ベッド"); await h.tapSpot("ベッド下"); await h.readAll(); await h.arrow("▼");
    await h.arrow("▼"); await h.tapSpot("ぴつじ部屋のドア"); await h.useItem("カメラ", "ドア小窓"); await h.readAll(); await h.arrow("▼");
    await h.tapSpot("棚"); await h.tapSpot("引き出し"); await h.readAll(); await h.arrow("▼");
    await h.arrow("◀"); await h.tapSpot("ドアB"); await h.tapSpot("電話台"); await h.tapSpot("電話");
    await h.dialPhone("#7*27"); await h.readAll();
    await h.arrow("▼"); await h.tapSpot("ドアA"); await h.arrow("▶"); await h.tapSpot("黒ぴぐま部屋のドア"); await h.tapSpot("机");
    await h.tapSpot("パソコン"); await h.readAll();
    await h.chatGame("サーカステント", "お寺");
    await h.click(page.locator(".gimmick-controls button").filter({ hasText: "送信" }));
    await h.story();
    eq((await h.save()).playPart, 7, "part7");
    await h.readAll();
    await h.tapSpot("調査ノート");
    for (let i = 0; i < 6; i++) await h.click(page.locator(".note-page"));
    await h.readAll(); await h.click(page.locator(".note-close-btn"));
    await h.arrow("▼"); await h.arrow("▼"); await h.arrow("◀"); await h.tapSpot("ドアB");
    await h.useItem("写真", "ぴさぎ");
    for (const r of await page.locator(".gimmick-image-wrap .gimmick-key-hotspot").all()) await r.click();
    await h.click(page.locator(".gimmick-controls button").filter({ hasText: "決定" }));
    await h.readThrough();
    await h.useItem("タンバリン", "ぴさぎ"); await h.readAll();
    await h.tapSpot("ドアA"); await h.arrow("▶"); await h.tapSpot("黒ぴぐま部屋のドア");
    await h.useItem("マラカス", "ぴぐま");
    await page.locator("#footer-message").click(); await page.waitForTimeout(WAIT);
    await h.readThrough();
    await h.arrow("▼"); await h.arrow("◀"); await h.tapSpot("ドアB"); await h.arrow("▶");
    await h.tapSpot("オーディオ");
    await h.click(page.locator(".bgm-track-btn").filter({ hasText: "HAPPY" }));
    await h.arrow("◀"); await h.tapSpot("ドアA"); await h.arrow("▶"); await h.tapSpot("黒ぴぐま部屋のドア"); await h.tapSpot("机"); await h.tapSpot("配信用カメラ");
    await h.story();
    eq((await h.save()).playPart, 8, "part8");
    await h.readAll();
    await h.tapSpot("ぴつじ部屋の出口");
    for (let i = 0; i < 40; i++) { const s = await page.$(".story-footer"); if (!s) break; await s.click(); await page.waitForTimeout(30); }
    await page.waitForTimeout(WAIT);
    eq((await h.save()).phase, "end", "エンディングに到達しない");
  };

  await test("F-02", "2周目: 1周目の表情タップのループ位置を持ち越さない（エンディング→タイトルへ戻る→スタート。リロードなし）", async (page, h) => {
    await h.load(baseState({ playPart: 3 }));
    eq(await faceTap(page, h), P3_FACE[0], "1周目1回目");
    eq(await faceTap(page, h), P3_FACE[1], "1周目2回目");
    await playPart3ToEnding(page, h);
    await h.click(page.locator(".end-back-btn"));
    await playTitleToPart3(page, h);
    eq(await faceTap(page, h), P3_FACE[0], "2周目1回目が1行目ではない");
    eq(await faceTap(page, h), P3_FACE[1], "2周目2回目");
    eq(await faceTap(page, h), P3_FACE[2], "2周目3回目");
    eq(await faceTap(page, h), P3_FACE[0], "2周目4回目(ループ)");
    await h.shot("F-02_face_2nd");
  });

  await test("F-03", "デバッグの直接ジャンプ: 同じタブで再ジャンプしても表情タップは1行目から（エンディング→タイトルへ戻る→再ジャンプ。リロードなし）", async (page, h) => {
    await h.load(null);
    await h.click(page.locator(".start-debug-btn").filter({ hasText: /^PlayPart3$/ }));
    await h.readAll();
    eq(await faceTap(page, h), P3_FACE[0], "1回目のジャンプ後1回目");
    eq(await faceTap(page, h), P3_FACE[1], "1回目のジャンプ後2回目");
    await playPart3ToEnding(page, h);
    await h.click(page.locator(".end-back-btn"));
    await h.click(page.locator(".start-debug-btn").filter({ hasText: /^PlayPart3$/ }));
    await h.readAll();
    eq(await faceTap(page, h), P3_FACE[0], "再ジャンプ後1回目が1行目ではない");
  });

  // ===================== AU: SE・BGM =====================
  await test("AU-01", "ストーリー1: 開始でThe Dark Eternal Night → 指定行でbo-tto_hidamariに切替。常に1曲だけ", async (page, h) => {
    await h.load(null);
    eq(await h.bgm(), [], "スタート画面でBGMが鳴っている");
    await h.click(page.locator(".start-debug-btn").filter({ hasText: /^StoryPart1$/ }));
    eq(await h.bgm(), ["BGM_The Dark Eternal Night"]);
    for (let i = 0; i < 40 && !(await h.storyText()).includes("･･････脱出しない"); i++) { await page.locator(".story-footer").click(); await page.waitForTimeout(60); }
    await page.waitForTimeout(200);
    eq(await h.bgm(), ["BGM_bo-tto_hidamari"]);
    ok((await h.maxBgm()) <= 1, "二重再生");
  });
  await test("AU-02", "操作パートのBGM: リロード・視点移動・ノート・モーダルで二重にならず、途中から流し直さない", async (page, h) => {
    await h.load(baseState({ playPart: 2 }));
    eq(await h.bgm(), ["BGM_Candy Crush"]);
    const plays = async () => page.evaluate(() => window.__audio.bgm().length);
    await h.arrow("▼"); await h.arrow("▼"); await h.arrow("◀"); await h.arrow("▶");
    await h.tapSpot("黒ぴぐま部屋のドア"); await h.tapSpot("机"); await h.tapSpot("調査ノート"); await h.click(page.locator(".note-close-btn"));
    await h.openSettings(); await h.click(page.locator(".modal-close-btn"));
    eq(await plays(), 1);
    await page.reload(); await page.waitForTimeout(600);
    eq(await h.bgm(), ["BGM_Candy Crush"]);
    ok((await h.maxBgm()) <= 1, "二重再生");
  });
  await test("AU-03", "BGM 消/中: 消で止まり、中に戻すと同じ曲が1つだけ流れる（素早く段階を切替しても二重にならない）", async (page, h) => {
    await h.load(baseState({ playPart: 4, currentView: "roomB2" }));
    await h.openSettings();
    await h.setLevel("BGM", "消");
    eq(await h.bgm(), [], "消で止まらない");
    const row = page.locator(".settings-row").filter({ hasText: "BGM" });
    for (const lv of ["中", "消", "大", "消", "小", "消"]) await row.locator(".settings-level").filter({ hasText: lv }).click();
    await h.setLevel("BGM", "中");
    await page.waitForTimeout(300);
    eq(await h.bgm(), ["BGM_tie no wa"]);
    ok((await h.maxBgm()) <= 1, "二重再生");
  });
  await test("AU-04", "SE 消: クリックポイント・所持品・アイコンのSEが鳴らない / 中で鳴る。設定はリロード後も保持", async (page, h) => {
    await h.load(baseState({ playPart: 4, currentView: "roomB2", inventory: ["itemIllust"] }));
    await h.openSettings();
    await h.setLevel("効果音", "消");
    await h.click(page.locator(".modal-close-btn"));
    await h.audioReset();
    await h.tapSpot("電気スイッチ"); await h.readAll(); await h.tapItem("絵"); await h.openSettings();
    eq(await h.se(), [], "消なのにSEが鳴った");
    await page.reload(); await page.waitForTimeout(WAIT);
    await h.openSettings();
    eq(await h.levels(), ["消", "中"], "リロードで設定が戻った");
    await h.setLevel("効果音", "中");
    await h.click(page.locator(".modal-close-btn"));
    await h.audioReset();
    await h.tapSpot("電気スイッチ");
    eq(await h.se(), ["Se_Switch"]);
  });
  await test("AU-05", "セーブデータ削除してもSE/BGM設定は残る", async (page, h) => {
    await h.load(baseState({ playPart: 3 }));
    await h.openSettings();
    await h.setLevel("BGM", "小");
    page.once("dialog", (d) => d.accept());
    await page.locator(".danger-btn").click();
    await page.waitForSelector(".start-screen");
    await h.click(page.locator(".start-title"));
    await h.openSettings();
    eq(await h.levels(), ["中", "小"]);
  });
  await test("AU-06", "メッセージの後のSEは、メッセージを送った時に鳴る（トースター: パンを焼く→焼く音→終わる音）", async (page, h) => {
    await h.load(baseState({ playPart: 3, currentView: "viewToaster", inventory: ["itemBread"], everObtainedItems: ["itemBread"] }));
    await h.tapItem("食パン");
    await h.audioReset();
    await h.tapSpot("トースター");
    eq(await h.msg(), "パンを焼くっぴ～");
    eq(await h.se(), [], "メッセージを読む前にSEが鳴った(未設定SEは記録されない)");
    eq(await h.readAll(), ["パンを焼くっぴ～", "お腹空いたけど食べる前にヒント見るっぴ！", "後で美味しくいただくっぴ～！"]);
  });
  await test("AU-07", "オーディオ: HAPPY(未設定)を選ぶと元のBGMが止まり、「通常」で元の曲が1つだけ再開", async (page, h) => {
    await h.load(baseState({ playPart: 7, currentView: "roomB2", bgmState: { unlockedTracks: ["default", "happy"], currentTrack: "default" } }));
    eq(await h.bgm(), ["BGM_dotabatare-su slow"]);
    await h.tapSpot("オーディオ");
    await h.click(page.locator(".bgm-track-btn").filter({ hasText: "HAPPY" }));
    eq(await h.bgm(), []);
    await h.tapSpot("オーディオ");
    await h.click(page.locator(".bgm-track-btn").filter({ hasText: "通常" }));
    eq(await h.bgm(), ["BGM_dotabatare-su slow"]);
    ok((await h.maxBgm()) <= 1, "二重再生");
  });
  await test("AU-08", "タブが裏に回るとBGMが止まり、戻ると再開する", async (page, h) => {
    await h.load(baseState({ playPart: 2 }));
    eq(await h.bgm(), ["BGM_Candy Crush"]);
    await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: true, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    eq(await h.bgm(), [], "裏でもBGMが鳴る");
    await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: false, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    await page.waitForTimeout(300);
    eq(await h.bgm(), ["BGM_Candy Crush"]);
  });
  await test("AU-09", "音声ファイルが404/遅延でもゲームは止まらず、タップの度に再試行を繰り返さない", async (page, h) => {
    await h.load(baseState({ playPart: 4, currentView: "roomB2" }));
    await h.tapSpot("電気スイッチ"); await h.readAll();
    await h.tapSpot("電気スイッチ");
    eq(await h.readAll(), ["元の色に戻ったっぴ"]);
    const fails = await page.evaluate(() => window.__audio.fails().length);
    ok(fails <= 3, `再生失敗が繰り返されている ${fails}`);
  }, { route: (page) => page.route("**/*.mp3", (r) => r.fulfill({ status: 404, body: "" })) });
  await test("AU-10", "連打: 同じSEのスポットを素早く連打しても、SEの重なりは抑えられる", async (page, h) => {
    await h.load(baseState({ playPart: 4, currentView: "roomB2" }));
    await h.audioReset();
    const box = await h.spot("電気スイッチ").boundingBox();
    for (let i = 0; i < 6; i++) await page.mouse.click(box.x + 5, box.y + 5);
    await page.waitForTimeout(WAIT);
    const n = (await h.se()).length;
    ok(n >= 1 && n <= 6, `SE回数 ${n}`);
    const s = await h.save();
    ok(typeof s.flags.roomLightRed === "boolean", "スイッチ状態が壊れた");
  });

  // ===================== MT: 複数タブ =====================
  await test("MT-01", "同じゲームを2つのタブで開き、片方で進めると、もう片方は操作を止めて再読み込みを促す（古い状態で上書きしない・BGM停止）", async (page, h, { context, watch }) => {
    await h.load(baseState({ playPart: 2, currentView: "viewRefrigerator" }));
    const page2 = await context.newPage();
    watch(page2);
    await page2.goto(BASE); await page2.waitForSelector(".header-icons"); await page2.waitForTimeout(WAIT);
    const h2 = helpers(page2);
    eq(await h2.bgm(), ["BGM_Candy Crush"]);
    await h.tapSpot("冷蔵庫");
    await page2.waitForTimeout(400);
    ok((await page2.textContent("#modal-root")).includes("別のタブ"), "もう片方のタブに通知が出ない");
    eq(await h2.bgm(), [], "もう片方のタブのBGMが止まらない");
    const saved = await h.save();
    await page2.locator(".face-box").click({ force: true }).catch(() => {});
    await page2.waitForTimeout(300);
    eq(await h.save(), saved, "古いタブが上書きした");
    ok(saved.inventory.includes("itemChocolate"), "進めたタブの状態が残っていない");
    await page2.locator("#modal-root button").filter({ hasText: "再読み込み" }).click();
    await page2.waitForSelector(".header-icons"); await page2.waitForTimeout(WAIT);
    eq(await h2.inv(), ["チョコレート"], "再読み込み後に最新状態にならない");
  });

  // ===================== E: 異常系 =====================
  await test("E-01", "Web応答が遅い(データ3秒遅延): 読み込み中表示 → 正常に開始", async (page, h) => {
    await page.goto(BASE);
    ok((await page.textContent("#app")).includes("読み込み中"), "読み込み中表示が無い");
    await page.waitForSelector(".start-screen", { timeout: 15000 });
    await h.click(page.locator(".start-title"));
    eq(await h.msg(), "さて……");
  }, { route: (page) => page.route("**/data/*.json", async (r) => { await new Promise((res) => setTimeout(res, 3000)); await r.continue(); }) });
  await test("E-02", "Web応答が返らない(タイムアウト): エラー表示と再読み込みボタン", async (page, h) => {
    await page.goto(BASE);
    await page.waitForSelector(".load-error", { timeout: 25000 });
    ok((await page.textContent(".load-error")).includes("タイムアウト"), "タイムアウト表示なし");
    ok(await page.locator("#app button").filter({ hasText: "再読み込み" }).isVisible(), "再読み込みボタンなし");
  }, { route: (page) => page.route("**/data/audio.json", () => {}), allowConsoleError: true });
  await test("E-03", "データ取得がサーバーエラー(500): エラー表示", async (page, h) => {
    await page.goto(BASE);
    await page.waitForSelector(".load-error", { timeout: 5000 });
    ok((await page.textContent(".load-error")).includes("500"), "ステータス表示なし");
  }, { route: (page) => page.route("**/data/credits.json", (r) => r.fulfill({ status: 500, body: "err" })), allowConsoleError: true });
  await test("E-04", "背景画像・音声が遅い(5秒遅延): 待ちの間も操作できる", async (page, h) => {
    await h.load(baseState({ playPart: 2 }));
    await h.arrow("▼");
    eq(await h.view(), "roomPiguma");
    await h.tapSpot("本棚");
    eq(await h.readAll(), ["脱出ゲーム作るためにたくさん本を読んだっぴ～"]);
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
  await test("E-06", "Cookie/サイトデータ無効(localStorage例外): 起動・プレイでき、設定に警告・SE/BGM切替も動く", async (page, h) => {
    await page.goto(BASE);
    await page.waitForSelector(".start-screen", { timeout: 5000 });
    await h.click(page.locator(".start-title"));
    eq(await h.readAll(), ["さて……"]);
    await h.tapSpot("配信用カメラ");
    ok(await page.locator(".story-footer").count() === 1, "ストーリーへ進まない");
    await h.click(page.locator(".story-header .icon-btn"));
    ok((await page.textContent(".modal-box")).includes("セーブされません"), "警告なし");
    await h.setLevel("BGM", "消");
    eq(await h.bgm(), [], "BGMが止まらない");
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
  await test("E-10", "連打: 配信用カメラを素早く10連打しても、ストーリーが1行目から始まる・BGMは1曲", async (page, h) => {
    await h.load(baseState({ playPart: 1 }));
    const box = await h.spot("配信用カメラ").boundingBox();
    for (let i = 0; i < 10; i++) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(WAIT);
    eq(await page.textContent(".story-footer div:last-child"), "ここは……？");
    ok((await h.maxBgm()) <= 1, "二重再生");
  });
  await test("E-11", "連打: 調査ノートをダブルタップしてもページ1左が飛ばされない", async (page, h) => {
    await h.load(baseState({ playPart: 3 }));
    const box = await h.spot("調査ノート").boundingBox();
    await page.mouse.click(box.x + 5, box.y + 5); await page.mouse.click(box.x + 5, box.y + 5);
    await page.waitForTimeout(WAIT);
    ok((await page.textContent(".note-page")).includes("1ページ左"), "1左が飛ばされた");
  });
  await test("E-12", "連打: 下矢印を素早く連打しても1画面分しか移動しない", async (page, h) => {
    await h.load(baseState({ playPart: 2 }));
    const box = await page.locator(".arrow-btn").boundingBox();
    for (let i = 0; i < 4; i++) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(WAIT);
    eq(await h.view(), "roomPiguma");
  });
  await test("E-13", "連打: 冷蔵庫(チョコ)を10連打してもチョコは1個・メッセージ破綻なし", async (page, h) => {
    await h.load(baseState({ playPart: 2, currentView: "viewRefrigerator" }));
    const box = await h.spot("冷蔵庫").boundingBox();
    for (let i = 0; i < 10; i++) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    eq(await h.inv(), ["チョコレート"]);
    eq((await h.save()).inventory, ["itemChocolate"]);
    ok((await h.modalCount()) <= 1, "入手画像が複数開いた");
    await h.closeGet();
    ok((await h.msg()).length > 0, "メッセージが空");
    eq(h.gotItems.length <= 1, true, "入手画像が2回以上出た");
  });
  await test("E-14", "連打: 電子錠Bの決定を連打しても成功処理は1回", async (page, h) => {
    await h.load(baseState({ playPart: 3, currentView: "roomA1" }));
    await h.tapSpot("ドアBの電子錠");
    await h.selectFruit("りんご");
    for (const d of ["3", "9", "5", "2"]) await page.locator("button.gimmick-key-hotspot").filter({ hasText: new RegExp(`^${d}$`) }).click();
    await page.locator(".gimmick-controls button").filter({ hasText: "決定" }).scrollIntoViewIfNeeded();
    const btn = await page.locator(".gimmick-controls button").filter({ hasText: "決定" }).boundingBox();
    for (let i = 0; i < 5; i++) await page.mouse.click(btn.x + 10, btn.y + 10);
    await page.waitForTimeout(WAIT);
    eq(await h.readAll(), ["カチッと音がして鍵が開いた", "ロックが解除されたっぴ！", "ぴつじを脱出させるっぴ！"]);
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
  await test("E-17", "連打: ゲーム画面の送信・電話の発信を連打しても成功は1回・ストーリーへ正常に移る", async (page, h) => {
    await h.load(p6({ flags: { phoneGimmickCleared: true }, itemUsageLog: { itemCamera: ["spotPitsujiWindow"] } }));
    await h.tapSpot("パソコン"); await h.readAll();
    await h.chatGame("サーカステント", "お寺");
    const b = await page.locator(".gimmick-controls button").filter({ hasText: "送信" }).boundingBox();
    for (let i = 0; i < 5; i++) await page.mouse.click(b.x + 10, b.y + 10);
    await page.waitForTimeout(WAIT);
    const s = await h.save();
    ok(s.phase === "story" || (await h.msg()) === "これでぴぐまを呼び出せたっぴ～", "状態が不正");
    eq(await h.modalCount(), 0);
    await h.story();
    eq((await h.save()).playPart, 7);
  });
  await test("E-18", "連打: ヒントの同じ行を連打しても1行しか開かない", async (page, h) => {
    await h.load(baseState({ playPart: 3 }));
    await h.click(page.locator(".header-icons .icon-btn").filter({ hasText: "ヒント" }));
    const first = await page.locator(".hint-line--masked").first().boundingBox();
    for (let i = 0; i < 4; i++) await page.mouse.click(first.x + 5, first.y + 5);
    await page.waitForTimeout(100);
    eq((await h.save()).hintRevealCounts["3"], 1);
    await page.locator(".hint-line--masked").first().click();
    eq((await h.save()).hintRevealCounts["3"], 2, "次の行が開かない");
  });
  await test("E-19", "楽器を渡す前はオーディオでHAPPYが選べない", async (page, h) => {
    await h.load(baseState({ playPart: 7, currentView: "roomB2" }));
    await h.tapSpot("オーディオ");
    ok(await page.locator(".bgm-track-btn").filter({ hasText: "HAPPY" }).isDisabled(), "HAPPYが選べる");
  });
  await test("E-20", "画面サイズが小さい端末(320x568)でもノート閉じるボタン・所持品・電話ギミックの発信が表示される", async (page, h) => {
    await h.load(baseState({ playPart: 6, currentView: "viewNote", inventory: ["itemPisagiCard"] }));
    ok(await page.locator(".note-close-btn").isVisible(), "閉じるボタンが見えない");
    const b = await page.locator(".note-close-btn").boundingBox();
    ok(b.y + b.height <= 568, "閉じるボタンが画面外");
    await h.shot("E-20_small_note");
    await h.load(baseState({ playPart: 6, currentView: "viewPhoneStand" }));
    await h.tapSpot("電話");
    await page.locator("button.gimmick-key-hotspot").filter({ hasText: "発信" }).scrollIntoViewIfNeeded();
    ok(await page.locator("button.gimmick-key-hotspot").filter({ hasText: "発信" }).isVisible(), "発信ボタンが見えない");
    await h.shot("E-20_small_phone");
  }, { context: { viewport: { width: 320, height: 568 } } });
  await test("E-21", "改ざん・破損したセーブ(型の不正・存在しないパート/アイテム/BGM・巨大な値)でも起動でき、不正な進行位置は破棄", async (page, h) => {
    const cases = [
      [baseState({ bgmState: null }), "play"],
      [baseState({ inventory: "itemChocolate", everObtainedItems: null, flags: [], clickCounts: "x" }), "play"],
      [baseState({ inventory: ["itemCD", "itemChocolate", "itemChocolate", 5] }), "play"],
      [baseState({ bgmState: { unlockedTracks: ["default", "evil"], currentTrack: "evil" } }), "play"],
      [baseState({ currentView: "viewNote", notePage: 99 }), "play"],
      [baseState({ playPart: 99 }), "start"],
      [baseState({ phase: "story", storyPart: "<img src=x onerror=alert(1)>" }), "start"],
      [baseState({ phase: "hacked" }), "start"],
      [baseState({ itemUsageLog: { itemChocolate: "spotPitsujiDoorGap" } }), "play"]
    ];
    for (const [s, expect] of cases) {
      await page.goto(BASE);
      await page.evaluate(([k, v]) => { localStorage.clear(); localStorage.setItem(k, JSON.stringify(v)); }, [SAVE_KEY, s]);
      await page.reload();
      await page.waitForSelector(".header-icons, .start-screen", { timeout: 5000 });
      await page.waitForTimeout(WAIT);
      const isStart = await page.locator(".start-screen").count();
      eq(isStart ? "start" : "play", expect, JSON.stringify(s).slice(0, 80));
      if (!isStart) {
        const inv = await h.inv();
        ok(inv.every((n) => typeof n === "string" && n.length), "所持品表示が壊れた");
        ok(new Set(inv).size === inv.length, "所持品が重複表示");
        await h.click(page.locator(".face-box"));
        ok((await h.msg()).length > 0, "操作できない");
      }
    }
  }, { allowConsoleError: true });
  await test("E-22", "長時間プレイ: ログは200件までで古いものから消える（ログ画面が重くならない）", async (page, h) => {
    await h.load(baseState({ playPart: 3 }));
    for (let i = 0; i < 260; i++) {
      await page.locator(".face-box").click();
      await page.locator("#footer-message").click();
    }
    await h.click(page.locator(".header-icons .icon-btn").filter({ hasText: "ログ" }));
    const n = await page.locator(".log-line").count();
    ok(n <= 200 && n >= 150, `ログ件数 ${n}`);
  });
  await test("E-23", "意図しない操作: ギミック表示中に×で閉じる／メッセージ途中で別スポット／画像表示中の連打でも状態が壊れない", async (page, h) => {
    await h.load(baseState({ playPart: 6, currentView: "viewPhoneStand" }));
    await h.tapSpot("電話");
    await page.locator("button.gimmick-key-hotspot").filter({ hasText: /^#$/ }).click();
    await h.click(page.locator(".modal-close-btn").first());
    eq(await h.modalCount(), 0, "×で閉じない");
    await h.tapSpot("電話");
    eq((await page.textContent(".gimmick-phone-display")).trim(), "", "閉じても入力が残る");
    await h.click(page.locator(".modal-close-btn").first());
    await h.arrow("▼"); await h.tapSpot("ドアA"); await h.arrow("▶"); await h.tapSpot("黒ぴぐま部屋のドア");
    await h.tapSpot("本棚");
    for (let i = 0; i < 8; i++) await page.mouse.click(200, 300);
    await page.waitForTimeout(WAIT);
    // 画像を開いた直後0.25秒のタップは無視する仕様（誤って閉じない）。重ならず、次のタップで閉じること
    ok((await h.modalCount()) <= 1, "画像が重なって開いた");
    if (await h.modalCount()) { await page.mouse.click(200, 300); await page.waitForTimeout(WAIT); }
    eq(await h.modalCount(), 0, "画像が閉じない");
    ok((await h.save()).inventory.filter((x) => x === "itemPisagiCard").length === 1, "名刺が重複");
  });

  // ===================== ST: ストーリー（ゲームストーリー.txt） =====================
  await test("ST-01", "ストーリー1: 背景画像(ぴつじ部屋/配信画面/黒画面/机)・立ち絵(配信中の黒ぴぐまは出さない)・BGM停止と再開", async (page, h) => {
    await h.load(null);
    await h.click(page.locator(".start-debug-btn").filter({ hasText: /^StoryPart1$/ }));
    const cur = async () => ({
      text: (await page.textContent(".story-footer div:last-child")).trim(),
      speaker: (await page.textContent(".speaker-name")).trim(),
      bg: await page.$eval(".story-main", (m) => { const i = m.querySelector(".scene-bg-img"); return i ? i.getAttribute("src").split("/").pop() : (m.classList.contains("story-main--black") ? "黒" : ""); }),
      portrait: await page.$$eval(".story-portraits .portrait-img, .story-portraits .portrait-box", (els) => els.map((e) => (e.getAttribute("src") || "仮").split("/").pop())),
      bgm: (await h.bgm()).join("+")
    });
    const seen = [];
    for (let i = 0; i < 40 && (await h.save()).phase === "story"; i++) {
      seen.push(await cur());
      if (["おはよう。気分はどうかな？", "え！？", "え･･････？！", "脱出ゲームは、始まったら脱出するものだっぴ！？！"].includes(seen.at(-1).text)) await h.shot("ST-01_" + i);
      await page.locator(".story-footer").click(); await page.waitForTimeout(80);
    }
    const at = (t) => seen.find((x) => x.text === t) || {};
    eq([at("ここは……？").bgm, at("ここは……？").portrait], ["BGM_The Dark Eternal Night", ["eto_remake_hitsuji.webp"]], "1行目");
    eq(at("さっきまで木陰でお昼寝してたような……").bg, "bg_pitsujiRoom1.webp");
    const hello = at("おはよう。気分はどうかな？");
    eq([hello.bg, hello.portrait], ["bg_storyStream.webp", []], "配信画面の黒ぴぐまに立ち絵が出ている");
    const e1 = seen.find((x) => x.text === "え！？");
    eq([e1.bg, e1.bgm, e1.portrait], ["bg_pitsujiRoom1.webp", "", []], "「え！？」でBGMが止まらない");
    eq(at("お、おはよう。気分はどうかな？").bgm, "BGM_The Dark Eternal Night", "BGMが再開しない");
    eq(at("･･････脱出しない").bgm, "BGM_bo-tto_hidamari");
    const cut = at("え･･････？！");
    eq([cut.bg, cut.portrait], ["黒", ["char_kuropiguma1.webp"]], "配信を切った後の黒画面");
    const desk = at("脱出ゲームは、始まったら脱出するものだっぴ！？！");
    eq([desk.bg, desk.portrait], ["bg_viewDesk.webp", ["char_kuropiguma1.webp"]], "机の背景＋黒ぴぐまの立ち絵");
    ok(!seen.some((x) => /\[BG\]/.test(x.text)), "台詞に[BG]が混ざった");
    ok((await h.maxBgm()) <= 1, "二重再生");
  });
  await test("ST-02", "ストーリーで流れたBGMが、次の操作パートの開始時メッセージの後に「BGM 〇〇 がオーディオに追加された」と表示され、オーディオで選べる", async (page, h) => {
    await h.load(null);
    await h.click(page.locator(".start-debug-btn").filter({ hasText: /^StoryPart3$/ }));
    for (let i = 0; i < 40 && (await h.save()).phase === "story"; i++) { await page.locator(".story-footer").click(); await page.waitForTimeout(40); }
    await page.waitForTimeout(WAIT);
    eq(await h.readAll(), [...startMsgs[4], "BGM The Da がオーディオに追加された", "BGM bo-tto がオーディオに追加された"]);
    eq((await h.save()).bgmState.unlockedTracks, ["default", "darkEternalNight", "hidamari"]);
    await h.arrow("▼"); await h.arrow("▼"); await h.arrow("◀"); await h.tapSpot("ドアB"); await h.arrow("▶");
    await h.tapSpot("オーディオ");
    eq(await page.locator(".bgm-track-btn").allTextContents(), ["通常", "HAPPY（未入手）", "The Da", "bo-tto"]);
    await h.shot("ST-02_audio");
    await h.click(page.locator(".bgm-track-btn").filter({ hasText: /^The Da$/ }));
    eq(await h.bgm(), ["BGM_The Dark Eternal Night"], "選んだ曲が流れない");
    // 既に追加済みのBGMは、次のストーリー後に再度知らせない
    await page.evaluate(() => localStorage.clear());
    await h.load(baseState({ phase: "story", storyPart: 4, playPart: 4, bgmState: { unlockedTracks: ["default", "darkEternalNight", "hidamari"], currentTrack: "default" } }));
    for (let i = 0; i < 40 && (await h.save()).phase === "story"; i++) { await page.locator(".story-footer").click(); await page.waitForTimeout(40); }
    await page.waitForTimeout(WAIT);
    eq(await h.readAll(), startMsgs[5], "追加済みのBGMを再度知らせた");
  });
  await test("ST-03", "オーディオでHAPPYを選んでいても、ストーリー7ではストーリーのBGM(The Dark Eternal Night)が流れる", async (page, h) => {
    await h.load(baseState({ phase: "story", storyPart: 7, playPart: 7, bgmState: { unlockedTracks: ["default", "happy"], currentTrack: "happy" } }));
    eq(await h.bgm(), ["BGM_The Dark Eternal Night"]);
    await page.locator(".story-footer").click(); await page.waitForTimeout(100);
    eq(await h.bgm(), [], "ハッピーな音楽(HAPPY・素材待ち)に切り替わらない");
    ok((await h.maxBgm()) <= 1, "二重再生");
  });
  await test("ST-04", "ストーリー8: 黒ぴぐまとぴつじの立ち絵が並ぶ／最後まで進むとエンディング", async (page, h) => {
    await h.load(null);
    await h.click(page.locator(".start-debug-btn").filter({ hasText: /^StoryPart8$/ }));
    for (let i = 0; i < 40 && !(await h.storyText()).includes("はっ！"); i++) { await page.locator(".story-footer").click(); await page.waitForTimeout(40); }
    eq(await page.locator(".story-portraits .portrait-img").count(), 2, "立ち絵が2枚並ばない");
    await h.shot("ST-04_two_portraits");
    for (let i = 0; i < 40 && (await h.save()).phase === "story"; i++) { await page.locator(".story-footer").click(); await page.waitForTimeout(40); }
    eq((await h.save()).phase, "end");
  });

  // ===================== AV: 音量（大・中・小・消） =====================
  await test("AV-01", "音量: 中=audio.jsonの基準音量(省略時0.6)、大=1.5倍(最大1)、小=0.5倍。BGMは流れている曲の音量がすぐ変わる", async (page, h) => {
    await h.load(baseState({ playPart: 4, currentView: "roomB2" }));
    eq(await page.evaluate(() => window.__audio.bgmVolume()), [0.6], "中");
    await h.openSettings();
    await h.setLevel("BGM", "大");
    eq(await page.evaluate(() => window.__audio.bgmVolume()), [0.9], "大");
    await h.setLevel("BGM", "小");
    eq(await page.evaluate(() => window.__audio.bgmVolume()), [0.3], "小");
    await h.audioReset();
    await h.setLevel("効果音", "大");
    await h.setLevel("効果音", "小");
    eq(await page.evaluate(() => window.__audio.seVolume()), [0.9, 0.3], "SEの音量(変更時に確認用のSEが鳴る)");
    await h.setLevel("効果音", "消");
    eq(await page.evaluate(() => window.__audio.seVolume()), [0.9, 0.3], "消でSEが鳴った");
  });
  await test("AV-02", "音量: 以前のON/OFF設定(true/false)は ON→中・OFF→消 として引き継ぐ", async (page, h) => {
    await page.goto(BASE);
    await page.evaluate(([k, sk, st]) => { localStorage.clear(); localStorage.setItem(k, JSON.stringify({ se: false, bgm: true })); localStorage.setItem(sk, JSON.stringify(st)); }, [AUDIO_KEY, SAVE_KEY, baseState({ playPart: 3 })]);
    await page.reload(); await page.waitForSelector(".header-icons"); await page.waitForTimeout(WAIT);
    await h.openSettings();
    eq(await h.levels(), ["消", "中"]);
  });

  // ===================== PC: ゲーム画面(チャット)ギミック =====================
  await test("PC-01", "ゲーム画面: 送り先は4択(ぴのくま/ぴりくま/ぴよくま/ぴかくま)、横にランキング。ぴかくま以外は進めない。下部の閉じるボタンで閉じられる", async (page, h) => {
    await h.load(p6({ everObtainedItems: ["itemCamera"], itemUsageLog: { itemCamera: ["spotPitsujiWindow"] } }));
    await h.tapSpot("パソコン"); await h.readAll();
    eq(await page.locator(".gimmick-friends-list .inventory-item").allTextContents(), ["ぴのくま", "ぴりくま", "ぴよくま", "ぴかくま"]);
    eq(await page.locator(".gimmick-ranking-line").allTextContents(), ["1. ぴかくま", "2. ぷるゃ", "3. 黒くま", "4. たぴおか"]);
    ok((await page.textContent(".gimmick-ranking")).includes("ランキング"), "ランキングの見出しが無い");
    const f = await page.locator(".gimmick-friends-list").boundingBox(), r = await page.locator(".gimmick-ranking").boundingBox();
    ok(r.x > f.x + f.width - 1, "ランキングが送り先の横にない");
    await h.shot("PC-01_friends");
    for (const wrong of ["ぴのくま", "ぴりくま", "ぴよくま"]) {
      await h.click(page.locator(".gimmick-friends-list .inventory-item").filter({ hasText: new RegExp(`^${wrong}$`) }));
      eq(await page.locator(".gimmick-chat-blank").count(), 0, `${wrong}で進めた`);
      ok((await page.textContent(".modal-box")).includes("この人じゃないっぴ……"), "間違いのメッセージが無い");
    }
    ok(await page.locator(".gimmick-close-btn").isVisible(), "フレンド選択画面に閉じるボタンが無い");
    await h.click(page.locator(".gimmick-friends-list .inventory-item").filter({ hasText: /^ぴかくま$/ }));
    ok((await page.textContent(".modal-box")).includes("送り先: ぴかくま"), "送り先が表示されない");
    eq(await page.locator(".gimmick-chat-blank").count(), 2, "チャット画面に進まない");
    await page.locator(".gimmick-close-btn").scrollIntoViewIfNeeded();
    ok(await page.locator(".gimmick-close-btn").isVisible(), "チャット画面の下部に閉じるボタンが無い");
    await h.shot("PC-01_chat_close");
    await h.click(page.locator(".gimmick-close-btn"));
    eq(await h.modalCount(), 0, "閉じるボタンで閉じない");
    ok(!(await h.save()).flags.chatGimmickCleared, "閉じただけで解除された");
    await h.tapSpot("パソコン"); await h.readAll();
    await h.click(page.locator(".modal-close-btn"));
    eq(await h.modalCount(), 0, "×で閉じない");
  });

  // ===================== PH: 写真ギミック =====================
  await test("PH-01", "写真ギミック: 写真画像(pic_tmp_gimmicPhoto)の上のマラカス・タンバリン位置が正解。見つけると〇で囲む", async (page, h) => {
    await h.load(baseState({ playPart: 7, currentView: "roomB1", inventory: ["itemPhoto"], everObtainedItems: ["itemPhoto"] }));
    await h.useItem("写真", "ぴさぎ");
    const img = page.locator(".gimmick-image-wrap img.gimmick-image");
    ok((await img.getAttribute("src")).endsWith("pic_tmp_gimmicPhoto.webp"), "写真画像ではない");
    ok(await img.evaluate((i) => i.complete && i.naturalWidth > 0), "写真画像が読み込めない");
    const w = await page.locator(".gimmick-image-wrap").boundingBox();
    // マラカス(左下)・タンバリン(右上)の位置をタップ
    await page.mouse.click(w.x + w.width * 0.12, w.y + w.height * 0.53); await page.waitForTimeout(WAIT);
    await page.mouse.click(w.x + w.width * 0.77, w.y + w.height * 0.14); await page.waitForTimeout(WAIT);
    eq(await page.locator(".gimmick-key-hotspot--circle").count(), 2, "正解位置が〇で囲まれない");
    await h.shot("PH-01_photo_found");
    ok(!(await page.locator(".gimmick-controls button").filter({ hasText: "決定" }).isDisabled()), "決定が押せない");
  });

  // ===================== SWI: 電気スイッチ（操作パート5〜7） =====================
  await test("SWI-01", "電気スイッチ(PlayPart6): 赤くなる→メッセージ→消す音→メッセージ→元の色。途中で別の操作をしても赤いまま残らない", async (page, h) => {
    await h.load(baseState({ playPart: 6, currentView: "roomB2" }));
    await h.audioReset();
    await h.tapSpot("電気スイッチ");
    eq([await h.msg(), await page.locator(".scene-tint").count()], ["これじゃ見にくいッピ", 1], "赤くならない");
    await h.shot("SWI-01_red");
    await page.locator("#footer-message").click(); await page.waitForTimeout(WAIT);
    eq([await h.msg(), await page.locator(".scene-tint").count()], ["元の電気に戻すっぴ～", 1]);
    eq(await h.se(), ["Se_Switch", "Se_Switch"], "消す時のSE");
    await page.locator("#footer-message").click(); await page.waitForTimeout(WAIT);
    eq(await page.locator(".scene-tint").count(), 0, "元の色に戻らない");
    ok(!(await h.save()).flags.roomLightRed, "セーブが赤いまま");
    // メッセージ途中で矢印・別スポットをタップしても、演出を飛ばして赤いまま残ることはない
    await h.tapSpot("電気スイッチ");
    await h.arrow("◀");
    await h.tapSpot("ローテーブル");
    await h.readAll();
    await page.waitForTimeout(WAIT);
    ok(!(await h.save()).flags.roomLightRed, "途中操作で赤いまま残った");
  });
  await test("SWI-02", "ベッド(PlayPart6)はタオルケットの無い差分背景", async (page, h) => {
    await h.load(baseState({ playPart: 6, currentView: "viewBed" }));
    ok((await page.getAttribute(".scene-bg-img", "src")).endsWith("bg_viewBedDiff.webp"), "差分背景ではない");
  });

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "OK  " : "NG  "} ${r.id} ${r.title}${r.ok ? "" : "\n       → " + r.err}`);
  console.log(`\n${results.length}件中 ${results.length - failed.length}件OK / ${failed.length}件NG`);
  process.exitCode = failed.length ? 1 : 0;
})();
