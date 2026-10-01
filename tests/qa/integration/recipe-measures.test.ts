import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { ObjectUnavailable, S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';

test('RECIPE05: receipt-backed nutrition and yield retain coverage, basis and exact revisions', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `recipe-measures-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    const work = await f.json<{ work: string; mainVersion: string }>(await f.call('POST', '/v1/works', await f.authoredBody({ language: 'en',
      profile: 'metadata-only-v1', title: 'Recipe measure acceptance',
      semanticTypes: ['https://schema.org/Recipe'], actingSubject: f.actor,
    })), 201);
    await f.grant(`work:edit:${work.work}`, 'recipe.edit');
    await f.grant(`work:read:${work.work}`, 'work.read');
    const created = await f.json<{ structure: string; revision: string }>(await f.call('POST',
      '/v1/recipes', { owner: work.work, mainVersion: work.mainVersion, actingSubject: f.actor },
      `recipe-${randomUUID()}`), 201);
    const path = `/v1/recipes/${shortId(created.structure)}/measures`;
    const read = (revision?: string, token = f.account.tokenA) => f.call('GET', path
      + `?actingSubject=${encodeURIComponent(f.actor)}`
      + (revision ? `&revision=${encodeURIComponent(revision)}` : ''), undefined, randomUUID(), token);
    const body = { expectedHead: created.revision, actingSubject: f.actor,
      yield: { value: { numerator: 6, denominator: 2 }, unitText: 'loaves',
        coverage: 'complete', provenance: 'declared' },
      servings: { value: { numerator: 12, denominator: 1 },
        coverage: 'complete', provenance: 'declared' },
      nutrition: { basis: 'per-serving', inputs: [
        { coverage: 'complete', values: [{ nutrient: 'https://schema.org/proteinContent',
          unit: 'https://qudt.org/vocab/unit/GM', amount: { numerator: 1, denominator: 3 } }] },
        { coverage: 'partial', values: [{ nutrient: 'https://schema.org/proteinContent',
          unit: 'https://qudt.org/vocab/unit/GM', amount: { numerator: 1, denominator: 6 } }] },
      ] } } as const;
    expect((await f.call('POST', path, body, `measure-${randomUUID()}`, f.account.noScope)).status)
      .toBe(401);
    expect((await f.call('POST', path, body, `measure-${randomUUID()}`, f.account.tokenB)).status)
      .toBe(403);
    expect((await read(undefined, f.account.tokenB)).status).toBe(404);
    expect((await f.call('POST', path, { ...body, yield: { ...body.yield,
      unitText: undefined } }, `measure-${randomUUID()}`)).status).toBe(400);
    const oversized = { ...body, nutrition: { ...body.nutrition,
      inputs: [{ coverage: 'complete', values: Array.from({ length: 63 }, (_, index) => ({
        nutrient: `https://example.org/nutrient/${index}`,
        unit: 'https://qudt.org/vocab/unit/GM', amount: { numerator: 1, denominator: 1 },
      })) }] } };
    expect((await f.call('POST', path, oversized, `measure-${randomUUID()}`)).status).toBe(400);
    const writeKey = `measure-${randomUUID()}`;
    const first = await f.json<{ revision: string; receipt: string; replayed: boolean;
      cost: { pagesRead: number; pagesWritten: number; placementsWritten: number } }>(
      await f.call('POST', path, body, writeKey), 200);
    expect(first).toMatchObject({ replayed: false,
      cost: { pagesRead: 1, pagesWritten: 1, placementsWritten: 0 } });
    expect(first.revision).not.toBe(created.revision);
    expect(await f.json<{ revision: string; receipt: string; replayed: boolean }>(
      await f.call('POST', path, body, writeKey), 200)).toMatchObject({
      revision: first.revision, receipt: first.receipt, replayed: true,
    });
    expect((await f.call('POST', path, { ...body, nutrition: { ...body.nutrition,
      basis: 'whole-recipe' } }, writeKey)).status).toBe(409);
    const current = await f.json<{ revision: string; predecessor: string;
      measures: Array<{ kind: string; value: { numerator: number; denominator: number };
        coverage: string; basis: string; unit?: string; unitText?: string; provenance: string }>;
      cost: { pagesRead: number } }>(await read(), 200);
    expect(current).toMatchObject({ revision: first.revision, predecessor: created.revision,
      cost: { pagesRead: 1 }, measures: [
        { kind: 'yield', value: { numerator: 3, denominator: 1 }, unitText: 'loaves',
          basis: 'whole-recipe', coverage: 'complete', provenance: 'declared' },
        { kind: 'servings', value: { numerator: 12, denominator: 1 }, unitText: 'servings',
          basis: 'whole-recipe', coverage: 'complete', provenance: 'declared' },
        { kind: 'nutrient', value: { numerator: 1, denominator: 2 },
          unit: 'https://qudt.org/vocab/unit/GM', basis: 'per-serving',
          coverage: 'partial', provenance: 'computed' },
      ] });
    expect((await f.json<{ measures: unknown[] }>(await read(created.revision), 200)).measures)
      .toEqual([]);
    expect((await f.call('POST', path, { ...body, expectedHead: created.revision },
      `measure-${randomUUID()}`)).status).toBe(409);
    const unknown = { ...body, expectedHead: first.revision,
      yield: { ...body.yield, coverage: 'partial' },
      nutrition: { basis: 'whole-recipe', inputs: [{ coverage: 'unknown', values: [
        { nutrient: 'https://schema.org/fatContent', unit: 'https://qudt.org/vocab/unit/GM',
          amount: { numerator: 2, denominator: 1 } },
      ] }] } };
    const next = await f.json<{ revision: string }>(await f.call('POST', path, unknown,
      `measure-${randomUUID()}`), 200);
    expect((await f.json<{ measures: Array<{ kind: string; coverage: string }> }>(await read(), 200))
      .measures).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'yield', coverage: 'partial' }),
        expect.objectContaining({ kind: 'nutrient', coverage: 'unknown', basis: 'whole-recipe' }),
      ]));
    expect((await f.json<{ measures: unknown[] }>(await read(first.revision), 200)).measures)
      .toEqual(current.measures);
    const manifest = await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?manifest WHERE { GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(next.revision)} rv:manifest ?manifest . } }`);
    const digest = manifest.results!.bindings[0]!.manifest!.value.slice(-64);
    (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = {
      put: bytes => objects.put(bytes), get: value => value === digest
        ? Promise.reject(new ObjectUnavailable('missing measure manifest')) : objects.get(value),
    };
    try { expect((await read(next.revision)).status).toBe(503); }
    finally { (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects; }
    expect((await read(next.revision)).status).toBe(200);
    const races = await Promise.all([1, 2].map(value => f.call('POST', path,
      { ...body, expectedHead: next.revision,
        yield: { ...body.yield, value: { numerator: value, denominator: 1 } } },
      `measure-${randomUUID()}`)));
    expect(races.map(result => result.status).sort()).toEqual([200, 409]);
  } finally { await f.close(); }
}, 180_000);
