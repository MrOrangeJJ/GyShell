import assert from "node:assert/strict";
import pkg from "@xterm/headless";
import { createTerminalMarkerRegistry } from "./terminalMarkerRegistry";

const { Terminal } = pkg;

const write = (
  terminal: InstanceType<typeof Terminal>,
  data: string,
): Promise<void> =>
  new Promise((resolve) => terminal.write(data, resolve));

const run = async (): Promise<void> => {
  const terminal = new Terminal({
    cols: 24,
    rows: 6,
    allowProposedApi: true,
  });
  const registry = createTerminalMarkerRegistry(terminal, 64);

  await write(terminal, "prompt$ ");
  const anchor = registry.rememberOffsetAnchor(10);
  assert.ok(anchor, "an output boundary should accept an offset anchor");
  const divider = registry.registerBoundaryFromAnchor("boundary-1", anchor!);
  assert.ok(divider, "an anchor should produce a separately owned divider");
  assert.notEqual(divider, anchor, "divider and anchor must be distinct markers");
  assert.equal(divider!.line, anchor!.line + 1);

  assert.equal(
    registry.registerBoundaryFromAnchor("boundary-1", anchor!),
    divider,
    "reusing a boundary id must not register a duplicate marker",
  );
  divider!.dispose();
  assert.equal(registry.boundaryMarkers.has("boundary-1"), false);
  assert.equal(anchor!.isDisposed, false, "disposing a divider must keep its anchor");
  assert.equal(registry.getOffsetAnchor(10)?.marker, anchor);

  const replacement = registry.registerBoundary("boundary-1");
  assert.ok(replacement, "a disposed boundary id can be reused");
  assert.notEqual(replacement, divider);

  for (let offset = 11; offset <= 75; offset += 1) {
    await write(terminal, `line-${offset}\r\n`);
    registry.rememberOffsetAnchor(offset);
  }
  assert.equal(registry.offsetAnchors.size, 64, "offset anchors stay bounded");
  assert.equal(registry.getOffsetAnchor(10), undefined, "old anchors are evicted");
  assert.equal(
    registry.boundaryMarkers.get("boundary-1")?.isDisposed,
    false,
    "offset-anchor trimming must not dispose an independently owned divider",
  );

  await write(terminal, "\u001b[?1049h");
  assert.equal(registry.registerBoundary("alternate"), undefined);
  assert.equal(registry.rememberOffsetAnchor(100), undefined);
  await write(terminal, "\u001b[?1049l");
  assert.ok(registry.registerBoundary("normal-again"));

  const stableLine = registry.boundaryMarkers.get("boundary-1")!.line;
  terminal.resize(18, 6);
  terminal.resize(24, 6);
  assert.equal(
    registry.boundaryMarkers.get("boundary-1")!.line,
    stableLine,
    "owned dividers must reflow with xterm",
  );

  registry.dispose();
  registry.dispose();
  assert.equal(registry.boundaryMarkers.size, 0);
  assert.equal(registry.offsetAnchors.size, 0);
  terminal.dispose();
  console.log("terminal marker ownership extreme cases: ok");
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
