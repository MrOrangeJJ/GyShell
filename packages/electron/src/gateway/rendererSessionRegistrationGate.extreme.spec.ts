import assert from "node:assert/strict";
import {
  RendererSessionRegistrationGate,
  type RendererSessionRegistrationOperation,
} from "./rendererSessionRegistrationGate";

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

await runCase("queues startup ownership requests and preserves order", async () => {
  const gate = new RendererSessionRegistrationGate<{ id: string }>();
  const calls: string[] = [];
  const first = gate.dispatch({ id: "renderer-1" }, "register", "session-a");
  const second = gate.dispatch(
    { id: "renderer-1" },
    "unregister",
    "session-a",
  );
  let handlerReady = false;
  const handlerReadyPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      handlerReady = true;
      gate.setHandler(async (event, operation, sessionId) => {
        assert.equal(handlerReady, true);
        calls.push(`${event.id}:${operation}:${sessionId}`);
      });
      resolve();
    }, 0);
  });

  await handlerReadyPromise;
  await Promise.all([first, second]);
  assert.deepEqual(calls, [
    "renderer-1:register:session-a",
    "renderer-1:unregister:session-a",
  ]);
});

await runCase("serializes requests arriving after readiness", async () => {
  const gate = new RendererSessionRegistrationGate<{ id: string }>();
  const active: string[] = [];
  let concurrent = 0;
  let maximumConcurrent = 0;
  gate.setHandler(async (_event, operation, sessionId) => {
    concurrent += 1;
    maximumConcurrent = Math.max(maximumConcurrent, concurrent);
    active.push(`${operation}:${sessionId}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
    concurrent -= 1;
  });

  await Promise.all(
    ["a", "b", "c"].map((sessionId) =>
      gate.dispatch({ id: "renderer-2" }, "register", sessionId),
    ),
  );
  assert.equal(maximumConcurrent, 1);
  assert.deepEqual(active, ["register:a", "register:b", "register:c"]);
});

await runCase("does not poison later requests when one operation fails", async () => {
  const gate = new RendererSessionRegistrationGate<{ id: string }>();
  const calls: string[] = [];
  gate.setHandler(async (_event, operation, sessionId) => {
    calls.push(`${operation}:${sessionId}`);
    if (sessionId === "bad") throw new Error("synthetic failure");
  });

  await assert.rejects(
    gate.dispatch({ id: "renderer-3" }, "register", "bad"),
    /synthetic failure/,
  );
  await gate.dispatch({ id: "renderer-3" }, "register", "good");
  assert.deepEqual(calls, ["register:bad", "register:good"]);
});

await runCase("rejects queued requests when startup fails", async () => {
  const gate = new RendererSessionRegistrationGate<{ id: string }>();
  const pending = gate.dispatch({ id: "renderer-4" }, "register", "session-d");
  gate.fail(new Error("startup failed"));
  await assert.rejects(pending, /startup failed/);
  await assert.rejects(
    gate.dispatch({ id: "renderer-4" }, "register", "session-e"),
    /startup failed/,
  );
});

await runCase("preserves opaque session ids and rejects malformed ids", async () => {
  const gate = new RendererSessionRegistrationGate<{ id: string }>();
  const received: Array<{
    operation: RendererSessionRegistrationOperation;
    sessionId: string;
  }> = [];
  gate.setHandler(async (_event, operation, sessionId) => {
    received.push({ operation, sessionId });
  });
  await gate.dispatch({ id: "renderer-5" }, "unregister", "  session::E  ");
  assert.deepEqual(received, [
    { operation: "unregister", sessionId: "  session::E  " },
  ]);
  await assert.rejects(
    gate.dispatch({ id: "renderer-5" }, "register", "  "),
    /Session id is required/,
  );
  await assert.rejects(
    gate.dispatch(
      { id: "renderer-5" },
      "register",
      17 as unknown as string,
    ),
    /Session id is required/,
  );
  await assert.rejects(
    gate.dispatch({ id: "renderer-5" }, "register", "\ud800"),
    /Session id is required/,
  );
});

console.log("All renderer session registration gate extreme tests passed.");
