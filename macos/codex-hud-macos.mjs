#!/usr/bin/env node

import fs from "node:fs/promises";
import { watch as watchFs } from "node:fs";
import path from "node:path";
import process from "node:process";
import net from "node:net";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const UUID = "[0-9a-fA-F-]{36}";
const sessionIdPattern = new RegExp(`^${UUID}$`);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const THREAD_BINDING = "__codexHudThreadChanged";
const THREAD_OBSERVER_KEY = "__codexHudThreadObserver";

function parseArgs(argv) {
  const options = { attachOnly: false, projectDir: "" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--attach-only") options.attachOnly = true;
    else if (argv[index] === "--project-dir") options.projectDir = argv[++index] || "";
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.projectDir) throw new Error("Missing --project-dir");
  return options;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function configBoolean(config, name, fallback) {
  if (config[name] === undefined) return fallback;
  if (typeof config[name] !== "boolean") throw new Error(`config.${name} must be true or false`);
  return config[name];
}

function validateConfig(config) {
  const port = Number(config.debugPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("config.debugPort must be between 1024 and 65535");
  const threshold = Number(config.longContextThresholdTokens ?? 272000);
  if (!Number.isFinite(threshold) || threshold <= 0) throw new Error("config.longContextThresholdTokens must be greater than zero");
  const template = Number(config.uiTemplate ?? 1);
  if (!Number.isInteger(template) || ![1, 2].includes(template)) throw new Error("config.uiTemplate must be 1 or 2");
  return {
    ...config,
    debugPort: port,
    pollIntervalMs: Math.max(1000, Number(config.pollIntervalMs || 2000)),
    longContextThresholdTokens: threshold,
    uiTemplate: template,
    hotReload: configBoolean(config, "hotReload", true),
    cleanupOldLogs: configBoolean(config, "cleanupOldLogs", true),
    cleanupOldLedger: configBoolean(config, "cleanupOldLedger", true),
    transparent: configBoolean(config, "transparent", false),
  };
}

function sourceRevision(source) {
  return createHash("sha256").update(source).digest("hex");
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function recursiveFiles(root) {
  const result = [];
  async function visit(directory) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(item);
      else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) result.push(item);
    }
  }
  await visit(root);
  return result;
}

class EventWake {
  constructor() {
    this.pending = false;
    this.waiters = new Set();
  }

  wake() {
    if (this.waiters.size === 0) this.pending = true;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  wait(timeout) {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        resolve();
      }, timeout);
      this.waiters.add(wake);
    });
  }
}

class RolloutIndex {
  constructor(roots, wake) {
    this.roots = roots;
    this.wake = wake;
    this.entries = new Map();
    this.bySessionId = new Map();
    this.watchers = [];
    this.pendingFiles = new Map();
    this.changedFiles = new Set();
    this.createdFiles = new Set();
  }

  async start() {
    await this.rescan();
    for (const root of this.roots) {
      if (!await exists(root)) continue;
      try {
        const watcher = watchFs(root, { recursive: true }, (_event, filename) => {
          if (!filename) {
            this.wake.wake();
            return;
          }
          const file = path.join(root, String(filename));
          if (path.basename(file).startsWith("rollout-") && file.endsWith(".jsonl")) this.schedule(file, _event === "rename");
        });
        watcher.on("error", () => this.wake.wake());
        this.watchers.push(watcher);
      } catch {
        // The periodic rescan remains available when FSEvents cannot watch a root.
      }
    }
  }

  close() {
    for (const watcher of this.watchers) watcher.close();
    for (const timer of this.pendingFiles.values()) clearTimeout(timer);
    this.watchers = [];
    this.pendingFiles.clear();
  }

  schedule(file, created) {
    if (this.pendingFiles.has(file)) clearTimeout(this.pendingFiles.get(file));
    this.pendingFiles.set(file, setTimeout(async () => {
      this.pendingFiles.delete(file);
      await this.register(file, created);
      this.wake.wake();
    }, 100));
  }

  remove(file) {
    const entry = this.entries.get(file);
    if (!entry) return;
    this.entries.delete(file);
    const files = this.bySessionId.get(entry.sessionId);
    files?.delete(file);
    if (files?.size === 0) this.bySessionId.delete(entry.sessionId);
  }

