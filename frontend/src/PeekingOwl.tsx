import { useEffect, useRef, useState, type AnimationEvent } from "react";

// Decorative owl that peeks over the top edge of a panel/list, watches for 4
// blinks, then ducks away behind the panel until `progress` has advanced by 3
// — then it pops back up. Purely cosmetic. `progress` is whatever monotonically
// increasing signal the host wants to gate the owl on (e.g. the latest block
// number on the home feed, or a refresh tick on the leaderboard).
const OWL_BLINKS_BEFORE_HIDING = 4;
const OWL_PROGRESS_AWAY = 3;

const OWL_INITIAL_HIDDEN_MS = 3000;

export function PeekingOwl({ progress }: { progress: number | null }) {
  // "initial" — hidden for a few seconds after load; "peeking" — up and
  // blinking; "away" — ducked behind the panel until progress advances by 3.
  const [phase, setPhase] = useState<"initial" | "peeking" | "away">("initial");
  const blinkCount = useRef(0);
  const hiddenSinceProgress = useRef<number | null>(null);

  // Stay hidden briefly on page load, then make the first appearance.
  useEffect(() => {
    const timer = window.setTimeout(() => setPhase("peeking"), OWL_INITIAL_HIDDEN_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // Count blinks while peeking; after the 4th, duck away.
  const onIteration = (event: AnimationEvent) => {
    if (event.animationName !== "home-owl-blink" || phase !== "peeking") return;
    blinkCount.current += 1;
    if (blinkCount.current >= OWL_BLINKS_BEFORE_HIDING) {
      hiddenSinceProgress.current = progress;
      setPhase("away");
    }
  };

  // While away, reappear once progress has advanced by 3.
  useEffect(() => {
    if (phase !== "away" || progress === null) return;
    if (hiddenSinceProgress.current === null) {
      hiddenSinceProgress.current = progress;
      return;
    }
    if (progress - hiddenSinceProgress.current >= OWL_PROGRESS_AWAY) {
      blinkCount.current = 0;
      setPhase("peeking");
    }
  }, [progress, phase]);

  return (
    <span
      className={`home-owl${phase === "peeking" ? " is-peeking" : ""}`}
      aria-hidden="true"
      // Stay fully hidden until the first peek begins — otherwise the owl
      // flashes in its un-positioned spot on load before it ducks. Inline so it
      // applies on the very first paint, before the stylesheet is in effect.
      style={{ visibility: phase === "initial" ? "hidden" : "visible" }}
      onAnimationIteration={onIteration}
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
        <g className="home-owl-eyes">
          <circle cx="43" cy="57" r="16.5" fill="#FBF7EF" />
          <circle cx="77" cy="57" r="16.5" fill="#FBF7EF" />
          {/* pupils wander to random-ish angles, always biased down-and-left */}
          <g className="home-owl-pupils">
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
