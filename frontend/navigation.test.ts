import { describe, expect, test } from "bun:test";
import { primaryNavViewFor, requiresAdminView, visibleNavItems } from "./src/navigation";

function visibleViews(adminVerified: boolean, transactionDataEnabled: boolean | null): string[] {
  return visibleNavItems(adminVerified, transactionDataEnabled).map((item) => item.view);
}

describe("frontend navigation visibility", () => {
  test("direct admin views require the same access as their navigation items", () => {
    for (const view of ["admin", "baseload", "health"] as const) expect(requiresAdminView(view)).toBe(true);
    for (const view of ["statistics", "home", "data", "search", "entity", "transaction"] as const) expect(requiresAdminView(view)).toBe(false);
  });

  test("hides admin-only pages when admin mode is not verified", () => {
    const views = visibleViews(false, true);
    for (const view of ["admin", "baseload", "health"]) expect(views).not.toContain(view);
    expect(views).toContain("data");
  });

  test("shows admin-only pages when admin mode is verified", () => {
    const views = visibleViews(true, true);
    for (const view of ["admin", "baseload", "health", "block", "entity", "transactions", "senders"]) {
      expect(views).toContain(view);
    }
  });

  test("keeps transaction-data pages hidden until the backend feature is available", () => {
    const views = visibleViews(true, false);
    for (const view of ["block", "entity", "transactions", "senders"]) expect(views).not.toContain(view);
    expect(views).toContain("transaction-records");
  });

  test("puts the explorer sections in the header and everything else in the footer", () => {
    const primary = visibleNavItems(false, true).filter((item) => item.primary).map((item) => item.label);
    expect(primary).toEqual(["Home", "Blocks", "Wallets", "Transactions", "Entities"]);
  });

  test("detail pages highlight the header section they belong to", () => {
    expect(primaryNavViewFor("block")).toBe("blocks");
    expect(primaryNavViewFor("transaction")).toBe("transactions");
    expect(primaryNavViewFor("address")).toBe("senders");
    expect(primaryNavViewFor("entity")).toBe("data");
    expect(primaryNavViewFor("statistics")).toBe("statistics");
  });
});
