import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import seeds from '../../../packages/definitions/src/reviewed-vocabulary.json';
import {
  reviewedCatalogueOwner,
  reviewedCatalogueKey,
  reviewedCatalogueSlot,
  seedReviewedCatalogue,
  type ReviewedCataloguePort,
} from '../src/reviewed-catalogue.ts';
const scheme = 'https://rezics.com/schemes/bangumi/public-tags';
test('platform seed owner is reversible exact ASCII and validates its complete operation byte bound', () => {
  const owner = reviewedCatalogueOwner(scheme, '后宫');
  expect(owner.source).toBe('rezics_reviewed_vocabulary');
  expect(owner.source.length).toBe(26);
  expect(owner.external_id.length).toBe(82);
  expect(Buffer.from(owner.external_id.slice(3), 'base64url').toString('utf8')).toBe(JSON.stringify([scheme, '后宫']));
  expect(Buffer.byteLength(reviewedCatalogueKey(owner, 'bootstrap'))).toBe(174);
  expect(reviewedCatalogueOwner(scheme, 'e\u0301')).not.toEqual(reviewedCatalogueOwner(scheme, 'é'));
  expect(() => reviewedCatalogueOwner(scheme, 'x'.repeat(200))).toThrow();
  expect(() => reviewedCatalogueKey({ source: owner.source, external_id: 'x'.repeat(164) }, 'bootstrap')).toThrow();
});
test('invalid truncated duplicated or mass-disappeared finite inventory has zero external effects', async () => {
  let effects = 0;
  const port = new Proxy({} as ReviewedCataloguePort, {
    get() {
      effects++;
      throw new Error('Effect before admission');
    },
  });
  for (const input of [
    [],
    seeds.slice(1),
    [...seeds, seeds[0]],
    [...seeds.slice(0, 3), { ...seeds[3], literalMember: '後宮' }],
  ]) {
    await expect(
      seedReviewedCatalogue({ path: '.temp/never-open-invalid-reviewed.sqlite', port, seeds: input }),
    ).rejects.toThrow();
  }
  expect(effects).toBe(0);
});

test('reviewed metadata accepts the public transport null-prototype JSON snapshot', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'reviewed-json-'));
  const reachedBootstrap = new Error('Stopped after metadata provenance was checked');
  let creates = 0;
  const port = {
    fence: async () => ({ fenced: false, securityRevision: null }),
    setSourceRecordMetadata: async ({ command }: Parameters<ReviewedCataloguePort['setSourceRecordMetadata']>[0]) => ({
      record: Object.setPrototypeOf(structuredClone(command.metadata), null),
      metadata_revision: 1,
      effect: 'filled' as const,
    }),
    batch: async () => {
      creates++;
      throw reachedBootstrap;
    },
  } as unknown as ReviewedCataloguePort;
  try {
    await expect(seedReviewedCatalogue({ path: resolve(directory, 'state.sqlite'), port })).rejects.toBe(
      reachedBootstrap,
    );
    expect(creates).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reviewed scalar and classification facts use their ordinary unkeyed candidate bucket', () => {
  for (const property of ['schema:url', 'schema:sameAs', 'skos:inScheme', 'skos:closeMatch']) {
    expect(reviewedCatalogueSlot(property)).toEqual({
      property,
      context: '00000000-0000-8000-8000-000000000000',
      limit: 100,
    });
  }
});
