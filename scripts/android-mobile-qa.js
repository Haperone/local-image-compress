"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getLocalMobileQaFingerprintState } = require("./mobile-qa-fingerprint");
const { resolveRepositoryLayout } = require("./repository-layout");

const PLUGIN_ID = "local-image-compress";
const BRIDGE_KEY = "__LIC_MOBILE_QA_RUN__";
const REPORT_SCHEMA = "local-image-compress-mobile-qa-report/v1";
const DEFAULT_PACKAGE = "md.obsidian";
const MANUAL_FALLBACK_EXIT_CODE = 2;
const DEFAULT_TIMEOUTS = Object.freeze({
  discovery: 15_000,
  connect: 10_000,
  run: 20 * 60_000,
  report: 30_000,
  cleanup: 30_000,
  poll: 1_000
});

class ManualFallbackError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManualFallbackError";
  }
}

class MobileQaFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "MobileQaFailure";
  }
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function parseArguments(argv, environment = process.env) {
  const valueOptions = new Set([
    "adb",
    "serial",
    "package",
    "socket",
    "target",
    "discovery-timeout-ms",
    "connect-timeout-ms",
    "run-timeout-ms",
    "report-timeout-ms",
    "cleanup-timeout-ms",
    "poll-ms"
  ]);
  const options = { command: "probe", json: false, help: false };
  let index = 0;
  if (argv[0] && !argv[0].startsWith("--")) {
    options.command = argv[0];
    index = 1;
  }
  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const equalsIndex = argument.indexOf("=");
    const name = argument.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    if (!valueOptions.has(name)) {
      throw new Error(`Unknown option: --${name}`);
    }
    const value = equalsIndex === -1 ? argv[++index] : argument.slice(equalsIndex + 1);
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}.`);
    }
    options[name] = value;
  }
  if (!new Set(["probe", "run", "pull-report"]).has(options.command) && !options.help) {
    throw new Error(`Unknown command: ${options.command}`);
  }

  const timeoutValue = (optionName, environmentName, fallback) => parsePositiveInteger(
    options[optionName] || environment[environmentName] || fallback,
    `--${optionName}`
  );
  const packageName = options.package || environment.MOBILE_QA_ANDROID_PACKAGE || DEFAULT_PACKAGE;
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(packageName)) {
    throw new Error(`Invalid Android package name: ${packageName}`);
  }
  const socketName = options.socket ? options.socket.replace(/^@/, "") : null;
  if (socketName && !/^[A-Za-z0-9_.:-]+$/.test(socketName)) {
    throw new Error(`Invalid Android abstract socket name: ${options.socket}`);
  }
  return {
    command: options.command,
    help: options.help,
    json: options.json,
    adbPath: options.adb || environment.MOBILE_QA_ADB || "adb",
    serial: options.serial || environment.ANDROID_SERIAL || null,
    packageName,
    socketName,
    targetId: options.target || null,
    timeouts: {
      discovery: timeoutValue("discovery-timeout-ms", "MOBILE_QA_DISCOVERY_TIMEOUT_MS", DEFAULT_TIMEOUTS.discovery),
      connect: timeoutValue("connect-timeout-ms", "MOBILE_QA_CONNECT_TIMEOUT_MS", DEFAULT_TIMEOUTS.connect),
      run: timeoutValue("run-timeout-ms", "MOBILE_QA_RUN_TIMEOUT_MS", DEFAULT_TIMEOUTS.run),
      report: timeoutValue("report-timeout-ms", "MOBILE_QA_REPORT_TIMEOUT_MS", DEFAULT_TIMEOUTS.report),
      cleanup: timeoutValue("cleanup-timeout-ms", "MOBILE_QA_CLEANUP_TIMEOUT_MS", DEFAULT_TIMEOUTS.cleanup),
      poll: timeoutValue("poll-ms", "MOBILE_QA_POLL_MS", DEFAULT_TIMEOUTS.poll)
    }
  };
}

function parseAdbDevices(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("List of devices") && !line.startsWith("*"))
    .map((line) => {
      const [serial, state, ...details] = line.split(/\s+/);
      return { serial, state, details: details.join(" ") };
    })
    .filter((device) => device.serial && device.state);
}

function selectAdbDevice(devices, requestedSerial) {
  if (requestedSerial) {
    const selected = devices.find((device) => device.serial === requestedSerial);
    if (!selected) {
      throw new ManualFallbackError(`ADB device ${requestedSerial} is not connected.`);
    }
    if (selected.state !== "device") {
      throw new ManualFallbackError(`ADB device ${requestedSerial} is ${selected.state}; authorize and reconnect it.`);
    }
    return selected;
  }
  const authorized = devices.filter((device) => device.state === "device");
  if (authorized.length === 1) {
    return authorized[0];
  }
  if (authorized.length > 1) {
    throw new ManualFallbackError(`Multiple authorized Android devices are connected; use --serial (${authorized.map((device) => device.serial).join(", ")}).`);
  }
  const states = devices.map((device) => `${device.serial}:${device.state}`).join(", ");
  throw new ManualFallbackError(states
    ? `No authorized Android device is available (${states}).`
    : "No Android device is connected through ADB.");
}

function parseProcessIds(output) {
  return [...new Set(String(output).trim().split(/\s+/).filter((value) => /^\d+$/.test(value)))];
}

function parseAdbForwards(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3)
    .map(([serial, local, remote]) => ({ serial, local, remote }));
}

function parseDevtoolsSockets(output) {
  const sockets = [];
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.match(/(?:@|\u0000)([^\s]*devtools_remote[^\s]*)\s*$/);
    if (match) {
      sockets.push(match[1]);
    }
  }
  return [...new Set(sockets)];
}

function selectDevtoolsSocket(sockets, pid, requestedSocket) {
  if (requestedSocket) {
    if (!sockets.includes(requestedSocket)) {
      throw new ManualFallbackError(`Requested WebView socket ${requestedSocket} is not present.`);
    }
    return requestedSocket;
  }
  const exact = `webview_devtools_remote_${pid}`;
  if (sockets.includes(exact)) {
    return exact;
  }
  const discovered = sockets.length > 0 ? ` Found: ${sockets.join(", ")}.` : "";
  throw new ManualFallbackError(`Obsidian does not expose the expected debug WebView socket ${exact}.${discovered}`);
}

function remainingTime(deadline, now, label, ErrorType = Error) {
  const remaining = deadline - now();
  if (remaining <= 0) {
    throw new ErrorType(`${label} timed out.`);
  }
  return Math.max(1, Math.trunc(remaining));
}

function localWebSocketUrl(remoteUrl, port) {
  let parsed;
  try {
    parsed = new URL(remoteUrl);
  } catch (error) {
    throw new ManualFallbackError(`CDP target returned an invalid WebSocket URL: ${remoteUrl}`);
  }
  if (!parsed.pathname.startsWith("/devtools/")) {
    throw new ManualFallbackError(`CDP target returned an unexpected WebSocket path: ${parsed.pathname}`);
  }
  return `ws://127.0.0.1:${port}${parsed.pathname}${parsed.search}`;
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.handleMessage = (event) => this.onMessage(event);
    this.handleClose = () => this.failPending(new Error("CDP WebSocket closed."));
    this.handleError = () => this.failPending(new Error("CDP WebSocket failed."));
    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("close", this.handleClose);
    socket.addEventListener("error", this.handleError);
  }

  static async connect(url, timeoutMs, WebSocketClass = globalThis.WebSocket) {
    if (typeof WebSocketClass !== "function") {
      throw new ManualFallbackError("This command requires Node.js 22+ with the built-in WebSocket API enabled.");
    }
    const socket = new WebSocketClass(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        try {
          socket.close();
        } catch (error) {
          // The connection is already unusable; the timeout is the useful error.
        }
        reject(new ManualFallbackError(`CDP WebSocket connection timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("error", handleError);
      };
      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new ManualFallbackError("Could not connect to the Obsidian WebView CDP target."));
      };
      socket.addEventListener("open", handleOpen);
      socket.addEventListener("error", handleError);
    });
    return new CdpClient(socket);
  }

  onMessage(event) {
    let message;
    try {
      const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
      message = JSON.parse(raw);
    } catch (error) {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`CDP ${pending.method} failed: ${message.error.message || JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }
    for (const listener of this.listeners) {
      listener(message);
    }
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}, timeoutMs = DEFAULT_TIMEOUTS.connect) {
    if (this.socket.readyState !== 1) {
      return Promise.reject(new Error("CDP WebSocket is not open."));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate(expression, timeoutMs, userGesture = false) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture
    }, timeoutMs);
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
      throw new Error(`CDP evaluation failed: ${description}`);
    }
    return response.result?.value;
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.socket.removeEventListener("message", this.handleMessage);
    this.socket.removeEventListener("close", this.handleClose);
    this.socket.removeEventListener("error", this.handleError);
    this.listeners.clear();
    this.failPending(new Error("CDP client closed."));
    if (this.socket.readyState === 0 || this.socket.readyState === 1) {
      this.socket.close();
    }
  }
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, content);
  try {
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

function createNodeDriver(adbPath) {
  return {
    now: () => Date.now(),
    sleep: (timeoutMs) => new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    runAdb(args, timeoutMs) {
      const result = spawnSync(adbPath, args, {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: timeoutMs
      });
      if (result.error) {
        const message = result.error.code === "ENOENT"
          ? `ADB executable was not found: ${adbPath}`
          : result.error.code === "ETIMEDOUT"
            ? `ADB command timed out after ${timeoutMs}ms: ${args.join(" ")}`
            : `ADB command failed: ${result.error.message}`;
        throw new Error(message);
      }
      if (result.status !== 0) {
        const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        throw new Error(`ADB exited with ${result.status}: ${args.join(" ")}${details ? `\n${details}` : ""}`);
      }
      return String(result.stdout || "").trim();
    },
    async fetchJson(url, timeoutMs) {
      if (typeof globalThis.fetch !== "function") {
        throw new ManualFallbackError("This command requires Node.js 22+ with the built-in fetch API enabled.");
      }
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        throw new Error(`CDP endpoint ${url} returned HTTP ${response.status}.`);
      }
      return await response.json();
    },
    openCdp: (url, timeoutMs) => CdpClient.connect(url, timeoutMs),
    writeArtifacts(report, logLines) {
      const { repositoryRoot } = resolveRepositoryLayout();
      const outputDir = path.join(repositoryRoot, "qa-backups", "mobile");
      const timestamp = timestampForFile();
      const logPath = path.join(outputDir, `runtime-qa-transport-${timestamp}.txt`);
      atomicWrite(logPath, `${logLines.join("\n")}\n`);
      let reportPath = null;
      if (report) {
        reportPath = path.join(outputDir, `runtime-qa-report-${timestamp}.json`);
        atomicWrite(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      }
      return { reportPath, logPath };
    }
  };
}

async function discoverAdb(options, driver) {
  const deadline = driver.now() + options.timeouts.discovery;
  const run = (args) => driver.runAdb(args, remainingTime(
    deadline,
    driver.now,
    "ADB discovery",
    ManualFallbackError
  ));
  try {
    run(["version"]);
  } catch (error) {
    throw new ManualFallbackError(error.message);
  }
  let devices;
  try {
    devices = parseAdbDevices(run(["devices", "-l"]));
  } catch (error) {
    throw new ManualFallbackError(`Could not list Android devices: ${error.message}`);
  }
  const device = selectAdbDevice(devices, options.serial);
  let pids;
  try {
    pids = parseProcessIds(run(["-s", device.serial, "shell", "pidof", options.packageName]));
  } catch (error) {
    throw new ManualFallbackError(`Obsidian package ${options.packageName} is not running on ${device.serial}.`);
  }
  if (pids.length !== 1) {
    throw new ManualFallbackError(pids.length === 0
      ? `Obsidian package ${options.packageName} is not running on ${device.serial}.`
      : `Obsidian package ${options.packageName} has multiple PIDs (${pids.join(", ")}); restart the app.`);
  }
  let sockets;
  try {
    sockets = parseDevtoolsSockets(run(["-s", device.serial, "shell", "cat", "/proc/net/unix"]));
  } catch (error) {
    throw new ManualFallbackError("Android did not allow inspection of WebView debug sockets.");
  }
  const socket = selectDevtoolsSocket(sockets, pids[0], options.socketName);
  let forwardsBefore;
  try {
    forwardsBefore = parseAdbForwards(run(["-s", device.serial, "forward", "--list"]));
  } catch (error) {
    throw new ManualFallbackError(`Could not inspect existing ADB forwards: ${error.message}`);
  }
  let output = "";
  let createFailure = null;
  try {
    output = String(run(["-s", device.serial, "forward", "tcp:0", `localabstract:${socket}`])).trim();
  } catch (error) {
    createFailure = new ManualFallbackError(`Could not forward the Obsidian WebView socket: ${error.message}`);
  }
  const port = Number(output);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    let cleanupFailure = null;
    try {
      const cleanupRun = (args) => driver.runAdb(args, options.timeouts.cleanup);
      const before = new Set(forwardsBefore.map((entry) => `${entry.serial}\0${entry.local}\0${entry.remote}`));
      const forwardsAfter = parseAdbForwards(cleanupRun(["-s", device.serial, "forward", "--list"]));
      const owned = forwardsAfter.filter((entry) => entry.serial === device.serial
        && entry.remote === `localabstract:${socket}`
        && !before.has(`${entry.serial}\0${entry.local}\0${entry.remote}`));
      for (const entry of owned) {
        if (/^tcp:\d+$/.test(entry.local)) {
          cleanupRun(["-s", device.serial, "forward", "--remove", entry.local]);
        }
      }
    } catch (error) {
      cleanupFailure = new Error(`Could not clean an unconfirmed ADB forward: ${error.message}`);
    }
    const invalidPortFailure = createFailure || new Error(`ADB returned an invalid forwarded port: ${output || "<empty>"}`);
    throw combineFailures(invalidPortFailure, cleanupFailure);
  }
  return { serial: device.serial, pid: pids[0], socket, port };
}

