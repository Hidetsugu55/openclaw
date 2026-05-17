import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../terminal/note.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { collectSourceInstallIssues, noteSourceInstallIssues } from "./doctor-install.js";

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

async function writeFile(root: string, relativePath: string, content = "") {
  const file = path.join(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

describe("noteSourceInstallIssues", () => {
  beforeEach(() => {
    vi.mocked(note).mockReset();
  });

  it("does not treat a packaged workspace config as a source checkout", async () => {
    await withTempDir({ prefix: "openclaw-doctor-install-" }, async (root) => {
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
      await writeFile(root, "pnpm-workspace.yaml", "packages:\n  - .\n");

      noteSourceInstallIssues(root);

      expect(note).not.toHaveBeenCalled();
    });
  });

  it("warns source checkouts when node_modules was not installed by pnpm", async () => {
    await withTempDir({ prefix: "openclaw-doctor-install-" }, async (root) => {
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
      await writeFile(root, "pnpm-workspace.yaml", "packages:\n  - .\n");
      await writeFile(root, "src/entry.ts", "export {};\n");

      noteSourceInstallIssues(root);

      expect(note).toHaveBeenCalledWith(
        [
          "- node_modules was not installed by pnpm (missing node_modules/.pnpm). Run: pnpm install so bundled plugins can load package-local dependencies.",
          "- tsx binary is missing for source runs. Run: pnpm install.",
        ].join("\n"),
        "Install",
      );
    });
  });
});

describe("collectSourceInstallIssues", () => {
  it("returns an empty list when root is null", () => {
    expect(collectSourceInstallIssues(null)).toEqual([]);
  });

  it("returns an empty list for packaged workspaces without a source checkout", async () => {
    await withTempDir({ prefix: "openclaw-collect-install-" }, async (root) => {
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
      await writeFile(root, "pnpm-workspace.yaml", "packages:\n  - .\n");

      expect(collectSourceInstallIssues(root)).toEqual([]);
    });
  });

  it("returns warning strings for source checkouts missing pnpm install artifacts", async () => {
    await withTempDir({ prefix: "openclaw-collect-install-" }, async (root) => {
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
      await writeFile(root, "pnpm-workspace.yaml", "packages:\n  - .\n");
      await writeFile(root, "src/entry.ts", "export {};\n");

      const issues = collectSourceInstallIssues(root);
      expect(issues).toContain(
        "- node_modules was not installed by pnpm (missing node_modules/.pnpm). Run: pnpm install so bundled plugins can load package-local dependencies.",
      );
      expect(issues).toContain("- tsx binary is missing for source runs. Run: pnpm install.");
    });
  });
});
