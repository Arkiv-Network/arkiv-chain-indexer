import { chromium } from "playwright";

const DEFAULT_URL = "http://localhost:23560/";
const DEFAULT_OUTPUT = "screenshot.png";

async function main(): Promise<void> {
  const url = process.argv[2] ?? process.env.SCREENSHOT_URL ?? DEFAULT_URL;
  const output = process.argv[3] ?? process.env.SCREENSHOT_OUTPUT ?? DEFAULT_OUTPUT;

  const browser = await chromium.launch({ timeout: 0 });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2_000);
    await page.screenshot({ path: output, fullPage: true });
    console.log(`Saved screenshot of ${url} to ${output}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
