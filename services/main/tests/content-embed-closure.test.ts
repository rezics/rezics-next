import { expect, test } from 'bun:test';
import type { ContentCore, ExactContentReference, ExactReadResult }
  from '../../content/src/core.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { ContentEmbedDenied, assertPublicContentEmbeds, publicContentEmbedGuards,
  readContentEmbedClosure } from '../src/modules/content-publication/embed-closure.ts';

const revision = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const reference = (n: number): ExactContentReference => ({
  owner: 'content', resourceId: `https://rezics.com/id/${revision(100 + n)}`,
  variantId: `urn:rezics:variant:${revision(200 + n)}`, revisionId: revision(n),
  format: 'rezics-content-json-v1', model: 'content-shape-v1', byteDigest: 'a'.repeat(64),
  byteLength: 1, language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
  sourceRevision: null, predecessor: null, provenance: {},
});

test('BOOK06: private transitive embed is visited and denied before publication', async () => {
  const bodies = new Map([[revision(1), { body: 'root', embeds: [revision(2)] }],
    [revision(2), { body: 'intermediate', embeds: [revision(3)] }],
    [revision(3), { body: 'private' }]]);
  const read: string[] = [];
  const content = { readExactBatch: async (ids: string[]): Promise<ExactReadResult[]> =>
    ids.map(id => {
      read.push(id);
      const n = Number.parseInt(id.slice(-12), 16);
      const body = bodies.get(id)!;
      return { revisionId: id, status: 'available', reference: reference(n),
        body, serializedJson: JSON.stringify(body) };
    }) } as Pick<ContentCore, 'readExactBatch'>;
  const env = { fuseki: { query: async () => ({ results: { bindings: [{
    variant: { value: reference(2).variantId },
    revision: { value: `urn:rezics:content:revision:${revision(2)}` },
  }] } }) } } as unknown as WorkActivationEnvironment;
  await expect(assertPublicContentEmbeds(env, content, revision(1)))
    .rejects.toBeInstanceOf(ContentEmbedDenied);
  expect(read).toEqual([revision(1), revision(2), revision(3)]);
  const closure = await readContentEmbedClosure(content, revision(1));
  expect(closure.dependencies.map(item => item.revisionId)).toEqual([revision(2), revision(3)]);
  expect(closure.cost).toMatchObject({ revisionsRead: 3, edges: 2, depth: 2,
    publicChecks: 2 });
  const guard = publicContentEmbedGuards(closure.dependencies);
  expect(guard.match(/FILTER EXISTS/g)).toHaveLength(2);
  expect(guard).toContain(`urn:rezics:content:revision:${revision(3)}`);
});

test('BOOK06: closure rejects cycles and an over-budget fanout', async () => {
  const body = (id: string) => ({ body: 'node', embeds: id === revision(1)
    ? [revision(2)] : [revision(1)] });
  const cycle = { readExactBatch: async (ids: string[]): Promise<ExactReadResult[]> => ids.map(id => ({
    revisionId: id, status: 'available', reference: reference(Number.parseInt(id.slice(-12), 16)),
    body: body(id), serializedJson: JSON.stringify(body(id)),
  })) } as Pick<ContentCore, 'readExactBatch'>;
  await expect(readContentEmbedClosure(cycle, revision(1)))
    .rejects.toBeInstanceOf(ContentEmbedDenied);
  const wide = { readExactBatch: async (ids: string[]): Promise<ExactReadResult[]> => ids.map(id => {
    const n = Number.parseInt(id.slice(-12), 16);
    const embeds = n === 1 ? Array.from({ length: 16 }, (_, i) => revision(i + 2))
      : n <= 17 ? Array.from({ length: 4 }, (_, i) => revision(18 + (n - 2) * 4 + i)) : [];
    return { revisionId: id, status: 'available', reference: reference(n),
      body: { body: 'node', embeds }, serializedJson: JSON.stringify({ body: 'node', embeds }) };
  }) } as Pick<ContentCore, 'readExactBatch'>;
  await expect(readContentEmbedClosure(wide, revision(1)))
    .rejects.toBeInstanceOf(ContentEmbedDenied);
});
