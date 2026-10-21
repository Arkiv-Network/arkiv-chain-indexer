// A query the node rejected, explained, with a caret under the spot a syntax
// error points at.

import { describeQueryError, locateQueryPosition } from "../lib/query";

export function QueryError({ error, query }: { error: unknown; query: string | null }) {
  const described = describeQueryError(error);
  const location = described.position !== null && query ? locateQueryPosition(query, described.position) : null;
  return (
    <div className="flex flex-col gap-2 border border-destructive/30 bg-destructive/5 p-3" role="alert">
      <p className="text-xs text-destructive">
        <strong className="font-semibold">{described.title}.</strong> {described.detail}
      </p>
      {location ? (
        <pre className="overflow-x-auto bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-destructive">
          {location.lineText}
          {"\n"}
          {" ".repeat(location.column)}^
          {query && query.includes("\n") ? ` line ${location.line + 1}, column ${location.column + 1}` : ` column ${location.column + 1}`}
        </pre>
      ) : null}
    </div>
  );
}
