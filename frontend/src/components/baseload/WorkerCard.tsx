import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  BASELOAD_BEHAVIOR_LABELS,
  BASELOAD_WORKER_BEHAVIORS,
  behaviorUsesPool,
  MAX_BASELOAD_ENTITIES_PER_REQUEST,
  type BaseloadWorkerBehavior,
  type BaseloadWorkerConfig,
} from "../../baseloadConfig";
import { type BaseloadTaskStatus, type BaseloadWorkerBalance } from "../../api";
import { fmtEth } from "../../format";
import { readStoredString, removeStoredValue, writeStoredString } from "../../localStorage";
import {
  BEHAVIOR_SHORT_LABELS,
  BEHAVIOR_TONE,
  CELL_ERROR_SUMMARY_MAX_LENGTH,
  ErrorDetail,
  Field,
  nativeSelectClassName,
  STATUS_TONE_BADGE,
  taskStatusTone,
} from "./shared";

const EDITABLE_WORKER_KEYS = [
  "maxGasPriceGwei",
  "opsPerMinute",
  "entitiesPerRequest",
  "singleCreatePayloadSize",
  "singleCreateStringArgumentCount",
  "singleCreateNumberArgumentCount",
  "entityPoolSize",
  "timeBombOffsetSeconds",
  "startBlock",
  "endBlock",
  "durationSeconds",
  "ttlSeconds",
] as const;

export function editableStorageKey(workerId: string, field: keyof BaseloadWorkerConfig): string {
  return `baseload.workerEdit.${workerId}.${field}`;
}

export function clearEditableStorage(workerId: string): void {
  for (const field of EDITABLE_WORKER_KEYS) {
    removeStoredValue(editableStorageKey(workerId, field));
  }
}

