"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runEsbuildCli } = require("./run-esbuild-cli");

const root = path.resolve(__dirname, "..");
let bundleNumber = 0;

function bundleModule(entryPoint, name) {
  const outputPath = path.join(os.tmpdir(), `lic-mutation-limiters-${process.pid}-${Date.now()}-${bundleNumber++}-${name}.cjs`);
  runEsbuildCli([
    entryPoint,
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=es2020",
    `--outfile=${outputPath}`,
    "--log-level=silent"
  ], { cwd: root, stdio: "pipe" });
  try {
    return require(outputPath);
  } finally {
    delete require.cache[outputPath];
    fs.rmSync(outputPath, { force: true });
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

async function within(promise, message) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), 250);
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function testConcurrency(ConcurrencyLimiter) {
  for (const invalidLimit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.throws(() => new ConcurrencyLimiter(invalidLimit), RangeError);
  }

  const limiter = new ConcurrencyLimiter(1);
  assert.equal(limiter.getLimit(), 1);
  const firstGate = deferred();
  const secondGate = deferred();
  const started = [];
  let running = 0;
  let maxRunning = 0;
  const first = limiter.run(async () => {
    started.push("first");
    running++;
    maxRunning = Math.max(maxRunning, running);
    await firstGate.promise;
    running--;
  });
  await flush();
  const second = limiter.run(async () => {
    started.push("second");
    running++;
    maxRunning = Math.max(maxRunning, running);
    await secondGate.promise;
    running--;
  });
  const third = limiter.run(async () => {
    started.push("third");
    running++;
    maxRunning = Math.max(maxRunning, running);
    running--;
  });
  await flush();
  assert.deepEqual(started, ["first"]);
  firstGate.resolve();
  await flush();
  assert.deepEqual(started, ["first", "second"]);
  secondGate.resolve();
  await within(Promise.all([first, second, third]), "ConcurrencyLimiter did not drain FIFO tasks");
  assert.deepEqual(started, ["first", "second", "third"]);
  assert.equal(maxRunning, 1);
  assert.equal(limiter.active, 0);
  assert.equal(limiter.queue.length, 0);

  const bounded = new ConcurrencyLimiter(2);
  const leftGate = deferred();
  const rightGate = deferred();
  const boundedStarts = [];
  const boundedTasks = [
    bounded.run(async () => { boundedStarts.push("left"); await leftGate.promise; }),
    bounded.run(async () => { boundedStarts.push("right"); await rightGate.promise; }),
    bounded.run(async () => { boundedStarts.push("queued"); })
  ];
  await flush();
  assert.deepEqual(boundedStarts, ["left", "right"]);
  assert.equal(bounded.active, 2);
  leftGate.resolve();
  rightGate.resolve();
  await within(Promise.all(boundedTasks), "ConcurrencyLimiter did not drain bounded tasks");
  assert.equal(bounded.active, 0);

  const recovery = new ConcurrencyLimiter(1);
  const recoveryGate = deferred();
  const held = recovery.run(async () => recoveryGate.promise);
  await flush();
  const queued = recovery.run(async () => "recovered");
  await flush();
  recovery.queue.unshift(() => {
    throw new Error("corrupt waiter");
  });
  recoveryGate.resolve();
  await within(held, "ConcurrencyLimiter did not release corrupt queue holder");
  assert.equal(await within(queued, "ConcurrencyLimiter did not recover corrupt waiter"), "recovered");
  assert.equal(recovery.active, 0);
  assert.equal(recovery.queue.length, 0);

  const failures = new ConcurrencyLimiter(1);
  await within(assert.rejects(failures.run(() => { throw new Error("sync failure"); }), /sync failure/), "ConcurrencyLimiter did not settle sync failure");
  await within(assert.rejects(failures.run(async () => { throw new Error("async failure"); }), /async failure/), "ConcurrencyLimiter did not settle async failure");
  assert.equal(await within(failures.run(async () => "after-failure"), "ConcurrencyLimiter did not recover after failure"), "after-failure");
  assert.equal(failures.active, 0);

  const invalidState = new ConcurrencyLimiter(1);
  invalidState.limit = 0;
  await within(assert.rejects(invalidState.run(async () => "never"), /invalid state/), "ConcurrencyLimiter accepted an invalid internal limit");

  const emptyQueue = new ConcurrencyLimiter(1);
  assert.equal(emptyQueue.queue.length, 0);
}

