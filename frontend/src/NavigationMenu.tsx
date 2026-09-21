import { Popover } from "@base-ui/react/popover";
import {
  Activity, Box, Boxes, Database, Gauge, HeartPulse, Home, Layers,
  LineChart, ListOrdered, Menu, Moon, Receipt, Search, Shield, Sun,
  Users, Wallet, type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { navLabelForView, type NavItem } from "./navigation";
import { buildRouteHref, shouldHandleClientNavigation, type View } from "./permalinks";
import { TIME_ZONE_OPTIONS } from "./timezones";

const NAV_ICONS: Partial<Record<View, LucideIcon>> = {
  statistics: LineChart,
  home: Home, search: Search, blocks: Boxes, block: Box, transactions: Wallet,
  entity: Layers, address: Wallet, data: Database, "transaction-records": Receipt,
  senders: Users, ranges: ListOrdered, charts: LineChart, guzzlers: Activity,
  health: HeartPulse, admin: Shield, baseload: Gauge,
};

// Keep pages and display settings together in the original compact popup.
// Shared positioning handles narrow screens, dismissal and focus restoration.
export function NavigationMenu({
  activeView, navItems, onNavigate, fullWidth, onToggleFullWidth,
  darkModeActive, onToggleDarkMode, timeZone, onTimeZoneChange,
}: {
  activeView: View;
  navItems: readonly NavItem[];
  onNavigate: (view: View) => void;
  fullWidth: boolean;
  onToggleFullWidth: () => void;
  darkModeActive: boolean;
  onToggleDarkMode: () => void;
  timeZone: string;
  onTimeZoneChange: (event: ChangeEvent<HTMLSelectElement>) => void;
}) {
  const [open, setOpen] = useState(false);
  const activeLabel = navItems.find(item => item.view === activeView)?.label ?? navLabelForView(activeView) ?? "Menu";
  useEffect(() => setOpen(false), [activeView]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        title="Navigation menu"
        aria-label={open ? "Close navigation menu" : "Open navigation menu"}
        className="ml-auto inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted data-open:bg-muted"
      >
        <Menu className="size-4" aria-hidden="true" />
        <span>{activeLabel}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end" collisionPadding={12} className="z-[60]">
          <Popover.Popup aria-label="Navigation menu" className="flex max-h-[var(--available-height)] w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-3 overflow-y-auto rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md">
            <div className="flex flex-col gap-2">
              <div className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Pages</div>
              <nav aria-label="Primary navigation" className="grid grid-cols-2 gap-1">
                {navItems.map(item => {
                  const Icon = NAV_ICONS[item.view] ?? Home;
                  const active = activeView === item.view;
                  return (
                    <a
                      key={item.view}
                      href={buildRouteHref(item.view, {})}
                      aria-current={active ? "page" : undefined}
                      onClick={event => {
                        if (!shouldHandleClientNavigation(event)) return;
                        event.preventDefault();
                        onNavigate(item.view);
                        setOpen(false);
                      }}
                      className={cn(
                        "inline-flex min-h-9 items-center gap-2 rounded-md border px-2 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                        active ? "border-border bg-muted text-foreground" : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                      {item.label}
                    </a>
                  );
                })}
              </nav>
            </div>
            <Separator />
            <div className="flex flex-col gap-2">
              <div className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Display</div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium">Full width</span>
                <Button type="button" variant={fullWidth ? "default" : "outline"} size="xs" onClick={onToggleFullWidth} aria-pressed={fullWidth} aria-label="Full width">
                  {fullWidth ? "On" : "Off"}
                </Button>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium">Theme</span>
                <Button type="button" variant="outline" size="xs" onClick={onToggleDarkMode} aria-pressed={darkModeActive} title={darkModeActive ? "Switch to light mode" : "Switch to dark mode"}>
                  {darkModeActive ? <Sun className="size-3" /> : <Moon className="size-3" />}
                  {darkModeActive ? "Dark" : "Light"}
                </Button>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="display-time-zone" className="text-xs font-medium text-muted-foreground">Time zone</label>
                <select id="display-time-zone" value={timeZone} onChange={onTimeZoneChange} className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground">
                  {TIME_ZONE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
