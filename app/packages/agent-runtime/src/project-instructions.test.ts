import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadInstructionChain,
  loadProjectInstructions,
  type ProjectInstructions,
} from "./project-instructions.js";
import { projectInstructionsPrompt } from "./project-instructions-prompt.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("loadProjectInstructions", () => {
  it("loads a non-empty workspace-root AGENTS.md", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    await writeFile(join(root, "AGENTS.md"), "Use pnpm for package commands.\n");

    await expect(loadProjectInstructions(root)).resolves.toEqual({
      entries: [{ source: "AGENTS.md", content: "Use pnpm for package commands." }],
    });
  });

  it("layers root and nested instructions with stable slash-normalized sources", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    await mkdir(join(root, "packages", "api"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Use the root convention.");
    await writeFile(join(root, "packages", "AGENTS.md"), "Use package rules.");
    await writeFile(join(root, "packages", "api", "AGENTS.md"), "Use API rules.");

    await expect(
      loadProjectInstructions(root, "packages/api/handler.ts"),
    ).resolves.toEqual({
      entries: [
        { source: "AGENTS.md", content: "Use the root convention." },
        { source: "packages/AGENTS.md", content: "Use package rules." },
        { source: "packages/api/AGENTS.md", content: "Use API rules." },
      ],
    });
  });

  it("prefers AGENTS.override.md within a directory", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    await writeFile(join(root, "AGENTS.md"), "Use shared rules.");
    await writeFile(join(root, "AGENTS.override.md"), "Use local override.");

    await expect(loadProjectInstructions(root)).resolves.toEqual({
      entries: [
        { source: "AGENTS.override.md", content: "Use local override." },
      ],
    });
  });

  it("uses Claude-compatible files only when no AGENTS file exists", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    await writeFile(join(root, "CLAUDE.md"), "Use Claude-compatible rules.");

    await expect(loadProjectInstructions(root)).resolves.toEqual({
      entries: [
        { source: "CLAUDE.md", content: "Use Claude-compatible rules." },
      ],
    });
  });

  it("prefers AGENTS.md over Claude-compatible files", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    await writeFile(join(root, "AGENTS.md"), "Use AGENTS rules.");
    await writeFile(join(root, "CLAUDE.md"), "Use Claude rules.");

    await expect(loadProjectInstructions(root)).resolves.toEqual({
      entries: [{ source: "AGENTS.md", content: "Use AGENTS rules." }],
    });
  });

  it("caps the complete chain at 32 KiB without splitting UTF-8 characters", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    await writeFile(join(root, "AGENTS.md"), "中".repeat(20_000));

    const loaded = await loadProjectInstructions(root);
    const content = loaded!.entries[0].content;
    const kept = content.split("\n\n[PI-Desktop truncated")[0];
    expect(Buffer.byteLength(kept, "utf8")).toBeLessThanOrEqual(
      32 * 1024,
    );
    expect(kept.endsWith("中")).toBe(true);
    expect(content).toContain("loaded the first 32766 of 60000 bytes");
  });

  it("treats missing, blank, and out-of-workspace files as absent", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    await expect(loadProjectInstructions(root)).resolves.toBeUndefined();

    await writeFile(join(root, "AGENTS.md"), " \n\t ");
    await expect(loadProjectInstructions(root)).resolves.toBeUndefined();
    await expect(loadProjectInstructions(root, "../outside/file.ts")).resolves.toBeUndefined();
  });
});

describe("loadInstructionChain", () => {
  it("loads global instructions before project instructions", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    const globalPath = join(root, "global-AGENTS.md");
    await writeFile(globalPath, "Use global conventions.");
    await writeFile(join(root, "AGENTS.md"), "Use project conventions.");

    await expect(loadInstructionChain(root, undefined, globalPath)).resolves.toEqual({
      entries: [
        { source: "~/.pi/agent/AGENTS.md", content: "Use global conventions." },
        { source: "AGENTS.md", content: "Use project conventions." },
      ],
    });
  });

  it("keeps project instructions when the global file fills its own budget", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    const globalPath = join(root, "global-AGENTS.md");
    await writeFile(globalPath, "a".repeat(32 * 1024));
    await writeFile(join(root, "AGENTS.md"), "Use project conventions.");

    await expect(loadInstructionChain(root, undefined, globalPath)).resolves.toEqual({
      entries: [
        { source: "~/.pi/agent/AGENTS.md", content: "a".repeat(32 * 1024) },
        { source: "AGENTS.md", content: "Use project conventions." },
      ],
    });
  });

  it("labels global truncation and independently retains a full project budget", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    const globalPath = join(root, "global-AGENTS.md");
    await writeFile(globalPath, "g".repeat(40_000));
    await writeFile(join(root, "AGENTS.md"), "p".repeat(32 * 1024));
    const chain = await loadInstructionChain(root, undefined, globalPath);
    expect(chain!.entries).toHaveLength(2);
    expect(chain!.entries[0].content).toContain(
      "[PI-Desktop truncated ~/.pi/agent/AGENTS.md: loaded the first 32768 of 40000 bytes;",
    );
    expect(chain!.entries[1].content).toBe("p".repeat(32 * 1024));
  });

  it("does not load a nested file from the few bytes left after Unicode truncation", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-desktop-instructions-"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "AGENTS.md"), "中".repeat(20_000));
    await writeFile(join(root, "nested", "AGENTS.md"), "x");
    const chain = await loadProjectInstructions(root, "nested/file.ts");
    expect(chain!.entries).toHaveLength(1);
    expect(chain!.entries[0].content).toContain("PI-Desktop truncated AGENTS.md");
  });
});

describe("projectInstructionsPrompt", () => {
  it("labels instruction sources and makes later entries authoritative", () => {
    const instructions: ProjectInstructions = {
      entries: [
        { source: "AGENTS.md", content: "Run unit tests." },
        { source: "packages/api/AGENTS.md", content: "Run API tests." },
      ],
    };

    expect(projectInstructionsPrompt(instructions)).toContain(
      "## AGENTS.md\n\nRun unit tests.",
    );
    expect(projectInstructionsPrompt(instructions)).toContain(
      "## packages/api/AGENTS.md\n\nRun API tests.",
    );
  });
});