async function testMemory(MemoryBudgetLimiter) {
  for (const invalidBudget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new MemoryBudgetLimiter(invalidBudget), /positive finite/);
  }

  const limiter = new MemoryBudgetLimiter(10);
  const first = await within(limiter.reserve(7), "MemoryBudgetLimiter did not admit the first reservation");
  const order = [];
  const secondPromise = limiter.reserve(4).then((reservation) => {
    order.push("second");
    return reservation;
  });
  const thirdPromise = limiter.reserve(3).then((reservation) => {
    order.push("third");
    return reservation;
  });
  await flush();
  assert.deepEqual(order, []);
  await within(first.resize(6), "MemoryBudgetLimiter head shrink did not settle");
  const second = await within(secondPromise, "MemoryBudgetLimiter did not admit FIFO head after shrink");
  assert.equal(limiter.activeWeight, 10);
  await flush();
  assert.deepEqual(order, ["second"]);
  second.release();
  const third = await within(thirdPromise, "MemoryBudgetLimiter did not admit next FIFO waiter");
  assert.deepEqual(order, ["second", "third"]);
  third.release();
  first.release();
  assert.equal(limiter.activeWeight, 0);

  const accounting = new MemoryBudgetLimiter(10);
  const fractional = await within(accounting.reserve(3.1), "Fractional memory reservation did not settle");
  assert.equal(accounting.activeWeight, 4);
  fractional.release();
  assert.equal(accounting.activeWeight, 0);
  const clamped = await within(accounting.reserve(Number.NaN), "Non-finite memory reservation did not settle");
  assert.equal(accounting.activeWeight, 10);
  clamped.release();
  assert.equal(accounting.activeWeight, 0);

  const resizeLimiter = new MemoryBudgetLimiter(10);
  const resizable = await within(resizeLimiter.reserve(4), "Resizable memory reservation did not settle");
  const competing = await within(resizeLimiter.reserve(6), "Competing memory reservation did not settle");
  let growthDone = false;
  const growth = resizable.resize(7).then(() => { growthDone = true; });
  await flush();
  assert.equal(growthDone, false);
  competing.release();
  await within(growth, "Memory reservation growth did not resume after release");
  assert.equal(resizeLimiter.activeWeight, 7);
  const queuedAfterShrink = resizeLimiter.reserve(4);
  await flush();
  await within(resizable.resize(3), "Memory reservation shrink did not settle");
  const admittedAfterShrink = await within(queuedAfterShrink, "Memory reservation shrink did not release capacity");
  admittedAfterShrink.release();
  resizable.release();
  resizable.release();
  await within(assert.rejects(resizable.resize(1), /already released/), "Released reservation resize did not reject");

  const sameWeight = new MemoryBudgetLimiter(10);
  const sameReservation = await within(sameWeight.reserve(5), "Same-size memory reservation did not settle");
  const sameWaiter = sameWeight.reserve(6);
  await flush();
  await within(sameReservation.resize(5), "Same-size memory reservation resize did not settle");
  assert.equal(sameWeight.activeWeight, 5);
  sameReservation.release();
  (await within(sameWaiter, "Same-size resize changed FIFO admission")).release();

  const shrinking = new MemoryBudgetLimiter(10);
  const shrinkReservation = await within(shrinking.reserve(5), "Shrink test reservation did not settle");
  const shrinkWaiter = shrinking.reserve(6);
  await flush();
  await within(shrinkReservation.resize(3), "Memory reservation shrink did not settle");
  const shrinkAdmitted = await within(shrinkWaiter, "Memory reservation shrink did not transfer capacity");
  assert.equal(shrinking.activeWeight, 9);
  shrinkAdmitted.release();
  shrinkReservation.release();

  const exactShrinkFifo = new MemoryBudgetLimiter(10);
  const heldSeven = await within(exactShrinkFifo.reserve(7), "Seven-byte reservation did not settle");
  const queuedFour = exactShrinkFifo.reserve(4);
  await flush();
  await within(heldSeven.resize(3), "Seven-to-three resize did not settle");
  const admittedFour = await within(queuedFour, "Seven-to-three resize did not admit the FIFO waiter");
  assert.equal(exactShrinkFifo.activeWeight, 7);
  admittedFour.release();
  heldSeven.release();

  const normalized = new MemoryBudgetLimiter(10);
  const full = await within(normalized.reserve(0), "Zero memory reservation did not normalize to the full budget");
  let blocked = false;
  const blockedReservation = normalized.reserve(1).then((reservation) => {
    blocked = false;
    return reservation;
  });
  blocked = true;
  await flush();
  assert.equal(blocked, true);
  full.release();
  (await within(blockedReservation, "Normalized full reservation did not release capacity")).release();

  const runCleanup = new MemoryBudgetLimiter(10);
  await within(assert.rejects(runCleanup.run(10, async () => { throw new Error("task failure"); }), /task failure/), "Memory run did not settle failure");
  const afterFailure = await within(runCleanup.reserve(10), "Memory run did not release after failure");
  assert.equal(runCleanup.activeWeight, 10);
  afterFailure.release();

  const destroyed = new MemoryBudgetLimiter(10);
  const held = await within(destroyed.reserve(10), "Destroy test reservation did not settle");
  const waiting = destroyed.reserve(1);
  const destroyError = new Error("destroyed");
  destroyed.destroy(destroyError);
  await within(assert.rejects(waiting, destroyError), "Memory destroy did not reject queued reservation");
  await within(assert.rejects(destroyed.reserve(1), destroyError), "Memory destroy did not reject future reservation");
  held.release();
  assert.equal(destroyed.activeWeight, 0);

  const emptyWaiters = new MemoryBudgetLimiter(10);
  assert.equal(emptyWaiters.waiters.length, 0);

  const idempotent = new MemoryBudgetLimiter(10);
  const idempotentHeld = await within(idempotent.reserve(5), "Idempotence test reservation did not settle");
  const idempotentWaiter = idempotent.reserve(6);
  await flush();
  idempotentHeld.release();
  const idempotentAdmitted = await within(idempotentWaiter, "First release did not admit queued reservation");
  assert.equal(idempotent.activeWeight, 6);
  idempotentHeld.release();
  assert.equal(idempotent.activeWeight, 6);
  idempotentAdmitted.release();
}

async function main() {
  const { ConcurrencyLimiter } = bundleModule(path.join("src-ts", "concurrency-limiter.ts"), "concurrency");
  const { MemoryBudgetLimiter } = bundleModule(path.join("src-ts", "memory-budget-limiter.ts"), "memory");
  await testConcurrency(ConcurrencyLimiter);
  await testMemory(MemoryBudgetLimiter);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
