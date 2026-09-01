(() => {
  "use strict";

  const VERSION = "0.5.35";
  const CONFIG = __CODEX_HUD_CONFIG__;
  const CONFIG_KEY = JSON.stringify(CONFIG);
  const ROOT_ID = "codex-hud-root";
  const STYLE_ID = "codex-hud-style";
  const POSITION_KEY = "codex-hud-position-v2";
  const TITLEBAR_GUARD = 40;

  if (window.top !== window || window.self !== window || !/^app:\/\/-\//i.test(window.location.href)) return;
  if (window.__codexHud?.version === VERSION && window.__codexHud?.configKey === CONFIG_KEY) {
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
    currentPricingUsage: emptyPricingUsage(),
    lastCompleted: emptyUsage(),
    lastCompletedPricingUsage: emptyPricingUsage(),
    session: emptyUsage(),
    sessionPricingUsage: null,
    sessionAvailable: false,
    activeThreadId: "",
    todayCost: null,
    weekCost: null,
    generating: false,
    rolloutTurnActive: null,
    pendingTurnStart: false,
    generationEndTimer: null,
    suppressStopUntilGone: false,
    turnHasUsage: false,
    turnId: "",
    collapsed: false,
    root: null,
    observer: null,
    appearanceTimer: null,
    domSyncScheduled: false,
    newChatPage: null,
    newChatIntent: false,
    normalComposerAppearance: { background: "", radius: "", shadow: "" },
    messageHandler: null,
    bridgeHandler: null,
    navigationHandler: null,
    originals: {},
  };

  function emptyUsage() {
    return { input: 0, output: 0, cached: 0, total: 0 };
  }

  function emptyPricingUsage() {
    return { standard: emptyUsage(), longContext: emptyUsage() };
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
    return {
      input,
      output,
      cached: Math.min(cached, input || cached),
      total,
    };
  }

  function normalizePricingUsage(source) {
    if (!source || typeof source !== "object") return null;
    const standard = normalizeUsage(source.standard);
    const longContext = normalizeUsage(source.long_context || source.longContext);
    return standard && longContext ? { standard, longContext } : null;
  }

  function addUsage(target, usage) {
    return {
      input: target.input + usage.input,
      output: target.output + usage.output,
      cached: target.cached + usage.cached,
      total: target.total + usage.total,
    };
  }

  function usageTier(usage) {
    return usage.input > Number(CONFIG.longContextThresholdTokens || 272000)
      ? "longContext"
      : "standard";
  }

  function addPricingUsage(target, usage) {
    const tier = usageTier(usage);
    return { ...target, [tier]: addUsage(target[tier], usage) };
  }

  function resetThreadUsage() {
    state.current = emptyUsage();
    state.currentPricingUsage = emptyPricingUsage();
    state.lastCompleted = emptyUsage();
    state.lastCompletedPricingUsage = emptyPricingUsage();
    state.session = emptyUsage();
    state.sessionPricingUsage = null;
    state.sessionAvailable = false;
    state.turnHasUsage = false;
    state.turnId = "";
    state.rolloutTurnActive = null;
    state.generating = detectGenerating();
    state.pendingTurnStart = state.generating;
    state.suppressStopUntilGone = false;
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

      const costSummary = node.cost_summary || node.costSummary;
      if (costSummary && typeof costSummary === "object") {
        const todayCost = Number(costSummary.today);
        const weekCost = Number(costSummary.week);
        state.todayCost = Number.isFinite(todayCost) ? todayCost : null;
        state.weekCost = Number.isFinite(weekCost) ? weekCost : null;
        changed = true;
      }

      const hudContext = node.__codex_hud_context;
      if (hudContext && typeof hudContext === "object") {
        const nextThreadId = String(hudContext.thread_id || "");
        const threadChanged = nextThreadId !== state.activeThreadId;
        if (threadChanged) {
          resetThreadUsage();
          if (nextThreadId) state.newChatIntent = false;
          changed = true;
        }
        state.activeThreadId = nextThreadId;
      }

      const nodeType = String(node.type || "");
      if (nodeType === "task_started") {
        const turnId = String(node.turn_id || node.turnId || node.id || "");
        if (state.suppressStopUntilGone) return;
        const replayedWhileIdle = !state.generating && !state.pendingTurnStart && !detectGenerating();
        const differentTurnWhileActive = state.generating
          && !state.pendingTurnStart
          && Boolean(state.turnId && turnId && turnId !== state.turnId);
        if (replayedWhileIdle || differentTurnWhileActive) return;
        if (!state.pendingTurnStart && (!state.generating || (turnId && turnId !== state.turnId))) {
          rememberCurrentTurn();
          state.current = emptyUsage();
          state.currentPricingUsage = emptyPricingUsage();
          state.turnHasUsage = false;
        }
        state.turnId = turnId;
        state.rolloutTurnActive = true;
        state.newChatIntent = false;
        state.generating = true;
        state.pendingTurnStart = false;
        changed = true;
      } else if (nodeType === "task_complete" || nodeType === "turn_aborted") {
        const turnId = String(node.turn_id || node.turnId || node.id || "");
        const exactTurn = Boolean(turnId && state.turnId && turnId === state.turnId);
        if (exactTurn || (!state.pendingTurnStart && (!turnId || !state.turnId || turnId === state.turnId))) {
          state.rolloutTurnActive = false;
          finishGenerating();
          changed = true;
        }
      }

      const tokenNode = nodeType === "token_count" ? node : null;
      if (tokenNode?.info && typeof tokenNode.info === "object") {
        const previousSessionTotal = state.session.total;
        const lastRequest = normalizeUsage(
          tokenNode.info.last_token_usage || tokenNode.info.lastTokenUsage || tokenNode.info.last_usage,
        );
        const session = normalizeUsage(
          tokenNode.info.total_token_usage || tokenNode.info.totalTokenUsage || tokenNode.info.total_usage,
        );
        const pricingUsage = normalizePricingUsage(
          tokenNode.info.pricing_tier_usage || tokenNode.info.pricingTierUsage,
        );
        const currentTurn = normalizeUsage(
          tokenNode.info.current_turn_usage || tokenNode.info.currentTurnUsage,
        );
        const currentTurnPricing = normalizePricingUsage(
          tokenNode.info.current_turn_pricing_usage || tokenNode.info.currentTurnPricingUsage,
        );
        const lastCompletedTurn = normalizeUsage(
          tokenNode.info.last_completed_turn_usage || tokenNode.info.lastCompletedTurnUsage,
        );
        const lastCompletedTurnPricing = normalizePricingUsage(
          tokenNode.info.last_completed_turn_pricing_usage || tokenNode.info.lastCompletedTurnPricingUsage,
        );
        if (lastCompletedTurn?.total > 0) {
          state.lastCompleted = lastCompletedTurn;
          state.lastCompletedPricingUsage = lastCompletedTurnPricing || emptyPricingUsage();
        }
        const hasCurrentTurnActive = Object.prototype.hasOwnProperty.call(tokenNode.info, "current_turn_active")
          || Object.prototype.hasOwnProperty.call(tokenNode.info, "currentTurnActive");
        const snapshotTurnActive = hasCurrentTurnActive
          ? Boolean(tokenNode.info.current_turn_active ?? tokenNode.info.currentTurnActive)
          : null;
        const snapshotTurnId = String(tokenNode.info.current_turn_id || tokenNode.info.currentTurnId || "");
        const staleCompletedSnapshot = snapshotTurnActive === false && detectGenerating();

        if (hasCurrentTurnActive) state.rolloutTurnActive = snapshotTurnActive;

        if (currentTurn && !staleCompletedSnapshot) {
          state.current = currentTurn;
          state.currentPricingUsage = currentTurnPricing || emptyPricingUsage();
          state.turnHasUsage = currentTurn.total > 0;
          state.turnId = snapshotTurnId || state.turnId;
          if (hasCurrentTurnActive) {
            if (snapshotTurnActive) {
              state.generating = true;
              state.pendingTurnStart = false;
            } else {
              finishGenerating();
            }
          }
          changed = true;
        } else if (lastRequest && session && session.total > previousSessionTotal) {
          if (state.generating) {
            state.current = addUsage(state.current, lastRequest);
            state.currentPricingUsage = addPricingUsage(state.currentPricingUsage, lastRequest);
          } else {
            state.current = lastRequest;
            state.currentPricingUsage = addPricingUsage(emptyPricingUsage(), lastRequest);
          }
          state.turnHasUsage = true;
          changed = true;
        }
        if (session) {
          state.session = session;
          state.sessionAvailable = session.total > 0;
          changed = true;
        }
        if (pricingUsage) {
          state.sessionPricingUsage = pricingUsage;
        } else if (lastRequest && session && state.sessionPricingUsage && session.total > previousSessionTotal) {
          state.sessionPricingUsage = addPricingUsage(state.sessionPricingUsage, lastRequest);
        } else if (session && session.total < previousSessionTotal) {
          state.sessionPricingUsage = null;
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

  function rawUsageCost(usage, price) {
    const cached = Math.min(usage.cached, usage.input);
    const uncached = Math.max(0, usage.input - cached);
    return (
      uncached * Number(price.input || 0) +
      cached * Number(price.cachedInput ?? price.input ?? 0) +
      usage.output * Number(price.output || 0)
    ) / 1_000_000;
  }

  function usageCost(usage, pricingUsage = null) {
    const price = CONFIG.prices?.[normalizedModel()];
    if (!price) return null;
    const configuredMultiplier = Number(CONFIG.priceMultiplier ?? 1);
    const multiplier = Number.isFinite(configuredMultiplier) && configuredMultiplier >= 0
      ? configuredMultiplier
      : 1;
    if (pricingUsage) {
      return multiplier * (
        rawUsageCost(pricingUsage.standard, price) +
        rawUsageCost(pricingUsage.longContext, price.longContext || price)
      );
    }
    const requestPrice = usage.input > Number(CONFIG.longContextThresholdTokens || 272000)
      ? price.longContext || price
      : price;
    return multiplier * rawUsageCost(usage, requestPrice);
  }

  function formatMoney(value) {
    if (!Number.isFinite(value)) return "--";
    if (value > 0 && value < 0.001) return "<$0.001";
    return `$${value.toFixed(value < 0.1 ? 3 : 2)}`;
  }

  function cachePercent(usage) {
    return usage.input ? `${Math.round((usage.cached / usage.input) * 100)}%` : "0%";
  }

  function activeTurnColor() {
    const color = String(CONFIG.activeTurnColor || "#f59e0b").trim();
    return window.CSS?.supports?.("color", color) ? color : "#f59e0b";
  }

  function uiTemplate() {
    return Number(CONFIG.uiTemplate) === 2 ? 2 : 1;
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
        --codex-hud-active-turn: #f59e0b;
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
      #${ROOT_ID}[data-active-turn="true"] [data-turn-value] { color: var(--codex-hud-active-turn); }
      #${ROOT_ID}[data-transparent="true"] {
        background: transparent;
        border-color: transparent;
        box-shadow: none;
        backdrop-filter: none;
      }
      #${ROOT_ID}[data-transparent="true"] .codex-hud-head { border-bottom-color: transparent; }
      #${ROOT_ID}[data-template="2"][data-transparent="false"] {
        --codex-hud-bg: color-mix(
          in srgb,
          var(--color-background-elevated-secondary-opaque, var(--color-token-bg-primary, #18181b)) 100%,
          transparent
        );
        background: var(--codex-hud-composer-bg, var(--codex-hud-bg)) !important;
        border-radius: var(--codex-hud-composer-radius, 16px) !important;
        box-shadow: var(
          --codex-hud-composer-shadow,
          rgba(0, 0, 0, .04) 0 0 0 1px,
          rgba(0, 0, 0, .04) 0 2px 8px,
          rgba(0, 0, 0, .024) 0 4px 80px 8px
        ) !important;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
      }
      #${ROOT_ID}[data-template="2"] {
        position: relative;
        inset: auto;
        z-index: 10;
        width: 100%;
        height: 34px;
        min-height: 34px;
        display: flex;
        align-items: center;
        gap: 0;
        padding: 0 10px;
        overflow-x: auto;
        overflow-y: hidden;
        border: 0;
        border-radius: 8px;
        box-shadow: none;
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        scrollbar-width: none;
        cursor: default;
      }
      #${ROOT_ID}[data-template="2"]::-webkit-scrollbar { display: none; }
      #${ROOT_ID}[data-template="2"] .codex-hud-inline-stat {
        flex: 0 0 auto;
        display: flex;
        align-items: baseline;
        gap: 8px;
        min-width: 0;
        box-sizing: border-box;
        padding: 0 4px;
        white-space: nowrap;
      }
      #${ROOT_ID}[data-template="2"] .codex-hud-inline-stat[data-stat="input"] { width: 76px; }
      #${ROOT_ID}[data-template="2"] .codex-hud-inline-stat[data-stat="output"] { width: 84px; }
      #${ROOT_ID}[data-template="2"] .codex-hud-inline-stat[data-stat="session"] { width: 90px; }
      #${ROOT_ID}[data-template="2"] .codex-hud-inline-stat[data-stat="cache"] { width: 68px; }
      #${ROOT_ID}[data-template="2"] .codex-hud-inline-stat[data-stat="turn"] { width: 82px; }
      #${ROOT_ID}[data-template="2"] .codex-hud-inline-stat[data-stat="cost"] { width: 112px; }
      #${ROOT_ID}[data-template="2"] .codex-hud-inline-stat[data-stat="today"] { width: 84px; }
      #${ROOT_ID}[data-template="2"] .codex-hud-inline-stat[data-stat="week"] { width: 84px; }
      #${ROOT_ID}[data-template="2"] .codex-hud-inline-group {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
      }
      #${ROOT_ID}[data-template="2"] .codex-hud-inline-group:first-child { margin-left: auto; }
      #${ROOT_ID}[data-template="2"] .codex-hud-inline-group:last-child { margin-right: auto; }
      #${ROOT_ID}[data-template="2"] .codex-hud-inline-group + .codex-hud-inline-group {
        margin-left: 6px;
        padding-left: 6px;
        border-left: 1px solid color-mix(in srgb, var(--codex-hud-text) 24%, transparent);
      }
      #${ROOT_ID}[data-template="2"] .codex-hud-inline-label {
        color: var(--codex-hud-muted);
        font-size: 10px;
      }
      #${ROOT_ID}[data-template="2"] .codex-hud-inline-value {
        color: var(--codex-hud-text);
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        text-align: left;
      }
      #${ROOT_ID}[data-template="2"][data-active-turn="true"] [data-turn-value] {
        color: var(--codex-hud-active-turn);
      }
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

  function visibleComposerEditor() {
    const preferred = document.querySelector('[contenteditable="true"][aria-label="Do anything"]');
    if (preferred?.getClientRects().length) return preferred;
    return [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')]
      .find((editor) => editor.getClientRects().length > 0) || null;
  }

  function selectedThreadId() {
    return document
      .querySelector('[data-app-action-sidebar-thread-selected="true"][data-app-action-sidebar-thread-id]')
      ?.getAttribute("data-app-action-sidebar-thread-id")
      ?.replace(/^local:/, "") || "";
  }

  function visibleChooseProject() {
    const editor = visibleComposerEditor();
    const composer = editor?.closest('[class*="_ComposerLayoutRoot_"]');
    if (!composer) return false;
    const scope = composer.parentElement?.parentElement?.parentElement || composer.parentElement || composer;
    const composerRect = composer.getBoundingClientRect();
    const exactLabel = (value) => /^(?:Choose project|选择项目)$/i.test(
      String(value || "").replace(/\s+/g, " ").trim(),
    );
    const nearComposer = (element) => {
      if (!element?.getClientRects().length) return false;
      const rect = element.getBoundingClientRect();
      const gap = composerRect.top - rect.bottom;
      const overlapsHorizontally = rect.right > composerRect.left && rect.left < composerRect.right;
      return overlapsHorizontally && gap >= 0 && gap <= 180;
    };
    if ([...scope.querySelectorAll('[aria-label]')].some((element) => (
      exactLabel(element.getAttribute("aria-label")) && nearComposer(element)
    ))) return true;

    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (exactLabel(node.nodeValue) && nearComposer(node.parentElement)) return true;
    }
    return false;
  }

  function detectNewChatPage() {
    if (!visibleComposerEditor()) return false;
    if (detectGenerating() || state.rolloutTurnActive === true) return false;
    if (state.newChatIntent) return true;
    if (visibleChooseProject()) return true;
    const chatActions = [...document.querySelectorAll('button[aria-label="Chat actions"], button[aria-label="聊天操作"]')]
      .some((button) => button.getClientRects().length > 0);
    return !chatActions;
  }

  function composerMount() {
    const editor = visibleComposerEditor();
    const layoutRoot = editor?.closest('[class*="_ComposerLayoutRoot_"]');
    const layoutContainer = layoutRoot?.parentElement;
    const wrapper = layoutContainer?.parentElement;
    if (!wrapper || !wrapper.contains(editor)) return null;
    return { wrapper, before: layoutContainer, layoutRoot };
  }

  function opaqueColor(value) {
    const color = String(value || "").trim();
    if (!color) return color;
    if (/\/[\s\d.]+%?\s*\)$/i.test(color)) {
      return color.replace(/\/[\s\d.]+%?\s*\)$/i, "/ 1)");
    }
    if (/^rgba\(/i.test(color) && color.includes(",")) {
      return color.replace(/,\s*[\d.]+%?\s*\)$/i, ", 1)");
    }
    return color;
  }

  function transparentColor(value) {
    const color = String(value || "").trim().toLowerCase();
    if (!color || color === "transparent") return true;
    const slashAlpha = color.match(/\/\s*([\d.]+)(%)?\s*\)$/);
    if (slashAlpha) {
      const alpha = Number(slashAlpha[1]) / (slashAlpha[2] ? 100 : 1);
      return Number.isFinite(alpha) && alpha <= 0;
    }
    const commaAlpha = color.match(/^rgba\([^)]*,\s*([\d.]+)(%)?\s*\)$/);
    if (commaAlpha) {
      const alpha = Number(commaAlpha[1]) / (commaAlpha[2] ? 100 : 1);
      return Number.isFinite(alpha) && alpha <= 0;
    }
    return false;
  }

  function composerBackground(root, layoutRoot) {
    const style = getComputedStyle(layoutRoot);
    const candidates = [
      style.backgroundColor,
      getComputedStyle(layoutRoot, "::before").backgroundColor,
      getComputedStyle(layoutRoot, "::after").backgroundColor,
    ];
    let ancestor = layoutRoot.parentElement;
    for (let depth = 0; ancestor && depth < 3; depth++, ancestor = ancestor.parentElement) {
      candidates.push(getComputedStyle(ancestor).backgroundColor);
    }
    candidates.push(
      root.style.getPropertyValue("--codex-hud-composer-bg"),
      style.getPropertyValue("--color-background-elevated-secondary-opaque"),
      style.getPropertyValue("--color-token-bg-primary"),
    );
    return candidates.map((value) => String(value || "").trim()).find((value) => !transparentColor(value)) || "";
  }

  function syncComposerAppearance(root, mount = composerMount()) {
    if (!root || !mount?.layoutRoot || uiTemplate() !== 2) return;
    const style = getComputedStyle(mount.layoutRoot);
    const newChatPage = detectNewChatPage();
    const savedAppearance = state.normalComposerAppearance;
    const previousBackground = root.style.getPropertyValue("--codex-hud-composer-bg").trim()
      || savedAppearance.background;
    const previousRadius = root.style.getPropertyValue("--codex-hud-composer-radius").trim()
      || savedAppearance.radius;
    const previousShadow = root.style.getPropertyValue("--codex-hud-composer-shadow").trim()
      || savedAppearance.shadow;
    const reuseNormalAppearance = newChatPage && Boolean(savedAppearance.background);
    const background = reuseNormalAppearance
      ? savedAppearance.background
      : opaqueColor(composerBackground(root, mount.layoutRoot));
    const radius = reuseNormalAppearance
      ? savedAppearance.radius || "25px"
      : transparentColor(style.backgroundColor)
        ? previousRadius || "25px"
        : style.borderRadius || previousRadius || "25px";
    const shadow = reuseNormalAppearance ? savedAppearance.shadow : style.boxShadow;
    if (!newChatPage) {
      state.normalComposerAppearance = { background, radius, shadow };
    }
    const properties = {
      "--codex-hud-composer-bg": background,
      "--codex-hud-composer-radius": radius,
      "--codex-hud-composer-shadow": shadow,
    };
    for (const [name, value] of Object.entries(properties)) {
      if (value && root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
    }
    if (root.dataset.transparent === "false") {
      root.style.setProperty("background-color", background, "important");
      root.style.setProperty("border-radius", radius, "important");
      if (shadow) root.style.setProperty("box-shadow", shadow, "important");
      else root.style.removeProperty("box-shadow");
    } else {
      root.style.removeProperty("background-color");
      root.style.removeProperty("border-radius");
      root.style.removeProperty("box-shadow");
    }
  }

  function templateOneMarkup() {
    return `
      <div class="codex-hud-head">
        <span class="codex-hud-title">codex-hud</span>
        <span class="codex-hud-model" data-value="model">--</span>
      </div>
      <div class="codex-hud-body">
        <div class="codex-hud-stat"><span class="codex-hud-label">input</span><span class="codex-hud-value" data-value="turn-input" data-turn-value>0</span></div>
        <div class="codex-hud-stat"><span class="codex-hud-label">output</span><span class="codex-hud-value" data-value="turn-output" data-turn-value>0</span></div>
        <div class="codex-hud-stat"><span class="codex-hud-label">session tokens</span><span class="codex-hud-value" data-value="session-total">0</span></div>
        <div class="codex-hud-stat"><span class="codex-hud-label">cache hits</span><span class="codex-hud-value" data-value="cache-rate">0%</span></div>
        <div class="codex-hud-stat"><span class="codex-hud-label">turn cost</span><span class="codex-hud-value" data-value="turn-cost" data-turn-value>--</span></div>
        <div class="codex-hud-stat"><span class="codex-hud-label">session cost</span><span class="codex-hud-value" data-value="session-cost">--</span></div>
        <div class="codex-hud-stat"><span class="codex-hud-label">today cost</span><span class="codex-hud-value" data-value="today-cost">--</span></div>
        <div class="codex-hud-stat"><span class="codex-hud-label">week cost</span><span class="codex-hud-value" data-value="week-cost">--</span></div>
      </div>
    `;
  }

  function templateTwoMarkup() {
    const stat = (label, value, slot, turnValue = false) => `
      <div class="codex-hud-inline-stat" data-stat="${slot}">
        <span class="codex-hud-inline-label">${label}</span>
        <span class="codex-hud-inline-value" data-value="${value}"${turnValue ? " data-turn-value" : ""}>--</span>
      </div>`;
    return `
      <div class="codex-hud-inline-group" data-group="tokens">
        ${stat("input", "turn-input", "input", true)}
        ${stat("output", "turn-output", "output", true)}
        ${stat("session", "session-total", "session")}
        ${stat("cache", "cache-rate", "cache")}
      </div>
      <div class="codex-hud-inline-group" data-group="turn-costs">
        ${stat("turn", "turn-cost", "turn", true)}
        ${stat("session cost", "session-cost", "cost")}
      </div>
      <div class="codex-hud-inline-group" data-group="period-costs">
        ${stat("today", "today-cost", "today")}
        ${stat("week", "week-cost", "week")}
      </div>
    `;
  }

  function ensureRoot() {
    ensureStyle();
    const template = uiTemplate();
    const mount = template === 2 ? composerMount() : null;
    if (state.root?.isConnected && Number(state.root.dataset.template) === template) {
      if (template === 1 || !mount) return state.root;
      if (state.root.parentElement !== mount.wrapper) {
        mount.wrapper.insertBefore(state.root, mount.before);
      }
      syncComposerAppearance(state.root, mount);
      return state.root;
    }
    document.getElementById(ROOT_ID)?.remove();
    if (template === 2 && !mount) return null;
    const root = document.createElement("section");
    root.id = ROOT_ID;
    root.setAttribute("aria-label", "codex-hud");
    root.dataset.template = String(template);
    root.dataset.transparent = String(CONFIG.transparent === true);
    root.style.setProperty("--codex-hud-active-turn", activeTurnColor());
    root.innerHTML = template === 2 ? templateTwoMarkup() : templateOneMarkup();
    if (template === 2) mount.wrapper.insertBefore(root, mount.before);
    else (document.body || document.documentElement).appendChild(root);
    if (template === 2) syncComposerAppearance(root, mount);
    state.root = root;
    if (template === 1) {
      installDrag(root);
      requestAnimationFrame(() => applySavedPosition(root));
    }
    return root;
  }

  function setValue(root, name, value) {
    const node = root.querySelector(`[data-value="${name}"]`);
    if (node && node.textContent !== value) node.textContent = value;
  }

  function detectGenerating() {
    return [...document.querySelectorAll('button[aria-label="Stop"], button[aria-label="停止"]')]
      .some((button) => button.getClientRects().length > 0);
  }

  function rememberCurrentTurn() {
    if (state.current.total <= 0) return;
    state.lastCompleted = { ...state.current };
    state.lastCompletedPricingUsage = {
      standard: { ...state.currentPricingUsage.standard },
      longContext: { ...state.currentPricingUsage.longContext },
    };
  }

  function composerHasDraft() {
    const editor = visibleComposerEditor();
    return Boolean(editor && String(editor.textContent || "").trim());
  }

  function finishGenerating() {
    if (state.generationEndTimer) {
      clearTimeout(state.generationEndTimer);
      state.generationEndTimer = null;
    }
    rememberCurrentTurn();
    if (state.current.total <= 0 && state.lastCompleted.total > 0) {
      state.current = { ...state.lastCompleted };
      state.currentPricingUsage = {
        standard: { ...state.lastCompletedPricingUsage.standard },
        longContext: { ...state.lastCompletedPricingUsage.longContext },
      };
      state.turnHasUsage = true;
    }
    state.generating = false;
    state.rolloutTurnActive = false;
    state.pendingTurnStart = false;
    state.suppressStopUntilGone = detectGenerating();
  }

  function scheduleGenerationEnd() {
    if (state.generationEndTimer) return;
    const delay = composerHasDraft() ? 1200 : 750;
    state.generationEndTimer = setTimeout(() => {
      state.generationEndTimer = null;
      if (detectGenerating() || state.rolloutTurnActive === true) return;
      finishGenerating();
      render();
    }, delay);
  }

  function syncGenerating() {
    if (detectNewChatPage()) {
      if (state.generating || state.pendingTurnStart) {
        finishGenerating();
        render();
      }
      return;
    }
    const generating = detectGenerating() || state.rolloutTurnActive === true;
    if (!generating) {
      state.suppressStopUntilGone = false;
      if (state.generating) scheduleGenerationEnd();
      return;
    }
    if (state.generationEndTimer) {
      clearTimeout(state.generationEndTimer);
      state.generationEndTimer = null;
    }
    if (state.suppressStopUntilGone || state.generating) return;
    rememberCurrentTurn();
    state.current = emptyUsage();
    state.currentPricingUsage = emptyPricingUsage();
    state.turnHasUsage = false;
    state.turnId = "";
    state.generating = true;
    state.pendingTurnStart = true;
    render();
  }

  function render() {
    const root = ensureRoot();
    if (!root) return;
    const newChatPage = detectNewChatPage();
    if (newChatPage && state.newChatPage !== true) resetThreadUsage();
    if (newChatPage && (state.generating || state.pendingTurnStart)) finishGenerating();
    state.newChatPage = newChatPage;
    root.dataset.newChat = String(newChatPage);
    root.dataset.transparent = String(newChatPage ? false : CONFIG.transparent === true);
    syncComposerAppearance(root);
    const waitingForUsage = state.generating && !state.turnHasUsage;
    const turnUnavailable = !state.generating && !state.sessionAvailable;
    const sessionUnavailable = !state.sessionAvailable;
    root.dataset.activeTurn = String(state.generating && state.turnHasUsage);
    setValue(root, "model", state.model || "");
    setValue(root, "turn-input", newChatPage || turnUnavailable ? "--" : waitingForUsage ? "..." : formatCount(state.current.input));
    setValue(root, "turn-output", newChatPage || turnUnavailable ? "--" : waitingForUsage ? "..." : formatCount(state.current.output));
    setValue(root, "session-total", newChatPage || sessionUnavailable ? "--" : formatCount(state.session.total));
    setValue(root, "cache-rate", newChatPage || sessionUnavailable ? "--" : cachePercent(state.session));
    setValue(root, "turn-cost", newChatPage || turnUnavailable ? "--" : waitingForUsage ? "..." : formatMoney(usageCost(state.current, state.currentPricingUsage)));
    setValue(root, "session-cost", newChatPage || sessionUnavailable ? "--" : formatMoney(usageCost(state.session, state.sessionPricingUsage)));
    setValue(root, "today-cost", formatMoney(state.todayCost));
    setValue(root, "week-cost", formatMoney(state.weekCost));
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
    if (state.appearanceTimer) clearInterval(state.appearanceTimer);
    if (state.generationEndTimer) clearTimeout(state.generationEndTimer);
    if (state.messageHandler) window.removeEventListener("message", state.messageHandler, true);
    if (state.bridgeHandler) window.removeEventListener("codex-message-from-view", state.bridgeHandler, true);
    if (state.navigationHandler) document.removeEventListener("click", state.navigationHandler, true);
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
  state.navigationHandler = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('[data-app-action-sidebar-thread-id]')) {
      state.newChatIntent = false;
      return;
    }
    const control = target.closest('button, [role="button"]');
    const label = String(control?.getAttribute("aria-label") || "").trim();
    const text = String(control?.textContent || "").trim();
    if (
      /^(?:New chat|新建聊天)$|^Start new chat in /i.test(label) ||
      /^(?:New chat|新建聊天)$/i.test(text)
    ) {
      state.newChatIntent = true;
      render();
    }
  };
  document.addEventListener("click", state.navigationHandler, true);
  state.observer = new MutationObserver(() => {
    if (state.domSyncScheduled) return;
    state.domSyncScheduled = true;
    requestAnimationFrame(() => {
      state.domSyncScheduled = false;
      syncGenerating();
      const newChatPage = detectNewChatPage();
      let needsRender = state.newChatPage !== newChatPage;
      if (uiTemplate() === 2) {
        const mount = composerMount();
        if (state.root?.isConnected && mount) syncComposerAppearance(state.root, mount);
        needsRender = needsRender || !state.root?.isConnected || (mount && state.root.parentElement !== mount.wrapper);
      } else if (!document.getElementById(ROOT_ID)) {
        needsRender = true;
      }
      if (needsRender) render();
    });
  });
  state.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-label", "class", "hidden", "style"],
  });
  if (uiTemplate() === 2) {
    state.appearanceTimer = setInterval(() => {
      const root = state.root?.isConnected ? state.root : null;
      const mount = composerMount();
      if (root && mount) syncComposerAppearance(root, mount);
    }, 250);
  }
  window.__codexHud = { version: VERSION, configKey: CONFIG_KEY, ensure: render, inspect, destroy };
  state.generating = detectGenerating();
  state.pendingTurnStart = state.generating;
  render();
})();
