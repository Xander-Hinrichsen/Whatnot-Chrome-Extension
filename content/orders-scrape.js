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
   * @typedef {{ listingRaw: string; saleTypeRaw: string; unitPrice: number; qty: number; recipient: string }} BundledRawRow
   * @typedef {{ cardNum: number | null; showName: string; owner: string; value: number; saleType: string; listingRaw: string }} SoldCard
   * @typedef {{ id: string; uniqueId: string; cardNum: number | null; showName: string; owner: string; listingRaw: string }} GiveawayCard
   */

  /** @param {string} s */
  function listingFirstLine(s) {
    return (s || "").split("\n")[0].replace(/\s+/g, " ").trim();
  }

  /**
   * Card # is the #123 in the listing title (e.g. MAGS #8), not Whatnot "Order #953604324".
   * @param {string} listingText
   * @returns {{ showName: string; cardNum: number | null }}
   */
  function parseListingForCardNum(listingText) {
    const raw = (listingText || "").replace(/\s+/g, " ").trim();
    const firstLine = raw.split("\n")[0].trim() || raw;
    const re = /#(\d+)/g;
    let cardNum = null;
    let showName = firstLine;
    let m;
    while ((m = re.exec(firstLine)) !== null) {
      const num = parseInt(m[1], 10);
      if (!Number.isFinite(num)) continue;
      const before = firstLine.slice(0, m.index).trim();
      if (/order\s*$/i.test(before)) continue;
      if (num >= 1000000) continue;
      cardNum = num;
      showName = before.trim();
      break;
    }
    if (cardNum == null) {
      const tail = firstLine.match(/#\s*(\d+)\s*$/);
      if (tail) {
        const num = parseInt(tail[1], 10);
        if (Number.isFinite(num) && num < 1000000) {
          cardNum = num;
          showName = firstLine.slice(0, tail.index).trim();
        }
      }
    }
    showName = showName.replace(/\s+Order\s*$/i, "").trim();
    return { showName, cardNum };
  }

  /** Bundled row whose cells merged into one blob (header + rows). */
  function isBundledGarbageRow(listingRaw, saleTypeRaw) {
    const blob = ((listingRaw || "") + " " + (saleTypeRaw || "")).toLowerCase();
    if (blob.includes("listing qty price") || blob.includes("item listing qty")) return true;
    if (blob.includes("items (bundled)") && blob.includes("listing qty")) return true;
    if ((saleTypeRaw || "").length > 100) return true;
    if ((listingRaw || "").length > 800) return true;
    return false;
  }

  /** @param {string} t */
  function looksLikeAccountName(t) {
    const s = (t || "").replace(/\s+/g, " ").trim();
    if (s.length < 2) return false;
    if (/^\$/.test(s)) return false;
    if (/^\d+(\.\d+)?$/.test(s)) return false;
    if (/^\d{1,4}$/.test(s)) return false;
    return /[a-zA-Z]/.test(s);
  }

  /**
   * @param {Element[]} cells
   * @param {Record<string, number>} col
   * @param {OrderRow} row
   */
  function refineRecipientFromMainRow(cells, col, row) {
    let r = (row.recipient || "").trim();
    if (looksLikeAccountName(r)) return row;

    const skip = new Set();
    ["value", "items", "orderDate", "tracking", "status", "weight", "dimensions", "requirements"]
      .forEach((k) => {
        const i = col[k];
        if (i >= 0) skip.add(i);
      });

    let best = "";
    for (let i = 0; i < cells.length; i++) {
      if (skip.has(i)) continue;
      const t = cellText(cells[i]);
      if (t.length > best.length && looksLikeAccountName(t)) best = t;
    }
    if (best) return { ...row, recipient: best };
    return row;
  }

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
    const maxRounds = 6;
    const maxClicksPerRound = 64;
    const pauseClick = 8;
    const pauseRound = 180;
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

  /** @param {string} s */
  function isGiveawaySaleType(s) {
    return (s || "").trim().toLowerCase().includes("giveaway");
  }

  /**
   * @param {BundledRawRow[]} rawRows
   * @returns {{ soldCards: SoldCard[]; giveawayCards: GiveawayCard[]; cardLines: CardLine[] }}
   */
  function buildCatalogFromBundled(rawRows) {
    const seen = new Set();
    /** @type {SoldCard[]} */
    const soldCards = [];
    /** @type {GiveawayCard[]} */
    const giveawayCards = [];
    let seq = 0;

    for (let r = 0; r < rawRows.length; r++) {
      const row = rawRows[r];
      const listLine = listingFirstLine(row.listingRaw);
      const saleNorm = listingFirstLine(row.saleTypeRaw);
      const key = `${listLine}|${saleNorm}|${row.unitPrice}|${row.qty}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const { showName, cardNum } = parseListingForCardNum(listLine);
      const give = isGiveawaySaleType(row.saleTypeRaw);
      const q = Math.min(Math.max(1, row.qty | 0), 500);

      for (let u = 0; u < q; u++) {
        seq++;
        if (give) {
          const gid = cardNum != null ? `g${cardNum}` : "gna";
          giveawayCards.push({
            id: gid,
            uniqueId: `${gid}-${row.recipient}-${seq}`,
            cardNum,
            showName,
            owner: row.recipient,
            listingRaw: listLine,
          });
        } else {
          soldCards.push({
            cardNum,
            showName,
            owner: row.recipient,
            value: row.unitPrice,
            saleType: saleNorm,
            listingRaw: listLine,
          });
        }
      }
    }

    /** @type {CardLine[]} */
    const cardLines = soldCards.map((c) => ({
      unitPrice: c.value,
      qty: 1,
      recipient: c.owner,
    }));

    return { soldCards, giveawayCards, cardLines };
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
      ["recipient", ["recipient", "buyer", "account", "customer"]],
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
   * @returns {{ price: number; qty: number; listing: number; saleType: number }}
   */
  function mapBundledColumnIndices(normTexts) {
    let price = -1;
    let qty = -1;
    let listing = -1;
    let saleType = -1;
    for (let i = 0; i < normTexts.length; i++) {
      const t = normTexts[i];
      if (price < 0 && (t === "price" || t.startsWith("price "))) price = i;
      if (qty < 0 && (t === "qty" || t === "quantity")) qty = i;
      if (listing < 0 && (t === "listing" || t.startsWith("listing "))) listing = i;
      if (saleType < 0 && t.includes("sale") && t.includes("type")) saleType = i;
    }
    return { price, qty, listing, saleType };
  }

  /**
   * First table row may be a title; scan a few rows for a real header.
   * @param {HTMLTableElement} table
   * @returns {{ col: { price: number; qty: number; listing: number; saleType: number }; headerTr: HTMLTableRowElement | null } | null}
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
   * @param {{ price: number; qty: number; listing: number; saleType: number }} col
   * @param {string} recipient
   * @param {HTMLTableRowElement | null} headerTr
   * @returns {BundledRawRow[]}
   */
  function extractBundledRowsFromHtmlTable(table, col, recipient, headerTr) {
    /** @type {BundledRawRow[]} */
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

      let listingRaw = "";
      if (col.listing >= 0 && col.listing < arr.length) {
        listingRaw = cellText(arr[col.listing]);
      } else if (arr[0]) {
        listingRaw = cellText(arr[0]);
      }
      const saleTypeRaw =
        col.saleType >= 0 && col.saleType < arr.length
          ? cellText(arr[col.saleType])
          : "";

      if (isBundledGarbageRow(listingRaw, saleTypeRaw)) continue;

      out.push({ listingRaw, saleTypeRaw, unitPrice: price, qty: q, recipient });
    }
    return out;
  }

  /**
   * @param {Element} gridLike
   * @param {string} recipient
   * @returns {BundledRawRow[]}
   */
  function extractBundledRowsFromAriaGrid(gridLike, recipient) {
    /** @type {BundledRawRow[]} */
    const out = [];
    const rows = gridLike.querySelectorAll('[role="row"]');
    /** @type {{ price: number; qty: number; listing: number; saleType: number } | null} */
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

      let listingRaw = "";
      if (col.listing >= 0 && col.listing < arr.length) {
        listingRaw = cellText(arr[col.listing]);
      } else if (arr[0]) {
        listingRaw = cellText(arr[0]);
      }
      const saleTypeRaw =
        col.saleType >= 0 && col.saleType < arr.length
          ? cellText(arr[col.saleType])
          : "";

      if (isBundledGarbageRow(listingRaw, saleTypeRaw)) continue;

      out.push({ listingRaw, saleTypeRaw, unitPrice: price, qty: q, recipient });
    }
    return out;
  }

  /**
   * Expanded line-items typically mount inside the row or one detail sibling.
   * @param {Element} tr
   */
  function orderRowBundledRoots(tr) {
    /** @type {Element[]} */
    const roots = [tr];
    let sib = tr.nextElementSibling;
    let steps = 0;
    while (sib && steps < 2) {
      const preview = ((sib.textContent || "").slice(0, 360) || "").toLowerCase();
      const hasLineItems =
        !!sib.querySelector("table, [role='grid'], [role='table']") ||
        /bundled|listing\s+qty|sale\s*type|video\s*receipt/.test(preview);
      if (!hasLineItems) break;
      roots.push(sib);
      sib = sib.nextElementSibling;
      steps++;
    }
    return roots;
  }

  /**
   * @param {Element} el
   * @param {string} recipient
   * @param {Element | null} mainTableEl
   * @returns {BundledRawRow[]}
   */
  function extractBundledRawFromElement(el, recipient, mainTableEl) {
    if (mainTableEl && el === mainTableEl) return [];
    if (el.tagName === "TABLE") {
      const t = /** @type {HTMLTableElement} */ (el);
      const hc = getHeaderCells(t);
      if (hc) {
        const normTexts = hc.map((c) => normHeader(cellText(c)));
        if (isMainOrdersTableHeader(normTexts)) return [];
      }
    }

    /** @type {BundledRawRow[]} */
    const raw = [];

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
        raw.push(...extractBundledRowsFromHtmlTable(table, col, recipient, headerTr));
      }
      return raw;
    }

    const role = el.getAttribute("role");
    if (role === "grid" || role === "table") {
      raw.push(...extractBundledRowsFromAriaGrid(el, recipient));
    }
    return raw;
  }

  /**
   * @param {Element} root
   * @param {{ row: OrderRow; tr: Element }[]} rowsWithTr
   * @param {Element | null} mainTableEl
   * @param {string[]} knownRecipients
   * @returns {{ cardLines: CardLine[]; soldCards: SoldCard[]; giveawayCards: GiveawayCard[] }}
   */
  function scrapeBundledCatalogFromOrderRows(root, rowsWithTr, mainTableEl, knownRecipients) {
    /** @type {BundledRawRow[]} */
    const raw = [];
    /** @type {Set<Element>} */
    const claimed = new Set();

    for (let i = 0; i < rowsWithTr.length; i++) {
      const { tr, row } = rowsWithTr[i];
      const recipient = (row.recipient || "").trim();
      const roots = orderRowBundledRoots(tr);
      /** @type {Set<Element>} */
      const candidates = new Set();
      for (let r = 0; r < roots.length; r++) {
        const sub = roots[r];
        sub.querySelectorAll("table").forEach((t) => candidates.add(t));
        queryAllDeep(sub, "table").forEach((t) => candidates.add(t));
        findTablesNearBundledSection(sub).forEach((t) => candidates.add(t));
        sub.querySelectorAll('[role="grid"], [role="table"]').forEach((t) => candidates.add(t));
        queryAllDeep(sub, '[role="grid"]').forEach((t) => candidates.add(t));
        queryAllDeep(sub, '[role="table"]').forEach((t) => {
          if (t.tagName !== "TABLE") candidates.add(t);
        });
      }
      candidates.forEach((el) => {
        if (claimed.has(el)) return;
        claimed.add(el);
        raw.push(...extractBundledRawFromElement(el, recipient, mainTableEl));
      });
    }

    if (raw.length === 0) {
      return scrapeBundledCatalogGlobal(root, knownRecipients, mainTableEl);
    }
    return buildCatalogFromBundled(raw);
  }

  /**
   * @param {Element} root
   * @param {string[]} knownRecipients
   * @param {Element | null} mainTableEl
   * @returns {{ cardLines: CardLine[]; soldCards: SoldCard[]; giveawayCards: GiveawayCard[] }}
   */
  function scrapeBundledCatalogGlobal(root, knownRecipients, mainTableEl) {
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
    /** @type {BundledRawRow[]} */
    const raw = [];

    candidates.forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      const recipient = guessRecipientNearTable(el, knownRecipients);
      raw.push(...extractBundledRawFromElement(el, recipient, mainTableEl));
    });

    return buildCatalogFromBundled(raw);
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
   * @param {HTMLTableElement} table
   * @param {Record<string, number>} col
   * @returns {{ row: OrderRow; tr: HTMLTableRowElement }[]}
   */
  function extractBodyRowsTableWithTr(table, col) {
    /** @type {{ row: OrderRow; tr: HTMLTableRowElement }[]} */
    const out = [];
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
      const arr = Array.from(cells);
      let row = rowFromCells(arr, col);
      if (!row) continue;
      row = refineRecipientFromMainRow(arr, col, row);
      out.push({ row, tr });
    }
    return out;
  }

  /**
   * @param {Element} tableLike
   * @param {Record<string, number>} col
   * @returns {{ row: OrderRow; tr: Element }[]}
   */
  function extractBodyRowsGridWithTr(tableLike, col) {
    /** @type {{ row: OrderRow; tr: Element }[]} */
    const out = [];
    const dataRows = tableLike.querySelectorAll('[role="row"]');
    let headerSeen = false;
    for (const rowEl of dataRows) {
      const hasHeader = rowEl.querySelector('[role="columnheader"]');
      if (hasHeader) {
        headerSeen = true;
        continue;
      }
      if (!headerSeen) continue;
      const cells = rowEl.querySelectorAll('[role="gridcell"], [role="cell"], td');
      if (!cells.length) continue;
      const arr = Array.from(cells);
      let row = rowFromCells(arr, col);
      if (!row) continue;
      row = refineRecipientFromMainRow(arr, col, row);
      out.push({ row, tr: rowEl });
    }
    return out;
  }

  /**
   * @param {Element} tableLike
   * @param {Record<string, number>} col
   * @returns {{ row: OrderRow; tr: Element }[]}
   */
  function extractBodyRowsWithTrs(tableLike, col) {
    if (tableLike.tagName === "TABLE") {
      return extractBodyRowsTableWithTr(/** @type {HTMLTableElement} */ (tableLike), col);
    }
    return extractBodyRowsGridWithTr(tableLike, col);
  }

  /**
   * @param {Element} tableLike
   * @returns {{ tableLike: Element; rows: OrderRow[]; rowsWithTr: { row: OrderRow; tr: Element }[]; score: number } | null}
   */
  function tryTableWithTrs(tableLike) {
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

    const rowsWithTr = extractBodyRowsWithTrs(tableLike, col);
    if (rowsWithTr.length === 0) return null;
    const rows = rowsWithTr.map((x) => x.row);
    return { tableLike, rows, rowsWithTr, score };
  }

  function scrapeOrdersTablePage() {
    const root = document.body || document.documentElement;

    /** @type {Element[]} */
    const candidates = [];
    candidates.push(...root.querySelectorAll("table"));
    candidates.push(...root.querySelectorAll('[role="table"], [role="grid"]'));
    candidates.push(...queryAllDeep(root, '[role="table"], [role="grid"]'));

    const seen = new Set();
    /** @type {{ tableLike: Element; rows: OrderRow[]; rowsWithTr: { row: OrderRow; tr: Element }[]; score: number } | null} */
    let best = null;
    let bestScore = -1;

    for (const el of candidates) {
      if (seen.has(el)) continue;
      seen.add(el);
      const res = tryTableWithTrs(el);
      if (!res || res.rowsWithTr.length === 0) continue;
      if (
        res.score > bestScore ||
        (res.score === bestScore && res.rowsWithTr.length > (best?.rowsWithTr.length || 0))
      ) {
        best = res;
        bestScore = res.score;
      }
    }

    if (!best || best.rowsWithTr.length === 0) {
      return {
        ok: false,
        error: "No order table found on this page. Open your seller orders/shipping view and try again.",
        rows: [],
        cardLines: [],
        soldCards: [],
        giveawayCards: [],
      };
    }

    const knownRecipients = best.rows.map((r) => r.recipient).filter(Boolean);
    const bundled = scrapeBundledCatalogFromOrderRows(
      root,
      best.rowsWithTr,
      best.tableLike,
      knownRecipients
    );

    return {
      ok: true,
      rows: best.rows,
      cardLines: bundled.cardLines,
      soldCards: bundled.soldCards,
      giveawayCards: bundled.giveawayCards,
      _tableLike: best.tableLike,
    };
  }

  /**
   * @param {Element} root
   * @returns {{ from: number; to: number; total: number; key: string } | null}
   */
  function getPaginationState(root) {
    const re = /\bshowing\s+(\d+)\s*(?:-|–|—|to)\s*(\d+)\s+of\s+(\d+)\b/i;
    const nodes = queryAllDeep(root, "div, span, p, small, td, li");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      const m = t.match(re);
      if (!m) continue;
      const from = parseInt(m[1], 10);
      const to = parseInt(m[2], 10);
      const total = parseInt(m[3], 10);
      if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(total)) continue;
      if (from <= 0 || to <= 0 || total <= 0) continue;
      return { from, to, total, key: `${from}-${to}-${total}` };
    }
    const pageText = (root.textContent || "").replace(/\s+/g, " ").trim();
    const mm = pageText.match(re);
    if (mm) {
      const from = parseInt(mm[1], 10);
      const to = parseInt(mm[2], 10);
      const total = parseInt(mm[3], 10);
      if (Number.isFinite(from) && Number.isFinite(to) && Number.isFinite(total)) {
        if (from > 0 && to > 0 && total > 0) {
          return { from, to, total, key: `${from}-${to}-${total}` };
        }
      }
    }
    return null;
  }

  /** @param {HTMLElement} el */
  function controlLabel(el) {
    return (
      (el.getAttribute("aria-label") || "") +
      " " +
      (el.getAttribute("data-testid") || "") +
      " " +
      (el.getAttribute("title") || "") +
      " " +
      (el.textContent || "")
    )
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  /** @param {string} label */
  function isForbiddenActionLabel(label) {
    return (
      label.includes("open dropdown") ||
      label.includes("seller hub navigation") ||
      label.includes("shipping label") ||
      label.includes("mailing label") ||
      label.includes("packing slip") ||
      label.includes("sticker") ||
      label.includes("print") ||
      label.includes("pdf") ||
      label.includes("invoice")
    );
  }

  /**
   * Prefer paginator arrows whose SVG has explicit aria-label (e.g. "Next page").
   * @param {Element} root
   */
  function findExplicitNextPageButton(root) {
    const icons = queryAllDeep(root, "svg[aria-label]");
    for (let i = 0; i < icons.length; i++) {
      const icon = icons[i];
      const al = (icon.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!al) continue;
      if (!al.includes("next page") && !al.includes("next")) continue;
      if (al.includes("open dropdown")) continue;

      let el = /** @type {Element | null} */ (icon);
      while (el && !(el.matches?.('button, [role="button"], a'))) el = el.parentElement;
      if (!(el instanceof HTMLElement)) continue;
      if (el.offsetParent === null) continue;
      if (el.hasAttribute("disabled")) continue;
      if ((el.getAttribute("aria-disabled") || "").toLowerCase() === "true") continue;
      const label = controlLabel(el);
      if (isForbiddenActionLabel(label)) continue;
      return el;
    }
    return null;
  }

  /**
   * @param {Element} root
   * @param {Element | null} tableLike
   * @returns {HTMLElement[]}
   */
  function findNextPageCandidatesNearTable(root, tableLike) {
    if (!tableLike || !(tableLike instanceof HTMLElement)) return [];
    const tableRect = tableLike.getBoundingClientRect();
    if (!tableRect || tableRect.width <= 0 || tableRect.height <= 0) return [];

    const nodes = queryAllDeep(root, 'button, [role="button"]');
    /** @type {HTMLElement[]} */
    const candidates = [];
    const seen = new Set();
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!(el instanceof HTMLElement)) continue;
      if (seen.has(el)) continue;
      seen.add(el);
      if (el.offsetParent === null) continue;
      if (el.hasAttribute("disabled")) continue;
      if ((el.getAttribute("aria-disabled") || "").toLowerCase() === "true") continue;

      const label = controlLabel(el);
      if (isForbiddenActionLabel(label)) continue;
      if (label.includes("prev") || label.includes("previous") || label.includes("back")) continue;

      const r = el.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) continue;
      // Strictly below table body so we don't click row action icons.
      const nearBottomBand = r.top >= tableRect.bottom + 6 && r.top <= tableRect.bottom + 260;
      const rightSide = r.left >= tableRect.left + tableRect.width * 0.65;
      const compact = r.width <= 70 && r.height <= 70;
      const iconLike = !!el.querySelector("svg, [data-icon]");
      if (!nearBottomBand || !rightSide) continue;
      if (!compact && !iconLike) continue;

      candidates.push(el);
    }
    if (candidates.length < 2) return candidates;

    // Look for a row that has at least 2 compact controls (prev/next pair),
    // then prefer the right-most control from that row (usually "next").
    /** @type {Map<number, HTMLElement[]>} */
    const byRow = new Map();
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      const y = Math.round(el.getBoundingClientRect().top / 6) * 6;
      const arr = byRow.get(y) || [];
      arr.push(el);
      byRow.set(y, arr);
    }

    /** @type {HTMLElement[] | null} */
    let bestRow = null;
    let bestScore = -1;
    byRow.forEach((arr, y) => {
      if (arr.length < 2) return;
      const score = arr.length * 100 - y; // prefer more controls and lower on page
      if (score > bestScore) {
        bestScore = score;
        bestRow = arr;
      }
    });
    if (bestRow && bestRow.length) {
      bestRow.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
      return bestRow;
    }

    candidates.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
    return candidates;
  }

  /**
   * @param {OrderRow[]} rows
   */
  function rowsSignature(rows) {
    if (!rows || !rows.length) return "";
    const cap = Math.min(rows.length, 5);
    const parts = [];
    for (let i = 0; i < cap; i++) {
      const r = rows[i];
      parts.push(`${r.recipient}|${r.orderDate}|${r.valueRaw}|${r.status}|${r.tracking}`);
    }
    return parts.join("||");
  }

  /**
   * Lightweight signature from currently visible table rows.
   * @param {Element | null} tableLike
   */
  function quickTableSignature(tableLike) {
    if (!tableLike) return "";
    /** @type {string[]} */
    const parts = [];
    if (tableLike.tagName === "TABLE") {
      const rows = tableLike.querySelectorAll("tbody tr, tr");
      for (let i = 0; i < rows.length && parts.length < 5; i++) {
        const tr = rows[i];
        if (tr.closest("thead")) continue;
        const t = (tr.textContent || "").replace(/\s+/g, " ").trim();
        if (!t) continue;
        parts.push(t);
      }
      return parts.join("||");
    }
    const rows = tableLike.querySelectorAll('[role="row"]');
    for (let i = 0; i < rows.length && parts.length < 5; i++) {
      const row = rows[i];
      if (row.querySelector('[role="columnheader"]')) continue;
      const t = (row.textContent || "").replace(/\s+/g, " ").trim();
      if (!t) continue;
      parts.push(t);
    }
    return parts.join("||");
  }

  /**
   * @param {Element} root
   * @param {{ from: number; to: number; total: number; key: string } | null} before
   * @param {string} beforeSig
   * @param {Element | null} tableLike
   */
  async function goToNextPage(root, before, beforeSig, tableLike) {
    if (before && before.to >= before.total) return false;

    /** @type {HTMLElement[]} */
    const toTry = [];
    const explicit = findExplicitNextPageButton(root);
    if (explicit) toTry.push(explicit);
    const nearTable = findNextPageCandidatesNearTable(root, tableLike);
    for (let i = 0; i < nearTable.length; i++) {
      if (!toTry.includes(nearTable[i])) toTry.push(nearTable[i]);
    }
    if (!toTry.length) return false;

    for (let i = 0; i < toTry.length; i++) {
      const btn = toTry[i];
      try {
        btn.click();
      } catch (_) {
        continue;
      }

      const startSig = quickTableSignature(tableLike);
      const start = Date.now();
      while (Date.now() - start < 2600) {
        await sleep(160);
        const now = getPaginationState(root);
        if (before && now && now.key !== before.key) return true;
        const liveSig = quickTableSignature(tableLike);
        if (startSig && liveSig && liveSig !== startSig) return true;
        if (!before && beforeSig && liveSig && liveSig !== beforeSig) return true;
      }
    }
    return false;
  }

  /**
   * @param {OrderRow[]} rows
   */
  function dedupeOrderRows(rows) {
    const seen = new Set();
    /** @type {OrderRow[]} */
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const key = `${r.recipient}|${r.orderDate}|${r.valueRaw}|${r.status}|${r.tracking}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    return out;
  }

  /** @param {any[]} arr */
  function sortByCardNum(arr) {
    arr.sort((a, b) => {
      const na = a.cardNum;
      const nb = b.cardNum;
      if (na == null && nb == null) return (a.listingRaw || "").localeCompare(b.listingRaw || "");
      if (na == null) return 1;
      if (nb == null) return -1;
      if (na !== nb) return na - nb;
      return (a.owner || "").localeCompare(b.owner || "");
    });
  }

  /**
   * @param {Element} root
   * @param {boolean} doExpand
   */
  async function scrapeAllOrderPages(root, doExpand) {
    /** @type {OrderRow[]} */
    const allRows = [];
    /** @type {any[]} */
    const allSold = [];
    /** @type {any[]} */
    const allGw = [];
    let totalExpandClicks = 0;
    const seenRowSigs = new Set();

    for (let page = 0; page < 30; page++) {
      if (doExpand) {
        totalExpandClicks += await autoExpandBundleRows(root);
        await sleep(450);
      }

      const res = scrapeOrdersTablePage();
      if (!res.ok) {
        if (page === 0) return { ...res, expandClickCount: totalExpandClicks };
        break;
      }
      const pageSig = rowsSignature(res.rows || []);
      if (pageSig && seenRowSigs.has(pageSig)) break;
      if (pageSig) seenRowSigs.add(pageSig);
      allRows.push(...(res.rows || []));
      allSold.push(...(res.soldCards || []));
      allGw.push(...(res.giveawayCards || []));

      const pg = getPaginationState(root);
      const moved = await goToNextPage(
        root,
        pg,
        pageSig,
        /** @type {Element | null} */ (res._tableLike || null)
      );
      if (!moved) break;
      await sleep(650);
    }

    const soldSeen = new Set();
    const soldCards = allSold.filter((c) => {
      const key = `${c.cardNum}|${c.showName}|${c.owner}|${c.value}|${c.saleType}|${c.listingRaw}`;
      if (soldSeen.has(key)) return false;
      soldSeen.add(key);
      return true;
    });

    const gwSeen = new Set();
    const giveawayCards = allGw.filter((c) => {
      const key = `${c.id}|${c.owner}|${c.listingRaw}`;
      if (gwSeen.has(key)) return false;
      gwSeen.add(key);
      return true;
    });

    sortByCardNum(soldCards);
    sortByCardNum(giveawayCards);

    const cardLines = soldCards.map((c) => ({
      unitPrice: Number(c.value) || 0,
      qty: 1,
      recipient: c.owner || "",
    }));

    return {
      ok: true,
      rows: dedupeOrderRows(allRows),
      cardLines,
      soldCards,
      giveawayCards,
      expandClickCount: totalExpandClicks,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "SCRAPE_ORDERS") return;

    (async () => {
      try {
        const root = document.body || document.documentElement;
        const result = await scrapeAllOrderPages(root, message?.skipExpand !== true);
        sendResponse(result);
      } catch (e) {
        sendResponse({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          rows: [],
          cardLines: [],
          soldCards: [],
          giveawayCards: [],
          expandClickCount: 0,
        });
      }
    })();

    return true;
  });
})();
