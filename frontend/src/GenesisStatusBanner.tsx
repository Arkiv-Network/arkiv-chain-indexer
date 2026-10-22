import type { EntityQueryIndexHealth } from "./api";

export function GenesisStatusBanner({ index }: { index?: false | EntityQueryIndexHealth }) {
  if (!index || !index.readiness || index.readiness === "ready") return null;
  const genesis = index.genesis;
  const message = index.readiness === "genesis-running"
    ? `Genesis entities importing: ${(genesis?.imported ?? 0).toLocaleString()} of ${(genesis?.total ?? 0).toLocaleString()}${genesis?.phase === "repair" ? " — applying indexed updates" : ""}.`
    : index.readiness === "genesis-failed" || index.readiness === "genesis-unavailable"
      ? "Genesis import needs operator attention."
      : index.readiness === "projection-pending"
        ? "The entity index is starting."
        : "Waiting for genesis entities to import.";
  return <div role="status" aria-live="polite" className="border-b border-amber-500/60 bg-amber-500/10 px-4 py-3 text-sm">
    {message} Entity queries are temporarily unavailable until the index is complete.
  </div>;
}
