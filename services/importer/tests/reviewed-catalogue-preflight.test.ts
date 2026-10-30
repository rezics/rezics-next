import { expect, test } from 'bun:test';
import seeds from '../../../packages/definitions/src/reviewed-vocabulary.json';
import {
  reviewedCatalogueOwner,
  reviewedCatalogueKey,
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
