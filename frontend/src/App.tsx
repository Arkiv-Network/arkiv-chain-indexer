import {
  Activity,
  Boxes,
  Box,
  Database,
  ExternalLink,
  Gauge,
  HeartPulse,
  Home,
  Layers,
  LineChart,
  ListOrdered,
  type LucideIcon,
  Moon,
  Receipt,
  Settings2,
  Shield,
  Sun,
  Users,
  Wallet,
} from "lucide-react";
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
import { visibleNavItems } from "./navigation";
import {
  BUILD_PAGE_SETTINGS,
  readStoredPageSettings,
  removeStoredPageSettings,
  type PageSettings,
  writeStoredPageSettings,
} from "./pageSettings";
import {
  buildRouteHref,
  getCurrentLocation,
  readAddressFromLocation,
  readEntityKeyFromLocation,
  readTransactionHashFromLocation,
  readViewFromLocation,
  shouldHandleClientNavigation,
  type View,
  writePermalink,
} from "./permalinks";
import { RangesView } from "./RangesView";
import { RecordTransactionsView } from "./RecordTransactionsView";
import { SendersView } from "./SendersView";
import { detectBrowserTimeZone, TIME_ZONE_OPTIONS } from "./timezones";
import { TransactionsView } from "./TransactionsView";
import { TransactionView } from "./TransactionView";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

const TIME_ZONE_STORAGE_KEY = "timeZone";
const BASELOAD_ADMIN_TOKEN_STORAGE_KEY = "baseload.adminBearerToken";
const ADMIN_MODE_ENABLED_STORAGE_KEY = "admin.modeEnabled";
const SIMULATE_OFFLINE_STORAGE_KEY = "home.simulateOffline";
const FULL_WIDTH_STORAGE_KEY = "ui.fullWidth";
const THEME_OVERRIDE_STORAGE_KEY = "ui.theme";

type ThemeOverride = "light" | "dark" | "";

const NAV_ICONS: Partial<Record<View, LucideIcon>> = {
  home: Home,
  blocks: Boxes,
  block: Box,
  transactions: Wallet,
  entity: Layers,
  address: Wallet,
  data: Database,
  "transaction-records": Receipt,
  senders: Users,
  ranges: ListOrdered,
  charts: LineChart,
  guzzlers: Activity,
  health: HeartPulse,
  admin: Shield,
  baseload: Gauge,
};

// Compact "Display" menu: full width toggle + time zone select, tucked behind
// a Settings2 icon button in the header. Mirrors the manual dropdown pattern
// used by the explorer's chain selector (open state + backdrop-to-close),
// rather than pulling in a new popover primitive for one header control.
function DisplayMenu({
  fullWidth,
  onToggleFullWidth,
  timeZone,
  onTimeZoneChange,
}: {
  fullWidth: boolean;
  onToggleFullWidth: () => void;
  timeZone: string;
  onTimeZoneChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="true"
        title="Display settings"
        className={cn(
          "rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          open && "bg-accent text-foreground",
        )}
      >
        <Settings2 className="size-4" />
      </button>
      {open ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
            aria-label="Close display settings"
          />
          <div className="absolute top-full right-0 z-20 mt-1 w-64 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium">Full width</span>
              <Button
                type="button"
                variant={fullWidth ? "default" : "outline"}
                size="xs"
                onClick={onToggleFullWidth}
                aria-pressed={fullWidth}
              >
                {fullWidth ? "On" : "Off"}
              </Button>
            </div>
            <Separator className="my-3" />
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Time zone</span>
              <select
                value={timeZone}
                onChange={onTimeZoneChange}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground"
              >
                {TIME_ZONE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function App() {
  const [clientLocation, setClientLocation] = useState(getCurrentLocation);
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
  };

  const onNavClick = (targetView: View) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!shouldHandleClientNavigation(event)) return;
    event.preventDefault();
    setView(targetView);
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

  // Mirror the effective theme as a `.dark` class on <html>. The design
  // system (globals.css, Tailwind `dark:` variant) keys off the class; the
  // legacy stylesheet keys off `data-theme` and the OS media query.
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

  const isChartsMain = activeView === "charts";

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

          <nav aria-label="Primary navigation" className="flex flex-wrap items-center gap-1">
            {navItems.map((item) => {
              const Icon = NAV_ICONS[item.view] ?? Home;
              const active = activeView === item.view;
              return (
                <a
                  key={item.view}
                  href={buildRouteHref(item.view, {})}
                  aria-current={active ? "page" : undefined}
                  onClick={onNavClick(item.view)}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                    active
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <Icon className="size-3" />
                  {item.label}
                </a>
              );
            })}
          </nav>

          <div className="flex-1" />

          <div className="flex flex-wrap items-center gap-2">
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

            <DisplayMenu
              fullWidth={fullWidth}
              onToggleFullWidth={toggleFullWidth}
              timeZone={timeZone}
              onTimeZoneChange={onTimeZoneChange}
            />

            <button
              type="button"
              onClick={toggleDarkMode}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={darkModeActive ? "Switch to light mode" : "Switch to dark mode"}
            >
              {darkModeActive ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>
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
          isChartsMain ? "flex p-0" : "mx-auto w-full p-4 md:p-6",
          !isChartsMain && !fullWidth && "max-w-415",
        )}
      >
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
          <HealthView timeZone={timeZone} />
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
          <a
            href="#"
            onClick={onAdminLoginClick}
            className="text-xs text-muted-foreground opacity-60 transition-opacity hover:opacity-100 hover:underline"
          >
            admin login
          </a>
        </div>
      </footer>
    </div>
  );
}
