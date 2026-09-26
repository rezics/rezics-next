import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { authorCreditFixture } from '../fixtures/author-credit.ts';
import { GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';
import { identityHarness, iri } from './source-identity-harness.ts';

const short = (value: string) => value.split('/').at(-1)!;

test('LIVE06: redirect and merge evidence proposes identity correction without moving native supports', async () => {
  const h = await identityHarness({ realAccount: true });
  try {
    const from = await h.record('old'), to = await h.record('new');
    const foreign = await h.record('foreign', 'other-provider');
    const observation = await h.observation(from, '{"redirect":"new"}');
    const body = { profile: 'source-record-identity-change-v1', kind: 'redirect',
      fromRecord: iri(from), toRecord: iri(to), observation: iri(observation), evidencePointer: '/redirect' };
    expect((await h.post('/v1/sources/identity-changes', 'reader', body)).status).toBe(401);
    expect((await h.post('/v1/sources/identity-changes', 'other', body)).status).toBe(404);
    const crossProvider = await h.post('/v1/sources/identity-changes', 'owner', { ...body,
      toRecord: iri(foreign) });
    expect(crossProvider.status).toBe(404);
    expect((await h.post('/v1/sources/identity-changes', 'owner', { ...body,
      evidencePointer: '/missing' })).status).toBe(409);
    const raced = await Promise.all([h.post('/v1/sources/identity-changes', 'owner', body),
      h.post('/v1/sources/identity-changes', 'owner', body)]);
    expect(raced.map(response => response.status).sort()).toEqual([200, 201]);
    const first = raced.find(response => response.status === 201)!;
    const change = await first.json() as { change: { change: string; nativeEffect: string }; replayed: boolean };
    expect(change.change.nativeEffect).toBe('none');
    expect((await h.post('/v1/sources/identity-changes', 'owner', body)).status).toBe(200);
    expect((await h.post('/v1/sources/identity-changes', 'owner', { ...body, kind: 'merge' })).status).toBe(409);
    const mergeObservation = await h.observation(from, '{"merge":"new"}');
    const merged = await h.post('/v1/sources/identity-changes', 'owner', { ...body,
      kind: 'merge', observation: iri(mergeObservation), evidencePointer: '/merge' });
    expect(merged.status).toBe(201);
    const path = `/v1/sources/identity-changes/${short(change.change.change)}`;
    expect((await h.get(path, 'other')).status).toBe(404);
    expect((await h.get(path, 'reader')).status).toBe(401);
    expect((await h.get(path, 'owner')).status).toBe(200);

    const fromTarget = iri(randomUUID()), toTarget = iri(randomUUID());
    const acting = iri(randomUUID());
    const readScope = `work:read:${fromTarget}`;
    await h.accessPool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [acting]);
    await h.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [readScope]);
    await h.accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'work.read',now() + interval '1 hour')`,
    [randomUUID(), h.principalId, acting]);
    const grantId = randomUUID();
    await h.accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,'work.read',now() + interval '1 hour')`, [grantId, acting, readScope]);
    const verified = await h.verifyOwner();
    expect(await h.access.canReadWork(verified, acting, fromTarget)).toBe(true);
    expect(await h.access.canReadWork(verified, acting, toTarget)).toBe(false);
    const proposal = { profile: 'source-identity-correction-proposal-v1', change: change.change.change,
      fromTarget, toTarget };
    expect((await h.post('/v1/sources/identity-corrections', 'owner', proposal, randomUUID())).status).toBe(409);
    const slot = 'work-metadata-v2#subtitle';
    const fromSupport = randomUUID(), toSupport = randomUUID();
    await h.pool.query(`INSERT INTO source.field_support
      (id, principal_id, target, slot, occurrence, context, record_id)
      VALUES ($1,$3,$4,$5,NULL,'global',$6),($2,$3,$7,$5,NULL,'global',$8)`,
    [fromSupport, toSupport, h.principalId, fromTarget, slot, from, toTarget, to]);
    const key = randomUUID();
    const made = await h.post('/v1/sources/identity-corrections', 'owner', proposal, key);
    expect(made.status).toBe(201);
    const correction = await made.json() as { proposal: { proposal: string; effect: string }; replayed: boolean };
    expect(correction.proposal.effect).toBe('proposal-only');
    expect(await h.access.canReadWork(verified, acting, fromTarget)).toBe(true);
    expect(await h.access.canReadWork(verified, acting, toTarget)).toBe(false);
    expect((await h.accessPool.query(`SELECT scope_id, active FROM access.permission_grant
      WHERE id = $1`, [grantId])).rows[0]).toEqual({ scope_id: readScope, active: true });
    expect((await h.post('/v1/sources/identity-corrections', 'owner', proposal, key)).status).toBe(200);
    expect((await h.post('/v1/sources/identity-corrections', 'owner', { ...proposal,
      toTarget: iri(randomUUID()) }, key)).status).toBe(409);
    expect((await h.get(`/v1/sources/identity-corrections/${short(correction.proposal.proposal)}`, 'other')).status).toBe(404);
    const supports = (await h.pool.query(`SELECT id, target, record_id FROM source.field_support
      WHERE id IN ($1,$2) ORDER BY id`, [fromSupport, toSupport])).rows;
    expect(supports).toEqual(expect.arrayContaining([
      { id: fromSupport, target: fromTarget, record_id: from },
      { id: toSupport, target: toTarget, record_id: to },
    ]));
    await h.accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [h.principalId]);
    expect((await h.get(path, 'owner')).status).toBe(403);
    expect((await h.post('/v1/sources/identity-changes', 'owner', body)).status).toBe(403);
  } finally { await h.close(); }
}, 60_000);

