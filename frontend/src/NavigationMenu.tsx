import { Popover } from "@base-ui/react/popover";
import { Boxes, Home, Layers, Moon, Settings2, Sun, Users, Wallet, type LucideIcon } from "lucide-react";
import { type ChangeEvent, type MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { primaryNavViewFor, type NavItem } from "./navigation";
import { buildRouteHref, shouldHandleClientNavigation, type View } from "./permalinks";
import { TIME_ZONE_OPTIONS } from "./timezones";

const PRIMARY_NAV_ICONS: Partial<Record<View, LucideIcon>> = {
  home: Home, blocks: Boxes, senders: Users, transactions: Wallet, "entity-explorer": Layers,
};

function NavLink({
  item, active, onNavigate, className,
}: {
  item: NavItem;
  active: boolean;
  onNavigate: (view: View) => void;
  className: string;
}) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!shouldHandleClientNavigation(event)) return;
    event.preventDefault();
    onNavigate(item.view);
  };
  const Icon = PRIMARY_NAV_ICONS[item.view];
  return (
    <a href={buildRouteHref(item.view, {})} aria-current={active ? "page" : undefined} onClick={onClick} className={className}>
      {item.primary && Icon ? <Icon className="size-3.5 shrink-0" aria-hidden="true" /> : null}
      {item.label}
    </a>
  );
}

/** The header's page links: the main sections of the explorer. */
export function PrimaryNavigation({
  activeView, navItems, onNavigate,
}: {
  activeView: View;
  navItems: readonly NavItem[];
  onNavigate: (view: View) => void;
}) {
  const current = primaryNavViewFor(activeView);
  return (
    <nav aria-label="Primary navigation" className="-mx-1 flex min-w-0 items-center gap-1 overflow-x-auto">
      {navItems.filter(item => item.primary).map(item => {
        const active = current === item.view;
        return (
          <NavLink
            key={item.view}
            item={item}
            active={active}
            onNavigate={onNavigate}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          />
        );
      })}
    </nav>
  );
}

/** The footer's links to every page that is not a header section. */
export function FooterNavigation({
  activeView, navItems, onNavigate,
}: {
  activeView: View;
  navItems: readonly NavItem[];
  onNavigate: (view: View) => void;
}) {
  return (
    <nav aria-label="More pages" className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {navItems.filter(item => !item.primary).map(item => (
        <NavLink
          key={item.view}
          item={item}
          active={activeView === item.view}
          onNavigate={onNavigate}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline aria-[current=page]:text-foreground"
        />
      ))}
    </nav>
  );
}

// Display settings in a compact popup. Shared positioning handles narrow
// screens, dismissal and focus restoration.
export function DisplaySettingsMenu({
  fullWidth, onToggleFullWidth, darkModeActive, onToggleDarkMode, timeZone, onTimeZoneChange,
}: {
  fullWidth: boolean;
  onToggleFullWidth: () => void;
  darkModeActive: boolean;
  onToggleDarkMode: () => void;
  timeZone: string;
  onTimeZoneChange: (event: ChangeEvent<HTMLSelectElement>) => void;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        title="Display settings"
        aria-label="Display settings"
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-open:bg-muted"
      >
        <Settings2 className="size-4" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end" collisionPadding={12} className="z-[60]">
          <Popover.Popup aria-label="Display settings" className="flex max-h-[var(--available-height)] w-72 max-w-[calc(100vw-1.5rem)] flex-col gap-2 overflow-y-auto rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md">
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
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
