import { ExternalLink } from "lucide-react";
import { NavigationMenu } from "./NavigationMenu";
import { useEffect, useState } from "react";
import {
  deleteBaseloadConfig,
  fetchBaseloadState,
  fetchBaseloadConfigs,
  fetchHealth,
  loadBaseloadConfig,
  saveBaseloadConfig,
  updateBaseloadConfig as putBaseloadConfig,
  type BaseloadStateResponse,
  type BaseloadTaskStatus,
  type BaseloadWorkerBalance,
  type StoredBaseloadConfigSummary,
} from "./api";
import { AccountControls } from "./AccountControls";
import { useAuth } from "./useAuth";
import { AdminView } from "./AdminView";
import {
  adminModeActive,
  adminModeStatus,
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
import { StatisticsView } from "./StatisticsView";
import { readStoredString, writeStoredString } from "./localStorage";
import { requiresAdminView, visibleNavItems } from "./navigation";
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
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { OmniSearch } from "./OmniSearch";
import { SearchView } from "./SearchView";
import { fetchSourceKind, uiMode } from "./simulatorApi";
import { SimulatorView } from "./SimulatorView";
import { DebugView } from "./DebugView";
import { NodeDebugView } from "./NodeDebugView";

const TIME_ZONE_STORAGE_KEY = "timeZone";
const ADMIN_MODE_ENABLED_STORAGE_KEY = "admin.modeEnabled";
const SIMULATE_OFFLINE_STORAGE_KEY = "home.simulateOffline";
const FULL_WIDTH_STORAGE_KEY = "ui.fullWidth";
const THEME_OVERRIDE_STORAGE_KEY = "ui.theme";

type ThemeOverride = "light" | "dark" | "";

export function App() {
  // Node applications connect straight to their Rust process. Keep this outside
  // SourceApp so no explorer health/auth/database requests run in these modes.
  const mode = uiMode();
  if (mode === "fullnode" || mode === "lightnode") return <NodeDebugView mode={mode}/>;
  return <SourceApp/>;
}

function SourceApp() {
  const [source, setSource] = useState<"ethereum" | "native-simulator" | null>(null);
  const [failure, setFailure] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setFailure("");
    void fetchSourceKind(controller.signal).then(setSource).catch((error) => {
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : "Source unavailable");
    });
    return () => controller.abort();
  }, [attempt]);
  // One frontend image serves both native views; the container's runtime
  // configuration selects the debug console or the explorer.
  if (source === "native-simulator") return uiMode() === "debug" ? <DebugView/> : <SimulatorView/>;
  if (source === "ethereum") return <EthereumApp/>;
  return <main className="sim-shell"><h1>Arkiv explorer</h1><p role="status">{failure || "Reading source capabilities…"}</p>{failure && <button onClick={() => setAttempt((n) => n + 1)}>Retry connection</button>}</main>;
}

