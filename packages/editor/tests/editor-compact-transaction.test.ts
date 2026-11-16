import { expect, test } from 'bun:test';
import { getSchema } from '@tiptap/core';
import { history, undo, redo, undoDepth, redoDepth } from '@tiptap/pm/history';
import { Fragment, Slice, type Node } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection, type Transaction } from '@tiptap/pm/state';
import { Mapping, ReplaceStep, type Step } from '@tiptap/pm/transform';
import { documentExtensionsForProfile } from '../src/components/document-extensions.ts';
import {
  compactHistory,
  compactHistoryState,
  compactTransaction,
  compactTransactionMetrics,
  identityPreservingBatch,
} from '../src/components/editor-compact-transaction.ts';
import { buildTextDocument, TextDocumentIndex } from '../src/components/editor-text-document.ts';

const schema = getSchema(documentExtensionsForProfile('blocks'));
const doc = (value: string) =>
  schema.nodes.doc!.create(null, schema.nodes.paragraph!.create({ id: 'p' }, schema.text(value)));
const insertion = (value: string) => (value ? new Slice(Fragment.from(schema.text(value)), 0, 0) : Slice.empty);
const flags = (mapping: Mapping, position: number, assoc: number) => {
  const result = mapping.mapResult(position, assoc);
  return [result.pos, result.deleted, result.deletedBefore, result.deletedAfter, result.deletedAcross];
};

function compare(source: Node, steps: readonly Step[], selection = TextSelection.create(source, 1)) {
  const state = EditorState.create({ schema, doc: source, selection });
  const native = state.tr;
  const compact = compactTransaction(state);
  for (const step of steps) {
    native.step(step);
    compact.step(step);
  }
  expect(compact.doc.toJSON()).toEqual(native.doc.toJSON());
  expect(compact.steps.map((step) => step.toJSON())).toEqual(native.steps.map((step) => step.toJSON()));
  expect(compact.selection.toJSON()).toEqual(native.selection.toJSON());
  expect(compact.selection.$from.doc).toBe(compact.doc);
  for (let index = 0; index < steps.length; index++) {
    const prefix = compact.docs[index]!;
    expect(prefix.toJSON()).toEqual(native.docs[index]!.toJSON());
    expect(prefix.resolve(1).doc).toBe(prefix);
    expect(compact.steps[index]).toBeInstanceOf(ReplaceStep);
    expect(Object.getPrototypeOf(compact.steps[index])).toBe(ReplaceStep.prototype);
    expect(compact.steps[index]!.invert(prefix).toJSON()).toEqual(
      native.steps[index]!.invert(native.docs[index]!).toJSON(),
    );
    const foreign = doc('foreign content that is long enough for each small fixture');
    expect(compact.steps[index]!.invert(foreign).toJSON()).toEqual(native.steps[index]!.invert(foreign).toJSON());
  }
  for (let position = 0; position <= source.content.size; position++)
    for (const assoc of [-1, 1]) {
      expect(flags(compact.mapping, position, assoc)).toEqual(flags(native.mapping, position, assoc));
    }
  const saved = compact.docs[1]?.toJSON();
  for (const prefix of compact.docs) prefix.toJSON();
  expect(compact.docs[1]?.toJSON()).toEqual(saved);
  expect(compact.selection.$from.doc).toBe(compact.doc);
  expect(compactTransactionMetrics(compact)!.cacheEntries).toBeLessThanOrEqual(2);
  return compact;
}

test('closed descending/ascending replacements preserve native prefixes, steps, flags and inverse identity', () => {
  for (const replacement of ['', 'x', 'longer']) {
    const source = doc('a a a a');
    const descending = [7, 5, 3, 1].map((from) => new ReplaceStep(from, from + 1, insertion(replacement)));
    expect(compactTransactionMetrics(compare(source, descending))!.fastSteps).toBe(4);
    let delta = 0;
    const ascending = [1, 3, 5, 7].map((from) => {
      const step = new ReplaceStep(from + delta, from + delta + 1, insertion(replacement));
      delta += replacement.length - 1;
      return step;
    });
    expect(compactTransactionMetrics(compare(source, ascending))!.fastSteps).toBe(4);
  }
  compare(doc('aa'), [new ReplaceStep(2, 3, insertion('bb')), new ReplaceStep(1, 2, insertion('bb'))]);
  compare(doc('a'), [new ReplaceStep(1, 1, insertion('b')), new ReplaceStep(1, 1, insertion('c'))]);
  compare(doc('a'), [new ReplaceStep(1, 1, insertion('b')), new ReplaceStep(2, 2, insertion('c'))]);
});

