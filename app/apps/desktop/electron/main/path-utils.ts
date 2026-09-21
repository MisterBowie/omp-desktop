/**
 * Normalize paths before handing them to native shell APIs.
 *
 * Electron's Windows shell helpers do not accept the extended-length prefix
 * that host-core may persist for long paths. UNC paths deliberately keep the
 * prefix because they use a different Windows namespace.
 */
export function stripWinLongPrefix(path: string): string {
  if (process.platform !== "win32") return path;
  // Matches `\\?\X:\...` (verbatim drive-letter paths).
  if (
    path.startsWith("\\\\?\\") &&
    path.length >= 7 &&
    path[5] === ":" &&
    path[6] === "\\"
  ) {
    return path.slice(4);
  }
  // Matches `//?/X:/...` (forward-slash variant from DB normalization).
  if (path.startsWith("//?/") && path.length >= 7 && path[5] === ":" && path[6] === "/") {
    return path.slice(4);
  }
  return path;
}
