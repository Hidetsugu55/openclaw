import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "vitest";

it("keeps the app-server transport out of the spawning caller's async context", async () => {
  await promisify(execFile)(
    process.execPath,
    [
      "--expose-gc",
      "--import",
      "tsx",
      fileURLToPath(new URL("./transport-stdio.retention.test-support.ts", import.meta.url)),
    ],
    { timeout: 20_000 },
  );
}, 25_000);
