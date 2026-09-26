import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Socket } from "node:net";
import { setImmediate } from "node:timers/promises";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import { fetchWithSsrFGuard } from "./fetch-guard.js";
import { PinnedDispatcherPool } from "./pinned-dispatcher-pool.js";

// A pooled keep-alive socket and undici's shared timers outlive the request that
// created them. They must not pin the caller's async-local stores (a finished agent
// run, its plugin generation and transcript state) for the rest of the process.
const callerStorage = new AsyncLocalStorage<{ payload: ArrayBuffer }>();
const pool = new PinnedDispatcherPool({ maxEntries: 1, idleTtlMs: 60_000 });
const serverSockets: Socket[] = [];

async function collectGarbage(): Promise<void> {
  for (let index = 0; index < 6; index++) {
    await setImmediate();
    global.gc!();
  }
}

try {
  await withServer(
    (request, response) => {
      serverSockets.push(request.socket);
      response.setHeader("connection", "keep-alive");
      response.end("ok");
    },
    async (baseUrl) => {
      const fetchOk = async () => {
        const result = await fetchWithSsrFGuard({
          url: `${baseUrl}/ok`,
          timeoutMs: 5_000,
          policy: { allowPrivateNetwork: true, hostnameAllowlist: ["127.0.0.1"] },
          dispatcherPool: pool,
        });
        try {
          assert.equal(await result.response.text(), "ok");
          return result.dispatcherReused;
        } finally {
          await result.release();
        }
      };

      let reference!: WeakRef<ArrayBuffer>;
      await (async () => {
        const payload = new ArrayBuffer(8 * 1024 * 1024);
        reference = new WeakRef(payload);
        await callerStorage.run({ payload }, fetchOk);
      })();

      await collectGarbage();
      assert.equal(
        reference.deref(),
        undefined,
        "pooled transport retained the finished caller's async-local store",
      );

      // The assertion above is only meaningful while the pooled transport is alive.
      assert.equal(await fetchOk(), true, "pooled dispatcher must be reused");
      assert.equal(serverSockets.length, 2);
      assert.equal(serverSockets[1], serverSockets[0], "keep-alive socket must be reused");
    },
  );
} finally {
  await pool.closeAll();
}
