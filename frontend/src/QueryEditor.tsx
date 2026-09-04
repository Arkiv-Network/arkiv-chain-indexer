// The CodeMirror editor for entity queries. This file is the lazy chunk: the
// Data page imports it with React.lazy so CodeMirror only loads on /data.
//
// The editor is controlled from the outside: `value` is the source of truth,
// edits report through `onChange`, and a `value` that differs from the document
// (an example chip, a filter added from a result, a shared link) is pushed in.

import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { useEffect, useRef } from "react";
import "./queryEditor.css";
import { arkivQueryLanguage } from "./queryLanguage";

export interface QueryEditorProps {
  value: string;
  onChange: (value: string) => void;
  onExecute: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

const editorTheme = EditorView.theme({
  "&": {
    fontSize: "0.8125rem",
    backgroundColor: "transparent",
    color: "var(--color-foreground)",
  },
  ".cm-content": {
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    padding: "0.6rem 0",
    minHeight: "3.4rem",
    caretColor: "var(--color-foreground)",
  },
  ".cm-line": { padding: "0 0.75rem" },
  ".cm-gutters": { display: "none" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "auto", lineHeight: "1.5" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-foreground)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--color-accent) !important",
    opacity: "0.35",
  },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-placeholder": { color: "var(--color-muted-foreground)", fontStyle: "normal" },
  ".cm-tooltip": {
    backgroundColor: "var(--color-popover)",
    color: "var(--color-popover-foreground)",
    border: "1px solid var(--color-border)",
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    fontSize: "0.8rem",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--color-primary)",
    color: "var(--color-primary-foreground)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected] .cm-completionDetail": {
    color: "var(--color-primary-foreground)",
  },
  ".cm-completionDetail": { color: "var(--color-muted-foreground)", marginLeft: "0.6rem", fontStyle: "normal" },
});

export default function QueryEditor({ value, onChange, onExecute, placeholder, autoFocus }: QueryEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onExecuteRef = useRef(onExecute);
  const initialValue = useRef(value);

  useEffect(() => {
    onChangeRef.current = onChange;
    onExecuteRef.current = onExecute;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const executeKeymap = keymap.of([
      {
        key: "Ctrl-Enter",
        mac: "Cmd-Enter",
        run: (view) => {
          onExecuteRef.current(view.state.doc.toString());
          return true;
        },
      },
    ]);

    const state = EditorState.create({
      doc: initialValue.current,
      extensions: [
        editorTheme,
        executeKeymap,
        history(),
        closeBrackets(),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
        cmPlaceholder(placeholder ?? ""),
        EditorView.lineWrapping,
        ...arkivQueryLanguage(),
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    if (autoFocus) view.focus();

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor is created once; later prop changes flow through the refs and the value effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor: value.length },
    });
  }, [value]);

  return (
    <div className="overflow-hidden rounded-md border border-input bg-muted">
      <div ref={hostRef} className="query-editor-host font-mono text-sm" />
    </div>
  );
}
