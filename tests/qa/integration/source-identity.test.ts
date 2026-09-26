import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { identityHarness, iri } from './source-identity-harness.ts';

const short = (value: string) => value.split('/').at(-1)!;

test('LIVE06: redirect and merge evidence proposes identity correction without moving native supports', async () => {
  const h = await identityHarness();
  try {
    const from = await h.record('old'), to = await h.record('new');
    const foreign = await h.record('foreign', 'other-provider');
    const observation = await h.observation(from, '{"redirect":"new"}');
    const body = { profile: 'source-record-identity-change-v1', kind: 'redirect',
      fromRecord: iri(from), toRecord: iri(to), observation: iri(observation), evidencePointer: '/redirect' };
    expect((await h.post('/v1/sources/identity-changes', 'reader', body)).status).toBe(401);
    expect((await h.post('/v1/sources/identity-changes', 'other', body)).status).toBe(404);
    expect((await h.post('/v1/sources/identity-changes', 'owner', { ...body,
      toRecord: iri(foreign) })).status).toBe(404);
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
    expect((await h.get(path, 'reader')).status).toBe(200);

    const fromTarget = iri(randomUUID()), toTarget = iri(randomUUID());
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
    expect((await h.get(path, 'reader')).status).toBe(403);
    expect((await h.post('/v1/sources/identity-changes', 'owner', body)).status).toBe(403);
  } finally { await h.close(); }
}, 30_000);
