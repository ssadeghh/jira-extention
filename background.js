(() => {
  "use strict";

  // =========================
  // Config & Settings
  // =========================
  const DEFAULTS = {
    splusUrl: "https://web.splus.ir/#-10011872319",
    jiraOrigin: "https://jira.mohaymen.ir",
    jiraPathGlob: "/secure/*",
    pollMinutes: 1,
    sendGapMs: 800
  };
  let settings = { ...DEFAULTS };

  function loadSettings() {
    return new Promise(res => {
      chrome.storage.sync.get(DEFAULTS, data => {
        settings = { ...DEFAULTS, ...data };
        res(settings);
      });
    });
  }
  function splusHostPattern() {
    try { return new URL(settings.splusUrl).origin + "/*"; }
    catch { return "https://web.splus.ir/*"; }
  }
  function jiraMatchPattern() {
    const base = settings.jiraOrigin.replace(/\/$/, "");
    const glob = (settings.jiraPathGlob || "/*").startsWith("/") ? settings.jiraPathGlob : "/" + settings.jiraPathGlob;
    return `${base}${glob}`;
  }
  async function applyAlarms() {
    await chrome.alarms.clear("jira-poll");
    const m = Math.max(1, Number(settings.pollMinutes) || 1);
    chrome.alarms.create("jira-poll", { periodInMinutes: m });
  }

  // =========================
  // Safer content-script registration
  // =========================
  const JIRA_CS_ID = "jira-watcher";
  let _csRegPromise = null;
  let _lastPattern = null;

  async function registerJiraWatcherCS() {
    if (_csRegPromise) return _csRegPromise; // prevent concurrent registrations

    _csRegPromise = (async () => {
      const pattern = jiraMatchPattern();

      // اگر الگو تغییر نکرده، اطمینان حاصل کن از ثبت بودن اسکریپت و برگرد
      if (_lastPattern === pattern) {
        try {
          const existing = await chrome.scripting.getRegisteredContentScripts?.({ ids: [JIRA_CS_ID] });
          if (existing && existing.length) return; // already registered with same id/pattern
        } catch { /* older Chrome or no perms; continue to safe (un)register path */ }
      }

      // ابتدا (در صورت وجود) حذف کن تا Duplicate رخ نده
      try {
        await chrome.scripting.unregisterContentScripts({ ids: [JIRA_CS_ID] });
      } catch { /* ignore */ }

      // سپس دوباره با الگوی فعلی ثبت کن
      const base = settings.jiraOrigin.replace(/\/$/, "");
      const patterns = Array.from(new Set([
        pattern,                    // مثلا https://jira.example.com/secure/*
        `${base}/plugins/*`,        // گجت‌ها/iframeها
        `${base}/issues/*`,         // لیست‌ها
        `${base}/browse/*`,         // صفحات تیکت
        `${base}/*`                 // تور آخِر: هر چی زیر همین اوریجنه
      ]));

      await chrome.scripting.registerContentScripts([{
        id: JIRA_CS_ID,
        js: ["watcher.js"],
        matches: patterns,
        runAt: "document_idle",
        allFrames: true,
        persistAcrossSessions: true
      }]);

      _lastPattern = pattern;
    })();

    try {
      await _csRegPromise;
    } finally {
      _csRegPromise = null;
    }
  }

  // =========================
  // SPlus Tab utils
  // =========================
  function computeSplusUrl() { return settings.splusUrl; }
  function computeSplusQueryPattern() { return splusHostPattern(); }

  let splusTabId = null;
  let queue = [];
  let busy = false;

  const log  = (...a) => console.log("%c[bg]", "color:#19a1a", ...a);
  const warn = (...a) => console.warn("%c[bg]", "color:#d55", ...a);

  function isOurChat(url = "") {
    const u = computeSplusUrl();
    const hash = (new URL(u)).hash;
    return typeof url === "string" && hash && url.includes(hash);
  }

  function pTabsQuery(q) { return new Promise(res => chrome.tabs.query(q, res)); }
  function pTabsGet(id) { return new Promise(res => chrome.tabs.get(id, t => res(chrome.runtime.lastError ? null : t))); }
  function pTabsCreate(opts) { return new Promise(res => chrome.tabs.create(opts, res)); }
  function pTabsUpdate(id, opts) { return new Promise(res => chrome.tabs.update(id, opts, res)); }
  function pTabsReload(id) { return new Promise(res => chrome.tabs.reload(id, {}, () => res(true))); }
  function pSendMessage(tabId, msg) {
    return new Promise(res => {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) {
          return res({ ok:false, err: chrome.runtime.lastError.message });
        }
        res({ ok:true, resp });
      });
    });
  }
  function pWaitTabComplete(tabId, timeoutMs = 20000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (done) return; done = true; try { chrome.tabs.onUpdated.removeListener(onUpd); } catch {} resolve(ok); };
      const onUpd = (updatedId, info) => { if (updatedId === tabId && info.status === "complete") finish(true); };
      chrome.tabs.onUpdated.addListener(onUpd);
      pTabsGet(tabId).then(tab => { if (tab && tab.status === "complete") finish(true); });
      setTimeout(() => finish(false), timeoutMs);
    });
  }
  function pInjectSplus(tabId) {
    return chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["splus.js"],
      world: "ISOLATED"
    }).then(
      () => ({ ok: true }),
      (e) => ({ ok: false, err: String(e) })
    );
  }

  async function findOrCreateSplusTab() {
    const SPLUS_URL = computeSplusUrl();
    const SPLUS_HOST_PATTERN = computeSplusQueryPattern();

    if (splusTabId != null) {
      const t = await pTabsGet(splusTabId);
      if (t) {
        if (!isOurChat(t.url)) {
          await pTabsUpdate(t.id, { url: SPLUS_URL, active: false });
          await pWaitTabComplete(t.id, 30000);
        }
        return t.id;
      }
      splusTabId = null;
    }

    const tabs = await pTabsQuery({ url: SPLUS_HOST_PATTERN });
    if (tabs && tabs.length) {
      let best = tabs.find(t => isOurChat(t.url)) || tabs[0];
      splusTabId = best.id;
      if (!isOurChat(best.url)) {
        await pTabsUpdate(best.id, { url: SPLUS_URL, active: false });
        await pWaitTabComplete(best.id, 30000);
      }
      return splusTabId;
    }

    const tab = await pTabsCreate({ url: SPLUS_URL, active: false });
    splusTabId = tab.id;
    await pWaitTabComplete(tab.id, 30000);
    return tab.id;
  }

  function pGetAllFrames(tabId) {
   return new Promise(res => {
     chrome.webNavigation.getAllFrames({ tabId }, frames => {
       if (chrome.runtime.lastError || !Array.isArray(frames)) return res([{ frameId: 0 }]);
       res(frames);
     });
   });
 }

  async function ensureSplusReady(tabId, totalTimeout = 20000) {
    await pWaitTabComplete(tabId, totalTimeout);

    let ping = await pSendMessage(tabId, { type: "PING" });
    if (ping.ok && ping.resp && ping.resp.pong) {
      log("PING OK (content present)");
      return true;
    }
    log("PING fail, injecting splus.js ...", ping.err);

    const inj = await pInjectSplus(tabId);
    if (!inj.ok) { warn("Inject failed:", inj.err); return false; }

    await new Promise(r => setTimeout(r, 300));

    ping = await pSendMessage(tabId, { type: "PING" });
    if (ping.ok && ping.resp && ping.resp.pong) { log("PING OK after inject"); return true; }

    warn("PING still failed after inject:", ping.err);
    return false;
  }

  async function sendOne(text) {
    try {
      const tabId = await findOrCreateSplusTab();
      const ready = await ensureSplusReady(tabId, 20000);
      if (!ready) { warn("SPlus not ready, drop message:", text.slice(0, 60)); return false; }
      const resp = await pSendMessage(tabId, { type: "SEND_MESSAGE", text });
      if (!resp.ok) { warn("SEND_MESSAGE error:", resp.err); return false; }
      return true;
    } catch (e) { warn("sendOne error:", e); return false; }
  }

  function kickQueue() {
    if (busy) return;
    if (!queue.length) return;
    busy = true;

    (async () => {
      while (queue.length) {
        const text = queue.shift();
        log("→ Sending:", (text || "").split("\n")[0]);
        await sendOne(text);
        await new Promise(r => setTimeout(r, Number(settings.sendGapMs) || 800));
      }
      busy = false;
    })();
  }

  // =========================
  // Lifecycle & Events
  // =========================
  chrome.runtime.onInstalled.addListener(async () => {
    await loadSettings();
    await applyAlarms();
    await registerJiraWatcherCS();
  });
  chrome.runtime.onStartup.addListener(async () => {
    await loadSettings();
    await applyAlarms();
    await registerJiraWatcherCS();
  });

  chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "jira-poll") return;

  try {
    const base = settings.jiraOrigin.replace(/\/$/, "");
    const tabs = await pTabsQuery({ url: `${base}/*` });
    if (!tabs?.length) return;

    // تب فعال فعلی (برای بازگردانی)
    const prevActive = await pTabsQuery({ active: true, currentWindow: true });
    const prevActiveTab = prevActive && prevActive[0] ? prevActive[0] : null;

    for (const t of tabs) {
      try {
        // 1) رفرش تب Jira
        await pTabsReload(t.id);
        await pWaitTabComplete(t.id, 30000);

        // 2) موقتاً تب را active کن تا رندر گجت‌ها انجام شود
        await pTabsUpdate(t.id, { active: true });

        // 3) کمی صبر برای رندرِ iframe/gadget
        await new Promise(r => setTimeout(r, 1200));

        // 4) درخواست ارزیابی
        const frames = await pGetAllFrames(t.id);
        let delivered = 0;
        for (const f of frames) {
          const ok = await new Promise(rs => {
            chrome.tabs.sendMessage(t.id, { type: "EVAL_NOW" }, { frameId: f.frameId }, resp => {
              rs(!chrome.runtime.lastError && resp && resp.ok);
            });
          });
          if (ok) delivered++;
        }
        if (!delivered) warn("EVAL_NOW not delivered to any frame");

        // 5) (اختیاری) برگرداندن فوکوس به تب قبلی
        if (prevActiveTab) {
          await pTabsUpdate(prevActiveTab.id, { active: true });
        }
      } catch (e) {
        warn("jira-poll per-tab error:", e);
      }
    }
  } catch (e) {
    warn("jira-poll top-level error:", e);
  }
});


  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "TASK_ADDED") {
      const text = msg.text || "incident جدید اضافه شد";
      queue.push(text);
      kickQueue();
      sendResponse?.({ ok: true });
      return true;
    }

    if (msg?.type === "REQUEST_SELF_RELOAD" && sender?.tab?.id) {
      pTabsReload(sender.tab.id).then(() => sendResponse?.({ ok: true }));
      return true;
    }

    if (msg?.type === "APPLY_SETTINGS_NOW") {
      (async () => {
        await loadSettings();
        await applyAlarms();
        await registerJiraWatcherCS();
        sendResponse?.({ ok: true });
      })();
      return true;
    }
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "sync") return;
    await loadSettings();
    if (changes.pollMinutes || changes.jiraOrigin || changes.jiraPathGlob) {
      await applyAlarms();
      await registerJiraWatcherCS();
    }
  });

  chrome.tabs.onRemoved.addListener((closedTabId) => { if (closedTabId === splusTabId) splusTabId = null; });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => { if (tabId === splusTabId && changeInfo.url) log("SPlus tab URL changed:", changeInfo.url); });
})();
