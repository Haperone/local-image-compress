"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  ACTIVE_RUNTIME_QA_SYMBOL_KEY,
  buildReleaseRuntimeQaExpression,
  buildReserveRuntimeQaExpression
} = require("./run-runtime-qa");

const runtimeQaSource = fs.readFileSync(path.join(__dirname, "runtime-qa.js"), "utf8");
const carrierBlock = runtimeQaSource.match(/\/\/ RUNTIME_QA_CARRIER_START([\s\S]*?)\/\/ RUNTIME_QA_CARRIER_END/)?.[1];
assert(carrierBlock, "Runtime QA carrier block is missing");
const { claimRuntimeQaCarrier, finishRuntimeQaCarrier } = Function(
  `"use strict";${carrierBlock}; return { claimRuntimeQaCarrier, finishRuntimeQaCarrier };`
)();
const carrierSymbol = Symbol.for(ACTIVE_RUNTIME_QA_SYMBOL_KEY);

function evaluate(expression, rendererContext) {
  return vm.runInContext(expression, rendererContext);
}

const rendererContext = vm.createContext({});
const rendererGlobal = vm.runInContext("globalThis", rendererContext);
const tokenA = "a".repeat(32);
const tokenB = "b".repeat(32);
assert.equal(evaluate(buildReserveRuntimeQaExpression(tokenA), rendererContext).reserved, true);
assert.equal(rendererGlobal[carrierSymbol].phase, "reserved");

const ownerA = claimRuntimeQaCarrier(rendererGlobal, carrierSymbol, tokenA, "2026-07-17T00:00:00.000Z");
assert.equal(ownerA.phase, "running");
assert.equal(evaluate(buildReserveRuntimeQaExpression(tokenB), rendererContext).reserved, false);
assert.equal(evaluate(buildReleaseRuntimeQaExpression(tokenA), rendererContext), false, "Wrapper release deleted a running payload");

finishRuntimeQaCarrier(rendererGlobal, carrierSymbol, ownerA, "2026-07-17T00:01:00.000Z");
assert.equal(rendererGlobal[carrierSymbol], ownerA, "Wrapper carrier was released before post-processing cleanup");
assert.equal(ownerA.phase, "settled");
assert.equal(evaluate(buildReserveRuntimeQaExpression(tokenB), rendererContext).reserved, false, "Settled payload admitted an overlapping wrapper");
assert.equal(evaluate(buildReleaseRuntimeQaExpression(tokenB), rendererContext), false, "Foreign token released the settled owner");

let cleanupObservedOwner = false;
cleanupObservedOwner = rendererGlobal[carrierSymbol] === ownerA;
assert.equal(cleanupObservedOwner, true, "Wrapper cleanup did not remain carrier-owned");
assert.equal(evaluate(buildReleaseRuntimeQaExpression(tokenA), rendererContext), true);
assert.equal(rendererGlobal[carrierSymbol], undefined);
assert.equal(evaluate(buildReserveRuntimeQaExpression(tokenB), rendererContext).reserved, true);
assert.equal(evaluate(buildReleaseRuntimeQaExpression(tokenB), rendererContext), true, "Pre-launch failure could not release its reservation");

assert.throws(
  () => claimRuntimeQaCarrier(rendererGlobal, carrierSymbol, tokenA, "2026-07-17T00:02:00.000Z"),
  /no matching renderer reservation/
);

const directOwner = claimRuntimeQaCarrier(rendererGlobal, carrierSymbol, undefined, "2026-07-17T00:03:00.000Z");
assert.equal(directOwner.owner, "direct");
finishRuntimeQaCarrier(rendererGlobal, carrierSymbol, directOwner, "2026-07-17T00:04:00.000Z");
assert.equal(rendererGlobal[carrierSymbol], undefined, "Direct runtime QA did not self-release");

process.stdout.write("Desktop runtime QA carrier lifecycle tests passed.\n");
