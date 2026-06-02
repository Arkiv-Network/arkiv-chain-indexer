import { describe, expect, test } from "bun:test";
import { readViewFromSearch, shouldHandleClientNavigation, type ClientNavigationClick } from "./src/permalinks";

function clickEvent(overrides: Partial<ClientNavigationClick> = {}): ClientNavigationClick {
  return {
    button: 0,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    currentTarget: {
      getAttribute: () => null,
    },
    ...overrides,
  };
}

describe("frontend permalink helpers", () => {
  test("reads the home view", () => {
    expect(readViewFromSearch("?view=home")).toBe("home");
  });

  test("defaults to the home view", () => {
    expect(readViewFromSearch("")).toBe("home");
  });

  test("reads the blocks view", () => {
    expect(readViewFromSearch("?view=blocks&limit=100")).toBe("blocks");
  });

  test("reads the block view", () => {
    expect(readViewFromSearch("?view=block&block=42")).toBe("block");
  });

  test("reads the transactions view", () => {
    expect(readViewFromSearch("?view=transactions&block=42")).toBe("transactions");
  });

  test("reads the transaction records view", () => {
    expect(readViewFromSearch("?view=transaction-records")).toBe("transaction-records");
  });

  test("reads the senders view", () => {
    expect(readViewFromSearch("?view=senders")).toBe("senders");
  });

  test("reads the health view", () => {
    expect(readViewFromSearch("?view=health")).toBe("health");
  });

  test("reads the baseload view", () => {
    expect(readViewFromSearch("?view=baseload")).toBe("baseload");
  });

  test("falls back to home for unknown views", () => {
    expect(readViewFromSearch("?view=unknown")).toBe("home");
  });
});

describe("frontend client navigation click handling", () => {
  test("handles plain left clicks inside the client app", () => {
    expect(shouldHandleClientNavigation(clickEvent())).toBe(true);
  });

  test("leaves middle-clicks and modified clicks to the browser", () => {
    expect(shouldHandleClientNavigation(clickEvent({ button: 1 }))).toBe(false);
    expect(shouldHandleClientNavigation(clickEvent({ ctrlKey: true }))).toBe(false);
    expect(shouldHandleClientNavigation(clickEvent({ metaKey: true }))).toBe(false);
    expect(shouldHandleClientNavigation(clickEvent({ shiftKey: true }))).toBe(false);
    expect(shouldHandleClientNavigation(clickEvent({ altKey: true }))).toBe(false);
  });

  test("does not handle links with external targets or prior cancellation", () => {
    expect(shouldHandleClientNavigation(clickEvent({ defaultPrevented: true }))).toBe(false);
    expect(
      shouldHandleClientNavigation(
        clickEvent({
          currentTarget: {
            getAttribute: (name) => (name === "target" ? "_blank" : null),
          },
        }),
      ),
    ).toBe(false);
  });
});
