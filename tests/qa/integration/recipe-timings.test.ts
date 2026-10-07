import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';

type Measure = { kind: string; value: { numerator: number; denominator: number };
  unitText?: string; coverage: string; provenance: string };

test('Recipe timings merge with stored measures, clear explicitly and fence stale heads', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `recipe-timings-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    const work = await f.json<{ work: string; mainVersion: string }>(await f.call('POST', '/v1/works',
      await f.authoredBody({ language: 'en', profile: 'metadata-only-v1', title: 'Timed bread',
        semanticTypes: ['https://schema.org/Recipe'], actingSubject: f.actor })), 201);
    await f.grant(`work:edit:${work.work}`, 'recipe.edit');
    await f.grant(`work:read:${work.work}`, 'work.read');
    const created = await f.json<{ structure: string; revision: string }>(await f.call('POST',
      '/v1/compositions', { profile: 'recipe-composition', work: work.work,
        mainVersion: work.mainVersion, actingSubject: f.actor }, `recipe-${randomUUID()}`), 201);
    const base = `/v1/recipes/${shortId(created.structure)}`;
    const read = async (revision?: string) => (await f.json<{ measures: Measure[] }>(await f.call('GET',
      `${base}/measures?actingSubject=${encodeURIComponent(f.actor)}`
      + (revision ? `&revision=${encodeURIComponent(revision)}` : '')), 200)).measures;
    const minutes = (value: number) => ({ value: { numerator: value, denominator: 1 }, unitText: 'min' });
    const timings = (expectedHead: string, body: object) => ({ expectedHead, actingSubject: f.actor, ...body });

    // A first save with yield, servings and nutrition: the timings route must keep all of it later.
    const first = await f.json<{ revision: string }>(await f.call('POST', `${base}/measures`, {
      expectedHead: created.revision, actingSubject: f.actor,
      yield: { value: { numerator: 2, denominator: 1 }, unitText: 'loaves', coverage: 'complete',
        provenance: 'declared' },
      servings: { value: { numerator: 8, denominator: 1 }, coverage: 'complete', provenance: 'declared' },
      nutrition: { basis: 'per-serving', inputs: [{ coverage: 'complete', values: [
        { nutrient: 'https://schema.org/proteinContent', unit: 'https://qudt.org/vocab/unit/GM',
          amount: { numerator: 3, denominator: 1 } }] }] },
    }, `measure-${randomUUID()}`), 200);

    const path = `${base}/timings`;
    const body = timings(first.revision, { preparation: minutes(20), cooking: minutes(45) });
    expect((await f.call('POST', path, body, `timing-${randomUUID()}`, f.account.noScope)).status).toBe(401);
    expect((await f.call('POST', path, body, `timing-${randomUUID()}`, f.account.tokenB)).status).toBe(403);
    expect((await f.call('POST', path, timings(first.revision, {}), `timing-${randomUUID()}`)).status).toBe(400);
    expect((await f.call('POST', path, timings(first.revision, { total: { value: minutes(5).value } }),
      `timing-${randomUUID()}`)).status).toBe(400);

    const key = `timing-${randomUUID()}`;
    const written = await f.json<{ revision: string; receipt: string; replayed: boolean }>(
      await f.call('POST', path, body, key), 200);
    expect(written.replayed).toBe(false);
    expect(await f.json(await f.call('POST', path, body, key), 200)).toMatchObject({
      revision: written.revision, receipt: written.receipt, replayed: true });
    expect((await f.call('POST', path, timings(first.revision, { cooking: minutes(50) }), key)).status).toBe(409);
    const kinds = (measures: Measure[]) => measures.map(item => item.kind).sort();
    let measures = await read();
    expect(kinds(measures)).toEqual(['cooking-duration', 'nutrient', 'preparation-duration', 'servings', 'yield']);
    expect(measures.find(item => item.kind === 'cooking-duration')).toMatchObject({
      value: { numerator: 45, denominator: 1 }, unitText: 'min', coverage: 'complete', provenance: 'declared' });
    // The previous revision still reads without timings.
    expect(kinds(await read(first.revision))).toEqual(['nutrient', 'servings', 'yield']);

    // Omission keeps, a value replaces, null clears; nothing else moves.
    const edited = await f.json<{ revision: string }>(await f.call('POST', path,
      timings(written.revision, { cooking: minutes(50), preparation: null, total: minutes(70) }),
      `timing-${randomUUID()}`), 200);
    measures = await read();
    expect(kinds(measures)).toEqual(['cooking-duration', 'nutrient', 'servings', 'total-duration', 'yield']);
    expect(measures.find(item => item.kind === 'cooking-duration')?.value).toEqual({ numerator: 50, denominator: 1 });

    // A yield edit without nutrition keeps the nutrient and the timings it does not supply.
    const yielded = await f.json<{ revision: string }>(await f.call('POST', `${base}/measures`, {
      expectedHead: edited.revision, actingSubject: f.actor,
      yield: { value: { numerator: 3, denominator: 1 }, unitText: 'loaves', coverage: 'complete',
        provenance: 'declared' },
    }, `measure-${randomUUID()}`), 200);
    measures = await read();
    expect(kinds(measures)).toEqual(['cooking-duration', 'nutrient', 'total-duration', 'yield']);
    expect(measures.find(item => item.kind === 'yield')?.value).toEqual({ numerator: 3, denominator: 1 });

    // A stale head conflicts; two writers on one head race to one winner.
    expect((await f.call('POST', path, timings(first.revision, { total: minutes(1) }),
      `timing-${randomUUID()}`)).status).toBe(409);
    const races = await Promise.all([1, 2].map(value => f.call('POST', path,
      timings(yielded.revision, { total: minutes(60 + value) }), `timing-${randomUUID()}`)));
    expect(races.map(result => result.status).sort()).toEqual([200, 409]);
  } finally { await f.close(); }
}, 180_000);
