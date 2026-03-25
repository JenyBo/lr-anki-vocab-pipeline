// Content-script bridge:
// 1) inject page-context hook script (token_hook.js),
// 2) receive token via window.postMessage,
// 3) store in chrome.storage.local for popup usage.

const STORAGE_KEY = 'diocoToken';
const MSG_TYPE = 'LR_DIOCO_TOKEN_CAPTURED';
const MSG_REQUEST = 'LR_DIOCO_TOKEN_REQUEST';

function looksLikeToken(s) {
  return typeof s === 'string' && s.length > 20 && s.includes('/');
}

function requestToken() {
  try {
    window.postMessage({ type: MSG_REQUEST }, '*');
  } catch {
    // ignore
  }
}

function injectHookScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('token_hook.js');
  script.async = false;
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => {
    script.remove();
    // Ask for token after the hook is guaranteed to be loaded.
    requestToken();
  };
}

window.addEventListener('message', async (event) => {
  const data = event.data;
  if (!data || data.type !== MSG_TYPE) return;

  const token = data.token;
  if (!looksLikeToken(token)) return;

  try {
    // Stop any retry loop once we have the message.
    window.__LR_TOKEN_REQUEST_RETRY__ = false;
    await chrome.storage.local.set({
      [STORAGE_KEY]: token,
      diocoTokenDebug: { found: true, lastCapturedAt: Date.now() },
    });
  } catch {
    // ignore storage errors
  }
});

injectHookScript();

// Retry token request a few times in case the first postMessage gets missed.
// We also store debug timestamps so the popup can show what happened.
window.__LR_TOKEN_REQUEST_RETRY__ = true;
let attempts = 0;
const maxAttempts = 6;
const intervalMs = 1000;
const retryTimer = setInterval(async () => {
  if (!window.__LR_TOKEN_REQUEST_RETRY__) {
    clearInterval(retryTimer);
    return;
  }
  attempts++;
  try {
    await chrome.storage.local.set({
      diocoTokenDebug: {
        ...(chrome?.storage?.local ? {} : {}),
        requestAttempt: attempts,
        lastRequestAt: Date.now(),
      },
    });
  } catch {
    // ignore
  }
  requestToken();

  if (attempts >= maxAttempts) {
    window.__LR_TOKEN_REQUEST_RETRY__ = false;
    clearInterval(retryTimer);
  }
}, intervalMs);

