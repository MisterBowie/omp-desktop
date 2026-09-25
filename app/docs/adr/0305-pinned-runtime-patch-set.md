# ADR 0305: A maintainable patch level on the pinned OMP runtime

- Status: Accepted (M5/T20-R3A), **revised after independent review (F3)**. The
  patch-set mechanism stands; the claim that the patch level satisfies PI's
  transition-tool contract does **not** — see "Unresolved (F3)".
- Date: 2026-09-25 (F3 revision 2026-09-25)
- Scope: how this project extends the pinned `upstream/oh-my-pi` runtime.
  T20-B/C/D remain declared, not claimed, and **T20-B must not start**: the R3
  blocker is not lifted.
- Evidence: `docs/validation/M5-omp-transition-patch.md`,
  `app/patches/oh-my-pi/manifest.json`,
  `app/patches/oh-my-pi/0001-rpc-host-tool-transition-contract.patch`,
  `app/scripts/omp-patch.mjs`,
  `apps/desktop/test/omp-patch.test.mjs`,
  `experiments/omp-bridge/t20-feasibility.mjs`.

## Context

T20-A's feasibility spike showed that the fixed OMP 18.2.7
(`d49918fab2dba3986927f2d46721629ed0f3a02c`) cannot implement PI Desktop's
transition-tool contract: an assistant batch that contains `SubmitPlan`/
`SubmitGoal` plus any sibling executes every call, and a submit result cannot
end the turn. The missing pieces are upstream capabilities, not desktop-side
wiring:

- RPC host-tool definitions carry no scheduling or batch-admission declaration,
  and `RpcHostToolAdapter` hardcodes `concurrency = "shared"`.
- `AgentToolResult` / `AfterToolCallResult` have no `terminate`, so a tool
  result cannot end the run.
- The only graceful stop the runtime offers is the subagent `yield` path, which
  is implemented by aborting the run with a private signal reason and rewriting
  the outcome downstream.

The same gaps still exist on upstream `main` at `ea8b542`
(`packages/agent/src/types.ts` has no `terminate`; `RpcHostToolDefinition` has
neither `concurrency` nor `batchPolicy`; `packages/coding-agent/src/modes/rpc/
host-tools.ts` still hardcodes `"shared"`). Waiting for upstream is not a plan,
and moving the desktop onto `main` would trade a known, auditable base for an
unpinned one.

## Decision

### 1. The runtime stays pinned; this project maintains a numbered patch level

The submodule stays at its fixed commit and its gitlink never moves for a
feature. What this project adds lives in `app/patches/oh-my-pi/`:

- `0001-*.patch` — a plain `git diff` against the pinned commit,
- `manifest.json` — base SHA, expected runtime version, patch SHA-256 and byte
  count, the capability ids, and the verification entry points.

The patch level is named `<base-short-sha>+omp-desktop.<n>` (currently
`d49918f+omp-desktop.1`) and is described as **maintained by OMP Desktop**, never
as upstream OMP support for the version. Anything that reports a runtime version
must keep reporting `omp/18.2.7` plus the patch level from the manifest.

### 2. `app/scripts/omp-patch.mjs` is the only application path

Developers and packaging never edit the submodule. The script:

- validates the manifest (schema, base SHA against the source `HEAD`, runtime
  version from `packages/utils/package.json`, patch checksum),
- refuses a source checkout with uncommitted changes,
- copies **exactly the tracked tree** of the pinned commit into a scratch
  directory (no `.git`), applies the patch, and proves it fully applied by
  checking `git apply --check --reverse`,
- optionally copies the per-worktree dependency payload (`node_modules`, built
  natives, the generated tool views) so the tree runs without installing —
  **with symlinks copied verbatim**, because a rewritten link silently resolves
  the unpatched workspace,
- optionally runs the patched launcher's `--version` probe and the agent + RPC
  host-tool suites inside the tree (`--verify`),
- removes every scratch it created on every path, including failures, and refuses
  targets that are symlinks, non-empty directories, the source checkout, or an
  ancestor of the repository.

M6/T21 consumes `--apply --out <dir> --prepare-build` as its build entry point;
nothing else re-implements patch application.

### 3. What the patch level provides (risk reduction, not a strict contract)

