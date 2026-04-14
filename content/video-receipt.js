(function () {
  "use strict";

  const STORAGE_KEY = "skipSeconds";
  const STORAGE_ENABLED = "extensionEnabled";
  const STORAGE_SEEK_STEP = "seekStepSeconds";
  const DEFAULT_SKIP = 28;
  const DEFAULT_SEEK_STEP = 10;
  const DATA_ATTR = "hasSkipped";

  /** @type {{ extensionEnabled: boolean, seekStepSeconds: number }} */
  let cachedPlayback = {
    extensionEnabled: true,
    seekStepSeconds: DEFAULT_SEEK_STEP,
  };

  function refreshPlaybackSettings() {
    chrome.storage.sync.get(
      { [STORAGE_ENABLED]: true, [STORAGE_SEEK_STEP]: DEFAULT_SEEK_STEP },
      (items) => {
        cachedPlayback.extensionEnabled = items[STORAGE_ENABLED] !== false;
        const s = Number(items[STORAGE_SEEK_STEP]);
        cachedPlayback.seekStepSeconds =
          Number.isFinite(s) && s >= 1 ? Math.min(600, s) : DEFAULT_SEEK_STEP;
      }
    );
  }

  refreshPlaybackSettings();
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    if (changes[STORAGE_ENABLED] || changes[STORAGE_SEEK_STEP]) {
      refreshPlaybackSettings();
    }
  });

  /** @type {WeakSet<HTMLVideoElement>} */
  const scheduled = new WeakSet();
  /** @type {WeakSet<HTMLVideoElement>} */
  const loadInFlight = new WeakSet();
  /** @type {WeakSet<ShadowRoot>} */
  const observedShadows = new WeakSet();

  /** Whatnot seeks the full-stream receipt to a start time; we add the user's offset to that position. */
  const SEEK_SETTLE_MS = 150;
  /** If no `seeked` events (unusual), wait for Whatnot to set `currentTime` before reading base. */
  const FALLBACK_MS = 3500;

  /**
   * @param {HTMLVideoElement} video
   * @param {number} offsetSeconds
   */
  function applyReceiptOffset(video, offsetSeconds) {
    if (video.dataset[DATA_ATTR] === "true") return;

    let cleaned = false;
    /** @type {number|undefined} */
    let debounceTimer;
    /** @type {number|undefined} */
    let fallbackTimer;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      window.clearTimeout(debounceTimer);
      window.clearTimeout(fallbackTimer);
      video.removeEventListener("seeked", onSeeked);
    };

    /**
     * @param {number} baseTime
     */
    const applyFromBase = (baseTime) => {
      if (video.dataset[DATA_ATTR] === "true") return;
      try {
        const dur = video.duration;
        let t = baseTime + offsetSeconds;
        if (Number.isFinite(dur) && dur > 0) {
          t = Math.min(t, Math.max(0, dur - 0.01));
        }
        const seekable = video.seekable;
        if (seekable && seekable.length > 0) {
          const end = seekable.end(seekable.length - 1);
          if (Number.isFinite(end) && t > end) {
            t = Math.max(0, end - 0.05);
          }
        }
        video.currentTime = t;
        video.dataset[DATA_ATTR] = "true";
        cleanup();
      } catch (_) {
        // keep listeners so seeked/fallback can retry
      }
    };

    const scheduleSettle = () => {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        if (video.dataset[DATA_ATTR] === "true") return;
        applyFromBase(video.currentTime);
      }, SEEK_SETTLE_MS);
    };

    const onSeeked = () => {
      scheduleSettle();
    };

    video.addEventListener("seeked", onSeeked);

    fallbackTimer = window.setTimeout(() => {
      if (video.dataset[DATA_ATTR] === "true") return;
      applyFromBase(video.currentTime);
    }, FALLBACK_MS);
  }

  /**
   * @param {HTMLVideoElement} video
   */
  function scheduleSkip(video) {
    if (video.dataset[DATA_ATTR] === "true") return;
    if (scheduled.has(video)) return;
    if (loadInFlight.has(video)) return;
    loadInFlight.add(video);

    chrome.storage.sync.get(
      { [STORAGE_KEY]: DEFAULT_SKIP, [STORAGE_ENABLED]: true },
      (items) => {
        loadInFlight.delete(video);
        if (items[STORAGE_ENABLED] === false) {
          return;
        }
        if (scheduled.has(video)) return;
        scheduled.add(video);
        const raw = items[STORAGE_KEY];
        const n = Number(raw);
        const offsetSeconds = Number.isFinite(n) ? Math.max(0, n) : DEFAULT_SKIP;
        applyReceiptOffset(video, offsetSeconds);
      }
    );
  }

  const shadowObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        processAdded(n);
      }
    }
  });

  const mutationObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        processAdded(n);
      }
    }
  });

  /**
   * @param {Node} node
   */
  function processSubtree(node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = /** @type {Element} */ (node);
      if (el.tagName === "VIDEO") {
        scheduleSkip(/** @type {HTMLVideoElement} */ (el));
      }
      for (let i = 0; i < el.children.length; i++) {
        processSubtree(el.children[i]);
      }
      const sr = el.shadowRoot;
      if (sr && !observedShadows.has(sr)) {
        observedShadows.add(sr);
        processSubtree(sr);
        shadowObserver.observe(sr, { childList: true, subtree: true });
      }
    } else if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      const frag = /** @type {DocumentFragment} */ (node);
      for (let i = 0; i < frag.children.length; i++) {
        processSubtree(frag.children[i]);
      }
    }
  }

  /**
   * @param {Node} node
   */
  function processAdded(node) {
    processSubtree(node);
  }

  function bootstrap() {
    const root = document.body || document.documentElement;
    processSubtree(root);
    mutationObserver.observe(root, { childList: true, subtree: true });
  }

  if (document.body || document.documentElement) {
    bootstrap();
  } else {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  }

  /**
   * @param {Node} node
   * @param {HTMLVideoElement[]} out
   */
  function collectVideosDeep(node, out) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = /** @type {Element} */ (node);
      if (el.tagName === "VIDEO") {
        out.push(/** @type {HTMLVideoElement} */ (el));
      }
      for (let i = 0; i < el.children.length; i++) {
        collectVideosDeep(el.children[i], out);
      }
      if (el.shadowRoot) {
        collectVideosDeep(el.shadowRoot, out);
      }
    } else if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      const frag = /** @type {DocumentFragment} */ (node);
      for (let i = 0; i < frag.children.length; i++) {
        collectVideosDeep(frag.children[i], out);
      }
    }
  }

  /**
   * @returns {HTMLVideoElement | null}
   */
  function getPrimaryVisibleVideo() {
    /** @type {HTMLVideoElement[]} */
    const list = [];
    const root = document.body || document.documentElement;
    collectVideosDeep(root, list);
    let best = null;
    let bestArea = 0;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const r = v.getBoundingClientRect();
      if (r.width < 32 || r.height < 32) continue;
      if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) {
        continue;
      }
      const a = r.width * r.height;
      if (a > bestArea) {
        bestArea = a;
        best = v;
      }
    }
    return best;
  }

  /**
   * @param {HTMLVideoElement} video
   * @param {number} deltaSec
   */
  function nudgeVideo(video, deltaSec) {
    try {
      const dur = video.duration;
      let t = video.currentTime + deltaSec;
      if (Number.isFinite(dur) && dur > 0) {
        t = Math.min(Math.max(0, t), Math.max(0, dur - 0.01));
      } else {
        t = Math.max(0, t);
      }
      const seekable = video.seekable;
      if (seekable && seekable.length > 0) {
        const end = seekable.end(seekable.length - 1);
        const start = seekable.start(0);
        if (Number.isFinite(end) && t > end) t = Math.max(start, end - 0.05);
        if (Number.isFinite(start) && t < start) t = start;
      }
      video.currentTime = t;
    } catch (_) {
      // ignore
    }
  }

  /**
   * @param {Event} e
   */
  function onKeyDown(e) {
    if (!cachedPlayback.extensionEnabled) return;
    if (e.defaultPrevented) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;

    const t = /** @type {EventTarget | null} */ (e.target);
    if (t instanceof Element) {
      if (t.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) {
        return;
      }
    } else if (t instanceof Node && t.parentElement) {
      if (
        t.parentElement.closest(
          "input, textarea, select, [contenteditable]:not([contenteditable='false'])"
        )
      ) {
        return;
      }
    }

    const video = getPrimaryVisibleVideo();
    if (!video) return;

    const step = cachedPlayback.seekStepSeconds;
    e.preventDefault();
    e.stopImmediatePropagation();
    nudgeVideo(video, e.key === "ArrowRight" ? step : -step);
  }

  window.addEventListener("keydown", onKeyDown, true);
})();
