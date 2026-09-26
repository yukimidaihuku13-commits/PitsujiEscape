// rules.test.mjs
// 設計資料(ゲームクリックポイント.txt / ゲームシステム.txt)の各分岐を、データ(spots.json等)と
// エンジン(js/engine)に対して直接検証するデバッグ用テスト。ブラウザ不要。
//   実行: node debug/rules.test.mjs   （プロジェクトのルートで）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

// SaveManagerがlocalStorageを使うため、Node上ではメモリ上のスタブで代用する。
const mem = {};
globalThis.localStorage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; }
};

const { createInitialState } = await imp("js/state/GameState.js");
const { Engine } = await imp("js/engine/ActionExec.js");
const { resolveActions, hasMatchingRule, resolveMessage } = await imp("js/engine/RuleResolver.js");
const { evaluate } = await imp("js/engine/ConditionEval.js");

const load = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", f), "utf8"));
const keyBy = (list) => Object.fromEntries(list.map((x) => [x.id ?? x.playPart, x]));
const data = {
  itemsById: keyBy(load("items.json")),
  viewsById: keyBy(load("views.json")),
  spotsById: keyBy(load("spots.json")),
  playPartsById: keyBy(load("playParts.json")),
  storyPartsById: keyBy(load("storyParts.json")),
  gimmicksById: keyBy(load("gimmicks.json")),
  hintsById: keyBy(load("hints.json")),
  bgmById: keyBy(load("bgm.json")),
  transitions: load("transitions.json"),
  audio: load("audio.json")
};

/** 状態を作り、Engineとイベント記録用のUIを用意する */
function setup({ part = 2, view = null, items = [], ever = [], used = {}, flags = {}, clicks = {}, selected = null, bgm = null, notePage = 0 } = {}) {
  const state = createInitialState();
  state.phase = "play";
  state.playPart = part;
  state.currentView = view || data.playPartsById[part].startView;
  state.inventory = [...items];
  state.everObtainedItems = [...new Set([...items, ...ever, ...Object.keys(used)])];
  state.itemUsageLog = JSON.parse(JSON.stringify(used));
  state.flags = { ...flags };
  state.clickCounts = { ...clicks };
  state.notePage = notePage;
  if (bgm) { state.bgmState.unlockedTracks.push(bgm); state.bgmState.currentTrack = bgm; }
  const ctx = { selectedItemId: selected };
  const log = { msgs: [], se: [], gimmick: [], image: [], imageOpts: [], obtained: [], story: [], bgmMenu: 0, autoClear: 0, seq: [] };
  const ui = {
    queueMessage: (t) => { log.msgs.push(t); log.seq.push("msg:" + t); },
    playSE: (id) => { log.se.push(id); log.seq.push("se:" + id); },
    setFlagInOrder: (flag, value) => { state.flags[flag] = value; log.seq.push(`flag:${flag}=${value}`); },
    openGimmick: (id) => log.gimmick.push(id),
    closeGimmick: () => {},
    enterStoryPart: (id) => log.story.push(id),
    enterPlayPart: () => {},
    enterEnding: () => log.story.push("end"),
    showImageModal: (o) => { log.image.push(o.caption); log.imageOpts.push(o); },
    showObtainedItem: (id) => { log.obtained.push(id); log.seq.push("obtain:" + id); },
    openBgmMenu: () => log.bgmMenu++,
    requestRender: () => {},
    scheduleAutoClear: () => log.autoClear++
  };
  const engine = new Engine(state, data, ctx, ui);
  return { state, ctx, log, engine };
}

function tap(env, spotId) {
  const spot = data.spotsById[spotId];
  if (!spot) throw new Error(`spotがありません: ${spotId}`);
  const actions = resolveActions(spot, env.state, env.ctx);
  env.engine.runActions(actions, spotId);
  return env;
}
function visible(env, spotId) {
  return hasMatchingRule(data.spotsById[spotId], env.state, env.ctx);
}
function notePageTap(env) {
  const view = data.viewsById[env.state.currentView];
  const page = view.pages[env.state.notePage];
  env.engine.runActions(resolveActions({ rules: page.onTap }, env.state, env.ctx), page.id);
}
const notePageId = (env) => data.viewsById[env.state.currentView].pages[env.state.notePage].id;

