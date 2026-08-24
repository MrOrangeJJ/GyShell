import assert from "node:assert/strict";
import {
  decideRendererRecovery,
  normalizeRendererRecoveryReason,
  shouldRecoverWindowsForChildProcess,
} from "./rendererRecovery";

assert.deepEqual(
  decideRendererRecovery("crashed", { now: 100, attempts: 0 }),
  { action: "reload", safeMode: false, attempt: 1, reason: "crashed" },
);
assert.deepEqual(
  decideRendererRecovery("oom", {
    now: 200,
    attempts: 1,
    lastFailureAt: 150,
  }),
  { action: "safe-mode", safeMode: true, attempt: 2, reason: "oom" },
);
assert.deepEqual(
  decideRendererRecovery("crashed", {
    now: 100_000,
    attempts: 9,
    lastFailureAt: 1,
  }),
  { action: "reload", safeMode: false, attempt: 1, reason: "crashed" },
);
assert.equal(normalizeRendererRecoveryReason("killed"), "killed");
assert.equal(normalizeRendererRecoveryReason("unknown"), "crashed");
assert.equal(
  shouldRecoverWindowsForChildProcess({ type: "GPU", reason: "oom" }),
  true,
);
assert.equal(
  shouldRecoverWindowsForChildProcess({ type: "Utility", reason: "crashed" }),
  false,
);
assert.equal(
  shouldRecoverWindowsForChildProcess({ type: "GPU", reason: "clean-exit" }),
  false,
);
console.log("All renderer recovery extreme tests passed.");
