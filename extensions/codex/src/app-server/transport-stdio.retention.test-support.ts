import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { createStdioTransport } from "./transport-stdio.js";

// The app-server process and its pipes outlive the agent run that first needs them.
// Their callbacks must neither observe nor pin that run's async-local stores.
const callerStorage = new AsyncLocalStorage<{ payload: ArrayBuffer }>();

async function collectGarbage(): Promise<void> {
  for (let index = 0; index < 6; index++) {
    await setImmediate();
    global.gc!();
  }
}

const spawnEcho = () =>
  createStdioTransport({
    transport: "stdio",
    command: process.execPath,
    args: ["-e", "process.stdin.pipe(process.stdout)"],
    headers: {},
  });

// Initialize the process registry and its shared sqlite owners outside any run, as
// Gateway startup does. Their own module-level contexts and idle timers are created
// on first use and would otherwise pin the measured run for unrelated reasons.
// This does not exercise the module-load caveat of transport-stdio itself: the
// static import above always evaluates it before this script runs.
const warmup = await spawnEcho();
const warmupExit = new Promise<void>((resolve) => {
  warmup.once("exit", () => resolve());
});
warmup.kill();
await warmupExit;

let reference!: WeakRef<ArrayBuffer>;
const child = await (async () => {
  const payload = new ArrayBuffer(8 * 1024 * 1024);
  reference = new WeakRef(payload);
  return await callerStorage.run({ payload }, spawnEcho);
})();

try {
  const observed = new Promise<unknown>((resolve) => {
    child.stdout.once("data", () => resolve(callerStorage.getStore()));
  });
  child.stdin.write("ping\n");
  assert.equal(await observed, undefined, "app-server output ran in the spawning caller's context");

  await collectGarbage();
  assert.equal(child.exitCode, null, "app-server must still be running");
  assert.equal(
    reference.deref(),
    undefined,
    "app-server transport retained the spawning caller's async-local store",
  );
} finally {
  child.kill();
}
