// DialogueBox.js
// メッセージ／ストーリー行を「1件ずつ、タップで次へ」の形で出すための
// 汎用キュー。メッセージ表示用・ストーリー表示用の両方をこの1つで扱う。

export class MessageQueue {
  /**
   * @param {(item: object) => void} renderFn 1件表示するための描画関数
   * @param {() => void} onEmpty 全件表示し終えたときに1度だけ呼ばれる
   */
  constructor(renderFn, onEmpty) {
    this.queue = [];
    this.renderFn = renderFn;
    this.onEmpty = onEmpty;
    this.current = null;
  }

  enqueue(item) {
    this.queue.push(item);
  }

  enqueueMany(items) {
    for (const item of items) this.queue.push(item);
  }

  isBusy() {
    return this.current !== null || this.queue.length > 0;
  }

  /** 次の1件を表示する。tap時に呼ぶ想定。 */
  advance() {
    if (this.queue.length === 0) {
      this.current = null;
      this.renderFn(null); // 表示を明示的にクリアする（前のメッセージが残り続けるバグの修正）
      if (this.onEmpty) this.onEmpty();
      return;
    }
    this.current = this.queue.shift();
    this.renderFn(this.current);
  }

  /** 残り全てを即時に読み飛ばす（早送り用）。最後の1件は表示状態にする。 */
  skipToEnd() {
    while (this.queue.length > 1) this.queue.shift();
    this.advance();
  }

  clear() {
    this.queue = [];
    this.current = null;
  }
}