const BRIDGE_IDENTITY_EXPRESSION = `(() => {
  if (typeof app === "undefined" || !app.plugins) return { appReady: false, pluginLoaded: false, bridgeReady: false };
  const plugin = app.plugins.getPlugin(${JSON.stringify(PLUGIN_ID)});
  const bridge = plugin && plugin[${JSON.stringify(BRIDGE_KEY)}];
  const methods = ["start", "status", "report", "latestReport", "cancel"];
  return {
    appReady: true,
    pluginLoaded: Boolean(plugin),
    bridgeVersion: bridge && bridge.version,
    bridgeReady: Boolean(bridge && bridge.version === 1 && methods.every((name) => typeof bridge[name] === "function"))
  };
})()`;

function selectQaTarget(inspectedTargets, requestedTargetId) {
  const available = requestedTargetId
    ? inspectedTargets.filter((entry) => entry.target.id === requestedTargetId)
    : inspectedTargets;
  if (requestedTargetId && available.length === 0) {
    throw new ManualFallbackError(`CDP target ${requestedTargetId} was not found.`);
  }
  const ready = available.filter((entry) => entry.identity?.bridgeReady);
  if (ready.length === 1) {
    return ready[0].target;
  }
  if (ready.length > 1) {
    throw new ManualFallbackError(`Multiple Obsidian QA targets are available; use --target (${ready.map((entry) => entry.target.id).join(", ")}).`);
  }
  if (available.some((entry) => entry.identity?.pluginLoaded)) {
    throw new ManualFallbackError("Local Image Compress is loaded, but its QA-only bridge is absent. Install and reload the mobile QA build.");
  }
  if (available.some((entry) => entry.identity?.appReady)) {
    throw new ManualFallbackError("The Obsidian WebView is reachable, but Local Image Compress is not loaded.");
  }
  throw new ManualFallbackError("No usable Obsidian page target was found in the debug WebView.");
}

