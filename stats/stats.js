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
  const elStatAccounts = document.getElementById("statAccounts");
  const elStatCards = document.getElementById("statCards");
  const elStatGross = document.getElementById("statGross");
  const elStatAvgAccount = document.getElementById("statAvgAccount");
  const elStatAvgCard = document.getElementById("statAvgCard");
  const elStatGiveaways = document.getElementById("statGiveaways");
  const elPanelOverview = document.getElementById("panelOverview");
  const elPanelData = document.getElementById("panelData");
  const elPanelSort = document.getElementById("panelSort");
  const tbodySold = document.getElementById("tbodySold");
  const tbodyGiveaway = document.getElementById("tbodyGiveaway");

  /** @type {any[]} */
  let lastFilteredSold = [];
  /** @type {any[]} */
  let lastFilteredGw = [];

  /** @type {any} */
  let chartItems = null;
  /** @type {any} */
  let chartValue = null;
  /** @type {any} */
  let chartCardPrice = null;

  /** @type {{ rows: any[]; cardLines?: any[]; soldCards?: any[]; giveawayCards?: any[] } | null} */
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
   * @param {any[]} soldCards
   * @param {any[]} giveawayCards
   * @param {any[]} filteredAccountRows
   * @param {boolean} statusFilterOn
   * @returns {[any[], any[]]}
   */
  function filterCatalogByStatus(
    soldCards,
    giveawayCards,
    filteredAccountRows,
    statusFilterOn
  ) {
    if (!statusFilterOn) {
      return [soldCards || [], giveawayCards || []];
    }
    const allowed = new Set(
      filteredAccountRows.map((r) => (r.recipient || "").trim()).filter(Boolean)
    );
    const fs = (soldCards || []).filter((c) => allowed.has((c.owner || "").trim()));
    const fg = (giveawayCards || []).filter((c) =>
      allowed.has((c.owner || "").trim())
    );
    return [fs, fg];
  }

  /**
   * @param {any[]} filteredSold
   * @param {any[]} filteredGiveaway
   */
  function updateSummaryPanel(filteredSold, filteredGiveaway) {
    const owners = new Set();
    for (let i = 0; i < filteredSold.length; i++) {
      const o = (filteredSold[i].owner || "").trim();
      if (o) owners.add(o);
    }
    for (let i = 0; i < filteredGiveaway.length; i++) {
      const o = (filteredGiveaway[i].owner || "").trim();
      if (o) owners.add(o);
    }
    const nAccounts = owners.size;
    const nSold = filteredSold.length;
    const nGw = filteredGiveaway.length;

    const gross = filteredSold.reduce((a, c) => a + (Number(c.value) || 0), 0);
    const grossLabel = nSold > 0 ? formatMoney(gross) : nAccounts > 0 ? formatMoney(0) : "—";

    /** @type {Map<string, number>} */
    const ownerTotals = new Map();
    for (let i = 0; i < filteredSold.length; i++) {
      const c = filteredSold[i];
      const o = (c.owner || "").trim();
      if (!o) continue;
      ownerTotals.set(o, (ownerTotals.get(o) || 0) + (Number(c.value) || 0));
    }
    const avgAccount =
      ownerTotals.size > 0 ? formatMoney(gross / ownerTotals.size) : "—";
    const avgCard = nSold > 0 ? formatMoney(gross / nSold) : "—";

    elStatAccounts.textContent = String(nAccounts);
    elStatCards.textContent = String(nSold);
    elStatGiveaways.textContent = String(nGw);
    elStatGross.textContent = grossLabel;
    elStatAvgAccount.textContent = avgAccount;
    elStatAvgCard.textContent = avgCard;
  }

  function clearSummaryPanel() {
    elStatAccounts.textContent = "—";
    elStatCards.textContent = "—";
    elStatGiveaways.textContent = "—";
    elStatGross.textContent = "—";
    elStatAvgAccount.textContent = "—";
    elStatAvgCard.textContent = "—";
  }

  /**
   * @param {any[]} sold
   * @param {any[]} gw
   */
  function renderDataTables(sold, gw) {
    tbodySold.textContent = "";
    for (let i = 0; i < sold.length; i++) {
      const c = sold[i];
      const tr = document.createElement("tr");
      const cells = [
        c.cardNum != null ? String(c.cardNum) : "—",
        c.showName || "",
        c.owner || "",
        formatMoney(Number(c.value) || 0),
        c.saleType || "",
        c.listingRaw || "",
      ];
      for (let j = 0; j < cells.length; j++) {
        const td = document.createElement("td");
        td.textContent = cells[j];
        tr.appendChild(td);
      }
      tbodySold.appendChild(tr);
    }
    tbodyGiveaway.textContent = "";
    for (let i = 0; i < gw.length; i++) {
      const c = gw[i];
      const tr = document.createElement("tr");
      const cells = [c.id || "", c.showName || "", c.owner || "", c.listingRaw || ""];
      for (let j = 0; j < cells.length; j++) {
        const td = document.createElement("td");
        td.textContent = cells[j];
        tr.appendChild(td);
      }
      tbodyGiveaway.appendChild(tr);
    }
  }

  /** @param {string} s */
  function csvEscape(s) {
    const t = String(s ?? "");
    if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
    return t;
  }

  /**
   * @param {string} filename
   * @param {string[]} header
   * @param {string[][]} rows
   */
  function downloadCsv(filename, header, rows) {
    const lines = [header.map(csvEscape).join(",")];
    for (let i = 0; i < rows.length; i++) {
      lines.push(rows[i].map(csvEscape).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
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
   * @param {any[]} filteredSold
   */
  function renderCharts(filteredSold) {
    destroyCharts();
    if (typeof Chart === "undefined") {
      setMessage("Chart library failed to load.", "err");
      return;
    }
    mplTheme();

    /** @type {Map<string, number>} */
    const soldCountByOwner = new Map();
    /** @type {Map<string, number>} */
    const soldValueByOwner = new Map();
    for (let i = 0; i < filteredSold.length; i++) {
      const c = filteredSold[i];
      const o = (c.owner || "").trim();
      if (!o) continue;
      soldCountByOwner.set(o, (soldCountByOwner.get(o) || 0) + 1);
      soldValueByOwner.set(o, (soldValueByOwner.get(o) || 0) + (Number(c.value) || 0));
    }

    const itemNums = Array.from(soldCountByOwner.values());
    const valueNums = Array.from(soldValueByOwner.values());
    const cardPrices = filteredSold.map((c) => Number(c.value)).filter((x) => Number.isFinite(x));

    const itemsSpec = countItemsBars(itemNums);
    const valueSpec = histogramFixedEdges(valueNums, ACCOUNT_VALUE_EDGES);
    const cardSpec = histogramFixedEdges(cardPrices, CARD_PRICE_EDGES);

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
            title: { display: true, text: "Sold cards per account" },
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
            title: { display: true, text: "Sold cards" },
            grid: { color: "#e0e0e0" },
          },
        },
      },
    });
  }

  /**
   * @param {{ rows: any[]; cardLines?: any[]; soldCards?: any[]; giveawayCards?: any[]; expandClickCount?: number }} payload
   * @param {number | null} scrapedAt
   */
  function render(payload, scrapedAt) {
    lastPayload = payload;
    const rows = payload.rows || [];
    const soldCards = payload.soldCards || [];
    const giveawayCards = payload.giveawayCards || [];
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
      clearSummaryPanel();
      destroyCharts();
      tbodySold.textContent = "";
      tbodyGiveaway.textContent = "";
      lastFilteredSold = [];
      lastFilteredGw = [];
      return;
    }

    elEmpty.hidden = true;
    elCharts.hidden = false;

    const t =
      scrapedAt != null
        ? new Date(scrapedAt).toLocaleString()
        : "";
    const statusFilterOn = elFilterStatus.value.trim() !== "";
    const [filteredSold, filteredGw] = filterCatalogByStatus(
      soldCards,
      giveawayCards,
      filtered,
      statusFilterOn
    );
    lastFilteredSold = filteredSold;
    lastFilteredGw = filteredGw;

    const expandBit =
      expandClicks != null ? ` · ${expandClicks} “Expand” clicks (auto)` : "";
    elMeta.textContent = `${filtered.length} of ${rows.length} accounts (main table) · ${filteredSold.length} sold cards · ${filteredGw.length} giveaways in catalog${expandBit}${t ? ` · scraped ${t}` : ""}`;

    const hasCatalog = filteredSold.length > 0 || filteredGw.length > 0;
    if (!hasCatalog) {
      destroyCharts();
      clearSummaryPanel();
      renderDataTables([], []);
      setMessage(
        "Main table loaded, but no line items were found in the catalog. Refresh after bundles expand, or check Sale type / Listing columns.",
        "err"
      );
      return;
    }

    setMessage("", "clear");
    updateSummaryPanel(filteredSold, filteredGw);
    renderCharts(filteredSold);
    renderDataTables(filteredSold, filteredGw);
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
        clearSummaryPanel();
        tbodySold.textContent = "";
        tbodyGiveaway.textContent = "";
        lastFilteredSold = [];
        lastFilteredGw = [];
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

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const panel = btn.getAttribute("data-panel");
      document.querySelectorAll(".tab").forEach((b) => {
        b.classList.toggle("tab-active", b === btn);
      });
      elPanelOverview.hidden = panel !== "overview";
      elPanelData.hidden = panel !== "data";
      elPanelSort.hidden = panel !== "sort";
    });
  });

  document.getElementById("downloadSoldCsv").addEventListener("click", () => {
    const header = ["card_num", "show", "account", "value", "sale_type", "listing"];
    const rows = lastFilteredSold.map((c) => [
      c.cardNum != null ? String(c.cardNum) : "",
      c.showName || "",
      c.owner || "",
      String(c.value ?? ""),
      c.saleType || "",
      c.listingRaw || "",
    ]);
    downloadCsv("whatnot-sold-cards.csv", header, rows);
  });

  document.getElementById("downloadGiveawayCsv").addEventListener("click", () => {
    const header = ["id", "show", "account", "listing"];
    const rows = lastFilteredGw.map((c) => [
      c.id || "",
      c.showName || "",
      c.owner || "",
      c.listingRaw || "",
    ]);
    downloadCsv("whatnot-giveaways.csv", header, rows);
  });

  // ---------- Sort Helper ----------

  const sortSetup = document.getElementById("sortSetup");
  const sortStepper = document.getElementById("sortStepper");
  const sortDisplay = document.getElementById("sortDisplay");
  const sortCardNum = document.getElementById("sortCardNum");
  const sortSub = document.getElementById("sortSub");
  const sortBatchSelect = document.getElementById("sortBatchSelect");
  const sortNote = document.getElementById("sortNote");
  const sortMin = document.getElementById("sortMin");
  const sortMax = document.getElementById("sortMax");
  const sortRowsInput = document.getElementById("sortRows");
  const sortColsInput = document.getElementById("sortCols");
  const sortStartBtn = document.getElementById("sortStart");
  const sortBackBtn = document.getElementById("sortBack");
  const sortPrevBtn = document.getElementById("sortPrev");
  const sortNextBtn = document.getElementById("sortNext");
  const sortSkipTo = document.getElementById("sortSkipTo");
  const sortSkipBtn = document.getElementById("sortSkipBtn");
  const lookupCell = document.getElementById("lookupCell");
  const lookupResult = document.getElementById("lookupResult");

  /** @type {{ cardNum: number | string; owner: string; isGiveaway?: boolean }[]} */
  let sortCards = [];
  /** @type {Map<string, number>} account → card count (sold only) */
  let sortAccountCounts = new Map();
  /** @type {{ owner: string; count: number }[]} sorted accounts for batching */
  let sortAccountOrder = [];
  /** @type {Set<string>} excluded accounts */
  let sortExcluded = new Set();
  /** @type {Map<string, string>} account → exclusion reason */
  let sortExcludeReason = new Map();
  let sortGridRows = 5;
  let sortGridCols = 5;
  let sortBatch = 0;
  let sortCardIdx = 0;
  /** @type {{ cardNum: number | string; owner: string; isGiveaway?: boolean }[]} */
  let sortBatchCards = [];
  /** @type {Map<string, number>} owner → batch index */
  let sortOwnerBatch = new Map();

  function cellName(flatIdx) {
    const row = Math.floor(flatIdx / sortGridCols);
    const col = flatIdx % sortGridCols;
    return String.fromCharCode(65 + row) + String(col + 1);
  }

  function batchSize() {
    return sortGridRows * sortGridCols;
  }

  function totalBatches() {
    return Math.max(1, Math.ceil(sortAccountOrder.length / batchSize()));
  }

  function batchAccounts(batchIdx) {
    const start = batchIdx * batchSize();
    return sortAccountOrder.slice(start, start + batchSize());
  }

  /** @returns {Map<string, string>} account → cell name for given batch */
  function batchCellMap(batchIdx) {
    const accts = batchAccounts(batchIdx);
    const map = new Map();
    for (let i = 0; i < accts.length; i++) {
      map.set(accts[i].owner, cellName(i));
    }
    return map;
  }

  /** Accounts assigned to batches 0..batchIdx-1 */
  function previousBatchAccounts(batchIdx) {
    const set = new Set();
    for (let b = 0; b < batchIdx; b++) {
      for (const a of batchAccounts(b)) set.add(a.owner);
    }
    return set;
  }

  /** Filter cards to only those relevant for the given batch */
  function cardsForBatch(batchIdx) {
    if (batchIdx === 0) return sortCards.slice();
    const prevAccts = previousBatchAccounts(batchIdx);
    return sortCards.filter((c) => {
      if (sortExcluded.has(c.owner)) return false;
      if (prevAccts.has(c.owner)) return false;
      return true;
    });
  }

  function populateBatchSelect() {
    sortBatchSelect.textContent = "";
    const n = totalBatches();
    for (let b = 0; b < n; b++) {
      const opt = document.createElement("option");
      opt.value = String(b);
      opt.textContent = `Batch ${b + 1} / ${n}`;
      sortBatchSelect.appendChild(opt);
    }
    sortBatchSelect.value = String(sortBatch);
  }

  function doLookup() {
    const code = (lookupCell.value || "").trim().toUpperCase();
    if (!code) { lookupResult.textContent = ""; return; }
    const map = batchCellMap(sortBatch);
    let found = null;
    map.forEach((cell, owner) => { if (cell === code) found = owner; });
    if (found) {
      const all = cardsForBatch(sortBatch).filter((c) => c.owner === found);
      const nums = all.map((c) => c.isGiveaway ? c.cardNum : `#${c.cardNum}`).join(", ");
      lookupResult.textContent = `${found} — ${nums || "no cards"}`;
    } else {
      lookupResult.textContent = "Empty cell";
    }
  }

  function jumpToCard(cardNum) {
    const target = parseInt(cardNum, 10);
    if (isNaN(target)) return;
    const idx = sortBatchCards.findIndex((c) => c.cardNum === target);
    if (idx >= 0) {
      sortCardIdx = idx;
      renderSortStep();
    }
  }

  function initSort() {
    const sold = lastFilteredSold || [];
    if (!sold.length) {
      sortNote.textContent = "No sold card data. Fetch data first.";
      return;
    }
    const minCards = parseInt(String(sortMin.value), 10) || 1;
    const maxCards = parseInt(String(sortMax.value), 10) || 9999;
    sortGridRows = Math.max(1, Math.min(26, parseInt(String(sortRowsInput.value), 10) || 5));
    sortGridCols = Math.max(1, Math.min(99, parseInt(String(sortColsInput.value), 10) || 5));

    sortAccountCounts = new Map();
    for (let i = 0; i < sold.length; i++) {
      const o = (sold[i].owner || "").trim();
      if (o) sortAccountCounts.set(o, (sortAccountCounts.get(o) || 0) + 1);
    }

    const gw = lastFilteredGw || [];
    for (let i = 0; i < gw.length; i++) {
      const o = (gw[i].owner || "").trim();
      if (o) sortAccountCounts.set(o, (sortAccountCounts.get(o) || 0) + 1);
    }

    const soldEntries = sold
      .filter((c) => c.cardNum != null)
      .map((c) => ({ cardNum: c.cardNum, owner: (c.owner || "").trim(), isGiveaway: false }))
      .sort((a, b) => a.cardNum - b.cardNum);

    const gwEntries = gw.map((g, i) => ({
      cardNum: g.id || `g${i + 1}`,
      owner: (g.owner || "").trim(),
      isGiveaway: true,
    }));

    sortCards = [...soldEntries, ...gwEntries];

    if (!sortCards.length) {
      sortNote.textContent = "No cards with valid card numbers found.";
      return;
    }

    sortExcluded = new Set();
    sortExcludeReason = new Map();
    sortAccountOrder = [];

    sortAccountCounts.forEach((count, owner) => {
      if (count < minCards) {
        sortExcluded.add(owner);
        sortExcludeReason.set(owner, count === 1 ? "Single card account" : `Only ${count} cards (min: ${minCards})`);
      } else if (count > maxCards) {
        sortExcluded.add(owner);
        sortExcludeReason.set(owner, `${count} cards (max: ${maxCards})`);
      } else {
        sortAccountOrder.push({ owner, count });
      }
    });

    sortAccountOrder.sort((a, b) => b.count - a.count);

    sortOwnerBatch = new Map();
    const bs = batchSize();
    for (let i = 0; i < sortAccountOrder.length; i++) {
      sortOwnerBatch.set(sortAccountOrder[i].owner, Math.floor(i / bs));
    }

    if (!sortAccountOrder.length) {
      sortNote.textContent = `All accounts excluded by filters (min: ${minCards}, max: ${maxCards}). Adjust and try again.`;
      return;
    }

    sortBatch = 0;
    sortCardIdx = 0;
    sortBatchCards = cardsForBatch(0);
    sortNote.textContent = "";
    sortSetup.hidden = true;
    sortStepper.hidden = false;
    populateBatchSelect();
    renderSortStep();
  }

  function renderSortStep() {
    if (!sortBatchCards.length) return;
    const card = sortBatchCards[sortCardIdx];
    const owner = card.owner;
    const cellMap = batchCellMap(sortBatch);
    const nBatches = totalBatches();

    sortBatchSelect.value = String(sortBatch);

    sortDisplay.className = "sort-display";
    sortSub.textContent = "";

    const gwTag = card.isGiveaway ? " (Giveaway)" : "";
    if (sortExcluded.has(owner)) {
      sortDisplay.classList.add("cell-excluded");
      sortDisplay.textContent = "✕";
      sortSub.textContent = (sortExcludeReason.get(owner) || "Excluded") + gwTag;
    } else if (cellMap.has(owner)) {
      sortDisplay.classList.add(card.isGiveaway ? "cell-giveaway" : "cell-hit");
      sortDisplay.textContent = cellMap.get(owner);
      sortSub.textContent = `${owner} — ${sortAccountCounts.get(owner) || "?"} cards${gwTag}`;
    } else {
      const ob = sortOwnerBatch.get(owner);
      sortDisplay.classList.add("cell-skip");
      sortDisplay.textContent = "—";
      sortSub.textContent = (ob != null ? `In batch ${ob + 1}` : "Not assigned") + gwTag;
    }

    sortCardNum.textContent = card.isGiveaway ? `${card.cardNum}` : `Card #${card.cardNum}`;
    sortCardNum.textContent += ` (${sortCardIdx + 1} / ${sortBatchCards.length})`;

    sortPrevBtn.disabled = sortCardIdx === 0 && sortBatch === 0;
    const isLast = sortCardIdx >= sortBatchCards.length - 1;
    const isLastBatch = sortBatch >= nBatches - 1;
    if (isLast && !isLastBatch) {
      sortNextBtn.textContent = `Batch ${sortBatch + 2} →`;
    } else if (isLast && isLastBatch) {
      sortNextBtn.textContent = "Done ✓";
    } else {
      sortNextBtn.textContent = "Next →";
    }
    sortNextBtn.disabled = isLast && isLastBatch;
    syncState();
  }

  sortStartBtn.addEventListener("click", initSort);

  sortBackBtn.addEventListener("click", () => {
    stopSession();
    sortSetup.hidden = false;
    sortStepper.hidden = true;
  });

  sortNextBtn.addEventListener("click", () => {
    if (sortCardIdx < sortBatchCards.length - 1) {
      sortCardIdx++;
      renderSortStep();
    } else if (sortBatch < totalBatches() - 1) {
      sortBatch++;
      sortBatchCards = cardsForBatch(sortBatch);
      sortCardIdx = 0;
      renderSortStep();
    }
  });

  sortPrevBtn.addEventListener("click", () => {
    if (sortCardIdx > 0) {
      sortCardIdx--;
      renderSortStep();
    } else if (sortBatch > 0) {
      sortBatch--;
      sortBatchCards = cardsForBatch(sortBatch);
      sortCardIdx = sortBatchCards.length - 1;
      renderSortStep();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (elPanelSort.hidden || sortStepper.hidden) return;
    if (e.key === "ArrowRight" || e.key === " ") {
      e.preventDefault();
      sortNextBtn.click();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      sortPrevBtn.click();
    }
  });

  sortBatchSelect.addEventListener("change", () => {
    const b = parseInt(sortBatchSelect.value, 10);
    if (isNaN(b) || b === sortBatch) return;
    sortBatch = b;
    sortBatchCards = cardsForBatch(sortBatch);
    sortCardIdx = 0;
    renderSortStep();
    doLookup();
  });

  lookupCell.addEventListener("input", doLookup);

  sortSkipBtn.addEventListener("click", () => jumpToCard(sortSkipTo.value));
  sortSkipTo.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); jumpToCard(sortSkipTo.value); }
  });

  // ---------- Remote Session ----------

  const sessionToggleBtn = document.getElementById("sessionToggle");
  const sessionPanel = document.getElementById("sessionPanel");
  const qrCodeEl = document.getElementById("qrCode");
  const sessionUrlEl = document.getElementById("sessionUrl");
  const sessionStatusEl = document.getElementById("sessionStatus");
  const relayUrlInput = document.getElementById("relayUrl");

  const savedRelay = localStorage.getItem("sortRelayUrl");
  if (savedRelay) relayUrlInput.value = savedRelay;
  relayUrlInput.addEventListener("change", () => {
    localStorage.setItem("sortRelayUrl", relayUrlInput.value.trim());
  });

  let sessionRoomId = "";
  let sessionActive = false;

  function randomRoomId() {
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let id = "";
    for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
  }

  function buildFullSortData() {
    const nBatches = totalBatches();
    const batches = [];
    for (let b = 0; b < nBatches; b++) {
      const cellMap = batchCellMap(b);
      const filtered = cardsForBatch(b);
      const cards = filtered.map((c) => {
        const gw = c.isGiveaway || false;
        const gwTag = gw ? " (Giveaway)" : "";
        if (sortExcluded.has(c.owner)) {
          return { cardNum: c.cardNum, status: "excluded", giveaway: gw, reason: (sortExcludeReason.get(c.owner) || "Excluded") + gwTag };
        }
        if (cellMap.has(c.owner)) {
          return {
            cardNum: c.cardNum,
            status: "hit",
            giveaway: gw,
            cell: cellMap.get(c.owner),
            ownerInfo: `${c.owner} — ${sortAccountCounts.get(c.owner) || "?"} cards${gwTag}`,
          };
        }
        const ob = sortOwnerBatch.get(c.owner);
        return { cardNum: c.cardNum, status: "skip", giveaway: gw, inBatch: ob != null ? ob + 1 : null };
      });
      const cellToAccount = {};
      cellMap.forEach((cell, owner) => {
        const nums = filtered.filter((c) => c.owner === owner).map((c) => c.cardNum);
        cellToAccount[cell] = { owner, cards: nums };
      });
      batches.push({ cards, cellToAccount });
    }
    return { batches, totalBatches: nBatches };
  }

  function syncState() {}

  async function startSession() {
    const relay = (relayUrlInput.value || "").trim().replace(/\/+$/, "");
    if (!relay) {
      sessionStatusEl.textContent = "Enter a relay URL first.";
      return;
    }
    if (!sortCards.length) {
      sessionStatusEl.textContent = "No sort data to share.";
      return;
    }

    sessionRoomId = randomRoomId();
    const phoneUrl = `${relay}/room/${sessionRoomId}`;
    sessionStatusEl.textContent = "Uploading data…";

    try {
      const data = buildFullSortData();
      const res = await fetch(`${relay}/api/${sessionRoomId}/data`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(res.statusText);
    } catch (err) {
      sessionStatusEl.textContent = `Upload failed: ${err.message}`;
      return;
    }

    sessionActive = true;
    sessionToggleBtn.textContent = "Stop session";
    sessionPanel.hidden = false;
    sessionStatusEl.textContent = `Ready — ${sortCards.length} cards uploaded`;

    qrCodeEl.textContent = "";
    if (typeof qrcode !== "undefined") {
      const qr = qrcode(0, "M");
      qr.addData(phoneUrl);
      qr.make();
      qrCodeEl.innerHTML = qr.createImgTag(4, 8);
    }
    sessionUrlEl.textContent = phoneUrl;
  }

  function stopSession() {
    sessionActive = false;
    sessionRoomId = "";
    sessionToggleBtn.textContent = "Start session";
    sessionPanel.hidden = true;
    qrCodeEl.textContent = "";
    sessionUrlEl.textContent = "";
    sessionStatusEl.textContent = "";
  }

  sessionToggleBtn.addEventListener("click", () => {
    if (sessionActive) stopSession();
    else startSession();
  });

  mplTheme();
  loadFromStorage();
})();
