import { describe, expect, test } from "bun:test";
import { ADDRESS_FACE_DATA_URI_PREFIX, addressFaceDataUri, blockieDataUri } from "./src/blockies";

const ADDRESS = "0x1234567890abcdef1234567890ABCDEF12345678";

function decodeSvg(uri: string): string {
  expect(uri.startsWith(ADDRESS_FACE_DATA_URI_PREFIX)).toBe(true);
  return decodeURIComponent(uri.slice(ADDRESS_FACE_DATA_URI_PREFIX.length));
}

describe("frontend address faces", () => {
  test("generates local SVG data URIs instead of remote or backend URLs", () => {
    const uri = addressFaceDataUri(ADDRESS);

    expect(uri.startsWith("http://")).toBe(false);
    expect(uri.startsWith("https://")).toBe(false);
    expect(uri.startsWith("/api/")).toBe(false);
    expect(uri.startsWith(ADDRESS_FACE_DATA_URI_PREFIX)).toBe(true);

    const svg = decodeSvg(uri);
    expect(svg).toContain("<svg ");
    expect(svg).toContain("shape-rendering=\"crispEdges\"");
    expect(svg).toContain("<rect");
  });

  test("normalizes address case and memoizes generated faces", () => {
    const first = addressFaceDataUri(ADDRESS);
    const second = addressFaceDataUri(ADDRESS.toLowerCase());

    expect(second).toBe(first);
  });

  test("keeps the legacy blockie helper on the same frontend implementation", () => {
    expect(blockieDataUri(ADDRESS)).toBe(addressFaceDataUri(ADDRESS));
  });
});
