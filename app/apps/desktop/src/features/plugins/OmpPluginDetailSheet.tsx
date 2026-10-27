import type { TFunction } from "i18next";
import { OMP_MARKET_LOADED_COMPONENTS, type OmpMarketComponentKind } from "@pi-desktop/shared";
import { Button, TooltipButton } from "../../components/ui";
import { IconLink, IconTriangleAlert, IconX } from "../../components/icons";
import { openHttpUrl } from "../../lib/open-http-url";
import { formatDate, monogram } from "./model";
import { OMP_COMPONENT_LABEL_KEYS, OMP_UNAVAILABLE_KEYS, ompWithheldKinds } from "./omp-market-model";
import type { OmpMarketplaceModel } from "./useOmpMarketplace";

function KindList({ kinds, t }: { kinds: readonly OmpMarketComponentKind[]; t: TFunction }) {
  return (
    <ul className="plugins-omp-kinds">
      {kinds.map((kind) => (
        <li key={kind} className="plugins-omp-kind">
          {t(OMP_COMPONENT_LABEL_KEYS[kind])}
        </li>
      ))}
    </ul>
  );
}

/** Details and actions for one OMP marketplace plugin (ADR 0333). */
export function OmpPluginDetailSheet({ market, t, locale }: { market: OmpMarketplaceModel; t: TFunction; locale: string }) {
  const item = market.selected;
  if (!item) return null;
  const { plugin, installed } = item;
  const disabled = market.busy !== null || !market.state?.available;
  const running = market.busy?.target === item.id;
  const withheld = ompWithheldKinds(item);
  const loaded = installed
    ? OMP_MARKET_LOADED_COMPONENTS.filter((kind) => (installed.components.loaded[kind] ?? 0) > 0)
    : [];
  const links = [
    { key: "repository", url: plugin?.repository },
    { key: "homepage", url: plugin?.homepage },
  ].filter((link): link is { key: string; url: string } => !!link.url);

  return (
    <div className="plugins-sheet-layer">
      <button type="button" className="plugins-sheet-scrim" aria-label={t("plugins.closeDetail")} onClick={market.closeDetail} />
      <aside className="plugins-sheet" role="dialog" aria-modal="true" aria-label={t("plugins.detailTitle")}>
        <header className="plugins-sheet-head">
          <span className="plugins-card-glyph is-large" aria-hidden>
            {monogram(item.name)}
          </span>
          <div className="plugins-sheet-ident">
            <h2 className="plugins-sheet-title">{item.name}</h2>
            <div className="plugins-sheet-meta">
              <span className="plugins-row-id">{item.id}</span>
              {plugin?.authorName ? (
                <>
                  <span className="plugins-dot" aria-hidden>
                    ·
                  </span>
                  <span>{plugin.authorName}</span>
                </>
              ) : null}
            </div>
          </div>
          <TooltipButton
            type="button"
            className="plugins-icon-btn"
            ariaLabel={t("plugins.closeDetail")}
            tooltip={t("plugins.closeDetail")}
            onClick={market.closeDetail}
          >
            <IconX size={15} />
          </TooltipButton>
        </header>

        <div className="plugins-sheet-cta">
          <div className="plugins-sheet-cta-copy">
            <span className="plugins-sheet-cta-version">
              {installed ? `v${installed.version}` : plugin?.version ? `v${plugin.version}` : item.marketplace}
            </span>
            <span className="plugins-sheet-cta-meta">
              {installed
                ? t("plugins.ompMarket.installedOn", { date: formatDate(installed.lastUpdated || installed.installedAt, locale) })
                : plugin && !plugin.installable && plugin.unavailableReason
                  ? t(OMP_UNAVAILABLE_KEYS[plugin.unavailableReason])
                  : t("plugins.ompMarket.fromMarketplace", { name: item.marketplace })}
            </span>
          </div>
          <div className="plugins-omp-actions">
            {installed ? (
              <>
                {installed.updateVersion && !installed.broken ? (
                  <Button variant="primary" disabled={disabled} onClick={() => market.upgrade(item)}>
                    {running && market.busy?.action === "upgrade"
                      ? t("plugins.ompMarket.upgrading")
                      : t("plugins.ompMarket.upgrade", { version: installed.updateVersion })}
                  </Button>
                ) : null}
                {installed.broken ? null : (
                  <Button variant="secondary" disabled={disabled} onClick={() => market.setEnabled(item, !installed.enabled)}>
                    {installed.enabled ? t("plugins.ompMarket.disable") : t("plugins.ompMarket.enable")}
                  </Button>
                )}
                <Button variant="secondary" disabled={disabled} onClick={() => market.uninstall(item)}>
                  {running && market.busy?.action === "uninstall" ? t("plugins.ompMarket.uninstalling") : t("plugins.ompMarket.uninstall")}
                </Button>
              </>
            ) : plugin?.installable ? (
              <Button variant="primary" disabled={disabled} onClick={() => market.install(item)}>
                {running ? t("plugins.ompMarket.installing") : t("plugins.ompMarket.install")}
              </Button>
            ) : null}
          </div>
        </div>

        <div className="plugins-sheet-body">
          {installed?.broken ? (
            <section className="plugins-callout">
              <span className="plugins-callout-icon" aria-hidden>
                <IconTriangleAlert size={15} />
              </span>
              <p className="plugins-callout-body">{t("plugins.ompMarket.brokenHint")}</p>
            </section>
          ) : null}

          <section className="plugins-sheet-section">
            <h3 className="plugins-sheet-section-title">{t("plugins.aboutTitle")}</h3>
            {plugin?.description ? <p className="plugins-sheet-desc">{plugin.description}</p> : null}
            <dl className="plugins-provenance">
              <div className="plugins-provenance-row">
                <dt>{t("plugins.ompMarket.marketplace")}</dt>
                <dd>{item.marketplace}</dd>
              </div>
              {plugin?.license ? (
                <div className="plugins-provenance-row">
                  <dt>{t("plugins.ompMarket.license")}</dt>
                  <dd>{plugin.license}</dd>
                </div>
              ) : null}
              {plugin?.category ? (
                <div className="plugins-provenance-row">
                  <dt>{t("plugins.ompMarket.category")}</dt>
                  <dd>{plugin.category}</dd>
                </div>
              ) : null}
              {plugin?.keywords.length ? (
                <div className="plugins-provenance-row">
                  <dt>{t("plugins.ompMarket.keywords")}</dt>
                  <dd>{plugin.keywords.join(", ")}</dd>
                </div>
              ) : null}
            </dl>
            {links.length > 0 ? (
              <div className="plugins-sheet-links">
                {links.map((link) => (
                  <button key={link.key} type="button" className="plugins-sheet-link" onClick={() => openHttpUrl(link.url)}>
                    <IconLink size={13} />
                    <span className="plugins-sheet-link-label">{t(`plugins.${link.key}`)}</span>
                    <span className="plugins-sheet-link-url">{link.url}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </section>

          <section className="plugins-sheet-section">
            <h3 className="plugins-sheet-section-title">{t("plugins.ompMarket.loadedTitle")}</h3>
            {installed ? (
              loaded.length > 0 ? (
                <ul className="plugins-omp-kinds">
                  {loaded.map((kind) => (
                    <li key={kind} className="plugins-omp-kind">
                      {t("plugins.ompMarket.componentCount", {
                        name: t(OMP_COMPONENT_LABEL_KEYS[kind]),
                        count: installed.components.loaded[kind] ?? 0,
                      })}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="plugins-sheet-desc">{t("plugins.ompMarket.loadedNone")}</p>
              )
            ) : (
              <p className="plugins-sheet-desc">{t("plugins.ompMarket.loadedAfterInstall")}</p>
            )}
            {installed ? <p className="plugins-omp-hint">{t("plugins.ompMarket.appliesNextMessage")}</p> : null}
          </section>

          {withheld.length > 0 ? (
            <section className="plugins-callout">
              <span className="plugins-callout-icon" aria-hidden>
                <IconTriangleAlert size={15} />
              </span>
              <div>
                <h3 className="plugins-callout-title">{t("plugins.ompMarket.withheldTitle")}</h3>
                <p className="plugins-callout-body">{t("plugins.ompMarket.withheldBody")}</p>
                <KindList kinds={withheld} t={t} />
              </div>
            </section>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
