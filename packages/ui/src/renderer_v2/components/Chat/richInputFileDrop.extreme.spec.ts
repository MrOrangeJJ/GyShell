/**
 * Extreme tests for dropping files onto the chat composer.
 *
 * The behaviour under test is DOM editing inside a contenteditable, so the
 * cases run the real RichInput component inside a real Chromium renderer
 * (Electron) rather than a DOM shim.
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
  console.log("SKIP rich input file drop tests (electron binary unavailable)");
  process.exit(0);
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "gyshell-richinput-drop-"));
const bundlePath = path.join(workDir, "richInput.js");
// Written next to the component so esbuild resolves the workspace node_modules.
const entryPath = path.join(here, `__richInputDropEntry.${process.pid}.tsx`);

fs.writeFileSync(
  entryPath,
  [
    `import * as React from "react";`,
    `import { createRoot } from "react-dom/client";`,
    `import { RichInput } from "./RichInput";`,
    `import { encodePassChatMentionToken } from "@gyshell/shared";`,
    `(globalThis as any).RichInputModule = { RichInput, React, createRoot, encodePassChatMentionToken };`,
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
fs.rmSync(entryPath, { force: true });
if (bundle.status !== 0) {
  console.error("FAIL could not bundle RichInput for the drop tests");
  console.error(bundle.stderr || bundle.stdout);
  process.exit(1);
}

const harnessHtml = String.raw`<!doctype html>
<html><body><div id="root"></div>
<script src="./richInput.js"></script>
<script>
const { RichInput, React, createRoot, encodePassChatMentionToken } = RichInputModule;

const store = {
  terminalTabs: [
    {
      id: "local-main",
      title: "Local (1)",
      config: { type: "local" },
      capabilities: { supportsFilesystem: true, supportsMonitor: true },
    },
    {
      id: "ssh-1",
      title: "Remote",
      config: { type: "ssh" },
      capabilities: { supportsFilesystem: true, supportsMonitor: true },
    },
    {
      id: "ssh-no-filesystem",
      title: "Remote without filesystem",
      config: { type: "ssh" },
      capabilities: { supportsFilesystem: false, supportsMonitor: true },
    },
  ],
  getPreferredLocalTerminalId: () => "local-main",
  skills: [],
  settings: { tools: { skills: {} } },
};

let handle = null;
const container = document.getElementById("root");
createRoot(container).render(
  React.createElement(RichInput, {
    ref: (h) => { handle = h; },
    store,
    onSend: () => {},
    onInput: () => {},
  }),
);

const editor = () => container.querySelector('[contenteditable="true"]');
const tags = () => Array.from(editor().querySelectorAll(".mention-tag"));
const names = () => tags().map((t) => t.dataset.name);

function makeFile(name) {
  return new File(["x"], name, { type: "" });
}

/** Build a DataTransfer carrying OS files, mirroring a Finder drag. */
function nativeFileTransfer(fileNames) {
  const dt = new DataTransfer();
  fileNames.forEach((n) => dt.items.add(makeFile(n)));
  return dt;
}

function panelTransfer(entries, sourceTerminalId) {
  const dt = new DataTransfer();
  dt.setData(
    "application/x-gyshell-filesystem-items",
    JSON.stringify({ version: 1, sourceTerminalId, sourceBasePath: "/base", entries }),
  );
  return dt;
}

function authoritativePanelTransfer(rawBody, counters) {
  return {
    types: ["application/x-gyshell-filesystem-items", "Files"],
    getData(type) {
      counters.customBodyReads += 1;
      return type === "application/x-gyshell-filesystem-items" ? rawBody : "";
    },
    get files() {
      counters.nativeFilesReads += 1;
      return [makeFile("native-bypass.txt")];
    },
  };
}

function makeDropCounters() {
  return {
    customBodyReads: 0,
    nativeFilesReads: 0,
    nativePathReads: 0,
    filesystemReads: 0,
  };
}

function installDropSideEffectSpies(counters) {
  window.gyshell = {
    system: {
      getPathForFile: () => {
        counters.nativePathReads += 1;
        return "/native/bypass.txt";
      },
    },
    filesystem: {
      readFileBase64: async () => {
        counters.filesystemReads += 1;
        return { contentBase64: "eA==", path: "/source/image.png", mimeType: "image/png" };
      },
    },
  };
}

