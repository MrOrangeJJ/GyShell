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
for (const runtimePath of [
  join(currentDir, "../../runtimes/gybackend/startGyBackend.ts"),
  join(currentDir, "../../../../electron/src/main/startElectronMain.ts"),
]) {
  const source = readFileSync(runtimePath, "utf8");
  assert.equal(
    source.match(
      /requireLiveTerminalBridgeTarget\(terminalService, terminalId\)/g,
    )?.length,
    6,
    `${runtimePath} should guard every non-reconnect terminal bridge operation`,
  );
}

console.log("terminalBridgeAdmission.extreme.spec.ts passed");
