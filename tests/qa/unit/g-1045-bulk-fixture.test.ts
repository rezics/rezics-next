import { expect, test } from 'bun:test';
import {
  CATALOGUE_IMPORT_COST,
  type CatalogueImportInput,
} from '../../../services/main/src/modules/work/catalogue-import.ts';
import { catalogueFixture } from '../support/catalogue-fixture.ts';
import { catalogueSeedPort } from '../support/catalogue-seed-port.ts';
import { integrationOrderFiles } from '../support/integration-order.ts';
import { workProfileCorpusApi } from '../../../scripts/load/work-profile-corpus.ts';
import type { SeedPort } from '../../../scripts/dev/seed/vn-catalogue-step.ts';
import { planIntegrationShards } from '../../../scripts/qa/integration-shards.ts';

const actor = 'https://rezics.com/id/00000000-0000-0000-0000-000000000001';
const input: CatalogueImportInput = {
  profile: 'work-catalogue-import-v1',
  expectedWorkHead: null,
  title: 'Bulk fixture',
  language: 'en',
  evidence: 'Unit fixture',
  semanticTypes: [],
  aliases: [],
  credits: [],
  classifications: [],
};
function outcome(key: string) {
  return {
    key,
    status: 'succeeded',
    receipt: {
      outcome: 'succeeded',
      work: actor,
      mainVersion: actor,
      workRevision: actor,
      mainRevision: actor,
      receipt: `receipt:${key}`,
    },
  };
}

test('G1045: fixture preparation chunks the full population at the public bound, drains each batch and refuses partial receipts', async () => {
  const batches: string[][] = [],
    order: string[] = [];
  let partial = false;
  const api = workProfileCorpusApi('http://main.local', 'fixture', {
    fetch: (async (url, init) => {
      const request = new Request(url, init);
      expect(new URL(request.url).pathname).toBe('/v1/work-imports/bulk');
      const body = (await request.json()) as { actingSubject: string; items: { key: string }[] };
      expect(body.actingSubject).toBe(actor);
      batches.push(body.items.map((row) => row.key));
      order.push('bulk');
      return Response.json({
        complete: true,
        partial,
        items: body.items.map((row) => outcome(row.key)),
      });
    }) as typeof fetch,
  });
  const items = Array.from({ length: CATALOGUE_IMPORT_COST.items + 1 }, (_, index) => ({
    key: `fixture:${index}`,
    input,
  }));
  const grant = () => {
    order.push('grant');
    return Promise.resolve();
  };
  const drain = () => {
    order.push('drain');
    return Promise.resolve();
  };
  const works = await catalogueFixture(api, actor, grant, items, drain);
  expect(works).toHaveLength(items.length);
  expect(batches.map((batch) => batch.length)).toEqual([128, 1]);
  expect(batches.flat()).toEqual(items.map((row) => row.key));
  expect(order).toEqual(['grant', 'bulk', 'drain', 'bulk', 'drain']);
  partial = true;
  await expect(catalogueFixture(api, actor, grant, items, drain)).rejects.toThrow('incomplete');
  expect(order.at(-1)).toBe('bulk');
});

test('G1045: VN fixture consumes only the declared public bulk creation receipts and retains ordinary edits and replay intents', async () => {
  const calls: string[] = [];
  const port: SeedPort = {
    actingSubject: actor,
    grant: () => Promise.resolve(),
    request(_method, path, body) {
      calls.push(path);
      if (path === '/v1/work-imports/bulk') {
        const items = (body as { items: { key: string }[] }).items;
        return Promise.resolve({
          status: 200,
          body: { complete: true, partial: false, items: items.map((row) => outcome(row.key)) },
        });
      }
      return Promise.resolve({ status: 200, body: { edited: true } });
    },
  };
  const declared = {
    key: 'vndb:test',
    title: 'A visual novel',
    language: 'ja',
    semanticTypes: ['https://schema.org/VideoGame'],
  };
  const prepared = await catalogueSeedPort(port, [declared]);
  const body = {
    profile: 'metadata-only-v1',
    title: declared.title,
    language: declared.language,
    semanticTypes: declared.semanticTypes,
    actingSubject: actor,
    authoring: 'own-work',
  };
  expect((await prepared.request('POST', '/v1/works', body, declared.key)).body).toMatchObject({
    work: actor,
    mainVersion: actor,
  });
  await expect(
    prepared.request('POST', '/v1/works', { ...body, title: 'Changed intent' }, declared.key),
  ).rejects.toThrow('intent changed');
  expect(
    await prepared.request('PUT', '/v1/works/metadata', { expectedHead: actor }),
  ).toMatchObject({ body: { edited: true } });
  const replay = await catalogueSeedPort(port, [declared]);
  expect(await replay.request('POST', '/v1/works', body, declared.key)).toEqual(
    await prepared.request('POST', '/v1/works', body, declared.key),
  );
  expect(calls).toEqual(['/v1/work-imports/bulk', '/v1/works/metadata', '/v1/work-imports/bulk']);
});

test('G1045: the shared-state order proof runs ten different predecessors and cannot recurse into any target', () => {
  expect(integrationOrderFiles).toHaveLength(10);
  expect(new Set(integrationOrderFiles).size).toBe(10);
  expect(integrationOrderFiles.every((file) => !/g-(?:1025|1038|852|854|556)/.test(file))).toBe(
    true,
  );
});

test('G1045: complete large-fixture traversals own their command budget without changing ordinary shards to scale storage', () => {
  const large = [
    'tests/qa/integration/g-854-large-library.test.ts',
    'tests/qa/integration/g-852-zones.test.ts',
    'tests/qa/integration/g-556-ranked-large.test.ts',
    'tests/qa/integration/g-939-discovery.test.ts',
  ];
  const ordinary = 'tests/qa/integration/credit-creation.test.ts';
  const shards = planIntegrationShards(
    new Map([...large.map((file) => [file, 240_000] as const), [ordinary, 10_000]]),
    1,
  );
  expect(shards.find((shard) => shard.files.includes(ordinary))!.files).toEqual([ordinary]);
  for (const file of large) {
    const shard = shards.find((plan) => plan.files.includes(file))!;
    expect(shard.files).toEqual([file]);
    expect(shard.batches).toEqual([[file]]);
  }
});
