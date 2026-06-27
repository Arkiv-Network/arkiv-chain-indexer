import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PAYLOAD_PROVIDER_BASE_URL,
  DEFAULT_TRANSACTION_DECODER_BASE_URL,
  addressSearchHref,
  payloadInfoHref,
  readPayloadProviderBaseUrl,
  readTransactionDecoderBaseUrl,
  readTransactionExplorerBaseUrl,
  transactionDecoderHref,
  transactionExplorerHref,
} from "./src/transactionLinks";

describe("transaction links", () => {
  test("links transaction hashes to the Atlas transaction decoder", () => {
    const hash = "0xf8da0a7fd7af9dae0730e43b9d0184500de5c77975dd3e644e2da22c044891c6";

    expect(transactionDecoderHref(hash)).toBe(`${DEFAULT_TRANSACTION_DECODER_BASE_URL}?tx=${hash}`);
    expect(transactionExplorerHref(hash)).toBe(`${DEFAULT_TRANSACTION_DECODER_BASE_URL}?tx=${hash}`);
  });

  test("reads configured transaction decoder base URLs", () => {
    expect(
      readTransactionDecoderBaseUrl({
        VITE_TRANSACTION_DECODER_BASE_URL: "https://decoder.example.test",
      }),
    ).toBe("https://decoder.example.test/");
  });

  test("ignores configured transaction explorer base URLs for decoder links", () => {
    expect(
      readTransactionDecoderBaseUrl({
        VITE_TRANSACTION_EXPLORER_BASE_URL: "https://legacy.example.test/tx",
      }),
    ).toBe(DEFAULT_TRANSACTION_DECODER_BASE_URL);
  });

  test("defaults invalid transaction decoder base URLs", () => {
    expect(readTransactionDecoderBaseUrl({ VITE_TRANSACTION_DECODER_BASE_URL: "" })).toBe(
      DEFAULT_TRANSACTION_DECODER_BASE_URL,
    );
    expect(readTransactionDecoderBaseUrl({ VITE_TRANSACTION_DECODER_BASE_URL: "ftp://example.test/" })).toBe(
      DEFAULT_TRANSACTION_DECODER_BASE_URL,
    );
  });

  test("still reads configured transaction explorer base URLs for compatibility", () => {
    expect(
      readTransactionExplorerBaseUrl({
        VITE_TRANSACTION_EXPLORER_BASE_URL: "https://explorer.example.test/tx",
      }),
    ).toBe("https://explorer.example.test/tx/");
  });

  test("does not build explorer links for missing or malformed transaction hashes", () => {
    expect(transactionDecoderHref(null)).toBeNull();
    expect(transactionDecoderHref("")).toBeNull();
    expect(transactionDecoderHref("0x1234")).toBeNull();
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

  test("links payload reference ids to the payload provider", () => {
    const id = "a806b74c6c933e9c0c3cfd7c099c7c6cdbf86bef1a48da310a90bd050c37b4e5";
    expect(payloadInfoHref(id)).toBe(`${DEFAULT_PAYLOAD_PROVIDER_BASE_URL}payloads/${id}`);
    // Mixed-case input is normalized to the lowercase content-addressed id.
    expect(payloadInfoHref(id.toUpperCase())).toBe(`${DEFAULT_PAYLOAD_PROVIDER_BASE_URL}payloads/${id}`);
  });

  test("reads configured and defaults invalid payload provider base URLs", () => {
    expect(
      readPayloadProviderBaseUrl({ VITE_PAYLOAD_PROVIDER_BASE_URL: "https://payload.example.test" }),
    ).toBe("https://payload.example.test/");
    expect(readPayloadProviderBaseUrl({ VITE_PAYLOAD_PROVIDER_BASE_URL: "" })).toBe(
      DEFAULT_PAYLOAD_PROVIDER_BASE_URL,
    );
    expect(
      readPayloadProviderBaseUrl({ VITE_PAYLOAD_PROVIDER_BASE_URL: "ftp://payload.example.test" }),
    ).toBe(DEFAULT_PAYLOAD_PROVIDER_BASE_URL);
  });

  test("does not build payload links for missing or malformed ids", () => {
    expect(payloadInfoHref(null)).toBeNull();
    expect(payloadInfoHref("")).toBeNull();
    expect(payloadInfoHref("not-hex")).toBeNull();
    // 0x-prefixed or wrong-length ids are not valid content-addressed ids.
    expect(payloadInfoHref("0xa806b74c")).toBeNull();
  });
});
