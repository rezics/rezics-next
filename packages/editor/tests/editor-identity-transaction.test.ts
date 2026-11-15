import { expect, test } from 'bun:test';
import { getSchema } from '@tiptap/core';
import { history, undo, redo } from '@tiptap/pm/history';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { AddMarkStep, RemoveMarkStep, AttrStep, Step } from '@tiptap/pm/transform';
import { documentExtensionsForProfile } from '../src/components/document-extensions.ts';
import {
  compactHistory,
  compactIdentityTransaction,
  compactTransaction,
  compactTransactionMetrics,
  identityPreservingBatch,
} from '../src/components/editor-compact-transaction.ts';

const schema = getSchema(documentExtensionsForProfile('blocks'));
const style = (color: string) => schema.marks.textStyle!.create({ color, backgroundColor: 'green' });
const source = (count = 3) =>
  schema.nodes.doc!.create(
    null,
    Array.from({ length: count }, (_, index) =>
      schema.nodes.paragraph!.create({ id: `p${index}` }, schema.text('abc', [style('red')])),
    ),
  );

test('native mark/attribute prefixes, private MarkSet inversions and foreign inversion stay exact', () => {
  const doc = source();
  const state = EditorState.create({ schema, doc });
  const steps = [
    new AddMarkStep(1, 4, style('blue')),
    new RemoveMarkStep(6, 9, style('red')),
    new AttrStep(0, 'textAlign', 'right'),
    new AttrStep(0, 'textAlign', 'center'),
  ];
  const native = state.tr,
    compact = compactTransaction(state);
  for (const step of steps) {
    native.step(step);
    compact.step(step);
  }
  expect(compact.doc.toJSON()).toEqual(native.doc.toJSON());
  expect(compact.steps.map((step) => step.toJSON())).toEqual(native.steps.map((step) => step.toJSON()));
  for (let index = 0; index < steps.length; index++) {
    expect(compact.docs[index]!.toJSON()).toEqual(native.docs[index]!.toJSON());
    const actual = compact.steps[index]!.invert(compact.docs[index]!);
    const expected = native.steps[index]!.invert(native.docs[index]!);
    expect(actual.toJSON()).toEqual(expected.toJSON());
    expect(Object.getPrototypeOf(actual) === Object.getPrototypeOf(expected)).toBe(true);
    const foreign = source();
    expect(compact.steps[index]!.invert(foreign).toJSON()).toEqual(native.steps[index]!.invert(foreign).toJSON());
  }
  expect(identityPreservingBatch([compact])).toBe(true);
  expect(compact.selection.$from.doc === compact.doc).toBe(true);
});

test('native MarkSet map/inverse/redo composition retains native output after partial nonhistory deletion', () => {
  const doc = source();
  let native = EditorState.create({ schema, doc, plugins: [history()] });
  let compact = EditorState.create({ schema, doc, plugins: [history()] });
  const mark = new AddMarkStep(1, 4, style('blue'));
  native = native.apply(native.tr.step(mark));
  compact = compact.apply(compactTransaction(compact).step(mark));
  native = native.apply(native.tr.insertText('!', 2).setMeta('addToHistory', false));
  compact = compact.apply(compact.tr.insertText('!', 2).setMeta('addToHistory', false));
  for (const command of [undo, redo, undo]) {
    command(native, (tr) => {
      native = native.apply(tr);
    });
    compactHistory(command, compact, (tr) => {
      compact = compact.apply(tr);
    });
    expect(compact.doc.toJSON()).toEqual(native.doc.toJSON());
    expect(compact.selection.toJSON()).toEqual(native.selection.toJSON());
  }
});

test('many-paragraph formatting and attributes keep native history bounded without caller trust tokens', () => {
  const doc = source(6_000);
  let state = EditorState.create({
    schema,
    doc,
    plugins: [history()],
    selection: TextSelection.create(doc, 1, doc.content.size - 1),
  });
  const steps: Step[] = [];
  doc.forEach((node, position) => {
    steps.push(new RemoveMarkStep(position + 1, position + node.nodeSize - 1, style('red')));
    steps.push(new AddMarkStep(position + 1, position + node.nodeSize - 1, style('blue')));
    steps.push(new AttrStep(position, 'textAlign', 'right'));
  });
  const started = performance.now();
  const tr = compactIdentityTransaction(state, steps)!;
  expect(identityPreservingBatch([tr])).toBe(true);
  state = state.apply(tr);
  const applied = performance.now();
  expect(compactTransactionMetrics(tr)!.materializations).toBe(1);
  expect(compactTransactionMetrics(tr)!.cachedInversions).toBe(steps.length);
  state = state.apply(state.tr.insertText('!', 1).setMeta('addToHistory', false));
  let undone: Transaction | undefined;
  expect(
    compactHistory(undo, state, (transaction) => {
      undone = transaction;
      state = state.apply(transaction);
    }),
  ).toBe(true);
  const undoEnd = performance.now();
  expect(state.doc.firstChild!.attrs.textAlign).toBeNull();
  expect(state.doc.firstChild!.lastChild!.marks[0]!.attrs.color).toBe('red');
  expect(state.doc.textContent.startsWith('!abc')).toBe(true);
  expect(
    compactHistory(redo, state, (transaction) => {
      state = state.apply(transaction);
    }),
  ).toBe(true);
  expect(state.doc.firstChild!.attrs.textAlign).toBe('right');
  expect(state.doc.firstChild!.lastChild!.marks[0]!.attrs.color).toBe('blue');
  expect(compactTransactionMetrics(undone!)!.ordinarySteps).toBe(0);
  console.info(
    JSON.stringify({
      identityFormatting: true,
      paragraphs: 6_000,
      steps: steps.length,
      buildApplyMs: Math.round(applied - started),
      undoMs: Math.round(undoEnd - applied),
      redoMs: Math.round(performance.now() - undoEnd),
    }),
  );
});

test('actual merged output runs govern expansion admission and no-op formatting has no history event', () => {
  const state = EditorState.create({ schema, doc: source() });
  expect(compactIdentityTransaction(state, [new AttrStep(0, 'textAlign', null)])!.steps).toHaveLength(0);
  const huge = schema.marks.textStyle!.create({ color: 'x'.repeat(1_000_000) });
  const doc = source(20);
  const current = EditorState.create({ schema, doc });
  const steps: Step[] = [];
  doc.forEach((node, position) => steps.push(new AddMarkStep(position + 1, position + node.nodeSize - 1, huge)));
  expect(compactIdentityTransaction(current, steps)).toBeNull();
});
