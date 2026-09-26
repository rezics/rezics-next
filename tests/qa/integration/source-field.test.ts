import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { authorCreditFixture, author, shortId } from '../fixtures/author-credit.ts';
import { GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';
import { nativeSupportLookupSql } from '../../../services/main/src/modules/source/withdrawal.ts';
import { fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
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

test('LIVE04/LIVE05: one withdrawal route preserves native credits and independent title support', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const directory = join(resolve(import.meta.dir, '../../..'), '.temp', `source-field-${randomUUID()}`);
  const h = await authorCreditFixture(Bun.env as Record<string, string>, directory);
  try {
    const proposal = await h.propose('OL993101W', [author('/authors/OL1A'), author('/authors/OL2A')]);
    const work = await h.adoptWork(proposal);
    await h.grant(`work:edit:${work.work}`, 'work.edit');
    await h.grant(`work:read:${work.work}`, 'work.read');
    const creditPath = `/v1/works/${shortId(work.work)}/source-author-credits`;
    const creditA = await h.json<{ support: { support: string; credit: { credit: string; revision: string } } }>(
      await h.call('POST', creditPath, h.input(proposal, work, 0)), 201);
    const creditB = await h.json<{ support: { support: string; credit: { credit: string; revision: string } } }>(
      await h.call('POST', creditPath, h.input(proposal, work, 1, '/authors/OL2A')), 201);
    const secondProposal = await h.propose('OL993102W', [author('/authors/OL1A')]);
    const attachment = await h.json<{ attachment: { binding: string } }>(await h.call('POST',
      `/v2/works/${shortId(work.work)}/source-supports`, {
        profile: 'native-work-source-title-attachment-v2', proposal: secondProposal.proposal,
        expectedHead: work.workRevision, actingSubject: h.actor,
        confirmedTitle: proposal.candidateTitle, titleLanguage: 'en' }), 201);
    const nativeHead = () => h.env.fuseki.query(`ASK { GRAPH <${GRAPHS.current}> {
      <${work.work}> <${RV}head> <${work.workRevision}> .
      <${creditA.support.credit.credit}> <${RV}creditRevision> <${creditA.support.credit.revision}> .
      <${creditB.support.credit.credit}> <${RV}creditRevision> <${creditB.support.credit.revision}> . } }`);
    expect((await nativeHead()).boolean).toBe(true);
    for (const support of [work.binding, attachment.attachment.binding, creditA.support.support]) {
      const plan = (await h.pool.query<{ 'QUERY PLAN': Array<{ Plan: {
        'Actual Rows': number; 'Shared Hit Blocks': number; 'Shared Read Blocks': number;
        'Temp Read Blocks': number } }> }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ${nativeSupportLookupSql}`,
        [shortId(support), h.principalId])).rows[0]!['QUERY PLAN'][0]!.Plan;
      expect(plan['Actual Rows']).toBe(1);
      expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(64);
      expect(plan['Temp Read Blocks']).toBe(0);
    }
    const titleBody = { profile: 'source-support-withdrawal-v1', support: work.binding,
      expectedSupport: work.binding, reason: 'Withdraw first title evidence' };
    expect((await h.call('POST', '/v1/sources/withdrawals', {
      ...titleBody, profile: 'source-field-withdrawal-v1' })).status).toBe(400);
    expect((await h.call('POST', '/v1/sources/withdrawals', titleBody, randomUUID(), h.account.noScope)).status).toBe(401);
    expect((await h.call('GET', `/v1/sources/supports/${shortId(work.binding)}`,
      undefined, randomUUID(), h.account.tokenB)).status).toBe(404);
    const titleKey = randomUUID();
    const withdrawnTitle = await h.json<{ support: { kind: string; support: { state: string } }; replayed: boolean }>(
      await h.call('POST', '/v1/sources/withdrawals', titleBody, titleKey), 201);
    expect(withdrawnTitle.support).toMatchObject({ kind: 'adoption', support: { state: 'withdrawn' } });
    expect((await h.call('POST', '/v1/sources/withdrawals', titleBody, titleKey)).status).toBe(200);
    const budget = { signal: AbortSignal.timeout(10_000), callsLeft: 64, bytesLeft: 262_144 };
    expect((await fusekiReadBudget.run(budget, () => h.call('GET',
      `/v1/sources/supports/${shortId(attachment.attachment.binding)}`))).status).toBe(200);
    expect(64 - budget.callsLeft).toBeLessThanOrEqual(16);
    expect(262_144 - budget.bytesLeft).toBeLessThan(64_000);
    const childBody = { profile: 'source-support-withdrawal-v1', support: creditA.support.support,
      expectedSupport: creditA.support.support, reason: 'Withdraw first child evidence' };
    expect((await h.call('POST', '/v1/sources/withdrawals', { ...childBody,
      expectedSupport: creditB.support.support })).status).toBe(409);
    const childKey = randomUUID();
    const withdrawnChild = await h.json<{ support: { kind: string; support: { state: string } } }>(
      await h.call('POST', '/v1/sources/withdrawals', childBody, childKey), 201);
    expect(withdrawnChild.support).toMatchObject({ kind: 'author-credit', support: { state: 'withdrawn' } });
    expect((await h.call('POST', '/v1/sources/withdrawals', { ...childBody,
      reason: 'changed' }, childKey)).status).toBe(409);
    expect((await h.call('GET', `/v1/sources/supports/${shortId(creditB.support.support)}`)).status).toBe(200);
    expect((await nativeHead()).boolean).toBe(true);
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
}, 60_000);