  async register(file, created = false) {
    let stats;
    try { stats = await fs.stat(file); } catch {
      this.remove(file);
      return false;
    }
    if (!stats.isFile()) {
      this.remove(file);
      return false;
    }
    const sessionId = await sessionIdFromRollout(file);
    if (!sessionId) return false;
    const existed = this.entries.has(file);
    this.remove(file);
    const normalized = sessionId.toLowerCase();
    this.entries.set(file, { sessionId: normalized, mtimeMs: stats.mtimeMs });
    if (!this.bySessionId.has(normalized)) this.bySessionId.set(normalized, new Set());
    this.bySessionId.get(normalized).add(file);
    this.changedFiles.add(file);
    if (created && !existed) this.createdFiles.add(file);
    return true;
  }

  async rescan() {
    const files = (await Promise.all(this.roots.map(recursiveFiles))).flat();
    const seen = new Set(files);
    for (const file of files) await this.register(file);
    for (const file of this.entries.keys()) {
      if (!seen.has(file)) this.remove(file);
    }
  }

  find(sessionId) {
    const files = this.bySessionId.get(String(sessionId || "").toLowerCase());
    if (!files?.size) return null;
    let newest = null;
    for (const file of files) {
      if (!newest || this.entries.get(file).mtimeMs > this.entries.get(newest).mtimeMs) newest = file;
    }
    return newest;
  }

  newest() {
    let newest = null;
    for (const [file, entry] of this.entries) {
      if (!newest || entry.mtimeMs > newest.mtimeMs) newest = { file, ...entry };
    }
    return newest;
  }

  takeChanged() {
    const files = [...this.changedFiles];
    this.changedFiles.clear();
    return files;
  }

  takeCreated() {
    const files = [...this.createdFiles];
    this.createdFiles.clear();
    return files;
  }
}

async function readFirstJsonLine(file) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0];
    return line ? JSON.parse(line) : null;
  } finally {
    await handle.close();
  }
}

function emptyUsage() {
  return { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

function emptyPricingUsage() {
  return { standard: emptyUsage(), long_context: emptyUsage() };
}

function copyUsage(usage) {
  return { ...usage };
}

function addUsage(target, usage) {
  for (const key of Object.keys(target)) target[key] += Number(usage?.[key] || 0);
}

function updateParser(state, row, threshold) {
  const payload = row?.payload || {};
  const type = payload.type || row?.type || "";
  if (type === "task_started") {
    state.currentTurnId = String(payload.turn_id || "");
    state.currentTurnActive = true;
    state.currentTurnUsage = emptyUsage();
    state.currentTurnPricingUsage = emptyPricingUsage();
    return;
  }
  if (type === "task_complete" || type === "turn_aborted") {
    if (String(payload.turn_id || "") === state.currentTurnId) {
      if (state.currentTurnUsage.total_tokens > 0) {
        state.lastCompletedTurnUsage = copyUsage(state.currentTurnUsage);
        state.lastCompletedTurnPricingUsage = {
          standard: copyUsage(state.currentTurnPricingUsage.standard),
          long_context: copyUsage(state.currentTurnPricingUsage.long_context),
        };
      }
      state.currentTurnActive = false;
    }
    return;
  }
  if (type === "turn_context" && payload.model) {
    state.model = String(payload.model);
    return;
  }
  if (type !== "token_count" || !payload.info) return;
  state.lastToken = payload;
  const last = payload.info.last_token_usage;
  const total = payload.info.total_token_usage;
  if (!last || !total) return;
  const cumulative = Number(total.total_tokens || 0);
  if (cumulative === state.lastCumulativeTotal) return;
  if (state.lastCumulativeTotal < 0) {
    const baseline = {
      input_tokens: Math.max(0, Number(total.input_tokens || 0) - Number(last.input_tokens || 0)),
      cached_input_tokens: Math.max(0, Number(total.cached_input_tokens || 0) - Number(last.cached_input_tokens || 0)),
      output_tokens: Math.max(0, Number(total.output_tokens || 0) - Number(last.output_tokens || 0)),
      total_tokens: Math.max(0, cumulative - Number(last.total_tokens || 0)),
    };
    addUsage(state.tieredUsage.standard, baseline);
  }
  const tier = Number(last.input_tokens || 0) > threshold ? "long_context" : "standard";
  addUsage(state.tieredUsage[tier], last);
  if (state.currentTurnId) {
    addUsage(state.currentTurnUsage, last);
    addUsage(state.currentTurnPricingUsage[tier], last);
  }
  state.lastCumulativeTotal = cumulative;
}

function newParserState() {
  return {
    model: "", lastToken: null, lastCumulativeTotal: -1, tieredUsage: emptyPricingUsage(),
    currentTurnId: "", currentTurnActive: false, currentTurnUsage: emptyUsage(),
    currentTurnPricingUsage: emptyPricingUsage(), lastCompletedTurnUsage: emptyUsage(),
    lastCompletedTurnPricingUsage: emptyPricingUsage(),
  };
}

async function parseRollout(file, index, threshold, state = newParserState(), visited = new Set(), limit = {}) {
  const key = path.resolve(file).toLowerCase();
  if (visited.has(key)) return state;
  visited.add(key);
  const meta = await readFirstJsonLine(file);
  const history = meta?.type === "session_meta" ? meta.payload?.history_base : null;
  if (history?.thread_id) {
    const parent = index.find(String(history.thread_id));
    if (parent) await parseRollout(parent, index, threshold, state, visited, {
      bytes: history.end_byte_offset ?? null,
      ordinal: history.end_ordinal_exclusive ?? null,
    });
  }
  const source = await fs.readFile(file);
  const byteLimit = limit.bytes === null || limit.bytes === undefined ? source.length : Math.min(source.length, Number(limit.bytes));
  const text = source.subarray(0, byteLimit).toString("utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (limit.ordinal !== null && limit.ordinal !== undefined && Number(row.ordinal) >= Number(limit.ordinal)) continue;
      updateParser(state, row, threshold);
    } catch { /* A partially written JSONL line is retried on the next poll. */ }
  }
  return state;
}

async function readRolloutAppend(state, file, offset, end, threshold) {
  const length = end - offset;
  if (length <= 0) return offset;
  if (length > 0x7fffffff) throw new Error("Rollout append is too large to parse");
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const complete = buffer.subarray(0, bytesRead);
    const lastNewline = complete.lastIndexOf(10);
    if (lastNewline < 0) return offset;
    for (const line of complete.subarray(0, lastNewline + 1).toString("utf8").split(/\r?\n/)) {
      if (!line) continue;
      try { updateParser(state, JSON.parse(line), threshold); } catch { /* The next append retries malformed JSONL. */ }
    }
    return offset + lastNewline + 1;
  } finally {
    await handle.close();
  }
}

