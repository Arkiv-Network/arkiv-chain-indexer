import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { type StoredBaseloadConfigSummary } from "../../api";
import { Field, nativeSelectClassName } from "./shared";

interface ConfigManagerBarProps {
  savedConfigs: StoredBaseloadConfigSummary[];
  selectedConfigName: string;
  onSelectedConfigNameChange: (name: string) => void;
  configName: string;
  onConfigNameChange: (name: string) => void;
  onLoad: () => void;
  onDelete: () => void;
  onSave: () => void;
  onRefresh: () => void;
}

export function ConfigManagerBar({
  savedConfigs,
  selectedConfigName,
  onSelectedConfigNameChange,
  configName,
  onConfigNameChange,
  onLoad,
  onDelete,
  onSave,
  onRefresh,
}: ConfigManagerBarProps) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-end gap-2">
        <Field label="Saved config" className="w-48">
          <select
            className={nativeSelectClassName}
            value={selectedConfigName}
            onChange={(event) => onSelectedConfigNameChange(event.target.value)}
            disabled={savedConfigs.length === 0}
          >
            {savedConfigs.length === 0 ? (
              <option value="">No saved configs</option>
            ) : (
              savedConfigs.map((saved) => (
                <option key={saved.name} value={saved.name}>
                  {saved.name} ({saved.workerCount})
                </option>
              ))
            )}
          </select>
        </Field>
        <Button type="button" variant="outline" size="sm" onClick={onLoad} disabled={!selectedConfigName}>
          Load selected
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onDelete} disabled={!selectedConfigName}>
          Delete saved
        </Button>
        <Field label="Config name" className="w-48">
          <Input
            type="text"
            value={configName}
            onChange={(event) => onConfigNameChange(event.target.value)}
            placeholder="mainnet low gas"
          />
        </Field>
        <Button type="button" variant="outline" size="sm" onClick={onSave}>
          Save current
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onRefresh}>
          Refresh
        </Button>
      </CardContent>
    </Card>
  );
}
