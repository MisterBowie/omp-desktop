#!/usr/bin/env node
/**
 * E01 — real OMP startup, `ready`, version negotiation, protocol samples, frame limits.
 *
 * Runs the pinned source launcher in both `rpc` and `rpc-ui` modes against an
 * isolated config root and a local (unreachable) mock model, then records the
 * handshake, the advertised frame limits, and a sanitized protocol sample.
 *
 * Usage: node e01-protocol.mjs
 */
import { join } from "node:path";
import { OmpRpc } from "./lib/rpc.mjs";
import { resolveRepoRoot, verifyPinnedSource, sanitizeFrame } from "./lib/base.mjs";
import { runExperiment, experimentRoot, writeFixture } from "./lib/run.mjs";

const evidence = await runExperiment("e01-protocol", async (ctx) => {
  const repoRoot = resolveRepoRoot();
  const pin = verifyPinnedSource(repoRoot);
  ctx.check("pinned submodule SHA matches the repo gitlink", pin.gitlink === pin.actual, `${pin.gitlink}`);
  ctx.check("launcher reports the pinned version", pin.ok, pin.reason);
  ctx.note("pinnedVersion", pin.pinnedVersion);
  ctx.note("gitlink", pin.gitlink);

  for (const mode of ["rpc", "rpc-ui"]) {
    const { runRoot, selector } = experimentRoot(ctx, `e01-${mode}`, { modelId: "local-model" });
    let rpc;
    try {
      rpc = await OmpRpc.start({ repoRoot, runRoot, mode, args: ["--model", selector] });
      const ready = rpc.readyFrame;
      ctx.note(`ready.${mode}`, sanitizeFrame(ready));
      ctx.check(`${mode}: ready has protocolVersion 1`, ready.protocolVersion === 1);
      ctx.check(
        `${mode}: ready advertises [1,2]`,
        Array.isArray(ready.supportedProtocolVersions) && ready.supportedProtocolVersions.includes(2),
        ready.supportedProtocolVersions,
      );
      ctx.check(`${mode}: maxFrameBytes is a positive number`, Number.isFinite(ready.maxFrameBytes) && ready.maxFrameBytes > 0, ready.maxFrameBytes);
      ctx.check(
        `${mode}: maxReassembledFrameBytes >= maxFrameBytes`,
        Number.isFinite(ready.maxReassembledFrameBytes) && ready.maxReassembledFrameBytes >= ready.maxFrameBytes,
        ready.maxReassembledFrameBytes,
      );

      const neg = await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });
      ctx.check(`${mode}: negotiate_protocol succeeds`, neg.success === true, neg);
      ctx.check(`${mode}: negotiated protocolVersion 2`, neg.data?.protocolVersion === 2, neg.data);

      // The ready frame advertises [1,2] (rpc-mode.ts:843) but the command
      // handler only accepts 2 (rpc-mode.ts:1176); OMP's own client likewise
      // only requires that the list contains 2 (rpc-client.ts:176). So the
      // advertised list is informational and v1 negotiation must fail loudly.
      const negV1 = await rpc.request({ type: "negotiate_protocol", protocolVersion: 1 });
      ctx.check(`${mode}: protocol version 1 is rejected with an explicit error`,
        negV1.success === false && /protocol version/i.test(negV1.error ?? ""),
        negV1.error ?? negV1.data);
      ctx.check(`${mode}: downgrading to v1 does not disturb the v2 session`,
        (await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 })).data?.protocolVersion === 2);

      const models = await rpc.request({ type: "get_available_models" });
      const ids = (models.data?.models ?? []).map((m) => m.id);
      ctx.check(`${mode}: get_available_models lists the mock model`, ids.includes("local-model"), ids);

      const state = await rpc.request({ type: "get_state" });
      ctx.check(`${mode}: get_state responds`, state.type === "response", state.error ?? "ok");
      ctx.note(`state.${mode}`, sanitizeFrame(state.data ?? {}));

      const commands = rpc.framesOfType("available_commands_update").at(-1);
      ctx.check(`${mode}: available_commands_update received`, Boolean(commands), commands ? `${commands.commands?.length} commands` : "missing");
      if (commands) ctx.note(`commands.${mode}`, (commands.commands ?? []).map((c) => c.name));

      if (mode === "rpc-ui") {
        writeFixture("e01-handshake.json", {
          note: "real capture, sanitized; local fake model provider, no credentials",
          captureMode: mode,
          pinnedVersion: pin.pinnedVersion,
          submoduleSha: pin.actual,
          ready: sanitizeFrame(ready),
          negotiateResponse: sanitizeFrame(neg),
          commandNames: (commands?.commands ?? []).map((c) => c.name),
        });
      }
    } finally {
      if (rpc) {
        const reaped = await rpc.stop();
        ctx.check(`${mode}: process group reaped`, reaped === true);
      }
    }
  }

  ctx.limit("Only handshake-level frames are captured here; turn-level events are covered by E02.");
});

process.exit(evidence.ok ? 0 : 1);
