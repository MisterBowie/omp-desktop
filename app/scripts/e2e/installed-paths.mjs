/** Physical filesystem identity, including Windows short names and junctions. */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const installedFilesystemPath = (path) => realpathSync.native(path);
export const createInstalledRunRoot = () => installedFilesystemPath(mkdtempSync(join(tmpdir(), "omp-installed-")));
