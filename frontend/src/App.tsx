import { useEffect, useState } from "react";
import { fetchHealth } from "./api";
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
        ) : (
          <HealthView timeZone={timeZone} />
        )}
      </main>
    </>
  );
}
