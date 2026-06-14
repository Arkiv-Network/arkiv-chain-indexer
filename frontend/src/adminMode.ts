export type AdminModeStatus = "hidden" | "enabled" | "disabled";

export function adminModeStatus(adminVerified: boolean, adminModeEnabled: boolean): AdminModeStatus {
  if (!adminVerified) return "hidden";
  return adminModeEnabled ? "enabled" : "disabled";
}

export function adminModeActive(adminVerified: boolean, adminModeEnabled: boolean): boolean {
  return adminModeStatus(adminVerified, adminModeEnabled) === "enabled";
}

export function privilegedAdminToken(
  token: string,
  adminVerified: boolean,
  adminModeEnabled: boolean,
): string | undefined {
  if (!adminModeActive(adminVerified, adminModeEnabled)) return undefined;
  const trimmed = token.trim();
  return trimmed || undefined;
}
