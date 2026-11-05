'use client';

import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldError } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { TextSelection } from '@tiptap/pm/state';
import type { RichTextEditorLabels } from './editor-labels.ts';
import { bubbleOptions } from './editor-selection-menu.tsx';
import { safeDocumentUrl } from './document-url.ts';

export interface LinkRange {
  from: number;
  to: number;
}
export interface LinkVisitRange extends LinkRange {
  id: number;
  visit: number;
  url: string;
}

export function isLinkRangeValid(editor: Editor, range: LinkRange): boolean {
  if (
    editor.isDestroyed ||
    !editor.isEditable ||
    !Number.isInteger(range.from) ||
    !Number.isInteger(range.to) ||
    range.from < 0 ||
    range.to < range.from ||
    range.to > editor.state.doc.content.size
  )
    return false;
  try {
    const selection = TextSelection.create(editor.state.doc, range.from, range.to);
    return selection.$from.parent.inlineContent && selection.$to.parent.inlineContent;
  } catch {
    return false;
  }
}

export function linkHref(editor: Editor, range: LinkRange): string {
  if (!isLinkRangeValid(editor, range)) return '';
  const link = editor.schema.marks.link;
  if (!link) return '';
  let href = '';
  if (range.from === range.to) {
    const $position = editor.state.doc.resolve(range.from);
    const mark = $position.marks().find((candidate) => candidate.type === link);
    return String(mark?.attrs.href ?? '');
  }
  editor.state.doc.nodesBetween(range.from, range.to, (node) => {
    const mark = node.marks.find((candidate) => candidate.type === link);
    if (mark && !href) href = String(mark.attrs.href ?? '');
  });
  return href;
}

/** Validate at the mutation boundary as well as in the address field. */
export function applyLink(
  editor: Editor,
  range: LinkRange,
  href: string | null,
  isCurrent: () => boolean = () => true,
): boolean {
  if (
    !isCurrent() ||
    editor.isDestroyed ||
    !editor.isEditable ||
    !editor.schema.marks.link ||
    !isLinkRangeValid(editor, range) ||
    (href !== null && !safeDocumentUrl(href))
  )
    return false;
  const chain = editor.chain().setTextSelection(range).extendMarkRange('link');
  if (href === null) return chain.unsetMark('link').run();
  if (range.from === range.to && !editor.isActive('link')) {
    return chain.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
  }
  return chain.setMark('link', { href }).run();
}

/** Keep a live ProseMirror selection if its mapped positions still resolve; never invent a retired range. */
export function revalidateTextSelection(editor: Editor): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const { selection, doc } = editor.state;
  const from = Math.max(0, Math.min(selection.from, doc.content.size));
  const to = Math.max(0, Math.min(selection.to, doc.content.size));
  try {
    const next = TextSelection.create(doc, from, to);
    if (next.eq(selection)) return true;
    editor.view.dispatch(editor.state.tr.setSelection(next).setMeta('addToHistory', false));
    return true;
  } catch {
    try {
      const next = TextSelection.near(doc.resolve(from));
      if (next.eq(selection)) return true;
      editor.view.dispatch(editor.state.tr.setSelection(next).setMeta('addToHistory', false));
      return true;
    } catch {
      return false;
    }
  }
}

const capturedLinkFocus = new WeakMap<Editor, { id: number; visit: number }>();

/**
 * Inline address editing on a saved document range. The bubble menu places it against the text, which a shadcn popover
 * cannot do: its anchor is a trigger element, not a range in the document.
 */
