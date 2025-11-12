const INPUT_SELECTORS = [
   '#editable-message-text',
   '.Composer [contenteditable="true"][role="textbox"]',
   '.Composer div[contenteditable="true"]',
   '[data-testid="composer-input"][contenteditable="true"]'
 ];
const SEND_BUTTON_SELECTORS = [
   '.Composer button[type="submit"]',
   '.Composer button:enabled',
   'button:has([class*="icon-send"])' // اگر CSS :has پشتیبانی شود
 ];

function waitForElementAny(selectors, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const pick = () => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      return null;
    };
    const existing = pick();
    if (existing) return resolve(existing);
    const obs = new MutationObserver(() => {
      const el = pick();
      if (el) { obs.disconnect(); resolve(el); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); reject(new Error("Element not found for any selector")); }, timeoutMs);
  });
}

async function sendMessage(text) {
  try {
    const input = await waitForElementAny(INPUT_SELECTORS);


    input.focus();

    const range = document.createRange();
    range.selectNodeContents(input);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

     // پاک کردن محتوا (contenteditable)
 if (input.isContentEditable) {
   input.innerHTML = '';
   const textNode = document.createTextNode(text);
   input.appendChild(textNode);
 } else if ('value' in input) {
   input.value = text;
 } else {
   input.textContent = text;
 }
 input.dispatchEvent(new Event('input', { bubbles: true }));
 input.dispatchEvent(new Event('change', { bubbles: true }));

    setTimeout(() => {
       let btn = null;
 for (const sel of SEND_BUTTON_SELECTORS) {
   const found = document.querySelector(sel);
   if (found) {
     btn = found.tagName?.toLowerCase() === 'button' ? found : found.closest('button');
     if (btn) break;
   }
 }
      btn?.click();
    }, 400);
  } catch (e) {
    console.warn("sendMessage error:", e);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "PING") {
    sendResponse({ pong: true });
    return;
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SEND_MESSAGE" && msg.text) {
    sendMessage(msg.text);
  }
});
