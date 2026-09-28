import { expect, test } from 'bun:test';
import { visibleContentSearchRights } from '../../../services/main/src/modules/content-publication/search.ts';
import { RV } from '../../../services/main/src/modules/work/activate.ts';

const original = { resource: 'https://rezics.com/id/11111111-1111-4111-8111-111111111111',
  rightsBasis: `${RV}OriginalContribution`, assessment: undefined };
const assessmentId = '22222222-2222-4222-8222-222222222222';
const classic = { resource: 'https://rezics.com/id/33333333-3333-4333-8333-333333333333',
  rightsBasis: `${RV}PublicDomain`, assessment: `urn:rezics:rights:assessment:${assessmentId}` };

test('Gutenberg search: withdrawn assessments disappear on the next search without an index rebuild', async () => {
  let current = true;
  const batches: unknown[] = [];
  const rights = { currentPublicDomainAssessments: async (refs: readonly { work: string; assessmentId: string }[]) => {
    batches.push(refs);
    return new Set(current ? [`${classic.resource}\0${assessmentId}`] : []);
  } };
  expect(await visibleContentSearchRights([original, classic], rights)).toEqual([original, classic]);
  current = false;
  expect(await visibleContentSearchRights([original, classic], rights)).toEqual([original]);
  expect(batches).toEqual([[{ work: classic.resource, assessmentId }], [{ work: classic.resource, assessmentId }]]);
});

test('Gutenberg search: a missing Rights owner or failed assessment read cannot disclose public-domain hits', async () => {
  await expect(visibleContentSearchRights([classic])).rejects.toThrow('rights owner is unavailable');
  await expect(visibleContentSearchRights([classic], { currentPublicDomainAssessments: async () => {
    throw new Error('owner unavailable');
  } })).rejects.toThrow('rights are unavailable');
  expect(await visibleContentSearchRights([original])).toEqual([original]);
});

test('Gutenberg search: malformed assessments and unrecognized rights bases fail closed', async () => {
  const rights = { currentPublicDomainAssessments: async () => new Set<string>() };
  await expect(visibleContentSearchRights([{ ...classic, assessment: undefined }], rights))
    .rejects.toThrow('assessment is missing');
  await expect(visibleContentSearchRights([{ ...original, rightsBasis: 'unknown' }], rights))
    .rejects.toThrow('rights basis is unknown');
});
