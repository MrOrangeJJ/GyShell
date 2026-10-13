import assert from "node:assert/strict";
import {
  resolveBlockRevealScrollTop,
  resolveTerminalRevealContextRows,
  resolveTerminalRevealTop,
} from "./terminalReveal";
import { commandFromPromptLine } from "./block/terminalBlockModel";

// Terminal landing: the command row sits below 1-3 rows of context.
assert.equal(resolveTerminalRevealContextRows(1), 0);
assert.equal(resolveTerminalRevealContextRows(5), 1);
assert.equal(resolveTerminalRevealContextRows(30), 2);
assert.equal(resolveTerminalRevealContextRows(60), 3);
assert.equal(resolveTerminalRevealTop({ commandLine: 17, viewportRows: 30, maxTop: 76 }), 15);
// Top of scrollback and bottom of buffer clamp instead of overshooting.
assert.equal(resolveTerminalRevealTop({ commandLine: 1, viewportRows: 30, maxTop: 76 }), 0);
assert.equal(resolveTerminalRevealTop({ commandLine: 100, viewportRows: 30, maxTop: 76 }), 76);
assert.equal(resolveTerminalRevealTop({ commandLine: 5, viewportRows: 30, maxTop: 0 }), 0);
for (let rows = 1; rows <= 120; rows += 1) {
  for (const commandLine of [0, 3, 40, 500]) {
    const top = resolveTerminalRevealTop({ commandLine, viewportRows: rows, maxTop: 400 });
    assert.ok(top >= 0 && top <= 400);
    // The command row is always on screen, never in the top context rows'
    // place when there is room above it.
    const maxReachable = Math.min(commandLine, 400 + rows - 1);
    if (commandLine <= 400) {
      assert.ok(commandLine >= top && commandLine < top + rows, `rows=${rows} line=${commandLine}`);
      if (commandLine >= 3 && rows >= 2) assert.ok(commandLine - top >= 1, "keeps context above");
    } else {
      assert.ok(maxReachable >= top);
    }
  }
}

// Block landing: a small gap above the target block's header.
assert.equal(
  resolveBlockRevealScrollTop({ blockTop: 600, viewportHeight: 800, maxScrollTop: 2000, rowHeight: 22 }),
  567,
);
assert.equal(
  resolveBlockRevealScrollTop({ blockTop: 10, viewportHeight: 800, maxScrollTop: 2000, rowHeight: 22 }),
  0,
);
assert.equal(
  resolveBlockRevealScrollTop({ blockTop: 3000, viewportHeight: 800, maxScrollTop: 2000, rowHeight: 22 }),
  2000,
);
// A short viewport limits the gap so the block still lands near the top.
assert.equal(
  resolveBlockRevealScrollTop({ blockTop: 600, viewportHeight: 100, maxScrollTop: 2000, rowHeight: 22 }),
  585,
);

// Prompt stripping for user-typed commands (no recorded command text).
assert.equal(commandFromPromptLine("MacBook-Pro-5:~ tonyhuang$ seq 1 40"), "seq 1 40");
assert.equal(commandFromPromptLine("[root@host ~]# ls -la"), "ls -la");
assert.equal(commandFromPromptLine("me@host ~ % git status"), "git status");
assert.equal(commandFromPromptLine("PS C:\\Users\\me> dir"), "dir");
assert.equal(commandFromPromptLine("~/src \u276f npm test"), "npm test");
// The first prompt delimiter wins; ">" inside the command is kept.
assert.equal(commandFromPromptLine('host$ echo "a > b" > out.txt'), 'echo "a > b" > out.txt');
// Negative controls: no prompt, empty prompt, or not a prompt line.
assert.equal(commandFromPromptLine("plain output line"), undefined);
assert.equal(commandFromPromptLine("host:~ me$ "), undefined);
assert.equal(commandFromPromptLine(""), undefined);
assert.equal(commandFromPromptLine(undefined), undefined);
assert.equal(commandFromPromptLine("price$5"), undefined);
assert.equal(commandFromPromptLine(`host$ ${"x".repeat(301)}`), undefined);

console.log("PASS terminal reveal: landing rows, block scroll anchor, prompt stripping");
