/**
 * T20-B1 fixture (not product code): a trusted extension whose
 * `before_agent_start` handler throws. Used as the negative control for the
 * abort path: the pinned runtime catches and logs handler errors, then still
 * delivers the prompt, so a throwing handler does NOT protect a turn.
 */
interface ExtensionAPI {
  on(event: "before_agent_start", handler: (event: unknown, ctx: unknown) => unknown): void;
}

export default function throwingStart(pi: ExtensionAPI): void {
  pi.on("before_agent_start", () => {
    throw new Error("fixture: before_agent_start handler failure");
  });
}
