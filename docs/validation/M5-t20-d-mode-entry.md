# M5/T20-D-Enter validation: model-side mode entry

Status: implementation complete and locally validated; the root's independent
review is pending. T20-D's capability/UI acceptance and the plan/goal engine
capability keys stay open; the Cursor + Plan/Goal gate (ADR 0306) is untouched.

Baseline: `2d96fa1e8bf3848021d1f265c0a258a9c455ef4c` (the root-accepted B2
final commit). Product branch `codex/m5-t20-d-mode-entry`; fork branch
`codex/omp-desktop-18.3.0-patch-5`. Fixed submodules: OMP `62bc57be`
(omp/18.3.0), PI `0111e306`. Patch level `.5` = base + fork
`36483311dfff67be7504f591974df93fc512a45a`.

Executor: one fresh session, model deepseek/deepseek-flash with thinking=max
(the user-selected executor; the planning/root session is separate). Environment:
Linux x64, Node v24.14.0, Bun 1.4.2, host-core debug binary built from the
unchanged `crates/host-core`. Every runtime test drives a local FakeProvider; no
paid or remote model is contacted. Raw logs and the baseline probe output are
under `docs/validation/M5-t20-d-mode-entry/`.

## 1. Requirement and baseline gap (RED evidence)

Fixed PI (`upstream/pi-desktop/packages/agent-runtime/src/runtime.ts:3595-3630`,
tests `:2138-2320`) and the product spec (`app/docs/spec/03-runtime/02-agent-runtime.md`
§5b, `10-session-state-machine.md` rule 12) require the model to call
`EnterPlanMode`/`EnterGoalMode`: Agent-only, empty-object schema, host
`plans.enter` is authoritative, and a successful entry is **non-terminating** —
the same durable turn continues with the new prompt and catalogue, and only the
mode's own submit tool terminates.

RED probe (baseline commit, real fixed patched runtime + real host +
FakeProvider + a trusted probe extension that wraps the baseline gate):
`evidence/baseline-probe.json`. It records:

- the Agent-mode provider catalogue contains **neither** `EnterPlanMode` nor
  `EnterGoalMode` (only the ordinary tool set);
- the trusted extension API surface has **no** live system-prompt action
  (`setTurnSystemPrompt`/`setSystemPrompt` are `undefined` from inside the
  runtime process; only `getActiveTools`/`setActiveTools` exist);
- a mid-turn `setActiveTools(["read"])` **does** narrow the next provider
  request's tool list, while the system prompt stays byte-identical — the
  catalogue can move mid-run, the prompt cannot.

That last pair is why the phase needed one narrow fork addition instead of a
per-provider payload hack: `before_agent_start` does not fire on a tool-only
iteration, and provider payload shapes differ per provider, so only an in-process
action can move the live prompt atomically (ADR 0311 §Context).

## 2. Implementation

- `app/apps/desktop/electron/main/runtime/omp-host-tools.ts`:
  `desktopEnterToolCatalogEntry(kind)` (PI names/descriptions, `{}` schema,
  essential/exclusive/sole, no settle termination, risk low, origin desktop),
  the `plans.enter` endpoint with durable identity from the binding/run/frame,
  strict reply validation (`ok && state === "planning" && kind`), and the
  transition record on the settled result's `details`.
- `app/apps/desktop/electron/main/runtime/omp-session.ts`: the Agent catalogue
  now carries both entries (contract modes keep their submit tool only); the
  executor binding records the new mode for the live turn and re-registers the
  host tools mid-turn; the record names the **native** session identity the
  gate validates.
- `app/packages/omp-runtime/src/session/mode-transition.ts` (new): the
  versioned, strictly decoded transition record (identity, direction,
  single-use material, byte ceiling).
- `app/packages/omp-runtime/extensions/omp-desktop-gate.ts`: a `tool_result`
  handler that validates the record against the live admission (fence token,
  owning session, exact tool call, Agent-only, one transition per turn), then
  applies the new system prompt from the cached parts, a new admission record,
  delegate retirement and the contract clamp.
- `app/packages/omp-runtime/src/session/turn-failure.ts` (new) and
  `runner.ts`: the structured mid-turn failure notice, honored only for the
  live running generation; the turn closes as an `error` (never as a
  completed turn), so the durable host turn is settled accordingly.
