import { useState } from "react";
import { BlocksView } from "./BlocksView";
import { RangesView } from "./RangesView";

type View = "blocks" | "ranges";

export function App() {
  const [view, setView] = useState<View>("blocks");

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
        </nav>
      </header>
      <main>{view === "blocks" ? <BlocksView /> : <RangesView />}</main>
    </>
  );
}
