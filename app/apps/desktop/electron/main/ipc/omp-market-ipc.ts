import { IPC } from "@pi-desktop/shared";
import type { OmpMarketplaceService } from "../runtime/omp-marketplace";
import type { IpcRegistrar } from "./types";

/** OMP plugin marketplace channels (ADR 0333); the service validates every argument. */
export function registerOmpMarketIpc(
  registrar: IpcRegistrar,
  marketplace: OmpMarketplaceService,
  sendToRenderer: (channel: string, payload?: unknown) => void,
): void {
  const changed = async (reason: string, work: Promise<unknown>) => {
    const state = await work;
    sendToRenderer(IPC.event.pluginChanged, { reason });
    return state;
  };
  registrar.handle(IPC.invoke.ompMarketState, () => marketplace.state());
  registrar.handle(IPC.invoke.ompMarketAddSource, (source) => changed("ompMarket.addSource", marketplace.addSource(source)));
  registrar.handle(IPC.invoke.ompMarketRemoveSource, (name) => changed("ompMarket.removeSource", marketplace.removeSource(name)));
  registrar.handle(IPC.invoke.ompMarketUpdateSources, (name) => changed("ompMarket.updateSources", marketplace.updateSources(name)));
  registrar.handle(IPC.invoke.ompMarketInstall, (id) => changed("ompMarket.install", marketplace.install(id)));
  registrar.handle(IPC.invoke.ompMarketUninstall, (id) => changed("ompMarket.uninstall", marketplace.uninstall(id)));
  registrar.handle(IPC.invoke.ompMarketSetEnabled, (id, enabled) =>
    changed("ompMarket.setEnabled", marketplace.setEnabled(id, enabled)),
  );
  registrar.handle(IPC.invoke.ompMarketUpgrade, (id) => changed("ompMarket.upgrade", marketplace.upgrade(id)));
}
