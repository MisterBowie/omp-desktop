/**
 * The packaged sidecar's admission rules.
 *
 * Every case here is a refusal a shipped application depends on: the runtime a
 * packaged build executes is chosen by exactly one path, and anything that does
 * not match this build's pins — or does not match the bytes on disk — must stop
 * the engine rather than run something else (ADR 0307).
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BUNDLED_EXPECTATION,
  BUNDLED_GATE_RELATIVE_PATH,
  BUNDLED_PROVENANCE_SCHEMA,
  bundledBinaryFilename,
  normalizeRepositoryUrl,
  resolveBundledGate,
  sha256File,
  verifyBundledRuntime,
  type BundledExpectation,
  type BundledSidecarProvenance,
} from "./bundled.js";

const created: string[] = [];

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-bundled-"));
  created.push(root);
  return root;
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A resource tree as a build would lay it out, with a tiny stand-in binary. */
function writeFixture(options: {
  platform?: NodeJS.Platform | string;
  arch?: string;
  binary?: string;
  gate?: string | null;
  omitManifest?: boolean;
  patch?: (provenance: BundledSidecarProvenance) => unknown;
  executable?: boolean;
}): { resourcesPath: string; provenance: BundledSidecarProvenance; gatePath: string } {
  const platform = options.platform ?? "linux";
  const arch = options.arch ?? "x64";
  const resourcesPath = scratch();
  const dir = join(resourcesPath, "omp-runtime");
  mkdirSync(dir, { recursive: true });
  const filename = bundledBinaryFilename(platform);
  const binaryPath = join(dir, filename);
  const binary = options.binary ?? "#!/bin/sh\necho omp/18.3.0\n";
  writeFileSync(binaryPath, binary, "utf8");
  if (options.executable !== false) chmodSync(binaryPath, 0o755);

  const gateRelative = BUNDLED_GATE_RELATIVE_PATH.split(sep).join("/");
  const gatePath = join(dir, ...gateRelative.split("/"));
  const gate = options.gate === undefined ? "// fixture gate\nexport const gate = true;\n" : options.gate;
  if (gate !== null) {
    mkdirSync(dirname(gatePath), { recursive: true });
    writeFileSync(gatePath, gate, "utf8");
  }

  const provenance: BundledSidecarProvenance = {
    schema: BUNDLED_PROVENANCE_SCHEMA,
    fork: {
      repository: "https://github.com/MisterBowie/oh-my-pi",
      commit: BUNDLED_EXPECTATION.forkCommit,
      tree: "135ad4b6bc27f58a6220260233e9ff377b14f231",
    },
    upstreamBase: { sha: BUNDLED_EXPECTATION.baseSha, version: BUNDLED_EXPECTATION.ompVersion },
    patchLevel: BUNDLED_EXPECTATION.patchLevel,
    capabilities: ["rpc-host-tool-concurrency"],
    ompVersion: BUNDLED_EXPECTATION.ompVersion,
    desktopVersion: BUNDLED_EXPECTATION.desktopVersion,
    platform: String(platform),
    arch,
    binary: {
      filename,
      bytes: Buffer.byteLength(binary),
      sha256: sha256File(binaryPath),
    },
    extensions: [
      {
        path: gateRelative,
        // A missing gate still declares a plausible entry, so the refusal under
        // test is the missing file and not a schema violation.
        bytes: gate === null ? 1 : Buffer.byteLength(gate),
        sha256: gate === null ? "0".repeat(64) : sha256File(gatePath),
      },
    ],
    build: { tool: "bun", bunVersion: "1.4.2" },
  };
  if (!options.omitManifest) {
    const value = options.patch ? options.patch(structuredClone(provenance)) : provenance;
    writeFileSync(join(dir, "provenance.json"), JSON.stringify(value, null, 2), "utf8");
  }
  return { resourcesPath, provenance, gatePath };
}

function verify(resourcesPath: string, expected: Partial<BundledExpectation> = {}, platform = "linux", arch = "x64") {
  return verifyBundledRuntime({
    resourcesPath,
    platform,
    arch,
    expected: { ...BUNDLED_EXPECTATION, ...expected },
  });
}

function refusal(resourcesPath: string, expected: Partial<BundledExpectation> = {}, platform = "linux", arch = "x64"): string {
  try {
    verify(resourcesPath, expected, platform, arch);
  } catch (error) {
    const typed = error as { code?: string; detail?: string; message?: string };
    expect(typed.code).toBe("bundled-runtime-invalid");
    return String(typed.detail ?? typed.message);
  }
  throw new Error("expected verification to be refused");
}

