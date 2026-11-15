'use client';

import { Button } from '@rezics/ui/shadcn/button';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Extension, type Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Fragment, Slice, type Mark, type Node as DocumentNode } from '@tiptap/pm/model';
import { ReplaceStep } from '@tiptap/pm/transform';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { useEditorState } from '@tiptap/react';
import { useDeferredValue, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { editorLabel, type EditorWorkbenchLabels } from './editor-workbench-labels.ts';
import { unspacedScript, wordSegmenter } from './editor-text-segmentation.ts';
import { editorSnapshot, maxSnapshotBytes } from './rich-text-editor-snapshot.ts';
import { compactTransaction } from './editor-compact-transaction.ts';
import { buildTextDocument, TextDocumentIndex, type ClosedTextEdit } from './editor-text-document.ts';

export type EditorFindMatch = { from: number; to: number; text: string };
export type EditorFindOptions = { matchCase: boolean; wholeWord: boolean };
const matchLimit = 10_000;
const decorationLimit = 300;
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
            const start = Math.max(0, next.current - Math.floor(decorationLimit / 2));
            const visible = next.matches.slice(start, start + decorationLimit);
            const current = next.matches[next.current];
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
export function findDocumentMatches(doc: DocumentNode, query: string, options: EditorFindOptions, locale?: string) {
  const matches: EditorFindMatch[] = [];
  let total = 0;
  if (!query || query.length > 256) return { matches, total, limited: false };
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options.matchCase ? 'gu' : 'giu');
  let run = '';
  let from = 0;
  let end = -1;
  const segmenter = options.wholeWord && unspacedScript.test(query) ? wordSegmenter(locale) : undefined;
  const scan = () => {
    expression.lastIndex = 0;
    const segments = segmenter?.segment(run);
    for (const match of run.matchAll(expression)) {
      const index = match.index!;
      const endIndex = index + match[0].length;
      if (options.wholeWord) {
        const startBoundary = segments ? segments.containing(index)?.index === index : !wordAt(run, index - 1);
        const endBoundary = segments
          ? endIndex === run.length || segments.containing(endIndex)?.index === endIndex
          : !wordAt(run, endIndex);
        if (!startBoundary || !endBoundary) continue;
      }
      total += 1;
      matches.push({ from: from + index, to: from + endIndex, text: match[0] });
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
  const index = new TextDocumentIndex(state.doc);
  const edits: ClosedTextEdit[] = [];
  const insertions = new Map<readonly Mark[], Slice>();
  let noOp = true;
  let previousEnd = -1;
  for (const match of matches) {
    if (match.from < previousEnd || match.to <= match.from) return null;
    previousEnd = match.to;
    const marks = index.firstMarks(match.from);
    if (!marks) return null;
    let insert = insertions.get(marks);
    if (!insert) {
      insert = replacement ? new Slice(Fragment.from(state.schema.text(replacement, marks)), 0, 0) : Slice.empty;
      insertions.set(marks, insert);
    }
    const admitted = index.edit(match.from, match.to, insert);
    if (!admitted || admitted.removed.content.textBetween(0, admitted.removed.content.size) !== match.text) return null;
    if (!admitted.removed.eq(insert)) noOp = false;
    edits.push(admitted.edit);
  }
  if (noOp) return state.tr;
  try {
    buildTextDocument(state.doc, edits, maxSnapshotBytes, false);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  const transaction = closeHistory(compactTransaction(state));
  const textSelection =
    state.selection instanceof TextSelection ? { anchor: state.selection.anchor, head: state.selection.head } : null;
  for (let position = edits.length - 1; position >= 0; position--) {
    const edit = edits[position]!;
    transaction.step(new ReplaceStep(edit.from, edit.to, edit.insert));
    if (textSelection) {
      const map = transaction.mapping.maps.at(-1)!;
      textSelection.anchor = map.map(textSelection.anchor);
      textSelection.head = map.map(textSelection.head);
      // Preserve native insertText's explicit selection collapse without resolving every prefix.
      const end = Math.max(textSelection.anchor, textSelection.head);
      if (replacement && textSelection.anchor !== textSelection.head && end === edit.from + replacement.length)
        textSelection.anchor = textSelection.head = end;
    }
  }
  const result = transaction.doc;
  try {
    editorSnapshot(result, state.schema.nodes.image ? 'blocks' : 'text');
  } catch {
    return null;
  }
  if (result.eq(state.doc)) return state.tr;
  transaction.setSelection(
    textSelection ? TextSelection.create(result, textSelection.anchor, textSelection.head) : transaction.selection,
  );
  return transaction.setStoredMarks(state.storedMarks).scrollIntoView();
}

export function clearEditorFindHighlights(editor: Editor): void {
  const current = searchKey.getState(editor.state);
  if (!current || current === DecorationSet.empty) return;
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, { matches: [], current: 0 }));
}

export type EditorFindIntent = 'find' | 'replace' | 'next' | 'previous';

export type EditorFindHandle = {
  activate: (intent: EditorFindIntent) => boolean;
};

const findActionClassName =
  'h-auto min-h-7 min-w-0 max-w-full shrink whitespace-normal wrap-break-word text-start';

export function EditorFind({
  editor,
  labels,
  isCurrent,
  onClose,
  onInvalidContent,
  defaultQuery,
  onQueryChange,
  initialIntent = 'find',
  ref,
}: {
  editor: Editor;
  labels: EditorWorkbenchLabels;
  isCurrent: () => boolean;
  onClose: () => void;
  onInvalidContent?: () => void;
  defaultQuery?: string;
  onQueryChange?: (query: string) => void;
  initialIntent?: EditorFindIntent;
  ref?: Ref<EditorFindHandle>;
}) {
  const id = useId();
  const descriptionId = `${id}-description`;
  const statusId = `${id}-status`;
  const search = useRef<HTMLInputElement>(null);
  const replacementInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(() => {
    const selected = editor.state.doc
      .textBetween(editor.state.selection.from, editor.state.selection.to)
      .slice(0, 256);
    const prior = (defaultQuery ?? '').slice(0, 256);
    return initialIntent === 'next' || initialIntent === 'previous' ? prior || selected : selected || prior;
  });
  const [replacement, setReplacement] = useState('');
  const [showReplacement, setShowReplacement] = useState(initialIntent === 'replace');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const requestReplacementFocus = useRef(initialIntent === 'replace');
  const initial = useRef<EditorFindIntent | null>(initialIntent);
  const locale = editor.view.dom.getAttribute('lang') ?? undefined;
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [current, setCurrent] = useState(0);
  const doc = useEditorState({ editor, selector: ({ editor: currentEditor }) => currentEditor.state.doc });
  const deferredDoc = useDeferredValue(doc);
  const deferredQuery = useDeferredValue(query);
  const result = useMemo(
    () => findDocumentMatches(deferredDoc, deferredQuery, { matchCase, wholeWord }, locale),
    [deferredDoc, deferredQuery, matchCase, wholeWord, locale],
  );
  const pending = deferredQuery !== query || deferredDoc !== doc;
  const index = result.matches.length ? Math.min(current, result.matches.length - 1) : 0;
  useEffect(() => {
    if (!showReplacement || !requestReplacementFocus.current || !isCurrent()) return;
    requestReplacementFocus.current = false;
    replacementInput.current?.focus({ preventScroll: true });
  }, [showReplacement, isCurrent]);
  useEffect(() => {
    if (!editor.isDestroyed && isCurrent() && editor.state.doc === deferredDoc && query === deferredQuery)
      editor.view.dispatch(editor.state.tr.setMeta(searchKey, { matches: result.matches, current: index }));
  }, [editor, deferredDoc, deferredQuery, query, result, index, isCurrent]);
  useEffect(
    () => () => {
      if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(searchKey, { matches: [], current: 0 }));
    },
    [editor],
  );

  const liveResult = () =>
    editor.state.doc === deferredDoc && query === deferredQuery
      ? result
      : findDocumentMatches(editor.state.doc, query, { matchCase, wholeWord }, locale);
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
    if (!transaction.docChanged) return false;
    const previous = editor.state.doc;
    clearEditorFindHighlights(editor);
    if (!isCurrent() || editor.state.doc !== previous) return false;
    editor.view.dispatch(transaction);
    const changed = editor.state.doc !== previous;
    if (changed) editor.view.dispatch(closeHistory(editor.state.tr));
    return changed;
  };
  const activate = (intent: EditorFindIntent): boolean => {
    if (!isCurrent()) return false;
    if (intent === 'replace' && editor.isEditable) {
      if (showReplacement) replacementInput.current?.focus({ preventScroll: true });
      else {
        requestReplacementFocus.current = true;
        setShowReplacement(true);
      }
      return true;
    }
    if ((intent === 'next' || intent === 'previous') && next(intent === 'previous')) return true;
    search.current?.focus({ preventScroll: true });
    return true;
  };
  useImperativeHandle(ref, () => ({ activate }));
  useEffect(() => {
    const intent = initial.current;
    if (!intent) return;
    const frame = requestAnimationFrame(() => {
      initial.current = null;
      onQueryChange?.(query);
      activate(intent);
    });
    return () => cancelAnimationFrame(frame);
    // The first invocation belongs to the mount. Later commands use the current imperative handle.
  }, []);
  const close = () => {
    onClose();
    if (isCurrent()) {
      if (editor.isEditable) editor.view.focus();
      else editor.view.dom.focus({ preventScroll: true });
    }
  };

  return (
    <section
      aria-label={labels.find}
      className="flex min-w-0 flex-col gap-2 rounded-lg border bg-popover p-2 text-popover-foreground"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || editor.view.composing) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-1">
        <Input
          ref={search}
          id={`${id}-query`}
          aria-label={labels.searchFor}
          aria-describedby={statusId}
          placeholder={labels.searchFor}
          value={query}
          maxLength={256}
          className="min-w-0 flex-1"
          onChange={(event) => {
            setQuery(event.target.value);
            onQueryChange?.(event.target.value);
            setCurrent(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              next(event.shiftKey);
            }
          }}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={labels.previousMatch}
          disabled={pending || !result.total}
          onClick={() => next(true)}
        >
          <ChevronUp aria-hidden="true" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={labels.nextMatch}
          disabled={pending || !result.total}
          onClick={() => next()}
        >
          <ChevronDown aria-hidden="true" />
        </Button>
        <Button type="button" size="icon" variant="ghost" aria-label={labels.closeFind} onClick={close}>
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p id={statusId} role="status" className="me-auto text-xs text-muted-foreground">
          {query && !pending
            ? result.total
              ? editorLabel(labels.matchCount, { current: index + 1, total: result.total })
              : labels.noMatches
            : null}
        </p>
        <Button
          type="button"
          variant="ghost"
          aria-expanded={optionsOpen}
          onClick={() => setOptionsOpen((open) => !open)}
        >
          {labels.caseSensitive} / {labels.wholeWord}
        </Button>
        {editor.isEditable ? (
          <Button
            type="button"
            variant="ghost"
            aria-expanded={showReplacement}
            onClick={() => {
              if (showReplacement) {
                setShowReplacement(false);
                search.current?.focus({ preventScroll: true });
              } else activate('replace');
            }}
          >
            {labels.replaceWith}
          </Button>
        ) : null}
      </div>
      {optionsOpen ? (
        <FieldGroup className="flex-row flex-wrap gap-3">
          <Field orientation="horizontal" className="w-auto">
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
          <Field orientation="horizontal" className="w-auto">
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
        </FieldGroup>
      ) : null}
      {showReplacement && editor.isEditable ? (
        <Field className="min-w-0 gap-2">
          <Input
            ref={replacementInput}
            aria-label={labels.replaceWith}
            placeholder={labels.replaceWith}
            value={replacement}
            maxLength={10_000}
            aria-describedby={descriptionId}
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing || editor.view.composing) return;
              event.preventDefault();
              replace();
            }}
          />
          <FieldDescription id={descriptionId} className="sr-only">{labels.findDescription}</FieldDescription>
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              variant="outline"
              className={findActionClassName}
              disabled={pending || !result.total}
              onClick={() => replace()}
            >
              {labels.replaceCurrent}
            </Button>
            <Button
              type="button"
              variant="outline"
              className={findActionClassName}
              disabled={pending || !result.total}
              onClick={() => replace(true)}
            >
              {labels.replaceAll}
            </Button>
          </div>
        </Field>
      ) : null}
    </section>
  );
}
