export interface TimeZoneOption {
  value: string;
  label: string;
}

export const TIME_ZONE_OPTIONS: TimeZoneOption[] = [
  { value: "America/New_York", label: "US Eastern" },
  { value: "America/Chicago", label: "US Central" },
  { value: "America/Denver", label: "US Mountain" },
  { value: "America/Los_Angeles", label: "US Pacific" },
  { value: "Europe/London", label: "Europe London" },
  { value: "Europe/Berlin", label: "Europe Central" },
  { value: "Europe/Warsaw", label: "Europe Warsaw" },
  { value: "Asia/Kolkata", label: "India" },
  { value: "Australia/Sydney", label: "Australia Sydney" },
  { value: "Australia/Melbourne", label: "Australia Melbourne" },
  { value: "Australia/Perth", label: "Australia Perth" },
  { value: "UTC", label: "UTC" },
];

export function detectBrowserTimeZone(): string {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return TIME_ZONE_OPTIONS.some((option) => option.value === detected) ? detected : "UTC";
}

export function isSupportedTimeZone(value: string | undefined): value is string {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}