async function connectQaTarget(discovery, options, driver) {
  const deadline = driver.now() + options.timeouts.connect;
  const remaining = () => remainingTime(deadline, driver.now, "CDP connection", ManualFallbackError);
  let targets;
  try {
    targets = await driver.fetchJson(`http://127.0.0.1:${discovery.port}/json/list`, remaining());
  } catch (firstError) {
    try {
      targets = await driver.fetchJson(`http://127.0.0.1:${discovery.port}/json`, remaining());
    } catch (secondError) {
      throw new ManualFallbackError(`The forwarded WebView socket did not expose CDP targets: ${secondError.message}`);
    }
  }
  if (!Array.isArray(targets)) {
    throw new ManualFallbackError("The WebView CDP target list was not an array.");
  }
  const candidates = targets.filter((target) => target
    && target.type === "page"
    && typeof target.id === "string"
    && typeof target.webSocketDebuggerUrl === "string");
  const inspected = [];
  for (const target of candidates) {
    if (options.targetId && target.id !== options.targetId) {
      continue;
    }
    let client;
    try {
      client = await driver.openCdp(localWebSocketUrl(target.webSocketDebuggerUrl, discovery.port), remaining());
      const identity = await client.evaluate(BRIDGE_IDENTITY_EXPRESSION, remaining());
      inspected.push({ target, identity });
    } catch (error) {
      inspected.push({ target, error });
    } finally {
      if (client) {
        client.close();
      }
    }
  }
  const target = selectQaTarget(inspected, options.targetId);
  const client = await driver.openCdp(localWebSocketUrl(target.webSocketDebuggerUrl, discovery.port), remaining());
  return { target, client };
}

