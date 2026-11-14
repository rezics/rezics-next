import type { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Fragment, type Node, type Slice } from '@tiptap/pm/model';
import { NodeSelection, TextSelection, type Selection, type Transaction } from '@tiptap/pm/state';

export interface AnnotationTarget {
  doc: Node;
  selection: Selection;
  from: number;
  to: number;
  content: Slice;
  ruby: Node | null;
  footnote: string | null;
}

export const validLanguageTag = (value: string) => value === '' || /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value);
export const validFootnoteLabel = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);

/** Dialogs keep the admitted content and selection, never a later unrelated caret. */
export function captureAnnotationTarget(editor: Editor): AnnotationTarget | null {
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing) return null;
  const { doc, selection } = editor.state;
  const { $from } = selection;
  let from = selection.from;
  let to = selection.to;
  let ruby: Node | null =
    selection instanceof NodeSelection && selection.node.type.name === 'ruby' ? selection.node : null;
  let footnote: string | null =
    selection instanceof NodeSelection && selection.node.type.name === 'footnoteReference'
      ? selection.node.attrs.label
      : null;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === 'ruby') {
      ruby = node;
      from = $from.before(depth);
      to = from + node.nodeSize;
    }
    if (node.type.name === 'footnoteDefinition') footnote = node.attrs.label;
  }
  if (!ruby && !footnote && (!$from.parent.isTextblock || !selection.$from.sameParent(selection.$to))) return null;
  return { doc, selection, from, to, content: doc.slice(from, to), ruby, footnote };
}

export function mapAnnotationTarget(
  target: AnnotationTarget,
  transaction: Transaction,
  editor: Editor,
): AnnotationTarget | null {
  if (transaction.before !== target.doc) return null;
  const from = transaction.mapping.map(target.from, 1);
  const to = transaction.mapping.map(target.to, target.from === target.to ? 1 : -1);
  if (target.from === target.to && transaction.mapping.map(target.from, -1) !== from) return null;
  if (from > to || !target.content.eq(editor.state.doc.slice(from, to))) return null;
  const selection = target.selection.getBookmark().map(transaction.mapping).resolve(editor.state.doc);
  if (!selection.eq(editor.state.selection)) return null;
  return { ...target, doc: editor.state.doc, selection, from, to };
}

function currentTarget(editor: Editor, target: AnnotationTarget, isCurrent: () => boolean): boolean {
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
  const before = editor.state;
  editor.view.dispatch(closeHistory(transaction).scrollIntoView());
  return before !== editor.state;
}

export function rubyBase(target: AnnotationTarget): string {
  return target.ruby?.textContent ?? target.content.content.textBetween(0, target.content.content.size, '', '');
}

export function canApplyRuby(target: AnnotationTarget): boolean {
  if (target.ruby) return true;
  let textOnly = true;
  target.content.content.forEach((node) => {
    if (!node.isText) textOnly = false;
  });
  return textOnly;
}

export function applyRuby(
  editor: Editor,
  target: AnnotationTarget,
  attrs: {
    base: string;
    rt: string;
    position: 'over' | 'under' | 'inter-character';
    lang: string;
  },
  isCurrent: () => boolean,
): boolean {
  const type = editor.schema.nodes.ruby;
  if (
    !type ||
    !currentTarget(editor, target, isCurrent) ||
    !canApplyRuby(target) ||
    !attrs.base ||
    !validLanguageTag(attrs.lang)
  )
    return false;
  if (rubyBase(target) && attrs.base !== rubyBase(target)) return false;
  if (!['over', 'under', 'inter-character'].includes(attrs.position)) return false;
  const existing = target.ruby?.content ?? target.content.content;
  // Retain every mark on an unchanged base; a deliberately entered replacement uses the selected text's marks.
  const content =
    attrs.base === rubyBase(target)
      ? existing
      : Fragment.from(editor.schema.text(attrs.base, existing.firstChild?.marks ?? target.selection.$from.marks()));
  const node = type.create({ rt: attrs.rt, position: attrs.position, lang: attrs.lang || null }, content);
  const transaction = editor.state.tr.replaceWith(target.from, target.to, node);
  transaction.setSelection(TextSelection.near(transaction.doc.resolve(target.from + node.nodeSize)));
  return dispatch(editor, transaction);
}

export function removeRuby(editor: Editor, target: AnnotationTarget, isCurrent: () => boolean): boolean {
  if (!target.ruby || !currentTarget(editor, target, isCurrent)) return false;
  return dispatch(editor, editor.state.tr.replaceWith(target.from, target.to, target.ruby.content));
}

