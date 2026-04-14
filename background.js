(function () {
  "use strict";

  const STORAGE_ORDERS = "ordersLastScrape";
  const STORAGE_AT = "ordersScrapedAt";
  const STORAGE_STATS_WINDOW = "statsWindowId";

  const WHATNOT_URLS = ["*://whatnot.com/*", "*://*.whatnot.com/*"];
  const STATS_PATH = "/stats/stats.html";

  function statsPageUrl() {
    return chrome.runtime.getURL("stats/stats.html");
  }

  /**
   * @param {number} windowId
   * @param {function(any): void} sendResponse
   */
  function focusStatsWindow(windowId, sendResponse) {
    chrome.windows.update(windowId, { focused: true }, () => {
      if (chrome.runtime.lastError) {
        chrome.storage.local.remove(STORAGE_STATS_WINDOW);
        createStatsWindow(sendResponse);
        return;
      }
      chrome.tabs.query({ windowId }, (tabs) => {
        if (!tabs?.length) {
          sendResponse({ ok: true, focused: true });
          return;
        }
        const statsTab = tabs.find((t) => t.url && t.url.includes(STATS_PATH));
        if (statsTab?.id != null) {
          chrome.tabs.update(statsTab.id, { active: true }, () => {
            sendResponse({ ok: true, focused: true });
          });
          return;
        }
        sendResponse({ ok: true, focused: true });
      });
    });
  }

  /**
   * @param {function(any): void} sendResponse
   */
  function createStatsWindow(sendResponse) {
    chrome.windows.create(
      {
        url: statsPageUrl(),
        type: "popup",
        width: 960,
        height: 780,
        focused: true,
      },
      (win) => {
        if (chrome.runtime.lastError || win?.id == null) {
          sendResponse({
            ok: false,
            error: chrome.runtime.lastError?.message || "Could not create window.",
          });
          return;
        }
        chrome.storage.local.set({ [STORAGE_STATS_WINDOW]: win.id }, () => {
          sendResponse({ ok: true, created: true });
        });
      }
    );
  }

  /**
   * @param {function(any): void} sendResponse
   */
  function openOrFocusStats(sendResponse) {
    function findExistingStatsWindow(orElseCreate) {
      chrome.tabs.query({}, (tabs) => {
        if (chrome.runtime.lastError || !tabs?.length) {
          orElseCreate();
          return;
        }
        const statsTab = tabs.find((t) => (t.url || "").includes(STATS_PATH));
        if (statsTab?.windowId != null) {
          chrome.storage.local.set({ [STORAGE_STATS_WINDOW]: statsTab.windowId }, () => {
            focusStatsWindow(statsTab.windowId, sendResponse);
          });
          return;
        }
        orElseCreate();
      });
    }

    chrome.storage.local.get(STORAGE_STATS_WINDOW, (items) => {
      const wid = items[STORAGE_STATS_WINDOW];
      if (wid == null) {
        findExistingStatsWindow(() => createStatsWindow(sendResponse));
        return;
      }
      chrome.windows.get(wid, (win) => {
        if (chrome.runtime.lastError || !win) {
          chrome.storage.local.remove(STORAGE_STATS_WINDOW);
          findExistingStatsWindow(() => createStatsWindow(sendResponse));
          return;
        }
        focusStatsWindow(wid, sendResponse);
      });
    });
  }

  chrome.windows.onRemoved.addListener((windowId) => {
    chrome.storage.local.get(STORAGE_STATS_WINDOW, (items) => {
      if (items[STORAGE_STATS_WINDOW] === windowId) {
        chrome.storage.local.remove(STORAGE_STATS_WINDOW);
      }
    });
  });

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
    function attempt(triesLeft) {
      chrome.tabs.sendMessage(tabId, { type: "SCRAPE_ORDERS" }, (res) => {
        if (chrome.runtime.lastError) {
          if (triesLeft > 0) {
            setTimeout(() => attempt(triesLeft - 1), 700);
            return;
          }
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
          soldCards: res.soldCards || [],
          giveawayCards: res.giveawayCards || [],
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

    attempt(1);
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

    if (message?.type === "OPEN_OR_FOCUS_STATS") {
      openOrFocusStats(sendResponse);
      return true;
    }

    return false;
  });
})();