export function WorkerCard({
  worker,
  status,
  balance,
  tokenSymbol,
  onUpdate,
  onDelete,
}: {
  worker: BaseloadWorkerConfig;
  status: BaseloadTaskStatus | undefined;
  balance: BaseloadWorkerBalance | undefined;
  tokenSymbol: string;
  onUpdate: (patch: Partial<BaseloadWorkerConfig>) => void;
  onDelete: () => void;
}) {
  const tone = BEHAVIOR_TONE[worker.behavior];

  return (
    <Card className={cn("gap-3 border-l-4 py-3", tone.border)}>
      <CardHeader className="flex items-center justify-between gap-2 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            wallet <strong className="font-mono text-sm text-foreground">#{worker.walletNumber}</strong>
          </span>
          <Badge
            variant="outline"
            className={cn("shrink-0 border-transparent font-mono", tone.badge)}
            title={BASELOAD_BEHAVIOR_LABELS[worker.behavior]}
          >
            {BEHAVIOR_SHORT_LABELS[worker.behavior]}
          </Badge>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          title="Delete worker"
          aria-label="Delete worker"
          onClick={onDelete}
        >
          ×
        </Button>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 px-3">
        <div className="truncate font-mono text-[11px] text-muted-foreground" title={worker.walletAddress}>
          {worker.walletAddress || "address pending"}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <StatusChip status={status} />
          <span className="font-mono text-xs text-foreground">
            <BalanceCell balance={balance} tokenSymbol={tokenSymbol} />
          </span>
        </div>

        <WorkerMetrics status={status} />

        {status?.detonationAt ? (
          <div className="rounded-none border border-dashed border-destructive/50 px-2 py-1 font-mono text-[11px] text-destructive">
            detonation @ {status.detonationAt}
          </div>
        ) : null}

        {status?.status === "error" && status.message ? (
          <ErrorDetail
            className="text-[11px] text-destructive"
            message={status.message}
            maxLength={CELL_ERROR_SUMMARY_MAX_LENGTH}
          />
        ) : null}

        <div className="grid grid-cols-2 gap-2 border-t border-border pt-3 sm:grid-cols-3">
          <Field label="Behavior" className="col-span-2 sm:col-span-3">
            <select
              className={nativeSelectClassName}
              value={worker.behavior}
              onChange={(event) =>
                onUpdate({ behavior: event.target.value as BaseloadWorkerBehavior })
              }
            >
              {BASELOAD_WORKER_BEHAVIORS.map((behavior) => (
                <option key={behavior} value={behavior}>
                  {BASELOAD_BEHAVIOR_LABELS[behavior]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Max gas gwei">
            <EditableNumber
              storageKey={editableStorageKey(worker.id, "maxGasPriceGwei")}
              value={worker.maxGasPriceGwei}
              min={0}
              step="0.1"
              onChange={(value) => {
                if (value !== null) onUpdate({ maxGasPriceGwei: value });
              }}
            />
          </Field>
          <Field label="Ops / min">
            <EditableNumber
              storageKey={editableStorageKey(worker.id, "opsPerMinute")}
              value={worker.opsPerMinute}
              min={0}
              step="1"
              onChange={(value) => {
                if (value !== null) onUpdate({ opsPerMinute: value });
              }}
            />
          </Field>
          <Field label="Entities / req">
            <EditableNumber
              storageKey={editableStorageKey(worker.id, "entitiesPerRequest")}
              value={worker.entitiesPerRequest}
              min={1}
              max={MAX_BASELOAD_ENTITIES_PER_REQUEST}
              step="1"
              integer
              onChange={(value) => {
                if (value !== null) onUpdate({ entitiesPerRequest: value });
              }}
            />
          </Field>
          <Field label="Payload bytes">
            <EditableNumber
              storageKey={editableStorageKey(worker.id, "singleCreatePayloadSize")}
              value={worker.singleCreatePayloadSize}
              min={0}
              step="1"
              integer
              onChange={(value) => {
                if (value !== null) onUpdate({ singleCreatePayloadSize: value });
              }}
            />
          </Field>
          <Field label="String args">
            <EditableNumber
              storageKey={editableStorageKey(worker.id, "singleCreateStringArgumentCount")}
              value={worker.singleCreateStringArgumentCount}
              min={0}
              step="1"
              integer
              onChange={(value) => {
                if (value !== null) onUpdate({ singleCreateStringArgumentCount: value });
              }}
            />
          </Field>
          <Field label="Number args">
            <EditableNumber
              storageKey={editableStorageKey(worker.id, "singleCreateNumberArgumentCount")}
              value={worker.singleCreateNumberArgumentCount}
              min={0}
              step="1"
              integer
              onChange={(value) => {
                if (value !== null) onUpdate({ singleCreateNumberArgumentCount: value });
              }}
            />
          </Field>
          {behaviorUsesPool(worker.behavior) ? (
            <Field label="Pool size">
              <EditableNumber
                storageKey={editableStorageKey(worker.id, "entityPoolSize")}
                value={worker.entityPoolSize}
                min={1}
                step="1"
                integer
                onChange={(value) => {
                  if (value !== null) onUpdate({ entityPoolSize: value });
                }}
              />
            </Field>
          ) : null}
          {worker.behavior === "time-bomb" ? (
            <Field label="Bomb offset s">
              <EditableNumber
                storageKey={editableStorageKey(worker.id, "timeBombOffsetSeconds")}
                value={worker.timeBombOffsetSeconds}
                min={1}
                step="1"
                integer
                onChange={(value) => {
                  if (value !== null) onUpdate({ timeBombOffsetSeconds: value });
                }}
              />
            </Field>
          ) : null}
          <Field label="Start block">
            <EditableNumber
              storageKey={editableStorageKey(worker.id, "startBlock")}
              value={worker.startBlock}
              min={0}
              step="1"
              integer
              onChange={(value) => {
                if (value !== null) onUpdate({ startBlock: value });
              }}
            />
          </Field>
          <Field label="End block">
            <EditableNumber
              storageKey={editableStorageKey(worker.id, "endBlock")}
              value={worker.endBlock}
              min={0}
              step="1"
              integer
              placeholder="Infinity"
              onChange={(value) => onUpdate({ endBlock: value })}
            />
          </Field>
          <Field label="Duration s">
            <EditableNumber
              storageKey={editableStorageKey(worker.id, "durationSeconds")}
              value={worker.durationSeconds}
              min={1}
              step="1"
              integer
              onChange={(value) => onUpdate({ durationSeconds: value })}
            />
          </Field>
          {worker.behavior === "time-bomb" ? (
            <Field label="TTL s">
              <span
                className="flex h-7 items-center px-2.5 text-xs text-muted-foreground"
                title="TTL targets the detonation moment automatically"
              >
                auto
              </span>
            </Field>
          ) : (
            <Field label="TTL s">
              <EditableNumber
                storageKey={editableStorageKey(worker.id, "ttlSeconds")}
                value={worker.ttlSeconds}
                min={1}
                step="1"
                integer
                onChange={(value) => {
                  if (value !== null) onUpdate({ ttlSeconds: value });
                }}
              />
            </Field>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function StatusChip({ status }: { status: BaseloadTaskStatus | undefined }) {
  const name = status?.status ?? "starting";
  const tone = taskStatusTone(name);
  const title =
    status && status.status !== "error"
      ? [status.message, status.entityKey ? `entity ${status.entityKey}` : null]
          .filter((part) => part)
          .join(" — ") || undefined
      : undefined;
  const pulsing = name === "running" || name === "waiting";
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 border-transparent font-mono", STATUS_TONE_BADGE[tone])}
      title={title}
    >
      <span className={cn("size-1.5 rounded-full bg-current", pulsing && "animate-pulse")} aria-hidden="true" />
      {name}
    </Badge>
  );
}

function WorkerMetrics({ status }: { status: BaseloadTaskStatus | undefined }) {
  if (!status) return null;
  const items: { label: string; value: string }[] = [];
  if (status.createdCount) items.push({ label: "created", value: String(status.createdCount) });
  if (status.updatedCount) items.push({ label: "updated", value: String(status.updatedCount) });
  if (status.deletedCount) items.push({ label: "deleted", value: String(status.deletedCount) });
  if (status.ownershipChangedCount) {
    items.push({ label: "owned", value: String(status.ownershipChangedCount) });
  }
  if (status.attemptedCount !== undefined) {
    items.push({ label: "tries", value: String(status.attemptedCount) });
  }
  if (status.poolSize) items.push({ label: "pool", value: String(status.poolSize) });
  if (status.currentBlock !== undefined) {
    items.push({ label: "block", value: String(status.currentBlock) });
  }
  if (status.txHash) items.push({ label: "tx", value: shortHash(status.txHash) });
  if (items.length === 0) return null;
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 rounded-none bg-muted/50 px-2.5 py-1.5 font-mono text-[11px]">
      {items.map((item) => (
        <div
          key={item.label}
          className="flex items-baseline gap-1.5"
          title={item.label === "tx" ? status.txHash : undefined}
        >
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className="font-medium text-foreground">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function BalanceCell({ balance, tokenSymbol }: { balance: BaseloadWorkerBalance | undefined; tokenSymbol: string }) {
  if (!balance) return <span title="No balance reported yet">—</span>;
  const label = `${fmtEth(balance.balanceWei)} ${tokenSymbol}`;
  if (balance.error) {
    return (
      <span
        className="flex flex-col gap-1 text-destructive"
        title={`${balance.balanceWei} wei (last updated ${balance.updatedAt})`}
      >
        <span>{label}</span>
        <ErrorDetail
          className="text-[11px] text-destructive"
          message={`RPC error: ${balance.error}`}
          maxLength={CELL_ERROR_SUMMARY_MAX_LENGTH}
        />
      </span>
    );
  }
  return (
    <span title={`${balance.balanceWei} wei (updated ${balance.updatedAt})`}>{label}</span>
  );
}

function shortHash(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function EditableNumber({
  storageKey,
  value,
  min,
  max,
  step,
  integer = false,
  placeholder,
  onChange,
}: {
  storageKey: string;
  value: number | null;
  min: number;
  max?: number;
  step: string;
  integer?: boolean;
  placeholder?: string;
  onChange: (value: number | null) => void;
}) {
  const [text, setText] = useState(() => readStoredString(storageKey, value === null ? "" : String(value)));

  useEffect(() => {
    setText(readStoredString(storageKey, value === null ? "" : String(value)));
  }, [storageKey, value]);

  const commit = () => {
    if (text.trim() === "") {
      removeStoredValue(storageKey);
      onChange(null);
      return;
    }
    const next = Number(text);
    if (
      !Number.isFinite(next) ||
      next < min ||
      (max !== undefined && next > max) ||
      (integer && !Number.isInteger(next))
    ) {
      removeStoredValue(storageKey);
      setText(value === null ? "" : String(value));
      return;
    }
    removeStoredValue(storageKey);
    onChange(next);
  };

  const updateText = (value: string) => {
    setText(value);
    writeStoredString(storageKey, value);
  };

  return (
    <Input
      className="h-7 font-mono text-xs"
      type="number"
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      value={text}
      onChange={(event) => updateText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
    />
  );
}
