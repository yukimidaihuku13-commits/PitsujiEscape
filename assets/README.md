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

## 4. クリックポイントの位置を画像に合わせる（position）

背景画像を入れても、クリックポイントは自動では画像上の位置に合いません。
`data/spots.json` の該当spotに `position`（%指定、画像左上が0,0）を追記すると、
その位置にタップ範囲（点線の四角）が表示されます。

```jsonc
{
  "id": "spotDesk",
  "viewId": "roomPiguma",
  "label": "机",
  "position": { "x": 10, "y": 55, "width": 30, "height": 20 },
  "rules": [ ... ]
}
```

`position` が無いspotは、これまでどおり画面下の縦一覧に表示されます。
一部のspotだけ先に座標を決める、という進め方もできます。

### 座標の決め方（3つの方法）

1. **ブラウザで実際にタップして調べる**：ゲーム画面の背景部分（ボタン以外の場所）を
   タップすると、ブラウザの開発者コンソールに `[座標メモ] x: 12.3%, y: 48.0%` の形で
   座標が出力されます。机が写っている場所を数回タップして、だいたいの範囲を掴んでください。
2. **画像編集ソフトで座標を読む**：画像を開き、対象物の左上・右下のピクセル座標を確認し、
   画像全体の幅・高さで割って%に変換する。
3. **ClaudeCodeに画像を見てもらって決めてもらう**：後述のとおり依頼できます。

### ClaudeCodeへの指示例

> 「`assets/backgrounds/roomPiguma.png` を見て、以下のクリックポイントのだいたいの位置を
> `data/spots.json` の `position`（x/y/width/height、%指定、画像左上が0,0）に設定してください。
> 厳密でなくて構いません。ざっくり画像内の対象物が写っている範囲に収まる程度でお願いします。
> - spotDesk：机
> - spotBookshelf：本棚
> - spotBed：ベッド」

画像ファイルのパスを具体的に伝える（見てもらいたい画像を指定する）のがポイントです。

