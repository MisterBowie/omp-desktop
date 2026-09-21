import { writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pack, type PackResult } from "./pack.js";

const run = promisify(execFile);

/**
 * Canonical source coordinate the plugin center accepts.
 *
 * `ref` is what the publisher pinned (`refs/tags/<tag>` or a commit), and
 * `commit` is what it resolved to locally. The center re-resolves both from
 * the forge rather than trusting these values; they are here so a submission
 * says what the publisher believed they were shipping.
 */
export type SubmissionSource = {
  repository: string;
  ref: string;
  commit: string;
  path: string;
};

export type SubmissionPayload = {
  schemaVersion: 1;
  pluginId: string;
  version: string;
  channel: "stable" | "beta";
  source: SubmissionSource;
  artifact: {
    mode: "publisher-release";
    fileName: string;
    sha256: string;
    sizeBytes: number;
  };
  permissions: string[];
  /** Stable per (plugin, version, commit, artifact) so a retry is not a new release. */
  idempotencyKey: string;
};

export type PublishResult = {
  payload: SubmissionPayload;
  payloadPath: string;
  pack: PackResult;
  warnings: string[];
};

export type PublishOptions = {
  outDir?: string;
  /** Override the detected ref, e.g. when tagging happens in CI. */
  ref?: string;
  channel?: "stable" | "beta";
  /** Skip the clean-worktree requirement. Produces an unpinnable submission. */
  allowDirty?: boolean;
};

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", dir, ...args]);
  return stdout.trim();
}

/**
 * Normalize a git remote to the canonical HTTPS URL the center stores.
 *
 * SSH remotes (`git@github.com:owner/repo.git`) are the common local form and
 * are not a URL the center can record, so they are rewritten rather than
 * rejected. Anything with credentials is refused: a submission is public data.
 */
export function canonicalRepositoryUrl(remote: string): string {
  const trimmed = remote.trim().replace(/\.git$/, "");
  const ssh = trimmed.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`unsupported git remote, expected an https or ssh URL: ${remote}`);
  }
  const url = new URL(trimmed);
  if (url.username || url.password) {
    throw new Error("git remote must not embed credentials");
  }
  if (url.protocol !== "https:") {
    throw new Error(`git remote must use https, got ${url.protocol}`);
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

/**
 * Prepare a plugin version for submission to the plugin center.
 *
 * Packing and pinning happen together on purpose: the artifact the publisher
 * uploads and the commit they claim it came from have to describe one moment,
 * or the center's rebuild has nothing to compare against.
 */
export async function publish(
  dirInput: string,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const dir = resolve(dirInput);
  const warnings: string[] = [];

  const packed = await pack(dir, { outDir: options.outDir });
  const manifest = packed.check.manifest;
  if (!manifest) throw new Error("plugin manifest is missing after packing");

  let repository: string;
  let commit: string;
  let status: string;
  try {
    repository = canonicalRepositoryUrl(await git(dir, ["remote", "get-url", "origin"]));
    commit = await git(dir, ["rev-parse", "HEAD"]);
    status = await git(dir, ["status", "--porcelain"]);
  } catch (error) {
    throw new Error(
      `publish needs a git repository with an origin remote: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (status && !options.allowDirty) {
    throw new Error(
      "working tree has uncommitted changes; commit them so the submitted commit describes the package",
    );
  }
  if (status) warnings.push("submitted from a dirty working tree; the pin will not reproduce");

  // A tag is what a publisher can point a reader at; a bare commit works but
  // gives the center nothing human-readable to show next to the version.
  let ref = options.ref ?? "";
  if (!ref) {
    const tag = await git(dir, ["tag", "--points-at", "HEAD"]).catch(() => "");
    const first = tag.split("\n").map((t) => t.trim()).filter(Boolean)[0];
    ref = first ? `refs/tags/${first}` : commit;
  }
  if (ref === commit) {
    warnings.push(`no tag points at ${commit.slice(0, 12)}; submitting the bare commit`);
  }

  // The repository root is the pin; the plugin may live in a subdirectory of it.
  const topLevel = await git(dir, ["rev-parse", "--show-toplevel"]);
  const relative = resolve(dir).slice(resolve(topLevel).length).replace(/^[/\\]/, "");
  const sourcePath = relative === "" ? "." : relative.split(/[/\\]/).join("/");

  const payload: SubmissionPayload = {
    schemaVersion: 1,
    pluginId: manifest.id,
    version: manifest.version,
    channel: options.channel ?? "stable",
    source: { repository, ref, commit, path: sourcePath },
    artifact: {
      mode: "publisher-release",
      fileName: packed.fileName,
      sha256: packed.shasum,
      sizeBytes: packed.byteLength,
    },
    permissions: [...(manifest.permissions ?? [])],
    idempotencyKey: `${manifest.id}@${manifest.version}+${commit}+${packed.shasum.slice(0, 16)}`,
  };

  const payloadPath = join(
    options.outDir ? resolve(options.outDir) : join(dir, "dist"),
    `${manifest.id}-${manifest.version}.submission.json`,
  );
  await writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return { payload, payloadPath, pack: packed, warnings };
}