test('LIVE06: acquired redirect assertion keeps source records separate', async () => {
  const h = await identityHarness({ realAccount: true, acquisition: true });
  try {
    h.provider.work('OL991902W', 1, { redirect: 'OL991903W' });
    h.provider.work('OL991903W', 1);
    const captured = await h.post('/v1/sources/acquisitions', 'owner', {
      profile: 'open-library-works-run-v1', workIds: ['OL991902W', 'OL991903W'],
      editions: false, ratings: false, frontier: false }, randomUUID());
    expect(captured.status).toBe(201);
    const run = await captured.json() as { run: { surfaces: Array<{ surface: string;
      outcome: { outcome: string } | null;
      captures: Array<{ observation: string; externalId: string }> }> } };
    const works = run.run.surfaces.find(surface => surface.surface === 'works');
    expect(works?.outcome?.outcome).toBe('qualified');
    const first = works?.captures.find(item => item.externalId === 'OL991902W');
    const second = works?.captures.find(item => item.externalId === 'OL991903W');
    expect(first?.observation).toBeString();
    expect(second?.observation).toBeString();
    const rows = (await h.pool.query<{ id: string; record_id: string }>(`SELECT id, record_id
      FROM source.observation WHERE id IN ($1,$2)`,
    [short(first!.observation), short(second!.observation)])).rows;
    const from = rows.find(row => row.id === short(first!.observation))!.record_id;
    const to = rows.find(row => row.id === short(second!.observation))!.record_id;
    expect(from).not.toBe(to);
    const change = await h.post('/v1/sources/identity-changes', 'owner', {
      profile: 'source-record-identity-change-v1', kind: 'redirect',
      fromRecord: iri(from), toRecord: iri(to), observation: first!.observation,
      evidencePointer: '/redirect' });
    expect(change.status).toBe(201);
    expect((await h.pool.query('SELECT count(*)::int AS n FROM source.record WHERE id IN ($1,$2)',
      [from, to])).rows[0]?.n).toBe(2);
    expect((await h.pool.query('SELECT count(*)::int AS n FROM source.observation WHERE id IN ($1,$2)',
      [short(first!.observation), short(second!.observation)])).rows[0]?.n).toBe(2);
  } finally { await h.close(); }
}, 60_000);

