import { Button, TooltipButton, cx } from "../components/ui";
import { IconDownload, IconMore, IconPlug, IconRefresh } from "../components/icons";
import { AnchoredMenu } from "../components/settings/AnchoredMenu";
import { SearchField } from "../features/plugins/presentation";
import { InstalledPluginsPanel } from "../features/plugins/InstalledPluginsPanel";
import { OmpMarketplacePanel } from "../features/plugins/OmpMarketplacePanel";
import { OmpPluginDetailSheet } from "../features/plugins/OmpPluginDetailSheet";
import { PluginDialogs } from "../features/plugins/PluginDialogs";
import { usePluginsPage } from "../features/plugins/usePluginsPage";
import { useOmpMarketplace } from "../features/plugins/useOmpMarketplace";

export function PluginsPage() {
  const page = usePluginsPage();
  const market = useOmpMarketplace();
  const {
    t,
    locale,
    tab,
    setTab,
    headerMenu,
    setHeaderMenu,
    overflowActions,
    stats,
    plugins,
    installedQuery,
    filteredInstalled,
    setInstalledQuery,
  } = page;
  const sourceCount = market.state?.sources.length ?? 0;

  return (
    <div className="thread-scroll">
      <div className="page-frame plugins-page">
        <div className="page-header plugins-page-header">
          <div className="plugins-title-block">
            <span className="plugins-title-icon" aria-hidden>
              <IconPlug size={14} />
            </span>
            <div className="plugins-title-copy">
              <h1 className="page-title">{t("plugins.title")}</h1>
            </div>
          </div>
          <div className="plugins-header-actions">
            {tab === "market" ? (
              <Button
                variant="primary"
                size="sm"
                disabled={sourceCount === 0 || market.busy !== null || !market.state?.available}
                onClick={() => market.updateSources()}
              >
                <IconRefresh size={14} />
                {market.busy?.action === "updateSources"
                  ? t("plugins.ompMarket.updatingSources")
                  : t("plugins.ompMarket.updateSources")}
              </Button>
            ) : tab === "installed" ? (
              <Button variant="primary" size="sm" onClick={() => setTab("market")}>
                <IconDownload size={14} />
                {t("plugins.browseMarket")}
              </Button>
            ) : null}
            <AnchoredMenu
              className="plugins-menu-wrap"
              open={headerMenu}
              onClose={() => setHeaderMenu(false)}
              menuClassName="plugins-menu is-end"
              label={t("plugins.moreActions")}
              role="menu"
              align="end"
              trigger={(ref) => (
                <TooltipButton
                  ref={ref}
                  type="button"
                  className="plugins-icon-btn plugins-header-menu"
                  ariaLabel={t("plugins.moreActions")}
                  tooltip={t("plugins.moreActions")}
                  aria-haspopup="menu"
                  aria-expanded={headerMenu}
                  onClick={() => setHeaderMenu((open) => !open)}
                >
                  <IconMore size={16} />
                </TooltipButton>
              )}
            >
                  {overflowActions.map((action) => (
                    <button
                      key={action.key}
                      type="button"
                      role="menuitem"
                      data-action={action.key}
                      onClick={() => {
                        setHeaderMenu(false);
                        void action.run();
                      }}
                    >
                      {t(`plugins.${action.key}`)}
                    </button>
                  ))}
            </AnchoredMenu>
          </div>
        </div>

        <div className="plugins-toolbar">
          <div className="plugins-segment" role="tablist" aria-label={t("plugins.title")}>
            <button
              type="button"
              role="tab"
              id="plugins-tab-installed"
              aria-selected={tab === "installed"}
              aria-controls="plugins-panel-installed"
              className={cx("plugins-segment-btn", tab === "installed" && "active")}
              onClick={() => setTab("installed")}
            >
              {t("plugins.tabInstalled")}
              <span className="plugins-segment-count">{stats.total}</span>
            </button>
            <button
              type="button"
              role="tab"
              id="plugins-tab-market"
              aria-selected={tab === "market"}
              aria-controls="plugins-panel-market"
              className={cx("plugins-segment-btn", tab === "market" && "active")}
              onClick={() => setTab("market")}
            >
              {t("plugins.tabMarket")}
              {market.items.length ? (
                <span className="plugins-segment-count">{market.items.length}</span>
              ) : null}
            </button>
          </div>
          {tab === "installed" ? (
            plugins.length ? (
              <div className="plugins-toolbar-end">
                {installedQuery.trim() ? (
                  <span className="plugins-result-count" aria-live="polite">
                    {t("plugins.resultCount", {
                      count: filteredInstalled.length,
                      total: plugins.length,
                    })}
                  </span>
                ) : null}
                <SearchField
                  value={installedQuery}
                  onChange={setInstalledQuery}
                  placeholder={t("plugins.searchInstalled")}
                />
              </div>
            ) : null
          ) : (
            <div className="plugins-toolbar-end">
              {market.busy ? (
                <span className="plugins-result-count" aria-live="polite">
                  {t("plugins.ompMarket.working")}
                </span>
              ) : null}
              <SearchField
                value={market.query}
                onChange={market.setQuery}
                placeholder={t("plugins.marketSearchPlaceholder")}
              />
            </div>
          )}
        </div>
        {tab === "installed" ? (
          <InstalledPluginsPanel {...page} />
        ) : (
          <OmpMarketplacePanel market={market} t={t} />
        )}
      </div>

      {tab === "market" ? <OmpPluginDetailSheet market={market} t={t} locale={locale} /> : null}
      <PluginDialogs {...page} />
    </div>
  );
}