export function LinkField({
  editor,
  labels,
  range,
  onClose,
  isCurrent,
  isRangeCurrent,
  onUrlChange,
  focusEditor,
}: {
  editor: Editor;
  labels: RichTextEditorLabels;
  range: LinkVisitRange;
  onClose: () => void;
  isCurrent: () => boolean;
  isRangeCurrent: (range: LinkVisitRange) => boolean;
  onUrlChange: (range: LinkVisitRange, url: string) => void;
  focusEditor: () => void;
}) {
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [invalid, setInvalid] = useState(false);
  const linked = Boolean(linkHref(editor, range));
  const current = () => isCurrent() && isRangeCurrent(range);
  useLayoutEffect(() => {
    if (!current()) return;
    const captured = capturedLinkFocus.get(editor);
    const justOpened = captured?.id !== range.id || captured?.visit !== range.visit;
    const active = editor.view.dom.ownerDocument.activeElement;
    if (!justOpened && editor.view.dom.contains(active)) return;
    revalidateTextSelection(editor);
    if (editor.view.dom.ownerDocument.activeElement !== input.current) input.current?.focus();
    capturedLinkFocus.set(editor, { id: range.id, visit: range.visit });
  }, [editor, focusEditor, isCurrent, isRangeCurrent, range.id, range.visit]);

  function finish(href: string | null) {
    if (!current()) return;
    if (href !== null && !safeDocumentUrl(href)) {
      setInvalid(true);
      return;
    }
    if (applyLink(editor, range, href, current)) {
      onClose();
      focusEditor();
    }
  }
  function cancel() {
    if (!current()) return;
    if (isLinkRangeValid(editor, range)) editor.commands.setTextSelection(range);
    onClose();
    focusEditor();
  }
  return (
    <form
      className="grid gap-2 p-1"
      onSubmit={(event) => {
        event.preventDefault();
        finish(range.url.trim() || null);
      }}
      onKeyDown={(event) => {
        if (!current()) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
      }}
    >
      <Field orientation="horizontal" className="flex-wrap items-center gap-1">
        <Input
          ref={input}
          dir="ltr"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-40 flex-1 text-foreground"
          aria-label={labels.url}
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
          value={range.url}
          onChange={(event) => {
            if (!current()) return;
            onUrlChange(range, event.target.value);
            setInvalid(false);
          }}
        />
        <Button type="submit" variant="secondary">
          {labels.apply}
        </Button>
        {linked ? (
          <Button type="button" variant="ghost" onClick={() => finish(null)}>
            {labels.unlink}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={cancel}>
          {labels.cancel}
        </Button>
      </Field>
      {invalid ? <FieldError id={errorId}>{labels.invalidUrl}</FieldError> : null}
    </form>
  );
}

export function LinkMenu({
  editor,
  labels,
  range,
  onEdit,
  onClose,
  container,
  isCurrent,
  isRangeCurrent,
  onUrlChange,
  focusEditor,
  rangeVisible = false,
}: {
  editor: Editor;
  labels: RichTextEditorLabels;
  range: LinkVisitRange | null;
  onEdit: (range: LinkRange) => void;
  onClose: () => void;
  container: RefObject<HTMLDivElement | null>;
  isCurrent: () => boolean;
  isRangeCurrent: (range: LinkVisitRange) => boolean;
  onUrlChange: (range: LinkVisitRange, url: string) => void;
  focusEditor: () => void;
  rangeVisible?: boolean;
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      empty: current.state.selection.empty,
      linked: current.isActive('link'),
      href: String(current.getAttributes('link').href ?? ''),
      from: current.state.selection.from,
      to: current.state.selection.to,
    }),
  });
  if (!isCurrent() || (!state.empty && (!range || !rangeVisible)) || (!state.linked && !range)) return null;
  const safe = safeDocumentUrl(state.href);
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="rezicsLinkMenu"
      updateDelay={0}
      options={{ ...bubbleOptions, placement: 'bottom' }}
      appendTo={() => container.current!}
      shouldShow={({ state: live, view, element }) =>
        isCurrent() &&
        editor.isEditable &&
        (live.selection.empty || (Boolean(range) && rangeVisible)) &&
        (view.hasFocus() || element.contains(document.activeElement))
      }
    >
      <div
        role="group"
        aria-label={labels.link}
        className="flex max-w-80 flex-col gap-1 rounded-2xl bg-popover p-2 text-popover-foreground shadow-lg ring-1 ring-foreground/5 dark:ring-foreground/10"
        onKeyDown={(event) => {
          if (!isCurrent()) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            if (range) onClose();
            focusEditor();
          }
        }}
      >
        {range ? (
          <LinkField
            key={range.id}
            editor={editor}
            labels={labels}
            range={range}
            onClose={onClose}
            isCurrent={isCurrent}
            isRangeCurrent={isRangeCurrent}
            onUrlChange={onUrlChange}
            focusEditor={focusEditor}
          />
        ) : (
          <>
            {safe ? (
              <a
                href={safe}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={labels.openLink}
                className="block truncate rounded-lg px-2 py-1 text-sm text-primary underline underline-offset-2"
              >
                {state.href}
              </a>
            ) : null}
            <Button
              variant="ghost"
              onClick={() => {
                if (isCurrent() && editor.state.selection.from === state.from && editor.state.selection.to === state.to)
                  onEdit({ from: state.from, to: state.to });
              }}
            >
              {labels.editLink}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                if (
                  !isCurrent() ||
                  editor.state.selection.from !== state.from ||
                  editor.state.selection.to !== state.to
                )
                  return;
                if (applyLink(editor, { from: state.from, to: state.to }, null, isCurrent)) focusEditor();
              }}
            >
              {labels.unlink}
            </Button>
          </>
        )}
      </div>
    </BubbleMenu>
  );
}
