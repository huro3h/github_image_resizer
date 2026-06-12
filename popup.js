const enabledEl = document.getElementById("enabled");
const maxWidthEl = document.getElementById("maxWidth");
const maxHeightEl = document.getElementById("maxHeight");
const keepAspectEl = document.getElementById("keepAspect");
const heightFieldEl = document.getElementById("heightField");
const convertPasteEl = document.getElementById("convertPaste");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");

// keepAspect が ON のとき height 欄を非活性にする
function updateHeightField() {
  const keep = keepAspectEl.checked;
  maxHeightEl.disabled = keep;
  heightFieldEl.style.opacity = keep ? "0.4" : "1";
}

keepAspectEl.addEventListener("change", updateHeightField);

// 保存済み設定を読み込む
chrome.storage.sync.get(
  { enabled: true, maxWidth: 600, maxHeight: 0, keepAspect: true, convertPaste: false },
  (settings) => {
    enabledEl.checked = settings.enabled;
    maxWidthEl.value = settings.maxWidth || "";
    maxHeightEl.value = settings.maxHeight || "";
    keepAspectEl.checked = settings.keepAspect;
    convertPasteEl.checked = settings.convertPaste;
    updateHeightField();
  }
);

// 保存
saveBtn.addEventListener("click", () => {
  const maxWidth = parseInt(maxWidthEl.value, 10);
  const maxHeight = parseInt(maxHeightEl.value, 10);

  if (!maxWidth || maxWidth <= 0) {
    statusEl.textContent = "幅に有効な値を入力してください";
    statusEl.style.color = "#cf222e";
    return;
  }

  const settings = {
    enabled: enabledEl.checked,
    maxWidth,
    maxHeight: isNaN(maxHeight) ? 0 : maxHeight,
    keepAspect: keepAspectEl.checked,
    convertPaste: convertPasteEl.checked,
  };

  chrome.storage.sync.set(settings, () => {
    statusEl.textContent = "保存しました";
    statusEl.style.color = "#1a7f37";
    setTimeout(() => {
      statusEl.textContent = "";
    }, 2000);
  });
});
