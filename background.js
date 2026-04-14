(function () {
  "use strict";

  const STORAGE_ORDERS = "ordersLastScrape";
  const STORAGE_AT = "ordersScrapedAt";

  const WHATNOT_URLS = ["*://whatnot.com/*", "*://*.whatnot.com/*"];

  /**
   * @param {chrome.tabs.Tab} tab
   */
  function isWhatnotTab(tab) {
    const u = tab.url || "";
    try {
      const host = new URL(u).hostname;
      return host === "whatnot.com" || host.endsWith(".whatnot.com");
    } catch (_) {
      return false;
    }
  }

  /**
   * @param {number} tabId
   * @param {function(any): void} sendResponse
   */
  function runScrapeOnTab(tabId, sendResponse) {
    chrome.tabs.sendMessage(tabId, { type: "SCRAPE_ORDERS" }, (res) => {
      if (chrome.runtime.lastError) {
        sendResponse({
          ok: false,
          error:
            "Cannot fetch data: Whatnot page may not be ready, or this URL does not load the extension. Reload the page and try again.",
        });
        return;
      }
      if (!res?.ok) {
        sendResponse({
          ok: false,
          error: res?.error || "Could not read orders from this page.",
        });
        return;
      }

      const payload = {
        rows: res.rows || [],
        cardLines: res.cardLines || [],
        expandClickCount: typeof res.expandClickCount === "number" ? res.expandClickCount : 0,
      };
      chrome.storage.local.set(
        { [STORAGE_ORDERS]: payload, [STORAGE_AT]: Date.now() },
        () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          sendResponse({ ok: true, data: payload });
        }
      );
    });
  }

  /**
   * Stats opens in a separate popup window. `currentWindow` would be that window
   * (active tab = chrome-extension://…), not the browser with Whatnot. Use the
   * last-focused *normal* window first, then any Whatnot tab.
   * @param {function(any): void} sendResponse
   */
  function findWhatnotTabAndScrape(sendResponse) {
    chrome.windows.getLastFocused({ windowTypes: ["normal"] }, (w) => {
      if (chrome.runtime.lastError || !w?.id) {
        sendResponse({
          ok: false,
          error: "Cannot fetch data: no browser window found. Open Chrome and a Whatnot tab first.",
        });
        return;
      }

      chrome.tabs.query({ windowId: w.id }, (tabsInWin) => {
        if (chrome.runtime.lastError || !tabsInWin?.length) {
          sendResponse({ ok: false, error: "Cannot fetch data: could not read tabs." });
          return;
        }

        const active = tabsInWin.find((t) => t.active);
        if (active && isWhatnotTab(active) && active.id != null) {
          runScrapeOnTab(active.id, sendResponse);
          return;
        }

        const anyInWin = tabsInWin.find((t) => isWhatnotTab(t));
        if (anyInWin?.id != null) {
          runScrapeOnTab(anyInWin.id, sendResponse);
          return;
        }

        chrome.tabs.query({ url: WHATNOT_URLS }, (allWn) => {
          if (chrome.runtime.lastError || !allWn?.length) {
            sendResponse({
              ok: false,
              error:
                "Cannot fetch data: open a Whatnot tab (e.g. orders/shipping) in Chrome, then try again.",
            });
            return;
          }

          const activeWn = allWn.find((t) => t.active);
          const tab = activeWn || allWn[0];
          if (tab?.id == null) {
            sendResponse({ ok: false, error: "Cannot fetch data: no Whatnot tab to use." });
            return;
          }
          runScrapeOnTab(tab.id, sendResponse);
        });
      });
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "REFRESH_ORDERS") {
      findWhatnotTabAndScrape(sendResponse);
      return true;
    }

    return false;
  });
})();