async function initializeIncrementalParser(file, index, threshold) {
  const state = newParserState();
  const meta = await readFirstJsonLine(file);
  const history = meta?.type === "session_meta" ? meta.payload?.history_base : null;
  if (history?.thread_id) {
    const parent = index.find(String(history.thread_id));
    if (parent) await parseRollout(parent, index, threshold, state, new Set([path.resolve(file).toLowerCase()]), {
      bytes: history.end_byte_offset ?? null,
      ordinal: history.end_ordinal_exclusive ?? null,
    });
  }
  return { state, offset: 0, size: 0, mtimeMs: 0 };
}

async function incrementalSnapshot(file, index, threshold, cache) {
  const stats = await fs.stat(file);
  let parser = cache.get(file);
  if (!parser || stats.size < parser.offset || (stats.size === parser.size && stats.mtimeMs !== parser.mtimeMs)) {
    parser = await initializeIncrementalParser(file, index, threshold);
    cache.set(file, parser);
  }
  if (stats.size > parser.offset) parser.offset = await readRolloutAppend(parser.state, file, parser.offset, stats.size, threshold);
  parser.size = stats.size;
  parser.mtimeMs = stats.mtimeMs;
  return snapshotFromState(parser.state);
}

function snapshotFromState(state) {
  if (!state.lastToken) return null;
  const info = {
    ...state.lastToken.info,
    pricing_tier_usage: state.tieredUsage,
    current_turn_usage: state.currentTurnUsage,
    current_turn_pricing_usage: state.currentTurnPricingUsage,
    last_completed_turn_usage: state.lastCompletedTurnUsage,
    last_completed_turn_pricing_usage: state.lastCompletedTurnPricingUsage,
    current_turn_active: state.currentTurnActive,
    current_turn_id: state.currentTurnId,
  };
  return { model: state.model, payload: { ...state.lastToken, info } };
}

