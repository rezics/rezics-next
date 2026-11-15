import { expect, test } from 'bun:test';
import { getSchema } from '@tiptap/core';
import { closeHistory, history, undo, redo } from '@tiptap/pm/history';
import { Fragment, Slice } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';
import { documentExtensionsForProfile } from '../src/components/document-extensions.ts';
import { compactHistory } from '../src/components/editor-compact-transaction.ts';
import { findDocumentMatches, replaceDocumentMatches } from '../src/components/editor-find.tsx';

test('same-width adjacent replacement history matches stock native after a real foreign deletion, node markup and metadata', () => {
  const schema = getSchema(documentExtensionsForProfile('blocks'));
  const source = schema.nodeFromJSON({
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { id: 'kept' }, content: [{ type: 'text', text: 'Kept' }] },
      {
        type: 'paragraph',
        attrs: { id: 'body' },
        content: [
          { type: 'text', text: 'aaaaaaaa', marks: [{ type: 'bold' }] },
          {
            type: 'text',
            text: 'aaaaaaaa',
            marks: [
              { type: 'link', attrs: { href: 'https://example.test/chapter' } },
              { type: 'textStyle', attrs: { color: '#b91c1c' } },
            ],
          },
          { type: 'text', text: 'aaaaaaaa' },
        ],
      },
    ],
  });
  const body = source.firstChild!.nodeSize,
    from = body + 1,
    middle = from + 12;
  const selection = TextSelection.create(source, from, from + 1);
  let native = EditorState.create({ schema, doc: source, selection, plugins: [history()] });
  let compact = EditorState.create({ schema, doc: source, selection, plugins: [history()] });
  let nativeBookmark = TextSelection.create(source, middle).getBookmark(),
    compactBookmark = nativeBookmark;
  const compare = (normal: Transaction, owned: Transaction) => {
    expect(owned.steps.map((step) => step.toJSON())).toEqual(normal.steps.map((step) => step.toJSON()));
    expect(owned.mapping.maps.map((map) => map.toString())).toEqual(normal.mapping.maps.map((map) => map.toString()));
    for (let position = 0; position <= native.doc.content.size; position++)
      for (const assoc of [-1, 1]) {
        const flags = (tr: Transaction) => {
          const result = tr.mapping.mapResult(position, assoc);
          return [result.pos, result.deleted, result.deletedBefore, result.deletedAfter, result.deletedAcross];
        };
        expect(flags(owned)).toEqual(flags(normal));
      }
    native = native.apply(normal);
    compact = compact.apply(owned);
    nativeBookmark = nativeBookmark.map(normal.mapping);
    compactBookmark = compactBookmark.map(owned.mapping);
    expect(compact.doc.toJSON()).toEqual(native.doc.toJSON());
    expect(compact.selection.toJSON()).toEqual(native.selection.toJSON());
    expect(compactBookmark.resolve(compact.doc).from).toBe(nativeBookmark.resolve(native.doc).from);
    expect(compact.selection.$from.doc).toBe(compact.doc);
  };
  const found = findDocumentMatches(source, 'a', { matchCase: true, wholeWord: false });
  const normal = closeHistory(native.tr);
  for (const match of found.matches.toReversed())
    normal.step(
      new ReplaceStep(
        match.from,
        match.to,
        new Slice(Fragment.from(schema.text('b', source.nodeAt(match.from)!.marks)), 0, 0),
      ),
    );
  normal.setSelection(TextSelection.create(normal.doc, from + 1)).setStoredMarks(native.storedMarks);
  compare(normal, replaceDocumentMatches(compact, found.matches, 'b')!);
  compare(closeHistory(native.tr), closeHistory(compact.tr));
  const foreign = (state: EditorState) =>
    state.tr
      .delete(middle, middle + 1)
      .setNodeMarkup(body, undefined, { ...state.doc.nodeAt(body)!.attrs, id: 'retained-id' })
      .setMeta('addToHistory', false)
      .setMeta('performanceMetadata', true);
  compare(foreign(native), foreign(compact));
  expect(native.doc.nodeAt(body)!.textContent).toBe('b'.repeat(23));
  for (const command of [undo, redo]) {
    const result: { normal: Transaction | null; owned: Transaction | null } = { normal: null, owned: null };
    expect(
      command(native, (tr) => {
        result.normal = tr;
      }),
    ).toBe(true);
    expect(
      compactHistory(command, compact, (tr) => {
        result.owned = tr;
      }),
    ).toBe(true);
    // This is a maintained native merged replacement, not one retained history step per original character.
    expect(result.normal!.steps.length).toBe(1);
    compare(result.normal!, result.owned!);
    expect(native.doc.nodeAt(body)!.attrs.id).toBe('retained-id');
    expect(native.doc.nodeAt(body)!.textContent).toBe(command === undo ? 'a'.repeat(24) : 'b'.repeat(23));
  }
});