function EthereumApp() {
  const auth = useAuth();
  const [clientLocation, setClientLocation] = useState(getCurrentLocation);
  const [transactionDataEnabled, setTransactionDataEnabled] = useState<boolean | null>(null);
  const [baseloadConfig, setBaseloadConfig] = useState<BaseloadConfig>(EMPTY_BASELOAD_CONFIG);
  const [baseloadTaskStatuses, setBaseloadTaskStatuses] = useState<Record<string, BaseloadTaskStatus>>({});
  const [baseloadBalances, setBaseloadBalances] = useState<Record<string, BaseloadWorkerBalance>>({});
  const [baseloadError, setBaseloadError] = useState<string | null>(null);
  const [baseloadSavedConfigs, setBaseloadSavedConfigs] = useState<StoredBaseloadConfigSummary[]>([]);
  const [baseloadConfigManagerError, setBaseloadConfigManagerError] = useState<string | null>(null);
  const [pageSettings, setPageSettings] = useState<PageSettings>(() =>
    readStoredPageSettings(BUILD_PAGE_SETTINGS),
  );
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
  const requestedView =
    transactionDataEnabled === false &&
    (view === "block" ||
      view === "transactions" ||
      view === "transaction" ||
      view === "entity" ||
      view === "address" ||
      view === "senders")
      ? "blocks"
      : view;
  const adminVerified = auth.session.role === "admin";
  const adminMode = adminModeStatus(adminVerified, adminModeEnabled);
  const adminModeIsActive = adminModeActive(adminVerified, adminModeEnabled);
  const activeView = requiresAdminView(requestedView) && !adminModeIsActive ? "home" : requestedView;
  const chartFullscreen = activeView === "chart-fullscreen";
  const csrfToken = adminModeIsActive ? auth.session.csrfToken ?? undefined : undefined;
  const navItems = visibleNavItems(adminModeIsActive, transactionDataEnabled);

  useEffect(() => {
    const network = pageSettings.networkName ? ` · ${pageSettings.networkName}` : "";
    const screen = activeView === "data" ? "Data (experimental, use with caution) · " : "";
    document.title = `${screen}${pageSettings.chainName} BlockExplorer${network}`;
  }, [activeView, pageSettings.chainName, pageSettings.networkName]);

  useEffect(() => {
    const onPopState = () => setClientLocation(getCurrentLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    fetchHealth()
      .then((body) => setTransactionDataEnabled(body.features.transactionData))
      .catch(() => setTransactionDataEnabled(true));
  }, []);

  useEffect(() => {
    // The locked UI has nothing to show: /baseload exposes worker wallets and
    // balances, so only poll it in admin mode.
    if (activeView !== "baseload" || !adminModeIsActive) return;

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
  }, [activeView, adminModeIsActive]);

  useEffect(() => {
    if (activeView !== "baseload" || !adminModeIsActive) {
      // Leaving admin mode drops the privileged list rather than keeping
      // Save and Delete on screen for a token that is no longer sent.
      setBaseloadSavedConfigs([]);
      return;
    }

    let cancelled = false;

    const refresh = async () => {
      try {
        const body = await fetchBaseloadConfigs();
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
  }, [activeView, adminModeIsActive]);

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
  };

  const onTimeZoneChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setTimeZone(event.target.value);
  };

  useEffect(() => {
    writeStoredString(TIME_ZONE_STORAGE_KEY, timeZone);
  }, [timeZone]);

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

  // Mirror the effective theme as a `.dark` class on <html>. The design
  // system (globals.css, Tailwind `dark:` variant) keys off the class; the
  // saved theme preference and the OS media query stay in sync.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const media =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : undefined;
    const apply = () => {
      const dark =
        themeOverride === "dark" || (themeOverride === "" && (media?.matches ?? false));
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    media?.addEventListener("change", apply);
    return () => media?.removeEventListener("change", apply);
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
    if (typeof window === "undefined" || !simulateOffline || !adminModeIsActive) return;
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
  }, [simulateOffline, adminModeIsActive]);

  useEffect(() => {
    if (adminModeIsActive) return;
    setSimulateOffline(false);
    setBaseloadConfig(EMPTY_BASELOAD_CONFIG);
    setBaseloadTaskStatuses({});
    setBaseloadBalances({});
    setBaseloadSavedConfigs([]);
    setBaseloadError(null);
    setBaseloadConfigManagerError(null);
  }, [adminModeIsActive]);

  useEffect(() => {
    if (!auth.loading && !adminVerified && requiresAdminView(view)) {
      if (writePermalink("home", {})) setClientLocation(getCurrentLocation());
    }
  }, [auth.loading, adminVerified, view]);

  const updateBaseloadConfig = async (config: BaseloadConfig) => {
    try {
      applyBaseloadState(await putBaseloadConfig(config, csrfToken));
    } catch (error) {
      setBaseloadError(error instanceof Error ? error.message : String(error));
    }
  };

  const applyBaseloadState = (state: BaseloadStateResponse) => {
    setBaseloadConfig(state.config);
    setBaseloadTaskStatuses(state.statuses);
    setBaseloadBalances(state.balances ?? {});
    setBaseloadError(state.enabled ? null : "BASELOAD_RPC_NODE is not configured on the backend");
  };

  const refreshBaseloadSavedConfigs = async () => {
    const body = await fetchBaseloadConfigs();
    setBaseloadSavedConfigs(body.configs);
    setBaseloadConfigManagerError(null);
  };

  const saveCurrentBaseloadConfig = async (name: string) => {
    try {
      await saveBaseloadConfig(name, baseloadConfig, csrfToken);
      await refreshBaseloadSavedConfigs();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBaseloadConfigManagerError(message);
      throw new Error(message);
    }
  };

  const loadSavedBaseloadConfig = async (name: string) => {
    try {
      applyBaseloadState(await loadBaseloadConfig(name, csrfToken));
      await refreshBaseloadSavedConfigs();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBaseloadConfigManagerError(message);
      throw new Error(message);
    }
  };

  const deleteSavedBaseloadConfig = async (name: string) => {
    try {
      await deleteBaseloadConfig(name, csrfToken);
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

  const isChartsMain = activeView === "charts";
  const navigateSearch = (href: string) => {
    window.history.pushState({}, "", href);
    refreshFromLocation();
  };

  if (chartFullscreen) {
    return (
      <main className="flex h-screen w-screen min-h-screen p-0">
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

  const showChainLabel = pageSettings.chainName && pageSettings.chainName !== "Arkiv";

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-50 border-b border-border bg-card/95 px-3 py-2 backdrop-blur md:px-6 md:py-3">
        <div className={cn("mx-auto flex flex-wrap items-center gap-2", !fullWidth && "max-w-415")}>
          <button
            type="button"
            onClick={() => setView("home")}
            className="inline-flex items-center gap-2 font-heading text-lg font-black tracking-tight transition-colors hover:text-muted-foreground"
          >
            [ ARKIV ] BlockExplorer
          </button>
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-primary uppercase">
            beta
          </span>
          {showChainLabel ? (
            <span className="rounded-md border border-border px-2 py-0.5 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
              {pageSettings.chainName}
            </span>
          ) : null}

          {pageSettings.networkName ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1 text-xs font-medium"
              title="Network"
            >
              <span className="size-1.5 rounded-full bg-emerald-500" />
              {pageSettings.networkName}
            </span>
          ) : null}

          {activeView !== "search" ? <div className="header-search min-w-0 flex-1 basis-56"><OmniSearch onNavigate={navigateSearch} /></div> : null}

          <div className="flex flex-wrap items-center gap-2">
            <AccountControls auth={auth} />
            {adminMode !== "hidden" ? (
              <Badge
                variant={adminMode === "enabled" ? "default" : "outline"}
                render={<button type="button" />}
                aria-pressed={adminMode === "enabled"}
                onClick={() => setAdminModeEnabled((value) => !value)}
                title={adminMode === "enabled" ? "Disable admin mode" : "Enable admin mode"}
                className="cursor-pointer tracking-wide uppercase"
              >
                Admin {adminMode}
              </Badge>
            ) : null}

            <a
              href="https://github.com/Arkiv-Network/reported-issues/issues/new/choose"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              title="Submit feedback or report a bug"
              data-umami-event="outbound-link-click"
              data-umami-event-url="https://github.com/Arkiv-Network/reported-issues/issues/new/choose"
            >
              Feedback
              <ExternalLink className="size-3" />
            </a>

            <NavigationMenu
              activeView={activeView}
              navItems={navItems}
              onNavigate={setView}
              fullWidth={fullWidth}
              onToggleFullWidth={toggleFullWidth}
              darkModeActive={darkModeActive}
              onToggleDarkMode={toggleDarkMode}
              timeZone={timeZone}
              onTimeZoneChange={onTimeZoneChange}
            />
          </div>
        </div>
      </header>
      <SyncStatusBanner
        timeZone={timeZone}
        minLagSeconds={pageSettings.scannerDelayWarningAgeMs / 1000}
      />
      <main
        className={cn(
          "relative z-[1] flex-1 min-h-0",
          isChartsMain ? "flex p-0" : "mx-auto w-full p-4 md:px-6 md:pb-6",
          !isChartsMain && !fullWidth && "max-w-415",
        )}
      >
        {activeView === "search" ? (
          <SearchView locationSearch={locationSearch} onNavigate={navigateSearch} onLocationChange={refreshFromLocation} />
        ) : activeView === "statistics" ? (
          <StatisticsView timeZone={timeZone} />
        ) : activeView === "home" ? (
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
          <DataView
            key={`${auth.session.user?.id ?? "anonymous"}:${adminModeIsActive}`}
            locationSearch={locationSearch}
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
            adminModeActive={adminModeIsActive}
            csrfToken={csrfToken}
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
          />
        )}
      </main>
      <footer className="border-t border-border bg-card">
        <div className={cn("mx-auto flex items-center justify-end gap-4 px-3 py-2 md:px-6", !fullWidth && "max-w-415")}>
          <a
            href="/llms.txt"
            className="text-xs text-muted-foreground opacity-60 transition-opacity hover:opacity-100 hover:underline"
          >
            llms.txt
          </a>
        </div>
      </footer>
    </div>
  );
}
