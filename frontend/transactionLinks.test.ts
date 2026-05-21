import { describe, expect, test } from "bun:test";
import { addressSearchHref, transactionExplorerHref } from "./src/transactionLinks";

describe("transaction links", () => {
  test("links transaction hashes to the Arkiv Hoodi explorer", () => {
    const hash = "0xf8da0a7fd7af9dae0730e43b9d0184500de5c77975dd3e644e2da22c044891c6";

    expect(transactionExplorerHref(hash)).toBe(
      "https://explorer.braga.hoodi.arkiv.network/tx/0xf8da0a7fd7af9dae0730e43b9d0184500de5c77975dd3e644e2da22c044891c6",
    );
  });

  test("does not build explorer links for missing or malformed transaction hashes", () => {
    expect(transactionExplorerHref(null)).toBeNull();
    expect(transactionExplorerHref("")).toBeNull();
    expect(transactionExplorerHref("0x1234")).toBeNull();
  });

  test("builds internal address search links on page one", () => {
    expect(addressSearchHref("0x1234567890abcdef1234567890ABCDEF12345678")).toBe(
      "?view=transactions&address=0x1234567890abcdef1234567890ABCDEF12345678&page=1",
    );
  });

  test("does not build address links for missing or malformed addresses", () => {
    expect(addressSearchHref(null)).toBeNull();
    expect(addressSearchHref("")).toBeNull();
    expect(addressSearchHref("0x1234")).toBeNull();
  });
});
