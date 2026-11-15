'use client';

import { getMarkRange, type Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { AllSelection, TextSelection, type SelectionBookmark } from '@tiptap/pm/state';
import type { Mark, Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { RichTextEditorLabels } from './editor-labels.ts';
import { bubbleOptions } from './editor-menu-helpers.ts';
import { safeDocumentUrl } from './document-url.ts';
import { runCompactEditorChain } from './editor-compact-commands.ts';
import { LinkEditBlock, LinkViewBlock } from './editor-upstream/reactjs-tiptap-editor/link-controls.tsx';

export interface LinkRange {
  from: number;
  to: number;
}
export interface CapturedLink extends LinkRange {
  selectionBookmark: SelectionBookmark;
  storedMarks: readonly Mark[] | null;
}
export interface LinkVisitRange extends CapturedLink {
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
    return (
      editor.state.doc.resolve(range.from).parent.inlineContent &&
      editor.state.doc.resolve(range.to).parent.inlineContent
    );
  } catch {
    return false;
  }
}

/** Native mark eligibility, restricted to text: atoms and their payloads are never link targets. */
function visitLinkText(
  editor: Editor,
  range: LinkRange,
  visit?: (node: ProseMirrorNode, from: number, to: number) => boolean | void,
): boolean {
  const link = editor.schema.marks.link;
  if (!link) return false;
  let found = false,
    done = false;
  editor.state.doc.nodesBetween(range.from, range.to, (node, position, parent) => {
    if (done || (node.isAtom && !node.isText)) return false;
    if (!node.isText || !parent?.type.allowsMarkType(link)) return;
    if (!link.isInSet(node.marks) && node.marks.some((mark) => mark.type.excludes(link))) return;
    const from = Math.max(position, range.from),
      to = Math.min(position + node.nodeSize, range.to);
    if (from >= to) return;
    found = true;
    done = visit ? visit(node, from, to) === false : true;
  });
  return found;
}

export function linkHref(editor: Editor, range: LinkRange): string {
  if (!isLinkRangeValid(editor, range) || !editor.schema.marks.link) return '';
  const target = range.from === range.to ? exactLinkRange(editor, range) : range;
  if (target.from === target.to) return '';
  let href = '';
  visitLinkText(editor, target, (node) => {
    const mark = node.marks.find((candidate) => candidate.type === editor.schema.marks.link);
    if (mark) {
      href = String(mark.attrs.href ?? '');
      return false;
    }
  });
  return href;
}

/** Capture the whole text link under a caret once; explicit text selections keep their exact extent. */
export function exactLinkRange(editor: Editor, range: LinkRange): LinkRange {
  if (!isLinkRangeValid(editor, range) || range.from !== range.to || !editor.schema.marks.link) return range;
  const linked = getMarkRange(editor.state.doc.resolve(range.from), editor.schema.marks.link);
  return linked && visitLinkText(editor, linked) ? linked : range;
}

/** Shared text eligibility for capture, mapped drafts and submission. */
export function eligibleLinkRange(
  editor: Editor,
  range: LinkRange,
  storedMarks: readonly Mark[] | null,
): LinkRange | null {
  if (!isLinkRangeValid(editor, range) || !editor.schema.marks.link) return null;
  const target = exactLinkRange(editor, range),
    link = editor.schema.marks.link;
  if (target.from !== target.to) return visitLinkText(editor, target) ? target : null;
  const position = editor.state.doc.resolve(target.from),
    marks = storedMarks ?? position.marks();
  return position.parent.type.allowsMarkType(link) &&
    (link.isInSet(marks) || !marks.some((mark) => mark.type.excludes(link)))
    ? target
    : null;
}

/** Read-only capture. Ctrl+A projects through maintained text-selection rules without changing the live selection. */
export function captureLink(editor: Editor, isCurrent: () => boolean = () => true): CapturedLink | null {
  if (!isCurrent() || editor.isDestroyed || !editor.isEditable || editor.view.composing || !editor.schema.marks.link)
    return null;
  const original = editor.state.selection;
  const selected =
    original instanceof AllSelection
      ? TextSelection.between(original.$anchor, original.$head)
      : original instanceof TextSelection
        ? original
        : null;
  // A structural/atom-only selection has no text to link. An explicit text caret can still insert a URL.
  if (!(selected instanceof TextSelection) || (original instanceof AllSelection && selected.empty)) return null;
  const target = eligibleLinkRange(editor, selected, editor.state.storedMarks);
  return target
    ? { ...target, selectionBookmark: original.getBookmark(), storedMarks: editor.state.storedMarks }
    : null;
}

/** Restore native selection class/direction and explicit stored marks; never publish a document or history event. */
export function restoreLinkSelection(
  editor: Editor,
  target: CapturedLink,
  isCurrent: () => boolean = () => true,
): boolean {
  if (!isCurrent() || editor.isDestroyed || !editor.isEditable || editor.view.composing) return false;
  try {
    const selection = target.selectionBookmark.resolve(editor.state.doc);
    if (selection.$from.doc !== editor.state.doc) return false;
    editor.view.dispatch(
      editor.state.tr.setSelection(selection).setStoredMarks(target.storedMarks).setMeta('addToHistory', false),
    );
    return true;
  } catch {
    return false;
  }
}

/** Validate the same text eligibility at submission, retaining stock mark behavior on closed text spans. */
export function applyLink(
  editor: Editor,
  range: LinkRange,
  href: string | null,
  isCurrent: () => boolean = () => true,
  storedMarks?: readonly Mark[] | null,
): boolean {
  if (
    !isCurrent() ||
    editor.isDestroyed ||
    !editor.isEditable ||
    editor.view.composing ||
    !editor.schema.marks.link ||
    (href !== null && !safeDocumentUrl(href))
  )
    return false;
  const capturedMarks = storedMarks === undefined ? editor.state.storedMarks : storedMarks;
  const target = eligibleLinkRange(editor, range, capturedMarks);
  if (!target) return false;
  const link = editor.schema.marks.link;
  return runCompactEditorChain(editor, (chain) => {
    const selected = chain.setTextSelection(target);
    if (target.from === target.to) {
      if (href === null) return selected.unsetMark('link');
      const marks = capturedMarks ?? editor.state.doc.resolve(target.from).marks();
      const previous = marks.find((mark) => mark.type === link);
      const linked = link.create({ ...previous?.attrs, href }).addToSet(marks);
      return selected.insertContent({ type: 'text', text: href, marks: linked.map((mark) => mark.toJSON()) });
    }
    return selected.command(({ tr }) => {
      visitLinkText(editor, target, (node, from, to) => {
        if (href === null) tr.removeMark(from, to, link);
        else {
          const previous = node.marks.find((mark) => mark.type === link);
          tr.addMark(from, to, link.create({ ...previous?.attrs, href }));
        }
      });
      return true;
    });
  });
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
    if (applyLink(editor, range, href, current, range.storedMarks)) {
      const link = editor.schema.marks.link!;
      const storedMarks =
        range.storedMarks === null
          ? null
          : href === null
            ? link.removeFromSet(range.storedMarks)
            : range.storedMarks.map((mark) => (mark.type === link ? link.create({ ...mark.attrs, href }) : mark));
      if (range.from !== range.to) restoreLinkSelection(editor, { ...range, storedMarks }, isCurrent);
      else if (isCurrent())
        editor.view.dispatch(editor.state.tr.setStoredMarks(storedMarks).setMeta('addToHistory', false));
      onClose();
      focusEditor();
    }
  }
  function cancel() {
    if (!current()) return;
    restoreLinkSelection(editor, range, current);
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
