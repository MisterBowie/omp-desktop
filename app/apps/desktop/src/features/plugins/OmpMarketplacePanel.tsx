import type { TFunction } from "i18next";
import { Button, Input, TooltipButton, cx } from "../../components/ui";
import { IconCheck, IconInfo, IconPlus, IconRefresh, IconSearch, IconTrash, IconTriangleAlert } from "../../components/icons";
import { monogram } from "./model";
import { OMP_COMPONENT_LABEL_KEYS, ompExecutableKinds, type OmpMarketItem } from "./omp-market-model";
import type { OmpMarketplaceModel } from "./useOmpMarketplace";

/** The source a first-time user is offered: Anthropic's Claude Code plugin directory. */
export const SUGGESTED_OMP_SOURCE = "anthropics/claude-plugins-official";

function CardAction({ item, market, t }: { item: OmpMarketItem; market: OmpMarketplaceModel; t: TFunction }) {
  const { busy, state } = market;
  const disabled = busy !== null || !state?.available;
  const running = busy?.target === item.id;
  const installed = item.installed;
  if (installed?.updateVersion && !installed.broken) {
    return (
      <Button variant="primary" size="sm" disabled={disabled} onClick={() => market.upgrade(item)}>
        {running ? t("plugins.ompMarket.upgrading") : t("plugins.ompMarket.upgrade", { version: installed.updateVersion })}
      </Button>
    );
  }
  if (installed) {
    return (
      <span className={cx("plugins-installed-mark", !installed.enabled && "is-muted")}>
        <IconCheck size={13} />
        {installed.enabled ? t("plugins.ompMarket.installed") : t("plugins.ompMarket.disabledTag")}
      </span>
    );
  }
  if (!item.plugin?.installable) {
    return <span className="plugins-card-state">{t("plugins.ompMarket.unavailable")}</span>;
  }
  return (
    <Button variant="primary" size="sm" disabled={disabled} onClick={() => market.install(item)}>
      {running ? t("plugins.ompMarket.installing") : t("plugins.ompMarket.install")}
    </Button>
  );
}

