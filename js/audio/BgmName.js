// BgmName.js
// オーディオ(BGM選択)に表示するBGM名を決める。
// ・BGM名は data/audio.json の bgm の各キー(ファイル名)の name で設定する
// ・name が null の間は、キー名から「BGM_」を除いた先頭6文字を暫定の名前として使う
// ・bgm.json の label は、音声ファイルが無いトラック(「通常」)用

const PROVISIONAL_NAME_LENGTH = 6;

/** audio.json の bgm キー(例: "BGM_The Dark Eternal Night")から表示名を返す */
export function bgmSoundName(soundKey, audioDefs) {
  const def = audioDefs && audioDefs.bgm && audioDefs.bgm[soundKey];
  if (def && def.name) return def.name;
  return String(soundKey || "").replace(/^BGM_/, "").slice(0, PROVISIONAL_NAME_LENGTH);
}

/** bgm.json のトラックの表示名 */
export function bgmTrackLabel(track, audioDefs) {
  if (!track) return "";
  if (track.label) return track.label;
  return track.sound ? bgmSoundName(track.sound, audioDefs) : track.id;
}

/** 新しいBGMがオーディオに追加された時のメッセージ（ゲームシステム.txt） */
export function bgmUnlockMessage(name) {
  return `BGM ${name} がオーディオに追加された`;
}
