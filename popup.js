const STORAGE_KEY = "skipSeconds";
const DEFAULT_SKIP = 28;

const input = document.getElementById("skipSeconds");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");

function loadSettings() {
  chrome.storage.sync.get({ [STORAGE_KEY]: DEFAULT_SKIP }, (items) => {
    const v = items[STORAGE_KEY];
    input.value = Number.isFinite(Number(v)) ? Number(v) : DEFAULT_SKIP;
  });
}

function showSaved() {
  statusEl.textContent = "Saved!";
  statusEl.style.color = "";
  statusEl.classList.add("visible");
  window.clearTimeout(showSaved._t);
  showSaved._t = window.setTimeout(() => {
    statusEl.classList.remove("visible");
  }, 2000);
}

saveBtn.addEventListener("click", () => {
  const raw = parseInt(String(input.value).trim(), 10);
  const skipSeconds = Number.isFinite(raw) ? Math.max(0, Math.min(600, raw)) : DEFAULT_SKIP;
  input.value = skipSeconds;

  chrome.storage.sync.set({ [STORAGE_KEY]: skipSeconds }, () => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = "Could not save.";
      statusEl.style.color = "#f08080";
      statusEl.classList.add("visible");
      return;
    }
    statusEl.style.color = "";
    showSaved();
  });
});

loadSettings();