describe("bundled naming and remote normalization", () => {
  it("names the executable per platform", () => {
    expect(bundledBinaryFilename("linux")).toBe("omp");
    expect(bundledBinaryFilename("darwin")).toBe("omp");
    expect(bundledBinaryFilename("win32")).toBe("omp.exe");
  });

  it("treats the git remote spellings of one repository as equal", () => {
    const expected = normalizeRepositoryUrl("https://github.com/MisterBowie/oh-my-pi");
    expect(expected).toBe("github.com/misterbowie/oh-my-pi");
    expect(normalizeRepositoryUrl("git@github.com:MisterBowie/oh-my-pi.git")).toBe(expected);
    expect(normalizeRepositoryUrl("ssh://git@github.com/MisterBowie/oh-my-pi.git")).toBe(expected);
    expect(normalizeRepositoryUrl("https://github.com/MisterBowie/oh-my-pi.git")).toBe(expected);
    expect(normalizeRepositoryUrl("https://github.com/can1357/oh-my-pi")).not.toBe(expected);
    expect(normalizeRepositoryUrl("not a url")).toBeNull();
  });
});

describe("bundled runtime verification", () => {
  it("accepts a resource tree that matches the manifest", () => {
    const { resourcesPath, provenance, gatePath } = writeFixture({});
    const verified = verify(resourcesPath);
    expect(verified.path).toBe(join(resourcesPath, "omp-runtime", "omp"));
    expect(verified.provenance).toEqual(provenance);
    expect(verified.extensions).toEqual([
      {
        path: BUNDLED_GATE_RELATIVE_PATH.split(sep).join("/"),
        absolutePath: gatePath,
        bytes: provenance.extensions[0].bytes,
        sha256: sha256File(gatePath),
      },
    ]);
  });

  it("keeps the default pins the desktop ships", () => {
    expect(BUNDLED_EXPECTATION.ompVersion).toBe("18.3.0");
    expect(BUNDLED_EXPECTATION.patchLevel).toBe("62bc57b+omp-desktop.2");
    expect(BUNDLED_EXPECTATION.forkCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("accepts a Windows layout with its own file name", () => {
    const { resourcesPath } = writeFixture({ platform: "win32", arch: "x64" });
    expect(verify(resourcesPath, {}, "win32", "x64").path).toBe(
      join(resourcesPath, "omp-runtime", "omp.exe"),
    );
  });

  it("refuses a missing sidecar or manifest", () => {
    expect(refusal(scratch())).toMatch(/missing omp-runtime/);
    const { resourcesPath } = writeFixture({ omitManifest: true });
    expect(refusal(resourcesPath)).toMatch(/missing provenance.json/);
  });

  it("refuses a non-executable or missing binary", () => {
    const notExecutable = writeFixture({ executable: false });
    expect(refusal(notExecutable.resourcesPath)).toMatch(/not executable/);

    const root = scratch();
    mkdirSync(join(root, "omp-runtime"), { recursive: true });
    writeFileSync(join(root, "omp-runtime", "provenance.json"), "{}", "utf8");
    expect(refusal(root)).toMatch(/missing the bundled omp/);
  });

  it("refuses a tampered manifest field by field", () => {
    expect(refusal(writeFixture({ patch: () => "not an object" }).resourcesPath)).toMatch(/does not match/);
    expect(refusal(writeFixture({ patch: (p) => ({ ...p, schema: "other/1" }) }).resourcesPath)).toMatch(
      /schema is other\/1/,
    );
    expect(refusal(writeFixture({ patch: (p) => ({ ...p, platform: "darwin" }) }).resourcesPath)).toMatch(
      /platform is darwin/,
    );
    expect(refusal(writeFixture({ patch: (p) => ({ ...p, arch: "arm64" }) }).resourcesPath)).toMatch(
      /arch is arm64/,
    );
    expect(refusal(writeFixture({ patch: (p) => ({ ...p, ompVersion: "18.2.7" }) }).resourcesPath)).toMatch(
      /OMP version is 18.2.7/,
    );
    expect(refusal(writeFixture({ patch: (p) => ({ ...p, patchLevel: "d49918f+omp-desktop.1" }) }).resourcesPath)).toMatch(
      /patch level is d49918f\+omp-desktop\.1/,
    );
    expect(
      refusal(
        writeFixture({ patch: (p) => ({ ...p, fork: { ...p.fork, commit: "0".repeat(40) } }) }).resourcesPath,
      ),
    ).toMatch(/fork commit is 0000000000000000000000000000000000000000/);
    expect(
      refusal(
        writeFixture({ patch: (p) => ({ ...p, fork: { ...p.fork, repository: "https://github.com/can1357/oh-my-pi" } }) })
          .resourcesPath,
      ),
    ).toMatch(/fork repository/);
    expect(
      refusal(
        writeFixture({ patch: (p) => ({ ...p, upstreamBase: { ...p.upstreamBase, sha: "0".repeat(40) } }) }).resourcesPath,
      ),
    ).toMatch(/upstream base/);
    expect(
      refusal(writeFixture({ patch: (p) => ({ ...p, binary: { ...p.binary, filename: "omp.exe" } }) }).resourcesPath),
    ).toMatch(/binary name is omp\.exe/);
  });

  it("refuses a binary that does not match the declared bytes or digest", () => {
    const bytesMismatch = writeFixture({ patch: (p) => ({ ...p, binary: { ...p.binary, bytes: p.binary.bytes + 1 } }) });
    expect(refusal(bytesMismatch.resourcesPath)).toMatch(/binary is/);

    const digestMismatch = writeFixture({
      patch: (p) => ({ ...p, binary: { ...p.binary, sha256: "a".repeat(64) } }),
    });
    expect(refusal(digestMismatch.resourcesPath)).toMatch(/SHA-256 does not match/);
  });

  it("refuses a tampered binary even when the manifest is untouched", () => {
    const { resourcesPath, provenance } = writeFixture({});
    chmodSync(join(resourcesPath, "omp-runtime", "omp"), 0o755);
    writeFileSync(join(resourcesPath, "omp-runtime", "omp"), "#!/bin/sh\nexit 1\n", "utf8");
    chmodSync(join(resourcesPath, "omp-runtime", "omp"), 0o755);
    expect(provenance.binary.sha256).not.toBe(sha256File(join(resourcesPath, "omp-runtime", "omp")));
    expect(refusal(resourcesPath)).toMatch(/binary is|SHA-256/);
  });

  it("refuses malformed JSON and symlinked resources", () => {
    const { resourcesPath } = writeFixture({});
    writeFileSync(join(resourcesPath, "omp-runtime", "provenance.json"), "{", "utf8");
    expect(refusal(resourcesPath)).toMatch(/not valid JSON/);

    const root = scratch();
    const outside = scratch();
    mkdirSync(join(outside, "omp-runtime"), { recursive: true });
    symlinkSync(join(outside, "omp-runtime"), join(root, "omp-runtime"));
    expect(refusal(root)).toMatch(/must not be a symlink/);
  });
});

describe("tool gate and pin verification", () => {
  it("returns the verified gate through the shared resolver", () => {
    const { resourcesPath, gatePath } = writeFixture({});
    expect(resolveBundledGate({ resourcesPath })?.path).toBe(gatePath);
  });

  it("returns null from the gate resolver when the resource does not verify", () => {
    const { resourcesPath } = writeFixture({
      patch: (p) => ({ ...p, binary: { ...p.binary, sha256: "a".repeat(64) } }),
    });
    expect(resolveBundledGate({ resourcesPath })).toBeNull();
  });

  it("refuses a gate whose content changed, even when the length did not", () => {
    const { resourcesPath, gatePath } = writeFixture({});
    const swapped = Buffer.from(readFileSync(gatePath));
    swapped[0] = swapped[0] ^ 0xff;
    writeFileSync(gatePath, swapped);
    expect(refusal(resourcesPath)).toMatch(/extension .* does not match the provenance manifest/);
  });

  it("refuses a missing, symlinked, undeclared or escaping gate", () => {
    expect(refusal(writeFixture({ gate: null }).resourcesPath)).toMatch(/missing extension/);

    const linked = writeFixture({});
    const outside = join(scratch(), "gate.ts");
    writeFileSync(outside, "// outside\n");
    rmSync(linked.gatePath);
    symlinkSync(outside, linked.gatePath);
    expect(refusal(linked.resourcesPath)).toMatch(/must not be a symlink/);

    const escaping = writeFixture({
      patch: (p) => ({ ...p, extensions: [{ ...p.extensions[0], path: "../outside.ts" }] }),
    });
    expect(refusal(escaping.resourcesPath)).toMatch(/not inside the runtime directory/);

    const undeclared = writeFixture({
      patch: (p) => ({ ...p, extensions: [{ ...p.extensions[0], path: "extensions/other.ts" }] }),
    });
    expect(refusal(undeclared.resourcesPath)).toMatch(/missing extension|does not declare/);
  });

  it("refuses a manifest that declares no extensions at all", () => {
    const { resourcesPath } = writeFixture({ patch: (p) => ({ ...p, extensions: [] }) });
    expect(refusal(resourcesPath)).toMatch(/does not match/);
  });

  it("pins the desktop release the artifact was built for", () => {
    const { resourcesPath } = writeFixture({ patch: (p) => ({ ...p, desktopVersion: "0.0.1" }) });
    expect(refusal(resourcesPath)).toMatch(/desktop version is 0\.0\.1/);
  });

  it("does not claim to verify the informational provenance fields", () => {
    // fork.tree, capabilities and build.* cannot be re-derived by a packaged
    // application; they are audit records, so changing them must not change
    // acceptance. This test is the executable form of that ADR statement.
    const { resourcesPath } = writeFixture({
      patch: (p) => ({
        ...p,
        fork: { ...p.fork, tree: "0".repeat(40) },
        capabilities: ["something-else"],
        build: { tool: "other", bunVersion: "0.0.0" },
      }),
    });
    expect(() => verify(resourcesPath)).not.toThrow();
  });
});
