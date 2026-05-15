import { useEffect, useState } from "react";
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
  const [timeZoneState, setTimeZoneState] = usePersistentState(TIME_ZONE_STORAGE_KEY, {
    timeZone: detectBrowserTimeZone(),
  });
  const view = readViewFromSearch(locationSearch);
  const timeZone = timeZoneState.timeZone;

  useEffect(() => {
    const onPopState = () => setLocationSearch(getCurrentSearch());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

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
            className={view === "blocks" ? "active" : ""}
            onClick={() => setView("blocks")}
          >
            Blocks
          </button>
          <button
            type="button"
            className={view === "transactions" ? "active" : ""}
            onClick={() => setView("transactions")}
          >
            Transactions
          </button>
          <button
            type="button"
            className={view === "ranges" ? "active" : ""}
            onClick={() => setView("ranges")}
          >
            Ranges
          </button>
          <button
            type="button"
            className={view === "charts" ? "active" : ""}
            onClick={() => setView("charts")}
          >
            Charts
          </button>
          <button
            type="button"
            className={view === "health" ? "active" : ""}
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
      <main className={view === "charts" ? "fullscreen" : ""}>
        {view === "blocks" ? (
          <BlocksView
            locationSearch={locationSearch}
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
          />
        ) : view === "transactions" ? (
          <TransactionsView
            locationSearch={locationSearch}
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
          />
        ) : view === "ranges" ? (
          <RangesView
            locationSearch={locationSearch}
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
          />
        ) : view === "charts" ? (
          <ChartsView
            locationSearch={locationSearch}
            onLocationChange={refreshFromLocation}
            timeZone={timeZone}
          />
        ) : (
          <HealthView timeZone={timeZone} />
        )}
      </main>
    </>
  );
}
