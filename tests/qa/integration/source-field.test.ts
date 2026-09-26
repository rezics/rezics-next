import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { authorCreditFixture, author, shortId } from '../fixtures/author-credit.ts';
import { GRAPHS, RV, hash } from '../../../services/main/src/modules/work/activate.ts';
import { nativeSupportLookupSql } from '../../../services/main/src/modules/source/withdrawal.ts';
import { fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
import { readMainOutboxEnvelope } from '../../../services/main/src/modules/outbox/relay.ts';
import { identityHarness, iri, sha } from './source-identity-harness.ts';
import { synopsisSlot } from '../../../services/main/src/modules/source/field-control-native.ts';
import { PROTECTION_RULE } from '../../../services/main/src/modules/protection/schema.ts';

const short = (value: string) => value.split('/').at(-1)!;

test('LIVE03: synopsis source refresh yields to a same-value human control epoch', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const directory = join(resolve(import.meta.dir, '../../..'), '.temp', `synopsis-field-${randomUUID()}`);
  const h = await authorCreditFixture(Bun.env as Record<string, string>, directory);
  try {
    const initial = await h.propose('OL993401W', [author('/authors/OL1A')],
      'Synopsis Work', 'A source synopsis');
    const work = await h.adoptWork(initial);
    await h.grant(`work:edit:${work.work}`, 'work.edit');
    await h.grant(`work:read:${work.work}`, 'work.read');
    const path = `/v1/works/${shortId(work.work)}/fields/synopsis/control`;
    const read = async () => h.json<{ workHead: string; contentHead: string | null;
      controlHead: string | null; controlEpoch: string; mode: string; value: string | null;
      rightsStatus: string | null }>(await h.call('GET', `${path}?actingSubject=${encodeURIComponent(h.actor)}`), 200);
    const absent = await read();
    expect(absent).toMatchObject({ workHead: work.workRevision, contentHead: null,
      controlHead: null, controlEpoch: '0', mode: 'unestablished', value: null });
    const basis = (state: typeof absent) => ({ contentHead: state.contentHead,
      head: state.controlHead, epoch: state.controlEpoch, protection: null });
    const source = (proposal: typeof initial, value: string, state: typeof absent) => ({
      profile: 'work-editorial-field-control-v1', field: 'synopsis',
      expectedWorkHead: work.workRevision, basis: basis(state), value, origin: 'source',
      source: { record: proposal.record, observation: proposal.observation,
        conversion: proposal.conversion, mapping: 'open-library-work-map-v1' },
      actingSubject: h.actor });
    const first = source(initial, 'A source synopsis', absent), firstKey = randomUUID();
    expect((await h.call('POST', path, first, firstKey, h.account.noScope)).status).toBe(401);
    expect((await h.call('POST', path, first, firstKey, h.account.tokenB)).status).toBe(404);
    const applied = await h.json<{ control: string; content: string; receipt: string; replayed: boolean;
      support: string }>(
      await h.call('POST', path, first, firstKey), 201);
    expect(applied.replayed).toBe(false);
    expect((await h.call('POST', path, first, firstKey)).status).toBe(200);
    expect((await h.call('POST', path, { ...first, value: 'Changed key intent' }, firstKey)).status).toBe(409);
    const afterInitial = await read();
    expect(afterInitial).toMatchObject({ value: 'A source synopsis',
      controlEpoch: '1', mode: 'source-managed', rightsStatus: 'undetermined' });
    expect(afterInitial.contentHead).toBe(applied.content);
    expect(afterInitial.controlHead).toBe(applied.control);
    const sourceSupportPath = `/v1/sources/field-supports/${shortId(applied.support)}`;
    const firstSupport = await h.json<{ outcome: string; graphReceipt: string;
      nativeRevision: string; supportIdentity: string }>(await h.call('GET', sourceSupportPath), 200);
    expect(firstSupport).toMatchObject({ outcome: 'applied', graphReceipt: applied.receipt,
      nativeRevision: applied.content });
    const refresh = await h.propose('OL993401W', [author('/authors/OL1A')],
      'Synopsis Work', 'A revised synopsis');
    const refreshIntent = source(refresh, 'A revised synopsis', afterInitial);
    const refreshKey = randomUUID();
    h.loseFieldGraph(); h.failFieldCertificate();
    expect((await h.call('POST', path, refreshIntent, refreshKey)).status).toBe(503);
    const pending = (await h.pool.query<{ pending_step_id: string }>(`SELECT h.pending_step_id
      FROM source.field_support s JOIN source.field_support_head h ON h.support_id = s.id
      WHERE s.id = $1`, [shortId(applied.support)])).rows[0];
    expect(pending?.pending_step_id).not.toBeNull();
    const afterRefresh = await read();
    expect(afterRefresh).toMatchObject({ value: 'A revised synopsis', controlEpoch: '2',
      mode: 'source-managed', rightsStatus: 'undetermined' });
    expect(afterRefresh.contentHead).not.toBe(applied.content);
    const human = { ...source(refresh, 'A revised synopsis', afterRefresh),
      origin: 'human', source: null };
    expect((await h.call('POST', path, human)).status).toBe(201);
    const confirmed = await read();
    expect(confirmed).toMatchObject({ value: 'A revised synopsis', controlEpoch: '3',
      mode: 'human-controlled', rightsStatus: 'undetermined' });
    expect(confirmed.contentHead).not.toBe(afterRefresh.contentHead);
    const refreshed = await h.json<{ content: string; control: string;
      support: string; replayed: boolean }>(await h.call('POST', path, refreshIntent, refreshKey), 200);
    expect(refreshed).toMatchObject({ content: afterRefresh.contentHead,
      control: afterRefresh.controlHead, support: applied.support, replayed: true });
    expect(await read()).toEqual(confirmed);
    expect((await h.call('POST', path, source(refresh, 'A revised synopsis', afterRefresh))).status).toBe(409);
    expect((await h.call('POST', path, source(refresh, 'A revised synopsis', confirmed))).status).toBe(409);
    expect(await read()).toEqual(confirmed);
    const latestSupport = await h.json<{ supportIdentity: string; outcome: string;
      nativeRevision: string; state: string }>(await h.call('GET', sourceSupportPath), 200);
    expect(latestSupport).toMatchObject({ outcome: 'applied', state: 'recorded',
      nativeRevision: refreshed.content });
    expect(latestSupport.supportIdentity).not.toBe(firstSupport.supportIdentity);
    const withdrawn = await h.json<{ support: { state: string; nativeRevision: string } }>(
      await h.call('POST', '/v1/sources/withdrawals', {
        profile: 'source-field-withdrawal-v1', support: applied.support,
        expectedSupport: latestSupport.supportIdentity, reason: 'Withdraw source synopsis evidence',
      }), 201);
    expect(withdrawn.support).toMatchObject({ state: 'withdrawn', nativeRevision: refreshed.content });
    expect(await read()).toEqual(confirmed);
    await h.grant(`work:protect:${work.work}`, 'work.protection.tighten');
    const protectedWork = await h.json<{ protectionRevision: string }>(await h.call('POST',
      '/v1/work-title-protections', { profile: 'work-title-protection-v1', action: 'tighten',
        work: work.work, expectedHead: work.workRevision, expectedProtection: null,
        expectedControl: null, expectedControlEpoch: '0', expectedRuleRevision: PROTECTION_RULE,
        actingSubject: h.actor, reason: 'Review the Work before another synopsis edit', evidence: [] }), 201);
    expect(protectedWork.protectionRevision).toStartWith('https://rezics.com/id/');
    expect((await h.call('POST', path, { ...human, basis: basis(confirmed) })).status).toBe(409);
    expect(await read()).toEqual(confirmed);
    const slot = synopsisSlot(work.work);
    const graph = await h.env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.current}> {
      <${slot}> rv:fieldHead <${confirmed.contentHead}> ; rv:fieldControlHead <${confirmed.controlHead}> . } }`);
    expect(graph.boolean).toBe(true);
    expect(h.fieldCommands.at(-1)).toMatchObject({ focuses: 3 });
    expect(h.fieldCommands.every(command => command.bytes < 24_000)).toBe(true);
    for (const [from, to] of [[1, 8], [9, 64], [65, 512]]) {
      const supports = (await h.pool.query<{ id: string }>(`
        INSERT INTO source.field_support (id,principal_id,target,slot,occurrence,context,record_id)
        SELECT gen_random_uuid(),$1,'https://rezics.com/id/' || gen_random_uuid(),
          'work-editorial-field-v1#synopsis',NULL,'global',$2
        FROM generate_series($3::int,$4::int) RETURNING id`,
      [h.principalId, shortId(initial.record), from, to])).rows;
      await h.pool.query(`INSERT INTO source.field_support_step
          (id,support_id,ordinal,principal_id,action,conversion_id,mapping_revision,
           grain,source_field,source_occurrence,value_digest,expected_head,control_intent,
           acting_subject,authority_proof,native_idempotency_key,idempotency_key,request_digest)
        SELECT gen_random_uuid(),s.id,1,st.principal_id,'apply',st.conversion_id,
          st.mapping_revision,st.grain,st.source_field,NULL,st.value_digest,st.expected_head,
          st.control_intent,st.acting_subject,st.authority_proof,
          'source-field-' || gen_random_uuid(),'background-' || gen_random_uuid(),st.request_digest
        FROM unnest($2::uuid[]) AS s(id) CROSS JOIN source.field_support_step st WHERE st.id = $1`,
      [shortId(firstSupport.supportIdentity), supports.map(row => row.id)]);
      await h.pool.query('ANALYZE source.field_support_step');
      const plan = (await h.pool.query<{ 'QUERY PLAN': Array<{ Plan: {
        'Actual Rows': number; 'Shared Hit Blocks': number; 'Shared Read Blocks': number;
        'Temp Read Blocks': number } }> }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
        SELECT id,support_id,request_digest,native_idempotency_key
        FROM source.field_support_step WHERE principal_id = $1 AND idempotency_key = $2`,
      [h.principalId, firstKey])).rows[0]!['QUERY PLAN'][0]!.Plan;
      expect(plan['Actual Rows']).toBe(1);
      expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(32);
      expect(plan['Temp Read Blocks']).toBe(0);
    }
    const readBudget = { signal: AbortSignal.timeout(10_000), callsLeft: 16, bytesLeft: 262_144 };
    await fusekiReadBudget.run(readBudget, async () => {
      expect((await h.call('GET', `${path}?actingSubject=${encodeURIComponent(h.actor)}`)).status).toBe(200);
      expect((await h.call('GET', sourceSupportPath)).status).toBe(200);
    });
    expect(16 - readBudget.callsLeft).toBeLessThanOrEqual(8);
    expect(262_144 - readBudget.bytesLeft).toBeLessThan(64_000);
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
}, 120_000);

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
    const secondProposal = await h.propose('OL993102W', [author('/authors/OL1A'), author('/authors/OL2A')]);
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
    const retirementPath = `/v1/works/${shortId(work.work)}/author-credits/${shortId(creditB.support.credit.credit)}`
      + '/retirements';
    const retirement = { profile: 'work-author-credit-retirement-v1',
      revision: creditB.support.credit.revision, expectedHead: work.workRevision,
      actingSubject: h.actor, reason: 'Explicit human retirement' };
    expect((await h.call('POST', retirementPath, retirement, randomUUID(), h.account.noScope)).status).toBe(401);
    expect((await h.call('POST', retirementPath, retirement, randomUUID(), h.account.tokenB)).status).toBe(403);
    const retirementKey = randomUUID();
    h.loseRetirementGraph();
    const retirementBudget = { signal: AbortSignal.timeout(10_000), callsLeft: 64, bytesLeft: 262_144 };
    const retired = await h.json<{ retirement: { retirement: string;
      sourcePosition: { dataEpoch: string; sequence: string } }; replayed: boolean }>(
      await fusekiReadBudget.run(retirementBudget, () => h.call('POST',
        retirementPath, retirement, retirementKey)), 201);
    expect(retired.replayed).toBe(false);
    expect(64 - retirementBudget.callsLeft).toBeLessThanOrEqual(32);
    expect(262_144 - retirementBudget.bytesLeft).toBeLessThan(128_000);
    const eventId = `urn:rezics:event:${hash(`${retired.retirement.retirement}\0author-credit-retired`)}`;
    const envelope = await readMainOutboxEnvelope(h.env.fuseki, {
      batchId: `urn:rezics:outbox:${hash(retired.retirement.retirement)}`,
      dataEpoch: retired.retirement.sourcePosition.dataEpoch,
      sequence: retired.retirement.sourcePosition.sequence,
      routingEpoch: h.env.lineage.routingEpoch, eventIds: [eventId],
    }, eventId);
    expect(envelope.type).toBe('com.rezics.work.author-credit-retired.v1');
    expect((await h.call('POST', retirementPath, retirement, retirementKey)).status).toBe(200);
    expect((await h.call('POST', retirementPath, { ...retirement,
      reason: 'Changed reason' }, retirementKey)).status).toBe(409);
    const retiredRead = `/v1/works/${shortId(work.work)}/author-credits/${shortId(creditB.support.credit.credit)}`
      + `/retirement?actingSubject=${encodeURIComponent(h.actor)}`;
    expect((await h.call('GET', retiredRead)).status).toBe(200);
    expect((await h.call('GET', retiredRead, undefined, randomUUID(), h.account.tokenB)).status).toBe(404);
    const retiredNative = await h.env.fuseki.query(`ASK { GRAPH <${GRAPHS.current}> {
      <${creditB.support.credit.credit}> <${RV}retiredBy> <${retired.retirement.retirement}> .
      <${creditB.support.credit.credit}> <${RV}creditRevision> <${creditB.support.credit.revision}> .
      <${creditA.support.credit.credit}> <${RV}creditRevision> <${creditA.support.credit.revision}> .
      <${work.work}> <${RV}head> <${work.workRevision}> . } }`);
    expect(retiredNative.boolean).toBe(true);
    expect((await h.call('POST', creditPath, { ...h.input(secondProposal, work, 1, '/authors/OL2A'),
      baseSupport: creditB.support.support })).status).toBe(409);
    const firstRetirementPath = `/v1/works/${shortId(work.work)}`
      + `/author-credits/${shortId(creditA.support.credit.credit)}/retirements`;
    const firstRetirement = { ...retirement, revision: creditA.support.credit.revision };
    expect((await h.call('POST', firstRetirementPath, {
      ...firstRetirement, expectedHead: iri(randomUUID()) })).status).toBe(409);
    const race = await Promise.all([h.call('POST', firstRetirementPath, firstRetirement, randomUUID()),
      h.call('POST', firstRetirementPath, firstRetirement, randomUUID())]);
    expect(race.map(response => response.status).sort()).toEqual([201, 409]);
    expect((await nativeHead()).boolean).toBe(true);
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
}, 60_000);
