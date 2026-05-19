import { useEffect, useState } from "react";
import {
  fetchBaseloadState,
  fetchHealth,
  updateBaseloadConfig as putBaseloadConfig,
  type BaseloadTaskStatus,
  type BaseloadWorkerBalance,
} from "./api";
import { BaseloadView } from "./BaseloadView";
import { EMPTY_BASELOAD_CONFIG, type BaseloadConfig } from "./baseloadConfig";
import { BlocksView } from "./BlocksView";
import { ChartsView } from "./ChartsView";
import { HealthView } from "./HealthView";
import { getCurrentSearch, readViewFromSearch, writePermalink } from "./permalinks";
import { usePersistentState } from "./persistentState";
import { RangesView } from "./RangesView";
import { detectBrowserTimeZone, TIME_ZONE_OPTIONS } from "./timezones";
import { TransactionsView } from "./TransactionsView";

const TIME_ZONE_STORAGE_KEY = "gas-tracker.time-zone";

export function App() {
  const [locationSearch, setLocationSearch] = useState(getCurrentSearch);
  const [transactionDataEnabled, setTransactionDataEnabled] = useState<boolean | null>(null);
  const [baseloadConfig, setBaseloadConfig] = useState<BaseloadConfig>(EMPTY_BASELOAD_CONFIG);
  const [baseloadTaskStatuses, setBaseloadTaskStatuses] = useState<Record<string, BaseloadTaskStatus>>({});
  const [baseloadBalances, setBaseloadBalances] = useState<Record<string, BaseloadWorkerBalance>>({});
  const [baseloadError, setBaseloadError] = useState<string | null>(null);
  const [timeZoneState, setTimeZoneState] = usePersistentState(TIME_ZONE_STORAGE_KEY, {
    timeZone: detectBrowserTimeZone(),
  });
  const view = readViewFromSearch(locationSearch);
  const activeView = transactionDataEnabled !== true && view === "transactions" ? "blocks" : view;
  const timeZone = timeZoneState.timeZone;

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
    let cancelled = false;

    const refresh = async () => {
      try {
        const state = await fetchBaseloadState();
        if (cancelled) return;
        setBaseloadConfig(state.config);
        setBaseloadTaskStatuses(state.statuses);
        setBaseloadBalances(state.balances ?? {});
        setBaseloadError(state.enabled ? null : "BASELOAD_RPC_NODE is not configured on the backend");
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
  }, []);

  useEffect(() => {
    if (transactionDataEnabled === false && view === "transactions" && writePermalink("blocks", {})) {
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
    setTimeZoneState({ timeZone: event.target.value });
  };

  const updateBaseloadConfig = async (config: BaseloadConfig) => {
    try {
      const state = await putBaseloadConfig(config);
      setBaseloadConfig(state.config);
      setBaseloadTaskStatuses(state.statuses);
      setBaseloadBalances(state.balances ?? {});
      setBaseloadError(state.enabled ? null : "BASELOAD_RPC_NODE is not configured on the backend");
    } catch (error) {
      setBaseloadError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <>
      <header>
        <h1>Gas price tracker</h1>
        <nav>
          <button
            type="button"
            className={activeView === "blocks" ? "active" : ""}
            onClick={() => setView("blocks")}
          >
            Blocks
          </button>
          {transactionDataEnabled === true ? (
            <button
              type="button"
              className={activeView === "transactions" ? "active" : ""}
              onClick={() => setView("transactions")}
            >
              Transactions
            </button>
          ) : null}
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
            className={activeView === "health" ? "active" : ""}
            onClick={() => setView("health")}
          >
            Health
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
      </header>
      <main className={activeView === "charts" ? "fullscreen" : ""}>
        {activeView === "blocks" ? (
          <BlocksView
            locationSearch={locationSearch}
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
          />
        ) : activeView === "transactions" ? (
          <TransactionsView
            locationSearch={locationSearch}
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
          />
        ) : activeView === "ranges" ? (
          <RangesView
            locationSearch={locationSearch}
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
          />
        ) : activeView === "charts" ? (
          <ChartsView
            locationSearch={locationSearch}
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
            transactionDataEnabled={transactionDataEnabled === true}
          />
        ) : activeView === "baseload" ? (
          <BaseloadView
            config={baseloadConfig}
            onConfigChange={updateBaseloadConfig}
            taskStatuses={baseloadTaskStatuses}
            balances={baseloadBalances}
            backendError={baseloadError}
          />
        ) : (
          <HealthView timeZone={timeZone} />
        )}
      </main>
    </>
  );
}