function combineFailures(operationFailure, cleanupFailure) {
  if (operationFailure && cleanupFailure) {
    return new AggregateError([operationFailure, cleanupFailure], `${operationFailure.message}\nCleanup also failed: ${cleanupFailure.message}`);
  }
  return operationFailure || cleanupFailure;
}

async function withQaTarget(options, driver, callback) {
  const discovery = await discoverAdb(options, driver);
  let connection;
  let result;
  let operationFailure = null;
  try {
    connection = await connectQaTarget(discovery, options, driver);
    result = await callback({ ...discovery, ...connection });
  } catch (error) {
    operationFailure = error;
  }
  if (connection?.client) {
    try {
      connection.client.close();
    } catch (error) {
      operationFailure = combineFailures(operationFailure, error);
    }
  }
  let cleanupFailure = null;
  try {
    driver.runAdb(
      ["-s", discovery.serial, "forward", "--remove", `tcp:${discovery.port}`],
      options.timeouts.cleanup
    );
  } catch (error) {
    cleanupFailure = new Error(`Could not remove ADB forward tcp:${discovery.port}: ${error.message}`);
  }
  const failure = combineFailures(operationFailure, cleanupFailure);
  if (failure) {
    throw failure;
  }
  return result;
}

function bridgeExpression(method, args = []) {
  return `(async () => {
    const plugin = app.plugins.getPlugin(${JSON.stringify(PLUGIN_ID)});
    const bridge = plugin && plugin[${JSON.stringify(BRIDGE_KEY)}];
    if (!bridge || bridge.version !== 1 || typeof bridge[${JSON.stringify(method)}] !== "function") {
      throw new Error("Mobile QA bridge is unavailable or incompatible");
    }
    return await bridge[${JSON.stringify(method)}](...${JSON.stringify(args)});
  })()`;
}

