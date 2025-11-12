// popup.js
const DEFAULTS = {
  jiraOrigin: "https://jira.mohaymen.ir",
  jiraPathGlob: "/secure/*",
  pollMinutes: 1,
  pageAutoRefreshMs: 0,
  bgWatchdogMs: 0,
  sendGapMs: 800,
  splusUrl: "https://web.splus.ir/#45913396",
  messageHeader: "incident جدید اضافه شد"
};

const $ = (id) => document.getElementById(id);
const fields = [
  "jiraOrigin","jiraPathGlob","pollMinutes","pageAutoRefreshMs",
  "bgWatchdogMs","sendGapMs","splusUrl","messageHeader"
];

function setStatus(txt, ok = true) {
  const el = $("status");
  el.textContent = txt || "";
  el.style.color = ok ? "inherit" : "#d33";
}

function load() {
  chrome.storage.sync.get(DEFAULTS, (cfg) => {
    fields.forEach((k) => { $(k).value = cfg[k] ?? DEFAULTS[k]; });
  });
}

async function save() {
  try {
    setStatus("درحال ذخیره…");

    const jiraOrigin = new URL($("jiraOrigin").value.trim()).origin;
    const splusUrl = new URL($("splusUrl").value.trim()).toString();

    const cfg = {
      jiraOrigin,
      jiraPathGlob: $("jiraPathGlob").value.trim() || "/secure/*",
      pollMinutes: Math.max(1, parseInt($("pollMinutes").value, 10) || 1),
      pageAutoRefreshMs: Math.max(0, parseInt($("pageAutoRefreshMs").value, 10) || 0),
      bgWatchdogMs: Math.max(0, parseInt($("bgWatchdogMs").value, 10) || 0),
      sendGapMs: Math.max(200, parseInt($("sendGapMs").value, 10) || 800),
      splusUrl,
      messageHeader: $("messageHeader").value.trim() || DEFAULTS.messageHeader
    };

    const originPattern = `${jiraOrigin.replace(/\/$/, "")}/*`;
    const granted = await chrome.permissions.request({ origins: [originPattern] });
    if (!granted) throw new Error("دسترسی به دامنهٔ JIRA داده نشد.");

    await chrome.storage.sync.set(cfg);

    await chrome.runtime.sendMessage({ type: "APPLY_SETTINGS_NOW" });

    setStatus("ذخیره شد و اعمال شد ✅");
  } catch (e) {
    console.error(e);
    setStatus("خطا: " + (e.message || e), false);
  }
}

$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("save").addEventListener("click", save);
document.addEventListener("DOMContentLoaded", load);
