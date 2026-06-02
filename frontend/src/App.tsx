import { useEffect, useState } from "react";
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
import { BaseloadView } from "./BaseloadView";
import { EMPTY_BASELOAD_CONFIG, type BaseloadConfig } from "./baseloadConfig";
import { BlockView } from "./BlockView";
import { BlocksView } from "./BlocksView";
import { ChartsView } from "./ChartsView";
import { GuzzlersView } from "./GuzzlersView";
import { HealthView } from "./HealthView";
import { HomeView } from "./HomeView";
import { readStoredString, writeStoredString } from "./localStorage";
import {
  BUILD_PAGE_SETTINGS,
  readStoredPageSettings,
  removeStoredPageSettings,
  type PageSettings,
  writeStoredPageSettings,
} from "./pageSettings";
import { getCurrentSearch, readViewFromSearch, writePermalink } from "./permalinks";
import { RangesView } from "./RangesView";
import { RecordTransactionsView } from "./RecordTransactionsView";
import { SendersView } from "./SendersView";
import { detectBrowserTimeZone, TIME_ZONE_OPTIONS } from "./timezones";
import { TransactionsView } from "./TransactionsView";

const TIME_ZONE_STORAGE_KEY = "timeZone";
const BASELOAD_ADMIN_TOKEN_STORAGE_KEY = "baseload.adminBearerToken";
const SIMULATE_OFFLINE_STORAGE_KEY = "home.simulateOffline";
const FULL_WIDTH_STORAGE_KEY = "ui.fullWidth";
const THEME_OVERRIDE_STORAGE_KEY = "ui.theme";

type ThemeOverride = "light" | "dark" | "";

export function App() {
  const [locationSearch, setLocationSearch] = useState(getCurrentSearch);
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
  const [adminVerified, setAdminVerified] = useState(false);
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
  const view = readViewFromSearch(locationSearch);
  const activeView =
    transactionDataEnabled !== true && (view === "block" || view === "transactions" || view === "senders")
      ? "blocks"
      : view;

  useEffect(() => {
    const onPopState = () => setLocationSearch(getCurrentSearch());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

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
  }, [activeView, baseloadAdminToken]);

  useEffect(() => {
    if (
      transactionDataEnabled === false &&
      (view === "block" || view === "transactions" || view === "senders") &&
      writePermalink("blocks", {})
    ) {
      setLocationSearch(getCurrentSearch());
    }
  }, [transactionDataEnabled, view]);

  const refreshFromLocation = () => setLocationSearch(getCurrentSearch());

  const setView = (nextView: typeof view) => {
    if (writePermalink(nextView, {})) {
      refreshFromLocation();
    }
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
    const trimmed = baseloadAdminToken.trim();
    if (!trimmed) {
      setAdminVerified(false);
      return;
    }
    let cancelled = false;
    verifyAdminToken(trimmed)
      .then(() => {
        if (!cancelled) setAdminVerified(true);
      })
      .catch(() => {
        if (!cancelled) setAdminVerified(false);
      });
    return () => {
      cancelled = true;
    };
  }, [baseloadAdminToken]);

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
      setAdminVerified(false);
      return;
    }
    try {
      await verifyAdminToken(trimmed);
      setBaseloadAdminToken(trimmed);
      setAdminVerified(true);
    } catch (error) {
      setAdminVerified(false);
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

  const adminBearerToken = () => baseloadAdminToken.trim() || undefined;

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

  const mainClassName = activeView === "charts" ? "fullscreen" : activeView === "home" ? "contained" : undefined;

  return (
    <>
      <header>
        <div className="header-inner">
          <h1>
            <span className="brand-name">{pageSettings.chainName}</span>
            <span className="brand-sub">Scanner</span>
          </h1>
          <nav>
            <button
              type="button"
              className={activeView === "home" ? "active" : ""}
              onClick={() => setView("home")}
            >
              Home
            </button>
            <button
              type="button"
              className={activeView === "blocks" ? "active" : ""}
              onClick={() => setView("blocks")}
            >
              Blocks
            </button>
            {transactionDataEnabled === true ? (
              <>
                <button
                  type="button"
                  className={activeView === "block" ? "active" : ""}
                  onClick={() => setView("block")}
                >
                  Block
                </button>
                <button
                  type="button"
                  className={activeView === "transactions" ? "active" : ""}
                  onClick={() => setView("transactions")}
                >
                  Address
                </button>
                <button
                  type="button"
                  className={activeView === "senders" ? "active" : ""}
                  onClick={() => setView("senders")}
                >
                  Senders
                </button>
              </>
            ) : null}
            <button
              type="button"
              className={activeView === "transaction-records" ? "active" : ""}
              onClick={() => setView("transaction-records")}
            >
              Records
            </button>
            <button
              type="button"
              className={activeView === "ranges" ? "active" : ""}
              onClick={() => setView("ranges")}
            >
              Ranges
            </button>
            <button
              type="button"
              className={activeView === "charts" ? "active" : ""}
              onClick={() => setView("charts")}
            >
              Charts
            </button>
            <button
              type="button"
              className={activeView === "guzzlers" ? "active" : ""}
              onClick={() => setView("guzzlers")}
            >
              Activity
            </button>
            <button
              type="button"
              className={activeView === "health" ? "active" : ""}
              onClick={() => setView("health")}
            >
              Health
            </button>
            <button
              type="button"
              className={activeView === "admin" ? "active" : ""}
              onClick={() => setView("admin")}
            >
              Admin
            </button>
            <button
              type="button"
              className={activeView === "baseload" ? "active" : ""}
              onClick={() => setView("baseload")}
            >
              Baseload
            </button>
          </nav>
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
          <div className="ui-toggles">
            <button
              type="button"
              className={`ui-toggle${fullWidth ? " active" : ""}`}
              onClick={toggleFullWidth}
              aria-pressed={fullWidth}
              title={fullWidth ? "Switch to constrained width" : "Switch to full-width view"}
            >
              Full width
            </button>
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
          {adminVerified ? <span className="admin-mode-indicator">ADMIN MODE</span> : null}
        </div>
      </header>
      <main className={mainClassName}>
        {activeView === "home" ? (
          <HomeView
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
            settings={pageSettings}
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
        ) : activeView === "admin" ? (
          <AdminView
            settings={pageSettings}
            onSettingsChange={savePageSettings}
            onResetSettings={resetPageSettings}
            simulateOffline={simulateOffline}
            onToggleSimulateOffline={() => setSimulateOffline((value) => !value)}
          />
        ) : (
          <HealthView timeZone={timeZone} />
        )}
      </main>
      <footer>
        <div className="footer-inner">
          <a href="#" className="admin-login-link" onClick={onAdminLoginClick}>
            admin login
          </a>
        </div>
      </footer>
    </>
  );
}