function validateStatus(status, sessionId) {
  const states = new Set(["running", "passed", "failed", "cancelled"]);
  if (!status || status.sessionId !== sessionId || !states.has(status.state)) {
    throw new MobileQaFailure("The mobile QA bridge returned an invalid session status.");
  }
  return status;
}

function validateReport(report, expectedSessionId = null) {
  if (!report
    || report.schema !== REPORT_SCHEMA
    || typeof report.sessionId !== "string"
    || typeof report.pluginVersion !== "string"
    || report.pluginVersion.trim().length === 0
    || typeof report.appVersion !== "string"
    || report.appVersion.trim().length === 0
    || report.appVersion === "unknown") {
    throw new MobileQaFailure("The mobile QA bridge returned an invalid report.");
  }
  if (expectedSessionId && report.sessionId !== expectedSessionId) {
    throw new MobileQaFailure(`The report belongs to ${report.sessionId}, expected ${expectedSessionId}.`);
  }
  if (!report.summary || typeof report.summary.success !== "boolean") {
    throw new MobileQaFailure("The mobile QA report summary is invalid.");
  }
  if (typeof report.buildFingerprint !== "string" || !/^mobile-qa-src-[a-f0-9]{64}$/.test(report.buildFingerprint)) {
    throw new MobileQaFailure("The mobile QA report has no valid source fingerprint.");
  }
  return report;
}

function validateExpectedFingerprint(report, expectedFingerprint) {
  if (expectedFingerprint && report.buildFingerprint !== expectedFingerprint) {
    throw new MobileQaFailure(`The mobile QA report fingerprint ${report.buildFingerprint} does not match the current staged build ${expectedFingerprint}. Rebuild and reinstall with npm run qa:mobile:build.`);
  }
  return report;
}

function requireCurrentStagedFingerprint() {
  const state = getLocalMobileQaFingerprintState();
  if (!state.staged) {
    throw new MobileQaFailure("The local mobile-qa-build/main.js is missing. Run npm run qa:mobile:build before Android QA.");
  }
  if (state.staged !== state.current) {
    throw new MobileQaFailure(`The local mobile QA staging bundle is stale (${state.staged} != ${state.current}). Run npm run qa:mobile:build before Android QA.`);
  }
  return state;
}

function validatePulledReportFingerprints(report, state) {
  const mismatches = [];
  if (state?.current && report.buildFingerprint !== state.current) {
    mismatches.push(`current source ${state.current}`);
  }
  if (state?.staged && report.buildFingerprint !== state.staged) {
    mismatches.push(`staged bundle ${state.staged}`);
  }
  if (mismatches.length > 0) {
    throw new MobileQaFailure(`The saved mobile QA report fingerprint ${report.buildFingerprint} does not match the local ${mismatches.join(" or ")}. Rebuild and reinstall before treating it as a current result.`);
  }
  return report;
}

function isTimeoutFailure(error) {
  return error instanceof Error && /timed out/i.test(error.message);
}

