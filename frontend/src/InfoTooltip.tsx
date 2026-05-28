import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "./icons";

interface InfoTooltipProps {
  label: string;
  children: React.ReactNode;
  size?: number;
}

interface PopupPosition {
  top: number;
  left: number;
}

export function InfoTooltip({ label, children, size = 14 }: InfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState<PopupPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const popupId = useId();

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setPosition({
      top: rect.bottom + 8,
      left: rect.left + rect.width / 2,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!pinned) return;
    const onDocClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target)) return;
      if (popupRef.current?.contains(target)) return;
      setPinned(false);
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPinned(false);
        setOpen(false);
        triggerRef.current?.blur();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [pinned]);

  const handleClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setPinned((current) => {
      const next = !current;
      setOpen(next);
      return next;
    });
  }, []);

  const handleEnter = useCallback(() => {
    if (!pinned) setOpen(true);
  }, [pinned]);

  const handleLeave = useCallback(() => {
    if (!pinned) setOpen(false);
  }, [pinned]);

  const handleFocus = useCallback(() => setOpen(true), []);
  const handleBlur = useCallback(() => {
    if (!pinned) setOpen(false);
  }, [pinned]);

  return (
    <span className="info-tooltip" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <button
        ref={triggerRef}
        type="button"
        className={`info-tooltip-trigger${pinned ? " is-pinned" : ""}`}
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? popupId : undefined}
        onClick={handleClick}
        onFocus={handleFocus}
        onBlur={handleBlur}
        style={{ width: size, height: size }}
      >
        <Info size={size} />
      </button>
      {open && position
        ? createPortal(
            <div
              ref={popupRef}
              id={popupId}
              role="tooltip"
              className="info-tooltip-popup"
              style={{ top: position.top, left: position.left }}
              onMouseEnter={handleEnter}
              onMouseLeave={handleLeave}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
