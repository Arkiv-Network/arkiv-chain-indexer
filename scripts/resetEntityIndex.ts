#!/usr/bin/env bun
/** Explicit entity-only reset. Stop backend/projector and importer before invoking. */
import { parseArgs } from "node:util";
import { EntityIndexStorage } from "../src/entityIndexStorage";

const { values: args } = parseArgs({ options: {
  "database-url": { type: "string" }, schema: { type: "string" },
  "writers-stopped": { type: "boolean" }, help: { type: "boolean", short: "h" },
}, strict: true });
if (args.help || !args["writers-stopped"] || !(args["database-url"] ?? process.env.DATABASE_URL)) {
  console.error("usage: bun run scripts/resetEntityIndex.ts --writers-stopped [--database-url <url>] [--schema <schema>]\nStop all indexer database writers first. Only entity projection tables/state are cleared; scanned and authentication data remain.");
  process.exit(args.help ? 0 : 2);
}
const storage = await EntityIndexStorage.open(args["database-url"] ?? process.env.DATABASE_URL!, { max: 2, ...(args.schema ? { schema: args.schema } : {}) });
try { await storage.reset(); console.log("Entity index reset; rerun the genesis importer and restart writers."); }
finally { await storage.close(); }
