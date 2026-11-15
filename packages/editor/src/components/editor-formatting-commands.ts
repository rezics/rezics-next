import type { Editor } from '@tiptap/core';
import { Mark, type Node, type Slice } from '@tiptap/pm/model';
import { NodeSelection, type Selection, type Transaction } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import { AddMarkStep, RemoveMarkStep, AttrStep, type Step } from '@tiptap/pm/transform';
import { compactIdentityTransaction } from './editor-compact-transaction.ts';
import { safeAlignment, validTextStyle, validTextEmphasis, type DocumentAlignment } from './document-style.ts';

export type FormattingTarget = { doc: Node; selection: Selection; content: Slice; block: Node; blockFrom: number };
export function captureFormattingTarget(editor: Editor): FormattingTarget | null {
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing) return null;
  const { doc, selection } = editor.state;
  let block = selection instanceof NodeSelection && selection.node.isTextblock ? selection.node : null;
  let blockFrom = selection.from;
  if (!block)
    for (let depth = selection.$from.depth; depth > 0; depth--) {
      const candidate = selection.$from.node(depth);
      if (candidate.isTextblock) {
        block = candidate;
        blockFrom = selection.$from.before(depth);
        break;
      }
    }
  if (!block) return null;
  return { doc, selection, block, blockFrom, content: doc.slice(selection.from, selection.to) };
}
export function mapFormattingTarget(
  target: FormattingTarget,
  transaction: Transaction,
  editor: Editor,
): FormattingTarget | null {
  if (transaction.before !== target.doc) return null;
  const selection = target.selection.getBookmark().map(transaction.mapping).resolve(editor.state.doc);
  if (!selection.eq(editor.state.selection)) return null;
  if (
    target.selection.empty &&
    transaction.mapping.map(target.selection.from, -1) !== transaction.mapping.map(target.selection.from, 1)
  )
    return null;
  const blockFrom = transaction.mapping.map(target.blockFrom, 1);
  const block = editor.state.doc.nodeAt(blockFrom);
  if (!block || !block.eq(target.block) || !target.content.eq(editor.state.doc.slice(selection.from, selection.to)))
    return null;
  return { ...target, doc: editor.state.doc, selection, block, blockFrom };
}
function admitted(editor: Editor, target: FormattingTarget, isCurrent: () => boolean) {
  return (
    isCurrent() &&
    !editor.isDestroyed &&
    editor.isEditable &&
    !editor.view.composing &&
    editor.state.doc === target.doc &&
    editor.state.selection.eq(target.selection)
  );
}
function dispatch(editor: Editor, transaction: Transaction): boolean {
  const previous = editor.state;
  editor.view.dispatch(closeHistory(transaction).scrollIntoView());
  return editor.state !== previous;
}
export function applyAuthoredMark(
  editor: Editor,
  target: FormattingTarget,
  name: 'textStyle' | 'textEmphasis',
  patch: Record<string, string | null> | null,
  isCurrent: () => boolean,
): boolean {
  const type = editor.schema.marks[name];
  if (
    !type ||
    !admitted(editor, target, isCurrent) ||
    (patch && !(name === 'textStyle' ? validTextStyle(patch) : validTextEmphasis(patch)))
  )
    return false;
  const merge = (marks: readonly Mark[]) => {
    const attrs = { ...marks.find((mark) => mark.type === type)?.attrs, ...patch };
    return patch === null || (name === 'textStyle' && !attrs.color && !attrs.backgroundColor)
      ? null
      : type.create(attrs);
  };
  if (target.selection.empty) {
    const transaction = editor.state.tr;
    if (!target.selection.$from.parent.type.allowsMarkType(type)) return false;
    const marks = editor.state.storedMarks ?? target.selection.$from.marks();
    const next = merge(marks);
    transaction.setStoredMarks(next ? next.addToSet(type.removeFromSet(marks)) : type.removeFromSet(marks));
    return dispatch(editor, transaction);
  } else {
    const steps: Step[] = [];
    let eligible = false;
    target.doc.nodesBetween(target.selection.from, target.selection.to, (node, position, parent) => {
      if (!node.isText || !parent?.type.allowsMarkType(type)) return;
      eligible = true;
      const from = Math.max(position, target.selection.from),
        to = Math.min(position + node.nodeSize, target.selection.to);
      const next = merge(node.marks);
      const old = node.marks.find((mark) => mark.type === type);
      if ((next && old?.eq(next)) || (!next && !old)) return;
      if (old) steps.push(new RemoveMarkStep(from, to, old));
      if (next) steps.push(new AddMarkStep(from, to, next));
    });
    if (!steps.length) return eligible;
    const transaction = compactIdentityTransaction(editor.state, steps);
    if (!transaction) return false;
    transaction.setStoredMarks(editor.state.storedMarks);
    return dispatch(editor, transaction);
  }
}
export function applyAuthoredAlignment(
  editor: Editor,
  target: FormattingTarget,
  alignment: DocumentAlignment | null,
  isCurrent: () => boolean,
): boolean {
  if (!admitted(editor, target, isCurrent) || (alignment !== null && !safeAlignment(alignment))) return false;
  const steps: Step[] = [];
  let eligible = false;
  const set = (node: Node, from: number) => {
    if (!['paragraph', 'heading'].includes(node.type.name)) return;
    eligible = true;
    if (node.attrs.textAlign !== alignment) steps.push(new AttrStep(from, 'textAlign', alignment));
  };
  if (target.selection.empty || target.selection instanceof NodeSelection) set(target.block, target.blockFrom);
  else
    target.doc.nodesBetween(target.selection.from, target.selection.to, (node, from) => {
      if (node.isTextblock) set(node, from);
    });
  if (!steps.length) return eligible;
  const transaction = compactIdentityTransaction(editor.state, steps);
  return !!transaction && dispatch(editor, transaction.setStoredMarks(editor.state.storedMarks));
}
export function applyCodeLanguage(
  editor: Editor,
  target: FormattingTarget,
  language: string,
  isCurrent: () => boolean,
): boolean {
  if (!admitted(editor, target, isCurrent) || target.block.type.name !== 'codeBlock') return false;
  if (target.block.attrs.language === (language || null)) return true;
  const transaction = compactIdentityTransaction(editor.state, [
    new AttrStep(target.blockFrom, 'language', language || null),
  ]);
  return !!transaction && dispatch(editor, transaction.setStoredMarks(editor.state.storedMarks));
}
