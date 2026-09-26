import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "vitest";

it("does not retain a finished caller's async-local stores in pooled transports", async () => {
  await promisify(execFile)(
    process.execPath,
    [
      "--expose-gc",
      "--import",
      "tsx",
      fileURLToPath(new URL("./fetch-guard.retention.test-support.ts", import.meta.url)),
    ],
    { timeout: 20_000 },
  );
}, 25_000);
