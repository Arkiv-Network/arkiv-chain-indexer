import { describe, expect, test } from "bun:test";
import { navLabelForView, visibleNavItems } from "./src/navigation";

function visibleLabels(adminVerified: boolean, transactionDataEnabled: boolean | null): string[] {
  return visibleNavItems(adminVerified, transactionDataEnabled).map((item) => item.label);
}

describe("frontend navigation visibility", () => {
  test("hides admin-only pages when admin mode is not verified", () => {
    expect(visibleLabels(false, true)).toEqual([
      "Home",
      "Blocks",
      "Block",
      "Address",
      "Senders",
      "Records",
      "Ranges",
      "Charts",
      "Activity",
    ]);
  });

  test("shows admin-only pages when admin mode is verified", () => {
    expect(visibleLabels(true, true)).toEqual([
      "Home",
      "Blocks",
      "Block",
      "Address",
      "Senders",
      "Records",
      "Ranges",
      "Charts",
      "Activity",
      "Health",
      "Admin",
      "Baseload",
    ]);
  });

  test("keeps transaction-data pages hidden until the backend feature is available", () => {
    expect(visibleLabels(true, false)).toEqual([
      "Home",
      "Blocks",
      "Records",
      "Ranges",
      "Charts",
      "Activity",
      "Health",
      "Admin",
      "Baseload",
    ]);
  });

  test("resolves labels for hidden direct-link views", () => {
    expect(navLabelForView("admin")).toBe("Admin");
    expect(navLabelForView("baseload")).toBe("Baseload");
    expect(navLabelForView("health")).toBe("Health");
    expect(navLabelForView("ranges")).toBe("Ranges");
  });
});
