/**
 * GitHub Image Resizer — content script
 *
 * GitHub でコメントに画像を添付すると、テキストエリアに以下の順で変化する:
 *   1. アップロード中: ![Uploading image.png…]()
 *   2. 完了後:        ![Image](https://github.com/user-attachments/assets/xxx)
 *                 または
 *                     <img width="W" height="H" alt="Image" src="URL" />
 *
 * このスクリプトはアップロード完了（プレースホルダーが消えた瞬間）を検知し、
 * ユーザーが設定した最大幅/高さに合わせて img タグに書き換える。
 * アップロード中は一切処理しない。
 */

(function () {
  "use strict";

  // デフォルト設定
  let settings = {
    enabled: true,
    maxWidth: 600,
    maxHeight: 0,
    keepAspect: true,
    convertPaste: false,
  };

  // 設定を読み込む
  chrome.storage.sync.get(settings, (stored) => {
    settings = stored;
  });

  // 設定変更をリアルタイムに反映
  chrome.storage.onChanged.addListener((changes) => {
    for (const key in changes) {
      settings[key] = changes[key].newValue;
    }
  });

  // ----------------------------------------
  // 画像サイズ計算
  // ----------------------------------------

  /**
   * 元の width/height を設定値に合わせてスケールダウンする。
   * @param {number} origW - 元の幅 (0 なら不明)
   * @param {number} origH - 元の高さ (0 なら不明)
   * @returns {{ width: number, height: number | null } | null}
   */
  function calcSize(origW, origH) {
    const maxW = settings.maxWidth;
    const maxH = settings.maxHeight; // 0 = 制限なし

    // 元サイズが不明な場合はそのまま maxWidth だけ設定
    if (!origW) {
      return { width: maxW, height: null };
    }

    // 既に制限内なら変更しない
    const widthOk = origW <= maxW;
    const heightOk = !maxH || origH <= maxH || !origH;
    if (widthOk && heightOk) {
      return null; // 変更不要
    }

    if (settings.keepAspect && origH) {
      // アスペクト比を保ちながら最大幅・最大高さの両方に収める
      let scale = 1;
      if (origW > maxW) scale = Math.min(scale, maxW / origW);
      if (maxH && origH > maxH) scale = Math.min(scale, maxH / origH);
      return {
        width: Math.round(origW * scale),
        height: Math.round(origH * scale),
      };
    } else {
      // 幅だけ変更
      const newW = Math.min(origW, maxW);
      let newH = null;
      if (maxH && origH) {
        newH = Math.min(origH, maxH);
      }
      return { width: newW, height: newH };
    }
  }

  // ----------------------------------------
  // テキスト書き換え
  // ----------------------------------------

  // アップロード中プレースホルダー: ![Uploading xxxx…]()
  const UPLOADING_RE = /!\[[^\]]*\]\(\s*\)/;

  // Markdown 形式: ![alt](url)  ※ URL が確定済みのもの
  const MD_IMG_RE = /!\[([^\]]*)\]\((https:\/\/github\.com\/user-attachments\/assets\/[^)]+)\)/g;

  // HTMLタグ形式: <img width="W" height="H" alt="alt" src="URL" />
  const HTML_IMG_RE =
    /<img\s+width="(\d+)"\s+height="(\d+)"\s+alt="([^"]*)"\s+src="(https:\/\/github\.com\/user-attachments\/assets\/[^"]+)"\s*\/>/g;

  /**
   * テキストエリアの内容を書き換える。
   * アップロード中プレースホルダーが残っている間は何もしない。
   * @param {HTMLTextAreaElement} textarea
   */
  function processTextarea(textarea) {
    if (!settings.enabled) return;

    const original = textarea.value;

    // アップロード中 (![Uploading …]()) が残っていれば処理しない
    if (UPLOADING_RE.test(original)) return;

    let replaced = original;

    // 1. <img width="W" height="H" ... /> 形式を処理
    replaced = replaced.replace(
      HTML_IMG_RE,
      (match, wStr, hStr, alt, src) => {
        const origW = parseInt(wStr, 10);
        const origH = parseInt(hStr, 10);
        const sized = calcSize(origW, origH);
        if (!sized) return match; // 変更不要

        const h = sized.height !== null ? sized.height : origH;
        return `<img width="${sized.width}" height="${h}" alt="${alt}" src="${src}" />`;
      }
    );

    // 2. Markdown 形式 ![alt](url) を処理 (width/height 不明なので maxWidth のみ設定)
    replaced = replaced.replace(MD_IMG_RE, (match, alt, src) => {
      if (!settings.maxWidth) return match;
      return `<img width="${settings.maxWidth}" alt="${alt}" src="${src}" />`;
    });

    if (replaced !== original) {
      // カーソル位置を保持しながら値を更新
      const selStart = textarea.selectionStart;
      const selEnd = textarea.selectionEnd;
      const diff = replaced.length - original.length;

      textarea.value = replaced;

      // カーソルを末尾に追従させる
      const newStart = Math.max(0, selStart + diff);
      const newEnd = Math.max(0, selEnd + diff);
      textarea.setSelectionRange(newStart, newEnd);

      // React/Vue などのフレームワーク向けにイベントを発火
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  // ----------------------------------------
  // テキストエリアごとの監視
  // ----------------------------------------

  /**
   * テキストエリアに input イベントリスナーを追加する。
   * アップロード完了を検知するために、前回値と比較して
   * 「プレースホルダーが消えた瞬間」だけ processTextarea を呼ぶ。
   * @param {HTMLTextAreaElement} textarea
   */
  function attachListener(textarea) {
    if (textarea.dataset.girAttached) return;
    textarea.dataset.girAttached = "1";

    let prevValue = textarea.value;
    // paste イベントが直前に発火したかどうかのフラグ
    let pendingPaste = false;

    textarea.addEventListener("input", () => {
      const current = textarea.value;

      // アップロード中プレースホルダーが前回あって今回消えた = 完了
      const wasUploading = UPLOADING_RE.test(prevValue);
      const isUploading = UPLOADING_RE.test(current);

      prevValue = current;

      if (wasUploading && !isUploading) {
        // アップロード完了直後: 処理を実行
        pendingPaste = false;
        processTextarea(textarea);
        return;
      }

      if (isUploading) {
        // まだアップロード中: 何もしない
        pendingPaste = false;
        return;
      }

      if (pendingPaste) {
        // paste イベント経由の input: convertPaste 設定に従う
        pendingPaste = false;
        if (settings.enabled && settings.convertPaste) {
          processTextarea(textarea);
        }
        return;
      }

      // 通常の文字入力: debounce 後に処理
      scheduleProcess(textarea);
    });

    // クリップボードからのペースト処理
    textarea.addEventListener("paste", (e) => {
      // paste が発火したことを input ハンドラに伝える
      pendingPaste = true;

      if (!settings.enabled || !settings.convertPaste) return;

      const text = e.clipboardData.getData("text/plain");
      // ペースト内容に img タグまたは Markdown 画像が含まれるか確認
      if (!HTML_IMG_RE.test(text) && !MD_IMG_RE.test(text)) return;
      // 正規表現の lastIndex をリセット (グローバルフラグのため)
      HTML_IMG_RE.lastIndex = 0;
      MD_IMG_RE.lastIndex = 0;

      // デフォルトのペーストをキャンセルして自前で挿入する
      e.preventDefault();
      // preventDefault した場合は input イベントが発火しないためフラグを戻す
      pendingPaste = false;

      const converted = convertText(text);
      insertAtCursor(textarea, converted);
      prevValue = textarea.value;
    });
  }

  // ----------------------------------------
  // テキスト変換・カーソル挿入ユーティリティ
  // ----------------------------------------

  /**
   * テキスト内の img タグ / Markdown 画像記法を変換して返す。
   * processTextarea と同じロジックを文字列に対して適用する。
   * @param {string} text
   * @returns {string}
   */
  function convertText(text) {
    let result = text;

    result = result.replace(
      HTML_IMG_RE,
      (match, wStr, hStr, alt, src) => {
        const origW = parseInt(wStr, 10);
        const origH = parseInt(hStr, 10);
        const sized = calcSize(origW, origH);
        if (!sized) return match;
        const h = sized.height !== null ? sized.height : origH;
        return `<img width="${sized.width}" height="${h}" alt="${alt}" src="${src}" />`;
      }
    );

    result = result.replace(MD_IMG_RE, (match, alt, src) => {
      if (!settings.maxWidth) return match;
      return `<img width="${settings.maxWidth}" alt="${alt}" src="${src}" />`;
    });

    return result;
  }

  /**
   * テキストエリアのカーソル位置にテキストを挿入し、
   * input イベントを発火してフレームワークに変更を通知する。
   * @param {HTMLTextAreaElement} textarea
   * @param {string} text
   */
  function insertAtCursor(textarea, text) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);

    textarea.value = before + text + after;
    const pos = start + text.length;
    textarea.setSelectionRange(pos, pos);

    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // ----------------------------------------
  // Debounce: 連続入力の最後だけ実行
  // ----------------------------------------

  /** @type {Map<HTMLTextAreaElement, number>} */
  const debounceTimers = new Map();

  /**
   * 300ms 後に processTextarea を実行する。
   * 連続して呼ばれた場合はタイマーをリセットする。
   * @param {HTMLTextAreaElement} textarea
   */
  function scheduleProcess(textarea) {
    if (debounceTimers.has(textarea)) {
      clearTimeout(debounceTimers.get(textarea));
    }
    const id = setTimeout(() => {
      debounceTimers.delete(textarea);
      processTextarea(textarea);
    }, 300);
    debounceTimers.set(textarea, id);
  }

  // ----------------------------------------
  // DOM 監視
  // ----------------------------------------

  /**
   * ページ内のすべてのコメント用テキストエリアにリスナーを付ける。
   */
  function attachToAll() {
    const selectors = [
      "textarea.js-comment-field",
      "textarea[name='comment[body]']",
      "textarea[aria-label]",
      "textarea.comment-form-textarea",
    ];
    document
      .querySelectorAll(selectors.join(","))
      .forEach(attachListener);
  }

  // 初期アタッチ
  attachToAll();

  // 動的に追加されるテキストエリアにも対応
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.tagName === "TEXTAREA") {
          attachListener(/** @type {HTMLTextAreaElement} */ (node));
        } else {
          node.querySelectorAll &&
            node
              .querySelectorAll("textarea")
              .forEach(attachListener);
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
})();
