// AudioManager.js
// SE・BGMの再生と、音量設定(大・中・小・消)の保持を行う。
// 音声ファイルの割り当ては data/audio.json に集約する（ここにファイル名を書かない）。
// ・実際の音量 = 音声ごとの「中」の音量(audio.json の volume。省略時 DEFAULT_MID_VOLUME) × 設定の段階の倍率
//   （音声ファイルごとに元の音の大きさが違うため、volume で「中」の時の音量を揃える）
// ・audio.json に無いキー / file:null のキーは鳴らさず、コンソールに出すだけ（仮設定のため）
// ・BGMは常に1曲だけ。切り替え時は前の曲を止めてから流す（二重再生しない）
// ・ブラウザの自動再生制限で再生できなかったBGMは、次に画面をタップした時に再生し直す
// ・音量設定はゲームのセーブデータとは別に保存する（セーブ削除でも設定は消えない）
// ・タブが裏に回った間／別タブでゲームが進んだ後は、BGMを止める（setSuspended）
// ・BGMに layer があれば、そのBGMが流れている間だけ小さい音で重ねて流す（配信BGM＋ノイズ等）
// ・SEはタップから鳴るまでの遅れを無くすため Web Audio API で鳴らす。起動時に全SEを読み込み・
//   デコードしておき、ファイル先頭の無音は自動で飛ばす。Web Audio が使えない/読み込み前は、
//   SEごとに読み込み済みの <audio> を使い回して鳴らす。
// ・同じSEが鳴っている途中でもう一度鳴らした時の動きは、audio.json の SE ごとの overlap で決める
//     "restart"(省略時): 頭から鳴らし直す（短いタップ音向け）
//     "wait"           : 鳴り終わるまで次は鳴らさない（長めのSE向け）

const SETTINGS_KEY = "pitsujiEscapeGame_audioSettings";
// 同じSEがこの間隔より短く連続した場合は鳴らさない（連打・二重イベントで音が重なるのを防ぐ）
const SE_REPEAT_GUARD_MS = 80;
// 先頭の無音とみなす音の大きさ(振幅 0〜1)と、音の出だしを削り過ぎないよう残す長さ(秒)
const SILENCE_THRESHOLD = 0.003;
const SILENCE_KEEP_SEC = 0.005;

let defs = { se: {}, bgm: {} };
// 音量の段階。factor は「中」の音量に対する倍率（1を超えた分は最大音量1で頭打ち）。
export const VOLUME_LEVELS = [
  { id: "high", label: "大", factor: 1.5 },
  { id: "mid", label: "中", factor: 1 },
  { id: "low", label: "小", factor: 0.5 },
  { id: "off", label: "消", factor: 0 }
];
const DEFAULT_LEVEL = "mid";
// audio.json で volume を省略した音声の「中」の音量
const DEFAULT_MID_VOLUME = 0.6;

let settings = { se: DEFAULT_LEVEL, bgm: DEFAULT_LEVEL };
let bgmKey = null; // 今流すべきBGMのキー（「消」の間も覚えておき、音量を戻した時に流す）
let bgmAudio = null;
let bgmAudioKey = null;
let unlockListenerAdded = false;
const suspendReasons = new Set();
const seLastPlayed = {};

// ---- SE (Web Audio API) ----
let audioCtx = null;
const seBuffers = {}; // key → { buffer, offset(先頭の無音を飛ばす秒数) }
const sePlaying = {}; // key → 再生中の AudioBufferSourceNode
const seElements = {}; // key → 読み込み済みの <audio>（Web Audio が使えない/読み込み前の代わり）

export function init(audioDefs) {
  defs = { se: audioDefs?.se || {}, bgm: audioDefs?.bgm || {} };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (saved && typeof saved === "object") {
      for (const kind of ["se", "bgm"]) settings[kind] = normalizeLevel(saved[kind]);
    }
  } catch (e) {
    console.warn("[Audio] 設定を読み込めませんでした", e);
  }
  initWebAudio();
  preloadSE();
}

function initWebAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    audioCtx = new Ctx();
  } catch (e) {
    console.warn("[Audio] Web Audio を使えないため、SEは <audio> で鳴らします", e);
    audioCtx = null;
    return;
  }
  // iPhone等では、画面を触るまで Web Audio が鳴らない。触る度に再開を試み、鳴る状態になったら外す。
  const unlock = () => {
    if (audioCtx.state === "running") {
      for (const type of ["pointerdown", "touchend", "keydown"]) document.removeEventListener(type, unlock, true);
      return;
    }
    audioCtx.resume().catch(() => {});
  };
  for (const type of ["pointerdown", "touchend", "keydown"]) document.addEventListener(type, unlock, true);
}

// 全SEを先に読み込んでおく（タップ時に読み込み待ちが発生しないように）
function preloadSE() {
  for (const [key, def] of Object.entries(defs.se)) {
    if (!def || !def.file) continue;
    const url = encodeURI(def.file);
    if (!audioCtx) {
      const el = new Audio(url);
      el.preload = "auto";
      seElements[key] = el;
      continue;
    }
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      // 古いSafariは Promise 版の decodeAudioData が無いため、コールバック版で呼ぶ
      .then((data) => new Promise((resolve, reject) => audioCtx.decodeAudioData(data, resolve, reject)))
      .then((buffer) => {
        seBuffers[key] = { buffer, offset: leadingSilence(buffer) };
      })
      .catch((e) => console.warn(`[Audio] SEを読み込めませんでした: ${key}`, e && (e.message || e.name)));
  }
}

// 先頭の無音の長さ(秒)。MP3は先頭に無音が入っていることが多く、鳴り始めが遅れて聞こえるため飛ばす。
function leadingSilence(buffer) {
  let first = buffer.length;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < first; i++) {
      if (Math.abs(data[i]) > SILENCE_THRESHOLD) {
        first = i;
        break;
      }
    }
  }
  if (first >= buffer.length) return 0; // 全部無音のファイルはそのまま
  return Math.max(0, first / buffer.sampleRate - SILENCE_KEEP_SEC);
}

// 末尾の無音の長さ(秒)。ループ再生の継ぎ目で途切れないよう、ループ範囲から外すのに使う。
function trailingSilence(buffer) {
  let last = -1;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = data.length - 1; i > last; i--) {
      if (Math.abs(data[i]) > SILENCE_THRESHOLD) {
        last = i;
        break;
      }
    }
  }
  if (last < 0) return 0;
  return Math.max(0, (buffer.length - 1 - last) / buffer.sampleRate - SILENCE_KEEP_SEC);
}

// 以前のON/OFF設定(true/false)が保存されている場合は、ON→中 / OFF→消 として引き継ぐ。
function normalizeLevel(v) {
  if (v === true) return DEFAULT_LEVEL;
  if (v === false) return "off";
  return VOLUME_LEVELS.some((l) => l.id === v) ? v : DEFAULT_LEVEL;
}

function levelFactor(kind) {
  return (VOLUME_LEVELS.find((l) => l.id === settings[kind]) || { factor: 1 }).factor;
}

// 音声ごとの「中」の音量 × 設定の段階の倍率（0〜1）
function volumeOf(kind, def) {
  const base = typeof def.volume === "number" ? def.volume : DEFAULT_MID_VOLUME;
  return Math.min(1, Math.max(0, base * levelFactor(kind)));
}

/** 音量設定 { se: "high"|"mid"|"low"|"off", bgm: ... } */
export function getSettings() {
  return { ...settings };
}

export function setLevel(kind, level) {
  settings[kind] = normalizeLevel(level);
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn("[Audio] 設定を保存できませんでした", e);
  }
  if (kind === "bgm") applyBgm();
}

/** reason ごとに一時停止を掛け外しする（"hidden": タブが裏 / "otherTab": 別タブで進行）。 */
export function setSuspended(reason, on) {
  if (on) suspendReasons.add(reason);
  else suspendReasons.delete(reason);
  applyBgm();
}

