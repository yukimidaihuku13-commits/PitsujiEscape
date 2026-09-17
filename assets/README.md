# assets フォルダ

背景・キャラクター画像を置くフォルダです。ファイルを置くだけでは反映されません。
`data/views.json`（脱出パートの背景）または `data/storyParts.json`（ストーリーの背景・立ち絵）
に、追加した画像への相対パスを1行追記する必要があります。

## 1. 脱出パートの背景を追加する場合

1. `assets/backgrounds/` に画像ファイルを置く（例: `roomPiguma.png`）
2. `data/views.json` の対象view（例: `roomPiguma`）に `"background"` を追記する

```jsonc
{
  "id": "roomPiguma",
  "label": "黒ぴぐま部屋",
  "layoutType": "play",
  "background": "assets/backgrounds/roomPiguma.png",
  "spots": ["spotDesk", "spotBookshelf", "spotBed"]
}
```

`background` を書かなければ、これまでどおりグレーのプレースホルダー表示になります
（＝一部のviewだけ先に画像を入れる、という進め方も可能です）。

## 2. ストーリーパートの背景・立ち絵を追加する場合

`data/storyParts.json` の該当する行に `bgImage`（背景）／`portraitImage`（立ち絵）を追記します。

```jsonc
{ "speaker": "黒ぴぐま", "text": "おはよう。気分はどうかな？",
  "bg": "壁掛けモニターに黒ぴぐまが映った姿",
  "bgImage": "assets/backgrounds/monitor_pigma.png",
  "portraitImage": "assets/characters/pigma_normal.png" }
```

`bg` はそのまま残して構いません（`bgImage`が無い場合の表示用テキストとして使われます）。

## 3. JS側の変更は不要

`background` / `bgImage` / `portraitImage` はJS側で既に対応済みです。
画像ファイルを置いてJSONにパスを書くだけで反映されます。反映されない場合は、
パスが `index.html` からの相対パスとして正しいか（先頭に `/` を付けない）を確認してください。
