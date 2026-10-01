import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { cataloguePlan } from '../../fixtures/catalogue/load.ts';
import { catalogueIntakePath, catalogueWorkBody } from '../../fixtures/catalogue/intake.ts';
import { assertSeedRequest } from '../../../scripts/dev/seed/request-schema.ts';
import { SeedApi, type SeedEndpoints } from '../../../scripts/dev/seed/api.ts';
import { requiresSeedAdministrator } from '../../../scripts/dev/seed/work-authority.ts';
import { workTypeEntries } from '../../../services/main/src/modules/types/registry.ts';
import { collectionPage } from '../../../scripts/dev/seed/ln-vn-zones-step.ts';

test('G905: seed authority follows every served Work type, including software and ModPackage', () => {
  for (const entry of workTypeEntries) {
    expect(requiresSeedAdministrator([entry.type])).toBe(entry.creation === 'administrator');
  }
  expect(
    requiresSeedAdministrator(['https://schema.org/Book', 'https://rezics.com/vocab/ModPackage']),
  ).toBe(true);
});

test('G905: Zone catalogue membership reads every bounded page before deciding which Works are missing', async () => {
  const actor = `https://rezics.com/id/${randomUUID()}`;
  const collection = `https://rezics.com/id/${randomUUID()}`;
  const targets = Array.from({ length: 84 }, () => `https://rezics.com/id/${randomUUID()}`);
  const paths: string[] = [];
  const result = await collectionPage(
    {
      actingSubject: actor,
      grant: async () => {},
      request: async (method, path) => {
        expect(method).toBe('GET');
        paths.push(path);
        const url = new URL(path, 'http://main.local');
        expect(url.searchParams.get('limit')).toBe('20');
        const offset = Number(url.searchParams.get('after') ?? 0);
        return {
          status: 200,
          body: {
            structure: collection,
            revision: collection,
            next: offset + 20 < targets.length ? String(offset + 20) : null,
            occurrences: targets
              .slice(offset, offset + 20)
              .map((target) => ({ target, role: 'member', state: 'active' })),
          },
        };
      },
    },
    collection,
  );
  expect(paths).toHaveLength(5);
  expect(result.targets).toEqual(new Set(targets));
});

test('G905: every fixture Work searches its exact title and retains evidence across replay, lost responses and resets', async () => {
  const actor = `https://rezics.com/id/${randomUUID()}`;
  let epoch = randomUUID();
  const paths = new Set<string>();
  const port = {
    actingSubject: actor,
    request: async (method: string, path: string, body?: unknown) => {
      expect([method, path]).toEqual(['POST', '/v1/catalogue/candidates']);
      assertSeedRequest(method, path, body);
      return {
        status: 200,
        body: { candidateReceipt: randomUUID(), sourcePosition: { dataEpoch: epoch } },
      };
    },
  };
  try {
    for (const item of cataloguePlan().works) {
      const input = { title: item.title, language: 'ja', semanticTypes: [item.semanticType] };
      const key = `g905:${item.id}`;
      paths.add(catalogueIntakePath(epoch, actor, key));
      const first = await catalogueWorkBody(port, input, key);
      assertSeedRequest('POST', '/v1/works', first);
      // Reconstruct the port as a new seed process would, even before a write
      // response exists. A new search must not change the creation digest.
      expect(await catalogueWorkBody({ ...port }, input, key)).toEqual(first);
      expect(first).toMatchObject({
        title: item.title,
        language: 'ja',
        grain: 'new-creative-scope',
      });
    }
    const input = { title: 'Reset', language: 'en', semanticTypes: ['https://schema.org/Book'] };
    paths.add(catalogueIntakePath(epoch, actor, 'reset'));
    const before = await catalogueWorkBody(port, input, 'reset');
    epoch = randomUUID();
    paths.add(catalogueIntakePath(epoch, actor, 'reset'));
    const after = await catalogueWorkBody(port, input, 'reset');
    expect(after.candidateReceipt).not.toBe(before.candidateReceipt);
    await expect(
      catalogueWorkBody(port, { ...input, title: 'Changed intent' }, 'reset'),
    ).rejects.toThrow('intent changed');
  } finally {
    for (const path of paths) rmSync(path, { force: true });
  }
});

test('G905: generated request guard rejects obsolete catalogue bodies and every invalid seed write before HTTP', async () => {
  const body = {
    profile: 'metadata-only-v1',
    title: 'Fixture',
    language: 'en',
    semanticTypes: ['https://schema.org/Book'],
    actingSubject: `https://rezics.com/id/${randomUUID()}`,
  };
  expect(() => assertSeedRequest('POST', '/v1/works', body)).toThrow('violates generated schema');
  expect(() =>
    assertSeedRequest('POST', '/v1/works', { ...body, authoring: 'own-work' }),
  ).not.toThrow();
  const api = new SeedApi({ main: 'http://127.0.0.1:1' } as SeedEndpoints);
  await expect(api.post('/v1/works', body, 'unused', 'invalid')).rejects.toThrow(
    'violates generated schema',
  );
  await expect(
    api.put(
      '/v1/works/00000000-0000-4000-a000-000000000001/reader-status',
      {},
      'unused',
      'invalid',
    ),
  ).rejects.toThrow('violates generated schema');
  expect(() => assertSeedRequest('POST', '/v1/not-a-route', {})).toThrow(
    'no generated JSON schema',
  );
});