test('LIVE06: native Work heads and Access grants survive a redirect correction proposal', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const directory = join(resolve(import.meta.dir, '../../..'), '.temp', `source-identity-${randomUUID()}`);
  const h = await authorCreditFixture(Bun.env as Record<string, string>, directory);
  try {
    const oldId = 'OL992101W', newId = 'OL992102W';
    const prior = await h.propose(oldId, []), next = await h.propose(newId, []);
    const oldWork = await h.adoptWork(prior), newWork = await h.adoptWork(next);
    const grantId = await h.grant(`work:read:${oldWork.work}`, 'work.read');
    const principal = await h.account.verifier.verify(new Request('http://main.local',
      { headers: { authorization: `Bearer ${h.account.tokenA}` } }), ['work:read']);
    expect(await h.access.canReadWork(principal, h.actor, oldWork.work)).toBe(true);
    expect(await h.access.canReadWork(principal, h.actor, newWork.work)).toBe(false);
    const nativeHeads = () => h.env.fuseki.query(`ASK { GRAPH <${GRAPHS.current}> {
      <${oldWork.work}> <${RV}head> <${oldWork.workRevision}> .
      <${newWork.work}> <${RV}head> <${newWork.workRevision}> . } }`);
    expect((await nativeHeads()).boolean).toBe(true);
    const submitted = await h.json<{ observation: { observation: string; record: string } }>(await h.call('POST',
      '/v1/sources/intakes', { profile: 'source-manual-intake-v1', provider: 'open-library',
        namespace: 'work', externalId: oldId, sourceRevision: 'redirect-2', mediaType: 'application/json',
        retention: 'retained', rawBytesBase64: Buffer.from(JSON.stringify({ redirect: newId })).toString('base64'),
        coverage: { scope: 'record', complete: true, omittedFields: [] },
        rightsEvidence: { basis: 'unknown', note: '' } }), 201);
    expect(submitted.observation.record).toBe(prior.record);
    const change = await h.json<{ change: { change: string; nativeEffect: string } }>(await h.call('POST',
      '/v1/sources/identity-changes', { profile: 'source-record-identity-change-v1', kind: 'redirect',
        fromRecord: prior.record, toRecord: next.record,
        observation: submitted.observation.observation, evidencePointer: '/redirect' }), 201);
    expect(change.change.nativeEffect).toBe('none');
    const correction = await h.json<{ proposal: { effect: string; proposal: string } }>(await h.call('POST',
      '/v1/sources/identity-corrections', { profile: 'source-identity-correction-proposal-v1',
        change: change.change.change, fromTarget: oldWork.work, toTarget: newWork.work }), 201);
    expect(correction.proposal.effect).toBe('proposal-only');
    expect((await h.call('GET', `/v1/sources/identity-corrections/${short(correction.proposal.proposal)}`,
      undefined, randomUUID(), h.account.tokenB)).status).toBe(404);
    expect(await h.access.canReadWork(principal, h.actor, oldWork.work)).toBe(true);
    expect(await h.access.canReadWork(principal, h.actor, newWork.work)).toBe(false);
    expect((await nativeHeads()).boolean).toBe(true);
    expect((await h.accessPool.query('SELECT active, scope_id FROM access.permission_grant WHERE id = $1',
      [grantId])).rows[0]).toEqual({ active: true, scope_id: `work:read:${oldWork.work}` });
    const bindings = (await h.pool.query(`SELECT p.record_id, b.work FROM source.native_work_binding b
      JOIN source.native_work_proposal p ON p.id = b.proposal_id WHERE b.work IN ($1,$2) ORDER BY b.work`,
    [oldWork.work, newWork.work])).rows;
    expect(bindings).toEqual(expect.arrayContaining([
      { record_id: short(prior.record), work: oldWork.work },
      { record_id: short(next.record), work: newWork.work },
    ]));
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
}, 60_000);
