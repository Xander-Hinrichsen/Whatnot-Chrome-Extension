(function () {
  "use strict";

  /**
   * @typedef {{
   *   recipient: string;
   *   orderDate: string;
   *   items: number | null;
   *   value: number | null;
   *   valueRaw: string;
   *   weight: string;
   *   dimensions: string;
   *   requirements: string;
   *   status: string;
   *   tracking: string;
   * }} OrderRow
   *
   * @typedef {{ unitPrice: number; qty: number; recipient: string }} CardLine
   */

  /** @param {string} s */
  function normHeader(s) {
    return s
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .replace(/[↑↓↕]/g, "")
      .trim();
  }

  /** @param {string} text */
  function parseMoney(text) {
    const m = text.replace(/,/g, "").match(/-?\$?\s*([0-9]+(?:\.[0-9]+)?)/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return Number.isFinite(n) ? n : null;
  }

  /** @param {string} text */
  function parseItems(text) {
    const t = text.trim();
    if (!t) return null;
    const n = parseInt(t, 10);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * @param {Element} root
   * @param {string} selector
   * @returns {Element[]}
   */
  function queryAllDeep(root, selector) {
    /** @type {Element[]} */
    const out = [];
    function walk(node) {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
      const el = /** @type {Element} */ (node);
      try {
        out.push(...el.querySelectorAll(selector));
      } catch (_) {
        return;
      }
      const children = el.children;
      for (let i = 0; i < children.length; i++) {
        walk(children[i]);
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
    walk(root);
    return out;
  }

  /** @param {number} ms */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Bundle line-items are often not in the DOM until the row’s “Expand” control runs.
   * @param {Element} el
   */
  function shouldClickExpand(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.disabled) return false;
    if (el.getAttribute("aria-expanded") === "true") return false;

    const al = (el.getAttribute("aria-label") || "").trim().toLowerCase();
    if (al.includes("collapse")) return false;
    if (al.includes("expand")) return true;

    const raw = (el.innerText || "").trim().toLowerCase();
    const firstLine = raw.split("\n")[0] || "";
    if (firstLine === "expand" || /^expand\b/.test(firstLine)) {
      if (firstLine.length < 36) return true;
    }
    return false;
  }

  /**
   * @param {Element} root
   * @returns {HTMLElement[]}
   */
  function collectExpandTargets(root) {
    const sel = 'button, [role="button"], a[href], div[role="button"], span[role="button"]';
    /** @type {HTMLElement[]} */
    const raw = [];
    const seen = new Set();

    function add(el) {
      if (!(el instanceof HTMLElement)) return;
      if (seen.has(el)) return;
      seen.add(el);
      raw.push(el);
    }

    root.querySelectorAll(sel).forEach((e) => add(/** @type {HTMLElement} */ (e)));
    queryAllDeep(root, sel).forEach((e) => add(/** @type {HTMLElement} */ (e)));
    return raw;
  }

  /**
   * Click Expand toggles so nested “Items (Bundled)” mounts. Several rounds help
   * virtualized lists after scrolling.
   * @param {Element} root
   */
  async function autoExpandBundleRows(root) {
    const maxRounds = 14;
    const maxClicksPerRound = 130;
    const pauseClick = 20;
    const pauseRound = 500;
    let totalClicks = 0;
    const clicked = new WeakSet();

    for (let round = 0; round < maxRounds; round++) {
      const targets = collectExpandTargets(root).filter(shouldClickExpand);
      let clickedThisRound = 0;
      for (let i = 0; i < targets.length; i++) {
        if (clickedThisRound >= maxClicksPerRound) break;
        const el = targets[i];
        if (clicked.has(el)) continue;
        try {
          el.click();
          clicked.add(el);
          clickedThisRound++;
          totalClicks++;
          await sleep(pauseClick);
        } catch (_) {}
      }
      if (clickedThisRound === 0) break;
      try {
        window.scrollBy(0, 700);
      } catch (_) {}
      await sleep(pauseRound);
    }

    try {
      window.scrollTo(0, 0);
    } catch (_) {}
    await sleep(200);
    return totalClicks;
  }

  /** @param {Element} cell */
  function cellText(cell) {
    return cell.innerText.replace(/\s+/g, " ").trim();
  }

  /**
   * @param {string[]} headers
   * @returns {Record<string, number>}
   */
  function mapHeaderIndices(headers) {
    const texts = headers.map(normHeader);
    /** @type {Record<string, number>} */
    const idx = {
      recipient: -1,
      orderDate: -1,
      items: -1,
      value: -1,
      weight: -1,
      dimensions: -1,
      requirements: -1,
      status: -1,
      tracking: -1,
    };

    const rules = [
      ["recipient", ["recipient"]],
      ["orderDate", ["order date"]],
      ["items", ["items"]],
      ["value", ["value"]],
      ["weight", ["weight"]],
      ["dimensions", ["dimensions"]],
      ["requirements", ["requirements"]],
      ["status", ["status"]],
      ["tracking", ["tracking"]],
    ];

    for (const [key, patterns] of rules) {
      for (let i = 0; i < texts.length; i++) {
        const t = texts[i];
        for (const p of patterns) {
          if (t === p || t.startsWith(p + " ") || t.endsWith(" " + p)) {
            idx[key] = i;
            break;
          }
        }
        if (idx[key] >= 0) break;
      }
    }

    if (idx.orderDate < 0) {
      for (let i = 0; i < texts.length; i++) {
        if (texts[i] === "date" && idx.orderDate < 0) {
          idx.orderDate = i;
          break;
        }
      }
    }

    return idx;
  }

  /**
   * @param {string[]} normTexts
   */
  function isMainOrdersTableHeader(normTexts) {
    const hasRecipient = normTexts.some((t) => t === "recipient" || t.startsWith("recipient"));
    const hasValue = normTexts.some((t) => t === "value" || t.startsWith("value "));
    return hasRecipient && hasValue;
  }

  /**
   * Bundled line-item grid: has unit Price, not the main orders header.
   * @param {string[]} normTexts
   */
  function isBundledItemsTable(normTexts) {
    const hasPrice = normTexts.some((t) => t === "price" || t.startsWith("price "));
    if (!hasPrice) return false;
    if (isMainOrdersTableHeader(normTexts)) return false;

    const hasListing = normTexts.some((t) => t === "listing" || t.startsWith("listing "));
    const hasQty = normTexts.some((t) => t === "qty" || t === "quantity");
    const hasShipping =
      normTexts.some((t) => t === "shipping") ||
      normTexts.some((t) => t.includes("shipping") && !t.includes("tracking"));
    const hasSaleType = normTexts.some((t) => t.includes("sale") && t.includes("type"));
    const hasHazmat = normTexts.some((t) => t === "hazmat");
    const nonEmpty = normTexts.filter((t) => t.length > 0).length;
    const looksLikeWideRow =
      nonEmpty >= 4 && normTexts.some((t) => t === "weight" || t.startsWith("weight "));
    return (
      hasListing ||
      hasQty ||
      hasShipping ||
      hasSaleType ||
      hasHazmat ||
      looksLikeWideRow
    );
  }

  /**
   * @param {string[]} normTexts
   * @returns {{ price: number; qty: number }}
   */
  function mapBundledColumnIndices(normTexts) {
    let price = -1;
    let qty = -1;
    for (let i = 0; i < normTexts.length; i++) {
      const t = normTexts[i];
      if (price < 0 && (t === "price" || t.startsWith("price "))) price = i;
      if (qty < 0 && (t === "qty" || t === "quantity")) qty = i;
    }
    return { price, qty };
  }

  /**
   * First table row may be a title; scan a few rows for a real header.
   * @param {HTMLTableElement} table
   * @returns {{ col: { price: number; qty: number }; headerTr: HTMLTableRowElement | null } | null}
   */
  function scanTableForBundledHeader(table) {
    const rows = table.querySelectorAll("tr");
    for (let i = 0; i < Math.min(8, rows.length); i++) {
      const tr = rows[i];
      const cells = tr.querySelectorAll("th, td");
      if (cells.length < 2) continue;
      const normTexts = Array.from(cells).map((c) => normHeader(cellText(c)));
      if (isMainOrdersTableHeader(normTexts)) continue;
      if (!isBundledItemsTable(normTexts)) continue;
      const col = mapBundledColumnIndices(normTexts);
      if (col.price < 0) continue;
      return { col, headerTr: /** @type {HTMLTableRowElement} */ (tr) };
    }
    return null;
  }

  /**
   * @param {Element} root
   * @returns {Element[]}
   */
  function findTablesNearBundledSection(root) {
    /** @type {Element[]} */
    const found = [];

    function visit(node) {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
      const el = /** @type {Element} */ (node);
      const text = ((el.getAttribute("aria-label") || "") + " " + (el.textContent || "")).slice(
        0,
        280
      );
      if (/bundled/i.test(text)) {
        el.querySelectorAll("table").forEach((t) => found.push(t));
      }
      const kids = el.children;
      for (let i = 0; i < kids.length; i++) visit(kids[i]);
      if (el.shadowRoot) visit(el.shadowRoot);
    }

    visit(root);
    return found;
  }

  /**
   * @param {Element} table
   * @param {string[]} knownRecipients
   */
  function guessRecipientNearTable(table, knownRecipients) {
    let el = table.parentElement;
    for (let d = 0; d < 14 && el; d++, el = el.parentElement) {
      const blob = el.innerText || "";
      let best = "";
      for (let i = 0; i < knownRecipients.length; i++) {
        const r = knownRecipients[i];
        if (!r) continue;
        if (blob.includes(r) && r.length > best.length) best = r;
      }
      if (best) return best;
    }
    return "";
  }

  /**
   * @param {HTMLTableElement} table
   * @param {{ price: number; qty: number }} col
   * @param {string} recipient
   * @returns {CardLine[]}
   */
  /**
   * @param {HTMLTableElement} table
   * @param {{ price: number; qty: number }} col
   * @param {string} recipient
   * @param {HTMLTableRowElement | null} headerTr skip this row if it appears again in tbody
   */
  function extractBundledCardLinesFromHtmlTable(table, col, recipient, headerTr) {
    /** @type {CardLine[]} */
    const out = [];
    const allTr = Array.from(table.querySelectorAll("tr"));

    for (let i = 0; i < allTr.length; i++) {
      const tr = allTr[i];
      if (headerTr && tr === headerTr) continue;
      if (tr.closest("thead")) continue;
      const cells = tr.querySelectorAll("td");
      if (!cells.length) continue;
      const arr = Array.from(cells);
      const pi = col.price;
      if (pi < 0 || pi >= arr.length) continue;

      const priceCellText = cellText(arr[pi]);
      if (normHeader(priceCellText) === "price") continue;

      const price = parseMoney(priceCellText);
      if (!Number.isFinite(price)) continue;
      let q = 1;
      if (col.qty >= 0 && col.qty < arr.length) {
        const qRaw = parseItems(cellText(arr[col.qty]));
        if (Number.isFinite(qRaw) && qRaw > 0) q = qRaw;
      }
      out.push({ unitPrice: price, qty: q, recipient });
    }
    return out;
  }

  /**
   * @param {Element} gridLike
   * @param {string} recipient
   * @returns {CardLine[]}
   */
  function extractBundledCardLinesFromAriaGrid(gridLike, recipient) {
    /** @type {CardLine[]} */
    const out = [];
    const rows = gridLike.querySelectorAll('[role="row"]');
    /** @type {{ price: number; qty: number } | null} */
    let col = null;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const cells = row.querySelectorAll(
        '[role="columnheader"], [role="gridcell"], [role="cell"], th, td'
      );
      if (!cells.length) continue;
      const arr = Array.from(cells);
      const normTexts = arr.map((c) => normHeader(cellText(c)));

      if (isMainOrdersTableHeader(normTexts)) continue;

      if (!col) {
        if (!isBundledItemsTable(normTexts)) continue;
        const mapped = mapBundledColumnIndices(normTexts);
        if (mapped.price < 0) continue;
        col = mapped;
        continue;
      }

      const pi = col.price;
      if (pi < 0 || pi >= arr.length) continue;
      const priceCellText = cellText(arr[pi]);
      if (normHeader(priceCellText) === "price") continue;
      const price = parseMoney(priceCellText);
      if (!Number.isFinite(price)) continue;
      let q = 1;
      if (col.qty >= 0 && col.qty < arr.length) {
        const qRaw = parseItems(cellText(arr[col.qty]));
        if (Number.isFinite(qRaw) && qRaw > 0) q = qRaw;
      }
      out.push({ unitPrice: price, qty: q, recipient });
    }
    return out;
  }

  /**
   * @param {Element} root
   * @param {string[]} knownRecipients
   * @returns {CardLine[]}
   */
  function scrapeBundledCardLines(root, knownRecipients) {
    /** @type {Set<Element>} */
    const candidates = new Set();

    root.querySelectorAll("table").forEach((t) => candidates.add(t));
    queryAllDeep(root, "table").forEach((t) => candidates.add(t));
    findTablesNearBundledSection(root).forEach((t) => candidates.add(t));

    root.querySelectorAll('[role="grid"], [role="table"]').forEach((t) => candidates.add(t));
    queryAllDeep(root, '[role="grid"]').forEach((t) => candidates.add(t));
    queryAllDeep(root, '[role="table"]').forEach((t) => {
      if (t.tagName !== "TABLE") candidates.add(t);
    });

    const seen = new Set();
    /** @type {CardLine[]} */
    const lines = [];

    candidates.forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);

      const recipient = guessRecipientNearTable(el, knownRecipients);

      if (el.tagName === "TABLE") {
        const table = /** @type {HTMLTableElement} */ (el);
        let col = null;
        /** @type {HTMLTableRowElement | null} */
        let headerTr = null;

        const headerCells = getHeaderCells(table);
        if (headerCells) {
          const normTexts = headerCells.map((c) => normHeader(cellText(c)));
          if (isBundledItemsTable(normTexts) && !isMainOrdersTableHeader(normTexts)) {
            col = mapBundledColumnIndices(normTexts);
            const theadRow = table.querySelector("thead tr");
            if (theadRow && headerCells[0] && theadRow.contains(headerCells[0])) {
              headerTr = /** @type {HTMLTableRowElement} */ (theadRow);
            }
          }
        }

        if (!col || col.price < 0) {
          const scanned = scanTableForBundledHeader(table);
          if (scanned) {
            col = scanned.col;
            headerTr = scanned.headerTr;
          }
        }

        if (col && col.price >= 0) {
          lines.push(...extractBundledCardLinesFromHtmlTable(table, col, recipient, headerTr));
        }
        return;
      }

      const role = el.getAttribute("role");
      if (role === "grid" || role === "table") {
        lines.push(...extractBundledCardLinesFromAriaGrid(el, recipient));
      }
    });

    return lines;
  }

  /**
   * @param {Element} tableLike
   * @returns {Element[] | null}
   */
  function getHeaderCells(tableLike) {
    if (tableLike.tagName === "TABLE") {
      const thead = tableLike.querySelector("thead tr");
      if (thead) {
        const cells = thead.querySelectorAll("th, td");
        if (cells.length) return Array.from(cells);
      }
      const first = tableLike.querySelector("tr");
      if (first) {
        const cells = first.querySelectorAll("th, td");
        if (cells.length) return Array.from(cells);
      }
      return null;
    }

    const headerRow =
      tableLike.querySelector('[role="row"] [role="columnheader"]')?.closest('[role="row"]') ||
      tableLike.querySelector('[role="row"]');
    if (!headerRow) return null;
    const cells = headerRow.querySelectorAll('[role="columnheader"], [role="gridcell"], th, td');
    if (cells.length) return Array.from(cells);
    return null;
  }

  /**
   * @param {HTMLTableElement} table
   * @param {Record<string, number>} col
   * @returns {OrderRow[]}
   */
  function extractBodyRowsTable(table, col) {
    /** @type {OrderRow[]} */
    const rows = [];
    /** @type {NodeListOf<HTMLTableRowElement> | HTMLTableRowElement[]} */
    let dataRows;
    const tbody = table.querySelector("tbody");
    if (tbody) {
      dataRows = tbody.querySelectorAll("tr");
    } else {
      const all = Array.from(table.querySelectorAll("tr"));
      const drop = table.querySelector("thead") ? 0 : 1;
      dataRows = all.slice(drop);
    }

    for (let i = 0; i < dataRows.length; i++) {
      const tr = dataRows[i];
      if (tr.closest("thead")) continue;
      const cells = tr.querySelectorAll("td");
      if (!cells.length) continue;
      const row = rowFromCells(Array.from(cells), col);
      if (row) rows.push(row);
    }
    return rows;
  }

  /**
   * @param {Element} tableLike
   * @param {Record<string, number>} col
   * @returns {OrderRow[]}
   */
  function extractBodyRows(tableLike, col) {
    /** @type {OrderRow[]} */
    const rows = [];

    if (tableLike.tagName === "TABLE") {
      return extractBodyRowsTable(/** @type {HTMLTableElement} */ (tableLike), col);
    }

    const dataRows = tableLike.querySelectorAll('[role="row"]');
    let headerSeen = false;
    for (const row of dataRows) {
      const hasHeader = row.querySelector('[role="columnheader"]');
      if (hasHeader) {
        headerSeen = true;
        continue;
      }
      if (!headerSeen) continue;
      const cells = row.querySelectorAll('[role="gridcell"], [role="cell"], td');
      if (!cells.length) continue;
      const r = rowFromCells(Array.from(cells), col);
      if (r) rows.push(r);
    }
    return rows;
  }

  /**
   * @param {Element[]} cells
   * @param {Record<string, number>} col
   * @returns {OrderRow | null}
   */
  function rowFromCells(cells, col) {
    const get = (key) => {
      const i = col[key];
      if (i < 0 || i >= cells.length) return "";
      return cellText(cells[i]);
    };

    const valueRaw = get("value");
    const itemsRaw = get("items");
    const value = parseMoney(valueRaw);
    const items = parseItems(itemsRaw);

    const recipient = get("recipient");
    const status = get("status");

    if (!recipient && !valueRaw && !status) return null;

    return {
      recipient,
      orderDate: get("orderDate"),
      items,
      value,
      valueRaw,
      weight: get("weight"),
      dimensions: get("dimensions"),
      requirements: get("requirements"),
      status,
      tracking: get("tracking"),
    };
  }

  /**
   * @param {Element} tableLike
   * @returns {{ rows: OrderRow[]; score: number } | null}
   */
  function tryTable(tableLike) {
    const headerCells = getHeaderCells(tableLike);
    if (!headerCells || headerCells.length < 3) return null;

    const headers = headerCells.map((c) => cellText(c));
    const col = mapHeaderIndices(headers);
    let score = 0;
    if (col.recipient >= 0) score += 2;
    if (col.value >= 0) score += 2;
    if (col.items >= 0) score += 1;
    if (col.status >= 0) score += 1;
    if (col.orderDate >= 0) score += 1;

    if (score < 3) return null;

    const rows = extractBodyRows(tableLike, col);
    return { rows, score };
  }

  function scrapeOrdersTable() {
    const root = document.body || document.documentElement;

    /** @type {Element[]} */
    const candidates = [];
    candidates.push(...root.querySelectorAll("table"));
    candidates.push(...root.querySelectorAll('[role="table"], [role="grid"]'));
    candidates.push(...queryAllDeep(root, '[role="table"], [role="grid"]'));

    const seen = new Set();
    let best = null;
    let bestScore = -1;

    for (const el of candidates) {
      if (seen.has(el)) continue;
      seen.add(el);
      const res = tryTable(el);
      if (!res || res.rows.length === 0) continue;
      if (res.score > bestScore || (res.score === bestScore && res.rows.length > (best?.rows.length || 0))) {
        best = res;
        bestScore = res.score;
      }
    }

    if (!best || best.rows.length === 0) {
      return {
        ok: false,
        error: "No order table found on this page. Open your seller orders/shipping view and try again.",
        rows: [],
        cardLines: [],
      };
    }

    const knownRecipients = best.rows.map((r) => r.recipient).filter(Boolean);
    const cardLines = scrapeBundledCardLines(root, knownRecipients);

    return { ok: true, rows: best.rows, cardLines };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "SCRAPE_ORDERS") return;

    (async () => {
      try {
        const root = document.body || document.documentElement;
        let expandClickCount = 0;
        if (message?.skipExpand !== true) {
          expandClickCount = await autoExpandBundleRows(root);
          await sleep(650);
        }
        const result = scrapeOrdersTable();
        sendResponse({ ...result, expandClickCount });
      } catch (e) {
        sendResponse({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          rows: [],
          cardLines: [],
          expandClickCount: 0,
        });
      }
    })();

    return true;
  });
})();
