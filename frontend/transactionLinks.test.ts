import { describe, expect, test } from "bun:test";
import { addressSearchHref, readTransactionDecoderBaseUrl, transactionDecoderHref } from "./src/transactionLinks";

const HASH = "0xf8da0a7fd7af9dae0730e43b9d0184500de5c77975dd3e644e2da22c044891c6";

describe("transaction links", () => {
  test("the decoder link is off unless configured", () => {
    expect(readTransactionDecoderBaseUrl({})).toBeNull();
    expect(readTransactionDecoderBaseUrl({ VITE_TRANSACTION_DECODER_BASE_URL: "" })).toBeNull();
    for (const off of ["off", "OFF", "none", "false", "0", "disabled"]) {
      expect(readTransactionDecoderBaseUrl({ VITE_TRANSACTION_DECODER_BASE_URL: off })).toBeNull();
    }
    expect(transactionDecoderHref(HASH, null)).toBeNull();
  });

  test("reads a configured decoder base URL and links hashes to it", () => {
    const base = readTransactionDecoderBaseUrl({ VITE_TRANSACTION_DECODER_BASE_URL: "https://decoder.example.test" });
    expect(base).toBe("https://decoder.example.test/");
    expect(transactionDecoderHref(HASH, base)).toBe(`https://decoder.example.test/?tx=${HASH}`);
  });

  test("an invalid decoder URL turns the link off rather than guessing", () => {
    expect(readTransactionDecoderBaseUrl({ VITE_TRANSACTION_DECODER_BASE_URL: "ftp://example.test/" })).toBeNull();
    expect(readTransactionDecoderBaseUrl({ VITE_TRANSACTION_DECODER_BASE_URL: "not a url" })).toBeNull();
  });

  test("does not build decoder links for missing or malformed transaction hashes", () => {
    const base = "https://decoder.example.test/";
    expect(transactionDecoderHref(null, base)).toBeNull();
    expect(transactionDecoderHref("", base)).toBeNull();
    expect(transactionDecoderHref("0x1234", base)).toBeNull();
  });

  test("builds internal address detail links", () => {
    expect(addressSearchHref("0x1234567890abcdef1234567890ABCDEF12345678")).toBe(
      "/address/0x1234567890abcdef1234567890ABCDEF12345678",
    );
  });

  test("does not build address links for missing or malformed addresses", () => {
    expect(addressSearchHref(null)).toBeNull();
    expect(addressSearchHref("")).toBeNull();
    expect(addressSearchHref("0x1234")).toBeNull();
  });
});
