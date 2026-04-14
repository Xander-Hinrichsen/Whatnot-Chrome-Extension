const STORAGE_KEY = "skipSeconds";
const STORAGE_ENABLED = "extensionEnabled";
const STORAGE_SEEK_STEP = "seekStepSeconds";
const DEFAULT_SKIP = 28;
const DEFAULT_ENABLED = true;
const DEFAULT_SEEK_STEP = 10;

const input = document.getElementById("skipSeconds");
const seekStepInput = document.getElementById("seekStepSeconds");
const saveBtn = document.getElementById("save");
const saveSeekStepBtn = document.getElementById("saveSeekStep");
const statusEl = document.getElementById("status");
const enableBtn = document.getElementById("enable");
const disableBtn = document.getElementById("disable");
const openStatsBtn = document.getElementById("openStats");

function setToggleUi(enabled) {
  enableBtn.classList.toggle("active", enabled);
  disableBtn.classList.toggle("active", !enabled);
}

function loadSettings() {
  chrome.storage.sync.get(
    {
      [STORAGE_KEY]: DEFAULT_SKIP,
      [STORAGE_ENABLED]: DEFAULT_ENABLED,
      [STORAGE_SEEK_STEP]: DEFAULT_SEEK_STEP,
    },
    (items) => {
      const v = items[STORAGE_KEY];
      input.value = Number.isFinite(Number(v)) ? Number(v) : DEFAULT_SKIP;
      const st = items[STORAGE_SEEK_STEP];
      seekStepInput.value = Number.isFinite(Number(st)) ? Number(st) : DEFAULT_SEEK_STEP;
      setToggleUi(items[STORAGE_ENABLED] !== false);
    }
  );
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

function persistEnabled(enabled, onDone) {
  chrome.storage.sync.set({ [STORAGE_ENABLED]: enabled }, () => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = "Could not save.";
      statusEl.style.color = "#f08080";
      statusEl.classList.add("visible");
      return;
    }
    setToggleUi(enabled);
    statusEl.style.color = "";
    if (typeof onDone === "function") onDone();
    else showSaved();
  });
}

enableBtn.addEventListener("click", () => {
  persistEnabled(true);
});

disableBtn.addEventListener("click", () => {
  persistEnabled(false);
});

openStatsBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "OPEN_OR_FOCUS_STATS" }, (res) => {
    if (chrome.runtime.lastError || res?.ok === false) {
      statusEl.textContent = "Could not open stats window.";
      statusEl.style.color = "#f08080";
      statusEl.classList.add("visible");
      window.setTimeout(() => statusEl.classList.remove("visible"), 2500);
    }
  });
});

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

saveSeekStepBtn.addEventListener("click", () => {
  const rawStep = parseInt(String(seekStepInput.value).trim(), 10);
  const seekStepSeconds = Number.isFinite(rawStep)
    ? Math.max(1, Math.min(600, rawStep))
    : DEFAULT_SEEK_STEP;
  seekStepInput.value = seekStepSeconds;

  chrome.storage.sync.set({ [STORAGE_SEEK_STEP]: seekStepSeconds }, () => {
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
