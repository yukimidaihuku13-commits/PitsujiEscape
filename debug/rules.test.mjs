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
  transitions: load("transitions.json")
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
  const log = { msgs: [], se: [], gimmick: [], image: [], story: [], bgmMenu: 0, autoClear: 0 };
  const ui = {
    queueMessage: (t) => log.msgs.push(t),
    playSE: (id) => log.se.push(id),
    openGimmick: (id) => log.gimmick.push(id),
    closeGimmick: () => {},
    enterStoryPart: (id) => log.story.push(id),
    enterPlayPart: () => {},
    showImageModal: (o) => log.image.push(o.caption),
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
test("R-01", "本棚 PlayPart3: 4行を順に表示し、5回目で1行目に戻る", () => {
  const env = setup({ part: 3, view: "roomPiguma" });
  for (let i = 0; i < 5; i++) tap(env, "spotBookshelf");
  eq(env.log.msgs, ["インクについて、という本だ。", "温めると文字が消える。", "冷やすと文字が消える。", "と書いてある。謎を作る時に参考にした本。", "インクについて、という本だ。"]);
});
test("R-02", "本棚 PlayPart5: 3行ループ（PlayPart3のカウントを引き継がない）", () => {
  const env = setup({ part: 5, view: "roomPiguma", clicks: { spotBookshelf: 2 } });
  for (let i = 0; i < 4; i++) tap(env, "spotBookshelf");
  eq(env.log.msgs, ["ホームズの踊る人形だっぴ！", "換字式暗号の中で一番好きだっぴ！", "別の記号に置き換えられた絵文字を解読するホームズは凄いっぴ", "ホームズの踊る人形だっぴ！"]);
});
test("R-03", "本棚 PlayPart6: 名刺入手（メッセージ・SE・本の画像）", () => {
  const env = tap(setup({ part: 6, view: "roomPiguma" }), "spotBookshelf");
  eq(env.log.msgs, ["そういえば名刺をしおり代わりにしてたっぴ"]);
  eq(env.log.se, ["本を開くぱらっという音"]);
  eq(env.log.image.length, 1, "画像表示");
  ok(env.state.inventory.includes("itemPisagiCard"), "名刺を所持していない");
});
test("R-04", "本棚 名刺入手後: 2種のどちらかをランダム表示", () => {
  const env = setup({ part: 6, view: "roomPiguma", ever: ["itemPisagiCard"] });
  for (let i = 0; i < 20; i++) tap(env, "spotBookshelf");
  const set = new Set(env.log.msgs);
  ok([...set].every((m) => ["クローズド・サークルといえばアガサクリスティっぴ", "シャーロック・ホームズは名作だっぴねぇ"].includes(m)), [...set].join("/"));
  ok(set.size === 2, "20回で2種とも出ていない（乱数の偏り。再実行で確認）");
});
test("R-05", "本棚 その他のパート(2,4,7)", () => {
  for (const part of [2, 4, 7]) {
    const env = tap(setup({ part, view: "roomPiguma" }), "spotBookshelf");
    eq(env.log.msgs, ["最近のお気に入りはホームズの踊る人形だ"], `part${part}`);
  }
});
test("R-06", "ベッド: PlayPart1は非表示、2以降はベッド拡大へ", () => {
  ok(!visible(setup({ part: 1, view: "roomPiguma" }), "spotBed"), "part1で表示されている");
  const env = tap(setup({ part: 2, view: "roomPiguma" }), "spotBed");
  eq(env.state.currentView, "viewBed");
});
test("R-07", "ぴぐま: PlayPart7のみ表示。マラカス使用でCD入手", () => {
  for (const p of [2, 3, 4, 5, 6, 8]) ok(!visible(setup({ part: p, view: "roomPiguma" }), "spotPiguma"), `part${p}で表示`);
  const e1 = tap(setup({ part: 7, view: "roomPiguma" }), "spotPiguma");
  eq(e1.log.msgs, ["うきうきしていてなんだか楽しそうだっぴ"]);
  const e2 = tap(setup({ part: 7, view: "roomPiguma", items: ["itemMaracas"], selected: "itemMaracas" }), "spotPiguma");
  eq(e2.log.msgs, ["マラカスを受け取ってぴぐまが踊り出した！", "音楽CDを貰ったっぴ！"]);
  eq(e2.log.se, ["マラカスをシャカシャカする音"]);
  eq(e2.state.inventory, ["itemCD"]);
});
test("R-08", "ゲーム機: PlayPart1非表示 / 6でギミック / 6クリア後 / その他", () => {
  ok(!visible(setup({ part: 1 }), "spotGame"), "part1で表示");
  const e6 = tap(setup({ part: 6 }), "spotGame");
  eq(e6.log.gimmick, ["gimmickPcGame"]);
  eq(e6.log.se, ["ゲーム開始っぽい音"]);
  eq(tap(setup({ part: 6, flags: { chatGimmickCleared: true } }), "spotGame").log.msgs, ["これでぴぐまが気付いてくれるっぴ"]);
  for (const p of [2, 3, 4, 5, 7]) eq(tap(setup({ part: p }), "spotGame").log.msgs, ["今はゲームの時じゃないっピ...！"], `part${p}`);
});
test("R-09", "配信用カメラ: 各パートの未達メッセージ", () => {
  const cases = [
    [2, {}, ["ぴつじのテンションを上げるっぴ！"]],
    [2, { ever: ["itemChocolate"] }, ["チョコレートでテンションアップっぴ！"]],
    [3, {}, ["ぴつじを脱出させるっぴ～！！！"]],
    [4, {}, ["これはぴつじとの勝負っぴ！", "ぴつじを！部屋から！脱出させる！！！"]],
    [5, {}, ["ぴつじなかなか手強いッピ……", "何をしたら出てくるっぴ？！"]],
    [5, { used: { itemCushion: ["spotPitsujiWindow"] } }, ["ぴつじなかなか手強いッピ……", "何をしたら出てくるっぴ？！"]],
    [6, {}, ["ぴつじが寝てて今は無理ッピ......"]],
    [6, { used: { itemPisagiCard: ["spotPhone"] } }, ["ぴつじが寝てて今は無理ッピ......"]],
    [7, {}, ["脱出させるっぴ！！！！"]],
  ];
  for (const [part, opt, exp] of cases) {
    const env = tap(setup({ part, ...opt }), "spotPcStream");
    eq(env.log.msgs, exp, `part${part} ${JSON.stringify(opt)}`);
    eq(env.log.story, [], `part${part} 未達なのにクリアした`);
  }
});
test("R-10", "配信用カメラ: 各パートのクリア条件（1,2,3,4,5,7）でストーリーへ", () => {
  const cases = [
    [1, {}],
    [2, { used: { itemChocolate: ["spotPitsujiDoorGap"] } }],
    [3, { flags: { doorBUnlocked: true } }],
    [4, { flags: { doorEntranceUnlocked: true } }],
    [5, { used: { itemCushion: ["spotPitsujiWindow"], itemLargeTowel: ["spotPitsujiWindow"] } }],
    [7, { bgm: "happy" }]
  ];
  for (const [part, opt] of cases) {
    const env = tap(setup({ part, ...opt }), "spotPcStream");
    eq(env.log.story, [part], `part${part}`);
    eq(env.log.se, ["click"], `part${part} SE`);
    eq(env.state.phase, "story");
  }
});
test("R-11", "調査ノート: PlayPart1は非表示、2以降はノートを開く(ページ1左)", () => {
  ok(!visible(setup({ part: 1 }), "spotNotebook"), "part1で表示");
  const env = tap(setup({ part: 2, notePage: 3 }), "spotNotebook");
  eq(env.state.currentView, "viewNote");
  eq(notePageId(env), "note1left");
  eq(env.log.msgs, ["ぴつじはチョコレートが好きと……"]);
});
test("R-12", "ベッドマット: 取得後 / PlayPart5で入手 / その他", () => {
  eq(tap(setup({ part: 5, view: "viewBed", ever: ["itemLargeTowel"] }), "spotBedmat").log.msgs, ["沈み込むタイプのベッドマット 満足度が高いっぴ"]);
  const e = tap(setup({ part: 5, view: "viewBed" }), "spotBedmat");
  eq(e.log.msgs, ["ふわふわタオルケット これは気にいるっぴ"]);
  eq(e.state.inventory, ["itemLargeTowel"]);
  eq(tap(setup({ part: 4, view: "viewBed" }), "spotBedmat").log.msgs, ["このタオルケットの生地の触り心地は最高だ"]);
});
test("R-13", "ベッドマット: タオルケット入手後はベッド背景が差分に変わる", () => {
  const { state, ctx } = setup({ part: 5, view: "viewBed", ever: ["itemLargeTowel"] });
  const v = data.viewsById.viewBed;
  ok(v.backgroundVariants.some((b) => evaluate(b.when, state, ctx)), "差分背景に切り替わらない");
});
test("R-14", "ベッド下: カメラ取得後 / PlayPart6で入手 / その他", () => {
  eq(tap(setup({ part: 6, view: "viewBed", ever: ["itemCamera"] }), "spotUnderBed").log.msgs, ["ここにはもう何もないっぴ"]);
  const e = tap(setup({ part: 6, view: "viewBed" }), "spotUnderBed");
  eq(e.log.msgs, ["カメラあった！"]);
  eq(e.log.se, ["ガサガサっという探す音"]);
  eq(e.state.inventory, ["itemCamera"]);
  eq(tap(setup({ part: 5, view: "viewBed" }), "spotUnderBed").log.msgs, ["今は使わないものが置いてあるっぴ"]);
});
test("R-15", "ドアB: PlayPart4以降は部屋B1へ / 3の解除前後 / 2", () => {
  eq(tap(setup({ part: 4, view: "roomA1" }), "spotDoorB").state.currentView, "roomB1");
  eq(tap(setup({ part: 3, view: "roomA1", flags: { doorBUnlocked: true } }), "spotDoorB").log.msgs, ["これでぴつじも脱出したくなるはず！"]);
  eq(tap(setup({ part: 3, view: "roomA1" }), "spotDoorB").log.msgs, ["ロックを解除しないと開かない仕組みにしてある"]);
  eq(tap(setup({ part: 2, view: "roomA1" }), "spotDoorB").log.msgs, ["隣の部屋に続くドアだ"]);
  eq(tap(setup({ part: 3, view: "roomA1", flags: { doorBUnlocked: true } }), "spotDoorB").state.currentView, "roomA1", "part3で部屋Bに移動できてしまう");
});
test("R-16", "ドアBの電子錠: 解除後 / PlayPart3でギミック / その他", () => {
  eq(tap(setup({ part: 4, view: "roomA1", flags: { doorBUnlocked: true } }), "spotLockDoorB").log.msgs, ["ロックは解除されている"]);
  const e = tap(setup({ part: 3, view: "roomA1" }), "spotLockDoorB");
  eq(e.log.gimmick, ["gimmickLockDoorB"]);
  eq(e.log.msgs, ["えーっと、答えはなんだっけ……"]);
  eq(tap(setup({ part: 2, view: "roomA1" }), "spotLockDoorB").log.msgs, ["ドアの鍵を開ける脱出の仕掛けだ"]);
});
test("R-17", "冷蔵庫/トースター/テーブル/棚/ぴつじ部屋ドア/黒ぴぐま部屋ドア/机/電話台/ドアA/ローテーブル: 視点移動", () => {
  const moves = [
    ["roomA1", "spotRefrigerator", "viewRefrigerator"], ["roomA1", "spotDoorKitchen", "viewToaster"], ["roomA1", "spotTable", "viewTable"],
    ["roomA2", "spotShelf", "viewShelf"], ["roomA2", "spotPitsujiDoor", "viewPitsujiDoor"], ["roomA2", "spotDoorPiguma", "roomPiguma"],
    ["roomPiguma", "spotDesk", "viewDesk"], ["roomB1", "spotPhoneStand", "viewPhoneStand"], ["roomB1", "spotDoorA", "roomA1"],
    ["roomB2", "spotLowTable", "viewLowTable"]
  ];
  for (const [view, spot, target] of moves) eq(tap(setup({ part: 4, view }), spot).state.currentView, target, spot);
});
test("R-18", "テーブルの上: 取得後 / PlayPart3で食パン / その他", () => {
  eq(tap(setup({ part: 3, view: "viewTable", ever: ["itemBread"] }), "spotOnTable").log.msgs, ["少しお腹がすいてきたな"]);
  const e = tap(setup({ part: 3, view: "viewTable" }), "spotOnTable");
  eq(e.log.msgs, ["食パンを手に入れた"]);
  eq(e.state.inventory, ["itemBread"]);
  eq(tap(setup({ part: 2, view: "viewTable" }), "spotOnTable").log.msgs, ["朝は断然食パンっぴ！"]);
});
test("R-19", "椅子: 取得後 / PlayPart5でクッション / その他", () => {
  eq(tap(setup({ part: 5, view: "viewTable", ever: ["itemCushion"] }), "spotChair").log.msgs, ["クッションが無いと背もたれが硬くて座りにくい"]);
  const e = tap(setup({ part: 5, view: "viewTable" }), "spotChair");
  eq(e.log.msgs, ["クッションを手に入れた"]);
  eq(e.state.inventory, ["itemCushion"]);
  eq(tap(setup({ part: 4, view: "viewTable" }), "spotChair").log.msgs, ["ふかふかのクッションが背中を守ってくれる"]);
});
test("R-20", "段ボール: PlayPart6の1回目はメッセージ、2回目以降は宛先画像 / 7以降 / その他", () => {
  const e = setup({ part: 6, view: "roomA2" });
  tap(e, "spotCardboardBox");
  eq(e.log.msgs, ["確か下の段のダンボールに書いてあったはず"]);
  eq(e.log.image.length, 0, "1回目で画像表示");
  tap(e, "spotCardboardBox");
  eq(e.log.image.length, 1, "2回目で画像が出ない");
  tap(e, "spotCardboardBox");
  eq(e.log.image.length, 2, "3回目以降で画像が出ない");
  eq(tap(setup({ part: 7, view: "roomA2" }), "spotCardboardBox").log.msgs, ["そのうち片付けよう"]);
  eq(tap(setup({ part: 5, view: "roomA2" }), "spotCardboardBox").log.msgs, ["脱出に必要なものを色々買った時のダンボールだ"]);
});
test("R-21", "壁の貼り紙: 取得後 / PlayPart4以降 / 3で青い紙 / 2", () => {
  eq(tap(setup({ part: 3, view: "roomA2", ever: ["itemBluePaper"] }), "spotWallPaper").log.msgs, ["もうここには何もなさそうだ"]);
  eq(tap(setup({ part: 4, view: "roomA2" }), "spotWallPaper").log.msgs, ["この紙は脱出ゲーム用に用意したんだったな"]);
  const e = tap(setup({ part: 3, view: "roomA2" }), "spotWallPaper");
  eq(e.log.msgs, ["青い紙を取得した"]);
  eq(e.state.inventory, ["itemBluePaper"]);
  eq(tap(setup({ part: 2, view: "roomA2" }), "spotWallPaper").log.msgs, ["壁に何か貼ってある"]);
});
test("R-22", "冷蔵庫(冷蔵部): 取得後 / PlayPart2でチョコ / その他", () => {
  eq(tap(setup({ part: 2, view: "viewRefrigerator", ever: ["itemChocolate"] }), "spotFridgeCompartment").log.msgs, ["つい開けてしまうけど……何もないッピ"]);
  const e = tap(setup({ part: 2, view: "viewRefrigerator" }), "spotFridgeCompartment");
  eq(e.log.msgs, ["ぴつじの好きなチョコレートっぴ！", "これをぴつじに渡すっぴ！"]);
  eq(e.state.inventory, ["itemChocolate"]);
  eq(tap(setup({ part: 3, view: "viewRefrigerator" }), "spotFridgeCompartment").log.msgs, ["いざという時に食べたいチョコレートが入れてある"]);
});
test("R-23", "冷凍庫: 取得後 / 3で青い紙→冷凍後の青い紙 / 3で未選択 / その他", () => {
  eq(tap(setup({ part: 3, view: "viewRefrigerator", ever: ["itemFrozenBluePaper"] }), "spotFreezerCompartment").log.msgs, ["アイスでも入れておけばよかった"]);
  const e = tap(setup({ part: 3, view: "viewRefrigerator", items: ["itemBluePaper"], selected: "itemBluePaper" }), "spotFreezerCompartment");
  eq(e.log.msgs, ["この紙は冷やすと文字が出てくるっぴ！"]);
  eq(e.state.inventory, ["itemFrozenBluePaper"]);
  eq(e.ctx.selectedItemId, null);
  eq(tap(setup({ part: 3, view: "viewRefrigerator", items: ["itemBluePaper"] }), "spotFreezerCompartment").log.msgs, ["ここにあれを入れればいいっぴね～"]);
  eq(tap(setup({ part: 2, view: "viewRefrigerator" }), "spotFreezerCompartment").log.msgs, ["開けるとひんやりする"]);
});
test("R-24", "冷凍庫: 違うアイテム(食パン)を選択して使っても消費されない", () => {
  const e = tap(setup({ part: 3, view: "viewRefrigerator", items: ["itemBread"], selected: "itemBread" }), "spotFreezerCompartment");
  eq(e.state.inventory, ["itemBread"]);
  eq(e.log.msgs, ["ここにあれを入れればいいっぴね～"]);
});
test("R-25", "トースター: 取得後 / PlayPart4以降 / 3で食パン→焼かれた食パン / 3で未選択 / 2", () => {
  eq(tap(setup({ part: 3, view: "viewToaster", ever: ["itemToastedBread"] }), "spotToaster").log.msgs, ["まだトースターが温かい"]);
  eq(tap(setup({ part: 4, view: "viewToaster" }), "spotToaster").log.msgs, ["謎解きに使うはずだったトースターだ"]);
  const e = tap(setup({ part: 3, view: "viewToaster", items: ["itemBread"], selected: "itemBread" }), "spotToaster");
  eq(e.log.msgs, ["後でトースト食べるっぴ～！"]);
  eq(e.state.inventory, ["itemToastedBread"]);
  eq(tap(setup({ part: 3, view: "viewToaster" }), "spotToaster").log.msgs, ["このトースターは美味しく焼けるっぴ！"]);
  eq(tap(setup({ part: 2, view: "viewToaster" }), "spotToaster").log.msgs, ["美味しいパンが焼けるっぴ"]);
});
test("R-26", "ぴつじ部屋ドアノブ", () => {
  eq(tap(setup({ part: 2, view: "viewPitsujiDoor" }), "spotPitsujiDoorKnob").log.msgs, ["よし！絶対ぴつじを脱出させてやる！"]);
});
test("R-27", "ドア小窓 PlayPart5: 未開放→ドライバーで開放→クッション/タオルケット", () => {
  const e = setup({ part: 5, view: "viewPitsujiDoor", items: ["itemScrewDriver", "itemCushion", "itemLargeTowel"] });
  tap(e, "spotPitsujiWindow");
  eq(e.log.msgs, ["これを外したらぴつじになにか渡せそうだ"]);
  eq(e.log.se, ["ガタガタしている音"]);
  e.ctx.selectedItemId = "itemCushion";
  tap(e, "spotPitsujiWindow");
  eq(e.state.inventory.includes("itemCushion"), true, "未開放なのにクッションが消費された");
  e.ctx.selectedItemId = "itemScrewDriver";
  tap(e, "spotPitsujiWindow");
  eq(e.log.msgs.at(-1), "曇りガラス窓を外した！");
  eq(e.log.se.at(-1), "カチャンっという音");
  ok(e.state.flags.pitsujiWindowOpen, "小窓が開いていない");
  ok(e.state.inventory.includes("itemScrewDriver"), "ドライバー(残存)が消えた");
  tap(e, "spotPitsujiWindow");
  eq(e.log.msgs.at(-1), "ここからぴつじになにか渡せそう");
  e.ctx.selectedItemId = "itemCushion";
  tap(e, "spotPitsujiWindow");
  eq(e.log.msgs.at(-1), "ふかふかのクッションを窓から投げ入れた！");
  e.ctx.selectedItemId = "itemLargeTowel";
  tap(e, "spotPitsujiWindow");
  eq(e.log.msgs.at(-1), "タオルケットを窓から投げ込んだ！");
  eq(e.state.inventory, ["itemScrewDriver"]);
});
test("R-28", "ドア小窓 PlayPart6: カメラで写真 / 写真入手後 / 未選択", () => {
  const e = tap(setup({ part: 6, view: "viewPitsujiDoor", items: ["itemCamera"], selected: "itemCamera" }), "spotPitsujiWindow");
  eq(e.log.msgs, ["このカメラでぴつじの様子を撮影して……"]);
  eq(e.state.inventory, ["itemPhotoPitsuji"]);
  eq(tap(setup({ part: 6, view: "viewPitsujiDoor", ever: ["itemPhotoPitsuji"] }), "spotPitsujiWindow").log.msgs, ["ぴつじが硬い床で熟睡している"]);
  eq(tap(setup({ part: 6, view: "viewPitsujiDoor" }), "spotPitsujiWindow").log.msgs, ["ぴつじが硬い床で熟睡している"]);
});
test("R-29", "ドア小窓 PlayPart4以前 / 7以降", () => {
  const e = tap(setup({ part: 3, view: "viewPitsujiDoor" }), "spotPitsujiWindow");
  eq(e.log.msgs, ["がたついている曇りガラス窓だ"]);
  eq(e.log.se, ["ガタガタしている音"]);
  eq(tap(setup({ part: 7, view: "viewPitsujiDoor" }), "spotPitsujiWindow").log.msgs, ["ぴつじが硬い床で熟睡している"]);
});
test("R-30", "ドア下隙間: PlayPart2でチョコ使用 / 2で未選択 / 3以降", () => {
  const e = tap(setup({ part: 2, view: "viewPitsujiDoor", items: ["itemChocolate"], selected: "itemChocolate" }), "spotPitsujiDoorGap");
  eq(e.log.msgs, ["チョコレートに釣られてドアの近くに来た気配がする", "部屋に戻ってぴつじに脱出を呼びかけるっぴ！"]);
  eq(e.log.se, ["シュッという音"]);
  eq(e.state.inventory, []);
  eq(tap(setup({ part: 2, view: "viewPitsujiDoor" }), "spotPitsujiDoorGap").log.msgs, ["ここから渡せそうっぴ"]);
  eq(tap(setup({ part: 3, view: "viewPitsujiDoor" }), "spotPitsujiDoorGap").log.msgs, ["隙間があるけど……下から中の様子は見えないな"]);
});
test("R-31", "引き出し: PlayPart3 / その他", () => {
  eq(tap(setup({ part: 3, view: "viewShelf" }), "spotDrawer").log.msgs, ["何も入ってないっぴ"]);
  eq(tap(setup({ part: 4, view: "viewShelf" }), "spotDrawer").log.msgs, ["ぴつじを脱出させるっぴ！！"]);
});
test("R-32", "工具箱: 取得後 / PlayPart5でドライバー / その他", () => {
  eq(tap(setup({ part: 5, view: "viewShelf", ever: ["itemScrewDriver"] }), "spotToolbox").log.msgs, ["他に使うものはなさそうだ"]);
  const e = tap(setup({ part: 5, view: "viewShelf" }), "spotToolbox");
  eq(e.state.inventory, ["itemScrewDriver"]);
  eq(tap(setup({ part: 4, view: "viewShelf" }), "spotToolbox").log.msgs, ["ここには脱出の準備で使った工具が色々と入れてある"]);
});
test("R-33", "玄関ドア: 解除後 / 解除前", () => {
  eq(tap(setup({ part: 4, view: "roomB1", flags: { doorEntranceUnlocked: true } }), "spotDoorEntrance").log.msgs, ["あとはぴつじを外に出すだけだ！"]);
  eq(tap(setup({ part: 4, view: "roomB1" }), "spotDoorEntrance").log.msgs, ["ドアには鍵が掛かっている"]);
});
test("R-34", "玄関ドアの電子錠: PlayPart7は非表示 / 解除後 / 解除前はギミック", () => {
  ok(!visible(setup({ part: 7, view: "roomB1" }), "spotLockEntrance"), "part7で表示");
  eq(tap(setup({ part: 5, view: "roomB1", flags: { doorEntranceUnlocked: true } }), "spotLockEntrance").log.msgs, ["ドアロックは解除した"]);
  eq(tap(setup({ part: 4, view: "roomB1" }), "spotLockEntrance").log.gimmick, ["gimmickLockEntrance"]);
});
test("R-35", "ぴさぎ: PlayPart7のみ。各段階", () => {
  for (const p of [4, 5, 6]) ok(!visible(setup({ part: p, view: "roomB1" }), "spotPisagi"), `part${p}で表示`);
  eq(tap(setup({ part: 7, view: "roomB1", ever: ["itemCamera"] }), "spotPisagi").log.msgs, ["写真があれば何でも買ってきてくれるって言うけど", "なにか買ってきて欲しいものはあるかな……"]);
  eq(tap(setup({ part: 7, view: "roomB1" }), "spotPisagi").log.msgs, ["必要なものを買ってきてくれる？", "なにか見た目がわかるものがあれば？"]);
  const e = tap(setup({ part: 7, view: "roomB1", items: ["itemPhoto"], selected: "itemPhoto" }), "spotPisagi");
  eq(e.log.gimmick, ["gimmickPhoto"]);
  eq(e.state.inventory, []);
  const e2 = tap(setup({ part: 7, view: "roomB1", used: { itemPhoto: ["spotPisagi"] }, items: ["itemCD"], selected: "itemCD" }), "spotPisagi");
  eq(e2.log.gimmick, ["gimmickPhoto"], "写真使用後に再度ギミックを開けない");
  eq(e2.state.inventory, ["itemCD"], "無関係の選択中アイテムが消費された");
  const e3 = tap(setup({ part: 7, view: "roomB1", used: { itemPhoto: ["spotPisagi"] }, flags: { gimmickPhotoCleared: true } }), "spotPisagi");
  eq(e3.log.msgs, ["これを買ってきて欲しい！", "任せるっぴ！", "タンバリンは任せるっぴ！"]);
  eq(e3.state.inventory, ["itemMaracas"]);
  const e4 = tap(setup({ part: 7, view: "roomB1", ever: ["itemMaracas"], flags: { gimmickPhotoCleared: true } }), "spotPisagi");
  eq(e4.log.msgs, ["タンバリンを鳴らして楽しそうだ"]);
  eq(e4.log.se, ["タンバリンを鳴らす音"]);
});
test("R-36", "オーディオ: CD使用でHAPPY解禁 / 通常はBGM選択", () => {
  const e = tap(setup({ part: 7, view: "roomB2", items: ["itemCD"], selected: "itemCD" }), "spotAudioPlayer");
  eq(e.log.msgs, ["流せる音楽が増えたな"]);
  ok(e.state.bgmState.unlockedTracks.includes("happy"), "happy未解禁");
  eq(e.state.inventory, []);
  eq(tap(setup({ part: 4, view: "roomB2" }), "spotAudioPlayer").log.bgmMenu, 1);
});
test("R-37", "ソファ: 取得後 / PlayPart5以降 / 4で絵", () => {
  eq(tap(setup({ part: 4, view: "roomB2", ever: ["itemIllust"] }), "spotSofa").log.msgs, ["ここにはもう何もなかったはずだ"]);
  eq(tap(setup({ part: 5, view: "roomB2" }), "spotSofa").log.msgs, ["もう使わないけれど、ソファの下にも脱出のヒントを置いてたんだっけ"]);
  const e = tap(setup({ part: 4, view: "roomB2" }), "spotSofa");
  eq(e.log.msgs, ["ソファの下に落ちていた絵を拾った"]);
  eq(e.state.inventory, ["itemIllust"]);
});
test("R-38", "電気スイッチ: 赤⇔青のトグル", () => {
  const e = setup({ part: 4, view: "roomB2" });
  tap(e, "spotSwitch"); tap(e, "spotSwitch"); tap(e, "spotSwitch");
  eq(e.log.msgs, ["部屋が赤くなった", "部屋が青くなった", "部屋が赤くなった"]);
  eq(e.state.flags.roomLightRed, true);
});
test("R-39", "電話: PlayPart7以降 / 6で名刺 / 6未選択 / 4でブラックライト / 4未選択 / その他", () => {
  eq(tap(setup({ part: 7, view: "viewPhoneStand" }), "spotPhone").log.msgs, ["懐かしの黒電話。触り心地がいい"]);
  const e = tap(setup({ part: 6, view: "viewPhoneStand", items: ["itemPisagiCard"], selected: "itemPisagiCard" }), "spotPhone");
  eq(e.log.msgs, ["留守番電話だ。すぐ来てほしいとメッセージを残しておこう"]);
  eq(e.state.inventory, []);
  eq(tap(setup({ part: 6, view: "viewPhoneStand" }), "spotPhone").log.msgs, ["どうにかぴつじを脱出させたい！"]);
  const e4 = tap(setup({ part: 4, view: "viewPhoneStand", items: ["itemBlackLight"], selected: "itemBlackLight" }), "spotPhone");
  eq(e4.log.msgs, ["電話になにかが浮かび上がってきた"]);
  eq(e4.log.image.length, 1);
  eq(e4.state.inventory, ["itemBlackLight"], "ブラックライト(残存)が消えた");
  eq(tap(setup({ part: 4, view: "viewPhoneStand" }), "spotPhone").log.msgs, ["どうにかぴつじを脱出させたい！"]);
  eq(tap(setup({ part: 5, view: "viewPhoneStand" }), "spotPhone").log.msgs, ["いいよな黒電話"]);
});
test("R-40", "電話台引き出し: 取得後 / PlayPart5以降 / 4でブラックライト", () => {
  eq(tap(setup({ part: 4, view: "viewPhoneStand", ever: ["itemBlackLight"] }), "spotPhoneStandDrawer").log.msgs, ["もうここには何もないはず"]);
  eq(tap(setup({ part: 5, view: "viewPhoneStand" }), "spotPhoneStandDrawer").log.msgs, ["脱出に使うはずだったブラックライトが入っている"]);
  const e = tap(setup({ part: 4, view: "viewPhoneStand" }), "spotPhoneStandDrawer");
  eq(e.log.msgs, ["ブラックライトを手に入れた"]);
});
test("R-41", "塩: PlayPart5以降 / 4でブラックライト / 4未選択", () => {
  eq(tap(setup({ part: 5, view: "viewLowTable" }), "spotSalt").log.msgs, ["お気に入りの美味しい塩だ"]);
  const e = tap(setup({ part: 4, view: "viewLowTable", items: ["itemBlackLight"], selected: "itemBlackLight" }), "spotSalt");
  eq(e.log.msgs, ["塩になにかが浮かび上がってきた"]);
  eq(e.log.image.length, 1);
  eq(tap(setup({ part: 4, view: "viewLowTable" }), "spotSalt").log.msgs, ["この塩に確かヒントを書いていたはず……"]);
});
test("R-42", "ぴつじ部屋の出口: PlayPart8クリア", () => {
  eq(tap(setup({ part: 8 }), "spotPitsujiExitDoor").log.story, [8]);
});

// =====================================================================
// N: 調査ノート（修正依頼）
// =====================================================================
function openNote(opt) { return tap(setup({ part: 2, ...opt }), "spotNotebook"); }
test("NR-01", "ページ送り: 1左→1右→2左→2右、各ページ表示時にメッセージ", () => {
  const e = openNote({ part: 2 });
  const ids = [notePageId(e)];
  for (let i = 0; i < 3; i++) { notePageTap(e); ids.push(notePageId(e)); }
  eq(ids, ["note1left", "note1right", "note2left", "note2right"]);
  eq(e.log.msgs, ["ぴつじはチョコレートが好きと……", "ぴつじはふかふかなものが好きだったな……", "ぴつじの友達を調べたページだっぴ", "ぴつじの友達の調査もしたっぴ"]);
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
  eq(e.log.msgs, ["貼り付いてて次のページが中々めくれないッピ", "貼り付いてて次のページが中々めくれないッピ"]);
  notePageTap(e);
  eq(notePageId(e), "note3left");
  eq(e.log.msgs.slice(2), ["次のページがめくれたっぴ！", "ぴつじと仲間達が楽しそうにパーティーしてる写真だっぴ"]);
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
// P: パート遷移・自動クリア・アイテム消去（修正依頼）
// =====================================================================
test("P-01", "PlayPart6: 名刺→チャットの順でも自動クリア（配信ボタン不要）", () => {
  const e = setup({ part: 6, view: "viewPhoneStand", items: ["itemPisagiCard", "itemPhotoPitsuji"], selected: "itemPisagiCard" });
  tap(e, "spotPhone");
  eq(e.log.autoClear, 0, "チャット前に自動クリア");
  e.engine.resolveGimmickResult("gimmickPcGame", true);
  eq(e.log.autoClear, 1);
  e.engine.runAutoClear();
  eq(e.log.story, [6]);
});
test("P-02", "PlayPart6: チャット→名刺の順でも自動クリア", () => {
  const e = setup({ part: 6, view: "viewDesk", items: ["itemPisagiCard", "itemPhotoPitsuji"] });
  e.engine.resolveGimmickResult("gimmickPcGame", true);
  eq(e.log.autoClear, 0);
  e.state.currentView = "viewPhoneStand"; e.ctx.selectedItemId = "itemPisagiCard";
  tap(e, "spotPhone");
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
test("P-04", "チャットギミック成功で ぴつじの写真 が所持品から消え、使用記録が残る", () => {
  const e = setup({ part: 6, items: ["itemPhotoPitsuji", "itemPisagiCard"] });
  e.engine.resolveGimmickResult("gimmickPcGame", true);
  eq(e.state.inventory, ["itemPisagiCard"]);
  ok((e.state.itemUsageLog.itemPhotoPitsuji || []).length > 0, "使用記録なし");
  eq(e.log.msgs, ["送信したっぴ！"]);
});
test("P-05", "パートクリア時に残存アイテムが破棄され、ノートのページも戻る", () => {
  const e = setup({ part: 3, items: ["itemFrozenBluePaper", "itemToastedBread"], flags: { doorBUnlocked: true }, notePage: 2 });
  tap(e, "spotPcStream");
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
test("P-07", "ギミック: 玄関/写真 成功でフラグ", () => {
  const e = setup({ part: 4 });
  e.engine.resolveGimmickResult("gimmickLockEntrance", true);
  ok(e.state.flags.doorEntranceUnlocked, "玄関未解除");
  const e7 = setup({ part: 7 });
  e7.engine.resolveGimmickResult("gimmickPhoto", true);
  ok(e7.state.flags.gimmickPhotoCleared, "写真ギミック未解除");
});
test("P-08", "ストーリーパートの次パート番号が1→2→…→8の順につながっている", () => {
  for (let i = 1; i <= 7; i++) eq(data.storyPartsById[i].nextPlayPart, i + 1, `story${i}`);
  for (let i = 1; i <= 8; i++) eq(data.playPartsById[i].nextStoryPart, i, `play${i}`);
});

test("P-09", "部屋の色(赤)は操作パートをまたぐと元に戻る", () => {
  const e = setup({ part: 4, flags: { doorEntranceUnlocked: true, roomLightRed: true } });
  tap(e, "spotPcStream");
  eq(e.log.story, [4]);
  ok(!e.state.flags.roomLightRed, "パート切替後も赤いまま");
});
test("P-10", "部屋が赤くなるのは部屋B1・B2（tintFlag）", () => {
  const tinted = Object.values(data.viewsById).filter((v) => v.tintFlag === "roomLightRed").map((v) => v.id).sort();
  eq(tinted, ["roomB1", "roomB2"]);
});
test("P-11", "絵のESCAPEは、部屋が赤い状態で部屋B1/B2にいる時だけ見える", () => {
  const desc = data.itemsById.itemIllust.description;
  const at = (view, red) => { const e = setup({ part: 4, view, flags: red ? { roomLightRed: true } : {} }); return resolveMessage(desc, e.state, e.ctx)[0]; };
  ok(at("roomB1", true).includes("ESCAPE"), "B1で見えない");
  ok(at("roomB2", true).includes("ESCAPE"), "B2で見えない");
  ok(!at("viewLowTable", true).includes("ESCAPE"), "ローテーブル拡大で見える");
  ok(!at("roomA1", true).includes("ESCAPE"), "部屋A1で見える");
  ok(!at("roomB2", false).includes("ESCAPE"), "赤くないのに見える");
});
test("P-12", "チャット画面の入力欄の見出しは「番地」「部屋番号」", () => {
  eq(data.gimmicksById.gimmickPcGame.numberFields.map((f) => [f.label, f.answer]), [["番地", "2"], ["部屋番号", "131"]]);
});

// =====================================================================
// D: データ整合性
// =====================================================================
test("D-01", "全spot/view/gimmick/itemの参照先が存在する", () => {
  const errs = [];
  for (const v of Object.values(data.viewsById)) for (const s of v.spots) if (!data.spotsById[s]) errs.push(`view ${v.id} → spot ${s}`);
  const walk = (actions, where) => {
    for (const a of actions) {
      if (a.type === "moveTo" && !data.viewsById[a.target]) errs.push(`${where} moveTo ${a.target}`);
      if (a.type === "triggerGimmick" && !data.gimmicksById[a.target]) errs.push(`${where} gimmick ${a.target}`);
      if (["giveItem", "consumeItem"].includes(a.type) && !data.itemsById[a.item]) errs.push(`${where} item ${a.item}`);
    }
  };
  for (const s of Object.values(data.spotsById)) s.rules.forEach((r) => walk(r.actions, s.id));
  for (const g of Object.values(data.gimmicksById)) { walk(g.onSuccess, g.id); walk(g.onFail, g.id); }
  for (const v of Object.values(data.viewsById)) for (const p of v.pages || []) { (p.onShow || []).forEach((r) => walk(r.actions, p.id)); (p.onTap || []).forEach((r) => walk(r.actions, p.id)); }
  for (const t of data.transitions) { if (!data.viewsById[t.view] || !data.viewsById[t.target]) errs.push(`transition ${t.view}→${t.target}`); }
  eq(errs, []);
});
test("D-02", "全アイテムに説明文(拡大表示用)がある", () => {
  eq(Object.values(data.itemsById).filter((i) => !i.description).map((i) => i.id), []);
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

// ---- 結果 ----
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "OK  " : "NG  "} ${r.id} ${r.title}${r.ok ? "" : "\n       → " + r.err}`);
console.log(`\n${results.length}件中 ${results.length - failed.length}件OK / ${failed.length}件NG`);
process.exitCode = failed.length ? 1 : 0;
