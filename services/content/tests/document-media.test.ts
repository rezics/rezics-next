import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { fromPlainText } from '@rezics/document';
import { documentImageUses, guardDocumentImageUses } from '../src/document-media.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = `https://rezics.com/id/${id(1)}`;
const use = { use: id(2), representation: id(3), occurrence: id(4), conceal: false };
function client(protection: string | null, value: unknown, representation = use.representation) {
  return { query: async (query: string) => ({ rows: query.includes('FROM media.use')
    ? [{ id: use.use, representation_id: representation, occurrence: use.occurrence, target, role: 'document-image' }]
    : [{ use_id: use.use, protection_head: protection, value }] }) } as unknown as PoolClient;
}

test('whole-document saves cannot change protected concealment or rebind exact bytes', async () => {
  await guardDocumentImageUses(client(null, false), [use], [target]);
  await guardDocumentImageUses(client(id(5), true), [use], [target], [use]);
  await expect(guardDocumentImageUses(client(null, true), [use], [target])).rejects.toThrow('before saving');
  await guardDocumentImageUses(client(id(5), false), [use], [target]);
  await expect(guardDocumentImageUses(client(id(5), true), [use], [target])).rejects.toThrow('locked');
  await expect(guardDocumentImageUses(client(null, false, id(8)), [use], [target])).rejects.toThrow('representation');
  await expect(guardDocumentImageUses(client(null, false), [use], ['other'])).rejects.toThrow('target');
});

test('managed delivery URLs require stable media references; external legacy images remain valid', () => {
  const base = fromPlainText('caption', 'blocks');
  const attrs = { id: use.occurrence, src: '/api/main/v1/media/representations/example/bytes',
    representationId: use.representation, mediaUseId: use.use, conceal: true };
  const snapshot = { ...base, doc: { ...base.doc, content: [{ type: 'image', attrs }] } };
  expect(documentImageUses(snapshot)).toEqual([{ ...use, conceal: true }]);
  expect(() => documentImageUses({ ...snapshot, doc: { ...snapshot.doc,
    content: [{ type: 'image', attrs: { id: use.occurrence, src: attrs.src } }] } })).toThrow('exact representation');
  for (const src of [`https://rezics.com${attrs.src}`, `//rezics.com${attrs.src}`,
    `HTTPS://rezics.com${attrs.src}`, `/discard/..${attrs.src}`]) {
    expect(() => documentImageUses({ ...snapshot, doc: { ...snapshot.doc,
      content: [{ type: 'image', attrs: { id: use.occurrence, src } }] } })).toThrow('exact representation');
  }
  expect(documentImageUses({ ...snapshot, doc: { ...snapshot.doc,
    content: [{ type: 'image', attrs: { src: 'https://example.org/image.png' } }] } })).toEqual([]);
});
