import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearCodexAppServerBinding,
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
  type CodexAppServerAuthProfileLookup,
} from "./session-binding.js";

let tempDir: string;
let previousStateDir: string | undefined;

const nativeAuthLookup: Pick<CodexAppServerAuthProfileLookup, "authProfileStore"> = {
  authProfileStore: {
    version: 1,
    profiles: {
      work: {
        type: "oauth",
        provider: "openai-codex",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
    },
  },
};

describe("codex app-server session binding", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-binding-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempDir;
  });

  afterEach(async () => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("round-trips the thread binding through SQLite", async () => {
    const sessionFile = path.join(tempDir, "session.json");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-123",
      cwd: tempDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "tools-v1",
    });

    const binding = await readCodexAppServerBinding(sessionFile);

    expect(binding).toMatchObject({
      schemaVersion: 1,
      threadId: "thread-123",
      sessionFile,
      cwd: tempDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "tools-v1",
    });
  });

  it("does not persist public OpenAI as the provider for Codex-native auth bindings", async () => {
    const sessionFile = path.join(tempDir, "session.json");
    await writeCodexAppServerBinding(
      sessionFile,
      {
        threadId: "thread-123",
        cwd: tempDir,
        authProfileId: "work",
        model: "gpt-5.4-mini",
        modelProvider: "openai",
      },
      nativeAuthLookup,
    );

    const binding = await readCodexAppServerBinding(sessionFile, nativeAuthLookup);

    expect(binding).toMatchObject({
      threadId: "thread-123",
      authProfileId: "work",
      model: "gpt-5.4-mini",
    });
    expect(binding?.modelProvider).toBeUndefined();
  });

  it("does not infer native Codex auth from the profile id prefix", async () => {
    const sessionFile = path.join(tempDir, "session.json");
    await writeCodexAppServerBinding(
      sessionFile,
      {
        threadId: "thread-123",
        cwd: tempDir,
        authProfileId: "openai-codex:work",
        model: "gpt-5.4-mini",
        modelProvider: "openai",
      },
      {
        authProfileStore: {
          version: 1,
          profiles: {
            "openai-codex:work": {
              type: "api_key",
              provider: "openai",
              key: "sk-test",
            },
          },
        },
      },
    );

    const binding = await readCodexAppServerBinding(sessionFile, {
      authProfileStore: {
        version: 1,
        profiles: {
          "openai-codex:work": {
            type: "api_key",
            provider: "openai",
            key: "sk-test",
          },
        },
      },
    });

    expect(binding?.modelProvider).toBe("openai");
  });

  it("clears missing bindings without throwing", async () => {
    const sessionFile = path.join(tempDir, "missing.json");
    await clearCodexAppServerBinding(sessionFile);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });
});
