import { describe, expect, test } from "bun:test";
import { adminModeActive, adminModeStatus, privilegedAdminToken } from "./src/adminMode";

describe("frontend admin mode state", () => {
  test("hides admin mode status until credentials are verified", () => {
    expect(adminModeStatus(false, false)).toBe("hidden");
    expect(adminModeStatus(false, true)).toBe("hidden");
    expect(adminModeActive(false, true)).toBe(false);
  });

  test("reports enabled or disabled status for verified admins", () => {
    expect(adminModeStatus(true, true)).toBe("enabled");
    expect(adminModeActive(true, true)).toBe(true);

    expect(adminModeStatus(true, false)).toBe("disabled");
    expect(adminModeActive(true, false)).toBe(false);
  });

  test("only returns the bearer token while verified admin mode is enabled", () => {
    expect(privilegedAdminToken(" secret ", true, true)).toBe("secret");
    expect(privilegedAdminToken(" secret ", true, false)).toBeUndefined();
    expect(privilegedAdminToken(" secret ", false, true)).toBeUndefined();
    expect(privilegedAdminToken("   ", true, true)).toBeUndefined();
  });
});
