import { useEffect, useRef, useState } from "react";
import {
  deleteBaseloadConfig,
  fetchBaseloadState,
  fetchBaseloadConfigs,
  fetchHealth,
  loadBaseloadConfig,
  saveBaseloadConfig,
  updateBaseloadConfig as putBaseloadConfig,
  verifyAdminToken,
  type BaseloadStateResponse,
  type BaseloadTaskStatus,
  type BaseloadWorkerBalance,
  type StoredBaseloadConfigSummary,
} from "./api";
import { AdminView } from "./AdminView";
import {
  adminModeActive,
  adminModeStatus,
  isVerifiedAdminToken,
  privilegedAdminToken,
} from "./adminMode";
import { BaseloadView } from "./BaseloadView";
import { EMPTY_BASELOAD_CONFIG, type BaseloadConfig } from "./baseloadConfig";
import { BlockView } from "./BlockView";
import { BlocksView } from "./BlocksView";
import { DataView } from "./DataView";
import { EntityView } from "./EntityView";
import { ChartsView } from "./ChartsView";
import { CedricView } from "./CedricView";
import { GuzzlersView } from "./GuzzlersView";
import { HealthView } from "./HealthView";
import { SyncStatusBanner } from "./SyncStatusBanner";
import { HomeView } from "./HomeView";
import { readStoredString, writeStoredString } from "./localStorage";
import { navLabelForView, visibleNavItems } from "./navigation";
import {
  BUILD_PAGE_SETTINGS,
  readStoredPageSettings,
  removeStoredPageSettings,
  type PageSettings,
  writeStoredPageSettings,
} from "./pageSettings";
import {
  getCurrentLocation,
  readAddressFromLocation,
  readEntityKeyFromLocation,
  readTransactionHashFromLocation,
  readViewFromLocation,
  writePermalink,
} from "./permalinks";
import { RangesView } from "./RangesView";
import { RecordTransactionsView } from "./RecordTransactionsView";
import { SendersView } from "./SendersView";
import { detectBrowserTimeZone, TIME_ZONE_OPTIONS } from "./timezones";
import { TransactionsView } from "./TransactionsView";
import { TransactionView } from "./TransactionView";

const TIME_ZONE_STORAGE_KEY = "timeZone";
const BASELOAD_ADMIN_TOKEN_STORAGE_KEY = "baseload.adminBearerToken";
const ADMIN_MODE_ENABLED_STORAGE_KEY = "admin.modeEnabled";
const SIMULATE_OFFLINE_STORAGE_KEY = "home.simulateOffline";
const FULL_WIDTH_STORAGE_KEY = "ui.fullWidth";
const THEME_OVERRIDE_STORAGE_KEY = "ui.theme";

type ThemeOverride = "light" | "dark" | "";

