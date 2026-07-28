"use strict";

const assert = require("node:assert/strict");
const {
  BRIDGE_IDENTITY_EXPRESSION,
  MANUAL_FALLBACK_EXIT_CODE,
  cli,
  parseAdbDevices,
  parseArguments,
  parseDevtoolsSockets,
  pullLatestReport,
  runMobileQa,
  selectAdbDevice,
  selectDevtoolsSocket,
  selectQaTarget,
  validateReport,
  validateExpectedFingerprint,
  validatePulledReportFingerprints,
  withQaTarget
} = require("./android-mobile-qa");

function options(command = "probe", overrides = {}) {
  const parsed = parseArguments([command], {});
  return {
    ...parsed,
    ...overrides,
    timeouts: { ...parsed.timeouts, ...(overrides.timeouts || {}) }
  };
}

function makeReport(sessionId, success = true) {
  return {
    schema: "local-image-compress-mobile-qa-report/v1",
    pluginVersion: "test-plugin",
    appVersion: "test-app",
    buildFingerprint: `mobile-qa-src-${"a".repeat(64)}`,
    sessionId,
    phase: "completed",
    checks: [],
    cleanup: { status: "pass" },
    recovery: { status: "not-required" },
    summary: {
      passed: success ? 1 : 0,
      failed: success ? 0 : 1,
      skipped: 0,
      cancelled: !success,
      success
    }
  };
}

function makeIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } }
    },
    stdout: () => stdout,
    stderr: () => stderr
  };
}

function makeFakeDriver(configuration = {}) {
  const state = {
    now: 0,
    adbCalls: [],
    adbTimeouts: [],
    closedClients: 0,
    artifacts: [],
    cancelled: false,
    statusIndex: 0,
    forwardAllocated: false
  };
  const sessionId = configuration.sessionId || "a".repeat(32);
  const report = configuration.report || makeReport(sessionId, true);
  const statuses = configuration.statuses || [
    {
      sessionId,
      state: "running",
      phase: "running",
      currentCheck: "compression-jpeg",
      completed: 0,
      total: 1,
      reportReady: false
    },
    {
      sessionId,
      state: "passed",
      phase: "completed",
      currentCheck: null,
      completed: 1,
      total: 1,
      reportReady: true
    }
  ];

  function bridgeMethod(expression) {
    for (const method of ["start", "status", "report", "latestReport", "cancel"]) {
      if (expression.includes(`bridge["${method}"]`)) {
        return method;
      }
    }
    return null;
  }

  function makeClient(identityOnly) {
    const listeners = new Set();
    return {
      async evaluate(expression) {
        if (expression === BRIDGE_IDENTITY_EXPRESSION) {
          return configuration.identity || { appReady: true, pluginLoaded: true, bridgeVersion: 1, bridgeReady: true };
        }
        assert(!identityOnly, "Identity-only CDP client received a bridge command");
        const method = bridgeMethod(expression);
        if (method === "start") {
          return { sessionId };
        }
        if (method === "status") {
          if (configuration.statusTimeout && !state.cancelled && state.statusIndex === 0) {
            state.statusIndex += 1;
            throw new Error("CDP Runtime.evaluate timed out after 5ms.");
          }
          if (state.cancelled) {
            return {
              sessionId,
              state: "cancelled",
              phase: "completed",
              currentCheck: null,
              completed: 0,
              total: 1,
              reportReady: true
            };
          }
          const status = statuses[Math.min(state.statusIndex, statuses.length - 1)];
          state.statusIndex += 1;
          return status;
        }
        if (method === "report") {
          return report;
        }
        if (method === "latestReport") {
          return configuration.latestReport === undefined ? report : configuration.latestReport;
        }
        if (method === "cancel") {
          state.cancelled = true;
          return undefined;
        }
        throw new Error("Unexpected CDP evaluation");
      },
      async send() {
        return {};
      },
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() {
        state.closedClients += 1;
      }
    };
  }

  let openedClients = 0;
  const driver = {
    now: () => state.now,
    sleep: async (timeoutMs) => { state.now += timeoutMs; },
    runAdb(args, timeoutMs) {
      state.adbCalls.push([...args]);
      state.adbTimeouts.push({ args: [...args], timeoutMs });
      const joined = args.join(" ");
      if (joined === "version") {
        return "Android Debug Bridge version 1.0.41";
      }
      if (joined === "devices -l") {
        return "List of devices attached\nSERIAL-1 device product:test model:Phone";
      }
      if (joined.includes(" shell pidof ")) {
        return "4242";
      }
      if (joined.endsWith("shell cat /proc/net/unix")) {
        return "00000000: 00000002 00000000 00010000 0001 01 42 @webview_devtools_remote_4242";
      }
      if (joined.endsWith("forward tcp:0 localabstract:webview_devtools_remote_4242")) {
        state.forwardAllocated = true;
        state.now += configuration.forwardAdvanceMs || 0;
        return configuration.forwardPortOutput || "43123";
      }
      if (joined.endsWith("forward --list")) {
        return state.forwardAllocated
          ? "SERIAL-1 tcp:43123 localabstract:webview_devtools_remote_4242"
          : "";
      }
      if (joined.endsWith("forward --remove tcp:43123")) {
        if (configuration.cleanupFailure) {
          throw new Error("injected cleanup failure");
        }
        state.forwardAllocated = false;
        return "";
      }
      throw new Error(`Unexpected ADB call: ${joined}`);
    },
    async fetchJson() {
      return [{
        id: "target-1",
        type: "page",
        webSocketDebuggerUrl: "ws://localhost/devtools/page/target-1"
      }];
    },
    async openCdp() {
      openedClients += 1;
      return makeClient(openedClients % 2 === 1);
    },
    writeArtifacts(savedReport, logLines) {
      state.artifacts.push({ report: savedReport, logLines: [...logLines] });
      return {
        reportPath: savedReport ? "C:/qa/runtime-qa-report.json" : null,
        logPath: "C:/qa/runtime-qa-transport.txt"
      };
    }
  };
  return { driver, state, report };
}

