import { describe, expect, test } from "bun:test";
import { addressAlias, addressDisplay } from "./src/addressAliases";

describe("address aliases", () => {
  test("aliases the EntityRegistry contract", () => {
    const display = addressDisplay("0x4400000000000000000000000000000000000044");

    expect(display).toEqual({
      label: "EntityRegistry",
      title: "0x4400000000000000000000000000000000000044",
    });
  });

  test("matches addresses case-insensitively", () => {
    expect(addressAlias("0X4400000000000000000000000000000000000044")).toBe("EntityRegistry");
  });

  test("aliases default baseload wallet addresses", () => {
    expect(addressAlias("0x15cf3D9b2F65Ef7fb29643c7a73C737C44e69D19")).toBe("Wallet7");
  });

  test("falls back to shortened address display for unknown addresses", () => {
    const display = addressDisplay("0x1234567890abcdef1234567890ABCDEF12345678");

    expect(display).toEqual({
      label: "0x12345678...12345678",
      title: "0x1234567890abcdef1234567890ABCDEF12345678",
    });
  });

  test("does not add a hover title for missing addresses", () => {
    expect(addressDisplay(null)).toEqual({ label: "-" });
  });
});
