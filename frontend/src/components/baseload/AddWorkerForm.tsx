import type { ChangeEvent, FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  BASELOAD_BEHAVIOR_LABELS,
  BASELOAD_WORKER_BEHAVIORS,
  behaviorUsesPool,
  MAX_BASELOAD_ENTITIES_PER_REQUEST,
  type BaseloadWorkerBehavior,
  type BaseloadWorkerDraft,
} from "../../baseloadConfig";
import { BEHAVIOR_SHORT_LABELS, BEHAVIOR_TONE, Field, nativeSelectClassName } from "./shared";

interface AddWorkerFormProps {
  draft: BaseloadWorkerDraft;
  draftBehavior: BaseloadWorkerBehavior;
  availableWallets: number[];
  onDraftChange: (
    key: keyof BaseloadWorkerDraft,
  ) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  onSubmit: (event: FormEvent) => void;
}

export function AddWorkerForm({
  draft,
  draftBehavior,
  availableWallets,
  onDraftChange,
  onSubmit,
}: AddWorkerFormProps) {
  const tone = BEHAVIOR_TONE[draftBehavior];

  return (
    <form onSubmit={onSubmit} noValidate>
      <Card className={cn("gap-3 border-l-4 py-3", tone.border)}>
        <CardHeader className="px-3">
          <CardTitle>Add worker</CardTitle>
          <CardDescription className="font-mono">
            {BASELOAD_BEHAVIOR_LABELS[draftBehavior]}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-3">
          <div role="radiogroup" aria-label="Worker behavior" className="flex flex-wrap gap-1.5">
            {BASELOAD_WORKER_BEHAVIORS.map((behavior) => {
              const checked = draftBehavior === behavior;
              const optionTone = BEHAVIOR_TONE[behavior];
              return (
                <label
                  key={behavior}
                  className={cn(
                    "cursor-pointer rounded-none border px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors",
                    checked
                      ? cn("border-transparent", optionTone.badge)
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                  title={BASELOAD_BEHAVIOR_LABELS[behavior]}
                >
                  <input
                    type="radio"
                    name="draft-behavior"
                    value={behavior}
                    checked={checked}
                    onChange={onDraftChange("behavior")}
                    className="sr-only"
                  />
                  {BEHAVIOR_SHORT_LABELS[behavior]}
                </label>
              );
            })}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            <Field label="Wallet">
              <select
                className={nativeSelectClassName}
                value={draft.walletNumber}
                onChange={onDraftChange("walletNumber")}
                disabled={availableWallets.length === 0}
              >
                {availableWallets.map((wallet) => (
                  <option key={wallet} value={wallet}>
                    #{wallet}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Max gas gwei">
              <Input
                type="number"
                min="0"
                step="0.1"
                value={draft.maxGasPriceGwei}
                onChange={onDraftChange("maxGasPriceGwei")}
              />
            </Field>
            <Field label="Ops / min">
              <Input
                type="number"
                min="0"
                step="1"
                value={draft.opsPerMinute}
                onChange={onDraftChange("opsPerMinute")}
              />
            </Field>
            <Field label="Entities / req">
              <Input
                type="number"
                min="1"
                max={MAX_BASELOAD_ENTITIES_PER_REQUEST}
                step="1"
                value={draft.entitiesPerRequest}
                onChange={onDraftChange("entitiesPerRequest")}
              />
            </Field>
            <Field label="Payload bytes">
              <Input
                type="number"
                min="0"
                step="1"
                value={draft.singleCreatePayloadSize}
                onChange={onDraftChange("singleCreatePayloadSize")}
              />
            </Field>
            <Field label="String args">
              <Input
                type="number"
                min="0"
                step="1"
                value={draft.singleCreateStringArgumentCount}
                onChange={onDraftChange("singleCreateStringArgumentCount")}
              />
            </Field>
            <Field label="Number args">
              <Input
                type="number"
                min="0"
                step="1"
                value={draft.singleCreateNumberArgumentCount}
                onChange={onDraftChange("singleCreateNumberArgumentCount")}
              />
            </Field>
            {behaviorUsesPool(draftBehavior) ? (
              <Field label="Pool size">
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={draft.entityPoolSize}
                  onChange={onDraftChange("entityPoolSize")}
                />
              </Field>
            ) : null}
            {draftBehavior === "time-bomb" ? (
              <Field label="Bomb offset s">
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={draft.timeBombOffsetSeconds}
                  onChange={onDraftChange("timeBombOffsetSeconds")}
                />
              </Field>
            ) : null}
            <Field label="Start block">
              <Input
                type="number"
                min="0"
                step="1"
                value={draft.startBlock}
                onChange={onDraftChange("startBlock")}
              />
            </Field>
            <Field label="End block">
              <Input
                type="number"
                min="0"
                step="1"
                placeholder="Infinity"
                value={draft.endBlock}
                onChange={onDraftChange("endBlock")}
              />
            </Field>
            <Field label="Duration s">
              <Input
                type="number"
                min="1"
                step="1"
                placeholder="Forever"
                value={draft.durationSeconds}
                onChange={onDraftChange("durationSeconds")}
              />
            </Field>
            {draftBehavior === "time-bomb" ? (
              <Field label="TTL s">
                <span
                  className="flex h-8 items-center px-2.5 text-xs text-muted-foreground"
                  title="TTL targets the detonation moment automatically"
                >
                  auto
                </span>
              </Field>
            ) : (
              <Field label="TTL s">
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={draft.ttlSeconds}
                  onChange={onDraftChange("ttlSeconds")}
                />
              </Field>
            )}
          </div>

          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={availableWallets.length === 0}>
              {availableWallets.length === 0 ? "Add worker" : `Add worker #${draft.walletNumber}`}
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
