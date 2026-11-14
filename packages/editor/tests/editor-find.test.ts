import { expect, test } from 'bun:test';
import { getSchema } from '@tiptap/core';
import { history, undo, redo } from '@tiptap/pm/history';
import { EditorState } from '@tiptap/pm/state';
import { documentExtensionsForProfile } from '../src/components/document-extensions.ts';
import { findDocumentMatches, replaceDocumentMatches } from '../src/components/editor-find.tsx';
import { editorShortcutMatches, orderedEditorCommands } from '../src/components/editor-command-preferences.ts';

const schema = getSchema(documentExtensionsForProfile('blocks'));
const options = { matchCase: false, wholeWord: false };

test('find respects case and word options and never crosses atoms, ruby boundaries or blocks', () => {
  const doc = schema.nodeFromJSON({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'cat Cat scatter ' },
          { type: 'text', text: 'mar', marks: [{ type: 'bold' }] },
          { type: 'text', text: 'ked ' },
          { type: 'mention', attrs: { accountId: '00000000-0000-4000-8000-000000000000' } },
          { type: 'text', text: 'end' },
          { type: 'ruby', attrs: { rt: 'reading' }, content: [{ type: 'text', text: 'cat' }] },
        ],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'cat' }] },
    ],
  });
  expect(findDocumentMatches(doc, 'cat', options).total).toBe(5);
  expect(findDocumentMatches(doc, 'cat', { matchCase: true, wholeWord: true }).total).toBe(3);
  expect(findDocumentMatches(doc, 'marked', options).total).toBe(1);
  expect(findDocumentMatches(doc, ' end', options).total).toBe(0);
  expect(findDocumentMatches(doc, 'endcat', options).total).toBe(0);
  expect(findDocumentMatches(doc, 'catcat', options).total).toBe(0);
});

test('replace all retains marks at an unmarked to bold boundary, opaque nodes and one undo event', () => {
  const doc = schema.nodeFromJSON({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'paragraph' },
        content: [
          { type: 'text', text: 'prefix ' },
          {
            type: 'text',
            text: 'match',
            marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://example.test' } }],
          },
          { type: 'text', text: ' ' },
          { type: 'ruby', attrs: { rt: 'reading', position: 'over' }, content: [{ type: 'text', text: 'match' }] },
          {
            type: 'extensionInline',
            attrs: {
              id: 'opaque',
              definition: 'unavailable',
              version: '1',
              payload: { private: 2 },
              fallback: 'Fallback',
            },
          },
        ],
      },
    ],
  });
  let state = EditorState.create({ schema, doc, plugins: [history()] });
  const matches = findDocumentMatches(doc, 'match', options).matches;
  const transaction = replaceDocumentMatches(state, matches, 'changed')!;
  state = state.apply(transaction);
  const bold = state.doc.firstChild!.child(1);
  expect(bold.text).toBe('changed');
  expect(bold.marks.map((mark) => mark.type.name)).toEqual(['bold', 'link']);
  expect(state.doc.firstChild!.child(3).attrs.rt).toBe('reading');
  expect(state.doc.firstChild!.lastChild!.attrs.payload).toEqual({ private: 2 });
  expect(
    undo(state, (step) => {
      state = state.apply(step);
    }),
  ).toBe(true);
  expect(state.doc.eq(doc)).toBe(true);
  expect(
    redo(state, (step) => {
      state = state.apply(step);
    }),
  ).toBe(true);
  expect(state.doc.textContent).toContain('changed');
});

test('logical replacement includes more than the retained highlight bound', () => {
  const doc = schema.nodeFromJSON({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a '.repeat(10_001) }] }],
  });
  const matches = findDocumentMatches(doc, 'a', options);
  expect(matches.total).toBe(10_001);
  expect(matches.matches).toHaveLength(10_001);
  const state = EditorState.create({ schema, doc });
  expect(state.apply(replaceDocumentMatches(state, matches.matches, 'b')!).doc.textContent).toBe('b '.repeat(10_001));
});

const event = (overrides: Partial<KeyboardEvent> = {}) =>
  ({
    key: '*',
    code: 'Digit8',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: true,
    isComposing: false,
    keyCode: 56,
    getModifierState: () => false,
    ...overrides,
  }) as KeyboardEvent;
test('portable shortcuts handle shifted digits while leaving native layout and composition input alone', () => {
  expect(editorShortcutMatches(event(), 'Mod-Shift-8')).toBe(true);
  expect(editorShortcutMatches(event({ key: 'è', code: 'Digit7' }), 'Mod-Shift-7')).toBe(true);
  for (const native of [
    event({ isComposing: true }),
    event({ key: 'Process' }),
    event({ key: 'Dead' }),
    event({ keyCode: 229 }),
    event({ getModifierState: (key) => key === 'AltGraph' }),
    event({ altKey: true }),
  ])
    expect(editorShortcutMatches(native, 'Mod-Shift-8')).toBe(false);
  expect(editorShortcutMatches(event({ ctrlKey: false, shiftKey: false, key: 'é', code: 'KeyE' }), 'Mod-e')).toBe(
    false,
  );
});

test('control preferences hide and order commands without changing their source vocabulary', () => {
  const commands = [{ id: 'bold' }, { id: 'table' }, { id: 'link' }];
  expect(
    orderedEditorCommands(commands, {
      hiddenCommands: ['table'],
      pinnedCommands: ['link'],
      commandOrder: ['bold'],
    }).map((command) => command.id),
  ).toEqual(['link', 'bold']);
  expect(commands).toHaveLength(3);
});
