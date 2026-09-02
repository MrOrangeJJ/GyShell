/**
 * Chromium integration tests for FileSystemPanel drop admission.
 *
 * These cases mount the real component and dispatch real DOM drop events so
 * malformed or stale custom MIME payloads cannot bypass source-terminal
 * ownership through native Files fallback.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../../..");
const electronBin = path.join(repoRoot, "node_modules/.bin/electron");
const esbuildBin = path.join(repoRoot, "node_modules/.bin/esbuild");

if (!fs.existsSync(electronBin)) {
  console.log("SKIP filesystem panel drop tests (electron binary unavailable)");
  process.exit(0);
}

const workDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "gyshell-filesystem-panel-drop-"),
);
const bundlePath = path.join(workDir, "fileSystemPanel.js");
const entryPath = path.join(
  here,
  `__fileSystemPanelDropEntry.${process.pid}.tsx`,
);

try {
  fs.writeFileSync(
    entryPath,
    [
      `import * as React from "react";`,
      `import { createRoot } from "react-dom/client";`,
      `import { FileSystemPanel } from "./FileSystemPanel";`,
      `import { I18nStore } from "../../stores/I18nStore";`,
      `(globalThis as any).FileSystemPanelModule = { FileSystemPanel, I18nStore, React, createRoot };`,
    ].join("\n"),
  );

  const bundle = spawnSync(
    esbuildBin,
    [
      entryPath,
      "--bundle",
      "--format=iife",
      `--outfile=${bundlePath}`,
      "--loader:.css=text",
      "--loader:.scss=text",
      "--loader:.svg=text",
      "--loader:.png=dataurl",
      '--define:process.env.NODE_ENV="production"',
      "--jsx=automatic",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (bundle.status !== 0) {
    console.error("FAIL could not bundle FileSystemPanel for drop tests");
    console.error(bundle.stderr || bundle.stdout);
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(entryPath, { force: true });
}

if (process.exitCode) {
  fs.rmSync(workDir, { recursive: true, force: true });
  process.exit(process.exitCode);
}

const harnessHtml = String.raw`<!doctype html>
<html><body><div id="root"></div>
<script src="./fileSystemPanel.js"></script>
<script>
const { FileSystemPanel, I18nStore, React, createRoot } = FileSystemPanelModule;
const MIME = "application/x-gyshell-filesystem-items";

const counters = {
  customBodyReads: 0,
  nativeFilesReads: 0,
  nativePathReads: 0,
  transferStarts: 0,
  clipboardMutations: 0,
  filesystemCalls: 0,
};

function resetCounters() {
  Object.keys(counters).forEach((key) => { counters[key] = 0; });
}

function snapshotCounters() {
  return { ...counters };
}

const target = {
  id: "target-terminal",
  title: "Target",
  config: { id: "target-terminal", type: "local", title: "Target" },
  capabilities: { supportsFilesystem: true, supportsMonitor: true },
  runtimeState: "initializing",
};
const goodSource = {
  id: "source-terminal",
  title: "Source",
  config: { id: "source-terminal", type: "ssh", title: "Source" },
  capabilities: { supportsFilesystem: true, supportsMonitor: true },
  runtimeState: "ready",
};
const unsupportedSource = {
  id: "source-no-filesystem",
  title: "Unsupported source",
  config: { id: "source-no-filesystem", type: "ssh", title: "Unsupported source" },
  capabilities: { supportsFilesystem: false, supportsMonitor: true },
  runtimeState: "ready",
};

const store = {
  i18n: new I18nStore(),
  fileSystemClipboard: null,
  fileTransferTasks: Object.create(null),
  terminalTabs: [target, goodSource, unsupportedSource],
  layout: {
    isDragging: false,
    draggingPanelId: null,
    getPanelRect: () => ({ width: 900, height: 700 }),
  },
  panelTabDisplayMode: "auto",
  settings: { terminal: { fontSize: 14 } },
  clearFileSystemClipboard() { counters.clipboardMutations += 1; },
  setFileSystemClipboard() { counters.clipboardMutations += 1; },
  getPreferredLocalTerminalId: () => "target-terminal",
  startFileTransfer: async () => {
    counters.transferStarts += 1;
    return { id: "transfer-1" };
  },
  cancelFileTransferTask: async () => {},
  openFileEditorFromFileSystem: async () => {},
};

window.gyshell = {
  gateway: { isSameMachine: async () => ({ sameMachine: true }) },
  filesystem: new Proxy({}, {
    get() {
      return async () => {
        counters.filesystemCalls += 1;
        return { path: "/target", entries: [] };
      };
    },
  }),
  system: {
    platform: "darwin",
    getPathForFile: () => {
      counters.nativePathReads += 1;
      return "/native/bypass.txt";
    },
    startFileDrag: () => {},
  },
};

const container = document.getElementById("root");
createRoot(container).render(
  React.createElement(FileSystemPanel, {
    store,
    panelId: "filesystem-panel",
    tabs: [target],
    activeTabId: "target-terminal",
    onSelectTab: () => {},
  }),
);

const wait = () => new Promise((resolve) => setTimeout(resolve, 40));
const dropTarget = () => container.querySelector(".filesystem-list");

function transfer(rawBody) {
  return {
    types: [MIME, "Files"],
    getData(type) {
      counters.customBodyReads += 1;
      return type === MIME ? rawBody : "";
    },
    get files() {
      counters.nativeFilesReads += 1;
      return [new File(["x"], "native-bypass.txt")];
    },
    dropEffect: "none",
  };
}

function payload(sourceTerminalId) {
  return JSON.stringify({
    version: 1,
    sourceTerminalId,
    sourceBasePath: "/source",
    entries: [{ name: "report.txt", path: "/source/report.txt", isDirectory: false }],
  });
}

function fireDrop(dataTransfer) {
  const event = new DragEvent("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  dropTarget().dispatchEvent(event);
  return event.defaultPrevented;
}

async function runDrop(rawBody) {
  resetCounters();
  const defaultPrevented = fireDrop(transfer(rawBody));
  await wait();
  return { counters: snapshotCounters(), defaultPrevented };
}

window.__cases = {
  async malformedAdvertisedPayload() {
    return runDrop('{"version":1,"sourceTerminalId":"source-terminal","entries":[]}');
  },
  async missingSourceTerminal() {
    return runDrop(payload("missing-source"));
  },
  async unsupportedSourceTerminal() {
    return runDrop(payload("source-no-filesystem"));
  },
  async validSourceTerminal() {
    return runDrop(payload("source-terminal"));
  },
};

(async () => {
  await wait();
  window.__ready = !!dropTarget();
})();
</script>
</body></html>`;

fs.writeFileSync(path.join(workDir, "harness.html"), harnessHtml);

const mainJs = String.raw`
const { app, BrowserWindow } = require("electron");
const path = require("path");
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const errors = [];
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) errors.push(message);
  });
  await win.loadFile(path.join(__dirname, "harness.html"));
  const out = await win.webContents.executeJavaScript(` + "`" + `(async () => {
    for (let attempt = 0; attempt < 100 && !window.__ready; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!window.__ready) throw new Error("FileSystemPanel did not mount");
    const results = {};
    for (const [name, fn] of Object.entries(window.__cases)) {
      try { results[name] = { ok: true, value: await fn() }; }
      catch (error) { results[name] = { ok: false, error: String(error && error.stack || error) }; }
    }
    return results;
  })()` + "`" + `);
  console.log("__RESULT__" + JSON.stringify({ results: out, errors }));
  app.exit(0);
});
`;
fs.writeFileSync(path.join(workDir, "main.js"), mainJs);
fs.writeFileSync(
  path.join(workDir, "package.json"),
  JSON.stringify({ name: "filesystem-panel-drop-harness", main: "main.js" }),
);

const run = spawnSync(electronBin, [workDir], {
  cwd: repoRoot,
  encoding: "utf8",
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
});
const marker = (run.stdout || "").split("__RESULT__")[1];
if (!marker) {
  console.error("FAIL harness produced no result");
  console.error(run.stdout);
  console.error(run.stderr);
  fs.rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

const { results, errors } = JSON.parse(marker.trim());
let failures = 0;
const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};
const check = (caseName: string, label: string, verify: (value: any) => void) => {
  const entry = results[caseName];
  if (!entry?.ok) {
    failures += 1;
    console.error(`FAIL ${label}`);
    console.error(entry?.error || "case did not run");
    return;
  }
  try {
    verify(entry.value);
    console.log(`PASS ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}`);
    console.error(error);
  }
};

for (const [caseName, label] of [
  ["malformedAdvertisedPayload", "malformed advertised payload"],
  ["missingSourceTerminal", "missing source terminal"],
  ["unsupportedSourceTerminal", "filesystem-ineligible source terminal"],
]) {
  check(caseName, `${label} is rejected before FileSystemPanel side effects`, (value) => {
    assert(value.defaultPrevented === true, "the authoritative drop must be consumed");
    assert(value.counters.customBodyReads === 1, "custom body must be read exactly once");
    assert(value.counters.nativeFilesReads === 0, "native Files must not be read");
    assert(value.counters.nativePathReads === 0, "native paths must not be resolved");
    assert(value.counters.transferStarts === 0, "no transfer may be registered");
    assert(value.counters.clipboardMutations === 0, "clipboard state must not mutate");
    assert(value.counters.filesystemCalls === 0, "no filesystem I/O may run");
  });
}

check("validSourceTerminal", "valid exact filesystem source starts one transfer", (value) => {
  assert(value.defaultPrevented === true, "the valid custom drop must be consumed");
  assert(value.counters.customBodyReads === 1, "custom body must be read exactly once");
  assert(value.counters.nativeFilesReads === 0, "valid custom MIME must not read native Files");
  assert(value.counters.nativePathReads === 0, "valid custom MIME must not resolve native paths");
  assert(value.counters.transferStarts === 1, "exactly one transfer must start");
  assert(value.counters.clipboardMutations === 0, "drop transfer must not mutate clipboard state");
  assert(value.counters.filesystemCalls === 0, "the drop must not perform eager filesystem I/O");
});

fs.rmSync(workDir, { recursive: true, force: true });
if (errors.length > 0) {
  failures += 1;
  console.error(`Renderer reported ${errors.length} error(s):`);
  errors.forEach((message: string) => console.error(`  ${message}`));
}
if (failures > 0) {
  console.error(`${failures} filesystem panel drop test(s) failed.`);
  process.exit(1);
}
console.log("All filesystem panel drop extreme tests passed.");
