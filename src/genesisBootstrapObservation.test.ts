import { expect, test } from "bun:test";
import { bootstrapPollInterval, GenesisCountMismatchConfirmation } from "./genesisBootstrapObservation";

test("a transient count mismatch cannot poison a restored database", () => {
  const confirmation = new GenesisCountMismatchConfirmation();
  expect(confirmation.observe("chain:genesis:dump:count")).toBe(false);
  // A matching count, unavailable node, or a loop observing repair breaks the sequence.
  expect(confirmation.observe(null)).toBe(false);
  expect(confirmation.observe("chain:genesis:dump:count")).toBe(false);
  expect(confirmation.observe("chain:genesis:dump:count")).toBe(true);
});

test("consecutive mismatches cannot carry over to a different genesis or dump", () => {
  const confirmation = new GenesisCountMismatchConfirmation();
  for (const identity of ["chain:a:dump:3", "chain:b:dump:3", "chain:b:newdump:3", "chain:b:newdump:4"]) {
    expect(confirmation.observe(identity)).toBe(false);
  }
  expect(confirmation.observe("chain:b:newdump:4")).toBe(true);
});

test("terminal dispositions back off, availability and repair keep retrying promptly", () => {
  for (const status of ["done", "refused: identity mismatch", "failed: reset required", "insufficient scratch space: need 12.3 GB, have 4.5 GB"]) {
    expect(bootstrapPollInterval(status)).toBe(60_000);
  }
  for (const status of ["waiting for reference, database, node or object storage; retrying", "waiting to confirm block-zero entity count mismatch", "waiting for backend repair", "importing genesis entities"]) {
    expect(bootstrapPollInterval(status)).toBe(5_000);
  }
});
