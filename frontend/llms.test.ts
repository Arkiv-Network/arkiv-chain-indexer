import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

describe("frontend llms.txt asset", () => {
  test("matches the repository llms.txt source", async () => {
    const [source, publicAsset] = await Promise.all([
      readFile(new URL("../llms.txt", import.meta.url), "utf8"),
      readFile(new URL("./public/llms.txt", import.meta.url), "utf8"),
    ]);

    expect(publicAsset).toBe(source);
  });
});
