import { useEffect, useRef, useState, type AnimationEvent } from "react";

// Cedric — full name "Cedric The Owl". A decorative owl that peeks over the top
// edge of a panel/list, watches for 4 blinks, then ducks away behind the panel
// until `progress` has advanced by 3 — then he pops back up. Purely cosmetic.
// `progress` is whatever monotonically increasing signal the host wants to gate
// Cedric on (e.g. the latest block number on the home feed, or a refresh tick on
// the leaderboard).
const CEDRIC_BLINKS_BEFORE_HIDING = 4;
const CEDRIC_PROGRESS_AWAY = 3;

const CEDRIC_INITIAL_HIDDEN_MS = 3000;

// Drives Cedric on a self-contained timer for views that have no natural
// monotonic signal (e.g. the transactions table, which only loads on demand).
// Keeping the tick state here means the host view doesn't re-render every tick.
export function CedricOnTimer({ intervalMs = 6000 }: { intervalMs?: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((value) => value + 1), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return <Cedric progress={tick} />;
}

export function Cedric({
  progress,
  initiallyVisible = false,
  canHide = true,
}: {
  progress: number | null;
  initiallyVisible?: boolean;
  canHide?: boolean;
}) {
  // "initial" — hidden for a few seconds after load; "peeking" — up and
  // blinking; "away" — ducked behind the panel until progress advances by 3.
  const [phase, setPhase] = useState<"initial" | "peeking" | "away">(
    initiallyVisible ? "peeking" : "initial",
  );
  const blinkCount = useRef(0);
  const hiddenSinceProgress = useRef<number | null>(null);

  // Stay hidden briefly on page load, then make the first appearance.
  useEffect(() => {
    if (initiallyVisible) return;
    const timer = window.setTimeout(() => setPhase("peeking"), CEDRIC_INITIAL_HIDDEN_MS);
    return () => window.clearTimeout(timer);
  }, [initiallyVisible]);

  // Count blinks while peeking; after the 4th, duck away.
  const onIteration = (event: AnimationEvent) => {
    if (event.animationName !== "cedric-blink" || phase !== "peeking") return;
    blinkCount.current += 1;
    if (canHide && blinkCount.current >= CEDRIC_BLINKS_BEFORE_HIDING) {
      hiddenSinceProgress.current = progress;
      setPhase("away");
    }
  };

  // While away, reappear once progress has advanced by 3.
  useEffect(() => {
    if (!canHide || phase !== "away" || progress === null) return;
    if (hiddenSinceProgress.current === null) {
      hiddenSinceProgress.current = progress;
      return;
    }
    if (progress - hiddenSinceProgress.current >= CEDRIC_PROGRESS_AWAY) {
      blinkCount.current = 0;
      setPhase("peeking");
    }
  }, [canHide, progress, phase]);

  return (
    <span
      className={`cedric${phase === "peeking" ? " is-peeking" : ""}`}
      aria-hidden="true"
      // Stay fully hidden until the first peek begins — otherwise Cedric
      // flashes in his un-positioned spot on load before he ducks. Inline so it
      // applies on the very first paint, before the stylesheet is in effect.
      style={{ visibility: phase === "initial" ? "hidden" : "visible" }}
      onAnimationIteration={canHide ? onIteration : undefined}
    >
      <svg viewBox="0 0 120 130" xmlns="http://www.w3.org/2000/svg">
        {/* ear tufts */}
        <path d="M30 28 L41 7 L54 31 Z" fill="#6E4B30" />
        <path d="M90 28 L79 7 L66 31 Z" fill="#6E4B30" />
        {/* body (mostly hidden behind the panel) */}
        <path d="M16 72 Q16 130 60 130 Q104 130 104 72 Z" fill="#6E4B30" />
        {/* head */}
        <ellipse cx="60" cy="58" rx="45" ry="43" fill="#6E4B30" />
        {/* belly + face disc */}
        <ellipse cx="60" cy="94" rx="31" ry="34" fill="#C49A6C" />
        <ellipse cx="60" cy="57" rx="37" ry="34" fill="#C49A6C" />
        {/* brows */}
        <path d="M28 41 Q44 31 57 43" stroke="#5A3C26" strokeWidth="4" fill="none" strokeLinecap="round" />
        <path d="M92 41 Q76 31 63 43" stroke="#5A3C26" strokeWidth="4" fill="none" strokeLinecap="round" />
        {/* eyes — grouped so they can blink; pupils sit low to look down at the blocks */}
        <g className="cedric-eyes">
          <circle cx="43" cy="57" r="16.5" fill="#FBF7EF" />
          <circle cx="77" cy="57" r="16.5" fill="#FBF7EF" />
          {/* pupils wander to random-ish angles, always biased down-and-left */}
          <g className="cedric-pupils">
            <circle cx="43" cy="57" r="7.6" fill="#2A2320" />
            <circle cx="77" cy="57" r="7.6" fill="#2A2320" />
            <circle cx="40" cy="54" r="2.3" fill="#FFFFFF" />
            <circle cx="74" cy="54" r="2.3" fill="#FFFFFF" />
          </g>
        </g>
        {/* beak */}
        <path d="M60 65 L68 73 Q60 82 52 73 Z" fill="#FE7446" />
      </svg>
    </span>
  );
}
