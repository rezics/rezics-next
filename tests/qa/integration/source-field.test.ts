import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { identityHarness, iri, sha } from './source-identity-harness.ts';

const short = (value: string) => value.split('/').at(-1)!;

test('LIVE05: generic field withdrawal serializes one support and preserves independent acceptance', async () => {
  const h = await identityHarness();
  try {
    const target = iri(randomUUID()), revision = iri(randomUUID()), actor = iri(randomUUID());
    const mapping = `fixture-${randomUUID().replaceAll('-', '')}-v1`, slot = 'work-metadata-v2#subtitle';
    const client = await h.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO source.field_mapping
        (mapping_revision, provider, namespace, root_grain, field_count) VALUES ($1,'fixture','work','work',1)`, [mapping]);
      await client.query(`INSERT INTO source.field_disposition
        (mapping_revision, grain, field_key, disposition, value_kind, reason, native_target)
        VALUES ($1,'work','subtitle','native','text','explicit native field',$2)`, [mapping, slot]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }

    const seed = async (label: string) => {
      const record = await h.record(label);
      const bytes = JSON.stringify({ subtitle: label });
      const observation = await h.observation(record, bytes);
      const conversion = randomUUID(), support = randomUUID(), step = randomUUID();
      await h.pool.query(`INSERT INTO source.conversion (id, observation_id, principal_id,
        mapping_revision, source_digest, projection, field_inventory)
        VALUES ($1,$2,$3,$4,$5,'{}',$6)`, [conversion, observation, h.principalId, mapping, sha(bytes),
        JSON.stringify([{ grain: 'work', field: 'subtitle', disposition: 'native' }])]);
      await h.pool.query(`INSERT INTO source.field_support
        (id, principal_id, target, slot, occurrence, context, record_id)
        VALUES ($1,$2,$3,$4,NULL,'global',$5)`, [support, h.principalId, target, slot, record]);
      const addStep = async (stepId: string, ordinal: number) => h.pool.query(`INSERT INTO source.field_support_step
        (id, support_id, ordinal, principal_id, action, conversion_id, mapping_revision,
         grain, source_field, source_occurrence, value_digest, expected_head,
         control_intent, acting_subject, authority_proof, native_idempotency_key,
         idempotency_key, request_digest)
        VALUES ($1,$2,$3,$4,'attach',$5,$6,'work','subtitle',NULL,$7,$8,NULL,$9,$10,NULL,$11,$12)`,
      [stepId, support, ordinal, h.principalId, conversion, mapping, sha(label), revision, actor,
        JSON.stringify({ principalId: h.principalId, actingSubject: actor }), randomUUID(), sha(stepId)]);
      const settle = async (stepId: string) => h.pool.query(`INSERT INTO source.field_support_outcome
        (step_id, outcome, native_revision, graph_receipt, admission_id, data_epoch, sequence,
         head_guarantee, receipt) VALUES ($1,'attached',$2,NULL,NULL,NULL,NULL,'verified-before-commit','{}')`,
      [stepId, revision]);
      await addStep(step, 1);
      await settle(step);
      return { support, step, addStep, settle };
    };
    const a = await seed('first'), b = await seed('second');
    const path = `/v1/sources/field-supports/${a.support}`;
    const initial = await h.get(path, 'reader');
    expect(initial.status).toBe(200);
    const before = await initial.json() as { supportIdentity: string; state: string; nativeRevision: string };
    expect(before).toMatchObject({ supportIdentity: iri(a.step), state: 'recorded', nativeRevision: revision });
    expect((await h.get(path, 'other')).status).toBe(404);
    const body = { profile: 'source-field-withdrawal-v1', support: iri(a.support),
      expectedSupport: iri(a.step), reason: 'Provider removed this field' };
    expect((await h.post('/v1/sources/withdrawals', 'reader', body, randomUUID())).status).toBe(401);
    expect((await h.post('/v1/sources/withdrawals', 'other', body, randomUUID())).status).toBe(404);
    expect((await h.post('/v1/sources/withdrawals', 'owner', { ...body,
      expectedSupport: iri(randomUUID()) }, randomUUID())).status).toBe(409);
    const key = randomUUID();
    const concurrent = await Promise.all([h.post('/v1/sources/withdrawals', 'owner', body, key),
      h.post('/v1/sources/withdrawals', 'owner', body, key)]);
    expect(concurrent.map(item => item.status).sort()).toEqual([200, 201]);
    const after = await (await h.get(path, 'reader')).json() as { state: string; nativeRevision: string;
      withdrawal: { nativeEffect: string; reason: string } };
    expect(after).toMatchObject({ state: 'withdrawn', nativeRevision: revision,
      withdrawal: { nativeEffect: 'none', reason: body.reason } });
    expect((await h.get(`/v1/sources/field-supports/${b.support}`, 'reader')).status).toBe(200);
    expect((await h.post('/v1/sources/withdrawals', 'owner', { ...body, reason: 'Changed' }, key)).status).toBe(409);
    await expect(a.addStep(randomUUID(), 2)).rejects.toMatchObject({ constraint: 'field_support_active' });

    const next = randomUUID();
    await b.addStep(next, 2);
    expect((await h.post('/v1/sources/withdrawals', 'owner', { ...body,
      support: iri(b.support), expectedSupport: iri(b.step) }, randomUUID())).status).toBe(409);
    await b.settle(next);
    expect((await h.post('/v1/sources/withdrawals', 'owner', { ...body,
      support: iri(b.support), expectedSupport: iri(b.step) }, randomUUID())).status).toBe(409);
    expect((await h.pool.query(`SELECT count(*)::int AS n FROM source.field_support_withdrawal
      WHERE support_id IN ($1,$2)`, [a.support, b.support])).rows[0]?.n).toBe(1);
    expect(short(after.nativeRevision)).toBe(short(revision));
    await h.accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [h.principalId]);
    expect((await h.get(path, 'reader')).status).toBe(403);
  } finally { await h.close(); }
}, 30_000);
