/**
 * Browser-backed stress test for very large seamless tool groups.
 *
 * The component depends on real layout, scrolling, ResizeObserver, and React
 * rendering behavior, so this test runs in Electron Chromium instead of a DOM
 * shim. It intentionally mounts the production component and stylesheet.
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
  console.log("SKIP seamless virtualization tests (electron binary unavailable)");
  process.exit(0);
}

const workDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "gyshell-seamless-virtualization-"),
);
const bundlePath = path.join(workDir, "seamless.js");
const entryPath = path.join(
  here,
  `__seamlessVirtualizationEntry.${process.pid}.tsx`,
);

fs.writeFileSync(
  entryPath,
  [
    `import * as React from "react";`,
    `import { createRoot } from "react-dom/client";`,
    `import { SeamlessToolGroupBanner } from "./ChatBanner";`,
    `import "./chatBanner.scss";`,
    `(globalThis as any).SeamlessHarness = { React, createRoot, SeamlessToolGroupBanner };`,
  ].join("\n"),
);

const bundle = spawnSync(
  esbuildBin,
  [
    entryPath,
    "--bundle",
    "--format=iife",
    `--outfile=${bundlePath}`,
    "--loader:.css=css",
    "--loader:.scss=css",
    "--loader:.svg=text",
    "--loader:.png=dataurl",
    '--define:process.env.NODE_ENV="production"',
    "--jsx=automatic",
  ],
  { cwd: repoRoot, encoding: "utf8" },
);
fs.rmSync(entryPath, { force: true });
if (bundle.status !== 0) {
  console.error("FAIL could not bundle SeamlessToolGroupBanner");
  console.error(bundle.stderr || bundle.stdout);
  fs.rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

const harnessHtml = String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <link rel="stylesheet" href="./seamless.css" />
  <style>
    html, body { margin: 0; height: 100%; }
    body { color: #4a4543; background: #f7f7f7; font-family: monospace; }
    .panel-body { width: 720px; height: 600px; overflow: auto; }
    #root { min-height: 100%; }
  </style>
</head>
<body>
  <div class="panel-body"><div id="root"></div></div>
  <script src="./seamless.js"></script>
  <script>
    const { React, createRoot, SeamlessToolGroupBanner } = SeamlessHarness;
    const longTasks = [];
    if (typeof PerformanceObserver !== "undefined") {
      try {
        const observer = new PerformanceObserver((list) => {
          longTasks.push(...list.getEntries().map((entry) => entry.duration));
        });
        observer.observe({ entryTypes: ["longtask"] });
      } catch {}
    }

    const messages = Array.from({ length: 10000 }, (_, index) => ({
      id: "tool-" + index,
      role: "assistant",
      type: "tool_call",
      content: JSON.stringify({ index, path: "/tmp/item-" + index }),
      timestamp: index + 1,
      streaming: false,
      payloadState: "geometry",
      deferredPayload: { fields: ["content", "output"] },
      metadata: {
        toolName: "read",
        output: "result-preview-" + index,
      },
    }));
    const fullPayloadRequests = [];

    const startedAt = performance.now();
    createRoot(document.getElementById("root")).render(
      React.createElement(SeamlessToolGroupBanner, {
        messages,
        expanded: true,
        onRequestFullMessages: async (messageIds) => {
          fullPayloadRequests.push([...messageIds]);
        },
      }),
    );

    const waitFrames = async (count = 3) => {
      for (let index = 0; index < count; index += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    };

    window.__runStress = async () => {
      await waitFrames(6);
      const panel = document.querySelector(".panel-body");
      const initial = {
        elapsedMs: performance.now() - startedAt,
        stepRows: document.querySelectorAll(".stg-step").length,
        nodes: document.querySelectorAll("*").length,
        scrollHeight: panel.scrollHeight,
        clientHeight: panel.clientHeight,
        firstVisibleText: document.querySelector(".stg-step-text")?.textContent || "",
        fullPayloadRequests: fullPayloadRequests.map((ids) => [...ids]),
      };

      panel.scrollTop = panel.scrollHeight;
      panel.dispatchEvent(new Event("scroll"));
      await waitFrames(6);
      const bottomRows = Array.from(document.querySelectorAll(".stg-step-text"))
        .map((node) => node.textContent || "");
      const bottom = {
        stepRows: document.querySelectorAll(".stg-step").length,
        nodes: document.querySelectorAll("*").length,
        lastVisibleText: bottomRows[bottomRows.length - 1] || "",
        containsLast: bottomRows.some((text) => text.includes("9999")),
        fullPayloadRequests: fullPayloadRequests.map((ids) => [...ids]),
      };

      const lastButton = Array.from(document.querySelectorAll(".stg-step-toggle"))
        .find((node) => (node.textContent || "").includes("9999"));
      lastButton?.click();
      await waitFrames(4);
      const expanded = {
        detailRows: document.querySelectorAll(".stg-step-details").length,
        stepRows: document.querySelectorAll(".stg-step").length,
        nodes: document.querySelectorAll("*").length,
        fullPayloadRequests: fullPayloadRequests.map((ids) => [...ids]),
      };

      panel.scrollTop = 0;
      panel.dispatchEvent(new Event("scroll"));
      await waitFrames(6);
      const topRows = Array.from(document.querySelectorAll(".stg-step-text"))
        .map((node) => node.textContent || "");
      return {
        initial,
        bottom,
        expanded,
        top: {
          stepRows: document.querySelectorAll(".stg-step").length,
          nodes: document.querySelectorAll("*").length,
          containsFirst: topRows.some((text) => text.includes("index: 0")),
        },
        longTasks,
      };
    };
    window.__ready = true;
  </script>
</body>
</html>`;
fs.writeFileSync(path.join(workDir, "harness.html"), harnessHtml);

const mainJs = String.raw`
const { app, BrowserWindow } = require("electron");
const path = require("path");
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 760,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const errors = [];
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) errors.push(message);
  });
  await win.loadFile(path.join(__dirname, "harness.html"));
  const result = await win.webContents.executeJavaScript(
    "window.__runStress()",
  );
  console.log("__RESULT__" + JSON.stringify({ result, errors }));
  app.exit(0);
});
`;
fs.writeFileSync(path.join(workDir, "main.js"), mainJs);
fs.writeFileSync(
  path.join(workDir, "package.json"),
  JSON.stringify({ name: "seamless-virtualization-harness", main: "main.js" }),
);

const run = spawnSync(electronBin, [workDir], {
  cwd: repoRoot,
  encoding: "utf8",
  timeout: 120_000,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
});
const marker = (run.stdout || "").split("__RESULT__")[1];
if (!marker) {
  console.error("FAIL seamless virtualization harness produced no result");
  console.error(run.stdout);
  console.error(run.stderr);
  fs.rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

const { result, errors } = JSON.parse(marker.trim());
const failures: string[] = [];
const check = (condition: unknown, message: string): void => {
  if (!condition) failures.push(message);
};

check(
  result.initial.stepRows <= 100,
  `initial expanded DOM must stay bounded, got ${result.initial.stepRows} step rows`,
);
check(
  result.bottom.stepRows <= 100,
  `bottom DOM must stay bounded, got ${result.bottom.stepRows} step rows`,
);
check(
  result.expanded.stepRows <= 100,
  `expanded detail DOM must stay bounded, got ${result.expanded.stepRows} step rows`,
);
check(
  result.top.stepRows <= 100,
  `top DOM must stay bounded after reverse scrolling, got ${result.top.stepRows} rows`,
);
check(
  result.initial.nodes <= 1_500 && result.bottom.nodes <= 1_500,
  `10,000 steps must not create an unbounded document (${result.initial.nodes}/${result.bottom.nodes} nodes)`,
);
check(
  result.initial.scrollHeight > 150_000,
  `virtual layout must preserve the full scroll range, got ${result.initial.scrollHeight}px`,
);
check(result.bottom.containsLast, "scrolling to the bottom must render step 9,999");
check(result.top.containsFirst, "scrolling back to the top must render step 0");
check(
  result.initial.fullPayloadRequests.length === 0 &&
    result.bottom.fullPayloadRequests.length === 0,
  "geometry-only group expansion and scrolling must not fan out full-payload requests",
);
check(
  result.expanded.fullPayloadRequests.length === 1 &&
    result.expanded.fullPayloadRequests[0]?.length === 1 &&
    result.expanded.fullPayloadRequests[0]?.[0] === "tool-9999",
  `expanding one geometry step must request only tool-9999, got ${JSON.stringify(result.expanded.fullPayloadRequests)}`,
);
check(
  result.expanded.detailRows === 1,
  `an on-screen step must retain its original expand interaction, got ${result.expanded.detailRows} details`,
);
const worstLongTask = Math.max(0, ...result.longTasks);
check(
  worstLongTask < 250,
  `the 10,000-step interaction produced a ${worstLongTask.toFixed(1)}ms long task`,
);
check(errors.length === 0, `renderer reported errors: ${errors.join(" | ")}`);

fs.rmSync(workDir, { recursive: true, force: true });
if (failures.length > 0) {
  failures.forEach((failure) => console.error(`FAIL ${failure}`));
  process.exit(1);
}

console.log(
  `PASS 10,000 seamless steps stay bounded (rows=${result.initial.stepRows}/${result.bottom.stepRows}, nodes=${result.initial.nodes}/${result.bottom.nodes}, worstLongTask=${worstLongTask.toFixed(1)}ms)`,
);
console.log("All seamless virtualization extreme tests passed.");
