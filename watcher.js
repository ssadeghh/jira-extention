(() => {
  "use strict";

  const DEBUG = true;

  let REFRESH_MS = 0;
  let BG_RELOAD_WATCHDOG_MS = 0;  
  let MESSAGE_HEADER = "incident جدید اضافه شد";

  const PATH_REGEX = /^\/secure\/Dashboard\.jspa$/;

  const TABLE_BODY_SELECTOR = "table.issue-table > tbody";
  const TOTAL_LINK_SELECTOR = "#total-tickets";

  const ALLOWED_GADGET_IDS = new Set(["40027"]);

  const MIN_DUPLICATE_NOTIFY_GAP_MS = 5000;

  const USE_TOTAL_DELTA_FALLBACK = true;

  const TTL_MS = 2 * 60 * 1000;

  const STORAGE_KEY_PREFIX = "jira:gadget:tbody:seen:";
  const STORAGE_TOTAL_SUFFIX = ":total";
  const STORAGE_TTL_SUFFIX = ":ttl";
  const STORAGE_SCOPE = location.origin + location.pathname;

  const state = (window.__jiraWatcher = window.__jiraWatcher || {
    version: "dynamic-1.2",
    idPart: null,
    baseline: new Set(),     
    lastNow: new Set(),       
    lastNew: [],              
    lastTotal: null,
    history: [],
    maxHistory: 300,
    lastEvalTs: 0,            
  });

  function ts() {
    const d = new Date();
    return d.toISOString().split("T")[1].replace("Z", "");
  }
  function log(...args) {
    if (!DEBUG) return;
    console.log("%c[watcher " + ts() + "]", "color:#0aa", ...args);
  }
  function group(label, cb) {
    if (!DEBUG) return cb();
    console.groupCollapsed("%c[watcher " + ts() + "] " + label, "color:#0aa");
    try { cb(); } finally { console.groupEnd(); }
  }
  function record(type, info = {}) {
    const entry = { ts: Date.now(), type, info };
    state.history.push(entry);
    if (state.history.length > state.maxHistory) state.history.shift();
    if (DEBUG) log(type, info);
  }

  function getSlaFromPayload(tr) {
    const root = tr.querySelector('td.customfield_10303 .sd-sla-field-customfield-root');
    const s = root?.getAttribute('data-payload');
    if (!s) return "";
    try {
      const payload = JSON.parse(s);
      const gv = payload?.goalView || {};
      return gv.remainingTimeHumanReadable || gv.remainingTimeLong || gv.goalTimeHumanReadable || "";
    } catch {
      return "";
    }
  }


  window.JIRA_WATCHER_LOGS = () => {
    group("HISTORY", () => console.table(state.history.map(h => ({
      time: new Date(h.ts).toLocaleTimeString(),
      type: h.type,
      info: JSON.stringify(h.info)
    }))));
    return state.history;
  };
  window.JIRA_WATCHER_BASELINE = () => {
    group("BASELINE_KEYS", () => console.table(Array.from(state.baseline).map(k => ({ key: k }))));
    return Array.from(state.baseline);
  };
  window.JIRA_WATCHER_RESET = () => {
    if (!state.idPart) return;
    localStorage.removeItem(storageKey(state.idPart));
    localStorage.removeItem(totalKey(state.idPart));
    localStorage.removeItem(ttlKey(state.idPart));
    state.baseline = new Set();
    record("RESET", { idPart: state.idPart });
    log("✅ baseline & total & TTL cleared for", state.idPart);
  };
  window.JIRA_WATCHER_EVAL = () => {
    record("MANUAL_EVAL");
    evaluateNow(true);
  };

  function storageKey(idPart = "gadget-40027") {
    return `${STORAGE_KEY_PREFIX}${STORAGE_SCOPE}:${idPart}`;
  }
  function totalKey(idPart = "gadget-40027") {
    return `${STORAGE_KEY_PREFIX}${STORAGE_SCOPE}:${idPart}${STORAGE_TOTAL_SUFFIX}`;
  }
  function ttlKey(idPart = "gadget-40027") {
    return `${STORAGE_KEY_PREFIX}${STORAGE_SCOPE}:${idPart}${STORAGE_TTL_SUFFIX}`;
  }

  function loadBaseline(idPart) {
    try {
      const raw = localStorage.getItem(storageKey(idPart));
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  }
  function saveBaseline(idPart, set) {
    try {
      localStorage.setItem(storageKey(idPart), JSON.stringify(Array.from(set)));
      record("SAVE_BASELINE", { count: set.size });
    } catch (e) {
      record("SAVE_BASELINE_ERR", { e: String(e) });
    }
  }

  function loadTotal(idPart) {
    const val = parseInt(localStorage.getItem(totalKey(idPart) || ""), 10);
    return Number.isFinite(val) ? val : null;
  }
  function saveTotal(idPart, num) {
    try {
      if (Number.isFinite(num)) {
        localStorage.setItem(totalKey(idPart), String(num));
        record("SAVE_TOTAL", { num });
      }
    } catch (e) {
      record("SAVE_TOTAL_ERR", { e: String(e) });
    }
  }

  function loadTTLMap(idPart) {
    try {
      const raw = localStorage.getItem(ttlKey(idPart));
      const obj = raw ? JSON.parse(raw) : {};
      return typeof obj === "object" && obj ? obj : {};
    } catch { return {}; }
  }
  function saveTTLMap(idPart, obj) {
    try {
      localStorage.setItem(ttlKey(idPart), JSON.stringify(obj));
    } catch {}
  }

  function waitForSelector(selector, root = document, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const pick = () => root.querySelector(selector);
      const first = pick();
      if (first) return resolve(first);
      const obs = new MutationObserver(() => {
        const el = pick();
        if (el) { obs.disconnect(); resolve(el); }
      });
      obs.observe(root, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); reject(new Error("timeout " + selector)); }, timeoutMs);
    });
  }
  function parseTotal(container) {
    const el = container.querySelector(TOTAL_LINK_SELECTOR);
    if (!el) return null;
    const m = (el.textContent || "").match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  }
  function collectRowsInfo(tbody) {
    const map = new Map();
    tbody.querySelectorAll("tr.issuerow").forEach((tr) => {
      const key =
        tr.getAttribute("data-issuekey") ||
        tr.querySelector("td.issuekey a.issue-link")?.textContent?.trim() || "";
      if (!key) return;

      const summary = tr.querySelector("td.summary a.issue-link")?.textContent?.trim() || "";
      const status = tr.querySelector("td.status")?.innerText?.trim() || "";
      const pImg = tr.querySelector("td.priority img");
      const pText = (pImg?.getAttribute("alt") || pImg?.getAttribute("title") || "").trim();
      const reporter =
        tr.querySelector("td.reporter a.user-hover, td.reporter .user-hover")?.textContent?.trim() || "";

      const slaText =
        getSlaFromPayload(tr) ||
        tr.querySelector('td.customfield_10303 .sla-tag.js-tooltip > div')?.textContent?.trim() ||
        tr.querySelector('td.customfield_10303 .sla-tag div')?.textContent?.trim() ||
        tr.querySelector('td.customfield_10303 .sla-tag .js-tooltip div')?.textContent?.trim() ||
        tr.querySelector('td.customfield_10303 .sla-tag .js-tooltip')?.textContent?.trim() ||
        "";

      map.set(key, {
        key: key.trim(),
        summary,
        status,
        priorityText: pText,
        reporter,
        slaText
      });
    });
    return map;
  }
  function collectAllRowsInfo() {
    const aggregate = new Map();
    document.querySelectorAll(TABLE_BODY_SELECTOR).forEach((tbody) => {
      if (ALLOWED_GADGET_IDS.size) {
        const gadget = tbody.closest(".gadget");
        const dataId = gadget?.getAttribute("data-id");
        if (dataId && !ALLOWED_GADGET_IDS.has(dataId)) {
          record("SKIP_GADGET", { dataId });
          return;
        }
      }
      collectRowsInfo(tbody).forEach((info, key) => {
        if (!aggregate.has(key)) {
          aggregate.set(key, info);
        }
      });
    });
    return aggregate;
  }
  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  let lastNotifyText = "";
  let lastNotifyAt = 0;

  function notifySPlus(text) {
    if (
      typeof text === "string" &&
      text === lastNotifyText &&
      Date.now() - lastNotifyAt < MIN_DUPLICATE_NOTIFY_GAP_MS
    ) {
      record("NOTIFY_SPLUS_SUPPRESSED_DUP", { text });
      return;
    }

    lastNotifyText = text;
    lastNotifyAt = Date.now();
    try {
      record("NOTIFY_SPLUS_REQ", { text });
      chrome.runtime.sendMessage({ type: "TASK_ADDED", text }, (resp) => {
        record("NOTIFY_SPLUS_RESP", { resp });
      });
    } catch (e) {
      record("NOTIFY_SPLUS_ERR", { e: String(e) });
    }
  }

  function buildMessageForOne(issue) {
    const sev = (issue.priorityText || "").toLowerCase();
    let emoji = "🟢";
    const slaLower = (issue.slaText || "").toLowerCase();
    const mins = approximateMinutes(slaLower); 

    if (mins != null) {
      if (mins < 360) emoji = "🚨";            
      else if (mins < 10080) emoji = "⚠️";     
      else emoji = "🟢";
    }

    return [
      `${MESSAGE_HEADER}: ${issue.key}`,
      `Summary: ${issue.summary || "-"}`,
      `Status: ${issue.status || "-"}`,
      `severity: ${issue.priorityText || "-"}`,
      `reporter: ${issue.reporter || "-"}`,
      `SLA: ${issue.slaText || "-"} ${emoji}`
    ].join("\n");
  }

  function approximateMinutes(s) {
    if (!s) return null;
    let total = 0, any = false;
    const re = /(\d+)\s*(w|d|h|m)/gi;
    let m;
    while ((m = re.exec(s))) {
      const num = parseInt(m[1], 10);
      if (!Number.isFinite(num)) continue;
      any = true;
      switch (m[2].toLowerCase()) {
        case "w": total += num * 7 * 24 * 60; break;
        case "d": total += num * 24 * 60; break;
        case "h": total += num * 60; break;
        case "m": total += num; break;
      }
    }
    return any ? total : null;
  }

  let _tbodies = new Set();
  let _evaluateLock = false;

  function evaluateNow(manual = false) {
    if (_evaluateLock || !_tbodies.size) return;
    _evaluateLock = true;

    try {
      state.lastEvalTs = Date.now();

      const prevNow = new Set(state.lastNow || []);

      const nowMap = collectAllRowsInfo();
      const nowKeys = new Set(nowMap.keys());
      const newOnes = [];

      // حذف‌شده‌ها: کلیدهایی که قبلاً داشتیم ولی الان نیستند
      const removed = [];
      state.baseline.forEach((k) => { if (!nowKeys.has(k)) removed.push(k); });

      nowKeys.forEach((k) => {
        if (!state.baseline.has(k)) newOnes.push(k);
      });

      group(manual ? "EVALUATE (manual)" : "EVALUATE", () => {
        console.table({
          nowCount: nowKeys.size,
          baselineCount: state.baseline.size,
          newlyCount: newOnes.length,
          lastTotal: state.lastTotal
        });
        if (newOnes.length) console.table(newOnes.map(k => ({ newKey: k })));
      });

      let currentTotal = parseTotal(document);
      if (currentTotal != null) {
        record("TOTAL_READ", { currentTotal });

        // اگر اولین بار است
        if (state.lastTotal == null) {
          const persisted = loadTotal(state.idPart);
          state.lastTotal = persisted == null ? currentTotal : persisted;
          saveTotal(state.idPart, state.lastTotal);
        }

        // Fallback: اگر total بالا رفت ولی newOnes خالی است، از اختلاف نسبت به lastNow استفاده کن
        if (USE_TOTAL_DELTA_FALLBACK && newOnes.length === 0 && state.lastTotal != null && currentTotal > state.lastTotal) {
          const nowMap2 = collectAllRowsInfo();
          const nowKeys2 = new Set(nowMap2.keys());

          // کلیدهایی که الان هست ولی در ارزیابی قبلی نبود
          const maybeNew = [];
          nowKeys2.forEach(k => { if (!prevNow.has(k)) maybeNew.push(k); });

          if (maybeNew.length) {
            const ttlMap2 = loadTTLMap(state.idPart);
            let sent = 0;

            for (const key of maybeNew) {
              const info = nowMap2.get(key);
              if (!info) continue;

              // احترام به TTL
              const last = ttlMap2[key] || 0;
              if (Date.now() - last < TTL_MS) continue;

              const text = buildMessageForOne(info);
              notifySPlus(text);

              ttlMap2[key] = Date.now();
              sent++;
              state.baseline.add(key); // تا دوباره تکرار نشود
            }

            saveBaseline(state.idPart, state.baseline);
            saveTTLMap(state.idPart, ttlMap2);
            record("TOTAL_DELTA_FALLBACK_SENT", { candidates: maybeNew.length, sent });
          } else {
            record("TOTAL_DELTA_NO_CANDIDATE");
          }
        }

        // در هر صورت، آخرش total ذخیره‌شده را هم‌گام کن
        if (currentTotal !== state.lastTotal) {
          state.lastTotal = currentTotal;
          saveTotal(state.idPart, currentTotal);
        }
      }


      const ttlMap = loadTTLMap(state.idPart);

      // از baseline حذف کن و TTL آنها را پاک کن تا اگر برگشتند، دوباره نوتیف شوند
      if (removed.length) {
        removed.forEach((k) => {
          state.baseline.delete(k);
          if (k in ttlMap) delete ttlMap[k];
        });
        saveBaseline(state.idPart, state.baseline);
        saveTTLMap(state.idPart, ttlMap);
        record("REMOVED_PURGED", { count: removed.length, keys: removed });
      }

      if (state.baseline.size === 0) {
        state.baseline = nowKeys;
        saveBaseline(state.idPart, state.baseline);
        record("BASELINE_SET", { count: state.baseline.size });
      } else if (newOnes.length > 0) {
        newOnes.forEach((key) => {
          const info = nowMap.get(key);
          if (!info) return;

          // چک TTL
          const last = ttlMap[key] || 0;
          if (Date.now() - last < TTL_MS) {
            record("SKIP_TTL", { key });
            return;
          }

          const text = buildMessageForOne(info);
          notifySPlus(text);

          // TTL به‌روز شود
          ttlMap[key] = Date.now();

          state.baseline.add(key);
        });

        saveBaseline(state.idPart, state.baseline);
        saveTTLMap(state.idPart, ttlMap);

        record("NEW_ROWS_SENT", { count: newOnes.length, keys: newOnes });
      } else {
        record("NO_CHANGE");
      }
      state.lastNow = nowKeys;
      state.lastNew = newOnes;
    } finally {
      _evaluateLock = false;
    }
  }

  try {
    chrome.runtime?.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === "EVAL_NOW") {
        record("EVAL_NOW_REQ");
        evaluateNow(true);
        sendResponse?.({ ok: true, at: Date.now() });
        return true; 
      }
      if (msg?.type === "FORCE_RELOAD") {
        record("FORCE_RELOAD_REQ");
        location.reload();
        sendResponse?.({ ok: true });
        return true; 
      }
    });
  } catch {}

  const debouncedEvaluate = debounce(() => evaluateNow(false), 300);

  const tbodyObservers = new Map();
  let intervalId = null;
  let docObserver = null;

  function observeTbody(tbody) {
    if (!tbody || tbodyObservers.has(tbody)) return;

    const obsRows = new MutationObserver((mutList) => {
      let addedTr = 0;
      mutList.forEach(m => {
        m.addedNodes && m.addedNodes.forEach(n => {
          if (n.nodeType === 1 && n.matches?.("tr.issuerow")) {
            addedTr++;
          }
        });
      });
      record("MUT_ROWS", { batches: mutList.length, addedTr });
      debouncedEvaluate();
    });
    obsRows.observe(tbody, { childList: true });
    tbodyObservers.set(tbody, obsRows);
  }

  function refreshTbodyList() {
    const current = new Set(Array.from(document.querySelectorAll(TABLE_BODY_SELECTOR)));
    current.forEach(tb => {
      _tbodies.add(tb);
      observeTbody(tb);
    });

    Array.from(tbodyObservers.keys()).forEach(tb => {
      if (!document.contains(tb) || !current.has(tb)) {
        try { tbodyObservers.get(tb)?.disconnect(); } catch {}
        tbodyObservers.delete(tb);
        _tbodies.delete(tb);
      }
    });
  }

  function attachObservers() {
    refreshTbodyList();

    if (docObserver) {
      try { docObserver.disconnect(); } catch {}
    }
    docObserver = new MutationObserver(() => {
      refreshTbodyList();
      debouncedEvaluate();
    });
    docObserver.observe(document.body || document, { childList: true, subtree: true });

    if (intervalId) clearInterval(intervalId);
    intervalId = setInterval(() => {
      record("INTERVAL_EVAL");
      evaluateNow(false);
    }, 5000);

    window.addEventListener("beforeunload", () => {
      tbodyObservers.forEach(obs => { try { obs.disconnect(); } catch {} });
      tbodyObservers.clear();
      _tbodies.clear();
      if (docObserver) { try { docObserver.disconnect(); } catch {} docObserver = null; }
      if (intervalId) clearInterval(intervalId);
    }, { once: true });

    record("OBS_ATTACHED", { bodies: _tbodies.size });
  }

  let refreshIntervalId = null;
  let watchdogIntervalId = null;

  function startRefreshTimers() {
    if (refreshIntervalId) clearInterval(refreshIntervalId);
    if (typeof REFRESH_MS === "number" && REFRESH_MS > 0) {
      refreshIntervalId = setInterval(() => {
        record("REFRESH_TICK", { REFRESH_MS });
        location.reload();
      }, REFRESH_MS);
    }

    if (watchdogIntervalId) clearInterval(watchdogIntervalId);
    if (typeof BG_RELOAD_WATCHDOG_MS === "number" && BG_RELOAD_WATCHDOG_MS > 0) {
      watchdogIntervalId = setInterval(() => {
        const since = Date.now() - (state.lastEvalTs || 0);
        const guard = Math.max(2 * REFRESH_MS + 2000, 15000);
        if (since > guard) {
          record("WATCHDOG_BG_RELOAD", { since, guard });
          try { chrome.runtime.sendMessage({ type: "REQUEST_SELF_RELOAD" }); } catch {}
        }
      }, BG_RELOAD_WATCHDOG_MS);
    }
  }

  function applyWatcherSettingsFrom(cfg) {
    const old = { REFRESH_MS, BG_RELOAD_WATCHDOG_MS, MESSAGE_HEADER };
    REFRESH_MS = Number(cfg.pageAutoRefreshMs) || 0;
    BG_RELOAD_WATCHDOG_MS = Number(cfg.bgWatchdogMs) || 0;
    if (typeof cfg.messageHeader === "string" && cfg.messageHeader.trim()) {
      MESSAGE_HEADER = cfg.messageHeader.trim();
    }
    record("APPLY_SETTINGS", { old, new: { REFRESH_MS, BG_RELOAD_WATCHDOG_MS, MESSAGE_HEADER } });
    startRefreshTimers();
  }

  function loadUserWatcherSettings() {
    try {
      chrome.storage?.sync?.get(
        { pageAutoRefreshMs: 60000, bgWatchdogMs: 120000, messageHeader: MESSAGE_HEADER },
        (cfg) => applyWatcherSettingsFrom(cfg)
      );
    } catch (e) {
      record("LOAD_SETTINGS_ERR", { e: String(e) });
    }
  }

  try {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "sync") return;
      const hasRelevant =
        Object.prototype.hasOwnProperty.call(changes, "pageAutoRefreshMs") ||
        Object.prototype.hasOwnProperty.call(changes, "bgWatchdogMs") ||
        Object.prototype.hasOwnProperty.call(changes, "messageHeader");
      if (!hasRelevant) return;

      const cfg = {
        pageAutoRefreshMs: changes.pageAutoRefreshMs?.newValue ?? REFRESH_MS,
        bgWatchdogMs: changes.bgWatchdogMs?.newValue ?? BG_RELOAD_WATCHDOG_MS,
        messageHeader: changes.messageHeader?.newValue ?? MESSAGE_HEADER
      };
      applyWatcherSettingsFrom(cfg);
    });
  } catch {}

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      record("VISIBLE_TICK");
      evaluateNow(true);
    }
  });

  async function main() {
    if (!PATH_REGEX.test(location.pathname || "")) {
      record("PATH_SKIP", { pathname: location.pathname });
      return;
    }

    loadUserWatcherSettings();

    const firstTbody = await waitForSelector(TABLE_BODY_SELECTOR, document, 20000).catch(() => null);
    if (!firstTbody) {
      record("TBODY_NOT_FOUND", { sel: TABLE_BODY_SELECTOR });
      startRefreshTimers();
      return;
    }

    _tbodies.add(firstTbody);
    observeTbody(firstTbody);

    state.idPart = `secure:${location.pathname}`;
    record("TBODY_FOUND", { rows: firstTbody.querySelectorAll("tr.issuerow").length });

    state.baseline = loadBaseline(state.idPart);
    state.lastTotal = loadTotal(state.idPart);
    record("LOAD_STATE", { baseline: state.baseline.size, lastTotal: state.lastTotal });

    evaluateNow(false);
    attachObservers();

    startRefreshTimers();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main, { once: true });
  } else {
    main();
  }
})();
