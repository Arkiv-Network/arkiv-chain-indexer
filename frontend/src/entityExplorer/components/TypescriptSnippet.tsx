// The current query as SDK code, ready to paste into an app.

import sdkPackage from "@arkiv-network/sdk/package.json";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { copyText } from "@/components/copy-cell";
import { typescriptSnippet } from "../lib/query";

// Read from the installed package: the dependency is a local tarball, so
// package.json holds a file path rather than a version.
const SDK_VERSION = sdkPackage.version;

export function TypescriptSnippet({ query }: { query: string }) {
  const code = typescriptSnippet(query, SDK_VERSION);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timeout);
  }, [copied]);
  return (
    <div className="relative min-w-0 border border-input bg-muted">
      <button
        type="button"
        className="absolute top-2 right-2 inline-flex size-6 items-center justify-center border border-border bg-background text-muted-foreground transition-colors hover:border-accent hover:text-accent"
        title="Copy TypeScript"
        aria-label="Copy TypeScript"
        onClick={async () => {
          if (await copyText(code)) setCopied(true);
        }}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
      <pre className="h-full max-h-96 overflow-auto p-3 pr-10 font-mono text-[11px] leading-relaxed text-foreground">{code}</pre>
    </div>
  );
}
