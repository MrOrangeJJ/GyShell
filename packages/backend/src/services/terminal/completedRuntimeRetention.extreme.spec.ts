import assert from "node:assert/strict";
import {
  deleteCompletedRuntime,
  scheduleCompletedRuntimeEviction,
} from "./completedRuntimeRetention";

interface TestRuntime {
  completedRuntimeEvictionTimer?: ReturnType<typeof setTimeout>;
  label: string;
}

const runCase = async (
  name: string,
  fn: () => Promise<void>,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const run = async (): Promise<void> => {
  await runCase("eviction removes a completed runtime after its TTL", async () => {
    const runtimes = new Map<string, TestRuntime>();
    const runtime: TestRuntime = { label: "expired" };
    runtimes.set("runtime", runtime);
    scheduleCompletedRuntimeEviction(runtimes, "runtime", runtime, 10);

    await wait(30);
    assert.equal(runtimes.has("runtime"), false);
  });

  await runCase(
    "an old runtime timer cannot evict a replacement runtime",
    async () => {
      const runtimes = new Map<string, TestRuntime>();
      const oldRuntime: TestRuntime = { label: "old" };
      const newRuntime: TestRuntime = { label: "new" };
      runtimes.set("runtime", oldRuntime);
      scheduleCompletedRuntimeEviction(runtimes, "runtime", oldRuntime, 10);

      await wait(2);
      runtimes.set("runtime", newRuntime);
      scheduleCompletedRuntimeEviction(runtimes, "runtime", newRuntime, 50);

      await wait(20);
      assert.equal(runtimes.get("runtime"), newRuntime);
      await wait(45);
      assert.equal(runtimes.has("runtime"), false);
    },
  );

  await runCase("explicit deletion clears a pending eviction", async () => {
    const runtimes = new Map<string, TestRuntime>();
    const runtime: TestRuntime = { label: "deleted" };
    runtimes.set("runtime", runtime);
    scheduleCompletedRuntimeEviction(runtimes, "runtime", runtime, 10);
    assert.equal(deleteCompletedRuntime(runtimes, "runtime"), true);

    await wait(30);
    assert.equal(runtimes.has("runtime"), false);
    assert.equal(runtime.completedRuntimeEvictionTimer, undefined);
  });
};

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