function sanitizeDiagnostic(value) {
  return String(value)
    .replace(/\b(?:content|file):\/\/[^\r\n\t"']+/gi, "<redacted-uri>")
    .replace(/[A-Za-z]:[\\/][^\r\n\t"']+/g, "<redacted-path>")
    .replace(/\\\\[^\\\s]+\\[^\r\n\t"']+/g, "<redacted-path>")
    .replace(/\/(?:private\/var\/mobile|var\/mobile|storage|sdcard|mnt|data\/user|data\/data|Users)\/[^\r\n\t"']+/g, "<redacted-path>")
    .slice(0, 1_500);
}

function remoteObjectText(value) {
  if (value && Object.prototype.hasOwnProperty.call(value, "value")) {
    try {
      return typeof value.value === "string" ? value.value : JSON.stringify(value.value);
    } catch (error) {
      return String(value.value);
    }
  }
  return value?.description || value?.type || "unknown";
}

function diagnosticFromEvent(event) {
  if (event.method === "Runtime.consoleAPICalled") {
    const type = event.params?.type;
    if (!new Set(["warning", "error", "assert"]).has(type)) {
      return null;
    }
    return `[console.${type}] ${sanitizeDiagnostic((event.params.args || []).map(remoteObjectText).join(" "))}`;
  }
  if (event.method === "Runtime.exceptionThrown") {
    const details = event.params?.exceptionDetails;
    return `[exception] ${sanitizeDiagnostic(details?.exception?.description || details?.text || "Unknown exception")}`;
  }
  return null;
}

function progressLine(status) {
  const check = status.currentCheck ? ` ${status.currentCheck}` : "";
  return `[${status.completed}/${status.total}] ${status.phase}${check}`;
}

async function waitForTerminalStatus(client, driver, options, sessionId, log) {
  const deadline = driver.now() + options.timeouts.run;
  let previous = "";
  while (true) {
    const status = validateStatus(await client.evaluate(
      bridgeExpression("status", [sessionId]),
      Math.min(options.timeouts.connect, remainingTime(deadline, driver.now, "Mobile QA run", MobileQaFailure))
    ), sessionId);
    const line = progressLine(status);
    if (line !== previous) {
      previous = line;
      log(line);
    }
    if (status.state !== "running") {
      return status;
    }
    await driver.sleep(Math.min(options.timeouts.poll, remainingTime(deadline, driver.now, "Mobile QA run", MobileQaFailure)));
  }
}

async function cancelTimedOutSession(client, driver, options, sessionId, log) {
  const deadline = driver.now() + options.timeouts.cleanup;
  await client.evaluate(
    bridgeExpression("cancel", [sessionId, "Android transport timeout"]),
    remainingTime(deadline, driver.now, "Mobile QA cancellation", MobileQaFailure)
  );
  log("Cancellation requested; waiting for mobile cleanup.");
  while (true) {
    const status = validateStatus(await client.evaluate(
      bridgeExpression("status", [sessionId]),
      remainingTime(deadline, driver.now, "Mobile QA cleanup", MobileQaFailure)
    ), sessionId);
    if (status.state !== "running" && status.reportReady) {
      return status;
    }
    await driver.sleep(Math.min(options.timeouts.poll, remainingTime(deadline, driver.now, "Mobile QA cleanup", MobileQaFailure)));
  }
}

async function waitForReport(client, driver, options, sessionId, initialStatus) {
  const deadline = driver.now() + options.timeouts.report;
  let status = initialStatus;
  while (!status.reportReady) {
    await driver.sleep(Math.min(options.timeouts.poll, remainingTime(deadline, driver.now, "Mobile QA report", MobileQaFailure)));
    status = validateStatus(await client.evaluate(
      bridgeExpression("status", [sessionId]),
      remainingTime(deadline, driver.now, "Mobile QA report", MobileQaFailure)
    ), sessionId);
  }
  return validateReport(await client.evaluate(
    bridgeExpression("report", [sessionId]),
    remainingTime(deadline, driver.now, "Mobile QA report", MobileQaFailure)
  ), sessionId);
}

async function runMobileQa(options, driver, io) {
  return await withQaTarget(options, driver, async ({ serial, pid, socket, target, client }) => {
    const logLines = [];
    const log = (line) => {
      logLines.push(line);
      io.stdout.write(`${line}\n`);
    };
    let removeEventListener = () => {};
    let runtimeEnabled = false;
    let reportForArtifacts = null;
    let result = null;
    let failure = null;
    try {
      log(`Device: ${serial}; PID: ${pid}; socket: ${socket}; target: ${target.id}`);
      await client.send("Runtime.enable", {}, options.timeouts.connect);
      runtimeEnabled = true;
      await client.send("Runtime.discardConsoleEntries", {}, options.timeouts.connect);
      removeEventListener = client.onEvent((event) => {
        const diagnostic = diagnosticFromEvent(event);
        if (diagnostic) {
          logLines.push(diagnostic);
        }
      });
      const started = await client.evaluate(bridgeExpression("start"), options.timeouts.connect, true);
      const sessionId = started?.sessionId;
      if (typeof sessionId !== "string" || !/^[a-f0-9]{32}$/.test(sessionId)) {
        if (typeof sessionId === "string") {
          try {
            await client.evaluate(
              bridgeExpression("cancel", [sessionId, "Android transport rejected an invalid session id"]),
              options.timeouts.cleanup,
              true
            );
          } catch (cancelError) {
            logLines.push(`Could not cancel invalid bridge session: ${sanitizeDiagnostic(cancelError.message)}`);
          }
        }
        throw new MobileQaFailure("The mobile QA bridge returned an invalid session id.");
      }
      log(`Session: ${sessionId}`);
      let status;
      let timedOut = false;
      try {
        status = await waitForTerminalStatus(client, driver, options, sessionId, log);
      } catch (error) {
        if (!isTimeoutFailure(error)) {
          throw error;
        }
        timedOut = true;
        status = await cancelTimedOutSession(client, driver, options, sessionId, log);
      }
      const report = await waitForReport(client, driver, options, sessionId, status);
      reportForArtifacts = report;
      validateExpectedFingerprint(report, options.expectedFingerprint);
      if (timedOut) {
        throw new MobileQaFailure("Mobile QA exceeded the run timeout and was cancelled after cleanup.");
      }
      if (status.state !== "passed" || !report.summary.success) {
        throw new MobileQaFailure(`Mobile QA finished with state ${status.state}; failed checks: ${report.summary.failed}.`);
      }
      if (report.cleanup?.status !== "pass" || report.recovery?.status === "fail") {
        throw new MobileQaFailure("Mobile QA checks passed, but cleanup or recovery did not complete safely.");
      }
      result = { discovery: { serial, pid, socket, targetId: target.id }, report };
    } catch (error) {
      failure = error;
    } finally {
      removeEventListener();
      if (runtimeEnabled) {
        try {
          await client.send("Runtime.disable", {}, options.timeouts.cleanup);
        } catch (error) {
          const cleanupError = new MobileQaFailure(`Could not disable CDP Runtime events: ${error.message}`);
          failure = combineFailures(failure, cleanupError);
        }
      }
    }
    if (failure) {
      logLines.push(`FAILED: ${sanitizeDiagnostic(failure.message)}`);
    }
    const artifacts = driver.writeArtifacts(reportForArtifacts, logLines);
    io.stdout.write(`${artifacts.reportPath ? `Report: ${artifacts.reportPath}\n` : ""}Transport log: ${artifacts.logPath}\n`);
    if (failure) {
      throw failure;
    }
    return { ...result, artifacts };
  });
}

async function probeMobileQa(options, driver, io) {
  const result = await withQaTarget(options, driver, async ({ serial, pid, socket, target }) => ({
    ready: true,
    serial,
    packageName: options.packageName,
    pid,
    socket,
    targetId: target.id,
    bridgeVersion: 1
  }));
  const fingerprint = getLocalMobileQaFingerprintState();
  const resultWithFingerprint = { ...result, fingerprint };
  if (options.json) {
    io.stdout.write(`${JSON.stringify(resultWithFingerprint, null, 2)}\n`);
  } else {
    io.stdout.write([
      "Android mobile QA transport is ready.",
      `Device: ${result.serial}`,
      `Package: ${result.packageName} (PID ${result.pid})`,
      `WebView socket: ${result.socket}`,
      `CDP target: ${result.targetId}`,
      `QA bridge: v${result.bridgeVersion}`,
      `Current source fingerprint: ${fingerprint.current}`,
      `Staged bundle fingerprint: ${fingerprint.staged || "missing (run npm run qa:mobile:build)"}`
    ].join("\n") + "\n");
  }
  return resultWithFingerprint;
}

async function pullLatestReport(options, driver, io) {
  return await withQaTarget(options, driver, async ({ client }) => {
    const rawReport = await client.evaluate(
      bridgeExpression("latestReport"),
      options.timeouts.report
    );
    if (!rawReport) {
      throw new MobileQaFailure("No mobile QA report is available in the test Vault.");
    }
    const report = validateReport(rawReport);
    const artifacts = driver.writeArtifacts(report, [`Pulled mobile QA report ${report.sessionId} through CDP.`]);
    io.stdout.write(`Report: ${artifacts.reportPath}\nTransport log: ${artifacts.logPath}\n`);
    validateExpectedFingerprint(report, options.expectedFingerprint);
    return { report, artifacts };
  });
}

function printHelp(io) {
  io.stdout.write([
    "Usage:",
    "  node scripts/android-mobile-qa.js probe [--serial <id>] [--package md.obsidian]",
    "  node scripts/android-mobile-qa.js run [--serial <id>] [--target <id>]",
    "  node scripts/android-mobile-qa.js pull-report [--serial <id>] [--target <id>]",
    "",
    "Optional overrides: --adb, --socket, --discovery-timeout-ms, --connect-timeout-ms,",
    "--run-timeout-ms, --report-timeout-ms, --cleanup-timeout-ms, --poll-ms, --json.",
    "Environment: MOBILE_QA_ADB, ANDROID_SERIAL, MOBILE_QA_ANDROID_PACKAGE,",
    "MOBILE_QA_DISCOVERY_TIMEOUT_MS, MOBILE_QA_CONNECT_TIMEOUT_MS, MOBILE_QA_RUN_TIMEOUT_MS,",
    "MOBILE_QA_REPORT_TIMEOUT_MS, MOBILE_QA_CLEANUP_TIMEOUT_MS, MOBILE_QA_POLL_MS.",
    "The QA-only build must already be installed and reloaded in a marked test Vault."
  ].join("\n") + "\n");
}

function manualFallbackText(message) {
  return [
    `Automatic Android QA is unavailable: ${message}`,
    "Manual fallback:",
    "1. Install and reload the mobile QA build in the marked test Vault.",
    "2. Run “Local Image Compress: Run mobile runtime QA” from Obsidian's command palette.",
    "3. Share the JSON and TXT files from “Local Image Compress QA/reports” in that Vault."
  ].join("\n");
}

function findManualFallback(error) {
  if (error instanceof ManualFallbackError) {
    return error;
  }
  if (error instanceof AggregateError) {
    const nested = error.errors.map((entry) => findManualFallback(entry));
    if (nested.length > 0 && nested.every(Boolean)) {
      return new ManualFallbackError(error.message);
    }
  }
  return null;
}

async function cli(argv = process.argv.slice(2), environment = process.env, io = process, driverFactory = createNodeDriver, fingerprintStateProvider = getLocalMobileQaFingerprintState) {
  try {
    const options = parseArguments(argv, environment);
    if (options.help) {
      printHelp(io);
      return 0;
    }
    const driver = driverFactory(options.adbPath);
    if (options.command === "probe") {
      await probeMobileQa(options, driver, io);
    } else if (options.command === "run") {
      options.expectedFingerprint = requireCurrentStagedFingerprint().current;
      await runMobileQa(options, driver, io);
    } else {
      const pulled = await pullLatestReport(options, driver, io);
      validatePulledReportFingerprints(pulled.report, fingerprintStateProvider());
    }
    return 0;
  } catch (error) {
    const manual = findManualFallback(error);
    if (manual) {
      io.stderr.write(`${manualFallbackText(manual.message)}\n`);
      return MANUAL_FALLBACK_EXIT_CODE;
    }
    io.stderr.write(`${error instanceof MobileQaFailure ? "Mobile QA failed" : "Android mobile QA transport failed"}: ${error.message}\n`);
    if (environment.MOBILE_QA_DEBUG === "1" && error.stack) {
      io.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
}

if (require.main === module) {
  cli().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  BRIDGE_IDENTITY_EXPRESSION,
  BRIDGE_KEY,
  CdpClient,
  MANUAL_FALLBACK_EXIT_CODE,
  ManualFallbackError,
  MobileQaFailure,
  bridgeExpression,
  cli,
  connectQaTarget,
  diagnosticFromEvent,
  discoverAdb,
  localWebSocketUrl,
  manualFallbackText,
  parseAdbDevices,
  parseArguments,
  parseDevtoolsSockets,
  parseProcessIds,
  probeMobileQa,
  pullLatestReport,
  runMobileQa,
  requireCurrentStagedFingerprint,
  selectAdbDevice,
  selectDevtoolsSocket,
  selectQaTarget,
  validateReport,
  validateExpectedFingerprint,
  validatePulledReportFingerprints,
  validateStatus,
  withQaTarget
};