| Capability id | Contract |
| --- | --- |
| `rpc-host-tool-concurrency` | `RpcHostToolDefinition.concurrency?: "shared" \| "exclusive"`, omitted → `"shared"`; any other value — including JSON `null` — rejects the whole `set_host_tools` request |
| `rpc-host-tool-sole-batch-policy` | `RpcHostToolDefinition.batchPolicy?: "any" \| "sole"`; a `"sole"` tool must be the only call in its assistant message, counted over **every** `toolCall` block of the message (PI `runtime.ts:2222-2234` counts them without exclusions). A violating batch is rejected whole: no call the loop dispatches executes, no `tool_execution_start` is emitted, one blocked error result per dispatched call in order, and the host hook is never consulted. A pre-executed sibling cannot be un-executed — see "Unresolved (F3)" |
| `agent-tool-result-terminate` | `AgentToolResult.terminate?: boolean` and `AfterToolCallResult.terminate?: boolean`; once the batch settles, a requested termination ends the run before the next provider call — success and error results alike, no rewritten `stopReason`, queued steering left for the next run; streaming partials never terminate |
| `rpc-host-tool-result-terminate` | `host_tool_result.result.terminate` reaches the loop verbatim and must be an optional JSON boolean; any other value is a malformed frame that fails the call instead of being read for truthiness. A frame with top-level `isError` and `result.terminate` resolves with `isError: true, terminate: true` instead of being rejected (a thrown error cannot carry the flag) |

The declarations are generic: nothing in the patch knows about Plan, Goal,
`SubmitPlan`, `SubmitGoal`, or any desktop product name. The desktop declares the
policy on the tool it registers.

Speculation is disabled for a provider call whose active tool set advertises a
sole-declared tool, so no speculative candidate or stream session can start
physical work before the batch's admission is decided (OMP starts candidates at
`toolcall_end`: `speculative-execution.ts:847-905`, `agent-loop.ts:2264`). This
is a real cost — `read`/`eval` speculation is off in exactly the sessions that
register a transition tool — and it is deliberate.

## Unresolved (F3): the sole contract is not strict

PI's rule counts *every* `toolCall` block of the assistant message
(`packages/agent-runtime/src/runtime.ts:2222-2234`). OMP can produce blocks the
loop never dispatches and that were already executed before the assistant
message existed: a `toolCall` carrying `kCursorExecResolved` was run by the
Cursor exec channel / provider bridge during streaming, and its result is
buffered for out-of-band emission (`packages/ai/src/utils/block-symbols.ts:46-57`,
`packages/agent/src/agent.ts:1491-1497`). Such a call's side effect cannot be
prevented or retracted by anything the agent loop does.

Therefore the patch level cannot guarantee "a batch that carries a sole tool and
any sibling has zero side effects": it can only guarantee that the loop does not
execute, start, or host-call anything for that batch — including not running the
already-executed block a second time (which is what the marker exists to
prevent). PI has no equivalent channel, so there is no PI behaviour to match
here; the requirement itself is unsatisfiable at this layer.

Consequences:

- **R3 remains a hard blocker.** The T20-B/C/D work that depends on it must not
  start, and the "R3 lifted" / "T20-B may start" claims made in the previous
  commit of this branch are retracted.
- The patch level stays useful as *risk reduction* for the paths the loop
  controls (all-toolCall counting, speculation gate, batch rejection, terminate
  plumbing) and as the mechanism M6/T21 builds a patched runtime with — but it
  is not a PI-compatibility claim.
- Lifting R3 needs one of: an upstream change that stops pre-executing calls
  before the assistant message is complete, a product decision to remove those
  channels (Cursor exec channel / tool speculation) from sessions that declare
  sole-batch tools, or an explicitly user-accepted semantic difference.

## Consequences

- The desktop gains the behavior PI's runtime has, without forking the runtime
  and without depending on an unpinned upstream branch. The cost is carrying one
  patch file per capability set, and a rebase obligation whenever the pinned
  commit moves: re-apply, re-run `--check`, the patched spike, and the OMP
  suites listed in the manifest.
- The patch is deliberately minimal (agent core + the RPC host-tool mapping and
  its docs); it adds no new provider/streaming behavior and does not touch
  permissions, approvals, or session storage, so the T19 boundaries stay intact.
- `docs/rpc.md` in the patched tree documents the wire fields, so an SDK consumer
  reading the runtime's own documentation sees the same contract.
- The patch level must never be described as native upstream support, and the
  desktop must not report the patched runtime as plain `18.2.7` when a support
  decision depends on the distinction.
