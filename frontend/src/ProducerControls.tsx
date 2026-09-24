import { useEffect, useRef, useState } from "react";
import type { useAuth } from "./useAuth";
import {
  displayNative,
  nativeControl,
  nativeGet,
  retrySameControl,
  sameIdentity,
  type NativeRow,
  type NativeStatus,
} from "./simulatorApi";

const title = (value: string) =>
  value.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

/** Authenticated pause/step/resume and bounded workload configuration.
 * Mount it keyed by run identity: a changed source must discard every
 * pending command, retry token and message rather than carry them over. */
export function ProducerControls({
  status,
  auth,
  onStatus,
}: {
  status: NativeStatus;
  auth: ReturnType<typeof useAuth>;
  onStatus: (status: NativeStatus) => void;
}) {
  const [controlResult, setControlResult] = useState("");
  const [controlError, setControlError] = useState("");
  const [controlBusy, setControlBusy] = useState(false);
  const [retryCommand, setRetryCommand] = useState<NativeRow | null>(null);
  const [payloadBytes, setPayloadBytes] = useState(64);
  const [extraRows, setExtraRows] = useState(0);
  const controlGeneration = useRef(0);

  async function control(
    action: "pause" | "resume" | "step" | "configure",
    retry = false,
  ) {
    if (
      !status.producer ||
      auth.session.role !== "admin" ||
      !auth.session.csrfToken ||
      controlBusy
    )
      return;
    const generation = ++controlGeneration.current;
    setControlBusy(true);
    setControlError("");
    setControlResult("");
    const producer = status.producer;
    const command =
      retry && retryCommand
        ? retryCommand
        : {
            commandId:
              "0x" +
              Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
                b.toString(16).padStart(2, "0"),
              ).join(""),
            runId: status.identity.runId,
            expectedRevision: producer.configRevision,
            expectedHeight: action === "step" ? producer.head.height : null,
            action,
            config:
              action === "configure"
                ? {
                    ...producer.workload,
                    payloadBytes,
                    extraRowsPerBlock: extraRows,
                  }
                : null,
          };
    try {
      const result = (await nativeControl(
        command,
        auth.session.csrfToken,
      )) as NativeRow;
      if (generation !== controlGeneration.current) return;
      setRetryCommand(null);
      setControlResult(
        `${displayNative(result.status)} · head ${displayNative((result.head as NativeRow)?.height)} · revision ${displayNative(result.configRevision)}`,
      );
    } catch (e) {
      if (generation !== controlGeneration.current) return;
      const uncertain = retrySameControl(e);
      setRetryCommand(uncertain ? command : null);
      setControlError(
        `${e instanceof Error ? e.message : "Control unavailable"}. ${uncertain ? "Retry preserves this command ID; do not create another step to guess its outcome." : "Command rejected. Refreshing producer state; a new command can be submitted."}`,
      );
      if (!uncertain) {
        try {
          const current = (await nativeGet("statistics")) as NativeStatus;
          if (
            generation === controlGeneration.current &&
            sameIdentity(current.identity, status.identity)
          )
            onStatus(current);
        } catch {
          /* Normal status polling will retry. */
        }
      }
    } finally {
      if (generation === controlGeneration.current) setControlBusy(false);
    }
  }

  useEffect(() => {
    ++controlGeneration.current;
    setControlBusy(false);
    setRetryCommand(null);
    setControlResult("");
    setControlError("");
    return () => {
      ++controlGeneration.current;
    };
  }, [auth.session.role, auth.session.user?.id]);

  return (
    <div className="sim-detail">
      <h2>Producer controls</h2>
      <p className="sim-muted">
        Pause and resume are volatile runtime controls. Step is idempotent and
        commits one normal block; workload changes take effect in the next
        block. Every command carries the run ID, expected configuration
        revision and a fresh command ID; the backend forwards it over the
        private control listener with your administrator session and CSRF
        token.
      </p>
      <div className="sim-filters">
        {(["pause", "step", "resume"] as const).map((action) => (
          <button
            key={action}
            disabled={
              controlBusy ||
              !!retryCommand ||
              !status.producer ||
              (action === "step" && !status.producer.paused)
            }
            onClick={() => void control(action)}
          >
            {title(action)}
          </button>
        ))}
        <label>
          Field payload bytes
          <input
            type="number"
            min={0}
            max={1024}
            value={payloadBytes}
            onChange={(e) => setPayloadBytes(Number(e.target.value))}
          />
        </label>
        <label>
          Extra rows / block
          <input
            type="number"
            min={0}
            max={4}
            value={extraRows}
            onChange={(e) => setExtraRows(Number(e.target.value))}
          />
        </label>
        <button
          className="secondary"
          disabled={controlBusy || !!retryCommand || !status.producer}
          onClick={() => void control("configure")}
        >
          Queue workload configuration
        </button>
      </div>
      {controlResult && <p role="status">{controlResult}</p>}
      {controlError && (
        <div className="sim-error" role="alert">
          {controlError}
        </div>
      )}
      {retryCommand && (
        <button
          className="secondary"
          disabled={controlBusy}
          onClick={() => void control(retryCommand.action as "step", true)}
        >
          Retry same command
        </button>
      )}
    </div>
  );
}
