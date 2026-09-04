import { useEffect, useState } from "react";
import {
  BUILD_PAGE_SETTINGS,
  PAGE_SETTING_DEFINITIONS,
  type PageSettings,
  type EditablePageSettingsKey,
  normalizeSettingsDraft,
  settingsToDraft,
} from "./pageSettings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface AdminViewProps {
  settings: PageSettings;
  onSettingsChange: (settings: PageSettings) => void;
  onResetSettings: () => void;
  simulateOffline: boolean;
  onToggleSimulateOffline: () => void;
}

export function AdminView({
  settings,
  onSettingsChange,
  onResetSettings,
  simulateOffline,
  onToggleSimulateOffline,
}: AdminViewProps) {
  const [draft, setDraft] = useState(() => settingsToDraft(settings));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(settingsToDraft(settings));
  }, [settings]);

  const updateDraft = (key: EditablePageSettingsKey, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setMessage(null);
    setError(null);
  };

  const saveSettings = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = normalizeSettingsDraft(draft, settings);
    if (result.error) {
      setError(result.error);
      setMessage(null);
      return;
    }
    onSettingsChange(result.settings);
    setError(null);
    setMessage("Page settings saved in this browser.");
  };

  const resetSettings = () => {
    onResetSettings();
    setError(null);
    setMessage("Page settings reset to build defaults.");
  };

  return (
    <section className="mx-auto flex w-full max-w-415 flex-col gap-6 px-3 py-6 md:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="font-heading text-lg font-black tracking-tight">Page settings</h2>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Build defaults from Vite</span>
          <Badge variant="outline" className="font-mono">
            {BUILD_PAGE_SETTINGS.chainName}
          </Badge>
        </div>
      </div>

      <Card className="py-0">
        <form onSubmit={saveSettings}>
          <div role="table" aria-label="Page settings" className="divide-y divide-border">
            <div
              role="row"
              className="hidden gap-3 px-4 py-2 text-[10px] font-medium tracking-wider text-muted-foreground uppercase sm:grid sm:grid-cols-[1fr_11rem_11rem_11rem]"
            >
              <span role="columnheader">Setting</span>
              <span role="columnheader">Value</span>
              <span role="columnheader">Build variable</span>
              <span role="columnheader">Source</span>
            </div>
            {PAGE_SETTING_DEFINITIONS.map((definition) => {
              const activeValue = settings[definition.key];
              const buildValue = BUILD_PAGE_SETTINGS[definition.key];
              const source = activeValue === buildValue ? "Build default" : "Saved local override";
              return (
                <label
                  className="grid items-center gap-2 px-4 py-3 sm:grid-cols-[1fr_11rem_11rem_11rem]"
                  role="row"
                  key={definition.key}
                >
                  <span role="cell" className="flex items-baseline gap-1.5">
                    <strong className="text-xs font-medium text-foreground">{definition.label}</strong>
                    {definition.kind === "number" ? (
                      <small className="text-[10px] text-muted-foreground">{definition.unit}</small>
                    ) : null}
                  </span>
                  <span role="cell">
                    <Input
                      type={definition.kind === "number" ? "number" : "text"}
                      min={definition.kind === "number" ? 0 : undefined}
                      step={definition.kind === "number" ? 1 : undefined}
                      value={draft[definition.key]}
                      onChange={(event) => updateDraft(definition.key, event.target.value)}
                    />
                  </span>
                  <span role="cell" className="font-mono text-[11px] text-muted-foreground">
                    {definition.envName}
                  </span>
                  <span role="cell" className="text-xs text-muted-foreground">
                    {source}
                  </span>
                </label>
              );
            })}
          </div>

          <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
            <div className="flex gap-2">
              <Button type="submit" size="sm">
                Save page settings
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={resetSettings}>
                Reset to build defaults
              </Button>
            </div>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Debug tools</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="max-w-md">
            <strong className="text-xs font-medium text-foreground">Simulate offline</strong>
            <p className="mt-1 text-xs text-muted-foreground">
              Fail all <span className="font-mono">/api/blocks</span> requests so the UI shows its
              no-connection state. Persists in this browser until turned off.
            </p>
          </div>
          <Button
            type="button"
            variant={simulateOffline ? "default" : "outline"}
            size="sm"
            aria-pressed={simulateOffline}
            onClick={onToggleSimulateOffline}
            title="Debug: pretend the backend is unreachable"
          >
            {simulateOffline ? "● simulated offline (debug)" : "○ simulate offline (debug)"}
          </Button>
        </CardContent>
      </Card>
    </section>
  );
}