function assertDebuggerUrl(url, port) {
  const parsed = new URL(url);
  if (!new Set(["ws:", "wss:"]).has(parsed.protocol) || !LOOPBACK_HOSTS.has(parsed.hostname) || Number(parsed.port) !== port) {
    throw new Error("Rejected an unsafe CDP WebSocket endpoint");
  }
  return parsed.toString();
}

class CdpSession {
  constructor(debuggerUrl, port) {
    this.debuggerUrl = assertDebuggerUrl(debuggerUrl, port);
    this.nextId = 1;
    this.pending = new Map();
    this.eventListeners = new Set();
    this.closed = false;
  }

  async connect() {
    this.socket = new WebSocket(this.debuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connection timed out")), 5000);
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connection failed")); }, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        message.error ? pending.reject(new Error(`CDP: ${message.error.message}`)) : pending.resolve(message.result);
        return;
      }
      for (const listener of this.eventListeners) listener(message);
    });
    this.socket.addEventListener("close", () => {
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(new Error("CDP connection closed"));
      this.pending.clear();
    }, { once: true });
  }

  command(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, returnByValue = true) {
    const result = await this.command("Runtime.evaluate", { expression, returnByValue, awaitPromise: false });
    if (result.exceptionDetails) throw new Error(`Renderer evaluation failed: ${result.exceptionDetails.text || "unknown error"}`);
    return result.result?.value;
  }

  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  get isAlive() {
    return !this.closed && this.socket?.readyState === WebSocket.OPEN;
  }

  close() {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error("CDP connection closed"));
    this.pending.clear();
    this.socket?.close();
  }
}

const threadObserverSource = `(() => {
  const binding = ${JSON.stringify(THREAD_BINDING)};
  const stateKey = ${JSON.stringify(THREAD_OBSERVER_KEY)};
  try { window[stateKey]?.observer?.disconnect?.() || window[stateKey]?.disconnect?.(); } catch {}
  try { document.removeEventListener('click', window[stateKey]?.click, true); } catch {}

  let lastThreadKey = null;
  let lastGenerating = null;
  let scheduled = false;
  const report = () => {
    scheduled = false;
    const element = document.querySelector('[data-app-action-sidebar-thread-selected="true"][data-app-action-sidebar-thread-id]');
    const threadKey = element?.getAttribute('data-app-action-sidebar-thread-id') || '';
    const generating = [...document.querySelectorAll('button[aria-label="Stop"], button[aria-label="停止"]')]
      .some((button) => button.getClientRects().length > 0);
    if (threadKey === lastThreadKey && generating === lastGenerating) return;
    lastThreadKey = threadKey;
    lastGenerating = generating;
    try {
      if (typeof window[binding] === 'function') window[binding](JSON.stringify({ threadKey, generating }));
    } catch {}
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(report);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-app-action-sidebar-thread-selected', 'data-app-action-sidebar-thread-id'],
  });
  const click = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-app-action-sidebar-thread-id]')) {
      // React applies the selected attribute after its click handler. Recheck
      // after the event as well as after the following render commit.
      setTimeout(schedule, 50);
      setTimeout(schedule, 180);
    }
  };
  document.addEventListener('click', click, true);
  window[stateKey] = { observer, click };
  schedule();
})();`;

class ThreadSelectionListener {
  constructor(debuggerUrl, port, wake) {
    this.session = new CdpSession(debuggerUrl, port);
    this.pendingThreadKey = null;
    this.wake = wake;
    this.ready = false;
  }

  async connect() {
    this.session.onEvent((message) => {
      if (message.method !== "Runtime.bindingCalled" || message.params?.name !== THREAD_BINDING) return;
      try {
        const payload = JSON.parse(String(message.params.payload || "{}"));
        this.enqueue(String(payload.threadKey || ""));
      } catch { /* Ignore malformed renderer bridge messages. */ }
    });
    await this.session.connect();
    await this.session.command("Runtime.enable");
    await this.session.command("Runtime.addBinding", { name: THREAD_BINDING });
    await this.session.command("Page.addScriptToEvaluateOnNewDocument", { source: threadObserverSource });
    await this.session.evaluate(threadObserverSource, false);
    this.ready = true;
  }

  enqueue(threadKey) {
    this.pendingThreadKey = threadKey;
    this.wake.wake();
    // The sidebar selection can commit before the conversation panel finishes
    // resetting its HUD state. A bounded second sync avoids requiring a manual
    // switch away and back to make an already parsed turn visible.
    setTimeout(() => this.wake.wake(), 1000);
  }

