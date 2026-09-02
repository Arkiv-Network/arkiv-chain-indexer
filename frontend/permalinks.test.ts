import { describe, expect, test } from "bun:test";
import {
  buildRouteHref,
  entityDetailHref,
  readEntityKeyFromLocation,
  readViewFromLocation,
  shouldHandleClientNavigation,
  type ClientNavigationClick,
} from "./src/permalinks";

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
  test("reads the home route", () => {
    expect(readViewFromLocation({ pathname: "/", search: "" })).toBe("home");
  });

  test("defaults to the home view", () => {
    expect(readViewFromLocation({ pathname: "/unknown", search: "" })).toBe("home");
  });

  test("reads the blocks route", () => {
    expect(readViewFromLocation({ pathname: "/blocks", search: "?limit=100" })).toBe("blocks");
  });

  test("reads the block route", () => {
    expect(readViewFromLocation({ pathname: "/block", search: "?block=42" })).toBe("block");
  });

  test("reads the transactions route", () => {
    expect(readViewFromLocation({ pathname: "/transactions", search: "?block=42" })).toBe("transactions");
  });

  test("reads the transaction records route", () => {
    expect(readViewFromLocation({ pathname: "/records", search: "" })).toBe("transaction-records");
  });

  test("reads the senders route", () => {
    expect(readViewFromLocation({ pathname: "/senders", search: "" })).toBe("senders");
  });

  test("reads the health route", () => {
    expect(readViewFromLocation({ pathname: "/health", search: "" })).toBe("health");
  });

  test("reads the data route", () => {
    expect(readViewFromLocation({ pathname: "/data", search: "" })).toBe("data");
    expect(readViewFromLocation({ pathname: "/data/", search: "?q=%2A" })).toBe("data");
    expect(readViewFromLocation({ pathname: "/", search: "?view=data" })).toBe("data");
    expect(buildRouteHref("data", { q: "$owner = addr(0xabc)" })).toBe("/data?q=%24owner+%3D+addr%280xabc%29");
  });

  test("reads the baseload route", () => {
    expect(readViewFromLocation({ pathname: "/baseload", search: "" })).toBe("baseload");
  });

  test("reads compatibility aliases", () => {
    expect(readViewFromLocation({ pathname: "/transaction-records", search: "" })).toBe("transaction-records");
    expect(readViewFromLocation({ pathname: "/guzzlers", search: "" })).toBe("guzzlers");
  });

  test("reads the entity route with and without a key segment", () => {
    const key = `0x${"ab".repeat(32)}`;
    expect(readViewFromLocation({ pathname: "/entity", search: "" })).toBe("entity");
    expect(readViewFromLocation({ pathname: `/entity/${key}`, search: "" })).toBe("entity");
    expect(readEntityKeyFromLocation({ pathname: `/entity/${key}`, search: "" })).toBe(key);
    expect(readEntityKeyFromLocation({ pathname: "/entity", search: "" })).toBeNull();
    expect(entityDetailHref(` ${key} `)).toBe(`/entity/${key}`);
  });

  test("reads the chart fullscreen route", () => {
    expect(readViewFromLocation({ pathname: "/charts/fullscreen", search: "?zoom=6" })).toBe("chart-fullscreen");
  });

  test("falls back to legacy query view at the root", () => {
    expect(readViewFromLocation({ pathname: "/", search: "?view=charts" })).toBe("charts");
    expect(readViewFromLocation({ pathname: "/unknown", search: "?view=charts" })).toBe("charts");
  });

  test("builds browser route hrefs without legacy view parameters", () => {
    expect(buildRouteHref("transactions", { address: "0xabc", page: "1", view: "blocks" })).toBe(
      "/transactions?address=0xabc&page=1",
    );
    expect(buildRouteHref("chart-fullscreen", { zoom: "6", parameters: "averageFeePriceWei" })).toBe(
      "/charts/fullscreen?zoom=6&parameters=averageFeePriceWei",
    );
    expect(buildRouteHref("transaction-records", {})).toBe("/records");
    expect(buildRouteHref("guzzlers", { address: "" })).toBe("/activity");
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
