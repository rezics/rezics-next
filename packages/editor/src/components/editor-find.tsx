'use client';

import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Extension, type Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import type { Node as DocumentNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { useEditorState } from '@tiptap/react';
import { useDeferredValue, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { editorLabel, type EditorWorkbenchLabels } from './editor-workbench-labels.ts';
import { editorSnapshot, maxSnapshotBytes } from './rich-text-editor-snapshot.ts';

export type EditorFindMatch = { from: number; to: number; text: string };
export type EditorFindOptions = { matchCase: boolean; wholeWord: boolean };
const matchLimit = 10_000;
const searchKey = new PluginKey<DecorationSet>('editorFind');

export const EditorFindHighlights = Extension.create({
  name: 'editorFind',
  addProseMirrorPlugins: () => [
    new Plugin({
      key: searchKey,
      state: {
        init: () => DecorationSet.empty,
        apply(transaction, previous) {
          const next = transaction.getMeta(searchKey) as
            | { matches: readonly EditorFindMatch[]; current: number }
            | undefined;
          if (next) {
            const visible = next.matches.slice(0, matchLimit);
            const current = next.matches[next.current];
            if (next.current >= matchLimit && current) visible.push(current);
            return DecorationSet.create(
              transaction.doc,
              visible.map((match) =>
                Decoration.inline(match.from, match.to, {
                  class: match === current ? 'editor-find-match editor-find-current' : 'editor-find-match',
                }),
              ),
            );
          }
          return previous.map(transaction.mapping, transaction.doc);
        },
      },
      props: { decorations: (state) => searchKey.getState(state) },
    }),
  ],
});

function wordAt(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false;
  const start = index > 0 && /[\uDC00-\uDFFF]/.test(text[index]!) ? index - 1 : index;
  return /[\p{L}\p{N}\p{M}_]/u.test(String.fromCodePoint(text.codePointAt(start)!));
}

/** Match across adjacent marked text, never across an atom, ruby boundary or block boundary. */
export function findDocumentMatches(doc: DocumentNode, query: string, options: EditorFindOptions) {
  const matches: EditorFindMatch[] = [];
  let total = 0;
  if (!query || query.length > 256) return { matches, total, limited: false };
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options.matchCase ? 'gu' : 'giu');
  let run = '';
  let from = 0;
  let end = -1;
  const scan = () => {
    expression.lastIndex = 0;
    for (const match of run.matchAll(expression)) {
      const index = match.index!;
      if (options.wholeWord && (wordAt(run, index - 1) || wordAt(run, index + match[0].length))) continue;
      total += 1;
      matches.push({ from: from + index, to: from + index + match[0].length, text: match[0] });
    }
  };
  doc.descendants((node, position) => {
    if (!node.isText) return;
    if (position !== end) {
      scan();
      run = '';
      from = position;
    }
    run += node.text!;
    end = position + node.nodeSize;
  });
  scan();
  return { matches, total, limited: total > matchLimit };
}

/** One history event retaining the first matched text's marks, including non-inclusive links. */
export function replaceDocumentMatches(
  state: EditorState,
  matches: readonly EditorFindMatch[],
  replacement: string,
): Transaction | null {
  if (!matches.length || replacement.length > 10_000) return null;
  if (
    state.doc.textContent.length +
      matches.reduce((growth, match) => growth + replacement.length - (match.to - match.from), 0) >
    maxSnapshotBytes
  )
    return null;
  const transaction = closeHistory(state.tr);
  for (const match of [...matches].reverse()) {
    if (
      match.from < 0 ||
      match.to > state.doc.content.size ||
      state.doc.textBetween(match.from, match.to) !== match.text
    )
      return null;
    const $from = state.doc.resolve(match.from);
    const marks = $from.nodeAfter?.isText ? $from.nodeAfter.marks : $from.marksAcross(state.doc.resolve(match.to));
    transaction.setStoredMarks(marks ?? []).insertText(replacement, match.from, match.to);
  }
  transaction.setStoredMarks(state.storedMarks);
  return transaction.scrollIntoView();
}

export type EditorFindHandle = {
  next: (backwards?: boolean) => boolean;
  replace: () => boolean;
  focusReplacement: () => void;
};

export function EditorFind({
  editor,
  labels,
  isCurrent,
  onClose,
  onInvalidContent,
  ref,
}: {
  editor: Editor;
  labels: EditorWorkbenchLabels;
  isCurrent: () => boolean;
  onClose: () => void;
  onInvalidContent?: () => void;
  ref?: Ref<EditorFindHandle>;
}) {
  const id = useId();
  const search = useRef<HTMLInputElement>(null);
  const replacementInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(() =>
    editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to).slice(0, 256),
  );
  const [replacement, setReplacement] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [current, setCurrent] = useState(0);
  const doc = useEditorState({ editor, selector: ({ editor: currentEditor }) => currentEditor.state.doc });
  const deferredDoc = useDeferredValue(doc);
  const deferredQuery = useDeferredValue(query);
  const result = useMemo(
    () => findDocumentMatches(deferredDoc, deferredQuery, { matchCase, wholeWord }),
    [deferredDoc, deferredQuery, matchCase, wholeWord],
  );
  const index = result.matches.length ? Math.min(current, result.matches.length - 1) : 0;
  useEffect(() => {
    search.current?.focus();
  }, []);
  useEffect(() => {
    if (!editor.isDestroyed && isCurrent() && editor.state.doc === deferredDoc)
      editor.view.dispatch(editor.state.tr.setMeta(searchKey, { matches: result.matches, current: index }));
  }, [editor, deferredDoc, result, index, isCurrent]);
  useEffect(
    () => () => {
      if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(searchKey, { matches: [], current: 0 }));
    },
    [editor],
  );

  const liveResult = () =>
    editor.state.doc === deferredDoc && query === deferredQuery
      ? result
      : findDocumentMatches(editor.state.doc, query, { matchCase, wholeWord });
  const next = (backwards = false): boolean => {
    if (!isCurrent() || editor.view.composing) return false;
    const live = liveResult();
    if (!live.matches.length) return false;
    const selection = editor.state.selection;
    let at = backwards
      ? live.matches.findLastIndex((match) => match.from < selection.from)
      : live.matches.findIndex((match) => match.from > selection.from);
    if (at < 0) at = backwards ? live.matches.length - 1 : 0;
    const match = live.matches[at]!;
    setCurrent(at);
    editor.view.dispatch(
      editor.state.tr
        .setSelection(TextSelection.create(editor.state.doc, match.from, match.to))
        .setMeta(searchKey, { matches: live.matches, current: at })
        .scrollIntoView(),
    );
    return true;
  };
  const replace = (all = false): boolean => {
    if (!isCurrent() || !editor.isEditable || editor.view.composing) return false;
    const live = liveResult();
    const selected =
      live.matches.find(
        (match) => match.from === editor.state.selection.from && match.to === editor.state.selection.to,
      ) ?? live.matches[Math.min(index, live.matches.length - 1)];
    const transaction = replaceDocumentMatches(
      editor.state,
      all ? live.matches : selected ? [selected] : [],
      replacement,
    );
    if (!transaction) {
      if (live.total) onInvalidContent?.();
      return false;
    }
    try {
      editorSnapshot(transaction.doc, editor.schema.nodes.image ? 'blocks' : 'text');
    } catch {
      onInvalidContent?.();
      return false;
    }
    const previous = editor.state.doc;
    editor.view.dispatch(transaction);
    return editor.state.doc !== previous;
  };
  useImperativeHandle(ref, () => ({
    next,
    replace: () => replace(),
    focusReplacement: () => replacementInput.current?.focus(),
  }));
  const close = () => {
    onClose();
    if (isCurrent()) editor.view.focus();
  };

  return (
    <section
      aria-label={labels.find}
      className="flex flex-col gap-3 rounded-xl border bg-background p-3"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || editor.view.composing) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-query`}>{labels.searchFor}</FieldLabel>
          <Input
            ref={search}
            id={`${id}-query`}
            value={query}
            maxLength={256}
            onChange={(event) => {
              setQuery(event.target.value);
              setCurrent(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                next(event.shiftKey);
              }
            }}
          />
          <FieldDescription>{labels.findDescription}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-replacement`}>{labels.replaceWith}</FieldLabel>
          <Input
            ref={replacementInput}
            id={`${id}-replacement`}
            value={replacement}
            maxLength={10_000}
            onChange={(event) => setReplacement(event.target.value)}
          />
        </Field>
        <div className="flex flex-wrap gap-4">
          <Field orientation="horizontal">
            <Checkbox
              id={`${id}-case`}
              checked={matchCase}
              onCheckedChange={(checked) => {
                setMatchCase(!!checked);
                setCurrent(0);
              }}
            />
            <FieldLabel htmlFor={`${id}-case`}>{labels.caseSensitive}</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Checkbox
              id={`${id}-word`}
              checked={wholeWord}
              onCheckedChange={(checked) => {
                setWholeWord(!!checked);
                setCurrent(0);
              }}
            />
            <FieldLabel htmlFor={`${id}-word`}>{labels.wholeWord}</FieldLabel>
          </Field>
        </div>
      </FieldGroup>
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {result.total ? editorLabel(labels.matchCount, { current: index + 1, total: result.total }) : labels.noMatches}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={!result.total} onClick={() => next(true)}>
          {labels.previousMatch}
        </Button>
        <Button type="button" variant="outline" disabled={!result.total} onClick={() => next()}>
          {labels.nextMatch}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!result.total || !editor.isEditable}
          onClick={() => replace()}
        >
          {labels.replaceCurrent}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!result.total || !editor.isEditable}
          onClick={() => replace(true)}
        >
          {labels.replaceAll}
        </Button>
        <Button type="button" variant="ghost" onClick={close}>
          {labels.closeFind}
        </Button>
      </div>
    </section>
  );
}