function fireDrop(dataTransfer) {
  const event = new DragEvent("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  editor().dispatchEvent(event);
}

function reset() {
  handle.clear();
  editor().focus();
}

const wait = () => new Promise((r) => setTimeout(r, 30));

window.__cases = {
  async multipleNativeFiles() {
    reset();
    // Electron exposes real paths through the preload bridge.
    window.gyshell = { system: { getPathForFile: (f) => "/Users/demo/" + f.name } };
    fireDrop(nativeFileTransfer(["a.txt", "b.txt", "c.txt"]));
    await wait();
    return { names: names(), serialized: handle.getValue() };
  },

  async manyNativeFiles() {
    reset();
    window.gyshell = { system: { getPathForFile: (f) => "/Users/demo/" + f.name } };
    const list = Array.from({ length: 50 }, (_, i) => "file-" + i + ".txt");
    fireDrop(nativeFileTransfer(list));
    await wait();
    return { count: tags().length, names: names() };
  },

  async dropOntoExistingText() {
    reset();
    handle.setValue("please review ");
    editor().focus();
    const range = document.createRange();
    range.selectNodeContents(editor());
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    window.gyshell = { system: { getPathForFile: (f) => "/Users/demo/" + f.name } };
    fireDrop(nativeFileTransfer(["one.md", "two.md"]));
    await wait();
    return { names: names(), serialized: handle.getValue() };
  },

  async consecutiveDrops() {
    reset();
    window.gyshell = { system: { getPathForFile: (f) => "/Users/demo/" + f.name } };
    fireDrop(nativeFileTransfer(["a.txt", "b.txt"]));
    await wait();
    fireDrop(nativeFileTransfer(["c.txt", "d.txt"]));
    await wait();
    return { names: names() };
  },

  async panelMultiSelect() {
    reset();
    const entries = ["x.log", "y.log", "z.log"].map((n) => ({
      name: n, path: "/srv/" + n, isDirectory: false,
    }));
    fireDrop(panelTransfer(entries, "ssh-1"));
    await wait();
    return { names: names(), serialized: handle.getValue() };
  },

  async panelMixedWithDirectories() {
    reset();
    const entries = [
      { name: "src", path: "/srv/src", isDirectory: true },
      { name: "a.log", path: "/srv/a.log", isDirectory: false },
      { name: "docs", path: "/srv/docs", isDirectory: true },
    ];
    fireDrop(panelTransfer(entries, "ssh-1"));
    await wait();
    return { count: tags().length, names: names() };
  },

  async malformedAdvertisedPanelPayloadIsSideEffectFree() {
    reset();
    const counters = makeDropCounters();
    installDropSideEffectSpies(counters);
    fireDrop(authoritativePanelTransfer('{"version":1,"entries":[]}', counters));
    await wait();
    return { counters, count: tags().length, serialized: handle.getValue() };
  },

  async missingPanelSourceIsSideEffectFree() {
    reset();
    const counters = makeDropCounters();
    installDropSideEffectSpies(counters);
    const body = JSON.stringify({
      version: 1,
      sourceTerminalId: "missing-source",
      sourceBasePath: "/source",
      entries: [{ name: "image.png", path: "/source/image.png", isDirectory: false }],
    });
    fireDrop(authoritativePanelTransfer(body, counters));
    await wait();
    return { counters, count: tags().length, serialized: handle.getValue() };
  },

  async unsupportedPanelSourceIsSideEffectFree() {
    reset();
    const counters = makeDropCounters();
    installDropSideEffectSpies(counters);
    const body = JSON.stringify({
      version: 1,
      sourceTerminalId: "ssh-no-filesystem",
      sourceBasePath: "/source",
      entries: [{ name: "image.png", path: "/source/image.png", isDirectory: false }],
    });
    fireDrop(authoritativePanelTransfer(body, counters));
    await wait();
    return { counters, count: tags().length, serialized: handle.getValue() };
  },

  async duplicatePathsAreKept() {
    reset();
    window.gyshell = { system: { getPathForFile: () => "/Users/demo/same.txt" } };
    fireDrop(nativeFileTransfer(["same.txt", "same.txt"]));
    await wait();
    return { count: tags().length };
  },

  async unresolvablePathsAreSkipped() {
    reset();
    window.gyshell = { system: { getPathForFile: () => "" } };
    fireDrop(nativeFileTransfer(["ghost.txt", "gone.txt"]));
    await wait();
    return { count: tags().length };
  },

  async pathsWithSpecialCharacters() {
    reset();
    const specials = ["my file.txt", "re#port&v2.md", "\u4e2d\u6587\u6587\u4ef6.txt"];
    window.gyshell = { system: { getPathForFile: (f) => "/Users/demo/" + f.name } };
    fireDrop(nativeFileTransfer(specials));
    await wait();
    return { names: names(), serialized: handle.getValue() };
  },

  async caretStaysAtEndForTyping() {
    reset();
    window.gyshell = { system: { getPathForFile: (f) => "/Users/demo/" + f.name } };
    fireDrop(nativeFileTransfer(["a.txt", "b.txt"]));
    await wait();
    document.execCommand("insertText", false, "check these");
    return { serialized: handle.getValue(), names: names() };
  },

  async clearRemovesEverything() {
    reset();
    window.gyshell = { system: { getPathForFile: (f) => "/Users/demo/" + f.name } };
    fireDrop(nativeFileTransfer(["a.txt", "b.txt", "c.txt"]));
    await wait();
    handle.clear();
    return { count: tags().length, serialized: handle.getValue() };
  },

  async canonicalPassChatRoundTrip() {
    reset();
    const sessionId = "  Session#opaque::]🙂  ";
    const title = "Canonical # Plan ] 🙂";
    const token = encodePassChatMentionToken(sessionId, title);
    handle.setValue("before " + token + " after");
    await wait();
    const passChatTag = tags().find((tag) => tag.dataset.type === "pass-chat");
    return {
      token,
      serialized: handle.getValue(),
      count: tags().length,
      id: passChatTag?.dataset.id,
      name: passChatTag?.dataset.name,
      text: passChatTag?.textContent,
    };
  },

  async malformedCanonicalPassChatStaysLiteral() {
    reset();
    const malformed = "[MENTION_PASS_CHAT_V2:#broken#]";
    handle.setValue("before " + malformed + " after");
    await wait();
    return {
      serialized: handle.getValue(),
      count: tags().length,
      text: editor().textContent,
    };
  },

  async backspaceStillRemovesLastMention() {
    reset();
    window.gyshell = { system: { getPathForFile: (f) => "/Users/demo/" + f.name } };
    fireDrop(nativeFileTransfer(["a.txt", "b.txt"]));
    await wait();
    // The composer requires two Backspace presses: arm, then delete.
    const press = () => editor().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
    );
    press(); press();
    await wait();
    return { names: names() };
  },
};