export function applyLanguage(
  editor: Editor,
  target: AnnotationTarget,
  attrs: {
    lang: string;
    dir: '' | 'ltr' | 'rtl' | 'auto';
    scope: 'selection' | 'block';
  },
  isCurrent: () => boolean,
): boolean {
  if (
    !currentTarget(editor, target, isCurrent) ||
    !validLanguageTag(attrs.lang) ||
    !['', 'ltr', 'rtl', 'auto'].includes(attrs.dir)
  )
    return false;
  const transaction = editor.state.tr;
  const values = { lang: attrs.lang || null, dir: attrs.dir || null };
  if (attrs.scope === 'block') {
    const { $from } = target.selection;
    let depth = $from.depth;
    while (depth > 0 && !$from.node(depth).isTextblock) depth--;
    if (depth === 0 || !('lang' in $from.node(depth).attrs)) return false;
    const node = $from.node(depth);
    transaction.setNodeMarkup($from.before(depth), undefined, { ...node.attrs, ...values });
  } else {
    const mark = editor.schema.marks.language;
    if (!mark || target.from === target.to) return false;
    transaction.removeMark(target.from, target.to, mark);
    if (values.lang || values.dir) transaction.addMark(target.from, target.to, mark.create(values));
  }
  return dispatch(editor, transaction);
}

export function footnoteDefinitions(editor: Editor): { label: string; node: Node; pos: number }[] {
  const definitions: { label: string; node: Node; pos: number }[] = [];
  editor.state.doc.forEach((node, pos) => {
    if (node.type.name === 'footnoteDefinition') definitions.push({ label: node.attrs.label, node, pos });
  });
  return definitions;
}

export function canInsertFootnote(target: AnnotationTarget): boolean {
  for (let depth = target.selection.$from.depth; depth > 0; depth--) {
    if (target.selection.$from.node(depth).type.name === 'footnoteDefinition') return false;
  }
  return target.selection.$from.parent.isTextblock && !target.ruby;
}

/** Create a reference and definition atomically, or reuse an already resolved label. */
export function insertFootnote(
  editor: Editor,
  target: AnnotationTarget,
  label: string,
  body: string,
  isCurrent: () => boolean,
): boolean {
  if (!currentTarget(editor, target, isCurrent) || !canInsertFootnote(target) || !validFootnoteLabel(label))
    return false;
  const reference = editor.schema.nodes.footnoteReference;
  const definition = editor.schema.nodes.footnoteDefinition;
  const paragraph = editor.schema.nodes.paragraph;
  if (!reference || !definition || !paragraph) return false;
  const exists = footnoteDefinitions(editor).some((note) => note.label === label);
  const transaction = editor.state.tr;
  // Insertion preserves selected annotated text; only an explicitly selected reference is replaced.
  if (target.selection instanceof NodeSelection && target.selection.node.type === reference) {
    transaction.replaceWith(target.selection.from, target.selection.to, reference.create({ label }));
  } else {
    transaction.insert(target.selection.to, reference.create({ label }));
  }
  if (!exists) {
    const lines = body.split('\n').map((text) => paragraph.create(null, text ? editor.schema.text(text) : undefined));
    transaction.insert(transaction.doc.content.size, definition.create({ label }, lines));
  }
  transaction.setSelection(TextSelection.near(transaction.doc.resolve(target.selection.to + 1)));
  return dispatch(editor, transaction);
}

/** Renaming a definition updates every reference without rebuilding its rich body. */
export function renameFootnote(
  editor: Editor,
  target: AnnotationTarget,
  label: string,
  isCurrent: () => boolean,
): boolean {
  if (!target.footnote || !currentTarget(editor, target, isCurrent) || !validFootnoteLabel(label)) return false;
  if (label === target.footnote) return true;
  if (label !== target.footnote && footnoteDefinitions(editor).some((note) => note.label === label)) return false;
  const transaction = editor.state.tr;
  transaction.doc.descendants((node, pos) => {
    if (['footnoteReference', 'footnoteDefinition'].includes(node.type.name) && node.attrs.label === target.footnote)
      transaction.setNodeMarkup(pos, undefined, { ...node.attrs, label });
  });
  return transaction.docChanged && dispatch(editor, transaction);
}

export function removeFootnote(
  editor: Editor,
  target: AnnotationTarget,
  all: boolean,
  isCurrent: () => boolean,
): boolean {
  if (!target.footnote || !currentTarget(editor, target, isCurrent)) return false;
  const ranges: { from: number; to: number }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.attrs.label !== target.footnote) return;
    const reference = node.type.name === 'footnoteReference';
    if (
      (all && (reference || node.type.name === 'footnoteDefinition')) ||
      (!all && reference && target.selection instanceof NodeSelection && pos === target.selection.from)
    )
      ranges.push({ from: pos, to: pos + node.nodeSize });
  });
  if (!ranges.length) return false;
  const transaction = editor.state.tr;
  for (const range of ranges.sort((a, b) => b.from - a.from)) transaction.delete(range.from, range.to);
  return dispatch(editor, transaction);
}

export function focusFootnoteBody(editor: Editor, label: string, isCurrent: () => boolean): boolean {
  if (!isCurrent() || editor.isDestroyed || !editor.isEditable) return false;
  const note = footnoteDefinitions(editor).find((candidate) => candidate.label === label);
  if (!note) return false;
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(note.pos + 1))).scrollIntoView(),
  );
  editor.view.focus();
  return true;
}
