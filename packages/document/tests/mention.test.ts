// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import {
  blocksDocumentSchema,
  checkDocument,
  documentParagraphs,
  documentText,
  documentVersion,
  fromMarkdown,
  fromPlainText,
  hasDocumentContent,
  parseDocument,
  schemaForProfile,
  serializeDocument,
  textDocumentSchema,
  type DocumentNode,
  type DocumentProfile,
  type DocumentSnapshot,
} from '../src/index.ts';

const accountId = '01234567-89ab-4def-8123-456789abcdef';
const profiles: DocumentProfile[] = ['text', 'blocks'];

const snapshot = (content: DocumentNode[], profile: DocumentProfile): DocumentSnapshot => ({
  version: documentVersion,
  profile,
  doc: { type: 'doc', content },
});

const publishedSchema = (profile: DocumentProfile) =>
  Bun.file(new URL(`../schema/rezics-${profile}-v1.schema.json`, import.meta.url)).json();

const inlineMention = (id = accountId): DocumentNode => ({
  type: 'mention',
  attrs: { accountId: id },
  marks: [{ type: 'bold' }],
});

const textWithMention = (profile: DocumentProfile): DocumentSnapshot =>
  snapshot(
    [
      {
        type: 'paragraph',
        attrs: { id: 'p1' },
        content: [{ type: 'text', text: 'Before ' }, inlineMention(), { type: 'text', text: ' after' }],
      },
    ],
    profile,
  );

function findMention(node: DocumentNode): DocumentNode | undefined {
  if (node.type === 'mention') return node;
  for (const child of node.content ?? []) {
    const found = findMention(child);
    if (found) return found;
  }
}

test('text and blocks mention snapshots validate, serialize and round-trip unchanged', async () => {
  for (const profile of profiles) {
    const value = textWithMention(profile);
    const schema = await publishedSchema(profile);

    expect(Value.Check(schema, value)).toBe(true);
    expect(checkDocument(value)).toBe(true);
    expect(parseDocument(value)).toBe(value);

    const restored = parseDocument(JSON.parse(serializeDocument(value)));
    expect(findMention(restored.doc)).toEqual(inlineMention());

    const textRoundTrip = textDocumentSchema.nodeFromJSON(value.doc).toJSON();
    const blocksRoundTrip = blocksDocumentSchema.nodeFromJSON(textRoundTrip).toJSON();
    const textAgain = textDocumentSchema.nodeFromJSON(blocksRoundTrip).toJSON();
    expect(findMention(textAgain as DocumentNode)).toEqual(inlineMention());
  }
});

test('ProseMirror profile schemas enforce mention account IDs and inline atom shape', () => {
  for (const profile of profiles) {
    const schema = schemaForProfile(profile);
    const valid = textWithMention(profile);
    const node = schema.nodeFromJSON(valid.doc);
    node.check();
    expect(findMention(node.toJSON() as DocumentNode)).toEqual(inlineMention());

    const invalidId = textWithMention(profile);
    invalidId.doc.content![0]!.content![1]!.attrs!.accountId = accountId.toUpperCase();
    expect(() => schema.nodeFromJSON(invalidId.doc)).toThrow();
  }
});

test('both published schemas and checkDocument reject malformed mentions', async () => {
  for (const profile of profiles) {
    const schema = await publishedSchema(profile);
    const invalidSnapshots = [
      snapshot([{ type: 'paragraph', attrs: { id: 'p1' }, content: [{ type: 'mention', attrs: {} }] }], profile),
      snapshot(
        [{ type: 'paragraph', attrs: { id: 'p1' }, content: [inlineMention(accountId.toUpperCase())] }],
        profile,
      ),
      snapshot([{ type: 'paragraph', attrs: { id: 'p1' }, content: [inlineMention('not-a-uuid')] }], profile),
      snapshot(
        [
          {
            type: 'paragraph',
            attrs: { id: 'p1' },
            content: [{ ...inlineMention(), attrs: { accountId, handle: 'alice' } }],
          },
        ],
        profile,
      ),
      snapshot(
        [
          {
            type: 'paragraph',
            attrs: { id: 'p1' },
            content: [{ ...inlineMention(), content: [{ type: 'text', text: '@alice' }] }],
          },
        ],
        profile,
      ),
      snapshot([inlineMention()], profile),
    ];

    for (const value of invalidSnapshots) {
      expect(Value.Check(schema, value)).toBe(false);
      expect(checkDocument(value)).toBe(false);
    }
  }
});

test('plain text projections use the optional mention callback and default to a lone @', () => {
  const value = snapshot(
    [
      {
        type: 'paragraph',
        attrs: { id: 'p1' },
        content: [inlineMention(), { type: 'text', text: ' ' }, inlineMention('fedcba98-7654-4321-8fed-cba987654321')],
      },
    ],
    'text',
  );
  const mentionText = (id: string) =>
    id === accountId ? '@alice' : id === 'fedcba98-7654-4321-8fed-cba987654321' ? '@bob' : '@unknown';

  expect(documentText(value)).toBe('@ @');
  expect(documentParagraphs(value)).toEqual([{ id: 'p1', text: '@ @' }]);
  expect(documentText(value, mentionText)).toBe('@alice @bob');
  expect(documentParagraphs(value, mentionText)).toEqual([{ id: 'p1', text: '@alice @bob' }]);
  expect(documentText(value, () => '@carol @')).toBe('@carol @ @carol @');
  expect(hasDocumentContent(value)).toBe(true);
});

test('Markdown imports @handles as plain text without creating mentions', () => {
  const imported = fromMarkdown('@alice and @bob', 'text');

  expect(documentText(imported)).toBe('@alice and @bob');
  expect(findMention(imported.doc)).toBeUndefined();
});

test('adding mentions keeps existing snapshots valid and the document version unchanged', async () => {
  expect(documentVersion).toBe('rezics-document-v1');

  const existingSnapshots = [fromPlainText('First\nSecond'), fromMarkdown('# Heading\n\nText', 'text')];
  for (const value of existingSnapshots) {
    expect(value.version).toBe('rezics-document-v1');
    expect(checkDocument(value)).toBe(true);
    expect(Value.Check(await publishedSchema(value.profile), value)).toBe(true);
  }
});
