/**
 * The run-scoped capability-source boundary (M5/T19-A).
 *
 * Every OMP runtime this product starts receives one config overlay file,
 * written inside the run's owned root and passed as `--config <overlay>`.
 * The pinned runtime merges `--config` overlays above the global config layer
 * (`~/.omp/agent/config.yml`) and above the project layer (workspace
 * `.omp/…`, `.claude/settings.json`, project `mcp.json`, …), and below only
 * its own runtime overrides — the precedence the runtime documents as
 * `defaults < global < project < PI_CONFIG_FILES < --config < runtime`.
 *
 * The overlay therefore closes the ambient capability sources this product
 * does not own yet:
 *
 *   - `mcp.enableProjectConfig: false` — no workspace `.mcp.json` / `mcp.json`
 *     (native, standalone, or another tool's) can connect and register tools.
 *     The desktop-owned MCP equivalent arrives once through the host-tool RPC
 *     boundary in T19-B.
 *   - `memory.backend: off` — no OMP memory backend can read or write memory
 *     files or inject them into the prompt, whatever a lower-priority global
 *     or workspace config says. Desktop project memory arrives through the
 *     trusted gate with the existing `projectMemoryPrompt()` semantics in
 *     T19-C.
 *
 * The file is a property of one run: it lives inside the run root, and the
 * supervisor's owned cleanup removes it with the run root on stop, reclaim,
 * and failed starts. It is never a static constructor argument and never
 * touches the user's real configuration.
 */
import { writeFileSync } from "node:fs";

/** File name of the run-scoped overlay inside each run root. */
export const CONFIG_OVERLAY_FILE = "config-overlay.yml";

/**
 * The overlay content, with the forced settings last so they are the final
 * word of the document if future phases append entries ahead of them.
 */
export function sourceIsolationOverlayYaml(): string {
  return [
    "# Run-scoped capability-source boundary, written by the OMP Desktop runtime supervisor (M5/T19-A).",
    "# The pinned runtime merges this above the global and project config layers; the",
    "# workspace cannot re-open these sources. Desktop-owned equivalents are exposed once",
    "# through the host-tool RPC boundary (T19-B) and the trusted gate (T19-C).",
    "mcp:",
    "  enableProjectConfig: false",
    "memory:",
    "  backend: off",
    "",
  ].join("\n");
}

/** Write the run-scoped source-isolation overlay to `path`. */
export function writeSourceIsolationOverlay(path: string): void {
  writeFileSync(path, sourceIsolationOverlayYaml(), "utf8");
}