async function runTest(name, callback) {
  await callback();
  process.stdout.write(`PASS: ${name}\n`);
}

(async () => {
  await runTest("argument and ADB parsers reject ambiguity", () => {
    const parsed = parseArguments([
      "run",
      "--serial=SERIAL-1",
      "--package",
      "md.obsidian",
      "--run-timeout-ms",
      "1234"
    ], {});
    assert.equal(parsed.serial, "SERIAL-1");
    assert.equal(parsed.timeouts.run, 1234);
    assert.equal(parseArguments(["probe"], { ANDROID_SERIAL: "SERIAL-ENV" }).serial, "SERIAL-ENV");

    const devices = parseAdbDevices([
      "List of devices attached",
      "SERIAL-1 device product:test",
      "SERIAL-2 unauthorized usb:1-1",
      ""
    ].join("\r\n"));
    assert.equal(selectAdbDevice(devices, null).serial, "SERIAL-1");
    assert.throws(() => selectAdbDevice([
      ...devices,
      { serial: "SERIAL-3", state: "device", details: "" }
    ], null), /Multiple authorized/);
  });

  await runTest("positive-integer timeout parsing rejects fractions", () => {
    const rejected = ["0.5", "1.9"].map((value) => {
      try {
        parseArguments(["run", "--run-timeout-ms", value], {});
        return false;
      } catch (error) {
        return /positive integer/.test(String(error?.message || error));
      }
    });

    assert.deepEqual(
      rejected,
      [true, true],
      `Fractional positive-integer timeouts were accepted: ${JSON.stringify(rejected)}`
    );
  });

  await runTest("report validation rejects missing runtime version evidence", () => {
    const report = makeReport("a".repeat(32));
    assert.equal(validateReport(report).appVersion, "test-app");
    assert.throws(
      () => validateReport({ ...report, appVersion: "unknown" }),
      /invalid report/
    );
    assert.throws(
      () => validateReport({ ...report, pluginVersion: "" }),
      /invalid report/
    );
  });

  await runTest("socket and target selection require exact ownership", () => {
    const sockets = parseDevtoolsSockets([
      "x @chrome_devtools_remote",
      "x @webview_devtools_remote_4242",
      "x @webview_devtools_remote_9999"
    ].join("\n"));
    assert.equal(selectDevtoolsSocket(sockets, "4242", null), "webview_devtools_remote_4242");
    assert.throws(() => selectDevtoolsSocket(sockets, "1111", null), /expected debug WebView socket/);
    assert.equal(selectQaTarget([
      { target: { id: "a" }, identity: { bridgeReady: false, pluginLoaded: true } },
      { target: { id: "b" }, identity: { bridgeReady: true } }
    ], null).id, "b");
  });

  await runTest("forward cleanup is exact even when the operation fails", async () => {
    const fixture = makeFakeDriver();
    await assert.rejects(
      withQaTarget(options(), fixture.driver, async () => { throw new Error("injected operation failure"); }),
      /injected operation failure/
    );
    assert(fixture.state.adbCalls.some((args) => args.join(" ").endsWith("forward --remove tcp:43123")));
    assert(!fixture.state.adbCalls.some((args) => args.includes("--remove-all")));
    assert.equal(fixture.state.closedClients, 2);
  });

  await runTest("forward cleanup failure is blocking", async () => {
    const fixture = makeFakeDriver({ cleanupFailure: true });
    await assert.rejects(
      withQaTarget(options(), fixture.driver, async () => "done"),
      /Could not remove ADB forward tcp:43123/
    );
    assert.equal(fixture.state.adbCalls.filter((args) => args.join(" ").endsWith("forward --remove tcp:43123")).length, 1);
  });

  await runTest("invalid allocated port is discovered and removed exactly", async () => {
    const fixture = makeFakeDriver({ forwardPortOutput: "not-a-port" });
    await assert.rejects(withQaTarget(options(), fixture.driver, async () => "unused"), /invalid forwarded port/);
    assert.equal(fixture.state.forwardAllocated, false);
    assert(fixture.state.adbCalls.some((args) => args.join(" ").endsWith("forward --remove tcp:43123")));
  });

  await runTest("invalid forward cleanup gets a fresh cleanup timeout after discovery expires", async () => {
    const fixture = makeFakeDriver({ forwardPortOutput: "not-a-port", forwardAdvanceMs: 10 });
    await assert.rejects(withQaTarget(options("probe", {
      timeouts: { discovery: 10, cleanup: 25 }
    }), fixture.driver, async () => "unused"), /invalid forwarded port/);
    assert.equal(fixture.state.forwardAllocated, false);
    const cleanupCalls = fixture.state.adbTimeouts.filter((entry) => entry.args.join(" ").includes("forward --remove"));
    assert.equal(cleanupCalls.length, 1);
    assert.equal(cleanupCalls[0].timeoutMs, 25);
  });

  await runTest("run polls the bridge and saves a passing report", async () => {
    const fixture = makeFakeDriver();
    const output = makeIo();
    const result = await runMobileQa(options("run", { timeouts: { poll: 1 } }), fixture.driver, output.io);
    assert.equal(result.report.summary.success, true);
    assert.equal(fixture.state.artifacts.length, 1);
    assert.equal(fixture.state.artifacts[0].report.sessionId, result.report.sessionId);
    assert.match(output.stdout(), /compression-jpeg/);
    assert.match(output.stdout(), /runtime-qa-report/);
    assert(fixture.state.adbCalls.some((args) => args.join(" ").endsWith("forward --remove tcp:43123")));
  });

  await runTest("run saves a mismatched report before rejecting stale installed QA", async () => {
    const fixture = makeFakeDriver();
    await assert.rejects(
      runMobileQa(options("run", { expectedFingerprint: `mobile-qa-src-${"b".repeat(64)}` }), fixture.driver, makeIo().io),
      /does not match the current staged build/
    );
    assert.equal(fixture.state.artifacts.length, 1);
    assert.equal(fixture.state.artifacts[0].report.buildFingerprint, `mobile-qa-src-${"a".repeat(64)}`);
  });

  await runTest("fingerprint validation rejects an old installed bundle", async () => {
    assert.throws(
      () => validateExpectedFingerprint(makeReport("a".repeat(32)), `mobile-qa-src-${"b".repeat(64)}`),
      /does not match the current staged build/
    );
  });

  await runTest("invalid started session is cancelled before transport aborts", async () => {
    const fixture = makeFakeDriver({ sessionId: "invalid-session" });
    await assert.rejects(
      runMobileQa(options("run"), fixture.driver, makeIo().io),
      /invalid session id/
    );
    assert.equal(fixture.state.cancelled, true);
  });

  await runTest("run timeout cancels, retrieves the report, and still fails", async () => {
    const sessionId = "b".repeat(32);
    const fixture = makeFakeDriver({
      sessionId,
      report: makeReport(sessionId, false),
      statuses: [{
        sessionId,
        state: "running",
        phase: "running",
        currentCheck: "slow-check",
        completed: 0,
        total: 1,
        reportReady: false
      }]
    });
    const output = makeIo();
    await assert.rejects(
      runMobileQa(options("run", {
        timeouts: { run: 5, cleanup: 20, report: 20, connect: 10, poll: 5 }
      }), fixture.driver, output.io),
      /exceeded the run timeout/
    );
    assert.equal(fixture.state.cancelled, true);
    assert.equal(fixture.state.artifacts[0].report.sessionId, sessionId);
    assert(fixture.state.adbCalls.some((args) => args.join(" ").endsWith("forward --remove tcp:43123")));
  });

  await runTest("CDP evaluate timeout triggers best-effort bridge cancellation", async () => {
    const sessionId = "c".repeat(32);
    const fixture = makeFakeDriver({
      sessionId,
      statusTimeout: true,
      report: makeReport(sessionId, false)
    });
    await assert.rejects(
      runMobileQa(options("run", { timeouts: { cleanup: 20, report: 20, connect: 10, poll: 1 } }), fixture.driver, makeIo().io),
      /exceeded the run timeout/
    );
    assert.equal(fixture.state.cancelled, true);
  });

  await runTest("manual target fallback plus forward cleanup failure exits as transport failure", async () => {
    const fixture = makeFakeDriver({
      cleanupFailure: true,
      identity: { appReady: true, pluginLoaded: true, bridgeReady: false }
    });
    const output = makeIo();
    const exitCode = await cli(["probe"], {}, output.io, () => fixture.driver);
    assert.equal(exitCode, 1);
    assert.match(output.stderr(), /transport failed/i);
    assert.match(output.stderr(), /Could not remove ADB forward/);
  });

  await runTest("pull-report retrieves the latest report through the bridge", async () => {
    const fixture = makeFakeDriver();
    const output = makeIo();
    const result = await pullLatestReport(options("pull-report"), fixture.driver, output.io);
    assert.equal(result.report.sessionId, fixture.report.sessionId);
    assert.match(output.stdout(), /runtime-qa-report/);
  });

  await runTest("pull-report CLI does not require a staged bundle", async () => {
    const fixture = makeFakeDriver();
    const output = makeIo();
    const exitCode = await cli(
      ["pull-report"],
      {},
      output.io,
      () => fixture.driver,
      () => ({ current: fixture.report.buildFingerprint, staged: null })
    );
    assert.equal(exitCode, 0);
    assert.equal(fixture.state.artifacts.length, 1);
  });

  await runTest("pull-report CLI saves stale diagnostics before fingerprint failure", async () => {
    const fixture = makeFakeDriver();
    const output = makeIo();
    const current = `mobile-qa-src-${"b".repeat(64)}`;
    const exitCode = await cli(
      ["pull-report"],
      {},
      output.io,
      () => fixture.driver,
      () => ({ current, staged: fixture.report.buildFingerprint })
    );
    assert.equal(exitCode, 1);
    assert.equal(fixture.state.artifacts.length, 1);
    assert.match(output.stdout(), /runtime-qa-report/);
    assert.match(output.stderr(), /saved mobile QA report fingerprint/);
  });

  await runTest("pulled reports are compared with an available staged bundle", async () => {
    assert.throws(
      () => validatePulledReportFingerprints(makeReport("a".repeat(32)), {
        current: `mobile-qa-src-${"a".repeat(64)}`,
        staged: `mobile-qa-src-${"b".repeat(64)}`
      }),
      /staged bundle/
    );
  });

  await runTest("missing ADB exits with a graceful manual fallback", async () => {
    const output = makeIo();
    const exitCode = await cli([
      "probe",
      "--adb",
      `definitely-missing-adb-${Date.now()}`,
      "--discovery-timeout-ms",
      "100"
    ], {}, output.io);
    assert.equal(exitCode, MANUAL_FALLBACK_EXIT_CODE);
    assert.match(output.stderr(), /Manual fallback:/);
    assert.match(output.stderr(), /Local Image Compress QA\/reports/);
  });

  process.stdout.write("Android mobile QA transport self-tests passed.\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