function SourcesSection({ market, t }: { market: OmpMarketplaceModel; t: TFunction }) {
  const { state, busy, sourceInput, setSourceInput, addSource, removeSource, updateSources } = market;
  const sources = state?.sources ?? [];
  const disabled = busy !== null || !state?.available;
  return (
    <section className="plugins-omp-sources" aria-label={t("plugins.ompMarket.sourcesTitle")}>
      <div className="plugins-omp-sources-head">
        <h2 className="plugins-omp-sources-title">{t("plugins.ompMarket.sourcesTitle")}</h2>
        {sources.length === 0 ? <p className="plugins-omp-sources-hint">{t("plugins.ompMarket.sourcesEmpty")}</p> : null}
      </div>
      {sources.length > 0 ? (
        <ul className="plugins-omp-source-list">
          {sources.map((source) => (
            <li key={source.name} className="plugins-omp-source">
              <div className="plugins-omp-source-copy">
                <span className="plugins-omp-source-name">{source.name}</span>
                <span className="plugins-omp-source-meta">
                  <span className="plugins-row-id">{source.sourceUri}</span>
                  <span className="plugins-dot" aria-hidden>
                    ·
                  </span>
                  <span>{t("plugins.ompMarket.sourcePluginCount", { count: source.pluginCount })}</span>
                </span>
                {source.error ? (
                  <span className="plugins-omp-source-error">{t("plugins.ompMarket.sourceError", { error: source.error })}</span>
                ) : null}
              </div>
              <TooltipButton
                type="button"
                className="plugins-icon-btn"
                ariaLabel={t("plugins.ompMarket.updateSourceOf", { name: source.name })}
                tooltip={t("plugins.ompMarket.updateSourceOf", { name: source.name })}
                disabled={disabled}
                onClick={() => updateSources(source.name)}
              >
                <IconRefresh size={14} />
              </TooltipButton>
              <TooltipButton
                type="button"
                className="plugins-icon-btn"
                ariaLabel={t("plugins.ompMarket.removeSourceOf", { name: source.name })}
                tooltip={t("plugins.ompMarket.removeSourceOf", { name: source.name })}
                disabled={disabled}
                onClick={() => removeSource(source.name)}
              >
                <IconTrash size={14} />
              </TooltipButton>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="plugins-omp-source-form"
        onSubmit={(event) => {
          event.preventDefault();
          void addSource();
        }}
      >
        <Input
          value={sourceInput}
          placeholder={t("plugins.ompMarket.sourcePlaceholder")}
          aria-label={t("plugins.ompMarket.sourcePlaceholder")}
          disabled={disabled}
          onChange={(event) => setSourceInput(event.target.value)}
        />
        <Button type="submit" variant="secondary" size="sm" disabled={disabled || !sourceInput.trim()}>
          <IconPlus size={14} />
          {busy?.action === "addSource" ? t("plugins.ompMarket.adding") : t("plugins.ompMarket.addSource")}
        </Button>
      </form>
      {sources.length === 0 && !sourceInput ? (
        <button type="button" className="plugins-omp-suggest" disabled={disabled} onClick={() => setSourceInput(SUGGESTED_OMP_SOURCE)}>
          {t("plugins.ompMarket.suggestSource", { source: SUGGESTED_OMP_SOURCE })}
        </button>
      ) : null}
    </section>
  );
}

export function OmpMarketplacePanel({ market, t }: { market: OmpMarketplaceModel; t: TFunction }) {
  const { state, loading, visibleItems, items, categories, category, setCategory, marketplace, setMarketplace, installedOnly, setInstalledOnly, query, setQuery } =
    market;
  const sources = state?.sources ?? [];
  return (
    <div id="plugins-panel-market" role="tabpanel" aria-labelledby="plugins-tab-market" className="plugins-panel">
      {state && !state.available ? (
        <div className="plugins-omp-notice is-warning" role="alert">
          <IconTriangleAlert size={15} />
          <span>{t("plugins.ompMarket.runtimeUnavailable", { reason: state.unavailableReason ?? "" })}</span>
        </div>
      ) : null}

      <SourcesSection market={market} t={t} />

      <div className="plugins-omp-notice" role="note">
        <IconInfo size={15} />
        <span>{t("plugins.ompMarket.scopeNotice")}</span>
      </div>

      {items.length > 0 ? (
        <div className="plugins-filters" role="group" aria-label={t("plugins.categories")}>
          <button
            type="button"
            className={cx("plugins-filter", !installedOnly && "active")}
            aria-pressed={!installedOnly}
            onClick={() => setInstalledOnly(false)}
          >
            {t("plugins.ompMarket.filterAll")}
          </button>
          <button
            type="button"
            className={cx("plugins-filter", installedOnly && "active")}
            aria-pressed={installedOnly}
            onClick={() => setInstalledOnly(true)}
          >
            {t("plugins.ompMarket.filterInstalled", { count: state?.installed.length ?? 0 })}
          </button>
          {sources.length > 1
            ? sources.map((source) => (
                <button
                  key={`m:${source.name}`}
                  type="button"
                  className={cx("plugins-filter", marketplace === source.name && "active")}
                  aria-pressed={marketplace === source.name}
                  onClick={() => setMarketplace(marketplace === source.name ? "" : source.name)}
                >
                  {source.name}
                </button>
              ))
            : null}
          {categories.map((value) => (
            <button
              key={`c:${value}`}
              type="button"
              className={cx("plugins-filter", category === value && "active")}
              aria-pressed={category === value}
              onClick={() => setCategory(category === value ? "" : value)}
            >
              {value}
            </button>
          ))}
        </div>
      ) : null}

      {loading && !state ? (
        <div className="plugins-card-grid" aria-hidden>
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="plugins-card is-skeleton">
              <span className="plugins-skeleton-line is-short" />
              <span className="plugins-skeleton-line" />
              <span className="plugins-skeleton-line is-long" />
            </div>
          ))}
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="plugins-empty">
          <span className="plugins-empty-icon" aria-hidden>
            <IconSearch size={18} />
          </span>
          <p className="plugins-empty-title">
            {sources.length === 0 && items.length === 0 ? t("plugins.ompMarket.emptyNoSources") : t("plugins.marketEmpty")}
          </p>
          {query || category || marketplace || installedOnly ? (
            <div className="plugins-empty-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setQuery("");
                  setCategory("");
                  setMarketplace("");
                  setInstalledOnly(false);
                }}
              >
                {t("plugins.clearSearch")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="plugins-card-grid" role="list">
          {visibleItems.map((item) => {
            const executable = ompExecutableKinds(item);
            const version = item.installed?.version ?? item.plugin?.version;
            return (
              <article
                key={item.id}
                role="listitem"
                className={cx("plugins-card", market.selected?.id === item.id && "active")}
              >
                <button
                  type="button"
                  className="plugins-card-hit"
                  aria-label={t("plugins.viewDetailsOf", { name: item.name })}
                  onClick={() => market.openDetail(item.id)}
                >
                  <span className="plugins-card-head">
                    <span className="plugins-card-glyph" aria-hidden>
                      {monogram(item.name)}
                    </span>
                    <span className="plugins-card-ident">
                      <span className="plugins-card-title">
                        <span className="plugins-card-name">{item.name}</span>
                      </span>
                      <span className="plugins-card-meta">
                        <span className="plugins-card-author">{item.marketplace}</span>
                        {version ? (
                          <>
                            <span className="plugins-dot" aria-hidden>
                              ·
                            </span>
                            <span>v{version}</span>
                          </>
                        ) : null}
                        {item.plugin?.authorName ? (
                          <>
                            <span className="plugins-dot" aria-hidden>
                              ·
                            </span>
                            <span>{item.plugin.authorName}</span>
                          </>
                        ) : null}
                      </span>
                    </span>
                  </span>
                  <span className="plugins-card-desc">{item.plugin?.description ?? ""}</span>
                  {executable.length > 0 ? (
                    <span className="plugins-omp-executable">
                      {t("plugins.ompMarket.executableBadge", {
                        kinds: executable.map((kind) => t(OMP_COMPONENT_LABEL_KEYS[kind])).join(", "),
                      })}
                    </span>
                  ) : null}
                </button>
                <div className="plugins-card-foot">
                  <span className="plugins-card-state">
                    {item.installed?.broken
                      ? t("plugins.ompMarket.broken")
                      : item.installed
                        ? t("plugins.ompMarket.installedVersion", { version: item.installed.version })
                        : (item.plugin?.category ?? "")}
                  </span>
                  <CardAction item={item} market={market} t={t} />
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