// ---- ミニテストランナー ----
const results = [];
function test(id, title, fn) {
  try {
    fn();
    results.push({ id, title, ok: true });
  } catch (e) {
    results.push({ id, title, ok: false, err: e.message });
  }
}
function eq(actual, expected, label = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label} 期待値: ${b} / 実際: ${a}`);
}
function ok(cond, label) { if (!cond) throw new Error(label); }

// =====================================================================
// R: クリックポイント毎の全分岐（ゲームクリックポイント.txt）
// =====================================================================
const RANDOM_BOOKS = ["クローズド・サークルといえばアガサクリスティっぴ", "シャーロック・ホームズは名作だっぴねぇ"];
test("R-01", "本棚 PlayPart3: 4行を順に表示し、5回目で1行目に戻る", () => {
  const env = setup({ part: 3, view: "roomPiguma" });
  for (let i = 0; i < 5; i++) tap(env, "spotBookshelf");
  eq(env.log.msgs, ["「インクについて」という本だっぴ", "「温めると文字が消える。」", "「冷やすと文字が消える。」", "謎を作る時に参考にした本っぴ", "「インクについて」という本だっぴ"]);
});
test("R-02", "本棚 PlayPart4: 7行を順に表示し、8回目で1行目に戻る（PlayPart3のカウントを引き継がない） / PlayPart5", () => {
  const env = setup({ part: 4, view: "roomPiguma", clicks: { spotBookshelf: 2 } });
  for (let i = 0; i < 9; i++) tap(env, "spotBookshelf");
  eq(env.log.msgs, [
    "ホームズの冒険「踊る人形」は好きな本だっぴ～！", "送られてくる手紙が全部踊る人形文字で書かれてるんだっぴ～", "簡単に解読するホームズは凄いっぴ～",
    "こっちは英語辞書っぴ。しおりが挟んであるっぴ", "塩はSoltじゃなくてSaltっぴ", "電話はPhone、チョコはChocolateっぴ", "英語嫌いだけど謎作るために頑張って調べたッピ！",
    "ホームズの冒険「踊る人形」は好きな本だっぴ～！", "送られてくる手紙が全部踊る人形文字で書かれてるんだっぴ～"
  ]);
  eq(env.log.se, Array(9).fill("Se_Note"), "タップ毎のSE");
  eq(tap(setup({ part: 5, view: "roomPiguma" }), "spotBookshelf").log.msgs, ["ぴつじが好きそうな本は取り揃えてないっぴねえ"]);
});
test("R-03", "本棚 PlayPart6: 名刺入手（メッセージ・SE・本の画像）", () => {
  const env = tap(setup({ part: 6, view: "roomPiguma" }), "spotBookshelf");
  eq(env.log.msgs, ["名刺をしおり代わりにしてたっぴ！"]);
  eq(env.log.se, ["Se_Note", "パラッと名刺が落ちてくる音"]);
  eq(env.log.image.length, 1, "画像表示");
  ok(env.state.inventory.includes("itemPisagiCard"), "名刺を所持していない");
});
test("R-04", "本棚 PlayPart6の名刺入手後: 説明書入手前は説明書類のメッセージ、入手後・PlayPart7は2種のどちらかをランダム表示", () => {
  eq(tap(setup({ part: 6, view: "roomPiguma", ever: ["itemPisagiCard"] }), "spotBookshelf").log.msgs, ["説明書類はどこかに移動したっぴねえ"]);
  for (const opt of [{ part: 6, ever: ["itemPisagiCard", "itemPhoneManual"] }, { part: 7 }]) {
    const env = setup({ view: "roomPiguma", ...opt });
    for (let i = 0; i < 20; i++) tap(env, "spotBookshelf");
    const set = new Set(env.log.msgs);
    ok([...set].every((m) => RANDOM_BOOKS.includes(m)), [...set].join("/"));
    ok(set.size === 2, "20回で2種とも出ていない（乱数の偏り。再実行で確認）");
  }
});
test("R-05", "本棚 その他のパート(2)", () => {
  eq(tap(setup({ part: 2, view: "roomPiguma" }), "spotBookshelf").log.msgs, ["脱出ゲーム作るためにたくさん本を読んだっぴ～"]);
});
test("R-06", "ベッド: PlayPart1は非表示、2以降はベッド拡大へ", () => {
  ok(!visible(setup({ part: 1, view: "roomPiguma" }), "spotBed"), "part1で表示されている");
  const env = tap(setup({ part: 2, view: "roomPiguma" }), "spotBed");
  eq(env.state.currentView, "viewBed");
});
test("R-07", "ぴぐま: PlayPart7のみ表示。マラカス/タンバリン選択時の分岐", () => {
  for (const p of [2, 3, 4, 5, 6, 8]) ok(!visible(setup({ part: p, view: "roomPiguma" }), "spotPiguma"), `part${p}で表示`);
  eq(tap(setup({ part: 7, view: "roomPiguma" }), "spotPiguma").log.msgs, ["ぴぐまがわくわくしてるっぴ！"]);
  // タンバリンはぴぐまには渡せない
  const et = tap(setup({ part: 7, view: "roomPiguma", items: ["itemTambourine"], selected: "itemTambourine" }), "spotPiguma");
  eq(et.log.msgs, ["「こっちじゃないッピ！」って言ってるぴ～"]);
  eq(et.state.inventory, ["itemTambourine"], "タンバリンが消費された");
  // マラカス使用後
  const eu = tap(setup({ part: 7, view: "roomPiguma", used: { itemMaracas: ["spotPiguma"] } }), "spotPiguma");
  eq(eu.log.msgs, ["マラカスのりのりだっぴ～"]);
  eq(eu.log.se, ["SE_MaracasRoll"]);
  // ぴさぎにタンバリンを渡す前: マラカスを渡すだけ
  const e1 = tap(setup({ part: 7, view: "roomPiguma", items: ["itemMaracas"], selected: "itemMaracas" }), "spotPiguma");
  eq(e1.log.msgs, ["ぴぐまがマラカスを振り出したっぴ～", "ぴさぎも楽器やりたそうっぴ～"]);
  eq(e1.log.se, ["SE_MaracasRoll"]);
  eq(e1.state.inventory, []);
  eq(e1.log.image.length, 0, "片方だけでパーティー画像が出た");
  ok(!e1.state.bgmState.unlockedTracks.includes("happy"), "片方だけでHAPPYが追加された");
  // ぴさぎにタンバリンを渡した後: パーティー画像(BGM HAPPY)→HAPPY追加
  const e2 = tap(setup({ part: 7, view: "roomPiguma", items: ["itemMaracas"], used: { itemTambourine: ["spotPisagi"] }, selected: "itemMaracas" }), "spotPiguma");
  eq(e2.log.msgs, ["ぴぐまがマラカスを振り出したっぴ～", "BGM HAPPY がオーディオに追加された", "最後に部屋を賑やかにするっぴ！"]);
  eq(e2.log.imageOpts.map((o) => [o.text, o.bgm]), [["のりのりだっぴ～！", "happy"]]);
  ok(e2.state.bgmState.unlockedTracks.includes("happy"), "HAPPYが追加されない");
  eq(e2.state.bgmState.currentTrack, "default", "画像を閉じた後のBGMが元に戻らない");
});
test("R-08", "パソコン: PlayPart1非表示 / 6のカメラ使用前・後・クリア後 / その他", () => {
  ok(!visible(setup({ part: 1 }), "spotGame"), "part1で表示");
  const e0 = tap(setup({ part: 6 }), "spotGame");
  eq(e0.log.gimmick, [], "カメラ使用前にギミックが開いた");
  eq(e0.log.msgs, ["ぴぐまを呼び出す準備をするっぴ～", "悪戯じゃない証拠にぴつじの写真もつけるっぴ"]);
  const e6 = tap(setup({ part: 6, used: { itemCamera: ["spotPitsujiWindow"] } }), "spotGame");
  eq(e6.log.gimmick, ["gimmickPcGame"]);
  eq(e6.log.se, ["Se_ChangeSelect", "ゲーム開始っぽい音"]);
  eq(e6.log.msgs, ["ぴぐまを呼び出すっぴ！", "どうせならちょっと謎解きの要素も加えるっぴ～"]);
  eq(tap(setup({ part: 6, flags: { chatGimmickCleared: true } }), "spotGame").log.msgs, ["これでぴぐまは呼び出せたっぴ！", "次はぴさぎを呼び出すっぴ～"]);
  for (const p of [2, 3, 4, 5, 7]) eq(tap(setup({ part: p }), "spotGame").log.msgs, ["今はゲームの時じゃないッピ...！"], `part${p}`);
});
test("R-09", "配信用カメラ: 各パートの未達メッセージ", () => {
  const cases = [
    [2, {}, ["ぴつじのやる気を出して脱出させるっぴ～"]],
    [2, { ever: ["itemChocolate"] }, ["チョコでぴつじのやる気を出すっぴ～"]],
    [3, {}, ["ぴつじを脱出させるっぴ～！！"]],
    [4, {}, ["ぴつじとの勝負っぴ！", "部屋から絶対出してみせるっぴ！！！"]],
    [5, {}, ["なかなか手強いッピね……"]],
    [5, { used: { itemCushion: ["spotPitsujiWindow"] } }, ["なかなか手強いッピね……"]],
    [6, {}, ["ぴつじが寝てるから無理ッピ……"]],
    [6, { flags: { phoneGimmickCleared: true } }, ["ぴつじが寝てるから無理ッピ……"]],
    [7, {}, ["最後の勝負っぴ。ぴつじを部屋から脱出させるっぴ！"]],
    [7, { bgmUnlockedOnly: true }, ["最後の勝負っぴ。ぴつじを部屋から脱出させるっぴ！"]]
  ];
  for (const [part, opt, exp] of cases) {
    const env = setup({ part, ...opt });
    if (opt.bgmUnlockedOnly) env.state.bgmState.unlockedTracks.push("happy");
    tap(env, "spotPcStream");
    eq(env.log.msgs, exp, `part${part} ${JSON.stringify(opt)}`);
    eq(env.log.story, [], `part${part} 未達なのにクリアした`);
    eq(env.log.autoClear, 0, `part${part} 未達なのにクリア待ちになった`);
  }
});
test("R-10", "配信用カメラ: クリア条件を満たすと、クリア時の台詞を読み終えてからストーリーへ", () => {
  const cases = [
    [2, { used: { itemChocolate: ["spotPitsujiDoorGap"] } }, ["始めるっぴ～！"]],
    [3, { flags: { doorBUnlocked: true } }, ["今度こそ脱出ゲームっぴ！"]],
    [4, { flags: { doorEntranceUnlocked: true } }, ["ぴつじ脱出やるっぴ！！"]],
    [5, { used: { itemCushion: ["spotPitsujiWindow"], itemLargeTowel: ["spotPitsujiWindow"] } }, ["嫌な予感がするッピ……"]],
    [7, { bgm: "happy" }, ["最後の勝負っぴー！！"]]
  ];
  for (const [part, opt, msgs] of cases) {
    const env = tap(setup({ part, ...opt }), "spotPcStream");
    eq(env.log.msgs, msgs, `part${part} 台詞`);
    eq(env.log.se, ["Se_StartStream"], `part${part} SE`);
    eq(env.log.story, [], `part${part} 台詞を読む前にストーリーへ進んだ`);
    eq(env.log.autoClear, 1, `part${part} クリア待ちにならない`);
    env.engine.runAutoClear(); // 台詞を読み終えた(main.jsのrunPendingAutoClear)
    eq(env.log.story, [part], `part${part}`);
    eq(env.state.phase, "story");
  }
  // PlayPart1はクリア時の台詞なし → 即ストーリーへ
  const e1 = tap(setup({ part: 1 }), "spotPcStream");
  eq(e1.log.story, [1], "part1");
  eq(e1.log.se, ["Se_StartStream"], "part1 SE");
});
test("R-11", "調査ノート: PlayPart1は非表示、2以降はノートを開く(ページ1左)", () => {
  ok(!visible(setup({ part: 1 }), "spotNotebook"), "part1で表示");
  const env = tap(setup({ part: 2, notePage: 3 }), "spotNotebook");
  eq(env.state.currentView, "viewNote");
  eq(notePageId(env), "note1left");
  eq(env.log.msgs, ["調査によるとぴつじはチョコ好きっぴ"]);
});
test("R-12", "ベッドマット: 取得後 / PlayPart5で入手 / その他", () => {
  eq(tap(setup({ part: 5, view: "viewBed", ever: ["itemLargeTowel"] }), "spotBedmat").log.msgs, ["タオルケットが無くても寝心地は最高っぴ"]);
  const e = tap(setup({ part: 5, view: "viewBed" }), "spotBedmat");
  eq(e.log.msgs, ["ふわふわタオルケット。これは気にいるっぴ"]);
  eq(e.log.se, ["TBD_ベッドマット"], "タップ毎のSE");
  eq(e.state.inventory, ["itemLargeTowel"]);
  eq(tap(setup({ part: 4, view: "viewBed" }), "spotBedmat").log.msgs, ["このタオルケットの触り心地最高だっぴ～"]);
  for (const p of [6, 7]) eq(tap(setup({ part: p, view: "viewBed" }), "spotBedmat").log.msgs, ["ピも昼寝したいっぴ～", "でも我慢っぴ！脱出させるっぴ！"], `part${p}`);
});
test("R-13", "ベッドマット: タオルケット入手後・操作パート6,7はベッド背景が差分に変わる", () => {
  const v = data.viewsById.viewBed;
  const diff = (opt) => { const { state, ctx } = setup({ view: "viewBed", ...opt }); return v.backgroundVariants.some((b) => evaluate(b.when, state, ctx)); };
  ok(diff({ part: 5, ever: ["itemLargeTowel"] }), "入手後に差分背景に切り替わらない");
  ok(diff({ part: 6 }) && diff({ part: 7 }), "操作パート6,7で差分背景にならない");
  ok(!diff({ part: 5 }), "入手前なのに差分背景");
});
test("R-14", "ベッド下: カメラ取得後 / PlayPart6で入手 / その他", () => {
  eq(tap(setup({ part: 6, view: "viewBed", ever: ["itemCamera"] }), "spotUnderBed").log.msgs, ["ここにはもう何もないっぴ"]);
  const e = tap(setup({ part: 6, view: "viewBed" }), "spotUnderBed");
  eq(e.log.msgs, ["カメラ見つけたっぴー！"]);
  eq(e.log.se, ["ガサガサっという探す音"]);
  eq(e.state.inventory, ["itemCamera"]);
  eq(tap(setup({ part: 5, view: "viewBed" }), "spotUnderBed").log.msgs, ["今は使わないものを収納してあるっぴ～"]);
  const et = tap(setup({ part: 5, view: "viewBed", items: ["itemLargeTowel"], selected: "itemLargeTowel" }), "spotUnderBed");
  eq(et.log.msgs, ["タオルケットはしまわないっぴ～", "ぴつじに渡して元気にするっぴ～！"]);
  eq(et.state.inventory, ["itemLargeTowel"], "タオルケットが消えた");
  const ec = tap(setup({ part: 5, view: "viewBed", items: ["itemCushion"], selected: "itemCushion" }), "spotUnderBed");
  eq(ec.log.msgs, ["片付けないっぴ！", "ぴつじに渡すクッションぴ～"]);
  eq(ec.state.inventory, ["itemCushion"], "クッションが消えた");
  eq(tap(setup({ part: 7, view: "viewBed" }), "spotUnderBed").log.msgs, ["パーティー用具も置いとけば良かったっぴ～"]);
  const e2 = tap(setup({ part: 2, view: "viewBed", items: ["itemChocolate"], selected: "itemChocolate" }), "spotUnderBed");
  eq(e2.log.seq, ["se:Se_ChocoTrhow", "msg:あ！チョコが下に落ちたッピ！！", "se:ガーンみたいな音", "se:ガサガサっという探す音", "msg:ふう、取れたっぴ。一安心っぴ～"]);
  eq(e2.state.inventory, ["itemChocolate"], "チョコが消えた");
  eq(tap(setup({ part: 2, view: "viewBed" }), "spotUnderBed").log.msgs, ["今は使わないものが置いてあるっぴ"], "part2");
  for (const p of [3, 4]) eq(tap(setup({ part: p, view: "viewBed" }), "spotUnderBed").log.msgs, ["今は使わないものを収納してあるっぴ～"], `part${p}`);
});
test("R-15", "ドアB: PlayPart4以降は部屋B1へ / 3の解除前後 / 2", () => {
  const e4 = tap(setup({ part: 4, view: "roomA1" }), "spotDoorB");
  eq(e4.state.currentView, "roomB1");
  eq(e4.log.se, ["Se_DoorOpen1"]);
  eq(tap(setup({ part: 3, view: "roomA1", flags: { doorBUnlocked: true } }), "spotDoorB").log.msgs, ["これでぴつじも簡単に脱出できるっぴ～", "早くぴつじ脱出させるっぴ～！"]);
  eq(tap(setup({ part: 3, view: "roomA1" }), "spotDoorB").log.msgs, ["この謎も頑張って考えたっぴ～！", "でも答え忘れたッピ……"]);
  eq(tap(setup({ part: 2, view: "roomA1" }), "spotDoorB").log.msgs, ["隣室に続いてるドアっぴ～"]);
  eq(tap(setup({ part: 3, view: "roomA1", flags: { doorBUnlocked: true } }), "spotDoorB").state.currentView, "roomA1", "part3で部屋Bに移動できてしまう");
});
test("R-16", "ドアBの電子錠: PlayPart4以降 / 3の解除後 / 3でギミック(SE) / その他", () => {
  eq(tap(setup({ part: 4, view: "roomA1", flags: { doorBUnlocked: true } }), "spotLockDoorB").log.msgs, ["もう鍵は開いてるっぴ～"]);
  eq(tap(setup({ part: 3, view: "roomA1", flags: { doorBUnlocked: true } }), "spotLockDoorB").log.msgs, ["もう鍵は開いてるっぴ！やることないっぴ！"]);
  const e = tap(setup({ part: 3, view: "roomA1" }), "spotLockDoorB");
  eq(e.log.gimmick, ["gimmickLockDoorB"]);
  eq(e.log.se, ["ギミック起動音"]);
  eq(e.log.msgs, ["謎を解き明かすっぴ！"]);
  eq(tap(setup({ part: 2, view: "roomA1" }), "spotLockDoorB").log.msgs, ["ドアの鍵を開ける謎っぴ～"]);
});
test("R-17", "冷蔵庫/トースター/テーブル/棚/ぴつじ部屋ドア/黒ぴぐま部屋ドア/机/電話台/ドアA/ローテーブル: 視点移動", () => {
  const moves = [
    ["roomA1", "spotRefrigerator", "viewRefrigerator"], ["roomA1", "spotDoorKitchen", "viewToaster"], ["roomA1", "spotTable", "viewTable"],
    ["roomA2", "spotShelf", "viewShelf"], ["roomA2", "spotPitsujiDoor", "viewPitsujiDoor"], ["roomA2", "spotDoorPiguma", "roomPiguma"],
    ["roomPiguma", "spotDesk", "viewDesk"], ["roomB1", "spotPhoneStand", "viewPhoneStand"], ["roomB1", "spotDoorA", "roomA1"],
    ["roomB2", "spotLowTable", "viewLowTable"]
  ];
  for (const [view, spot, target] of moves) eq(tap(setup({ part: 4, view }), spot).state.currentView, target, spot);
  eq(tap(setup({ part: 4, view: "roomB1" }), "spotDoorA").log.se, ["Se_DoorOpen1"], "ドアAのSE");
});
test("R-18", "テーブルの上: PlayPart4以降 / 3で取得後 / 3で食パン(SE) / その他", () => {
  for (const p of [4, 6, 7]) eq(tap(setup({ part: p, view: "viewTable" }), "spotOnTable").log.msgs, ["朝ごはんは食パン派っぴ～"], `part${p}`);
  eq(tap(setup({ part: 5, view: "viewTable" }), "spotOnTable").log.msgs, ["ぴつじはご飯派って顔してるっぴ", "食パンでは満足しないっぴねぇ"]);
  eq(tap(setup({ part: 3, view: "viewTable", ever: ["itemBread"] }), "spotOnTable").log.msgs, ["少しお腹がすいてきたッピ……"]);
  const e = tap(setup({ part: 3, view: "viewTable" }), "spotOnTable");
  eq(e.log.msgs, ["食べたいけどこれは謎のヒントっぴ～"]);
  eq(e.log.se, ["袋をがさっと開ける音"]);
  eq(e.state.inventory, ["itemBread"]);
  eq(tap(setup({ part: 2, view: "viewTable" }), "spotOnTable").log.msgs, ["あとで食パン食べるっぴ！"]);
});
test("R-19", "椅子: PlayPart6以降 / 5で取得後 / 5でクッション(SE) / その他", () => {
  eq(tap(setup({ part: 6, view: "viewTable", ever: ["itemCushion"] }), "spotChair").log.msgs, ["この椅子はちょっと座り心地が悪いッピ……"]);
  eq(tap(setup({ part: 5, view: "viewTable", ever: ["itemCushion"] }), "spotChair").log.msgs, ["クッションが無くなったッピ", "少し背もたれが固くて痛いッピ……"]);
  const e = tap(setup({ part: 5, view: "viewTable" }), "spotChair");
  eq(e.log.msgs, ["クッションを手に入れたっぴ！", "これでぴつじも満足ぴ～"]);
  eq(e.log.se, ["TBD_椅子"]);
  eq(e.state.inventory, ["itemCushion"]);
  eq(tap(setup({ part: 4, view: "viewTable" }), "spotChair").log.msgs, ["ふかふかのクッションが背中を守ってくれるっぴ"]);
});
test("R-20", "段ボール: PlayPart6の1回目はメッセージ、2回目以降は宛先画像 / 7以降 / その他", () => {
  const e = setup({ part: 6, view: "roomA2" });
  tap(e, "spotCardboardBox");
  eq(e.log.msgs, ["下の段のダンボール見ればわかるっぴ～"]);
  eq(e.log.se, ["箱をがさがさする音"]);
  eq(e.log.image.length, 0, "1回目で画像表示");
  tap(e, "spotCardboardBox");
  eq(e.log.image.length, 1, "2回目で画像が出ない");
  eq(e.log.imageOpts[0].text, "隣に誤配された時の箱っぴ～");
  tap(e, "spotCardboardBox");
  eq(e.log.image.length, 2, "3回目以降で画像が出ない");
  eq(tap(setup({ part: 7, view: "roomA2" }), "spotCardboardBox").log.msgs, ["段ボールはあとで片付けるっぴ"]);
  eq(tap(setup({ part: 5, view: "roomA2" }), "spotCardboardBox").log.msgs, ["脱出用具をたくさん買った時の箱っぴ～"]);
});
test("R-21", "壁の貼り紙: PlayPart4以降 / 3で取得後 / 3で青い紙 / 2", () => {
  eq(tap(setup({ part: 3, view: "roomA2", ever: ["itemBluePaper"] }), "spotWallPaper").log.msgs, ["もうここには何もないっぴ"]);
  eq(tap(setup({ part: 4, view: "roomA2" }), "spotWallPaper").log.msgs, ["もうここには何もないっぴ"]);
  const e = tap(setup({ part: 3, view: "roomA2" }), "spotWallPaper");
  eq(e.log.msgs, ["これがヒントになるっぴ～！"]);
  eq(e.state.inventory, ["itemBluePaper"]);
  eq(tap(setup({ part: 2, view: "roomA2" }), "spotWallPaper").log.msgs, ["あからさまにヒントを壁に貼っておいたっぴ"]);
});
test("R-22", "冷蔵庫(冷蔵部): 取得後 / PlayPart2でチョコ / その他", () => {
  eq(tap(setup({ part: 2, view: "viewRefrigerator", ever: ["itemChocolate"] }), "spotFridgeCompartment").log.msgs, ["つい開けてしまうっぴ……何も入ってないッピ"]);
  for (const p of [6, 7]) eq(tap(setup({ part: p, view: "viewRefrigerator", ever: ["itemChocolate"] }), "spotFridgeCompartment").log.msgs, ["冷蔵庫は空っぽだっぴ～"], `part${p}`);
  eq(tap(setup({ part: 5, view: "viewRefrigerator" }), "spotFridgeCompartment").log.msgs, ["もうチョコはないッピね"]);
  eq(tap(setup({ part: 4, view: "viewRefrigerator", flags: { doorEntranceUnlocked: true } }), "spotFridgeCompartment").log.msgs, ["チョコレート無くてもなったっぴねぇ"]);
  eq(tap(setup({ part: 4, view: "viewRefrigerator" }), "spotFridgeCompartment").log.msgs, ["チョコレートあげちゃったの失敗だったッピ！", "でも無くても何とかなったはずっぴ！"]);
  for (const p of [2, 4, 5, 6, 7]) eq(tap(setup({ part: p, view: "viewRefrigerator", ever: ["itemChocolate"] }), "spotFridgeCompartment").log.se, ["Se_Refrigeratol"], `part${p} SE`);
  const e = tap(setup({ part: 2, view: "viewRefrigerator" }), "spotFridgeCompartment");
  eq(e.log.msgs, ["ぴつじの好きなチョコレートっぴ！", "これをぴつじに渡すっぴ！"]);
  eq(e.state.inventory, ["itemChocolate"]);
  eq(tap(setup({ part: 3, view: "viewRefrigerator" }), "spotFridgeCompartment").log.msgs, ["ヒント用のチョコレートっぴ"]);
});
test("R-23", "冷凍庫: PlayPart4以降 / 取得後 / 3で青い紙→冷凍後の青い紙 / 3で未選択 / その他", () => {
  for (const p of [4, 6, 7]) eq(tap(setup({ part: p, view: "viewRefrigerator" }), "spotFreezerCompartment").log.msgs, ["アイスでも入れておけば良かったッピ～"], `part${p}`);
  eq(tap(setup({ part: 5, view: "viewRefrigerator" }), "spotFreezerCompartment").log.msgs, ["ぴつじが好きそうなものは何もないッピ"]);
  eq(tap(setup({ part: 3, view: "viewRefrigerator", ever: ["itemFrozenBluePaper"] }), "spotFreezerCompartment").log.msgs, ["アイス入れておけば良かったッピ～"]);
  const e = tap(setup({ part: 3, view: "viewRefrigerator", items: ["itemBluePaper"], selected: "itemBluePaper" }), "spotFreezerCompartment");
  eq(e.log.msgs, ["この紙は冷やすと文字が出てくるっぴ！"]);
  eq(e.state.inventory, ["itemFrozenBluePaper"]);
  eq(e.ctx.selectedItemId, null);
  eq(tap(setup({ part: 3, view: "viewRefrigerator", items: ["itemBluePaper"] }), "spotFreezerCompartment").log.msgs, ["冷凍庫も謎解きに使うっぴ～"]);
  eq(tap(setup({ part: 2, view: "viewRefrigerator" }), "spotFreezerCompartment").log.msgs, ["何も入ってないッピ"]);
});
test("R-24", "冷凍庫: 違うアイテム(食パン)を選択して使っても消費されない", () => {
  const e = tap(setup({ part: 3, view: "viewRefrigerator", items: ["itemBread"], selected: "itemBread" }), "spotFreezerCompartment");
  eq(e.state.inventory, ["itemBread"]);
  eq(e.log.msgs, ["冷凍庫も謎解きに使うっぴ～"]);
});
test("R-25", "トースター: PlayPart4以降 / 3で焼いたパン選択・取得後 / 3で食パン→焼かれた食パン / 3で未選択 / 2", () => {
  eq(tap(setup({ part: 4, view: "viewToaster" }), "spotToaster").log.msgs, ["なんでも美味しく焼けるトースターっぴ～"]);
  eq(tap(setup({ part: 3, view: "viewToaster", items: ["itemToastedBread"], selected: "itemToastedBread" }), "spotToaster").log.msgs, ["これ以上焼いたら焦げちゃうッピー！"]);
  eq(tap(setup({ part: 3, view: "viewToaster", ever: ["itemToastedBread"] }), "spotToaster").log.msgs, ["美味しく焼けたっぴ～"]);
  const e = tap(setup({ part: 3, view: "viewToaster", items: ["itemBread"], selected: "itemBread" }), "spotToaster");
  eq(e.log.msgs, ["パンを焼くっぴ～", "お腹空いたけど食べる前にヒント見るっぴ！", "後で美味しくいただくっぴ～！"]);
  eq(e.log.se, ["焼いている音", "トースターが終わる音"]);
  eq(e.state.inventory, ["itemToastedBread"]);
  eq(tap(setup({ part: 3, view: "viewToaster" }), "spotToaster").log.msgs, ["このトースターはすごく美味しく焼けるっぴ！"]);
  eq(tap(setup({ part: 2, view: "viewToaster" }), "spotToaster").log.msgs, ["美味しいパンが焼けるトースターっぴ～"]);
  const ec = tap(setup({ part: 2, view: "viewToaster", items: ["itemChocolate"], selected: "itemChocolate" }), "spotToaster");
  eq(ec.log.msgs, ["焼きチョコにするっぴ～？", "違うッピ！！ぴつじに渡すチョコっぴ！"]);
  eq(ec.state.inventory, ["itemChocolate"], "チョコが消えた");
});
test("R-26", "ぴつじ部屋ドアノブ: PlayPart3以降 / 2でチョコ使用後・チョコ選択中・その他", () => {
  for (const p of [3, 7]) eq(tap(setup({ part: p, view: "viewPitsujiDoor" }), "spotPitsujiDoorKnob").log.msgs, ["絶対ぴつじを部屋から出してみせるっぴ～！"], `part${p}`);
  eq(tap(setup({ part: 2, view: "viewPitsujiDoor", used: { itemChocolate: ["spotPitsujiDoorGap"] } }), "spotPitsujiDoorKnob").log.msgs, ["部屋に戻って脱出ゲーム再開するっぴ～"]);
  const ec = tap(setup({ part: 2, view: "viewPitsujiDoor", items: ["itemChocolate"], selected: "itemChocolate" }), "spotPitsujiDoorKnob");
  eq(ec.log.msgs, ["ドア開け渡したらばれちゃうっぴ", "ばれないようにチョコを渡す方法を考えるっぴ"]);
  eq(ec.state.inventory, ["itemChocolate"], "チョコが消えた");
  eq(tap(setup({ part: 2, view: "viewPitsujiDoor" }), "spotPitsujiDoorKnob").log.msgs, ["ぴつじを脱出させるっぴ～"]);
});
test("R-27", "ドア小窓 PlayPart5: 未開放→ドライバーで開放→クッション/タオルケット", () => {
  const e = setup({ part: 5, view: "viewPitsujiDoor", items: ["itemScrewDriver", "itemCushion", "itemLargeTowel"] });
  tap(e, "spotPitsujiWindow");
  eq(e.log.msgs, ["この曇り窓は外せるっぴ～"]);
  eq(e.log.se, ["ガタガタしている音"]);
  e.ctx.selectedItemId = "itemCushion";
  tap(e, "spotPitsujiWindow");
  eq(e.state.inventory.includes("itemCushion"), true, "未開放なのにクッションが消費された");
  e.ctx.selectedItemId = "itemScrewDriver";
  tap(e, "spotPitsujiWindow");
  eq(e.log.msgs.slice(-2), ["曇り窓が外れたっぴ～", "ばれないようにこっそりっぴ～"]);
  eq(e.log.se.at(-1), "カチャンっという音");
  ok(e.state.flags.pitsujiWindowOpen, "小窓が開いていない");
  ok(!e.state.inventory.includes("itemScrewDriver"), "ドライバー(消失)が残っている");
  tap(e, "spotPitsujiWindow");
  eq(e.log.msgs.at(-1), "この窓からぴつじの元気出るものを渡すっぴ");
  e.ctx.selectedItemId = "itemCushion";
  tap(e, "spotPitsujiWindow");
  eq(e.log.msgs.slice(-2), ["声色変えるっぴ", "クッション ヲ ツカウッピ！"]);
  e.ctx.selectedItemId = "itemLargeTowel";
  tap(e, "spotPitsujiWindow");
  eq(e.log.msgs.slice(-2), ["バレないようにするっぴ", "タオルケット ヲ ツカウッピ"]);
  eq(e.state.inventory, []);
});
test("R-28", "ドア小窓 PlayPart6: カメラ使用 / 使用後 / 取得済み未選択 / 未取得", () => {
  const e = tap(setup({ part: 6, view: "viewPitsujiDoor", items: ["itemCamera"], selected: "itemCamera" }), "spotPitsujiWindow");
  eq(e.log.msgs, ["ぴつじの様子を撮影するピ", "証拠写真にするっぴ！"]);
  eq(e.state.inventory, [], "カメラが消えない(写真アイテムは入手しない)");
  eq(e.state.itemUsageLog.itemCamera, ["spotPitsujiWindow"]);
  eq(tap(setup({ part: 6, view: "viewPitsujiDoor", used: { itemCamera: ["spotPitsujiWindow"] } }), "spotPitsujiWindow").log.msgs, ["気持ちよさそうに熟睡しているッピ……", "少しの音では起きなさそうッピ……"]);
  eq(tap(setup({ part: 6, view: "viewPitsujiDoor", items: ["itemCamera"] }), "spotPitsujiWindow").log.msgs, ["ぴつじがここにいる証拠写真を撮るっぴ～"]);
  eq(tap(setup({ part: 6, view: "viewPitsujiDoor" }), "spotPitsujiWindow").log.msgs, ["ここにぴつじがいるって証拠を見せつけるっぴ！"]);
});
test("R-29", "ドア小窓 PlayPart4以前 / 7以降", () => {
  const e = tap(setup({ part: 3, view: "viewPitsujiDoor" }), "spotPitsujiWindow");
  eq(e.log.msgs, ["あんまりガタガタさせると気付かれるッピ"]);
  eq(e.log.se, ["ガタガタしている音"]);
  eq(tap(setup({ part: 7, view: "viewPitsujiDoor" }), "spotPitsujiWindow").log.msgs, ["気持ちよさそうに寝てるッピねぇ"]);
});
test("R-30", "ドア下隙間: PlayPart2でチョコ使用 / 2で未選択 / 3以降", () => {
  const e = tap(setup({ part: 2, view: "viewPitsujiDoor", items: ["itemChocolate"], selected: "itemChocolate" }), "spotPitsujiDoorGap");
  eq(e.log.seq, ["msg:ここからシュッと入れるっぴ！", "se:Se_ChocoTrhow", "msg:チョコレートに釣られて動いた気配がするっぴ～！", "msg:部屋に戻ってぴつじに脱出させるっぴ！"]);
  eq(e.state.inventory, []);
  eq(tap(setup({ part: 2, view: "viewPitsujiDoor" }), "spotPitsujiDoorGap").log.msgs, ["板チョコのような薄いものなら通りそうっぴねぇ"]);
  eq(tap(setup({ part: 2, view: "viewPitsujiDoor", used: { itemChocolate: ["spotPitsujiDoorGap"] } }), "spotPitsujiDoorGap").log.msgs, ["ぴつじがチョコ食べてる気配がするっぴ", "今なら脱出しそうだっぴ！"]);
  for (const p of [3, 4]) eq(tap(setup({ part: p, view: "viewPitsujiDoor" }), "spotPitsujiDoorGap").log.msgs, ["チョコ作戦は失敗だったっぴ～"], `part${p}`);
  for (const p of [6, 7]) eq(tap(setup({ part: p, view: "viewPitsujiDoor" }), "spotPitsujiDoorGap").log.msgs, ["この隙間はもう使えないっぴ～"], `part${p}`);
  // PlayPart5: 選択中アイテム毎のメッセージ。いずれも消費しない
  for (const [item, m] of [["itemCushion", "ここからクッションは通らないっぴねえ"], ["itemLargeTowel", "ここからタオルケットは通らないっぴねえ"], ["itemScrewDriver", "間違えて部屋の中に落とさないようにするっぴ"]]) {
    for (const flags of [{}, { pitsujiWindowOpen: true }]) {
      const e5 = tap(setup({ part: 5, view: "viewPitsujiDoor", items: [item], selected: item, flags }), "spotPitsujiDoorGap");
      eq(e5.log.msgs, [m], item);
      eq(e5.state.inventory, [item], `${item} が消えた`);
    }
  }
  eq(tap(setup({ part: 5, view: "viewPitsujiDoor", flags: { pitsujiWindowOpen: true } }), "spotPitsujiDoorGap").log.msgs, ["この隙間はもう使えないっぴ～"]);
  eq(tap(setup({ part: 5, view: "viewPitsujiDoor" }), "spotPitsujiDoorGap").log.msgs, ["こんな狭い隙間じゃだめッピ", "もっと広いところを探すっぴ！"]);
});
test("R-31", "引き出し: PlayPart6で電話の説明書 / 取得後 / その他（毎回SE）", () => {
  const e = tap(setup({ part: 6, view: "viewShelf" }), "spotDrawer");
  eq(e.log.msgs, ["電話の説明書を読むっぴ～"]);
  eq(e.log.se, ["Se_Shelf"]);
  eq(e.state.inventory, ["itemPhoneManual"]);
  eq(tap(setup({ part: 6, view: "viewShelf", ever: ["itemPhoneManual"] }), "spotDrawer").log.msgs, ["もうここには何もないっぴ～"]);
  for (const [p, m] of [[3, "今必要なものは何も無いッピ"], [7, "もうここには何もないっぴ～"]]) {
    const o = tap(setup({ part: p, view: "viewShelf" }), "spotDrawer");
    eq(o.log.msgs, [m], `part${p}`);
    eq(o.log.se, ["Se_Shelf"], `part${p} SE`);
  }
});
test("R-32", "工具箱: PlayPart6以降 / 5で取得後 / 5でドライバー(メッセージ) / 4以前（全てSE）", () => {
  eq(tap(setup({ part: 6, view: "viewShelf" }), "spotToolbox").log.msgs, ["使えるものは何も無いっぴ～"]);
  eq(tap(setup({ part: 5, view: "viewShelf", ever: ["itemScrewDriver"] }), "spotToolbox").log.msgs, ["使えるものは何も無いっぴ～"]);
  const e = tap(setup({ part: 5, view: "viewShelf" }), "spotToolbox");
  eq(e.log.msgs, ["見つけたっぴ！ドライバーだっぴー"]);
  eq(e.log.se, ["Se_LockOpen"]);
  eq(e.state.inventory, ["itemScrewDriver"]);
  eq(tap(setup({ part: 4, view: "viewShelf" }), "spotToolbox").log.msgs, ["色んな道具をしまってあるっぴ", "整頓上手だっぴ～"]);
});
test("R-33", "玄関ドア: PlayPart5以降 / 4の解除後・解除前 / その他", () => {
  eq(tap(setup({ part: 5, view: "roomB1" }), "spotDoorEntrance").log.msgs, ["鍵開いてるのにぴつじはなんで脱出しないッピ……？"]);
  eq(tap(setup({ part: 4, view: "roomB1", flags: { doorEntranceUnlocked: true } }), "spotDoorEntrance").log.msgs, ["ぴつじも楽々出られるっぴ！", "今度こそ脱出っぴ～！"]);
  eq(tap(setup({ part: 4, view: "roomB1" }), "spotDoorEntrance").log.msgs, ["鍵を開けるっぴ！任せるっぴ！"]);
});
test("R-34", "玄関ドアの電子錠: PlayPart7は非表示 / 解除後 / 解除前はギミック", () => {
  ok(!visible(setup({ part: 7, view: "roomB1" }), "spotLockEntrance"), "part7で表示");
  eq(tap(setup({ part: 5, view: "roomB1", flags: { doorEntranceUnlocked: true } }), "spotLockEntrance").log.msgs, ["もう鍵は開いてるっぴ～"]);
  eq(tap(setup({ part: 4, view: "roomB1" }), "spotLockEntrance").log.gimmick, ["gimmickLockEntrance"]);
});
test("R-35", "ぴさぎ: PlayPart7のみ。写真→ギミック / 楽器の受け渡し", () => {
  for (const p of [4, 5, 6]) ok(!visible(setup({ part: p, view: "roomB1" }), "spotPisagi"), `part${p}で表示`);
  eq(tap(setup({ part: 7, view: "roomB1" }), "spotPisagi").log.msgs, ["「必要なものを買ってくるっぴ」って言ってるぴ", "「買うものの見た目を教えるっぴ」っぴ？"]);
  const e = tap(setup({ part: 7, view: "roomB1", items: ["itemPhoto"], selected: "itemPhoto" }), "spotPisagi");
  eq(e.log.gimmick, ["gimmickPhoto"]);
  eq(e.state.inventory, []);
  const e2 = tap(setup({ part: 7, view: "roomB1", used: { itemPhoto: ["spotPisagi"] }, items: ["itemBlackLight"], selected: "itemBlackLight" }), "spotPisagi");
  eq(e2.log.gimmick, ["gimmickPhoto"], "写真使用後に再度ギミックを開けない");
  eq(e2.state.inventory, ["itemBlackLight"], "無関係の選択中アイテムが消費された");
  // 写真ギミッククリア後
  const e3 = tap(setup({ part: 7, view: "roomB1", used: { itemPhoto: ["spotPisagi"] }, flags: { gimmickPhotoCleared: true } }), "spotPisagi");
  eq(e3.log.msgs, ["ぴさぎがやる気に満ちた目で見てくるっぴ"]);
  // マラカスはぴさぎには渡せない
  const em = tap(setup({ part: 7, view: "roomB1", items: ["itemMaracas"], flags: { gimmickPhotoCleared: true }, selected: "itemMaracas" }), "spotPisagi");
  eq(em.log.msgs, ["「ぴさぎはこっちじゃないっぴ！」って顔で見てるっぴ"]);
  eq(em.state.inventory, ["itemMaracas"]);
  // タンバリンを先に渡す
  const et = tap(setup({ part: 7, view: "roomB1", items: ["itemTambourine"], flags: { gimmickPhotoCleared: true }, selected: "itemTambourine" }), "spotPisagi");
  eq(et.log.msgs, ["これを任せたっぴ！", "あとはぴぐまっぴ～！"]);
  eq(et.log.se, ["SE_TambourineRoll"]);
  eq(et.state.inventory, []);
  eq(et.log.image.length, 0, "片方だけでパーティー画像が出た");
  // ぴぐまにマラカスを渡した後にタンバリン → パーティー
  const ep = tap(setup({ part: 7, view: "roomB1", items: ["itemTambourine"], used: { itemMaracas: ["spotPiguma"] }, flags: { gimmickPhotoCleared: true }, selected: "itemTambourine" }), "spotPisagi");
  eq(ep.log.msgs, ["これを任せたっぴ！", "BGM HAPPY がオーディオに追加された", "最後に部屋を賑やかにするっぴ！"]);
  eq(ep.log.imageOpts.map((o) => [o.text, o.bgm]), [["のりのりだっぴ～！", "happy"]]);
  ok(ep.state.bgmState.unlockedTracks.includes("happy"), "HAPPYが追加されない");
  // タンバリン使用後
  const e4 = tap(setup({ part: 7, view: "roomB1", used: { itemTambourine: ["spotPisagi"] }, flags: { gimmickPhotoCleared: true } }), "spotPisagi");
  eq(e4.log.msgs, ["楽しそうにタンバリン叩いてるっぴ～"]);
  eq(e4.log.se, ["SE_TambourineRoll"]);
});
test("R-36", "オーディオ: いつでもBGM選択", () => {
  eq(tap(setup({ part: 4, view: "roomB2" }), "spotAudioPlayer").log.bgmMenu, 1);
  eq(tap(setup({ part: 7, view: "roomB2" }), "spotAudioPlayer").log.bgmMenu, 1);
});
test("R-37", "ソファ: PlayPart5以降 / 4で取得後 / 4で絵", () => {
  eq(tap(setup({ part: 4, view: "roomB2", ever: ["itemIllust"] }), "spotSofa").log.msgs, ["もう何も落ちてないっぴ"]);
  eq(tap(setup({ part: 5, view: "roomB2" }), "spotSofa").log.msgs, ["ふかふかだけどこれはぴつじの部屋に運べないっぴ～"]);
  eq(tap(setup({ part: 6, view: "roomB2" }), "spotSofa").log.msgs, ["ここには名刺落ちてなかったぴ", "どこかで使った気がするっぴ～"]);
  eq(tap(setup({ part: 6, view: "roomB2", ever: ["itemPisagiCard"] }), "spotSofa").log.msgs, ["何も落ちてないっぴ～"]);
  eq(tap(setup({ part: 7, view: "roomB2" }), "spotSofa").log.msgs, ["大きいソファー用意しといて良かったっぴ～", "皆で座れるっぴ～"]);
  const e = tap(setup({ part: 4, view: "roomB2" }), "spotSofa");
  eq(e.log.msgs, ["これを探してたんだっぴ～"]);
  eq(e.state.inventory, ["itemIllust"]);
});
test("R-38", "電気スイッチ: 赤⇔元の色のトグル", () => {
  const e = setup({ part: 4, view: "roomB2" });
  tap(e, "spotSwitch"); tap(e, "spotSwitch"); tap(e, "spotSwitch");
  eq(e.log.msgs, ["部屋が赤くなったっぴ", "元の色に戻ったっぴ", "部屋が赤くなったっぴ"]);
  eq(e.state.flags.roomLightRed, true);
  // 操作パート5〜7: 赤くする → メッセージ → 消す音 → メッセージ → 元に戻す（順番どおりに見せる）
  for (const [p, m1, m2] of [[5, "電気の色か落ち着かないッピ～", "元の部屋に戻すっぴ～"], [6, "これじゃ見にくいッピ", "元の電気に戻すっぴ～"], [7, "これじゃパーティーできないッピ！", "元の電気に戻すっぴ～"]]) {
    const ep = tap(setup({ part: p, view: "roomB2" }), "spotSwitch");
    eq(ep.log.seq, ["se:Se_Switch", "flag:roomLightRed=true", "msg:" + m1, "se:Se_Switch", "msg:" + m2, "flag:roomLightRed=false"], `part${p}`);
    ok(!ep.state.flags.roomLightRed, `part${p} 赤いまま`);
  }
});
test("R-39", "電話: PlayPart7以降 / 6でギミック / 6クリア後 / 4でブラックライト / その他", () => {
  eq(tap(setup({ part: 7, view: "viewPhoneStand" }), "spotPhone").log.msgs, ["電話したいところはないっぴ～"]);
  const e = tap(setup({ part: 6, view: "viewPhoneStand" }), "spotPhone");
  eq(e.log.gimmick, ["gimmickPhone"]);
  eq(e.log.msgs, ["ぴさぎを呼び出すっぴ！"]);
  const ecard = tap(setup({ part: 6, view: "viewPhoneStand", items: ["itemPisagiCard"], selected: "itemPisagiCard" }), "spotPhone");
  eq(ecard.log.seq, ["msg:直接名刺使ってもダメだっぴ～", "se:ギミック起動音", "msg:ぴさぎを呼び出すっぴ～"]);
  eq(ecard.log.gimmick, ["gimmickPhone"]);
  eq(ecard.state.inventory, ["itemPisagiCard"], "名刺が消えた");
  eq(tap(setup({ part: 6, view: "viewPhoneStand", flags: { phoneGimmickCleared: true } }), "spotPhone").log.msgs, ["あとはぴさぎが来るのを待つだけだっぴ～"]);
  const ecam = tap(setup({ part: 6, view: "viewPhoneStand", items: ["itemCamera"], flags: { phoneGimmickCleared: true }, selected: "itemCamera" }), "spotPhone");
  eq(ecam.log.msgs, ["電話の写真撮っても意味ないっぴ～"]);
  eq(ecam.state.inventory, ["itemCamera"], "カメラが消えた");
  const e4 = tap(setup({ part: 4, view: "viewPhoneStand", items: ["itemBlackLight"], selected: "itemBlackLight" }), "spotPhone");
  eq(e4.log.msgs, ["ヒントが見えたっぴ！"]);
  eq(e4.log.image.length, 1);
  eq(e4.state.inventory, ["itemBlackLight"], "ブラックライト(残存)が消えた");
  eq(tap(setup({ part: 4, view: "viewPhoneStand" }), "spotPhone").log.msgs, ["電話にも仕掛けをしてたっぴ～"]);
  eq(tap(setup({ part: 5, view: "viewPhoneStand" }), "spotPhone").log.msgs, ["今は電話したいところはないっぴ～", "そんなことよりぴつじッピ！"]);
});
test("R-40", "電話台引き出し: PlayPart5以降 / 4で取得後 / 4でブラックライト", () => {
  eq(tap(setup({ part: 4, view: "viewPhoneStand", ever: ["itemBlackLight"] }), "spotPhoneStandDrawer").log.msgs, ["もうここには何も入れてないっぴ"]);
  eq(tap(setup({ part: 5, view: "viewPhoneStand" }), "spotPhoneStandDrawer").log.msgs, ["必要なものは何も無いっぴ～"]);
  eq(tap(setup({ part: 6, view: "viewPhoneStand" }), "spotPhoneStandDrawer").log.msgs, ["説明書は隣の部屋にあるはずっぴ～"]);
  eq(tap(setup({ part: 6, view: "viewPhoneStand", ever: ["itemPhoneManual"] }), "spotPhoneStandDrawer").log.msgs, ["説明書近くに置いとけばよかったっぴ～"]);
  const em = tap(setup({ part: 6, view: "viewPhoneStand", items: ["itemPhoneManual"], selected: "itemPhoneManual" }), "spotPhoneStandDrawer");
  eq(em.log.msgs, ["使い終わったらこっちに片付けるっぴ～"]);
  eq(em.state.inventory, ["itemPhoneManual"], "説明書が消えた");
  eq(tap(setup({ part: 7, view: "viewPhoneStand" }), "spotPhoneStandDrawer").log.msgs, ["ここには何も無いっぴ～"]);
  const e = tap(setup({ part: 4, view: "viewPhoneStand" }), "spotPhoneStandDrawer");
  eq(e.log.msgs, ["ブラックライト見つけたっぴ～！"]);
  eq(e.state.inventory, ["itemBlackLight"]);
});
test("R-41", "塩: PlayPart5以降 / 4でブラックライト / 4未選択", () => {
  for (const p of [5, 6]) eq(tap(setup({ part: p, view: "viewLowTable" }), "spotSalt").log.msgs, ["ゆで卵と塩の相性は最高だっぴ～"], `part${p}`);
  eq(tap(setup({ part: 7, view: "viewLowTable" }), "spotSalt").log.msgs, ["さっきぴさぎが卵食べてたっぴ", "この塩美味しいって言ってたっぴ～"]);
  const e = tap(setup({ part: 4, view: "viewLowTable", items: ["itemBlackLight"], selected: "itemBlackLight" }), "spotSalt");
  eq(e.log.msgs, ["塩にヒントが描いてあるっぴ！"]);
  eq(e.log.image.length, 1);
  eq(tap(setup({ part: 4, view: "viewLowTable" }), "spotSalt").log.msgs, ["ゆで卵にはクレイジーソルトっぴ！"]);
});
test("R-42", "ぴつじ部屋の出口: PlayPart8クリア", () => {
  const e = tap(setup({ part: 8 }), "spotPitsujiExitDoor");
  eq(e.log.story, [8]);
  eq(e.log.se, ["カチャっというドアノブを下げる音"]);
});

// =====================================================================
// N: 調査ノート
// =====================================================================
function openNote(opt) { return tap(setup({ part: 2, ...opt }), "spotNotebook"); }
test("NR-01", "ページ送り: 1左→1右→2左→2右、各ページ表示時にメッセージ", () => {
  const e = openNote({ part: 2 });
  const ids = [notePageId(e)];
  for (let i = 0; i < 3; i++) { notePageTap(e); ids.push(notePageId(e)); }
  eq(ids, ["note1left", "note1right", "note2left", "note2right"]);
  eq(e.log.msgs, ["調査によるとぴつじはチョコ好きっぴ", "ぴつじはふかふかも好きらしいっぴ", "ぴつじの友達のぴさぎについても調べたっぴ", "ぴつじの友達のぴぐまについても調べたっぴ"]);
});
test("NR-02", "PlayPart2〜6: 2右より先には進まない（何回タップしても）", () => {
  for (const part of [2, 3, 4, 5, 6]) {
    const e = openNote({ part });
    for (let i = 0; i < 10; i++) notePageTap(e);
    eq(notePageId(e), "note2right", `part${part}`);
    ok(!e.state.inventory.includes("itemPhoto"), `part${part}で写真を入手した`);
  }
});
test("NR-03", "PlayPart7: 2右で3回タップすると3左へ進み、写真を入手", () => {
  const e = openNote({ part: 7 });
  for (let i = 0; i < 3; i++) notePageTap(e);
  e.log.msgs.length = 0;
  notePageTap(e); notePageTap(e);
  eq(notePageId(e), "note2right", "2回で進んでしまった");
  eq(e.log.msgs, ["ん？", "次のページが貼り付いてるッピ？", "貼り付いてて次のページが中々めくれないッピ"]);
  notePageTap(e);
  eq(notePageId(e), "note3left");
  eq(e.log.msgs.slice(3), ["次のページがめくれたっぴ！", "写真が張り付いててめくりにくかったっぴねえ", "パーティーしてる写真を手にいれたっぴ！"]);
  eq(e.state.inventory, ["itemPhoto"]);
});
test("NR-04", "3左(最後のページ)ではそれ以上進まず、写真も重複入手しない", () => {
  const e = openNote({ part: 7 });
  for (let i = 0; i < 6; i++) notePageTap(e);
  eq(notePageId(e), "note3left");
  e.log.msgs.length = 0;
  for (let i = 0; i < 3; i++) notePageTap(e);
  eq(notePageId(e), "note3left");
  eq(e.log.msgs, Array(3).fill("ぴぐまとぴさぎはパーティーで楽器担当だっぴ"));
  eq(e.state.inventory, ["itemPhoto"]);
});
test("NR-05", "閉じて開き直すとページ1左から。2右のタップ回数も数え直し", () => {
  const e = openNote({ part: 7 });
  for (let i = 0; i < 5; i++) notePageTap(e); // 3回で2右 + 2回タップ
  eq(notePageId(e), "note2right");
  // 閉じる(main.onNoteCloseと同じ処理)
  e.state.notePage = 0; e.state.currentView = "viewDesk";
  tap(e, "spotNotebook");
  eq(notePageId(e), "note1left");
  for (let i = 0; i < 5; i++) notePageTap(e);
  eq(notePageId(e), "note2right", "数え直しされず3左へ進んだ");
});
test("NR-06", "写真入手後に再度ノートを開くと、2右は1回のタップで3左へ（楽器担当メッセージ）", () => {
  const e = openNote({ part: 7, ever: ["itemPhoto"], used: { itemPhoto: ["spotPisagi"] } });
  for (let i = 0; i < 3; i++) notePageTap(e);
  eq(notePageId(e), "note2right");
  e.log.msgs.length = 0;
  notePageTap(e);
  eq(notePageId(e), "note3left", "1回のタップで3左へ進まない");
  eq(e.log.msgs, ["ぴぐまとぴさぎはパーティーで楽器担当だっぴ"]);
  ok(!e.state.inventory.includes("itemPhoto"), "使用済みの写真を再入手した");
});

// =====================================================================
// P: パート遷移・自動クリア・アイテム消去・ギミック
// =====================================================================
test("P-01", "PlayPart6: 電話→ゲーム画面の順でも自動クリア（配信ボタン不要）", () => {
  const e = setup({ part: 6, view: "viewPhoneStand" });
  e.engine.resolveGimmickResult("gimmickPhone", true, "#7*27");
  eq(e.log.autoClear, 0, "ゲーム画面の前に自動クリア");
  e.engine.resolveGimmickResult("gimmickPcGame", true);
  eq(e.log.autoClear, 1);
  e.engine.runAutoClear();
  eq(e.log.story, [6]);
});
test("P-02", "PlayPart6: ゲーム画面→電話の順でも自動クリア", () => {
  const e = setup({ part: 6, view: "viewDesk" });
  e.engine.resolveGimmickResult("gimmickPcGame", true);
  eq(e.log.autoClear, 0);
  e.engine.resolveGimmickResult("gimmickPhone", true, "#7*27");
  eq(e.log.autoClear, 1);
});
test("P-03", "PlayPart6以外は自動クリアしない（配信ボタン必須）", () => {
  const e = setup({ part: 3, view: "roomA1" });
  e.engine.resolveGimmickResult("gimmickLockDoorB", true);
  eq(e.log.autoClear, 0);
  eq(e.log.story, []);
  const e5 = setup({ part: 5, view: "viewPitsujiDoor", items: ["itemLargeTowel"], used: { itemCushion: ["spotPitsujiWindow"] }, flags: { pitsujiWindowOpen: true }, selected: "itemLargeTowel" });
  tap(e5, "spotPitsujiWindow");
  eq(e5.log.autoClear, 0);
});
test("P-04", "ギミック: ゲーム画面 成功でフラグ・SE・メッセージ", () => {
  const e = setup({ part: 6 });
  e.engine.resolveGimmickResult("gimmickPcGame", true);
  ok(e.state.flags.chatGimmickCleared, "未解除");
  eq(e.log.se, ["クリア音"]);
  eq(e.log.msgs, ["これでぴぐまを呼び出せたっぴ～"]);
});
test("P-05", "パートクリア時に残存アイテムが破棄され、ノートのページも戻る", () => {
  const e = setup({ part: 3, items: ["itemFrozenBluePaper", "itemToastedBread"], flags: { doorBUnlocked: true }, notePage: 2 });
  tap(e, "spotPcStream");
  e.engine.runAutoClear();
  eq(e.state.inventory, []);
  eq(e.state.notePage, 0);
});
test("P-06", "ギミック: 電子錠B 正解/不正解", () => {
  const e = setup({ part: 3, view: "roomA1" });
  e.engine.resolveGimmickResult("gimmickLockDoorB", false);
  eq(e.log.msgs, ["違ったッピ……"]);
  ok(!e.state.flags.doorBUnlocked, "不正解で解除");
  e.engine.resolveGimmickResult("gimmickLockDoorB", true);
  ok(e.state.flags.doorBUnlocked, "正解で未解除");
});
test("P-07", "ギミック: 玄関/写真 成功でフラグ。写真ギミック成功でマラカス・タンバリン入手", () => {
  const e = setup({ part: 4 });
  e.engine.resolveGimmickResult("gimmickLockEntrance", true);
  ok(e.state.flags.doorEntranceUnlocked, "玄関未解除");
  const e7 = setup({ part: 7 });
  e7.engine.resolveGimmickResult("gimmickPhoto", true);
  ok(e7.state.flags.gimmickPhotoCleared, "写真ギミック未解除");
  eq(e7.state.inventory, ["itemMaracas", "itemTambourine"]);
  eq(e7.log.msgs, ["これとこれ、買ってきて欲しいっぴ！", "「ぴさぎに任せるっぴー！」って言って玄関から出てったっぴ", "「ただいまっぴ～！」ぴさぎが帰って来たっぴ。", "速いっぴ。瞬足っぴ！", "なかなかやるっぴね！"]);
  eq(e7.log.se, ["キランという音", "シュンっという音"]);
  eq(e7.log.image.length, 2);
  eq(data.gimmicksById.gimmickPhoto.missMessage, "ここじゃないっぴねえ");
});
test("P-08", "ストーリーパートの次パート番号が1→2→…→8の順につながっている", () => {
  for (let i = 1; i <= 7; i++) eq(data.storyPartsById[i].nextPlayPart, i + 1, `story${i}`);
  for (let i = 1; i <= 8; i++) eq(data.playPartsById[i].nextStoryPart, i, `play${i}`);
});
test("P-09", "部屋の色(赤)は操作パートをまたぐと元に戻る", () => {
  const e = setup({ part: 4, flags: { doorEntranceUnlocked: true, roomLightRed: true } });
  tap(e, "spotPcStream");
  e.engine.runAutoClear();
  eq(e.log.story, [4]);
  ok(!e.state.flags.roomLightRed, "パート切替後も赤いまま");
});
test("P-10", "部屋が赤くなるのは部屋B1・B2（tintFlag）", () => {
  const tinted = Object.values(data.viewsById).filter((v) => v.tintFlag === "roomLightRed").map((v) => v.id).sort();
  eq(tinted, ["roomB1", "roomB2"]);
});
test("P-11", "絵のESCAPEは、部屋が赤い状態で部屋B1/B2にいる時だけ見える", () => {
  const item = data.itemsById.itemIllust;
  const at = (view, red) => { const e = setup({ part: 4, view, flags: red ? { roomLightRed: true } : {} }); return [resolveMessage(item.placeholder, e.state, e.ctx)[0], resolveMessage(item.description, e.state, e.ctx)[0]]; };
  eq(at("roomB1", true)[1], "これを覚えとくっぴ！");
  ok(at("roomB1", true)[0].includes("ESCAPE"), "B1で見えない");
  ok(at("roomB2", true)[0].includes("ESCAPE"), "B2で見えない");
  ok(!at("viewLowTable", true)[0].includes("ESCAPE"), "ローテーブル拡大で見える");
  ok(!at("roomA1", true)[0].includes("ESCAPE"), "部屋A1で見える");
  ok(!at("roomB2", false)[0].includes("ESCAPE"), "赤くないのに見える");
  eq(at("roomB2", false)[1], "このままだと何もわからないっぴ～");
});
test("P-12", "ゲーム画面ギミックの正解は A.サーカステント / B.お寺（候補4択）", () => {
  const g = data.gimmicksById.gimmickPcGame;
  eq(g.blanks.map((b) => [b.key, b.answer]), [["A", "サーカステント"], ["B", "お寺"]]);
  eq([...g.options].sort(), ["お寺", "サーカステント", "学校", "高層ビル"].sort());
  for (const b of g.blanks) ok(g.lines.some((l) => l.includes(`{${b.key}}`)), `文章に{${b.key}}がない`);
  eq(g.friends, ["ぴのくま", "ぴりくま", "ぴよくま", "ぴかくま"], "送り先の候補");
  eq(g.friendAnswer, "ぴかくま", "送り先の正解");
  eq(g.ranking, ["ぴかくま", "ぷるゃ", "黒くま", "たぴおか"], "ランキング");
});
test("P-15", "写真ギミック: 画像(pic_tmp_gimmicPhoto)が設定され、正解範囲が画像内に収まっている", () => {
  const g = data.gimmicksById.gimmickPhoto;
  eq(g.image, "assets/backgrounds/pic_tmp_gimmicPhoto.webp");
  ok(fs.existsSync(path.join(ROOT, g.image)), "画像ファイルが無い");
  for (const r of g.regions) {
    const p = r.position;
    ok(p.x >= 0 && p.y >= 0 && p.x + p.width <= 100 && p.y + p.height <= 100, `${r.key} が画像からはみ出している`);
  }
});
test("P-13", "電話ギミック: #7*27で成功 / 7*27は不在 / その他は存在しない番号", () => {
  const e = setup({ part: 6 });
  e.engine.resolveGimmickResult("gimmickPhone", false, "7*27");
  eq(e.log.msgs, ["ぴさぎは不在みたいだッピ"]);
  eq(e.log.se, ["電話に出ない音"]);
  e.log.msgs.length = 0; e.log.se.length = 0;
  e.engine.resolveGimmickResult("gimmickPhone", false, "1234");
  eq(e.log.msgs, ["「この番号は存在しない」ってメッセージが流れてるッピ"]);
  eq(e.log.se, ["電話がつながらない音"]);
  ok(!e.state.flags.phoneGimmickCleared, "失敗で解除");
  e.log.msgs.length = 0; e.log.se.length = 0;
  e.engine.resolveGimmickResult("gimmickPhone", true, "#7*27");
  ok(e.state.flags.phoneGimmickCleared, "成功で未解除");
  eq(e.log.msgs, ["ぴつじは預かってるっぴ", "速く助けにくるっぴ", "困ってるっぴ！"]);
  eq(e.log.se, ["留守番電話を残すピーという電子音"]);
  eq(data.gimmicksById.gimmickPhone.answer, "#7*27");
});
test("P-14", "表情タップ PlayPart7: HAPPY追加前 / 追加後・変更前 / 変更後", () => {
  const defs = data.playPartsById[7].faceMessage;
  const pick = (e) => defs.find((d) => evaluate(d.when, e.state, e.ctx)).cycle;
  eq(pick(setup({ part: 7 })), ["パーティーするっぴ！楽しい雰囲気作るっぴ～！"]);
  const e2 = setup({ part: 7 }); e2.state.bgmState.unlockedTracks.push("happy");
  eq(pick(e2), ["さっきの音楽最高だったっぴ～！", "パーティーには楽しい音楽が欠かせないっぴ！"]);
  eq(pick(setup({ part: 7, bgm: "happy" })), ["これなら賑やかでぴつじも目を覚ますっぴ！", "ぴつじの脱出ゲームが始まるっぴ！"]);
});

test("P-16", "PlayPart1: 表情タップ時メッセージ「……」、ヒント「机上のモニターをタップしてみよう」", () => {
  eq(data.playPartsById[1].faceMessage.map((d) => d.text), ["……"]);
  eq(data.hintsById[1].steps, ["机上のモニターをタップしてみよう"]);
});

// =====================================================================
// S: ストーリー（ゲームストーリー.txt）・BGM
// =====================================================================
const IMG = (f) => `assets/backgrounds/${f}.webp`;
test("S-01", "ストーリーの背景画像・立ち絵・BGMのファイルが存在する", () => {
  const errs = [];
  for (const st of Object.values(data.storyPartsById)) for (const l of st.lines) {
    for (const p of [l.bgImage, ...[].concat(l.portraitImage || [])]) if (p && !fs.existsSync(path.join(ROOT, p))) errs.push(`story${st.id}: ${p}`);
  }
  eq(errs, []);
});
test("S-02", "配信画面(モニター)越しに話す黒ぴぐまは立ち絵を出さず、配信を切った後は立ち絵を出す", () => {
  const errs = [];
  for (const st of Object.values(data.storyPartsById)) {
    let streaming = false;
    for (const l of st.lines) {
      if (l.se === "モニターが映る音" || l.bgImage === IMG("bg_storyStream")) streaming = true;
      if (l.se === "モニターが切れる音") streaming = false;
      if (!l.speaker) continue;
      const shown = !l.noPortrait;
      if (l.speaker === "黒ぴぐま" && streaming && shown) errs.push(`story${st.id} 配信中に立ち絵: ${l.text}`);
      if (l.speaker === "黒ぴぐま" && !streaming && !l.portraitImage) errs.push(`story${st.id} 配信外で立ち絵なし: ${l.text}`);
      if (l.speaker === "ぴつじ" && !l.portraitImage) errs.push(`story${st.id} ぴつじの立ち絵なし: ${l.text}`);
    }
  }
  eq(errs, []);
});
test("S-03", "ストーリー1: 台詞・背景・BGMの切替タイミングが資料どおり", () => {
  const L = data.storyPartsById[1].lines;
  const texts = L.map((l) => l.text);
  eq(texts.slice(0, 3), ["ここは……？", "さっきまで木陰でお昼寝してたような……", "おはよう。気分はどうかな？"]);
  eq(L[0].bgm, "BGM_The Dark Eternal Night");
  eq(L[1].bgImage, IMG("bg_pitsujiRoom1"));
  eq([L[2].se, L[2].bgImage], ["モニターが映る音", IMG("bg_storyStream")]);
  const eIdx = texts.indexOf("え！？");
  eq([L[eIdx].stopBgm, L[eIdx].se, L[eIdx].bgImage], [true, "ぽにょん、と座り込む音", IMG("bg_pitsujiRoom1")], "BGMを止める");
  const again = texts.indexOf("お、おはよう。気分はどうかな？");
  eq([L[again].bgm, L[again].bgImage], ["BGM_The Dark Eternal Night", IMG("bg_storyStream")], "BGM再開");
  eq(L[texts.indexOf("･･････脱出しない")].bgm, "BGM_bo-tto_hidamari");
  const cut = texts.indexOf("え･･････？！");
  eq([L[cut].se, L[cut].bg], ["モニターが切れる音", "黒画面"]);
  eq(L[cut + 1].bgImage, IMG("bg_viewDesk"), "モニターを切った後は机(viewDesk)の背景");
  eq(texts.at(-1), "よーし！絶対ぴつじを脱出させてやるっぴよー！！");
});
test("S-04", "各ストーリーの最初と最後の台詞が資料どおり", () => {
  const exp = {
    1: ["ここは……？", "よーし！絶対ぴつじを脱出させてやるっぴよー！！"],
    2: ["ふふふ、チョコのお味はどうかな？", "やってやるっぴー！！"],
    3: ["ご機嫌はどうかな、ぴつじくん", "ぴつじとの根比べっぴ！！！"],
    4: ["今から君には脱出ゲーム", "ぴつじには負けないっぴー！！"],
    5: ["･･････", "どうするッピ･･････"],
    6: ["という訳だっぴ", "や、やるっぴー！！"],
    7: ["今から君には脱出ゲームをしてもらう！", "お祝いだっぴー！！！"],
    8: ["パーティーっぴー！", "いぇぇぇっぴー！！"]
  };
  for (const [id, [first, last]] of Object.entries(exp)) {
    const t = data.storyPartsById[id].lines.map((l) => l.text).filter(Boolean);
    eq([t[0], t.at(-1)], [first, last], `story${id}`);
  }
});
const { bgmSoundName, bgmTrackLabel, bgmUnlockMessage } = await imp("js/audio/BgmName.js");
test("S-05", "BGM名: audio.json の name、未設定(null)ならファイル名(BGM_除く)の先頭6文字。追加メッセージの書式", () => {
  eq(bgmSoundName("BGM_The Dark Eternal Night", data.audio), "The Da");
  eq(bgmSoundName("BGM_bo-tto_hidamari", data.audio), "bo-tto");
  eq(bgmTrackLabel(data.bgmById.happy, data.audio), "HAPPY");
  eq(bgmTrackLabel(data.bgmById.default, data.audio), "通常");
  eq(bgmSoundName("BGM_bo-tto_hidamari", { bgm: { "BGM_bo-tto_hidamari": { name: "ひだまり" } } }), "ひだまり", "name を設定した場合");
  eq(bgmUnlockMessage("HAPPY"), "BGM HAPPY がオーディオに追加された");
  // ストーリーで流れるBGMは、オーディオで選べる曲(bgm.json)に登録されている
  const storyBgms = new Set(Object.values(data.storyPartsById).flatMap((s) => s.lines.map((l) => l.bgm).filter(Boolean)));
  for (const k of storyBgms) ok(Object.values(data.bgmById).some((t) => t.sound === k), `bgm.json に ${k} が無い`);
});

// =====================================================================
// X: 網羅・ランダム操作（全パート×全クリックポイント×全アイテム選択、異常操作）
// =====================================================================
const ALL_ITEMS = Object.keys(data.itemsById);
const ALL_SPOTS = Object.values(data.spotsById);
// 操作パートpで移動できる視点（views.json accessCondition）
const viewsInPart = (p) => Object.values(data.viewsById).filter((v) => v.layoutType === "play" && (!v.accessCondition || evaluate(v.accessCondition, { ...createInitialState(), playPart: p }, {}))).map((v) => v.id);
// 状態のバリエーション: 何もしていない / 全て済ませた後
function variantState(p, variant) {
  const opt = { part: p };
  if (variant === "done") {
    const used = {};
    for (const it of Object.values(data.itemsById)) used[it.id] = [...it.usableOn];
    Object.assign(opt, {
      ever: ALL_ITEMS, used,
      flags: { doorBUnlocked: true, doorEntranceUnlocked: true, pitsujiWindowOpen: true, chatGimmickCleared: true, phoneGimmickCleared: true, gimmickPhotoCleared: true }
    });
  }
  return opt;
}
function withWarnCapture(fn) {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try { fn(); } finally { console.warn = orig; }
  return warns;
}

test("X-01", "全パート×全視点の全クリックポイント×(未選択+全アイテム選択)×(未進行/進行後): 例外・未知アクション・既定メッセージ・意図しないアイテム消費が無い", () => {
  const errs = [];
  let cases = 0;
  for (let p = 1; p <= 8; p++) {
    for (const variant of ["fresh", "done"]) {
      for (const viewId of viewsInPart(p)) {
        for (const spotId of data.viewsById[viewId].spots) {
          for (const sel of [null, ...ALL_ITEMS]) {
            cases++;
            const base = variantState(p, variant);
            const e = setup({ ...base, view: viewId, items: sel ? [sel] : [], selected: sel });
            if (!visible(e, spotId)) continue; // 非表示のクリックポイントはタップできない
            const before = JSON.stringify(e.state.itemUsageLog);
            let warns;
            try {
              warns = withWarnCapture(() => tap(e, spotId));
            } catch (ex) {
              errs.push(`part${p}/${variant}/${spotId}/${sel}: 例外 ${ex.message}`);
              continue;
            }
            if (warns.some((w) => w.includes("未知のアクション"))) errs.push(`part${p}/${spotId}: 未知のアクション`);
            if (e.log.msgs.some((m) => typeof m !== "string" || !m)) errs.push(`part${p}/${spotId}: 不正なメッセージ`);
            if (e.log.msgs.includes("今は何も起きない") && !["spotPhoneStandDrawer"].includes(spotId)) errs.push(`part${p}/${variant}/${spotId}: 既定メッセージ(フォールバック)`);
            if (e.state.phase !== "play") continue; // パートクリア時の残存アイテム破棄は正常動作
            // アイテムが消費/使用記録された場合、それは選択中アイテムで、かつ使用対象(usableOn)であること
            const usedChanged = JSON.stringify(e.state.itemUsageLog) !== before;
            const consumed = sel && !e.state.inventory.includes(sel) && !(data.itemsById[sel].transformsTo && e.state.inventory.includes(data.itemsById[sel].transformsTo));
            if ((usedChanged || (sel && !e.state.inventory.includes(sel))) && (!sel || !data.itemsById[sel].usableOn.includes(spotId))) errs.push(`part${p}/${variant}/${spotId}: ${sel} が使用対象外なのに使用された`);
            if (consumed && data.itemsById[sel].persistence === "remainInPart") errs.push(`part${p}/${spotId}: 残存アイテム ${sel} が消えた`);
            // 選択していたアイテムは、使用されたかどうかに関わらず所持品が重複しない
            if (new Set(e.state.inventory).size !== e.state.inventory.length) errs.push(`part${p}/${spotId}: 所持品が重複`);
          }
        }
      }
    }
  }
  ok(cases > 3000, `ケース数が少ない: ${cases}`);
  eq(errs.slice(0, 20), []);
});

test("X-02", "各アイテムは、入手できる操作パートで使用対象(usableOn)に実際に使える（使えない組合せが無い）", () => {
  const obtainPart = {
    itemChocolate: 2, itemBluePaper: 3, itemBread: 3, itemScrewDriver: 5, itemCushion: 5, itemLargeTowel: 5,
    itemCamera: 6, itemPhoto: 7, itemTambourine: 7, itemMaracas: 7, itemBlackLight: 4
  };
  const extra = { spotPitsujiWindow: { flags: { pitsujiWindowOpen: true } } };
  const errs = [];
  for (const [item, part] of Object.entries(obtainPart)) {
    for (const spotId of data.itemsById[item].usableOn) {
      const e = setup({ part, view: data.spotsById[spotId].viewId, items: [item], selected: item, ...(item !== "itemScrewDriver" ? extra[spotId] || {} : {}) });
      tap(e, spotId);
      if (!(e.state.itemUsageLog[item] || []).includes(spotId)) errs.push(`${item} → ${spotId} (part${part}) で使えない`);
    }
  }
  eq(errs, []);
});

test("X-03", "調査ノートの各ページで、どのアイテムを選択していてもアイテムが消費されない", () => {
  const errs = [];
  for (const p of [2, 7]) for (const sel of ALL_ITEMS) {
    const e = openNote({ part: p, items: [sel] });
    e.ctx.selectedItemId = sel;
    for (let i = 0; i < 8; i++) notePageTap(e);
    if (!e.state.inventory.includes(sel)) errs.push(`part${p}: ${sel}`);
  }
  eq(errs, []);
});

// 簡易乱数（再現性のため固定シード）
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

test("X-04", "ランダム操作(各パート3000手・デタラメなタップ/アイテム選択/移動/ギミック成否): 例外なし・所持品重複なし・セーブ容量が肥大化しない", () => {
  const errs = [];
  let maxSize = 0;
  for (let p = 1; p <= 8; p++) {
    const rand = rng(1234 + p);
    const e = setup({ part: p });
    for (let step = 0; step < 3000 && e.state.phase === "play"; step++) {
      const r = rand();
      const view = data.viewsById[e.state.currentView];
      try {
        if (view.layoutType === "note") {
          if (r < 0.8) notePageTap(e); else { e.state.notePage = 0; e.state.currentView = "viewDesk"; }
        } else if (r < 0.15) {
          const moves = data.transitions.filter((t) => t.view === view.id && (!t.condition || evaluate(t.condition, e.state, e.ctx)));
          if (moves.length) e.state.currentView = moves[Math.floor(rand() * moves.length)].target;
        } else {
          const spots = view.spots.filter((s) => visible(e, s));
          if (!spots.length) continue;
          e.ctx.selectedItemId = rand() < 0.4 && e.state.inventory.length ? e.state.inventory[Math.floor(rand() * e.state.inventory.length)] : null;
          e.log.gimmick.length = 0;
          tap(e, spots[Math.floor(rand() * spots.length)]);
          for (const g of e.log.gimmick) e.engine.resolveGimmickResult(g, rand() < 0.3, rand() < 0.5 ? "7*27" : "0");
          if (e.log.autoClear) { e.engine.runAutoClear(); }
        }
      } catch (ex) {
        errs.push(`part${p} step${step}: ${ex.message}`);
        break;
      }
      const s = e.state;
      if (new Set(s.inventory).size !== s.inventory.length) errs.push(`part${p}: 所持品重複`);
      if (new Set(s.everObtainedItems).size !== s.everObtainedItems.length) errs.push(`part${p}: 入手履歴重複`);
      for (const [k, v] of Object.entries(s.itemUsageLog)) if (new Set(v).size !== v.length) errs.push(`part${p}: 使用履歴重複 ${k}`);
      for (const [k, v] of Object.entries(s.clickCounts)) if (v > 1000) errs.push(`part${p}: クリック回数が増え続ける ${k}=${v}`);
      maxSize = Math.max(maxSize, JSON.stringify(s).length);
      if (errs.length) break;
    }
  }
  eq(errs.slice(0, 10), []);
  ok(maxSize < 4096, `セーブデータが大きすぎる: ${maxSize} bytes`);
});

test("X-05", "通常パス(エンジン): PlayPart1〜8を設計どおりの手順でクリアでき、セーブ容量も小さい", () => {
  const e = setup({ part: 1 });
  const go = (spot, sel = null) => { e.state.currentView = data.spotsById[spot].viewId; e.ctx.selectedItemId = sel; tap(e, spot); };
  const clear = () => { e.log.autoClear = 0; go("spotPcStream"); if (e.log.autoClear) e.engine.runAutoClear(); };
  const next = (p) => { eq(e.state.phase, "story", `part${p - 1}がクリアできない`); e.engine.advanceToPlayPart(p); };
  clear(); next(2);
  go("spotFridgeCompartment"); go("spotPitsujiDoorGap", "itemChocolate"); clear(); next(3);
  go("spotWallPaper"); go("spotFreezerCompartment", "itemBluePaper"); go("spotOnTable"); go("spotToaster", "itemBread");
  eq([...e.state.inventory].sort(), ["itemFrozenBluePaper", "itemToastedBread"]);
  e.engine.resolveGimmickResult("gimmickLockDoorB", true); clear(); next(4);
  eq(e.state.inventory, [], "part4開始時に残存アイテムが残る");
  go("spotPhoneStandDrawer"); go("spotSofa"); go("spotSwitch"); go("spotPhone", "itemBlackLight"); go("spotSalt", "itemBlackLight");
  e.engine.resolveGimmickResult("gimmickLockEntrance", true); clear(); next(5);
  go("spotToolbox"); go("spotPitsujiWindow", "itemScrewDriver"); go("spotChair"); go("spotBedmat");
  go("spotPitsujiWindow", "itemCushion"); go("spotPitsujiWindow", "itemLargeTowel"); clear(); next(6);
  go("spotBookshelf"); go("spotDrawer"); go("spotCardboardBox"); go("spotCardboardBox");
  go("spotUnderBed"); go("spotPitsujiWindow", "itemCamera");
  e.log.autoClear = 0; go("spotPhone"); e.engine.resolveGimmickResult("gimmickPhone", true, "#7*27");
  eq(e.log.autoClear, 0, "電話だけでクリア");
  go("spotGame"); e.engine.resolveGimmickResult("gimmickPcGame", true);
  eq(e.log.autoClear, 1); e.engine.runAutoClear(); next(7);
  eq(e.state.inventory, [], "part7開始時に所持品が残る");
  e.state.currentView = "viewDesk"; tap(e, "spotNotebook"); for (let i = 0; i < 6; i++) notePageTap(e);
  go("spotPisagi", "itemPhoto"); e.engine.resolveGimmickResult("gimmickPhoto", true);
  go("spotPisagi", "itemTambourine"); go("spotPiguma", "itemMaracas");
  ok(e.state.bgmState.unlockedTracks.includes("happy"), "HAPPY未追加");
  e.state.bgmState.currentTrack = "happy"; clear(); next(8);
  go("spotPitsujiExitDoor");
  eq(e.state.phase, "story"); eq(e.state.storyPart, 8);
  e.engine.advanceToPlayPart(null);
  eq(e.state.phase, "end");
  ok(JSON.stringify(e.state).length < 3000, `セーブが大きい ${JSON.stringify(e.state).length}`);
});

test("X-06", "SE: メッセージを挟まずに続けて鳴るSEは多くても2つ・同じSEが同時に重ならない（多重SEの防止）", () => {
  const errs = [];
  for (const s of ALL_SPOTS) for (const r of s.rules) {
    // メッセージ・画像表示で区切られたSEは、前のメッセージを読み終えてから順に鳴るため同時には鳴らない
    let group = [];
    const check = () => {
      if (group.length > 2) errs.push(`${s.id}: 続けて${group.length}個`);
      if (new Set(group).size !== group.length) errs.push(`${s.id}: 同じSEが重複 ${group}`);
      group = [];
    };
    for (const a of r.actions) {
      if (a.type === "se") group.push(a.id);
      else if (["message", "showImageModal", "triggerGimmick"].includes(a.type)) check();
    }
    check();
  }
  eq(errs, []);
});

// =====================================================================
// D: データ整合性
// =====================================================================
// =====================================================================
// I: アイテム入手時の拡大画像（修正依頼: 入手時に拡大画像を表示し、タップで閉じる）
// =====================================================================
test("I-01", "入手時に拡大画像を表示する: 資料の「取得」の位置(メッセージ・SEとの順番)で1回だけ", () => {
  const ef = tap(setup({ part: 2, view: "viewRefrigerator" }), "spotFridgeCompartment");
  eq(ef.log.seq, ["se:Se_Refrigeratol", "obtain:itemChocolate", "msg:ぴつじの好きなチョコレートっぴ！", "msg:これをぴつじに渡すっぴ！"]);
  const eb = tap(setup({ part: 5, view: "viewBed" }), "spotBedmat");
  eq(eb.log.seq, ["se:TBD_ベッドマット", "msg:ふわふわタオルケット。これは気にいるっぴ", "obtain:itemLargeTowel"]);
  const ek = tap(setup({ part: 6, view: "roomPiguma" }), "spotBookshelf");
  eq(ek.log.seq.filter((s) => s.startsWith("obtain:")), ["obtain:itemPisagiCard"]);
  eq(ek.log.image.length, 1, "しおりの本の画像");
  // 取得済みの再タップでは表示しない
  eq(tap(setup({ part: 2, view: "viewRefrigerator", ever: ["itemChocolate"] }), "spotFridgeCompartment").log.obtained, []);
});
test("I-02", "変化するアイテムは変化後のアイテムを入手として表示（冷凍後の青い紙 / 焼かれた食パンは焼き上がりの後）", () => {
  const ez = tap(setup({ part: 3, view: "viewRefrigerator", items: ["itemBluePaper"], selected: "itemBluePaper" }), "spotFreezerCompartment");
  eq(ez.log.seq, ["se:Se_Refrigeratol", "obtain:itemFrozenBluePaper", "msg:この紙は冷やすと文字が出てくるっぴ！"]);
  const et = tap(setup({ part: 3, view: "viewToaster", items: ["itemBread"], selected: "itemBread" }), "spotToaster");
  eq(et.log.seq, ["msg:パンを焼くっぴ～", "se:焼いている音", "se:トースターが終わる音", "obtain:itemToastedBread", "msg:お腹空いたけど食べる前にヒント見るっぴ！", "msg:後で美味しくいただくっぴ～！"]);
  // 消失アイテムの使用では入手表示を出さない
  eq(tap(setup({ part: 2, view: "viewPitsujiDoor", items: ["itemChocolate"], selected: "itemChocolate" }), "spotPitsujiDoorGap").log.obtained, []);
});
test("I-03", "ギミック成功・調査ノートでの入手も表示（マラカス・タンバリン / 写真）", () => {
  const eg = setup({ part: 7, view: "roomB1" });
  eg.engine.resolveGimmickResult("gimmickPhoto", true);
  eq(eg.log.obtained, ["itemMaracas", "itemTambourine"]);
  const en = openNote({ part: 7 });
  for (let i = 0; i < 6; i++) notePageTap(en);
  eq(en.log.obtained, ["itemPhoto"]);
});
test("I-04", "全ての入手箇所(giveItem・変化)で、入手したアイテムと同じものが1回ずつ表示される（通しプレイ）", () => {
  const errs = [];
  for (let p = 1; p <= 8; p++) {
    for (const viewId of viewsInPart(p)) {
      for (const spotId of data.viewsById[viewId].spots) {
        for (const sel of [null, ...ALL_ITEMS]) {
          const e = setup({ part: p, view: viewId, items: sel ? [sel] : [], selected: sel, flags: { pitsujiWindowOpen: true } });
          if (!visible(e, spotId)) continue;
          const before = [...e.state.inventory];
          tap(e, spotId);
          const added = e.state.inventory.filter((id) => !before.includes(id));
          if (JSON.stringify(added) !== JSON.stringify(e.log.obtained)) errs.push(`part${p}/${spotId}/${sel}: 入手${JSON.stringify(added)} 表示${JSON.stringify(e.log.obtained)}`);
        }
      }
    }
  }
  eq(errs.slice(0, 10), []);
});

// =====================================================================
// W: 不正解位置でのアイテム使用（修正依頼: 正解位置以外では消費しない）
// =====================================================================
// 各アイテムの正解位置（ゲームクリックポイント.txt の「使用」）。ここに無い場所は全て不正解位置。
const CORRECT_USE = {
  itemChocolate: ["spotPitsujiDoorGap"],
  itemBluePaper: ["spotFreezerCompartment"],
  itemBread: ["spotToaster"],
  itemBlackLight: ["spotPhone", "spotSalt"],
  itemScrewDriver: ["spotPitsujiWindow"],
  itemCushion: ["spotPitsujiWindow"],
  itemLargeTowel: ["spotPitsujiWindow"],
  itemCamera: ["spotPitsujiWindow"],
  itemPhoto: ["spotPisagi"],
  itemTambourine: ["spotPisagi"],
  itemMaracas: ["spotPiguma"],
  itemFrozenBluePaper: [], itemToastedBread: [], itemIllust: [], itemPisagiCard: [], itemPhoneManual: []
};
test("W-01", "正解位置の一覧が items.json の usableOn と一致し、使用(consumeSelectedItem)は正解位置の選択中アイテムにしか設定されていない", () => {
  const errs = [];
  for (const id of ALL_ITEMS) {
    if (JSON.stringify([...(CORRECT_USE[id] || ["(一覧に無い)"])].sort()) !== JSON.stringify([...data.itemsById[id].usableOn].sort())) errs.push(`${id}: usableOn ${JSON.stringify(data.itemsById[id].usableOn)}`);
  }
  // 条件式に含まれる selectedItem を全て集める（allOf/anyOf の中も）
  const selectedIn = (w) => !w || typeof w !== "object" ? [] : [...(w.selectedItem ? [w.selectedItem] : []), ...[...(w.allOf || []), ...(w.anyOf || [])].flatMap(selectedIn)];
  const ruleSets = [
    ...Object.values(data.spotsById).map((s) => [s.id, s.rules]),
    ...Object.values(data.viewsById).flatMap((v) => (v.pages || []).flatMap((pg) => [[pg.id, pg.onShow || []], [pg.id, pg.onTap || []]]))
  ];
  for (const [where, rules] of ruleSets) {
    for (const r of rules) {
      if (!r.actions.some((a) => a.type === "consumeSelectedItem")) continue;
      const sels = selectedIn(r.when);
      if (sels.length !== 1) errs.push(`${where}: 使用するアイテムが条件で1つに決まっていない`);
      for (const it of sels) if (!(CORRECT_USE[it] || []).includes(where)) errs.push(`${where}: ${it} は正解位置ではないのに使用する`);
    }
  }
  for (const g of Object.values(data.gimmicksById)) {
    for (const a of [...(g.onSuccess || []), ...(g.onFail || []), ...(g.failCases || []).flatMap((c) => c.actions)]) {
      if (a.type === "consumeSelectedItem") errs.push(`${g.id}: ギミックで選択中アイテムを使用する`);
    }
  }
  eq(errs, []);
});
test("W-02", "不正解位置: 全アイテム×正解位置以外の全クリックポイント×全パート×(未進行/進行後)で、消費も使用記録もされない", () => {
  const errs = [];
  let cases = 0;
  for (let p = 1; p <= 8; p++) {
    for (const variant of ["fresh", "done"]) {
      for (const viewId of viewsInPart(p)) {
        for (const spotId of data.viewsById[viewId].spots) {
          for (const sel of ALL_ITEMS) {
            if (CORRECT_USE[sel].includes(spotId)) continue;
            const base = variantState(p, variant);
            for (const flags of [base.flags || {}, { ...(base.flags || {}), pitsujiWindowOpen: true }]) {
              const e = setup({ ...base, flags, view: viewId, items: [sel], selected: sel });
              if (!visible(e, spotId)) continue;
              cases++;
              const usedBefore = JSON.stringify(e.state.itemUsageLog);
              tap(e, spotId);
              if (e.state.phase !== "play") continue; // パートクリア時の残存アイテム破棄は正常動作
              if (!e.state.inventory.includes(sel)) errs.push(`part${p}/${variant}/${spotId}: ${sel} が消費された`);
              if (JSON.stringify(e.state.itemUsageLog) !== usedBefore) errs.push(`part${p}/${variant}/${spotId}: ${sel} が使用記録された`);
            }
          }
        }
      }
    }
  }
  ok(cases > 2000, `ケース数が少ない: ${cases}`);
  eq(errs.slice(0, 20), []);
});
test("W-03", "データの設定ミスで不正解位置に使用処理が走っても、アイテムは消費されず選択も残る（Inventoryの安全策）", () => {
  const e = setup({ part: 3, view: "viewToaster", items: ["itemChocolate"], selected: "itemChocolate" });
  const origError = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(" "));
  try { e.engine.runActions([{ type: "consumeSelectedItem" }], "spotToaster"); } finally { console.error = origError; }
  eq(e.state.inventory, ["itemChocolate"]);
  eq(e.state.itemUsageLog, {});
  eq(e.ctx.selectedItemId, "itemChocolate");
  eq(e.log.obtained, []);
  ok(errors.some((m) => m.includes("itemChocolate")), "コンソールに設定ミスが出ていない");
});

test("D-01", "全spot/view/gimmick/itemの参照先が存在する", () => {
  const errs = [];
  for (const v of Object.values(data.viewsById)) for (const s of v.spots) if (!data.spotsById[s]) errs.push(`view ${v.id} → spot ${s}`);
  const walk = (actions, where) => {
    for (const a of actions) {
      if (a.type === "moveTo" && !data.viewsById[a.target]) errs.push(`${where} moveTo ${a.target}`);
      if (a.type === "triggerGimmick" && !data.gimmicksById[a.target]) errs.push(`${where} gimmick ${a.target}`);
      if (["giveItem", "consumeItem"].includes(a.type) && !data.itemsById[a.item]) errs.push(`${where} item ${a.item}`);
      if (["unlockBgmTrack", "setBgmTrack"].includes(a.type) && !data.bgmById[a.track]) errs.push(`${where} bgm ${a.track}`);
      if (a.type === "showImageModal" && a.bgm && !data.bgmById[a.bgm]) errs.push(`${where} bgm ${a.bgm}`);
    }
  };
  for (const s of Object.values(data.spotsById)) s.rules.forEach((r) => walk(r.actions, s.id));
  for (const g of Object.values(data.gimmicksById)) { walk(g.onSuccess, g.id); walk(g.onFail, g.id); (g.failCases || []).forEach((c) => walk(c.actions, g.id)); }
  for (const v of Object.values(data.viewsById)) for (const p of v.pages || []) { (p.onShow || []).forEach((r) => walk(r.actions, p.id)); (p.onTap || []).forEach((r) => walk(r.actions, p.id)); }
  for (const t of data.transitions) { if (!data.viewsById[t.view] || !data.viewsById[t.target]) errs.push(`transition ${t.view}→${t.target}`); }
  for (const i of Object.values(data.itemsById)) for (const s of i.usableOn) if (!data.spotsById[s]) errs.push(`item ${i.id} usableOn ${s}`);
  eq(errs, []);
});
test("D-02", "全アイテムに説明文(拡大表示用)がある（名刺は表/裏の2ページ）", () => {
  eq(Object.values(data.itemsById).filter((i) => !(i.description || (i.zoomPages?.length && i.zoomPages.every((p) => p.text)))).map((i) => i.id), []);
  eq(data.itemsById.itemPisagiCard.zoomPages.map((p) => p.text), ["ぴさぎは仕事人っぴ！", "留守番電話にメッセージを残してください、ッピ……？"]);
});
test("D-03", "全PlayPartに開始時メッセージ、PlayPart1〜7に表情タップ時メッセージがある", () => {
  for (let i = 1; i <= 8; i++) ok(data.playPartsById[i].startMessages.length > 0, `part${i} 開始時メッセージなし`);
  for (let i = 1; i <= 7; i++) ok((data.playPartsById[i].faceMessage || []).length > 0, `part${i} 表情タップ時メッセージなし`);
});
test("D-04", "どのviewからも机拡大(viewDesk)に戻れる(PlayPart7時点、ぴつじ部屋除く)", () => {
  const e = setup({ part: 7 });
  const adj = {};
  for (const t of data.transitions) if (!t.condition || evaluate(t.condition, e.state, e.ctx)) (adj[t.view] ||= []).push(t.target);
  for (const s of Object.values(data.spotsById)) for (const r of s.rules) for (const a of r.actions) if (a.type === "moveTo") (adj[s.viewId] ||= []).push(a.target);
  adj.viewNote = ["viewDesk"];
  const unreachable = [];
  for (const v of Object.keys(data.viewsById)) {
    if (v === "roomPitsuji") continue;
    const seen = new Set([v]); const q = [v];
    while (q.length) { const c = q.shift(); for (const n of adj[c] || []) if (!seen.has(n)) { seen.add(n); q.push(n); } }
    if (!seen.has("viewDesk")) unreachable.push(v);
  }
  eq(unreachable, []);
});
test("D-06", "SE・BGMのキーが全て audio.json に登録されている（ファイル未設定のnullは可）", () => {
  const audio = load("audio.json");
  const errs = [];
  const seKeys = new Set();
  const collect = (actions) => { for (const a of actions || []) if (a.type === "se") seKeys.add(a.id); };
  for (const s of Object.values(data.spotsById)) s.rules.forEach((r) => collect(r.actions));
  for (const g of Object.values(data.gimmicksById)) { collect(g.onSuccess); collect(g.onFail); (g.failCases || []).forEach((c) => collect(c.actions)); }
  for (const v of Object.values(data.viewsById)) for (const p of v.pages || []) [...(p.onShow || []), ...(p.onTap || [])].forEach((r) => collect(r.actions));
  for (const s of Object.values(data.storyPartsById)) for (const l of s.lines) if (l.se) seKeys.add(l.se);
  for (const pp of Object.values(data.playPartsById)) if (pp.clearSE) seKeys.add(pp.clearSE);
  for (const k of Object.values(audio.ui)) if (k) seKeys.add(k);
  for (const k of seKeys) if (!(k in audio.se)) errs.push("se " + k);
  const bgmKeys = new Set();
  for (const pp of Object.values(data.playPartsById)) if (pp.bgm) bgmKeys.add(pp.bgm);
  for (const s of Object.values(data.storyPartsById)) for (const l of s.lines) if (l.bgm) bgmKeys.add(l.bgm);
  for (const b of Object.values(data.bgmById)) if (b.sound) bgmKeys.add(b.sound);
  for (const k of bgmKeys) if (!(k in audio.bgm)) errs.push("bgm " + k);
  for (const [k, d] of [...Object.entries(audio.se), ...Object.entries(audio.bgm)]) if (d && d.file && !fs.existsSync(path.join(ROOT, d.file))) errs.push("file無し " + k + ": " + d.file);
  eq(errs, []);
});
test("D-05", "削除済みアイテム(音楽CD・ぴつじの写真)がデータに残っていない", () => {
  const all = ["items", "spots", "views", "gimmicks", "playParts", "hints"].map((f) => fs.readFileSync(path.join(ROOT, "data", f + ".json"), "utf8")).join("");
  ok(!/itemCD|itemPhotoPitsuji/.test(all), "参照が残っている");
});

// ---- 結果 ----
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "OK  " : "NG  "} ${r.id} ${r.title}${r.ok ? "" : "\n       → " + r.err}`);
console.log(`\n${results.length}件中 ${results.length - failed.length}件OK / ${failed.length}件NG`);
process.exitCode = failed.length ? 1 : 0;
