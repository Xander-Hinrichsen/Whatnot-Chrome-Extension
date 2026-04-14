(function () {
  "use strict";

  const STORAGE_ORDERS = "ordersLastScrape";
  const STORAGE_AT = "ordersScrapedAt";

  const elMessage = document.getElementById("message");
  const elMeta = document.getElementById("meta");
  const elEmpty = document.getElementById("emptyState");
  const elCharts = document.getElementById("charts");
  const elFilterStatus = document.getElementById("filterStatus");
  const btnRefresh = document.getElementById("refresh");

  /** @type {any} */
  let chartItems = null;
  /** @type {any} */
  let chartValue = null;
  /** @type {any} */
  let chartCardPrice = null;

  /** @type {{ rows: any[]; cardLines?: any[] } | null} */
  let lastPayload = null;

  /** Dense bins for typical account totals (most mass below ~$30). */
  const ACCOUNT_VALUE_EDGES = [
    0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 40, 55, 75, 100, 150, Infinity,
  ];

  /** Finer bins for single-card / line-item prices. */
  const CARD_PRICE_EDGES = [
    0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 30, 40, 55, Infinity,
  ];

  function mplTheme() {
    if (typeof Chart === "undefined") return;
    Chart.defaults.font.family =
      '"DejaVu Sans", "Helvetica Neue", Helvetica, Arial, ui-sans-serif, system-ui, sans-serif';
    Chart.defaults.font.size = 11;
    Chart.defaults.color = "#333333";
    Chart.defaults.borderColor = "#cccccc";
    Chart.defaults.backgroundColor = "rgba(255,255,255,0.9)";
  }

  /**
   * @param {string} text
   * @param {'err'|'ok'|'clear'} kind
   */
  function setMessage(text, kind) {
    elMessage.textContent = text || "";
    elMessage.classList.toggle("ok", kind === "ok");
    if (kind === "clear") {
      elMessage.textContent = "";
      elMessage.classList.remove("ok");
    }
  }

  /** @param {number} n */
  function formatMoney(n) {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(n);
  }

  /**
   * Fixed-width buckets; `edges` must be ascending, first0, last Infinity.
   * @param {number[]} values
   * @param {number[]} edges
   */
  function histogramFixedEdges(values, edges) {
    const v = values.filter((x) => Number.isFinite(x));
    if (v.length === 0) return { labels: [], counts: [] };

    const nBins = edges.length - 1;
    if (nBins < 1) return { labels: [], counts: [] };

    const counts = new Array(nBins).fill(0);
    for (const x of v) {
      let b = nBins - 1;
      for (let i = 0; i < nBins - 1; i++) {
        if (x < edges[i + 1]) {
          b = i;
          break;
        }
      }
      counts[b]++;
    }

    const labels = [];
    for (let i = 0; i < nBins; i++) {
      const lo = edges[i];
      const hi = edges[i + 1];
      labels.push(
        hi === Infinity ? `${formatMoney(lo)}+` : `${formatMoney(lo)}–${formatMoney(hi)}`
      );
    }
    return { labels, counts };
  }

  /**
   * @param {number[]} items
   */
  function countItemsBars(items) {
    const map = new Map();
    for (const n of items) {
      if (!Number.isFinite(n)) continue;
      map.set(n, (map.get(n) || 0) + 1);
    }
    const keys = Array.from(map.keys()).sort((a, b) => a - b);
    return {
      labels: keys.map((k) => String(k)),
      counts: keys.map((k) => map.get(k) || 0),
    };
  }

  /**
   * @param {any[]} rows
   * @param {string} status
   */
  function filterRows(rows, status) {
    const s = status.trim();
    if (!s) return rows;
    return rows.filter((r) => (r.status || "").trim() === s);
  }

  /**
   * @param {any[]} rows
   */
  function uniqueStatuses(rows) {
    const set = new Set();
    for (const r of rows) {
      const st = (r.status || "").trim();
      if (st) set.add(st);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  /**
   * @param {any[]} cardLines
   * @param {any[]} filteredAccountRows
   * @param {boolean} statusFilterOn
   */
  function filterCardLines(cardLines, filteredAccountRows, statusFilterOn) {
    if (!statusFilterOn) return cardLines;
    const allowed = new Set(
      filteredAccountRows.map((r) => (r.recipient || "").trim()).filter(Boolean)
    );
    return cardLines.filter((line) => {
      const r = (line.recipient || "").trim();
      if (!r) return false;
      return allowed.has(r);
    });
  }

  /**
   * @param {any[]} cardLines
   * @returns {number[]}
   */
  function cardLinesToUnitSamples(cardLines) {
    /** @type {number[]} */
    const out = [];
    for (let i = 0; i < cardLines.length; i++) {
      const line = cardLines[i];
      const price = line.unitPrice;
      if (!Number.isFinite(price)) continue;
      let q = line.qty;
      if (!Number.isFinite(q) || q < 1) q = 1;
      q = Math.min(q, 500);
      for (let j = 0; j < q; j++) out.push(price);
    }
    return out;
  }

  function destroyCharts() {
    if (chartItems) {
      chartItems.destroy();
      chartItems = null;
    }
    if (chartValue) {
      chartValue.destroy();
      chartValue = null;
    }
    if (chartCardPrice) {
      chartCardPrice.destroy();
      chartCardPrice = null;
    }
  }

  /**
   * @param {any[]} rows
   * @param {any[]} allCardLines
   */
  function renderCharts(rows, allCardLines) {
    destroyCharts();
    if (typeof Chart === "undefined") {
      setMessage("Chart library failed to load.", "err");
      return;
    }
    mplTheme();

    const statusFilterOn = elFilterStatus.value.trim() !== "";
    const cardLines = filterCardLines(allCardLines || [], rows, statusFilterOn);
    const cardSamples = cardLinesToUnitSamples(cardLines);

    const itemNums = rows.map((r) => r.items).filter((x) => Number.isFinite(x));
    const valueNums = rows.map((r) => r.value).filter((x) => Number.isFinite(x));

    const itemsSpec = countItemsBars(itemNums);
    const valueSpec = histogramFixedEdges(valueNums, ACCOUNT_VALUE_EDGES);
    const cardSpec = histogramFixedEdges(cardSamples, CARD_PRICE_EDGES);

    const tabBlue = "#1f77b4";
    const tabOrange = "#ff7f0e";
    const tabGreen = "#2ca02c";

    const ctxI = document.getElementById("chartItems");
    const ctxV = document.getElementById("chartValue");
    const ctxC = document.getElementById("chartCardPrice");

    chartItems = new Chart(ctxI, {
      type: "bar",
      data: {
        labels: itemsSpec.labels,
        datasets: [
          {
            label: "Accounts",
            data: itemsSpec.counts,
            backgroundColor: tabBlue,
            borderColor: tabBlue,
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
        },
        scales: {
          x: {
            title: { display: true, text: "Items (main table)" },
            grid: { color: "#e0e0e0" },
          },
          y: {
            beginAtZero: true,
            ticks: { precision: 0 },
            title: { display: true, text: "Accounts" },
            grid: { color: "#e0e0e0" },
          },
        },
      },
    });

    chartValue = new Chart(ctxV, {
      type: "bar",
      data: {
        labels: valueSpec.labels,
        datasets: [
          {
            label: "Accounts",
            data: valueSpec.counts,
            backgroundColor: tabOrange,
            borderColor: tabOrange,
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
        },
        scales: {
          x: {
            title: { display: true, text: "Total per account (USD)" },
            grid: { display: false },
            ticks: { maxRotation: 45, minRotation: 45, autoSkip: true },
          },
          y: {
            beginAtZero: true,
            ticks: { precision: 0 },
            title: { display: true, text: "Accounts" },
            grid: { color: "#e0e0e0" },
          },
        },
      },
    });

    chartCardPrice = new Chart(ctxC, {
      type: "bar",
      data: {
        labels: cardSpec.labels,
        datasets: [
          {
            label: "Cards",
            data: cardSpec.counts,
            backgroundColor: tabGreen,
            borderColor: tabGreen,
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
        },
        scales: {
          x: {
            title: { display: true, text: "Unit price (USD)" },
            grid: { display: false },
            ticks: { maxRotation: 45, minRotation: 45, autoSkip: true },
          },
          y: {
            beginAtZero: true,
            ticks: { precision: 0 },
            title: { display: true, text: "Cards (qty-weighted)" },
            grid: { color: "#e0e0e0" },
          },
        },
      },
    });
  }

  /**
   * @param {{ rows: any[]; cardLines?: any[]; expandClickCount?: number }} payload
   * @param {number | null} scrapedAt
   */
  function render(payload, scrapedAt) {
    lastPayload = payload;
    const rows = payload.rows || [];
    const cardLines = payload.cardLines || [];
    const expandClicks =
      typeof payload.expandClickCount === "number" ? payload.expandClickCount : null;

    const statuses = uniqueStatuses(rows);
    const prev = elFilterStatus.value;
    elFilterStatus.innerHTML = "";
    const optAll = document.createElement("option");
    optAll.value = "";
    optAll.textContent = "All";
    elFilterStatus.appendChild(optAll);
    for (const st of statuses) {
      const o = document.createElement("option");
      o.value = st;
      o.textContent = st;
      elFilterStatus.appendChild(o);
    }
    if (prev && statuses.includes(prev)) {
      elFilterStatus.value = prev;
    }

    const filtered = filterRows(rows, elFilterStatus.value);

    if (rows.length === 0) {
      elEmpty.hidden = false;
      elCharts.hidden = true;
      elMeta.textContent = "";
      destroyCharts();
      return;
    }

    elEmpty.hidden = true;
    elCharts.hidden = false;

    const t =
      scrapedAt != null
        ? new Date(scrapedAt).toLocaleString()
        : "";
    const statusFilterOn = elFilterStatus.value.trim() !== "";
    const cardLinesFiltered = filterCardLines(cardLines, filtered, statusFilterOn);
    const nCardUnits = cardLinesToUnitSamples(cardLinesFiltered).length;

    const expandBit =
      expandClicks != null ? ` · ${expandClicks} “Expand” clicks (auto)` : "";
    elMeta.textContent = `${filtered.length} of ${rows.length} accounts shown · ${nCardUnits} card line-items (qty-weighted)${expandBit}${t ? ` · scraped ${t}` : ""}`;

    const hasNumeric =
      filtered.some((r) => Number.isFinite(r.items)) ||
      filtered.some((r) => Number.isFinite(r.value)) ||
      nCardUnits > 0;
    if (!hasNumeric) {
      destroyCharts();
      setMessage(
        "Rows found but Items/Value could not be parsed, and no per-card prices were found. The extension auto-clicks “Expand” before scraping; if this stays empty, Whatnot may use a different control or load bundles in a way we can’t read yet.",
        "err"
      );
      return;
    }

    setMessage("", "clear");
    renderCharts(filtered, cardLines);
  }

  function loadFromStorage() {
    chrome.storage.local.get([STORAGE_ORDERS, STORAGE_AT], (items) => {
      const payload = items[STORAGE_ORDERS];
      const at = items[STORAGE_AT];
      if (payload && payload.rows && payload.rows.length) {
        render(payload, typeof at === "number" ? at : null);
      } else {
        elEmpty.hidden = false;
        elCharts.hidden = true;
        elMeta.textContent = "";
      }
    });
  }

  btnRefresh.addEventListener("click", () => {
    setMessage("Fetching…", "ok");
    chrome.runtime.sendMessage({ type: "REFRESH_ORDERS" }, (res) => {
      if (chrome.runtime.lastError) {
        setMessage("Cannot fetch data: " + chrome.runtime.lastError.message, "err");
        return;
      }
      if (!res?.ok) {
        setMessage(res?.error || "Cannot fetch data.", "err");
        return;
      }
      setMessage("Updated.", "ok");
      window.setTimeout(() => setMessage("", "clear"), 2000);
      chrome.storage.local.get([STORAGE_AT], (items) => {
        render(res.data, items[STORAGE_AT] ?? Date.now());
      });
    });
  });

  elFilterStatus.addEventListener("change", () => {
    if (lastPayload) {
      chrome.storage.local.get([STORAGE_AT], (items) => {
        render(lastPayload, items[STORAGE_AT] ?? null);
      });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE_ORDERS]) return;
    const nv = changes[STORAGE_ORDERS].newValue;
    if (nv && nv.rows) {
      chrome.storage.local.get([STORAGE_AT], (items) => {
        render(nv, items[STORAGE_AT] ?? null);
      });
    }
  });

  mplTheme();
  loadFromStorage();
})();
