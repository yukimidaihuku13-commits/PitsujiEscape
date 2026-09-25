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

const SETTINGS_KEY = "pitsujiEscapeGame_audioSettings";
// 同じSEがこの間隔より短く連続した場合は鳴らさない（連打・二重イベントで音が重なるのを防ぐ）
const SE_REPEAT_GUARD_MS = 80;

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
  seLastPlayed[key] = now;
  const audio = new Audio(encodeURI(def.file));
  audio.volume = volumeOf("se", def);
  audio.play().catch((e) => console.warn(`[Audio] SEを再生できませんでした: ${key}`, e.name));
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
    return;
  }
  if (bgmAudio.paused) startBgmAudio();
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