function resolveFile(kind, key) {
  const def = defs[kind][key];
  if (!def || !def.file) return null;
  return def;
}

export function playSE(key) {
  if (!key) return;
  const def = resolveFile("se", key);
  if (!def) {
    console.log(`[SE未設定] ${key}`);
    return;
  }
  if (levelFactor("se") === 0 || suspendReasons.size > 0) return;
  const now = Date.now();
  if (now - (seLastPlayed[key] || 0) < SE_REPEAT_GUARD_MS) return;
  const wait = def.overlap === "wait";
  const loaded = seBuffers[key];
  if (audioCtx && loaded) {
    if (wait && sePlaying[key]) return;
    seLastPlayed[key] = now;
    playSEBuffer(key, loaded, volumeOf("se", def));
    return;
  }
  // Web Audio が使えない/まだ読み込み中: <audio> を1つ作って使い回す
  const el = seElements[key] || (seElements[key] = new Audio(encodeURI(def.file)));
  if (wait && !el.paused && !el.ended) return;
  seLastPlayed[key] = now;
  el.volume = volumeOf("se", def);
  el.currentTime = 0;
  el.play().catch((e) => console.warn(`[Audio] SEを再生できませんでした: ${key}`, e.name));
}

function playSEBuffer(key, loaded, volume) {
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  if (sePlaying[key]) {
    // "restart": 鳴っている途中の同じSEを止めて頭から鳴らし直す
    try {
      sePlaying[key].stop();
    } catch (e) {
      /* 既に止まっている */
    }
  }
  const source = audioCtx.createBufferSource();
  source.buffer = loaded.buffer;
  const gain = audioCtx.createGain();
  gain.gain.value = volume;
  source.connect(gain);
  gain.connect(audioCtx.destination);
  source.onended = () => {
    if (sePlaying[key] === source) delete sePlaying[key];
  };
  sePlaying[key] = source;
  source.start(0, loaded.offset);
}

/** 流すBGMを切り替える。同じキーなら何もしない（最初から流し直さない）。null で停止。 */
export function playBgm(key) {
  if ((key || null) === bgmKey) return;
  bgmKey = key || null;
  if (bgmKey && !resolveFile("bgm", bgmKey)) console.log(`[BGM未設定] ${bgmKey}`);
  applyBgm();
}

export function stopBgm() {
  playBgm(null);
}

/** デバッグ用: 現在の再生状態 */
export function debugState() {
  return { bgmKey, playingKey: bgmAudio && !bgmAudio.paused ? bgmAudioKey : null, settings: { ...settings }, suspended: [...suspendReasons] };
}

function applyBgm() {
  const def = bgmKey ? resolveFile("bgm", bgmKey) : null;
  if (!def) {
    // 曲が無い(停止・未設定)場合は、前の曲を破棄する
    if (bgmAudio) bgmAudio.pause();
    bgmAudio = null;
    bgmAudioKey = null;
    applyLayer(null, false);
    return;
  }
  if (bgmAudio && bgmAudioKey !== bgmKey) {
    bgmAudio.pause();
    bgmAudio = null;
    bgmAudioKey = null;
  }
  if (!bgmAudio) {
    bgmAudio = new Audio(encodeURI(def.file));
    bgmAudio.loop = true;
    bgmAudioKey = bgmKey;
  }
  bgmAudio.volume = volumeOf("bgm", def); // 設定画面で段階を変えた時は、流れている曲の音量もすぐ変える
  if (levelFactor("bgm") === 0 || suspendReasons.size > 0) {
    bgmAudio.pause(); // 「消」/一時停止中は止めておき、再開時は続きから流す
    applyLayer(def, false);
    return;
  }
  if (bgmAudio.paused) startBgmAudio();
  applyLayer(def, true);
}

