import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';

type Measure = { kind: string; value: { numerator: number; denominator: number }; unitText?: string };

/**
 * A measure edit keeps the measures it does not supply, so it reads the stored set. That read, and any
 * error derived from it, must come only after the caller's authority over this exact Recipe is proved.
 * A full measure set makes the oracle plain: adding a timing is a 400 for an editor and must stay a 403
 * for everyone else.
 */
test('a timing edit reads stored measures only for someone who may edit that Recipe', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `recipe-measure-authority-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    const recipe = async (title: string) => {
      const work = await f.json<{ work: string; mainVersion: string }>(await f.call('POST', '/v1/works',
        await f.authoredBody({ language: 'en', profile: 'metadata-only-v1', title,
          semanticTypes: ['https://schema.org/Recipe'], actingSubject: f.actor })), 201);
      const edit = await f.grant(`work:edit:${work.work}`, 'recipe.edit');
      await f.grant(`work:read:${work.work}`, 'work.read');
      const created = await f.json<{ structure: string; revision: string }>(await f.call('POST', '/v1/compositions',
        { profile: 'recipe-composition', work: work.work, mainVersion: work.mainVersion,
          actingSubject: f.actor }), 201);
      return { work: work.work, edit, ...created, path: `/v1/recipes/${shortId(created.structure)}` };
    };
    const nutrients = (count: number) => ({ basis: 'whole-recipe', inputs: [{ coverage: 'complete',
      values: Array.from({ length: count }, (_, index) => ({ nutrient: `https://example.org/nutrient/${index}`,
        unit: 'https://qudt.org/vocab/unit/GM', amount: { numerator: 1, denominator: 1 } })) }] });
    const measures = async (r: { path: string }, token = f.account.tokenA) => (await f.json<{ measures: Measure[] }>(
      await f.call('GET', `${r.path}/measures?actingSubject=${encodeURIComponent(f.actor)}`, undefined,
        randomUUID(), token), 200)).measures;
    const timing = (head: string, body: object, actingSubject = f.actor) => ({ expectedHead: head, actingSubject, ...body });
    const minutes = (value: number) => ({ value: { numerator: value, denominator: 1 }, unitText: 'min' });
    const post = (r: { path: string }, body: object, token = f.account.tokenA, route = 'timings') =>
      f.call('POST', `${r.path}/${route}`, body, `measure-${randomUUID()}`, token);

    // A full set: yield, servings and 62 nutrients.
    const full = await recipe('Full measure set');
    const filled = await f.json<{ revision: string }>(await post(full, { expectedHead: full.revision, actingSubject: f.actor,
      yield: { value: { numerator: 2, denominator: 1 }, unitText: 'loaves', coverage: 'complete', provenance: 'declared' },
      servings: { value: { numerator: 8, denominator: 1 }, coverage: 'complete', provenance: 'declared' },
      nutrition: nutrients(62) }, f.account.tokenA, 'measures'), 200);
    expect(await measures(full)).toHaveLength(64);

    // The editor learns the set is full; no one else learns anything.
    expect((await post(full, timing(filled.revision, { cooking: minutes(25) }))).status).toBe(400);
    expect((await post(full, timing(filled.revision, { cooking: minutes(25) }), f.account.tokenB)).status).toBe(403);
    // The same Agent named by a principal that does not represent it, and an Agent the principal does not represent.
    expect((await post(full, timing(filled.revision, { cooking: minutes(25) }, nativeId()))).status).toBe(403);
    expect((await post(full, { expectedHead: filled.revision, actingSubject: nativeId(), yield: {
      value: { numerator: 1, denominator: 1 }, unitText: 'x', coverage: 'complete', provenance: 'declared' },
    }, f.account.tokenA, 'measures')).status).toBe(403);
    // Without the OAuth scope nothing is read either.
    expect((await post(full, timing(filled.revision, { cooking: minutes(25) }), f.account.noScope)).status).toBe(401);
    // An unknown Structure says nothing about any Work.
    expect((await f.call('POST', `/v1/recipes/${randomUUID()}/timings`, timing(filled.revision, { cooking: minutes(25) }),
      `measure-${randomUUID()}`)).status).toBe(404);

    // Revoked, then expired, authority is refused before the stored set is read; restored authority works again.
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [full.edit]);
    expect((await post(full, timing(filled.revision, { cooking: minutes(25) }))).status).toBe(403);
    await f.accessPool.query('UPDATE access.permission_grant SET active = true WHERE id = $1', [full.edit]);
    expect((await post(full, timing(filled.revision, { cooking: minutes(25) }))).status).toBe(400);
    await f.accessPool.query("UPDATE access.permission_grant SET valid_until = now() - interval '1 minute' WHERE id = $1", [full.edit]);
    expect((await post(full, timing(filled.revision, { cooking: minutes(25) }))).status).toBe(403);
    expect((await measures(full)).length).toBe(64);

    // Another Work with room: the author's edits keep everything they do not supply, through a head race.
    const roomy = await recipe('Room for timings');
    const stored = await f.json<{ revision: string }>(await post(roomy, { expectedHead: roomy.revision, actingSubject: f.actor,
      yield: { value: { numerator: 4, denominator: 1 }, unitText: 'servings', coverage: 'complete', provenance: 'declared' },
      nutrition: nutrients(2) }, f.account.tokenA, 'measures'), 200);
    expect((await post(roomy, timing(stored.revision, { preparation: minutes(10) }), f.account.tokenB)).status).toBe(403);
    const race = await Promise.all([
      post(roomy, timing(stored.revision, { preparation: minutes(10) })),
      post(roomy, timing(stored.revision, { cooking: minutes(30) })),
    ]);
    expect(race.map(result => result.status).sort()).toEqual([200, 409]);
    const kinds = async () => (await measures(roomy)).map(item => item.kind).sort();
    expect((await kinds()).filter(kind => kind === 'nutrient')).toHaveLength(2);
    expect(await kinds()).toContain('yield');
    // The loser retries on the head that won, and both timings stand beside everything else.
    const head = (await f.json<{ revision: string }>(await f.call('GET',
      `${roomy.path}/measures?actingSubject=${encodeURIComponent(f.actor)}`), 200)).revision;
    const winner = (await measures(roomy)).find(item => item.kind.endsWith('-duration'))!.kind;
    const retry = winner === 'preparation-duration' ? { cooking: minutes(30) } : { preparation: minutes(10) };
    expect((await post(roomy, timing(head, retry))).status).toBe(200);
    expect(await kinds()).toEqual(['cooking-duration', 'nutrient', 'nutrient', 'preparation-duration', 'yield']);
    // A yield edit that races a timing edit also loses nothing it did not supply.
    const afterTiming = (await f.json<{ revision: string }>(await f.call('GET',
      `${roomy.path}/measures?actingSubject=${encodeURIComponent(f.actor)}`), 200)).revision;
    const second = await Promise.all([
      post(roomy, { expectedHead: afterTiming, actingSubject: f.actor, yield: { value: { numerator: 6, denominator: 1 },
        unitText: 'servings', coverage: 'complete', provenance: 'declared' } }, f.account.tokenA, 'measures'),
      post(roomy, timing(afterTiming, { total: minutes(50) })),
    ]);
    expect(second.map(result => result.status).sort()).toEqual([200, 409]);
    expect((await kinds()).filter(kind => kind === 'nutrient')).toHaveLength(2);
    expect((await kinds()).filter(kind => kind.endsWith('-duration')).length).toBeGreaterThanOrEqual(2);
  } finally { await f.close(); }
}, 240_000);
