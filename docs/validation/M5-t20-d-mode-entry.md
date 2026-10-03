# M5/T20-D-Enter validation: model-side mode entry

Status: **the first independent review (candidate `f56fe838`) was not accepted
and reported four findings (R1-R4); this repair round implements and verifies
the fixes; the candidate still awaits the root's re-review.** T20-D's
capability/UI acceptance and the plan/goal engine capability keys stay open;
the Cursor + Plan/Goal gate (ADR 0306) is untouched.

Baseline: `2d96fa1e8bf3848021d1f265c0a258a9c455ef4c` (the root-accepted B2
final commit). Product branch `codex/m5-t20-d-mode-entry`; fork branch
`codex/omp-desktop-18.3.0-patch-5`. Fixed submodules: OMP `62bc57be`
(omp/18.3.0), PI `0111e306`. Patch level `.5` = base + fork
`36483311dfff67be7504f591974df93fc512a45a` (**unchanged by this repair**).

## 0. First independent review repair (2026-10-03)

### 0.1 Reproducing the review REDs on this candidate

The root's four review scripts were copied to this machine and adapted **only**
in the repo/output/host-binary paths (expectations untouched); the copies and
both the root-original and adapted hashes are under
`repair-20261003-scripts/`. Reproduced RED (raw JSON + console under
`repair-20261003-red/`):

| Group | RED result on `f56fe838` (before the fix) |
| --- | --- |
| `gate-transition-generation-review.mjs` | 2 positive controls green; all 3 stale-continuation counterexamples red (successor's record replaced by the transitioned copy / successor failed and aborted with its own token) |
| `entry-failure-boundary-review.mjs` | 2 Stop controls green; all 4 committed-but-unfailed cases red (`malformed-committed-reply`, `catalog-error-after-commit` × plan/goal: 3 provider requests, the native write landed, the durable turn settled `completed`) |
| `entry-catalog-generation-review.mjs` | both kinds red: B, prompted as Agent after A's Stop and `session.configure(agent)`, first advertised both Enter tools, then lost them and gained A's `SubmitPlan`/`SubmitGoal` when A's held catalogue assembly was released |

### 0.2 Fixes

1. **Failure record must survive the RPC error channel** (R1). A host-tool
   error carrying structured `details` is now settled as `result.isError`
   instead of the frame's top-level `isError`, because the pinned runtime's
   reject path throws the text and discards the settled value
   (`RpcHostToolBridge.handleResult`). Outcomes without details keep the old
   top-level path. (`app/packages/omp-runtime/src/session/host-tools.ts`)
2. **Undecidable commits stop the turn** (R2). Only the host's four
   pre-CAS refusals stay correctable; an unreadable reply, a transport
   failure, a timeout or an unknown error code is reported as a
   `state: "failed"` record because it cannot rule out a commit.
   (`app/apps/desktop/electron/main/runtime/omp-host-tools.ts`)
3. **The gate's transition continuation is generation-bound** (R4). Every
   await (prompt replacement, clamp) re-checks exact record identity plus the
   token captured at validation; a stale continuation no longer replaces the
   successor's record, retires its delegates, overwrites the prompt cache,
   applies the old clamp, emits a failure naming the successor's token or
   aborts its context. Turn-failure descriptors take the token the failure was
   decided under. (`app/packages/omp-runtime/extensions/omp-desktop-gate.ts`)
4. **The desktop preparation is live-turn-bound** (R3). `enterMode` re-checks
   closed/stopping state, the admission record, the runner and the runner's
   current turn after the catalogue assembly and around the registration; the
   registration guard is re-checked immediately before `set_host_tools` and
   again before the acknowledgment is trusted and the cache fingerprint
   published. A stopped Enter can neither register a catalogue on the
   successor's runtime nor poison the cache. The fork and the fixed submodules
   are unchanged (no patch-level move).
   (`app/apps/desktop/electron/main/runtime/omp-session.ts`)

### 0.3 Behaviour after the repair (raw evidence)

- `repair-20261003-green/gate-transition-generation-f56fe838.json` — **5/5**
  (2 controls + 3 former counterexamples).
- `repair-20261003-green/entry-catalog-generation-f56fe838.json` — **2/2**:
  after A aborts, B stays Agent in both of its provider requests (both Enter
  tools present, both submit tools absent), A `aborted`, B `completed`, mode
  `agent`.
- `repair-20261003-green/entry-failure-boundary-f56fe838.json` — the four
  former failure cases now show exactly what the repair promises: **one**
  provider request, no write, a terminal desktop `error`, `onTurnEnd.reason =
  error`, the durable turn settled **`error`**, the committed mode durable,
  and the next real prompt recovering with the right submit tool and mode
  block. The two Stop controls stay green. The script's own `passed` flag is
  still false for one reason only — see 0.4.
- `repair-20261003-green/model-entry-flow-f56fe838.json` — normal flow 2/2.
- Product regressions added at the same layers (RED before the fix):
  `repair-20261003-red/product-e2e-prefix-red.txt.gz` shows all three new
  `omp-plan-submit-e2e` cases failing against the pre-fix source, while
  `repair-20261003-green/plan-submit-e2e.txt` shows the whole file **13
  passed / 0 failed** after the fix. Unit regressions: the gate stale
  continuation cases (`gate-mode-transition.test.ts`), the structured-error
  settlement (`host-tools.test.ts`), and the adapter's undecidable-commit
  cases (`omp-mode-entry-unit.test.mjs`).

### 0.4 Reviewer expectation correction: the durable turn status

`entry-failure-boundary-review.mjs` asserts `turns.status === "failed"` for
the two committed-unprepared scenarios. The host cannot store that value:
`end_turn_settling` accepts only `completed | aborted | error` and coerces
anything else to `completed` — the very status the review rejects — and it is
the sole writer of `turns.status`; the pinned PI reference has the same
three-value match, and the product's own turn-status unions are
`running | completed | aborted | error`. The probe under
`repair-20261003-corrections/` drives the real host binary and reads the row
back: requesting `"failed"` stores `completed`, requesting `"error"` stores
`"error"`. The repair therefore settles a failed post-commit transition turn
as the host's `error` terminal (with the structured `omp-desktop-turn-failure`
notice carrying `transition-apply-failed`/`transition-invalid`). The original
review script and its expectation are preserved unchanged; the correction
record is `repair-20261003-corrections/turn-status-expectation.json`.

