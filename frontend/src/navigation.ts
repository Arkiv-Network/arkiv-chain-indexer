import type { View } from "./permalinks";

export interface NavItem {
  view: View;
  label: string;
  /** Shown as a link in the header; every other page is linked from the footer. */
  primary?: boolean;
  requiresAdmin?: boolean;
  requiresTransactionData?: boolean;
}

export const ALL_NAV_ITEMS: readonly NavItem[] = [
  { view: "home", label: "Home", primary: true },
  { view: "blocks", label: "Blocks", primary: true },
  { view: "senders", label: "Wallets", primary: true, requiresTransactionData: true },
  { view: "transactions", label: "Transactions", primary: true, requiresTransactionData: true },
  { view: "entity-explorer", label: "Entities", primary: true },
  { view: "statistics", label: "Statistics" },
  { view: "search", label: "Search" },
  { view: "block", label: "Block", requiresTransactionData: true },
  { view: "entity", label: "Entity", requiresTransactionData: true },
  { view: "transaction-records", label: "Records" },
  { view: "ranges", label: "Ranges" },
  { view: "charts", label: "Charts" },
  { view: "guzzlers", label: "Activity" },
  { view: "health", label: "Health", requiresAdmin: true },
  { view: "admin", label: "Admin", requiresAdmin: true },
  { view: "baseload", label: "Baseload", requiresAdmin: true },
];

/** Detail pages highlight the header link of the list they belong to. */
const PRIMARY_NAV_PARENT: Partial<Record<View, View>> = {
  block: "blocks",
  transaction: "transactions",
  address: "senders",
  entity: "entity-explorer",
};

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

export function primaryNavViewFor(view: View): View {
  return PRIMARY_NAV_PARENT[view] ?? view;
}

/** Guard view rendering as well as menu visibility, including direct links. */
export function requiresAdminView(view: View): boolean {
  return ALL_NAV_ITEMS.some((item) => item.view === view && item.requiresAdmin);
}
