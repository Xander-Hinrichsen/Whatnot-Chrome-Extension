(function () {
  "use strict";

  const STORAGE_KEY = "skipSeconds";
  const DEFAULT_SKIP = 28;
  const DATA_ATTR = "hasSkipped";

  /** @type {WeakSet<HTMLVideoElement>} */
  const scheduled = new WeakSet();
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
    scheduled.add(video);

    chrome.storage.sync.get({ [STORAGE_KEY]: DEFAULT_SKIP }, (items) => {
      const raw = items[STORAGE_KEY];
      const n = Number(raw);
      const offsetSeconds = Number.isFinite(n) ? Math.max(0, n) : DEFAULT_SKIP;
      applyReceiptOffset(video, offsetSeconds);
    });
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
})();