### 0.5 Verification of the repair round

All commands were run on Linux x64, Node v24.14.0, Bun 1.4.2, local
FakeProvider only (no paid/remote model); raw logs in
`repair-20261003-green/`.

| Command | Result |
| --- | --- |
| `pnpm --filter @pi-desktop/omp-runtime test` | 33 files, **499 passed / 6 skipped / 0 failed**, exit 0 (`runtime-vitest.txt`) |
| `node --test apps/desktop/test/omp-mode-entry-unit.test.mjs` | **14 passed / 0 failed** (`mode-entry-unit.txt`) |
| `node --test` over the 11 affected desktop suites (mode-entry unit, submit unit, host-tool adapter/bridge, session failclosed/bridge, host-tool e2e, session e2e, turn-fence e2e, execution-policy e2e, plan-submit e2e) | **164 passed / 0 failed**, exit 0 (`desktop-affected.txt`) |
| `node --test apps/desktop/test/omp-plan-submit-e2e.test.mjs` | **13 passed / 0 failed** (all B2 + T20-D cases + the 3 repair cases) (`plan-submit-e2e.txt`) |
| `pnpm build:js` / `pnpm typecheck` / `pnpm lint` | exit 0 each (`build-js.txt`, `typecheck.txt`, `lint.txt`) |
| `node scripts/omp-patch.mjs --check --source <fork>` / sidecar `--check` | `OMP-SIDECAR-OK 62bc57b+omp-desktop.5` (unchanged patch/binary) |
| `node scripts/omp-sidecar.mjs --build --source <fork>` | real Linux x64 `omp` 244295136 B / `f6111efd…` (unchanged); **rebuilt gate bundle** 52297 B / `dbefff57…`; provenance `.5` (`sidecar-build.txt`) |
| `node scripts/verify-packaged-runtime.mjs --resources apps/desktop/resources` | `PACKAGED-RUNTIME-OK run`: protocol v2, `get_state` ok, gate-load control refused, minimal child PATH + isolated HOME, `stopped=true reaped=true cleaned=true` (`packaged-runtime.txt`) |

Repair commit: `6a4ecbd051a805563bd1fae4751dc346529e605a` on
`codex/m5-t20-d-mode-entry` (pushed to `origin`, ordinary append on top of
`f56fe838`; the fork, patch level `.5` and both fixed submodules are
unchanged). The repair docs/evidence follow in the same commit; this
coordinates paragraph is a separate append.

Not run / not claimed in this round: macOS and Windows real runs, electron-
builder installer resources, release/tag/main merge, the D capability keys and
UI matrix. The gate-bundle rebuild is the source-tree `Resources` layout smoke
(`verify-packaged-runtime.mjs`), not an installed packaged application.

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
