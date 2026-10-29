import { Fragment } from "react";
import { strValueParts, type StrValuePart } from "@/attributes";

/**
 * A str value with its control and spoofing characters as visible escapes,
 * each set apart from the text around it so `\n` the escape never reads as a
 * backslash and an `n`. A `\n` is shown, never followed: the value stays on
 * one line.
 */
export function StrValue({ text, parts = strValueParts(text) }: { text: string; parts?: readonly StrValuePart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.kind === "text" ? (
          <Fragment key={index}>{part.text}</Fragment>
        ) : (
          <span
            key={index}
            className="mx-px rounded-[2px] bg-muted px-0.5 font-mono text-muted-foreground"
            title={part.title}
          >
            {part.text}
          </span>
        ),
      )}
    </>
  );
}
