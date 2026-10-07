import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
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
  // Every read of a stored Structure object is counted: a denied request must not cause one.
  let reads = 0;
  const counted: ImmutableObjects = { put: bytes => objects.put(bytes), get: value => { reads++; return objects.get(value); } };
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = counted;
  const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
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

    // The editor reaches the stored set (and learns it is full); no one else reaches it at all.
    const attempt = async (route: 'timings' | 'measures', token: string, subject: string, head: string) => {
      reads = 0;
      const body = route === 'timings' ? timing(head, { cooking: minutes(25) }, subject)
        : { expectedHead: head, actingSubject: subject, yield: { value: { numerator: 1, denominator: 1 }, unitText: 'x',
          coverage: 'complete', provenance: 'declared' },
        servings: { value: { numerator: 8, denominator: 1 }, coverage: 'complete', provenance: 'declared' } };
      const response = await post(full, body, token, route);
      return { status: response.status, reads };
    };
    for (const route of ['timings', 'measures'] as const) {
      const editor = await attempt(route, f.account.tokenA, f.actor, filled.revision);
      // A full set refuses one more timing; a yield edit that supplies yield and servings keeps the set the same size.
      expect(editor.status).toBe(route === 'timings' ? 400 : 200);
      expect(editor.reads).toBeGreaterThan(0);
      if (route === 'measures') filled.revision = (await f.json<{ revision: string }>(await f.call('GET',
        `${full.path}/measures?actingSubject=${encodeURIComponent(f.actor)}`), 200)).revision;
    }
    for (const route of ['timings', 'measures'] as const) {
      // Another person, who has no authority on this private Work.
      expect(await attempt(route, f.account.tokenB, f.actor, filled.revision)).toEqual({ status: 403, reads: 0 });
      // The right person naming an Agent they do not represent.
      expect(await attempt(route, f.account.tokenA, nativeId(), filled.revision)).toEqual({ status: 403, reads: 0 });
    }
    // Without the OAuth scope, and for a Structure that does not exist, nothing is read either.
    reads = 0;
    expect((await post(full, timing(filled.revision, { cooking: minutes(25) }), f.account.noScope)).status).toBe(401);
    expect((await f.call('POST', `/v1/recipes/${randomUUID()}/timings`, timing(filled.revision, { cooking: minutes(25) }),
      `measure-${randomUUID()}`)).status).toBe(404);
    expect(reads).toBe(0);

    // Revoked, then expired, authority: refused before any stored read, on both routes; restored authority reaches it again.
    for (const [name, revoke, restore] of [
      ['revoked', "UPDATE access.permission_grant SET active = false WHERE id = $1", "UPDATE access.permission_grant SET active = true WHERE id = $1"],
      ['expired', "UPDATE access.permission_grant SET valid_until = now() - interval '1 minute' WHERE id = $1",
        "UPDATE access.permission_grant SET valid_until = now() + interval '1 hour' WHERE id = $1"],
    ] as const) {
      await f.accessPool.query(revoke, [full.edit]);
      for (const route of ['timings', 'measures'] as const) {
        expect(await attempt(route, f.account.tokenA, f.actor, filled.revision), `${name} ${route}`).toEqual({ status: 403, reads: 0 });
      }
      await f.accessPool.query(restore, [full.edit]);
      const back = await attempt('timings', f.account.tokenA, f.actor, filled.revision);
      expect(back.status, `${name} restored`).toBe(400);
      expect(back.reads).toBeGreaterThan(0);
    }

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

    // The Work's author needs no grant at all: a verified Account is on the author baseline. Everyone else still does.
    await accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = ANY($1)', [[f.account.a.id, f.account.b.id]]);
    // The author's Account controls the Agent as a provisioned Person, as sign-up leaves it.
    const control = randomUUID();
    await f.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'agent.control', 'infinity')`, [control, f.principalId, f.actor]);
    const epoch = (await f.accessPool.query<{ enforcement_epoch: string }>(
      'SELECT enforcement_epoch FROM access.principal WHERE id = $1', [f.principalId])).rows[0]!.enforcement_epoch;
    await f.accessPool.query(`INSERT INTO access.agent_provision (id, principal_id, idempotency_key, request_digest, agent_id,
      agent_kind, display_name, principal_epoch, state, graph_data_epoch, graph_sequence, representation_id)
      VALUES ($1, $2, 'qa-author', $3, $4, 'person', 'QA author', $5, 'active', 'qa', 1, $6)`,
    [randomUUID(), f.principalId, '0'.repeat(64), f.actor, epoch, control]);
    const own = await f.json<{ work: string; mainVersion: string }>(await f.call('POST', '/v1/works', await f.authoredBody({
      language: 'en', profile: 'metadata-only-v1', title: 'Grant-free author', semanticTypes: ['https://schema.org/Recipe'],
      actingSubject: f.actor })), 201);
    const startedOwn = await f.json<{ structure: string; revision: string }>(await f.call('POST', '/v1/compositions',
      { profile: 'recipe-composition', work: own.work, mainVersion: own.mainVersion, actingSubject: f.actor },
      `recipe-composition:${shortId(own.work)}`), 201);
    const ownPath = `/v1/recipes/${shortId(startedOwn.structure)}`;
    const yielded = await f.json<{ revision: string }>(await f.call('POST', `${ownPath}/measures`, { expectedHead: startedOwn.revision,
      actingSubject: f.actor, yield: { value: { numerator: 3, denominator: 1 }, unitText: 'loaves', coverage: 'complete',
        provenance: 'declared' } }, `measure-${randomUUID()}`), 200);
    reads = 0;
    expect((await f.call('POST', `${ownPath}/timings`, timing(yielded.revision, { cooking: minutes(40) }),
      `measure-${randomUUID()}`)).status).toBe(200);
    expect(reads).toBeGreaterThan(0);
    // Another person, verified too, and a stranger Agent, are refused before the stored set is read.
    for (const [token, subject] of [[f.account.tokenB, f.actor], [f.account.tokenA, nativeId()]] as const) {
      reads = 0;
      const response = await f.call('POST', `${ownPath}/timings`, timing(yielded.revision, { preparation: minutes(5) }, subject),
        `measure-${randomUUID()}`, token);
      expect(response.status).toBe(403);
      expect(reads).toBe(0);
    }
  } finally { await accountPool.end(); await f.close(); }
}, 240_000);