  take() {
    const threadKey = this.pendingThreadKey;
    this.pendingThreadKey = null;
    return threadKey;
  }

  get isAlive() {
    return this.ready && this.session.isAlive;
  }

  close() {
    this.ready = false;
    this.session.close();
  }
}

async function cdpTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`CDP target listing failed: ${response.status}`);
  return response.json();
}

function selectTarget(targets) {
  return targets.find((target) => target.type === "page" && /^app:\/\/-\/index\.html/.test(target.url || "") && !/(avatar-overlay|quick-chat)/i.test(target.url || ""));
}

async function launchCodex(bundle, port) {
  await execFileAsync("/usr/bin/open", ["-na", bundle, "--args", `--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`, `--remote-allow-origins=http://127.0.0.1:${port}`]);
}

async function isLoopbackPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function bundleIdentifier(bundle) {
  try {
    const { stdout } = await execFileAsync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", path.join(bundle, "Contents", "Info.plist")]);
    return stdout.trim();
  } catch {
    return "com.openai.codex";
  }
}

async function isBundleRunning(bundle) {
  try {
    await execFileAsync("/usr/bin/pgrep", ["-f", `${bundle}/Contents/MacOS/`]);
    return true;
  } catch {
    return false;
  }
}

async function quitCodex(bundle) {
  const identifier = await bundleIdentifier(bundle);
  await execFileAsync("/usr/bin/osascript", ["-e", `tell application id ${JSON.stringify(identifier)} to quit`]);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!await isBundleRunning(bundle)) return;
    await sleep(250);
  }
  throw new Error("Codex did not exit within 15 seconds; close it manually before starting the HUD");
}

async function waitForTarget(port) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const target = selectTarget(await cdpTargets(port));
      if (target?.webSocketDebuggerUrl) return target;
    } catch { /* Codex is still starting. */ }
    await sleep(500);
  }
  throw new Error("Timed out waiting for a Codex CDP renderer");
}

async function ensureCodexTarget(port, bundle, attachOnly) {
  try {
    const target = selectTarget(await cdpTargets(port));
    if (target?.webSocketDebuggerUrl) return target;
  } catch { /* Start or recover below. */ }
  if (attachOnly) throw new Error(`No Codex CDP endpoint is available on port ${port}`);
  if (!bundle) throw new Error("Codex.app was not found. Set CODEX_APP or config.codexPath to its .app path.");
  if (await isLoopbackPortOpen(port)) {
    throw new Error(`CDP port ${port} is already in use by a process that is not a Codex renderer`);
  }
  if (await isBundleRunning(bundle)) await quitCodex(bundle);
  await launchCodex(bundle, port);
  return waitForTarget(port);
}

async function sessionIdFromRollout(file) {
  if (!file) return "";
  try {
    const meta = await readFirstJsonLine(file);
    const sessionId = String(meta?.payload?.session_id || "");
    return sessionIdPattern.test(sessionId) ? sessionId : "";
  } catch {
    return "";
  }
}

class UsageLedger {
  constructor(file, config) {
    this.file = file;
    this.config = config;
    this.sources = new Map();
    this.records = [];
    this.keys = new Set();
  }