- Fork `.5`: optional `ExtensionAPI.setTurnSystemPrompt`
  (`AgentSession.setTurnSystemPrompt`, forwarded by `ExtensionRunner.initialize`).

## 3. Verification (commands, exits, proof layer)

### 3.1 RED/GREEN product tests

| Command | Result | Proof layer |
| --- | --- | --- |
| `node apps/desktop/test/zz-baseline-probe.mjs` (baseline tree, RED) | `evidence/baseline-probe.json`: Agent catalogue without Enter tools; no live prompt API; mid-turn `setActiveTools` narrows the next request while the prompt is unchanged | real fixed patched runtime + real host + FakeProvider + trusted probe extension |
| `node --test --test-name-pattern "T20-D" apps/desktop/test/omp-plan-submit-e2e.test.mjs` | 3 passed / 0 failed | real fixed patched runtime + real host DB + production bridge/gate/adapter + FakeProvider |
| `node --test apps/desktop/test/omp-plan-submit-e2e.test.mjs` | 10 passed / 0 failed (7 accepted B2 cases + 3 D-Enter cases) | same |
| `node --test apps/desktop/test/omp-mode-entry-unit.test.mjs` | 13 passed / 0 failed | production adapter, scripted host |
| `pnpm --filter @pi-desktop/omp-runtime test` | see §3.3 | real gate/gate-testkit units |
| `pnpm build:js` / `pnpm typecheck` / `pnpm lint` | see §3.3 | compile + types + lint |

The three E2E cases cover:

1. **Plan**: `EnterPlanMode` (model-called) commits `sessions.mode = plan`
   through the real host; the **same run's next provider request** carries the
   Plan block (and neither the Agent nor the Goal block) and the Plan
   catalogue (`SubmitPlan` present; `EnterPlanMode`/`EnterGoalMode`,
   `write`/`edit`/`apply_patch`/`task`/`eval` absent); the read-only core
   executes, the write attempt creates no file, the undeclared plugin tool is
   never executed (its fixture recorded zero calls); a Bash call under Plan
   `ask` raises a real approval card, executes after the desktop's own
   decision, and `SubmitPlan` then publishes the immutable artifact
   (`sha256`/size/bytes byte-compared) and ends the run with no further
   provider request.
2. **Goal**: `EnterGoalMode` moves the same turn to the Goal block and
   `SubmitGoal`; the wrong-kind `SubmitPlan` call is refused before the host
   (no plan row), and the Goal artifact lands under `.pi/goal/`.
3. **Mixed batch**: `[EnterPlanMode, bash]` is rejected whole — no
   `tool_execution_start`, no sibling side effect, no durable mode change —
   and a sole retry in the next model step enters Plan and submits normally.

### 3.2 Gate/unit counterexamples (`omp-runtime` vitest)

`gate-mode-transition.test.ts` (11 cases) pins: the ready record applies
prompt + clamp + policy and retires the prompt-time delegates; a replayed
record, a foreign session, a foreign tool-call id, a wrong direction, an
unstarted admission, a failed-state record, a success without a record and a
runtime without the live prompt API each fail the started turn (aborted,
structured `omp-desktop-turn-failure` notice, admission retired); an ordinary
host refusal stays correctable; a same-turn continuation rebuilds the prompt
from the cached parts; a Goal transition carries only `SubmitGoal`; the next
fence replaces the transitioned record.
`mode-transition.test.ts` (9 cases) pins the strict record codec.
`gate.test.ts` now expects the six registered policies.

### 3.3 Full-suite / build results

All commands below were captured verbatim under
`docs/validation/M5-t20-d-mode-entry/` (`green-*.txt`, `fork-*.txt`).