// ---- BGMに重ねて流す音（audio.json の bgm の layer。例: 配信BGMと一緒に流すノイズ） ----
// layer: { file, volume }。volume は設定が「中」の時の音量で、BGMの大中小消に連動する。
// iPhone では <audio> の音量指定が効かず小さい音にできないため、Web Audio でループ再生する。
const DEFAULT_LAYER_VOLUME = 0.05;
const layerBuffers = {}; // file → Promise<AudioBuffer>
let layerFile = null; // 今流している(または読み込み中の)重ねる音のファイル
let layerSource = null;
let layerGain = null;
let layerEl = null; // Web Audio が使えない場合の代わり

function layerVolume(layer) {
  const base = typeof layer.volume === "number" ? layer.volume : DEFAULT_LAYER_VOLUME;
  return Math.min(1, Math.max(0, base * levelFactor("bgm")));
}

function applyLayer(def, shouldPlay) {
  const layer = def && def.layer && def.layer.file ? def.layer : null;
  if (!layer || !shouldPlay) {
    stopLayer();
    return;
  }
  const volume = layerVolume(layer);
  if (layerFile === layer.file) {
    // 既に流している(読み込み中)なら音量だけ合わせる
    if (layerGain) layerGain.gain.value = volume;
    if (layerEl) layerEl.volume = volume;
    return;
  }
  stopLayer();
  layerFile = layer.file;
  const url = encodeURI(layer.file);
  if (!audioCtx) {
    layerEl = new Audio(url);
    layerEl.loop = true;
    layerEl.volume = volume;
    layerEl.play().catch(() => {}); // 自動再生制限で鳴らない場合は諦める（BGM本体は別途再試行する）
    return;
  }
  if (!layerBuffers[layer.file]) {
    layerBuffers[layer.file] = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((data) => new Promise((resolve, reject) => audioCtx.decodeAudioData(data, resolve, reject)));
  }
  const file = layer.file;
  layerBuffers[file]
    .then((buffer) => {
      if (layerFile !== file || layerSource) return; // 読み込み中に曲が変わった/止まった
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
      layerGain = audioCtx.createGain();
      layerGain.gain.value = layerVolume(layer);
      layerGain.connect(audioCtx.destination);
      layerSource = audioCtx.createBufferSource();
      layerSource.buffer = buffer;
      // 前後の無音をループ範囲から外し、継ぎ目で音が途切れないようにする
      const start = leadingSilence(buffer);
      const end = buffer.duration - trailingSilence(buffer);
      layerSource.loop = true;
      if (end - start > 0.1) {
        layerSource.loopStart = start;
        layerSource.loopEnd = end;
      }
      layerSource.connect(layerGain);
      layerSource.start(0, start);
    })
    .catch((e) => {
      console.warn(`[Audio] BGMに重ねる音を読み込めませんでした: ${file}`, e && (e.message || e.name));
      delete layerBuffers[file];
    });
}

function stopLayer() {
  layerFile = null;
  if (layerSource) {
    try {
      layerSource.stop();
    } catch (e) {
      /* 既に止まっている */
    }
    layerSource.disconnect();
    layerSource = null;
  }
  if (layerGain) {
    layerGain.disconnect();
    layerGain = null;
  }
  if (layerEl) {
    layerEl.pause();
    layerEl = null;
  }
}

function startBgmAudio() {
  const audio = bgmAudio;
  audio.play().catch((e) => {
    // 自動再生制限(NotAllowedError)のときだけ、次のユーザー操作で再生し直す。
    // ファイルが読めない等の失敗では再試行しない（タップの度に失敗を繰り返さない）。
    if (e.name !== "NotAllowedError") {
      console.warn(`[Audio] BGMを再生できませんでした: ${bgmAudioKey}`, e.name);
      return;
    }
    if (unlockListenerAdded) return;
    unlockListenerAdded = true;
    document.addEventListener(
      "pointerdown",
      () => {
        unlockListenerAdded = false;
        if (bgmAudio === audio && audio.paused) applyBgm();
      },
      { once: true, capture: true }
    );
  });
}
