import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireLiveTerminalBridgeTarget } from "./terminalBridgeAdmission";

const exactTerminalId = "  Term-#]::__proto__  ";
const terminal = { id: exactTerminalId };
const registry = {
  getTerminalById(terminalId: string): unknown {
    return new Map([[exactTerminalId, terminal]]).get(terminalId);
  },
};

assert.doesNotThrow(() =>
  requireLiveTerminalBridgeTarget(registry, exactTerminalId),
);
for (const invalidSelector of [
  exactTerminalId.trim(),
  exactTerminalId.toLowerCase(),
  "__proto__",
  "missing",
]) {
  assert.throws(
    () => requireLiveTerminalBridgeTarget(registry, invalidSelector),
    /Terminal .* not found\./,
    `bridge admission should reject non-member selector ${JSON.stringify(invalidSelector)}`,
  );
}

const currentDir = dirname(fileURLToPath(import.meta.url));
// Both runtime bridges require a registered terminal for Activity reads too.
// Exited SSH tabs remain registered so their persisted timeline is still
// available to a reconnecting client; unknown or closed IDs are rejected.
const runtimeExpectations = new Map([
  [
    join(currentDir, "../../runtimes/gybackend/startGyBackend.ts"),
    7,
  ],
  [join(currentDir, "../../../../electron/src/main/startElectronMain.ts"), 7],
]);
for (const [runtimePath, expectedGuardCount] of runtimeExpectations) {
  const source = readFileSync(runtimePath, "utf8");
  assert.equal(
    source.match(
      /requireLiveTerminalBridgeTarget\(terminalService, terminalId\)/g,
    )?.length,
    expectedGuardCount,
    `${runtimePath} should guard every live terminal bridge operation`,
  );
}

console.log("terminalBridgeAdmission.extreme.spec.ts passed");
