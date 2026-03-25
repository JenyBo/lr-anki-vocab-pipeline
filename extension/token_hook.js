// Runs in page context on languagereactor.com.
// Intercepts fetch/XHR request payloads to capture diocoToken and emits it via postMessage.

(function () {
  const MSG_TYPE = 'LR_DIOCO_TOKEN_CAPTURED';
  const MSG_REQUEST = 'LR_DIOCO_TOKEN_REQUEST';
  let alreadySent = false;
  let capturedToken = null;

  // Debug object for manual console checks.
  // Example: `window.__LR_TOKEN_CAPTURE_STATUS`
  window.__LR_TOKEN_CAPTURE_STATUS = {
    hookLoaded: true,
    tokenCaptured: false,
    tokenLen: 0,
    lastRequestAt: 0,
  };

  function looksLikeToken(s) {
    return typeof s === 'string' && s.length > 20 && s.includes('/');
  }

  function emitToken(token) {
    if (alreadySent) return;
    if (!looksLikeToken(token)) return;
    alreadySent = true;
    capturedToken = token;
    window.__LR_TOKEN_CAPTURE_STATUS.tokenCaptured = true;
    window.__LR_TOKEN_CAPTURE_STATUS.tokenLen = token.length;
    window.postMessage({ type: MSG_TYPE, token }, '*');
  }

  function tryExtractTokenFromBody(body) {
    if (!body) return null;

    // String payload
    if (typeof body === 'string') {
      if (!body.includes('diocoToken')) return null;
      try {
        const obj = JSON.parse(body);
        if (obj?.diocoToken) return obj.diocoToken;
      } catch {
        // ignore parse errors
      }
      const m = body.match(/"diocoToken"\s*:\s*"([^"]+)"/);
      return m ? m[1] : null;
    }

    // URLSearchParams
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      return body.get('diocoToken');
    }

    return null;
  }

  function shouldInspectUrl(url) {
    return typeof url === 'string' && url.includes('api-cdn.dioco.io');
  }

  // fetch hook
  const originalFetch = window.fetch?.bind(window);
  if (originalFetch) {
    window.fetch = function (input, init = {}) {
      try {
        const url = typeof input === 'string' ? input : input?.url;
        if (shouldInspectUrl(url)) {
          const token = tryExtractTokenFromBody(init?.body);
          if (token) emitToken(token);
        }
      } catch {
        // ignore hook errors
      }
      return originalFetch(input, init);
    };
  }

  // XHR hook
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      this.__lr_url = url;
      return open.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      try {
        if (shouldInspectUrl(this.__lr_url)) {
          const token = tryExtractTokenFromBody(body);
          if (token) emitToken(token);
        }
      } catch {
        // ignore hook errors
      }
      return send.apply(this, arguments);
    };
  }

  // If token was captured before the extension listener attached,
  // allow the extension to request the current token.
  window.addEventListener('message', (event) => {
    try {
      const data = event?.data;
      if (!data || data.type !== MSG_REQUEST) return;

      window.__LR_TOKEN_CAPTURE_STATUS.lastRequestAt = Date.now();
      if (capturedToken) {
        window.postMessage({ type: MSG_TYPE, token: capturedToken }, '*');
      }
    } catch {
      // ignore
    }
  });
})();

