'use client';

import { getMarkRange, type Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { TextSelection } from '@tiptap/pm/state';
import type { RichTextEditorLabels } from './editor-labels.ts';
import { bubbleOptions } from './editor-menu-helpers.ts';
import { safeDocumentUrl } from './document-url.ts';
import { LinkEditBlock, LinkViewBlock } from './editor-upstream/reactjs-tiptap-editor/link-controls.tsx';

export interface LinkRange {
  from: number;
  to: number;
}
export interface LinkVisitRange extends LinkRange {
  id: number;
  visit: number;
  url: string;
  /** The caret/selection before expanding an existing link for exact address editing. */
  selection?: LinkRange;
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
    return (
      editor.state.doc.resolve(range.from).parent.inlineContent &&
      editor.state.doc.resolve(range.to).parent.inlineContent
    );
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

/** Capture the whole link under a caret once; an explicit text selection keeps its exact extent. */
export function exactLinkRange(editor: Editor, range: LinkRange): LinkRange {
  if (!isLinkRangeValid(editor, range) || range.from !== range.to || !editor.schema.marks.link) return range;
  return getMarkRange(editor.state.doc.resolve(range.from), editor.schema.marks.link) ?? range;
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
    editor.view.composing ||
    !isLinkRangeValid(editor, range) ||
    (href !== null && !safeDocumentUrl(href))
  )
    return false;
  const target = exactLinkRange(editor, range);
  const chain = editor.chain().setTextSelection(target);
  if (href === null) return chain.unsetMark('link').run();
  if (target.from === target.to) {
    return chain.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
  }
  return chain.setMark('link', { href }).run();
}

/** Keep a live ProseMirror selection if its mapped positions still resolve; never invent a retired range. */
export function revalidateTextSelection(editor: Editor): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const { selection, doc } = editor.state;
  // A controlled echo keeps structural selections, including cell rectangles and selected block atoms.
  if (!(selection instanceof TextSelection)) return true;
  const anchor = Math.max(0, Math.min(selection.anchor, doc.content.size));
  const head = Math.max(0, Math.min(selection.head, doc.content.size));
  try {
    const next = TextSelection.between(doc.resolve(anchor), doc.resolve(head));
    if (next.eq(selection)) return true;
    editor.view.dispatch(editor.state.tr.setSelection(next).setMeta('addToHistory', false));
    return true;
  } catch {
    try {
      const next = TextSelection.near(doc.resolve(anchor));
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
      const original = range.selection;
      if (range.from !== range.to && original && isCurrent() && isLinkRangeValid(editor, original))
        editor.commands.setTextSelection(original);
      onClose();
      focusEditor();
    }
  }
  function cancel() {
    if (!current()) return;
    const original = range.selection ?? range;
    if (isLinkRangeValid(editor, original)) editor.commands.setTextSelection(original);
    onClose();
    focusEditor();
  }
  return (
    <LinkEditBlock
      labels={labels}
      url={range.url}
      error={invalid ? labels.invalidUrl : undefined}
      linked={linked}
      inputRef={input}
      onChange={(url) => {
        if (!current()) return;
        onUrlChange(range, url);
        setInvalid(false);
      }}
      onApply={() => finish(range.url.trim() || null)}
      onClear={() => finish(null)}
      onCancel={cancel}
    />
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
  const previewIsCurrent = () =>
    isCurrent() &&
    !editor.isDestroyed &&
    editor.isEditable &&
    !editor.view.composing &&
    editor.state.selection.from === state.from &&
    editor.state.selection.to === state.to &&
    String(editor.getAttributes('link').href ?? '') === state.href;
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
        className="flex w-80 max-w-[calc(100dvw-1rem)] flex-col gap-1 rounded-2xl bg-popover p-2 text-popover-foreground shadow-lg ring-1 ring-foreground/5 dark:ring-foreground/10"
        onKeyDown={(event) => {
          if (!isCurrent() || event.nativeEvent.isComposing || event.keyCode === 229) return;
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
          <LinkViewBlock
            labels={labels}
            href={safe}
            isCurrent={previewIsCurrent}
            onEdit={() => {
              if (previewIsCurrent()) onEdit({ from: state.from, to: state.to });
            }}
            onClear={() => {
              if (!previewIsCurrent()) return;
              if (applyLink(editor, exactLinkRange(editor, { from: state.from, to: state.to }), null, isCurrent))
                focusEditor();
            }}
          />
        )}
      </div>
    </BubbleMenu>
  );
}
