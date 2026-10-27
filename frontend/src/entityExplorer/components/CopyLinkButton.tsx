// Copies the permalink of the last run: the query, its page size and filter.

import { useEffect, useState } from "react";
import { copyText } from "@/components/copy-cell";
import { Button } from "@/components/ui/button";

export function CopyLinkButton({ href }: { href: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      title={href}
      onClick={async () => {
        // Clipboard unavailable (e.g. insecure context): the address bar already holds the same link.
        if (await copyText(href)) setCopied(true);
      }}
    >
      {copied ? "Copied" : "Copy link"}
    </Button>
  );
}
