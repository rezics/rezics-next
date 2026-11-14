import { expect, test } from 'bun:test';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { documentExtensionsForProfile } from '../src/components/document-extensions.ts';
import { restoreMovedUnitIdentity } from '../src/components/editor-drag-identity.ts';

const schema = getSchema(documentExtensionsForProfile('blocks'));
const unit = {
  type: 'bulletList',
  attrs: { id: 'list' },
  content: [
    {
      type: 'listItem',
      attrs: { id: 'item' },
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'paragraph', lang: 'ja' },
          content: [
            { type: 'text', text: 'A unit', marks: [{ type: 'bold' }] },
            {
              type: 'extensionInline',
              attrs: {
                id: 'opaque',
                definition: 'future',
                version: '1',
                payload: { nested: ['retained'] },
                fallback: 'Fallback',
              },
            },
          ],
        },
      ],
    },
  ],
};
const original = schema.nodeFromJSON(unit);
const renewed = schema.nodeFromJSON(JSON.parse(JSON.stringify(unit).replace(/"id":"([^"]+)"/g, '"id":"copy-$1"')));
const paragraph = schema.nodes.paragraph!.create({ id: 'other' }, schema.text('Other unit'));

test('a native move restores every nested identity and preserves content, marks and opaque payloads', () => {
  const state = EditorState.create({ schema, doc: schema.nodes.doc!.create(null, [paragraph, renewed]) });
  const restored = state.apply(restoreMovedUnitIdentity(state, paragraph.nodeSize, original)!).doc;
  expect(restored.child(1).eq(original)).toBe(true);
  expect(restored.child(0).eq(paragraph)).toBe(true);
});

test('copies keep renewed identities and a structurally changed target is never repaired as a move', () => {
  const copied = EditorState.create({ schema, doc: schema.nodes.doc!.create(null, [original, renewed]) });
  expect(restoreMovedUnitIdentity(copied, original.nodeSize, original)).toBeNull();
  const changed = EditorState.create({ schema, doc: schema.nodes.doc!.create(null, [paragraph]) });
  expect(restoreMovedUnitIdentity(changed, 0, original)).toBeNull();
});
