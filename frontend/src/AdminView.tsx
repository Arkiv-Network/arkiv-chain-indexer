import { useEffect, useState } from "react";
import {
  BUILD_PAGE_SETTINGS,
  PAGE_SETTING_DEFINITIONS,
  type PageSettings,
  type EditablePageSettingsKey,
  normalizeSettingsDraft,
  settingsToDraft,
} from "./pageSettings";

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
    <section className="admin-view">
      <div className="admin-view-header">
        <div>
          <p className="home-kicker">admin</p>
          <h2>Page settings</h2>
        </div>
        <div className="admin-view-status">
          <span>Build defaults from Vite</span>
          <strong>{BUILD_PAGE_SETTINGS.chainName}</strong>
        </div>
      </div>

      <form className="admin-settings-form" onSubmit={saveSettings}>
        <div className="admin-settings-table" role="table" aria-label="Page settings">
          <div className="admin-settings-row admin-settings-row--head" role="row">
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
              <label className="admin-settings-row" role="row" key={definition.key}>
                <span role="cell">
                  <strong>{definition.label}</strong>
                  {definition.kind === "number" ? <small>{definition.unit}</small> : null}
                </span>
                <span role="cell">
                  <input
                    type={definition.kind === "number" ? "number" : "text"}
                    min={definition.kind === "number" ? 0 : undefined}
                    step={definition.kind === "number" ? 1 : undefined}
                    value={draft[definition.key]}
                    onChange={(event) => updateDraft(definition.key, event.target.value)}
                  />
                </span>
                <span role="cell" className="mono">
                  {definition.envName}
                </span>
                <span role="cell">{source}</span>
              </label>
            );
          })}
        </div>

        {error ? <p className="summary error">{error}</p> : null}
        {message ? <p className="summary">{message}</p> : null}

        <div className="button-row">
          <button type="submit">Save page settings</button>
          <button type="button" className="secondary" onClick={resetSettings}>
            Reset to build defaults
          </button>
        </div>
      </form>

      <div className="admin-debug-tools">
        <h3>Debug tools</h3>
        <div className="admin-debug-row">
          <div>
            <strong>Simulate offline</strong>
            <p>
              Fail all <span className="mono">/api/blocks</span> requests so the UI shows its
              no-connection state. Persists in this browser until turned off.
            </p>
          </div>
          <button
            type="button"
            className={`home-debug-toggle${simulateOffline ? " active" : ""}`}
            aria-pressed={simulateOffline}
            onClick={onToggleSimulateOffline}
            title="Debug: pretend the backend is unreachable"
          >
            {simulateOffline ? "● simulated offline (debug)" : "○ simulate offline (debug)"}
          </button>
        </div>
      </div>
    </section>
  );
}
