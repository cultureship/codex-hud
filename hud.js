(() => {
  "use strict";

  const VERSION = "0.2.1";
  const CONFIG = __CODEX_HUD_CONFIG__;
  const ROOT_ID = "codex-hud-root";
  const STYLE_ID = "codex-hud-style";
  const POSITION_KEY = "codex-hud-position-v2";
  const TITLEBAR_GUARD = 40;

  if (window.top !== window || window.self !== window || !/^app:\/\/-\//i.test(window.location.href)) return;
  if (window.__codexHud?.version === VERSION) {
    window.__codexHud.ensure();
    return;
  }
  try {
    window.__codexHud?.destroy?.();
  } catch {
    // A previous version must not prevent the replacement from loading.
  }

  const state = {
    model: "",
    current: emptyUsage(),
    session: emptyUsage(),
    collapsed: false,
    root: null,
    observer: null,
    messageHandler: null,
    bridgeHandler: null,
    originals: {},
  };

  function emptyUsage() {
    return { input: 0, output: 0, cached: 0, total: 0 };
  }

  function count(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
  }

  function firstCount(source, keys) {
    for (const key of keys) {
      if (source && Object.prototype.hasOwnProperty.call(source, key)) return count(source[key]);
    }
    return 0;
  }

  function normalizeUsage(source) {
    if (!source || typeof source !== "object") return null;
    const hasUsageField = [
      "input_tokens", "inputTokens", "input",
      "output_tokens", "outputTokens", "output",
      "cached_input_tokens", "cachedInputTokens", "cached",
      "total_tokens", "totalTokens", "total",
    ].some((key) => Object.prototype.hasOwnProperty.call(source, key));
    if (!hasUsageField) return null;

    const input = firstCount(source, ["input_tokens", "inputTokens", "input"]);
    const output = firstCount(source, ["output_tokens", "outputTokens", "output"]);
    const cached = firstCount(source, [
      "cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens",
      "cacheReadInputTokens", "cache_read_tokens", "cached",
    ]);
    const total = firstCount(source, ["total_tokens", "totalTokens", "total"]) || input + output;
    return { input, output, cached: Math.min(cached, input || cached), total };
  }

  function parseText(text) {
    const value = String(text || "").trim();
    if (!value) return [];
    try {
      return [JSON.parse(value)];
    } catch {
      return value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((line) => line && line !== "[DONE]")
        .flatMap((line) => {
          try { return [JSON.parse(line)]; } catch { return []; }
        });
    }
  }

  function modelCandidate(value) {
    if (typeof value !== "string") return "";
    const model = value.trim();
    if (!model || model.length > 120) return "";
    return /^(?:gpt-|o\d|codex|chatgpt)/i.test(model) ? model : "";
  }

  function inspect(value) {
    if (typeof value === "string") {
      for (const parsed of parseText(value)) inspect(parsed);
      return;
    }
    const seen = new WeakSet();
    let changed = false;

    function visit(node, depth) {
      if (!node || depth > 10) return;
      if (typeof node === "string") {
        for (const parsed of parseText(node)) visit(parsed, depth + 1);
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) visit(item, depth + 1);
        return;
      }
      if (typeof node !== "object" || seen.has(node)) return;
      seen.add(node);

      for (const key of ["model", "model_name", "modelName", "selected_model", "selectedModel"] ) {
        const candidate = modelCandidate(node[key]);
        if (candidate && candidate !== state.model) {
          state.model = candidate;
          changed = true;
        }
      }

      const tokenNode = node.type === "token_count"
        ? node
        : node.payload?.type === "token_count"
          ? node.payload
          : null;
      if (tokenNode?.info && typeof tokenNode.info === "object") {
        const current = normalizeUsage(
          tokenNode.info.last_token_usage || tokenNode.info.lastTokenUsage || tokenNode.info.last_usage,
        );
        const session = normalizeUsage(
          tokenNode.info.total_token_usage || tokenNode.info.totalTokenUsage || tokenNode.info.total_usage,
        );
        if (current) {
          state.current = current;
          changed = true;
        }
        if (session) {
          state.session = session;
          changed = true;
        }
      }

      if (!tokenNode) {
        for (const key of ["last_token_usage", "lastTokenUsage", "last_usage", "usage"]) {
          const usage = normalizeUsage(node[key]);
          if (usage) {
            state.current = usage;
            changed = true;
            break;
          }
        }
      }

      for (const key of [
        "payload", "info", "data", "body", "message", "result", "response",
        "params", "event", "token_usage", "tokenUsage", "response_metadata",
      ]) {
        if (node[key] !== undefined) visit(node[key], depth + 1);
      }
    }

    visit(value, 0);
    if (changed) render();
  }

  function formatCount(value) {
    const number = count(value);
    if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 1 : 2)}M`;
    if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}K`;
    return String(number);
  }

  function normalizedModel() {
    const model = state.model.toLowerCase();
    if (CONFIG.prices?.[model]) return model;
    return Object.keys(CONFIG.prices || {}).find((key) => model === key || model.startsWith(`${key}-`)) || "";
  }

  function usageCost(usage) {
    const price = CONFIG.prices?.[normalizedModel()];
    if (!price) return null;
    const cached = Math.min(usage.cached, usage.input);
    const uncached = Math.max(0, usage.input - cached);
    return (
      uncached * Number(price.input || 0) +
      cached * Number(price.cachedInput ?? price.input ?? 0) +
      usage.output * Number(price.output || 0)
    ) / 1_000_000;
  }

  function formatMoney(value) {
    if (!Number.isFinite(value)) return "--";
    if (value > 0 && value < 0.001) return "<$0.001";
    return `$${value.toFixed(value < 0.1 ? 3 : 2)}`;
  }

  function cachePercent(usage) {
    return usage.input ? `${Math.round((usage.cached / usage.input) * 100)}%` : "0%";
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID} {
        --codex-hud-bg: color-mix(in srgb, var(--color-token-bg-primary, #18181b) 91%, transparent);
        --codex-hud-border: color-mix(in srgb, var(--color-token-border-default, #71717a) 34%, transparent);
        --codex-hud-text: var(--color-token-text-primary, #f4f4f5);
        --codex-hud-muted: var(--color-token-text-tertiary, #a1a1aa);
        position: fixed;
        right: 18px;
        bottom: 104px;
        z-index: 2147483000;
        width: 224px;
        box-sizing: border-box;
        border: 1px solid var(--codex-hud-border);
        border-radius: 8px;
        background: var(--codex-hud-bg);
        color: var(--codex-hud-text);
        box-shadow: 0 8px 24px rgba(0, 0, 0, .22);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        font: 12px/1.35 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
        user-select: none;
        -webkit-app-region: no-drag;
      }
      #${ROOT_ID}[data-collapsed="true"] { width: 156px; }
      #${ROOT_ID} .codex-hud-head {
        display: flex;
        align-items: center;
        min-height: 30px;
        padding: 0 7px 0 10px;
        border-bottom: 1px solid var(--codex-hud-border);
        cursor: move;
      }
      #${ROOT_ID}[data-collapsed="true"] .codex-hud-head { border-bottom: 0; }
      #${ROOT_ID} .codex-hud-title { font-size: 11px; font-weight: 650; }
      #${ROOT_ID} .codex-hud-model {
        min-width: 0;
        margin-left: 7px;
        color: var(--codex-hud-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${ROOT_ID} .codex-hud-collapse {
        width: 24px;
        height: 24px;
        margin-left: auto;
        padding: 0;
        border: 0;
        border-radius: 5px;
        background: transparent;
        color: var(--codex-hud-muted);
        font: 16px/24px ui-sans-serif, system-ui, sans-serif;
        cursor: pointer;
      }
      #${ROOT_ID} .codex-hud-collapse:hover { background: rgba(127, 127, 127, .14); color: var(--codex-hud-text); }
      #${ROOT_ID} .codex-hud-body {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px 12px;
        padding: 9px 10px 10px;
      }
      #${ROOT_ID}[data-collapsed="true"] .codex-hud-body { display: none; }
      #${ROOT_ID} .codex-hud-stat { min-width: 0; }
      #${ROOT_ID} .codex-hud-label { display: block; margin-bottom: 2px; color: var(--codex-hud-muted); font-size: 10px; }
      #${ROOT_ID} .codex-hud-value { display: block; font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; }
      @media (prefers-color-scheme: light) {
        #${ROOT_ID} { --codex-hud-bg: rgba(255, 255, 255, .92); --codex-hud-border: rgba(24, 24, 27, .16); --codex-hud-text: #18181b; --codex-hud-muted: #71717a; }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function savedPosition() {
    try {
      const value = JSON.parse(localStorage.getItem(POSITION_KEY) || "null");
      if (Number.isFinite(value?.left) && Number.isFinite(value?.top)) return value;
    } catch {
      // Ignore malformed local state.
    }
    return null;
  }

  function applySavedPosition(root) {
    const position = savedPosition();
    if (!position) return;
    root.style.left = `${Math.max(0, Math.min(position.left, window.innerWidth - root.offsetWidth))}px`;
    root.style.top = `${Math.max(TITLEBAR_GUARD, Math.min(position.top, window.innerHeight - root.offsetHeight))}px`;
    root.style.right = "auto";
    root.style.bottom = "auto";
  }

  function installDrag(root) {
    const head = root.querySelector(".codex-hud-head");
    let drag = null;
    head.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      const rect = root.getBoundingClientRect();
      drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      head.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    head.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const left = Math.max(0, Math.min(event.clientX - drag.dx, window.innerWidth - root.offsetWidth));
      const top = Math.max(TITLEBAR_GUARD, Math.min(event.clientY - drag.dy, window.innerHeight - root.offsetHeight));
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
      root.style.right = "auto";
      root.style.bottom = "auto";
    });
    const finish = () => {
      if (!drag) return;
      drag = null;
      const rect = root.getBoundingClientRect();
      try { localStorage.setItem(POSITION_KEY, JSON.stringify({ left: rect.left, top: rect.top })); } catch {}
    };
    head.addEventListener("pointerup", finish);
    head.addEventListener("pointercancel", finish);
  }

  function ensureRoot() {
    ensureStyle();
    if (state.root?.isConnected) return state.root;
    document.getElementById(ROOT_ID)?.remove();
    const root = document.createElement("section");
    root.id = ROOT_ID;
    root.setAttribute("aria-label", "codex-hud");
    root.innerHTML = `
      <div class="codex-hud-head">
        <span class="codex-hud-title">codex-hud</span>
        <span class="codex-hud-model" data-value="model">--</span>
        <button class="codex-hud-collapse" type="button" title="折叠" aria-label="折叠">-</button>
      </div>
      <div class="codex-hud-body">
        <div class="codex-hud-stat"><span class="codex-hud-label">本轮输入</span><span class="codex-hud-value" data-value="turn-input">0</span></div>
        <div class="codex-hud-stat"><span class="codex-hud-label">本轮输出</span><span class="codex-hud-value" data-value="turn-output">0</span></div>
        <div class="codex-hud-stat"><span class="codex-hud-label">会话 Token</span><span class="codex-hud-value" data-value="session-total">0</span></div>
        <div class="codex-hud-stat"><span class="codex-hud-label">缓存命中</span><span class="codex-hud-value" data-value="cache-rate">0%</span></div>
        <div class="codex-hud-stat"><span class="codex-hud-label">本轮估算</span><span class="codex-hud-value" data-value="turn-cost">--</span></div>
        <div class="codex-hud-stat"><span class="codex-hud-label">会话估算</span><span class="codex-hud-value" data-value="session-cost">--</span></div>
      </div>
    `;
    root.querySelector(".codex-hud-collapse").addEventListener("click", () => {
      state.collapsed = !state.collapsed;
      root.dataset.collapsed = String(state.collapsed);
      const button = root.querySelector(".codex-hud-collapse");
      button.textContent = state.collapsed ? "+" : "-";
      button.title = state.collapsed ? "展开" : "折叠";
      button.setAttribute("aria-label", button.title);
    });
    (document.body || document.documentElement).appendChild(root);
    state.root = root;
    installDrag(root);
    requestAnimationFrame(() => applySavedPosition(root));
    return root;
  }

  function setValue(root, name, value) {
    const node = root.querySelector(`[data-value="${name}"]`);
    if (node && node.textContent !== value) node.textContent = value;
  }

  function render() {
    const root = ensureRoot();
    setValue(root, "model", state.model || "--");
    setValue(root, "turn-input", formatCount(state.current.input));
    setValue(root, "turn-output", formatCount(state.current.output));
    setValue(root, "session-total", formatCount(state.session.total));
    setValue(root, "cache-rate", cachePercent(state.session));
    setValue(root, "turn-cost", formatMoney(usageCost(state.current)));
    setValue(root, "session-cost", formatMoney(usageCost(state.session)));
  }

  function relevantUrl(input) {
    const url = typeof input === "string" ? input : input?.url || "";
    return /(?:responses|conversation|thread|codex|\/api\/)/i.test(String(url));
  }

  function installCapture() {
    if (typeof window.fetch === "function") {
      const originalFetch = window.fetch;
      state.originals.fetch = originalFetch;
      window.fetch = async function codexHudFetch(input, init) {
        if (relevantUrl(input)) inspect(init?.body);
        const response = await originalFetch.apply(this, arguments);
        if (relevantUrl(input) && response?.clone) {
          response.clone().text().then(inspect).catch(() => {});
        }
        return response;
      };
    }

    const Xhr = window.XMLHttpRequest;
    if (Xhr?.prototype) {
      const originalOpen = Xhr.prototype.open;
      const originalSend = Xhr.prototype.send;
      state.originals.xhrOpen = originalOpen;
      state.originals.xhrSend = originalSend;
      Xhr.prototype.open = function codexHudOpen(method, url) {
        this.__codexHudUrl = url;
        return originalOpen.apply(this, arguments);
      };
      Xhr.prototype.send = function codexHudSend(body) {
        if (relevantUrl(this.__codexHudUrl)) {
          inspect(body);
          this.addEventListener("loadend", () => inspect(this.responseText || ""), { once: true });
        }
        return originalSend.apply(this, arguments);
      };
    }

    if (typeof window.WebSocket === "function") {
      const NativeWebSocket = window.WebSocket;
      state.originals.webSocket = NativeWebSocket;
      function CodexHudWebSocket() {
        const socket = new NativeWebSocket(...arguments);
        socket.addEventListener("message", (event) => {
          if (typeof event.data === "string") inspect(event.data);
          else if (event.data instanceof Blob && event.data.size <= 1_000_000) event.data.text().then(inspect).catch(() => {});
        });
        return socket;
      }
      CodexHudWebSocket.prototype = NativeWebSocket.prototype;
      for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
        Object.defineProperty(CodexHudWebSocket, key, { value: NativeWebSocket[key] });
      }
      window.WebSocket = CodexHudWebSocket;
    }

    state.messageHandler = (event) => inspect(event.data);
    state.bridgeHandler = (event) => inspect(event.detail);
    window.addEventListener("message", state.messageHandler, true);
    window.addEventListener("codex-message-from-view", state.bridgeHandler, true);
  }

  function destroy() {
    state.observer?.disconnect();
    if (state.messageHandler) window.removeEventListener("message", state.messageHandler, true);
    if (state.bridgeHandler) window.removeEventListener("codex-message-from-view", state.bridgeHandler, true);
    if (state.originals.fetch && window.fetch?.name === "codexHudFetch") window.fetch = state.originals.fetch;
    if (state.originals.webSocket && window.WebSocket?.name === "CodexHudWebSocket") window.WebSocket = state.originals.webSocket;
    const Xhr = window.XMLHttpRequest;
    if (Xhr?.prototype && state.originals.xhrOpen && Xhr.prototype.open?.name === "codexHudOpen") Xhr.prototype.open = state.originals.xhrOpen;
    if (Xhr?.prototype && state.originals.xhrSend && Xhr.prototype.send?.name === "codexHudSend") Xhr.prototype.send = state.originals.xhrSend;
    state.root?.remove();
    document.getElementById(STYLE_ID)?.remove();
    if (window.__codexHud?.version === VERSION) delete window.__codexHud;
  }

  installCapture();
  state.observer = new MutationObserver(() => {
    if (!document.getElementById(ROOT_ID)) render();
  });
  state.observer.observe(document.documentElement, { childList: true, subtree: true });
  window.__codexHud = { version: VERSION, ensure: render, inspect, destroy };
  render();
})();
