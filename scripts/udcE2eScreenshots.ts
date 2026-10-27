#!/usr/bin/env bun
/**
 * Full-page screenshots of the explorer's key pages after a UDC e2e run
 * (docs/udc-e2e.md): home, blocks, the mixed batch's block and transaction, a
 * mined failure, the 32-attribute create, and the permanent, toggled and wide
 * entities, the Data tab and statistics.
 *
 * Needs this checkout's devDependencies (`bun install`) and a browser
 * (`bunx playwright install chromium`).
 *
 *   bun scripts/udcE2eScreenshots.ts <frontend url> <manifest.json> <out dir>
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import type { Manifest } from "./udcE2eModel";

const [frontend, manifestPath, out] = process.argv.slice(2);
if (!frontend || !manifestPath || !out) {
  console.error("usage: bun scripts/udcE2eScreenshots.ts <frontend url> <manifest.json> <out dir>");
  process.exit(2);
}
const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const tx = (label: string) => manifest.transactions.find((t) => t.label === label);
const entity = (label: string) => manifest.entities.find((e) => e.label === label)?.key;
const root = frontend.replace(/\/+$/, "");

const pages: [string, string | undefined][] = [
  ["home", "/"],
  ["blocks", "/blocks"],
  ["block-batch", tx("batch-mixed") && `/block?block=${tx("batch-mixed")!.block}`],
  ["tx-batch", tx("batch-mixed") && `/tx/${tx("batch-mixed")!.hash}`],
  ["tx-failed-readonly", tx("fail:readonly-patch") && `/tx/${tx("fail:readonly-patch")!.hash}`],
  ["tx-32-attributes", tx("create-32-attributes") && `/tx/${tx("create-32-attributes")!.hash}`],
  ["tx-toggle-patch", tx("patch-toggle-retype") && `/tx/${tx("patch-toggle-retype")!.hash}`],
  ["entity-permanent", entity("heirloom") && `/entity/${entity("heirloom")}`],
  ["entity-toggle", entity("toggle") && `/entity/${entity("toggle")}`],
  ["entity-wide", entity("wide-32") && `/entity/${entity("wide-32")}`],
  ["data", "/data"],
  ["statistics", "/statistics"],
];

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
let failures = 0;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  for (const [name, path] of pages) {
    if (!path) {
      console.log(`skip ${name}: not in the manifest`);
      continue;
    }
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(root + path, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(1_500);
      const file = join(out, `${name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(`${name}: ${file}${errors.length ? ` (page errors: ${errors.slice(0, 2).join(" | ")})` : ""}`);
    } catch (error) {
      failures++;
      console.log(`${name}: FAILED ${(error as Error).message.split("\n")[0]}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
