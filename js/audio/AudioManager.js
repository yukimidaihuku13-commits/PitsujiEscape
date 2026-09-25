// AudioManager.js
// SE・BGMの再生と、ON/OFF設定の保持を行う。
// 音声ファイルの割り当ては data/audio.json に集約する（ここにファイル名を書かない）。
// ・audio.json に無いキー / file:null のキーは鳴らさず、コンソールに出すだけ（仮設定のため）
// ・BGMは常に1曲だけ。切り替え時は前の曲を止めてから流す（二重再生しない）
// ・ブラウザの自動再生制限で再生できなかったBGMは、次に画面をタップした時に再生し直す
// ・ON/OFF設定はゲームのセーブデータとは別に保存する（セーブ削除でも設定は消えない）
// ・タブが裏に回った間／別タブでゲームが進んだ後は、BGMを止める（setSuspended）

const SETTINGS_KEY = "pitsujiEscapeGame_audioSettings";
// 同じSEがこの間隔より短く連続した場合は鳴らさない（連打・二重イベントで音が重なるのを防ぐ）
const SE_REPEAT_GUARD_MS = 80;

let defs = { se: {}, bgm: {} };
let settings = { se: true, bgm: true };
let bgmKey = null; // 今流すべきBGMのキー（OFF中も覚えておき、ONにした時に流す）
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
      if (typeof saved.se === "boolean") settings.se = saved.se;
      if (typeof saved.bgm === "boolean") settings.bgm = saved.bgm;
    }
  } catch (e) {
    console.warn("[Audio] 設定を読み込めませんでした", e);
  }
}

export function getSettings() {
  return { ...settings };
}

export function setEnabled(kind, enabled) {
  settings[kind] = !!enabled;
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
  if (!settings.se || suspendReasons.size > 0) return;
  const now = Date.now();
  if (now - (seLastPlayed[key] || 0) < SE_REPEAT_GUARD_MS) return;
  seLastPlayed[key] = now;
  const audio = new Audio(encodeURI(def.file));
  audio.volume = def.volume ?? 1;
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
    bgmAudio.volume = def.volume ?? 1;
    bgmAudioKey = bgmKey;
  }
  if (!settings.bgm || suspendReasons.size > 0) {
    bgmAudio.pause(); // OFF/一時停止中は止めておき、再開時は続きから流す
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