export function App() {
  const [clientLocation, setClientLocation] = useState(getCurrentLocation);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [transactionDataEnabled, setTransactionDataEnabled] = useState<boolean | null>(null);
  const [baseloadConfig, setBaseloadConfig] = useState<BaseloadConfig>(EMPTY_BASELOAD_CONFIG);
  const [baseloadTaskStatuses, setBaseloadTaskStatuses] = useState<Record<string, BaseloadTaskStatus>>({});
  const [baseloadBalances, setBaseloadBalances] = useState<Record<string, BaseloadWorkerBalance>>({});
  const [baseloadError, setBaseloadError] = useState<string | null>(null);
  const [baseloadSavedConfigs, setBaseloadSavedConfigs] = useState<StoredBaseloadConfigSummary[]>([]);
  const [baseloadConfigManagerError, setBaseloadConfigManagerError] = useState<string | null>(null);
  const [baseloadAdminToken, setBaseloadAdminToken] = useState(() =>
    readStoredString(BASELOAD_ADMIN_TOKEN_STORAGE_KEY, ""),
  );
  const [pageSettings, setPageSettings] = useState<PageSettings>(() =>
    readStoredPageSettings(BUILD_PAGE_SETTINGS),
  );
  const [verifiedAdminToken, setVerifiedAdminToken] = useState("");
  const [adminModeEnabled, setAdminModeEnabled] = useState(
    () => readStoredString(ADMIN_MODE_ENABLED_STORAGE_KEY, "true") === "true",
  );
  const [simulateOffline, setSimulateOffline] = useState(
    () => readStoredString(SIMULATE_OFFLINE_STORAGE_KEY, "false") === "true",
  );
  const [fullWidth, setFullWidth] = useState(
    () => readStoredString(FULL_WIDTH_STORAGE_KEY, "false") === "true",
  );
  const [themeOverride, setThemeOverride] = useState<ThemeOverride>(() =>
    readStoredString(
      THEME_OVERRIDE_STORAGE_KEY,
      "",
      (value) => value === "" || value === "light" || value === "dark",
    ) as ThemeOverride,
  );
  const [timeZone, setTimeZone] = useState<string>(() =>
    readStoredString(
      TIME_ZONE_STORAGE_KEY,
      detectBrowserTimeZone(),
      (value) => TIME_ZONE_OPTIONS.some((option) => option.value === value),
    ),
  );
  const locationSearch = clientLocation.search;
  const view = readViewFromLocation(clientLocation);
  const transactionHash = readTransactionHashFromLocation(clientLocation);
  const entityKeyParam = readEntityKeyFromLocation(clientLocation);
  const addressParam = readAddressFromLocation(clientLocation);
  // Fall back to the blocks view only once /api/health has *confirmed* that
  // transaction data is disabled. While the probe is still in flight
  // (transactionDataEnabled === null) keep the requested view mounted —
  // otherwise a direct load of /tx/… or /entity/… first flashes the blocks
  // view (and fires its /api/blocks fetch) before swapping to the real page.
  const activeView =
    transactionDataEnabled === false &&
    (view === "block" ||
      view === "transactions" ||
      view === "transaction" ||
      view === "entity" ||
      view === "address" ||
      view === "senders")
      ? "blocks"
      : view;
  const chartFullscreen = activeView === "chart-fullscreen";
  const trimmedAdminToken = baseloadAdminToken.trim();
  const adminVerified = isVerifiedAdminToken(trimmedAdminToken, verifiedAdminToken);
  const adminMode = adminModeStatus(adminVerified, adminModeEnabled);
  const adminModeIsActive = adminModeActive(adminVerified, adminModeEnabled);
  const navItems = visibleNavItems(adminModeIsActive, transactionDataEnabled);
  const activeNavLabel =
    navItems.find((item) => item.view === activeView)?.label ?? navLabelForView(activeView) ?? "Menu";

  useEffect(() => {
    const network = pageSettings.networkName ? ` · ${pageSettings.networkName}` : "";
    document.title = `${pageSettings.chainName} BlockExplorer${network}`;
  }, [pageSettings.chainName, pageSettings.networkName]);

  useEffect(() => {
    const onPopState = () => setClientLocation(getCurrentLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    fetchHealth()
      .then((body) => setTransactionDataEnabled(body.features.transactionData))
      .catch(() => setTransactionDataEnabled(true));
  }, []);

  useEffect(() => {
    if (activeView !== "baseload") return;

    let cancelled = false;

    const refresh = async () => {
      try {
        const state = await fetchBaseloadState();
        if (cancelled) return;
        applyBaseloadState(state);
      } catch (error) {
        if (!cancelled) {
          setBaseloadError(error instanceof Error ? error.message : String(error));
        }
      }
    };

    void refresh();
    const interval = window.setInterval(refresh, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeView]);

  useEffect(() => {
    if (activeView !== "baseload") return;

    let cancelled = false;

    const refresh = async () => {
      try {
        const body = await fetchBaseloadConfigs(adminBearerToken());
        if (cancelled) return;
        setBaseloadSavedConfigs(body.configs);
        setBaseloadConfigManagerError(null);
      } catch (error) {
        if (!cancelled) {
          setBaseloadSavedConfigs([]);
          setBaseloadConfigManagerError(error instanceof Error ? error.message : String(error));
        }
      }
    };

    void refresh();
    return () => {
      cancelled = true;
    };
  }, [activeView, baseloadAdminToken, adminModeIsActive]);

  useEffect(() => {
    if (
      transactionDataEnabled === false &&
      (view === "block" ||
        view === "transactions" ||
        view === "transaction" ||
        view === "entity" ||
        view === "address" ||
        view === "senders") &&
      writePermalink("blocks", {})
    ) {
      setClientLocation(getCurrentLocation());
    }
  }, [transactionDataEnabled, view]);

  const refreshFromLocation = () => setClientLocation(getCurrentLocation());

  const setView = (nextView: typeof view) => {
    if (writePermalink(nextView, {})) {
      refreshFromLocation();
    }
    setMenuOpen(false);
  };

  const onTimeZoneChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setTimeZone(event.target.value);
  };

  useEffect(() => {
    writeStoredString(TIME_ZONE_STORAGE_KEY, timeZone);
  }, [timeZone]);

  useEffect(() => {
    writeStoredString(BASELOAD_ADMIN_TOKEN_STORAGE_KEY, baseloadAdminToken);
  }, [baseloadAdminToken]);

  useEffect(() => {
    writeStoredString(ADMIN_MODE_ENABLED_STORAGE_KEY, String(adminModeEnabled));
  }, [adminModeEnabled]);

  useEffect(() => {
    writeStoredString(SIMULATE_OFFLINE_STORAGE_KEY, String(simulateOffline));
  }, [simulateOffline]);

  useEffect(() => {
    writeStoredString(FULL_WIDTH_STORAGE_KEY, String(fullWidth));
    if (typeof document === "undefined") return;
    if (fullWidth) {
      document.documentElement.setAttribute("data-ui-width", "full");
    } else {
      document.documentElement.removeAttribute("data-ui-width");
    }
  }, [fullWidth]);

  useEffect(() => {
    writeStoredString(THEME_OVERRIDE_STORAGE_KEY, themeOverride);
    if (typeof document === "undefined") return;
    if (themeOverride === "light" || themeOverride === "dark") {
      document.documentElement.setAttribute("data-theme", themeOverride);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }, [themeOverride]);

  const toggleFullWidth = () => setFullWidth((value) => !value);
  const toggleDarkMode = () => {
    setThemeOverride((current) => {
      if (current === "dark") return "light";
      if (current === "light") return "dark";
      const prefersDark =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches;
      return prefersDark ? "light" : "dark";
    });
  };

  const darkModeActive =
    themeOverride === "dark" ||
    (themeOverride === "" &&
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  // Debug only: when the simulate-offline toggle (in the Admin panel) is on,
  // fail all /api/blocks requests at the fetch boundary so the UI shows the
  // offline state. Lives here in App so the patch survives navigating between
  // views. The rest of the app just sees a real connection failure.
  useEffect(() => {
    if (typeof window === "undefined" || !simulateOffline) return;
    const originalFetch = window.fetch;
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input instanceof Request
              ? input.url
              : String(input);
      if (url.includes("/api/blocks")) {
        throw new Error("Simulated offline (debug)");
      }
      return originalFetch(input, init);
    }) as typeof window.fetch;
    return () => {
      window.fetch = originalFetch;
    };
  }, [simulateOffline]);

  useEffect(() => {
    if (!trimmedAdminToken) {
      setVerifiedAdminToken("");
      return;
    }
    let cancelled = false;
    verifyAdminToken(trimmedAdminToken)
      .then(() => {
        if (!cancelled) setVerifiedAdminToken(trimmedAdminToken);
      })
      .catch(() => {
        if (!cancelled) setVerifiedAdminToken("");
      });
    return () => {
      cancelled = true;
    };
  }, [trimmedAdminToken]);

  const onAdminLoginClick = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const input = window.prompt(
      "Enter admin credentials (leave blank to clear):",
      baseloadAdminToken,
    );
    if (input === null) return;
    const trimmed = input.trim();
    if (!trimmed) {
      setBaseloadAdminToken("");
      setVerifiedAdminToken("");
      setAdminModeEnabled(false);
      return;
    }
    try {
      await verifyAdminToken(trimmed);
      setBaseloadAdminToken(trimmed);
      setVerifiedAdminToken(trimmed);
      setAdminModeEnabled(true);
    } catch (error) {
      setVerifiedAdminToken("");
      window.alert(
        `Admin credentials rejected: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const updateBaseloadConfig = async (config: BaseloadConfig) => {
    try {
      applyBaseloadState(await putBaseloadConfig(config, adminBearerToken()));
    } catch (error) {
      setBaseloadError(error instanceof Error ? error.message : String(error));
    }
  };

  const adminBearerToken = () =>
    privilegedAdminToken(baseloadAdminToken, adminVerified, adminModeEnabled);

  const applyBaseloadState = (state: BaseloadStateResponse) => {
    setBaseloadConfig(state.config);
    setBaseloadTaskStatuses(state.statuses);
    setBaseloadBalances(state.balances ?? {});
    setBaseloadError(state.enabled ? null : "BASELOAD_RPC_NODE is not configured on the backend");
  };

  const refreshBaseloadSavedConfigs = async () => {
    const body = await fetchBaseloadConfigs(adminBearerToken());
    setBaseloadSavedConfigs(body.configs);
    setBaseloadConfigManagerError(null);
  };

  const saveCurrentBaseloadConfig = async (name: string) => {
    try {
      await saveBaseloadConfig(name, baseloadConfig, adminBearerToken());
      await refreshBaseloadSavedConfigs();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBaseloadConfigManagerError(message);
      throw new Error(message);
    }
  };

  const loadSavedBaseloadConfig = async (name: string) => {
    try {
      applyBaseloadState(await loadBaseloadConfig(name, adminBearerToken()));
      await refreshBaseloadSavedConfigs();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBaseloadConfigManagerError(message);
      throw new Error(message);
    }
  };

  const deleteSavedBaseloadConfig = async (name: string) => {
    try {
      await deleteBaseloadConfig(name, adminBearerToken());
      await refreshBaseloadSavedConfigs();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBaseloadConfigManagerError(message);
      throw new Error(message);
    }
  };

  const resetPageSettings = () => {
    removeStoredPageSettings();
    setPageSettings(BUILD_PAGE_SETTINGS);
  };

  const savePageSettings = (settings: PageSettings) => {
    writeStoredPageSettings(settings);
    setPageSettings(settings);
  };

  const mainClassName = activeView === "charts" ? "fullscreen" : "contained";

  if (chartFullscreen) {
    return (
      <main className="fullscreen chart-fullscreen-main">
        <ChartsView
          locationSearch={locationSearch}
          onLocationChange={refreshFromLocation}
          timeZone={timeZone}
          transactionDataEnabled={transactionDataEnabled === true}
          tokenSymbol={pageSettings.tokenSymbol}
          noBatcher={pageSettings.noBatcher}
          presentationMode="fullscreen"
        />
      </main>
    );
  }

  return (
    <>
      <header>
        <div className="header-inner">
          <h1>
            <span className="brand-name">{pageSettings.chainName}</span>
            <span className="brand-sub">BlockExplorer</span>
            {pageSettings.networkName ? (
              <span className="brand-network" title="Network">
                {pageSettings.networkName}
              </span>
            ) : null}
          </h1>
          {adminMode !== "hidden" ? (
            <button
              type="button"
              className={`admin-mode-indicator${adminMode === "enabled" ? " active" : ""}`}
              aria-pressed={adminMode === "enabled"}
              onClick={() => setAdminModeEnabled((value) => !value)}
              title={
                adminMode === "enabled" ? "Disable admin mode" : "Enable admin mode"
              }
            >
              Admin mode {adminMode}
            </button>
          ) : null}
          <div className="header-menu" ref={menuRef}>
            <button
              type="button"
              className={`menu-button${menuOpen ? " active" : ""}`}
              onClick={() => setMenuOpen((value) => !value)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
              title="Navigation menu"
            >
              <span className="menu-button-icon" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span className="menu-button-label">{activeNavLabel}</span>
            </button>
            {menuOpen ? (
              <div className="menu-panel" role="menu">
                <div className="menu-section">
                  <div className="menu-section-title">Pages</div>
                  <nav className="menu-nav" aria-label="Primary navigation">
                    {navItems.map((item) => (
                      <button
                        key={item.view}
                        type="button"
                        role="menuitem"
                        className={activeView === item.view ? "active" : ""}
                        onClick={() => setView(item.view)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </nav>
                </div>
                <div className="menu-section">
                  <div className="menu-section-title">Display</div>
                  <div className="menu-control-row">
                    <span>Full width</span>
                    <button
                      type="button"
                      className={`ui-toggle${fullWidth ? " active" : ""}`}
                      onClick={toggleFullWidth}
                      aria-pressed={fullWidth}
                      title={fullWidth ? "Switch to constrained width" : "Switch to full-width view"}
                    >
                      {fullWidth ? "On" : "Off"}
                    </button>
                  </div>
                  <div className="menu-control-row">
                    <span>Theme</span>
                    <button
                      type="button"
                      className={`ui-toggle${darkModeActive ? " active" : ""}`}
                      onClick={toggleDarkMode}
                      aria-pressed={darkModeActive}
                      title={darkModeActive ? "Switch to light mode" : "Switch to dark mode"}
                    >
                      {darkModeActive ? "Dark" : "Light"}
                    </button>
                  </div>
                  <label className="timezone-select">
                    Time zone
                    <select value={timeZone} onChange={onTimeZoneChange}>
                      {TIME_ZONE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <SyncStatusBanner
        timeZone={timeZone}
        minLagSeconds={pageSettings.scannerDelayWarningAgeMs / 1000}
      />
      <main className={mainClassName}>
        {activeView === "home" ? (
          <HomeView
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
            settings={pageSettings}
            adminModeActive={adminModeIsActive}
          />
        ) : activeView === "blocks" ? (
          <BlocksView
            locationSearch={locationSearch}
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
            tokenSymbol={pageSettings.tokenSymbol}
            noBatcher={pageSettings.noBatcher}
          />
        ) : activeView === "block" ? (
          <BlockView
            locationSearch={locationSearch}
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
            tokenSymbol={pageSettings.tokenSymbol}
            noBatcher={pageSettings.noBatcher}
          />
        ) : activeView === "transactions" ? (
          <TransactionsView
            locationSearch={locationSearch}
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
            tokenSymbol={pageSettings.tokenSymbol}
          />
        ) : activeView === "transaction" ? (
          <TransactionView
            hash={transactionHash}
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
            tokenSymbol={pageSettings.tokenSymbol}
            blockTimeMs={pageSettings.blockTimeMs}
          />
        ) : activeView === "entity" ? (
          <EntityView
            entityKey={entityKeyParam}
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
            blockTimeMs={pageSettings.blockTimeMs}
          />
        ) : activeView === "address" ? (
          <TransactionsView
            locationSearch={locationSearch}
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
            tokenSymbol={pageSettings.tokenSymbol}
            lockedAddress={addressParam}
          />
        ) : activeView === "data" ? (
          <DataView locationSearch={locationSearch} onLocationChange={refreshFromLocation} timeZone={timeZone} />
        ) : activeView === "transaction-records" ? (
          <RecordTransactionsView
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
            tokenSymbol={pageSettings.tokenSymbol}
          />
        ) : activeView === "senders" ? (
          <SendersView
            locationSearch={locationSearch}
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
            tokenSymbol={pageSettings.tokenSymbol}
          />
        ) : activeView === "ranges" ? (
          <RangesView
            locationSearch={locationSearch}
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
            tokenSymbol={pageSettings.tokenSymbol}
          />
        ) : activeView === "charts" ? (
          <ChartsView
            locationSearch={locationSearch}
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
            transactionDataEnabled={transactionDataEnabled === true}
            tokenSymbol={pageSettings.tokenSymbol}
            noBatcher={pageSettings.noBatcher}
          />
        ) : activeView === "baseload" ? (
          <BaseloadView
            config={baseloadConfig}
            onConfigChange={updateBaseloadConfig}
            taskStatuses={baseloadTaskStatuses}
            balances={baseloadBalances}
            backendError={baseloadError}
            adminToken={baseloadAdminToken}
            onAdminTokenChange={setBaseloadAdminToken}
            savedConfigs={baseloadSavedConfigs}
            configManagerError={baseloadConfigManagerError}
            onRefreshSavedConfigs={refreshBaseloadSavedConfigs}
            onSaveCurrentConfig={saveCurrentBaseloadConfig}
            onLoadSavedConfig={loadSavedBaseloadConfig}
            onDeleteSavedConfig={deleteSavedBaseloadConfig}
            tokenSymbol={pageSettings.tokenSymbol}
          />
        ) : activeView === "guzzlers" ? (
          <GuzzlersView
            locationSearch={locationSearch}
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
            tokenSymbol={pageSettings.tokenSymbol}
          />
        ) : activeView === "cedric" ? (
          <CedricView />
        ) : activeView === "admin" ? (
          <AdminView
            settings={pageSettings}
            onSettingsChange={savePageSettings}
            onResetSettings={resetPageSettings}
            simulateOffline={simulateOffline}
            onToggleSimulateOffline={() => setSimulateOffline((value) => !value)}
          />
        ) : (
          <HealthView
            timeZone={timeZone}
            {...(adminBearerToken() ? { adminToken: adminBearerToken() as string } : {})}
          />
        )}
      </main>
      <footer>
        <div className="footer-inner">
          <a href="/llms.txt" className="footer-link">
            llms.txt
          </a>
          <a href="#" className="admin-login-link" onClick={onAdminLoginClick}>
            admin login
          </a>
        </div>
      </footer>
    </>
  );
}