test('reverse selection and stored marks retain real final-document identity', () => {
  const source = doc('a a a');
  const state = EditorState.create({
    schema,
    doc: source,
    selection: TextSelection.create(source, 6, 1),
    storedMarks: [schema.marks.bold!.create()],
  });
  const tr = compactTransaction(state);
  tr.step(new ReplaceStep(5, 6, insertion('bb'))).step(new ReplaceStep(1, 2, insertion('bb')));
  const selection = tr.selection;
  tr.setSelection(selection).setStoredMarks(state.storedMarks);
  expect(selection.anchor).toBeGreaterThan(selection.head);
  expect(selection.$from.doc).toBe(tr.doc);
  const applied = state.apply(tr);
  expect(applied.selection.$from.doc).toBe(applied.doc);
  expect(applied.storedMarks).toBeNull();
  const cursorState = EditorState.create({
    schema,
    doc: source,
    selection: TextSelection.create(source, 1),
    storedMarks: state.storedMarks,
  });
  const cursor = compactTransaction(cursorState)
    .step(new ReplaceStep(5, 6, insertion('bb')))
    .setStoredMarks(cursorState.storedMarks);
  expect(cursorState.apply(cursor).storedMarks?.map((mark) => mark.type.name)).toEqual(['bold']);
});

test('non-monotone/structural and foreign method steps use the ordinary path without masking identity repair', () => {
  const source = doc('a a a a');
  const mixed = compare(source, [
    new ReplaceStep(5, 6, insertion('b')),
    new ReplaceStep(1, 2, insertion('c')),
    new ReplaceStep(7, 8, insertion('d')),
  ]);
  expect(compactTransactionMetrics(mixed)!.ordinarySteps).toBe(1);
  expect(identityPreservingBatch([mixed])).toBe(false);
  const state = EditorState.create({ schema, doc: source });
  const tr = compactTransaction(state).step(new ReplaceStep(1, 2, insertion('b')));
  const structural = state.tr.insert(source.content.size, schema.nodes.paragraph!.create({ id: null }));
  expect(identityPreservingBatch([tr])).toBe(true);
  expect(identityPreservingBatch([tr, structural])).toBe(false);
  const foreign = new ReplaceStep(3, 4, insertion('c'));
  Object.defineProperty(foreign, 'invert', { value: () => new ReplaceStep(3, 4, insertion('foreign')) });
  const ordinary = compactTransaction(state).step(foreign);
  expect(ordinary.steps[0]).toBe(foreign);
  expect(compactTransactionMetrics(ordinary)!.ordinarySteps).toBe(1);
  const modified = tr.steps[0]!;
  modified.invert = foreign.invert;
  const replay = compactTransaction(state).step(modified);
  expect(replay.steps[0]).toBe(modified);
  expect(identityPreservingBatch([replay])).toBe(false);
});

test('native mapped/merged history preserves partial-member deletion, bookmarks, undo and redo', () => {
  for (const sourceText of ['a a a a', 'aaaa']) {
    const source = doc(sourceText);
    let native = EditorState.create({ schema, doc: source, plugins: [history()] });
    let compact = EditorState.create({ schema, doc: source, plugins: [history()] });
    const positions = [...sourceText.matchAll(/a/g)].map((match) => match.index + 1).reverse();
    const n = native.tr,
      c = compactTransaction(compact);
    for (const position of positions) {
      const step = new ReplaceStep(position, position + 1, insertion('bb'));
      n.step(step);
      c.step(step);
    }
    const bookmark = TextSelection.create(source, source.content.size - 1).getBookmark();
    native = native.apply(n);
    compact = compact.apply(c);
    expect(bookmark.map(c.mapping).resolve(compact.doc).toJSON()).toEqual(
      bookmark.map(n.mapping).resolve(native.doc).toJSON(),
    );
    native = native.apply(native.tr.delete(4, 6).setMeta('addToHistory', false));
    compact = compact.apply(compact.tr.delete(4, 6).setMeta('addToHistory', false));
    for (const command of [undo, redo, undo, redo]) {
      let last: Transaction | undefined;
      expect(
        command(native, (tr) => {
          native = native.apply(tr);
        }),
      ).toBe(true);
      expect(
        compactHistory(command, compact, (tr) => {
          last = tr;
          compact = compact.apply(tr);
        }),
      ).toBe(true);
      expect(compact.doc.toJSON()).toEqual(native.doc.toJSON());
      expect(compact.selection.toJSON()).toEqual(native.selection.toJSON());
      expect([undoDepth(compact), redoDepth(compact)]).toEqual([undoDepth(native), redoDepth(native)]);
      expect(compact.selection.$from.doc).toBe(compact.doc);
      expect(compactTransactionMetrics(last!)!.cachedInversions).toBeGreaterThan(0);
    }
  }
});

