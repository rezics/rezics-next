import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContentCore, ContentOutboxEvent, ProjectionPublication } from '../../content/src/core.ts';
import type { ContentProjectionCursor } from '../../content/src/projection-cursor.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { ContentProjectionUnavailable, relayContentProjectionOnce } from '../src/modules/content-publication/relay.ts';
import { discoverProjectionRecipes, projectionRecipeFor } from '../src/modules/content-publication/projection-recipes.ts';

const contentEpoch = '11111111-1111-4111-8111-111111111111';
const graphEpoch = '22222222-2222-4222-8222-222222222222';
const position = (sequence: string) => ({ owner: 'content' as const, dataEpoch: contentEpoch, sequence });
const bound = (value: string) => ({ type: 'literal', value });

test('G-087: media-set publication is proven and acknowledged without text projection', async () => {
  const reference: ProjectionPublication['reference'] = {
    owner: 'content', resourceId: 'urn:rezics:resource:1', variantId: 'urn:rezics:variant:1',
    revisionId: '33333333-3333-4333-8333-333333333333', format: 'rezics-content-json-v1',
    model: 'media-set-v1', byteDigest: 'a'.repeat(64), byteLength: 12,
    language: { kind: 'zxx' }, direction: 'none', sourceRevision: null,
    predecessor: null, provenance: {},
  };
  const publication: ProjectionPublication = { preparationId: 'prepare-1',
    preparationPosition: position('2'), reference, status: 'active',
    graph: { outcome: 'active', revisionId: reference.revisionId,
      receipt: 'urn:rezics:receipt:published', dataEpoch: graphEpoch, sequence: '7' } };
  const event: ContentOutboxEvent = { id: 'event-3', position: position('3'),
    operationId: 'settle-1', eventType: 'content.publication.active', recipe: 'content-body-v1',
    revisionId: reference.revisionId, payload: {} };
  let reads = 0;
  let acknowledgements = 0;
  const content = { ownerPosition: async () => position('3'), readOutbox: async () => [event],
    readProjectionPublication: async () => { reads++; return publication; },
    readExactBatch: async () => { throw new Error('non-text body was read'); },
  } as unknown as ContentCore;
  const cursor = { read: async () => position('2'), acknowledge: async () => { acknowledgements++; } } as unknown as ContentProjectionCursor;
  const row = { epoch: bound(graphEpoch), sequence: bound('7'), routing: bound('1'),
    outcome: bound('https://rezics.com/vocab/Succeeded'), receiptEpoch: bound(graphEpoch),
    receiptSequence: bound('7'), decision: bound('urn:rezics:decision:1'),
    head: bound('urn:rezics:decision:1'), revision: bound(`urn:rezics:content:revision:${reference.revisionId}`),
    digest: bound(reference.byteDigest), ownerEpoch: bound(contentEpoch), ownerSequence: bound('2'),
    resource: bound(reference.resourceId), variant: bound(reference.variantId),
    decisionRevision: bound(`urn:rezics:content:revision:${reference.revisionId}`),
    decisionDigest: bound(reference.byteDigest), decisionEpoch: bound(contentEpoch),
    decisionSequence: bound('2'),
  };
  const fuseki = { query: async () => ({ results: { bindings: [row] } }),
    commandHealth: async () => { throw new Error('text profile was checked'); },
  } as unknown as FusekiClient;
  const env = { fuseki, lineage: { dataEpoch: graphEpoch, routingEpoch: '1' },
    objectDirectory: '.temp/unused' };
  expect(await relayContentProjectionOnce(env, content, cursor, 'public-search'))
    .toMatchObject({ sourceSequence: '3', disposition: 'ignored' });
  expect(reads).toBe(1);
  expect(acknowledgements).toBe(1);

  reference.model = 'unknown-model-v1';
  await expect(relayContentProjectionOnce(env, content, cursor, 'public-search'))
    .rejects.toBeInstanceOf(ContentProjectionUnavailable);
  expect(acknowledgements).toBe(1);
});

test('G-087: owner projection recipes are discovered and duplicates fail at startup', async () => {
  expect(projectionRecipeFor('content-shape-v1').kind).toBe('text');
  expect(projectionRecipeFor('media-set-v1').kind).toBe('skip');
  await mkdir('.temp', { recursive: true });
  const root = await mkdtemp(join('.temp', 'projection-recipes-'));
  try {
    await mkdir(join(root, 'synthetic'));
    await writeFile(join(root, 'synthetic', 'projection-recipe.ts'),
      "export const projectionRecipes = [{ model: 'synthetic-v1', kind: 'skip' }];\n");
    expect((await discoverProjectionRecipes(root)).get('synthetic-v1')?.kind).toBe('skip');
    await writeFile(join(root, 'synthetic', 'projection-recipe.ts'),
      "export const projectionRecipes = [{ model: 'media-set-v1', kind: 'skip' }];\n");
    // A second owner file avoids Bun's module cache for the prior declaration.
    await mkdir(join(root, 'duplicate'));
    await writeFile(join(root, 'duplicate', 'projection-recipe.ts'),
      "export const projectionRecipes = [{ model: 'media-set-v1', kind: 'skip' }];\n");
    await expect(discoverProjectionRecipes(root)).rejects.toThrow(/Duplicate or invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
