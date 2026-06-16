import type { View } from "./permalinks";

export interface NavItem {
  view: View;
  label: string;
  requiresAdmin?: boolean;
  requiresTransactionData?: boolean;
}

export const ALL_NAV_ITEMS: readonly NavItem[] = [
  { view: "home", label: "Home" },
  { view: "blocks", label: "Blocks" },
  { view: "block", label: "Block", requiresTransactionData: true },
  { view: "transactions", label: "Address", requiresTransactionData: true },
  { view: "senders", label: "Senders", requiresTransactionData: true },
  { view: "transaction-records", label: "Records" },
  { view: "ranges", label: "Ranges" },
  { view: "charts", label: "Charts" },
  { view: "guzzlers", label: "Activity" },
  { view: "health", label: "Health", requiresAdmin: true },
  { view: "admin", label: "Admin", requiresAdmin: true },
  { view: "baseload", label: "Baseload", requiresAdmin: true },
];

export function visibleNavItems(
  adminVerified: boolean,
  transactionDataEnabled: boolean | null,
): readonly NavItem[] {
  return ALL_NAV_ITEMS.filter((item) => {
    if (item.requiresAdmin && !adminVerified) return false;
    if (item.requiresTransactionData && transactionDataEnabled !== true) return false;
    return true;
  });
}

export function navLabelForView(view: View): string | undefined {
  return ALL_NAV_ITEMS.find((item) => item.view === view)?.label;
}