window.__ready = true;
</script>
</body></html>`;

fs.writeFileSync(path.join(workDir, "harness.html"), harnessHtml);

const mainJs = `
const { app, BrowserWindow } = require("electron");
const path = require("path");
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const errors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  await win.loadFile(path.join(__dirname, "harness.html"));
  const out = await win.webContents.executeJavaScript(\`(async () => {
    const results = {};
    for (const [name, fn] of Object.entries(window.__cases)) {
      try { results[name] = { ok: true, value: await fn() }; }
      catch (error) { results[name] = { ok: false, error: String(error && error.stack || error) }; }
    }
    return results;
  })()\`);
  console.log("__RESULT__" + JSON.stringify({ results: out, errors }));
  app.exit(0);
});
`;
fs.writeFileSync(path.join(workDir, "main.js"), mainJs);
fs.writeFileSync(
  path.join(workDir, "package.json"),
  JSON.stringify({ name: "richinput-drop-harness", main: "main.js" }),
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
  process.exit(1);
}
const { results, errors } = JSON.parse(marker.trim());

let failures = 0;
const check = (caseName: string, name: string, fn: (value: any) => void) => {
  const entry = results[caseName];
  if (!entry) {
    failures += 1;
    console.error(`FAIL ${name} (case did not run)`);
    return;
  }
  if (!entry.ok) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(entry.error);
    return;
  }
  try {
    fn(entry.value);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
};

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
const assertDeep = (actual: unknown, expected: unknown, message: string) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}\n  expected=${b}\n  actual=${a}`);
};

const scoped = (p: string) => `@terminal(local-main):${p}`;

check("multipleNativeFiles", "dropping several OS files inserts one mention per file", (v) => {
  assertDeep(
    v.names,
    ["a.txt", "b.txt", "c.txt"].map((n) => scoped(`/Users/demo/${n}`)),
    "every dropped file must appear, in drop order",
  );
  for (const n of ["a.txt", "b.txt", "c.txt"]) {
    assert(v.serialized.includes(n), `serialized draft must mention ${n}`);
  }
});

check("manyNativeFiles", "dropping 50 files inserts 50 mentions", (v) => {
  assert(v.count === 50, `expected 50 mentions, got ${v.count}`);
  assert(v.names[0].endsWith("file-0.txt"), "first mention must be the first file");
  assert(v.names[49].endsWith("file-49.txt"), "last mention must be the last file");
});

check("dropOntoExistingText", "dropping onto existing text keeps the text and every file", (v) => {
  assertDeep(
    v.names,
    ["one.md", "two.md"].map((n) => scoped(`/Users/demo/${n}`)),
    "both files must be inserted after the typed text",
  );
  assert(
    v.serialized.startsWith("please review"),
    `typed text must survive the drop, got ${JSON.stringify(v.serialized)}`,
  );
});

check("consecutiveDrops", "a second drop appends instead of replacing the first", (v) => {
  assertDeep(
    v.names,
    ["a.txt", "b.txt", "c.txt", "d.txt"].map((n) => scoped(`/Users/demo/${n}`)),
    "consecutive drops must accumulate",
  );
});

check("panelMultiSelect", "multi-select from the filesystem panel inserts every entry", (v) => {
  assertDeep(
    v.names,
    ["x.log", "y.log", "z.log"].map((n) => `@terminal(ssh-1):/srv/${n}`),
    "each panel entry must become its own mention",
  );
});

check("panelMixedWithDirectories", "panel selections mixing files and directories keep all entries", (v) => {
  assert(v.count === 3, `expected 3 mentions, got ${v.count}`);
  assert(
    v.names.some((n: string) => n.endsWith("/srv/src")),
    "directories must be mentionable too",
  );
});

for (const [caseName, label] of [
  ["malformedAdvertisedPanelPayloadIsSideEffectFree", "malformed advertised panel payload"],
  ["missingPanelSourceIsSideEffectFree", "missing panel source terminal"],
  ["unsupportedPanelSourceIsSideEffectFree", "filesystem-ineligible panel source terminal"],
]) {
  check(caseName, `${label} is rejected before every drop side effect`, (v) => {
    assert(v.counters.customBodyReads === 1, "custom payload body must be read exactly once");
    assert(v.counters.nativeFilesReads === 0, "authoritative custom payload must not read native Files");
    assert(v.counters.nativePathReads === 0, "authoritative custom payload must not resolve native paths");
    assert(v.counters.filesystemReads === 0, "rejected source must not read filesystem content");
    assert(v.count === 0, "rejected source must not insert a mention");
    assert(v.serialized === "", "rejected source must leave the draft unchanged");
  });
}

check("duplicatePathsAreKept", "dropping the same path twice keeps both mentions", (v) => {
  assert(v.count === 2, `expected 2 mentions, got ${v.count}`);
});

check("unresolvablePathsAreSkipped", "files without a resolvable path are skipped", (v) => {
  assert(v.count === 0, `expected no mentions, got ${v.count}`);
});

check("pathsWithSpecialCharacters", "paths with spaces, symbols and non-ASCII survive intact", (v) => {
  assert(v.names.length === 3, `expected 3 mentions, got ${v.names.length}`);
  assert(v.serialized.includes("my file.txt"), "spaces must survive");
  assert(v.serialized.includes("re#port&v2.md"), "symbols must survive");
  assert(v.serialized.includes("\u4e2d\u6587\u6587\u4ef6.txt"), "non-ASCII must survive");
});

check("caretStaysAtEndForTyping", "typing after a multi-file drop appends text without losing mentions", (v) => {
  assert(v.names.length === 2, `expected 2 mentions, got ${v.names.length}`);
  assert(
    v.serialized.includes("check these"),
    `typed text must land after the mentions, got ${JSON.stringify(v.serialized)}`,
  );
});

check("clearRemovesEverything", "clearing the composer removes every dropped mention", (v) => {
  assert(v.count === 0, `expected no mentions, got ${v.count}`);
  assert(v.serialized === "", `expected empty draft, got ${JSON.stringify(v.serialized)}`);
});

check("canonicalPassChatRoundTrip", "RichInput restores and serializes canonical pass-chat identity exactly", (v) => {
  assert(typeof v.token === "string", "canonical token must be generated");
  assert(v.count === 1, `expected one pass-chat tag, got ${v.count}`);
  assert(v.id === "  Session#opaque::]🙂  ", "session identity must remain exact");
  assert(v.name === "Canonical # Plan ] 🙂", "title metadata must remain exact");
  assert(v.serialized === `before ${v.token} after`, "serialized token must round-trip exactly");
  assert(v.text === "@Pass Chat: Canoni...", "visible label must use the truncated title");
});

check("malformedCanonicalPassChatStaysLiteral", "RichInput keeps malformed canonical pass-chat text literal", (v) => {
  const malformed = "[MENTION_PASS_CHAT_V2:#broken#]";
  assert(v.count === 0, "malformed canonical token must not become a badge");
  assert(v.serialized === `before ${malformed} after`, "malformed token must survive serialization");
  assert(v.text === `before ${malformed} after`, "malformed token must remain visible as text");
});

check("backspaceStillRemovesLastMention", "backspace still deletes only the mention next to the caret", (v) => {
  assertDeep(
    v.names,
    [scoped("/Users/demo/a.txt")],
    "backspace must remove just the last mention",
  );
});

fs.rmSync(workDir, { recursive: true, force: true });

if (errors.length > 0) {
  console.error(`Renderer reported ${errors.length} error(s):`);
  errors.forEach((message: string) => console.error(`  ${message}`));
  failures += 1;
}

if (failures > 0) {
  console.error(`${failures} rich input file drop test(s) failed.`);
  process.exit(1);
}
console.log("All rich input file drop extreme tests passed.");