  retentionStart() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const daysSinceMonday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - daysSinceMonday - 7);
    return start;
  }

  keep(timestamp) {
    if (this.config.cleanupOldLedger === false) return true;
    const parsed = new Date(timestamp);
    return Number.isNaN(parsed.valueOf()) || parsed >= this.retentionStart();
  }

  async load() {
    let document;
    try { document = await readJson(this.file); } catch { return; }
    for (const [source, value] of Object.entries(document.sources || {})) {
      const offset = Number(typeof value === "object" ? value.offset : value);
      this.sources.set(source, { offset: Number.isFinite(offset) ? offset : 0, model: String(value?.model || "") });
    }
    for (const record of document.records || []) {
      if (!record?.key || this.keys.has(record.key) || !this.keep(record.timestamp)) continue;
      this.records.push(record);
      this.keys.add(record.key);
    }
  }

  async save() {
    const sources = Object.fromEntries(this.sources);
    await fs.writeFile(this.file, `${JSON.stringify({ version: 3, sources, records: this.records }, null, 2)}\n`);
  }

  addRecord(sessionId, timestamp, model, usage) {
    const total = Number(usage?.total_tokens || 0);
    if (!sessionId || !model || !total || !this.keep(timestamp)) return false;
    const key = `${sessionId}:${total}`;
    if (this.keys.has(key)) return false;
    this.records.push({
      key,
      timestamp,
      model,
      input_tokens: Number(usage.input_tokens || 0),
      cached_input_tokens: Number(usage.cached_input_tokens || 0),
      output_tokens: Number(usage.output_tokens || 0),
    });
    this.keys.add(key);
    return true;
  }

  async importFile(file, sessionId) {
    let stats;
    try { stats = await fs.stat(file); } catch { return false; }
    let source = this.sources.get(file) || { offset: 0, model: "" };
    if (stats.size < source.offset) source = { offset: 0, model: "" };
    if (stats.size === source.offset) return false;
    const handle = await fs.open(file, "r");
    let changed = false;
    let nextOffset = source.offset;
    try {
      const length = stats.size - source.offset;
      if (length > 0 && length <= 0x7fffffff) {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, source.offset);
        const content = buffer.subarray(0, bytesRead);
        const lastNewline = content.lastIndexOf(10);
        if (lastNewline < 0) return false;
        nextOffset += lastNewline + 1;
        for (const line of content.subarray(0, lastNewline + 1).toString("utf8").split(/\r?\n/)) {
          try {
            const row = JSON.parse(line);
            const payload = row?.payload || {};
            if ((payload.type || row?.type) === "turn_context" && payload.model) source.model = String(payload.model);
            if ((payload.type || row?.type) === "token_count") changed = this.addRecord(sessionId, String(row.timestamp || ""), source.model, payload.info?.last_token_usage) || changed;
          } catch { /* Ignore incomplete or malformed JSONL rows. */ }
        }
      }
    } finally { await handle.close(); }
    source.offset = nextOffset;
    this.sources.set(file, source);
    return changed;
  }

  configuredPrice(model, inputTokens) {
    const name = String(model || "").toLowerCase();
    const prices = this.config.prices || {};
    const key = Object.keys(prices).find((item) => name === item.toLowerCase() || name.startsWith(`${item.toLowerCase()}-`));
    if (!key) return null;
    const price = prices[key];
    return inputTokens > Number(this.config.longContextThresholdTokens || 272000) && price.longContext ? price.longContext : price;
  }

  recordCost(record) {
    const input = Number(record.input_tokens || 0);
    const cached = Math.min(Number(record.cached_input_tokens || 0), input);
    const price = this.configuredPrice(record.model, input);
    if (!price) return 0;
    const multiplier = Math.max(0, Number(this.config.priceMultiplier ?? 1));
    return multiplier * ((input - cached) * Number(price.input || 0) + cached * Number(price.cachedInput ?? price.input ?? 0) + Number(record.output_tokens || 0) * Number(price.output || 0)) / 1e6;
  }

  summary() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const week = new Date(today);
    week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
    let todayCost = 0;
    let weekCost = 0;
    for (const record of this.records) {
      const timestamp = new Date(record.timestamp);
      if (Number.isNaN(timestamp.valueOf()) || timestamp < week) continue;
      const cost = this.recordCost(record);
      weekCost += cost;
      if (timestamp >= today) todayCost += cost;
    }
    return { today: todayCost, week: weekCost };
  }

  async sync(files, index) {
    let changed = false;
    for (const file of files) {
      const sessionId = index.entries.get(file)?.sessionId || await sessionIdFromRollout(file);
      changed = await this.importFile(file, sessionId) || changed;
    }
    if (changed || files.length > 0) await this.save();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(options.projectDir);
  const config = validateConfig(await readJson(path.join(root, "config.json")));
  const hudPath = path.join(root, "hud.js");
  let hudTemplate = await fs.readFile(hudPath, "utf8");
  let hudRevision = sourceRevision(hudTemplate);
  const port = config.debugPort;
  const configuredBundle = String(config.codexPath || "").endsWith(".app") ? config.codexPath : "";
  const candidates = [configuredBundle, process.env.CODEX_APP, "/Applications/Codex.app", "/Applications/ChatGPT.app"].filter(Boolean);
  const bundle = (await Promise.all(candidates.map(async (candidate) => (await exists(candidate) ? candidate : "")))).find(Boolean);

  await ensureCodexTarget(port, bundle, options.attachOnly);

  const hudSourceForConfig = () => hudTemplate.replace("__CODEX_HUD_CONFIG__", JSON.stringify({
    prices: config.prices, priceMultiplier: Number(config.priceMultiplier ?? 1), activeTurnColor: String(config.activeTurnColor || "#f59e0b"),
    longContextThresholdTokens: config.longContextThresholdTokens, uiTemplate: config.uiTemplate, transparent: config.transparent,
  }));
  let hudSource = hudSourceForConfig();
  const sessionsRoot = path.join(process.env.HOME || "", ".codex", "sessions");
  const archivedRoot = path.join(process.env.HOME || "", ".codex", "archived_sessions");
  const healthInterval = Math.max(15000, Number(config.pollIntervalMs || 2000));
  const rescanInterval = Math.max(30000, healthInterval);
  const wake = new EventWake();
  if (config.hotReload) {
    try {
      const watcher = watchFs(hudPath, () => wake.wake());
      watcher.on("error", () => {});
    } catch { /* The health check still detects a changed HUD source. */ }
  }
  const rolloutIndex = new RolloutIndex([sessionsRoot, archivedRoot], wake);
  await rolloutIndex.start();
  const usageLedger = new UsageLedger(path.join(root, "usage-ledger.json"), config);
  await usageLedger.load();
  await usageLedger.sync(rolloutIndex.takeChanged(), rolloutIndex);
  let installedTargetId = "";
  let selectedThreadKey = "";
  let provisionalBaselineMtime = -1;
  const provisionalBindings = new Map();
  const rolloutParserCache = new Map();
  let threadListener = null;
  let listenerTargetId = "";
  let lastRescanAt = Date.now();
  let activeSyncUntil = 0;
  let activeSyncTimer = null;
  const missingRolloutRetries = new Map();
  const scheduleActiveSync = () => {
    if (activeSyncTimer || Date.now() >= activeSyncUntil) return;
    activeSyncTimer = setTimeout(() => {
      activeSyncTimer = null;
      wake.wake();
    }, 100);
  };

  while (true) {
    try {
      if (config.hotReload) {
        const nextTemplate = await fs.readFile(hudPath, "utf8");
        const nextRevision = sourceRevision(nextTemplate);
        if (nextRevision !== hudRevision) {
          hudTemplate = nextTemplate;
          hudRevision = nextRevision;
          hudSource = hudSourceForConfig();
          installedTargetId = "";
        }
      }
      const nextTarget = await ensureCodexTarget(port, bundle, options.attachOnly);
      if (!threadListener || !threadListener.isAlive || listenerTargetId !== nextTarget.id) {
        threadListener?.close();
        threadListener = new ThreadSelectionListener(nextTarget.webSocketDebuggerUrl, port, wake);
        await threadListener.connect();
        listenerTargetId = nextTarget.id;
      }
      if (Date.now() - lastRescanAt >= rescanInterval) {
        await rolloutIndex.rescan();
        lastRescanAt = Date.now();
      }
      const changedRollouts = rolloutIndex.takeChanged();
      const createdRollouts = rolloutIndex.takeCreated();
      await usageLedger.sync(changedRollouts, rolloutIndex);
      const session = new CdpSession(nextTarget.webSocketDebuggerUrl, port);
      await session.connect();
      try {
        if (installedTargetId !== nextTarget.id) {
          await session.command("Page.addScriptToEvaluateOnNewDocument", { source: hudSource });
          await session.evaluate(`try { window.__codexHud?.destroy?.(); } catch {}\n${hudSource}`, false);
          installedTargetId = nextTarget.id;
        }
        threadListener.take();
        const selection = await session.evaluate(`(() => {
          const selected = document.querySelector('[data-app-action-sidebar-thread-selected="true"][data-app-action-sidebar-thread-id]');
          const fiberKey = selected && Object.getOwnPropertyNames(selected).find((key) => key.startsWith('__reactFiber'));
          let fiber = fiberKey ? selected[fiberKey] : null;
          let conversationId = '';
          while (fiber && !conversationId) {
            const props = fiber.memoizedProps || {};
            const candidate = props.entry?.conversationId || props.conversationId || props.children?.props?.conversationId;
            if (typeof candidate === 'string') conversationId = candidate;
            fiber = fiber.return;
          }
          return {
            threadKey: selected?.getAttribute('data-app-action-sidebar-thread-id') || '',
            conversationId,
            generating: [...document.querySelectorAll('button[aria-label="Stop"], button[aria-label="停止"]')]
              .some((button) => button.getClientRects().length > 0),
            newChat: document.getElementById('codex-hud-root')?.dataset.newChat === 'true',
          };
        })()`);
        // The listener only wakes this loop. The DOM query is authoritative:
        // a binding event can describe the previous item during a fast switch.
        const threadKey = String(selection?.threadKey || "");
        const candidateThreadId = threadKey.replace(/^local:/, "");

        let threadId = sessionIdPattern.test(candidateThreadId)
          ? candidateThreadId
          : (sessionIdPattern.test(String(selection?.conversationId || "")) ? String(selection.conversationId) : "");
        let rollout = threadId ? rolloutIndex.find(threadId) : null;
        if (threadId && !rollout) {
          // A fast first response can finish before FSEvents delivers the new
          // rollout path. Recover this one known session immediately instead
          // of injecting an unavailable snapshot and waiting for the fallback.
          await rolloutIndex.rescan();
          rollout = rolloutIndex.find(threadId);
          const retries = missingRolloutRetries.get(threadId) || 0;
          if (!rollout && retries < 20) {
            missingRolloutRetries.set(threadId, retries + 1);
            setTimeout(() => wake.wake(), 100);
          }
        }
        if (rollout && threadId) missingRolloutRetries.delete(threadId);
        if (!threadId && threadKey) {
          const newest = rolloutIndex.newest();
          if (threadKey !== selectedThreadKey) {
            selectedThreadKey = threadKey;
            // A sidebar item with a client-new-thread key has no rollout ID yet.
            // Its binding can only be a rollout written after this selection;
            // otherwise switching old draft entries would steal the newest live
            // rollout from the active conversation.
            provisionalBaselineMtime = newest?.mtimeMs ?? -1;
          }
          threadId = provisionalBindings.get(threadKey) || "";
          rollout = threadId ? rolloutIndex.find(threadId) : null;
          const created = createdRollouts
            .map((file) => ({ file, entry: rolloutIndex.entries.get(file) }))
            .filter(({ entry }) => entry && (provisionalBaselineMtime < 0 || entry.mtimeMs > provisionalBaselineMtime))
            .sort((left, right) => right.entry.mtimeMs - left.entry.mtimeMs)[0];
          if (!rollout && created) {
            threadId = created.entry.sessionId;
            rollout = created.file;
            provisionalBindings.set(threadKey, threadId);
          }
          if (!rollout && newest && (provisionalBaselineMtime < 0 || newest.mtimeMs > provisionalBaselineMtime)) {
            const resolvedThreadId = await sessionIdFromRollout(newest.file);
            if (resolvedThreadId) {
              threadId = resolvedThreadId;
              rollout = newest.file;
              provisionalBindings.set(threadKey, resolvedThreadId);
            }
          }
        } else if (threadKey !== selectedThreadKey) {
          selectedThreadKey = threadKey;
          provisionalBaselineMtime = -1;
        }
        const snapshot = rollout ? await incrementalSnapshot(rollout, rolloutIndex, Number(config.longContextThresholdTokens || 272000), rolloutParserCache) : null;
        const snapshotInfo = snapshot?.payload?.info;
        if (selection?.generating === true || snapshotInfo?.current_turn_active === true) {
          activeSyncUntil = Date.now() + 5000;
        }
        const payload = {
          cost_summary: usageLedger.summary(),
          __codex_hud_context: { thread_id: threadId, usage_available: Boolean(snapshot) },
          ...(snapshot || {}),
        };
        await session.evaluate(`window.__codexHud?.inspect(${JSON.stringify(payload)})`, false);
        scheduleActiveSync();
      } finally { session.close(); }
    } catch (error) {
      console.error(`[codex-hud] ${error.message}`);
      installedTargetId = "";
      if (!threadListener?.isAlive) {
        threadListener?.close();
        threadListener = null;
        listenerTargetId = "";
      }
    }
    await wake.wait(healthInterval);
  }
}

main().catch((error) => {
  console.error(`[codex-hud] ${error.message}`);
  process.exitCode = 1;
});
