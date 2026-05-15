import { useEffect, useState } from "react";
import { BlocksView } from "./BlocksView";
import { ChartsView } from "./ChartsView";
import { getCurrentSearch, readViewFromSearch, writePermalink } from "./permalinks";
import { RangesView } from "./RangesView";

export function App() {
  const [locationSearch, setLocationSearch] = useState(getCurrentSearch);
  const view = readViewFromSearch(locationSearch);

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
        </nav>
      </header>
      <main className={view === "charts" ? "fullscreen" : ""}>
        {view === "blocks" ? (
          <BlocksView locationSearch={locationSearch} onLocationChange={refreshFromLocation} />
        ) : view === "ranges" ? (
          <RangesView locationSearch={locationSearch} onLocationChange={refreshFromLocation} />
        ) : (
          <ChartsView locationSearch={locationSearch} onLocationChange={refreshFromLocation} />
        )}
      </main>
    </>
  );
}
