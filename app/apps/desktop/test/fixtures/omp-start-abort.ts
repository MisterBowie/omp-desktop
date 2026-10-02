/**
 * T20-B1 fixture (not product code): a trusted extension whose
 * `before_agent_start` handler aborts the operation through the runtime's
 * formal `ctx.abort()` path. Used to verify the contract the desktop gate
 * relies on when its owner state is invalid: abort prevents the prompt from
 * reaching the provider.
 */
interface StartContext {
  abort?: () => void;
}

interface ExtensionAPI {
  on(event: "before_agent_start", handler: (event: unknown, ctx: StartContext) => unknown): void;
}

export default function abortingStart(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (_event, context) => {
    try {
      context.abort?.();
    } catch {
      // The probe observes the abort's effect, not this handler.
    }
    return undefined;
  });
}
