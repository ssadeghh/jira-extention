const DEFAULTS = {
  jiraOrigin: "https://jira.mohaymen.ir",
  jiraPathGlob: "/secure/*",
  pollMinutes: 1,
  pageAutoRefreshMs: 0,
  bgWatchdogMs: 0,
  sendGapMs: 800,
  splusUrl: "https://web.splus.ir/#45913396"
};

const els = {};
["jiraOrigin","jiraPathGlob","pollMinutes","pageAutoRefreshMs","bgWatchdogMs","sendGapMs","splusUrl"].forEach(id=>{
  els[id] = document.getElementById(id);
});

function load() {
  chrome.storage.sync.get(DEFAULTS, data => {
    for (const k in DEFAULTS) els[k].value = data[k] ?? DEFAULTS[k];
  });
}
load();

document.getElementById("save").addEventListener("click", async () => {
  try {
    const jiraOrigin = new URL(els.jiraOrigin.value.trim()).origin;
    const splusUrl = new URL(els.splusUrl.value.trim()).toString();

    const cfg = {
      jiraOrigin,
      jiraPathGlob: els.jiraPathGlob.value.trim() || "/secure/*",
      pollMinutes: Math.max(1, parseInt(els.pollMinutes.value, 10) || 1),
      pageAutoRefreshMs: Math.max(0, parseInt(els.pageAutoRefreshMs.value, 10) || 0),
      bgWatchdogMs: Math.max(0, parseInt(els.bgWatchdogMs.value, 10) || 0),
      sendGapMs: Math.max(200, parseInt(els.sendGapMs.value, 10) || 800),
      splusUrl
    };

    const originPattern = `${jiraOrigin.replace(/\/$/, "")}/*`;
    const granted = await chrome.permissions.request({ origins: [originPattern] });
    if (!granted) throw new Error("دسترسی به دامنهٔ JIRA داده نشد.");

    await chrome.storage.sync.set(cfg);

    await chrome.runtime.sendMessage({ type: "APPLY_SETTINGS_NOW" });

    setStatus("ذخیره شد ✅ و اعمال شد");
  } catch (e) {
    console.error(e);
    setStatus("خطا: " + e.message);
  }
});

function setStatus(t) {
  const s = document.getElementById("status");
  s.textContent = t;
  setTimeout(() => (s.textContent = ""), 3000);
}