test('one-pass text builder keeps marks, atoms and nested ruby and rejects escaped expansion before joining', () => {
  const source = schema.nodeFromJSON({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'p' },
        content: [
          { type: 'text', text: 'prefix ' },
          {
            type: 'text',
            text: 'match',
            marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://example.test' } }],
          },
          { type: 'mention', attrs: { accountId: '00000000-0000-4000-8000-000000000000' } },
          { type: 'ruby', attrs: { rt: 'reading' }, content: [{ type: 'text', text: 'match' }] },
        ],
      },
    ],
  });
  const index = new TextDocumentIndex(source);
  const edits = [index.edit(8, 13, new Slice(Fragment.from(schema.text('changed', index.firstMarks(8)!)), 0, 0))!.edit];
  const result = buildTextDocument(source, edits);
  expect(result.firstChild!.child(1).marks.map((mark) => mark.type.name)).toEqual(['bold', 'link']);
  expect(result.firstChild!.child(2)).toBe(source.firstChild!.child(2));
  expect(result.firstChild!.child(3)).toBe(source.firstChild!.child(3));
  const plain = doc('a');
  const expanded = new TextDocumentIndex(plain).edit(1, 2, insertion('\u0000'.repeat(100)))!.edit;
  expect(() => buildTextDocument(plain, [expanded], 500, false)).toThrow(RangeError);
  expect(buildTextDocument(plain, [expanded], 601).textContent).toHaveLength(100);
});

test('dense 100k characters build and apply with native history, bookmarks, undo and redo without prefix retention', () => {
  for (const spaced of [false, true]) {
    const sourceText = spaced ? 'a '.repeat(50_000) : 'a'.repeat(100_000);
    const source = doc(sourceText);
    let state = EditorState.create({ schema, doc: source, plugins: [history()] });
    const bookmarkAt = spaced ? 50_002 : 50_000;
    const bookmark = TextSelection.create(source, bookmarkAt).getBookmark();
    const start = performance.now();
    const tr = compactTransaction(state);
    for (let from = sourceText.length - (spaced ? 1 : 0); from >= 1; from -= spaced ? 2 : 1)
      tr.step(new ReplaceStep(from, from + 1, insertion('bb')));
    const built = performance.now();
    state = state.apply(tr);
    const applied = performance.now();
    expect(state.doc.textContent.length).toBe(spaced ? 150_000 : 200_000);
    const beforeCount = spaced ? bookmarkAt / 2 : bookmarkAt - 1;
    expect(bookmark.map(tr.mapping).resolve(state.doc).from).toBe(bookmarkAt + beforeCount);
    expect(compactTransactionMetrics(tr)!.materializations).toBeLessThanOrEqual(1);
    expect(compactTransactionMetrics(tr)!.cachedInversions).toBe(spaced ? 50_000 : 100_000);
    expect(
      undo(compactHistoryState(state), (transaction) => {
        state = state.apply(transaction);
      }),
    ).toBe(true);
    const undone = performance.now();
    expect(state.doc.eq(source)).toBe(true);
    expect(
      redo(compactHistoryState(state), (transaction) => {
        state = state.apply(transaction);
      }),
    ).toBe(true);
    expect(state.doc.textContent.length).toBe(spaced ? 150_000 : 200_000);
    console.info(
      JSON.stringify({
        compactDense: true,
        spaced,
        characters: 100_000,
        steps: tr.steps.length,
        buildMs: Math.round(built - start),
        applyMs: Math.round(applied - built),
        undoMs: Math.round(undone - applied),
        redoMs: Math.round(performance.now() - undone),
      }),
    );
  }
});

// This reached >20s without indexed evaluation. Its correctness assertions stay in the regular suite.
test('large separated history applies real non-history insertion and deletion before indexed native undo and redo', () => {
  for (const kind of ['insert', 'delete']) {
    const source = doc('a '.repeat(50_000));
    let state = EditorState.create({ schema, doc: source, plugins: [history()] });
    const tr = compactTransaction(state);
    for (let from = 99_999; from >= 1; from -= 2) tr.step(new ReplaceStep(from, from + 1, insertion('bb')));
    state = state.apply(tr);
    state = state.apply(
      (kind === 'insert' ? state.tr.insertText('!', 50_001) : state.tr.delete(50_001, 50_002)).setMeta(
        'addToHistory',
        false,
      ),
    );
    const edited = state.doc.textContent;
    const expected =
      source.textContent.slice(0, 33_333) +
      (kind === 'insert' ? '!' + source.textContent.slice(33_333) : source.textContent.slice(33_334));
    const started = performance.now();
    let undoTransaction: Transaction | undefined;
    expect(
      compactHistory(undo, state, (transaction) => {
        undoTransaction = transaction;
        state = state.apply(transaction);
      }),
    ).toBe(true);
    const undone = performance.now();
    expect(state.doc.textContent === expected).toBe(true);
    expect(compactTransactionMetrics(undoTransaction!)!.skippedMaps).toBeGreaterThan(100_000);
    expect(
      compactHistory(redo, state, (transaction) => {
        state = state.apply(transaction);
      }),
    ).toBe(true);
    expect(state.doc.textContent === edited).toBe(true);
    console.info(
      JSON.stringify({
        largeNativeRemap: kind,
        undoMs: Math.round(undone - started),
        redoMs: Math.round(performance.now() - undone),
        work: compactTransactionMetrics(undoTransaction!),
      }),
    );
  }
});
