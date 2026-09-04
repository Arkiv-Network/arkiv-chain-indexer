import { Check, Copy } from "lucide-react";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return copyTextFallback(value);
  }
}

function copyTextFallback(value: string): boolean {
  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  document.body.appendChild(textArea);
  textArea.select();

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textArea);
  }
}

/** Small icon button that copies `value` to the clipboard and flashes a checkmark. */
export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const onCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    // Copy buttons are often nested inside a clickable row/card.
    event.stopPropagation();
    if (await copyText(value)) setCopied(true);
  };

  return (
    <button
      type="button"
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-none border border-border text-muted-foreground opacity-70 transition-colors hover:border-accent hover:text-accent hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
        className,
      )}
      aria-label={`Copy ${label}`}
      title={copied ? "Copied" : `Copy ${label}`}
      onClick={onCopy}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}

/**
 * A truncated mono value (optionally a link) paired with a copy button. Used
 * for hashes and addresses across the tx/block/sender tables.
 */
export function CopyCell({
  value,
  label,
  title,
  copyLabel,
  href,
  external = false,
  onClick,
  className,
}: {
  value: string | null | undefined;
  label: string;
  title?: string;
  copyLabel: string;
  href?: string | null;
  external?: boolean;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  className?: string;
}) {
  const copyValue = value?.trim();

  if (!copyValue) {
    return (
      <span className={cn("truncate font-mono text-xs", className)} title={title}>
        {label}
      </span>
    );
  }

  const text = href ? (
    <a
      className="truncate font-mono text-xs text-foreground transition-colors hover:text-accent hover:underline"
      title={title ?? copyValue}
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      onClick={onClick}
    >
      {label}
    </a>
  ) : (
    <span className="truncate font-mono text-xs" title={title ?? copyValue}>
      {label}
    </span>
  );

  return (
    <span
      className={cn(
        "grid w-fit max-w-full grid-cols-[minmax(0,max-content)_auto] items-center gap-1.5",
        className,
      )}
    >
      {text}
      <CopyButton value={copyValue} label={copyLabel} />
    </span>
  );
}

export function MutedValue({ children }: { children: ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>;
}