| Command | Result (raw log) |
| --- | --- |
| `node --test apps/desktop/test/omp-plan-submit-e2e.test.mjs` | 10 passed / 0 failed, exit 0 (`green-e2e-full.txt`) |
| `pnpm --filter @pi-desktop/omp-runtime test` | 33 files passed, 495 passed / 6 skipped / 0 failed, exit 0 (`green-runtime-vitest.txt`) |
| `node --test` over the 10 affected desktop suites | 142 passed / 0 failed, exit 0 (`green-desktop-units.txt`) |
| `pnpm build:js` (product `app/`) | exit 0 (`green-build-js.txt`) |
| `pnpm typecheck` (product `app/`) | exit 0 (`green-typecheck.txt`) |
| `pnpm lint` (product `app/`) | exit 0 (`green-lint.txt`) |
| `node scripts/omp-patch.mjs --check` | `OMP-PATCH-OK 62bc57b+omp-desktop.5`, patch `64524286…`/118548 B, tracked files 7673 |
| `git -C <fork> -c core.abbrev=7 diff <base> <fork-head>` vs the shipped patch | byte-identical (`64524286…`) |
| Fork suites: `bun test agent-loop / rpc-host-tools / rpc-input-frame / agent-session-turn-system-prompt / agent-session-before-agent-start-prompt-override / extensions-runner` | 155 / 16 / 12 / 3 / 2 / 89 passed, exit 0 (`fork-tests.txt`) |
| Fork `tsgo -p packages/coding-agent/tsconfig.json --noEmit` | exit 0 (`fork-typecheck.txt`) |
| `node scripts/omp-sidecar.mjs --check --source <fork>` | `OMP-SIDECAR-OK 62bc57b+omp-desktop.5` (`green-sidecar-check.txt`) |
| `node scripts/omp-sidecar.mjs --build --source <fork>` | real Linux x64 `omp` 244295136 B / `f6111efd…`, gate bundle 51786 B / `7cf4fe24…`, provenance `.5` (`green-sidecar-build.txt`) |
| `node scripts/verify-packaged-runtime.mjs --resources apps/desktop/resources` | `PACKAGED-RUNTIME-OK`: protocol v2 negotiated, `get_state` ok, gate-load control refused, minimal child PATH + isolated HOME + no credential inheritance, `stopped=true reaped=true cleaned=true` with no leftovers (`green-sidecar-smoke.txt`) |

## 4. Failure and cancellation semantics (as implemented)

- A host refusal (`PLAN_APPROVAL_STALE`, `PLAN_ALREADY_ACTIVE`,
  `PLAN_SESSION_NOT_FOUND`, invalid params) is a correctable tool error with no
  transition record.
- A committed-but-unprepared transition (stop raced the RPC, catalogue
  re-registration failed, no live prompt API, apply throw) reports a
  `state: "failed"` record; the gate aborts the turn, retires the admission and
  signals the runner through the versioned turn-failure notice, so the turn
  ends as `error` (one terminal envelope, one `error` turn-end) rather than
  `completed`, and no further provider request or tool call runs.
- The durable host row keeps the committed mode; the next prompt rebuilds the
  admission/catalogue/prompt from it (the existing B1/B2 path). Nothing is
  rolled back and no old Agent-era admission can keep deciding.
- A user Stop during the entry RPC is re-checked after the RPC and after the
  desktop preparation; the run is closed by the stop path, and the durable fact
  stays for the next prompt.

## 5. Residual limits / not claimed

- The gate cannot verify the record's `liveTurnId` directly: the pinned runtime
  exposes no live-generation identity to extensions. The binding it does
  enforce is the fence token installed for this run, the owning native session,
  the exact tool-call id of the settled result and single use; the durable turn
  and the previous durable mode are validated by the host inside `plans.enter`.
- The gate's layer-level contract denial for tools that bypass the clamp (a
  deferred/auto-activated tool) is proven by the C suites; this phase's new
  E2E proves the catalogue swap and the mode plumbing (`SubmitPlan` accepted
  only after the transition), not a new gate-layer denial for native tools
  (they are not advertised at all).
- `plan`/`goal` engine capability keys, the composer entry, and the whole-matrix
  acceptance stay T20-D; Cursor + Plan/Goal stays refused (ADR 0306); no Goal
  continuation timer is introduced; the whole M5/T20 stage is not claimed
  complete.
- Only Linux x64 was exercised; no macOS/Windows run, no release/tag/main merge.
- The sidecar verification runs the production verifier over the source-tree
  `app/apps/desktop/resources` layout (the same `Resources` layout the launcher
  resolves at runtime). It is **not** an electron-builder installed application
  and does not replace M6/T21's packaged-resource acceptance.
