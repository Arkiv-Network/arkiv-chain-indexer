import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "./icons";
import { cn } from "@/lib/utils";

interface InfoTooltipProps {
  label: string;
  children: React.ReactNode;
  size?: number;
}

type Placement = "top" | "bottom";

interface PopupPosition {
  top: number;
  left: number;
  arrowLeft: number;
  placement: Placement;
}

const VIEWPORT_MARGIN = 8;

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
    const triggerRect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const triggerCenter = triggerRect.left + triggerRect.width / 2;

    const popup = popupRef.current;
    // Fall back to a reasonable estimate before the popup has rendered.
    const popupWidth = popup ? popup.offsetWidth : Math.min(320, viewportWidth - VIEWPORT_MARGIN * 2);
    const popupHeight = popup ? popup.offsetHeight : 0;

    const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - popupWidth - VIEWPORT_MARGIN);
    const desiredLeft = triggerCenter - popupWidth / 2;
    const left = Math.min(Math.max(desiredLeft, VIEWPORT_MARGIN), maxLeft);

    const spaceBelow = viewportHeight - triggerRect.bottom;
    const spaceAbove = triggerRect.top;
    const wantsBottom = spaceBelow >= popupHeight + 8 || spaceBelow >= spaceAbove;
    const placement: Placement = wantsBottom ? "bottom" : "top";
    const top = placement === "bottom" ? triggerRect.bottom + 8 : triggerRect.top - popupHeight - 8;

    const arrowLeft = Math.min(Math.max(triggerCenter - left, 12), popupWidth - 12);

    setPosition({ top, left, arrowLeft, placement });
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

  // After the popup is in the DOM, re-measure so we can clamp using the real width/height.
  useLayoutEffect(() => {
    if (!open) return;
    if (!popupRef.current) return;
    updatePosition();
  }, [open, updatePosition, children]);

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
    <span className="relative inline-flex items-center leading-none" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          "inline-flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          pinned && "text-foreground",
        )}
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
      {open
        ? createPortal(
            <div
              ref={popupRef}
              id={popupId}
              role="tooltip"
              className="fixed z-[1000] w-max max-w-[min(480px,calc(100vw-16px))] rounded-md border border-border bg-popover px-3.5 py-3 text-xs leading-relaxed text-popover-foreground shadow-md [&_p+p]:mt-2 [&_p]:m-0 [&_p]:text-muted-foreground [&_strong]:mb-1.5 [&_strong]:block [&_strong]:text-[13px] [&_strong]:font-semibold"
              data-placement={position?.placement ?? "bottom"}
              style={{
                top: position?.top ?? -9999,
                left: position?.left ?? -9999,
                visibility: position ? "visible" : "hidden",
              }}
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
