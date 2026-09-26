import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient, type CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { ProtectionAdmissionSigner } from '../../../services/main/src/modules/access/protection-admission.ts';
import { PROTECTION_RULE } from '../../../services/main/src/modules/protection/schema.ts';
import { strongRevokeWorkProtectionScope } from '../../../services/main/src/modules/protection/work.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { ratingAccount } from '../support/rating-account.ts';

const id = () => `https://rezics.com/id/${Bun.randomUUIDv7()}`;

test('SYS02/SYS03/SYS10/SYS11/SYS14: protected Work correction uses one reviewed owner commit', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through selected QA integration');
  const apps = Bun.env as Record<string, string>;
  const account = await ratingAccount(apps, 'openid work:create work:edit work:read work:protect work:correct work:review');
  const pool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
  const relayPool = new Pool({ connectionString: apps.ACCOUNT_RELAY_DATABASE_URL });
  try {
    const nativeFuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
    let loseReview = false;
    let beforeReview: (() => Promise<void>) | undefined;
    let graphQueries = 0, graphReadBytes = 0, proposalCommandBytes = 0;
    let hiddenReceipt: string | null = null, reviewCommands = 0;
    const fuseki = new Proxy(nativeFuseki, { get(target, property) {
      if (property === 'query') return async (...args: Parameters<FusekiClient['query']>) => {
        const result = await target.query(...args);
        graphQueries++; graphReadBytes += Buffer.byteLength(JSON.stringify(result));
        if (hiddenReceipt && args[0].includes(`<${hiddenReceipt}>`)
          && args[0].includes('SELECT ?outcome ?recordedAction')) {
          return { ...result, results: { ...result.results!, bindings: [] } };
        }
        return result;
      };
      if (property === 'commandWithReceipt') return async (command: CommandEnvelope) => {
        if (command.update.includes('WorkCorrectionReviewedEvent')) reviewCommands++;
        if (command.update.includes('WorkCorrectionProposedEvent')) {
          proposalCommandBytes = Buffer.byteLength(JSON.stringify(command));
        }
        if (command.update.includes('WorkCorrectionReviewedEvent') && beforeReview) {
          const hook = beforeReview; beforeReview = undefined; await hook();
        }
        const result = await target.commandWithReceipt(command);
        if (loseReview && command.update.includes('WorkCorrectionReviewedEvent')) {
          loseReview = false; throw new Error('lost Work correction acknowledgement');
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as FusekiClient;
    const environment = { fuseki, lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! },
      objectDirectory: resolve('.temp', `work-protection-${randomUUID()}`) };
    const access = new AccessAdmissionRegistry(pool, apps.FUSEKI_TITLE_ADMISSION_KEY);
    const signer = new ProtectionAdmissionSigner(pool, apps.FUSEKI_TITLE_ADMISSION_KEY);
    const app = createMainApp(fuseki, { environment, account: account.verifier, access, protectionSigner: signer });
    const principals = [randomUUID(), randomUUID()], actors = [id(), id()];
    await pool.query(`INSERT INTO access.principal (id,account_issuer,account_subject)
      VALUES ($1,$2,$3),($4,$2,$5)`, [principals[0], account.issuer, account.a.id, principals[1], account.b.id]);
    for (const actor of actors) await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [actor]);
    const grant = async (who: 0 | 1, scope: string, action: string) => {
      await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), principals[who], actors[who], action]);
      await pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), actors[who], scope, action]);
    };
    const call = (method: string, path: string, body?: object, key = randomUUID(), who: 0 | 1 = 0) => app.handle(
      new Request(`http://main.local${path}`, { method, headers: { authorization: `Bearer ${who ? account.tokenB : account.tokenA}`,
        'idempotency-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const json = async <T>(response: Response, expected: number): Promise<T> => {
      const result = await response.json();
      if (response.status !== expected) console.error('Work protection response', response.status, result);
      expect(response.status).toBe(expected);
      return result as T;
    };
    await grant(0, 'work:create:root', 'work.create');
    const created = await json<{ work: string; workRevision: string }>(await call('POST', '/v1/works',
      { profile: 'metadata-only-v1', title: 'Original title', actingSubject: actors[0] }), 201);
    const work = created.work;
    await grant(0, `work:read:${work}`, 'work.read');
    await grant(0, `work:edit:${work}`, 'work.edit');
    await grant(0, `work:protect:${work}`, 'work.protection.tighten');
    await grant(0, `work:correct:${work}`, 'work.correction.propose');
    await grant(1, `work:review:${work}`, 'work.correction.review');
    const basis = { work, expectedHead: created.workRevision, expectedProtection: null,
      expectedControl: null, expectedControlEpoch: '0', expectedRuleRevision: PROTECTION_RULE,
      actingSubject: actors[0], reason: 'Review the reported title', evidence: [] };
    const protect = { profile: 'work-title-protection-v1', action: 'tighten', ...basis };
    const protectKey = randomUUID();
    const protection = await json<{ protectionRevision: string; receipt: string }>(
      await call('POST', '/v1/work-title-protections', protect, protectKey), 201);
    expect(protection.protectionRevision).toStartWith('https://rezics.com/id/');
    expect(await json(await call('POST', '/v1/work-title-protections', {
      evidence: [], reason: basis.reason, actingSubject: basis.actingSubject,
      expectedRuleRevision: basis.expectedRuleRevision, expectedControlEpoch: basis.expectedControlEpoch,
      expectedControl: basis.expectedControl, expectedProtection: basis.expectedProtection,
      expectedHead: basis.expectedHead, work, action: 'tighten', profile: 'work-title-protection-v1',
    }, protectKey), 200)).toMatchObject({ protectionRevision: protection.protectionRevision, replayed: true });
    const state = await json<{ protectionHead: string; protectionMode: string; contentHead: string }>(
      await call('GET', `/v1/works/${work.split('/').at(-1)}/editorial-state?actingSubject=${encodeURIComponent(actors[0])}`), 200);
    expect(state).toMatchObject({ contentHead: created.workRevision,
      protectionHead: protection.protectionRevision, protectionMode: 'review-required' });
    await json(await call('POST', '/v1/works', { profile: 'metadata-only-v1',
      title: 'Unrelated sequence advance', actingSubject: actors[0] }), 201);
    expect((await call('POST', '/v1/work-title-protections', protect)).status).toBe(409);
    expect(await json(await call('POST', '/v1/work-title-protections', { ...protect, reason: 'Different request' },
      protectKey, 0), 409)).toMatchObject({ code: 'idempotency_conflict' });
    const edit = { profile: 'metadata-only-v1', work, expectedHead: created.workRevision,
      title: 'Unauthorized replacement', actingSubject: actors[0],
      titleControl: { head: null, epoch: '0', protection: protection.protectionRevision } };
    expect((await call('POST', '/v1/content-edits', edit)).status).toBe(409);
    const proposalRequest = { profile: 'work-title-correction-v1', ...basis,
      expectedProtection: protection.protectionRevision, title: 'Reviewed title', predecessor: null };
    const proposed = await json<{ proposalRevision: string }>(await call('POST', '/v1/work-title-corrections', proposalRequest), 201);
    const read = await json<{ proposal: { candidateDigest: string; candidate: string; title: string } }>(
      await call('GET', `/v1/work-title-corrections/${proposed.proposalRevision.split('/').at(-1)}?actingSubject=${
        encodeURIComponent(actors[0])}`), 200);
    expect(read.proposal.title).toBe('Reviewed title');
    const review = { profile: 'work-title-correction-review-v1', ...basis,
      expectedProtection: protection.protectionRevision, actingSubject: actors[1],
      candidateDigest: read.proposal.candidateDigest, expectedDecisionHead: null,
      outcome: 'approved' };
    const decisionPath = `/v1/work-title-corrections/${proposed.proposalRevision.split('/').at(-1)}/decisions`;
    await grant(0, `work:review:${work}`, 'work.correction.review');
    expect((await call('POST', decisionPath, { ...review, actingSubject: actors[0] })).status).toBe(403);
    const reviewKey = randomUUID();
    loseReview = true;
    const approved = await json<{ operation: string; decision: string; receipt: string;
      reviewOutcome: string; replayed: boolean;
      sourcePosition: { sequence: string } }>(
      await call('POST', decisionPath, review, reviewKey, 1), 200);
    expect(approved.reviewOutcome).toBe('approved');
    expect(approved.replayed).toBe(true);
    expect((await pool.query<{ state: string; graph_receipt: string }>(
      'SELECT state,graph_receipt FROM access.admission WHERE id = $1',
      [approved.operation.split('/').at(-1)])).rows[0]).toEqual({ state: 'sealed', graph_receipt: approved.receipt });
    expect((await json<{ decision: string; replayed: boolean }>(await call('POST', decisionPath, review,
      reviewKey, 1), 200))).toMatchObject({ decision: approved.decision, replayed: true });
    hiddenReceipt = approved.receipt;
    const beforeMissingReceipt = reviewCommands;
    expect(await json(await call('POST', decisionPath, review, reviewKey, 1), 202))
      .toMatchObject({ status: 'reconciling' });
    expect(reviewCommands).toBe(beforeMissingReceipt);
    hiddenReceipt = null;
    expect((await call('POST', decisionPath, { ...review, outcome: 'rejected' }, randomUUID(), 1)).status).toBe(409);
    expect((await call('POST', decisionPath, { ...review, outcome: 'rejected' }, reviewKey, 1)).status).toBe(409);
    const after = await json<{ contentHead: string; protectionHead: string; controlHead: string; controlEpoch: string }>(
      await call('GET', `/v1/works/${work.split('/').at(-1)}/editorial-state?actingSubject=${encodeURIComponent(actors[0])}`), 200);
    expect(after).toMatchObject({ contentHead: read.proposal.candidate,
      protectionHead: protection.protectionRevision, controlEpoch: '1' });
    const consumer = `work-protection-${randomUUID()}`;
    await initializeRelayCheckpoint(relayPool, consumer, environment.lineage.dataEpoch);
    let sequence = '0';
    while (BigInt(sequence) < BigInt(approved.sourcePosition.sequence)) {
      const batch = await relayMainOutboxOnce(fuseki, relayPool, consumer);
      if (!batch) throw new Error('protected Work outbox gap');
      sequence = batch.sequence;
    }
    const relayed = (await relayPool.query<{ envelope: { type: string; data: { receipt: { decision: string } } } }>(
      "SELECT envelope FROM relay.delivered_event WHERE envelope->>'type' = $1",
      ['com.rezics.protection.work-correction-reviewed.v1'])).rows;
    expect(relayed).toHaveLength(1);
    expect(relayed[0]?.envelope.data.receipt.decision).toBe(approved.decision);

    const secondBasis = { ...basis, expectedHead: read.proposal.candidate,
      expectedProtection: protection.protectionRevision, expectedControl: after.controlHead,
      expectedControlEpoch: after.controlEpoch };
    const rejectedProposal = await json<{ proposalRevision: string }>(await call('POST', '/v1/work-title-corrections', {
      profile: 'work-title-correction-v1', ...secondBasis, title: 'Rejected suggestion', predecessor: null }), 201);
    const rejectedRead = await json<{ proposal: { candidateDigest: string } }>(await call('GET',
      `/v1/work-title-corrections/${rejectedProposal.proposalRevision.split('/').at(-1)}?actingSubject=${
        encodeURIComponent(actors[0])}`), 200);
    const rejectedPath = `/v1/work-title-corrections/${rejectedProposal.proposalRevision.split('/').at(-1)}/decisions`;
    const rejectBody = { ...review, expectedHead: secondBasis.expectedHead,
      expectedControl: secondBasis.expectedControl, expectedControlEpoch: secondBasis.expectedControlEpoch,
      candidateDigest: rejectedRead.proposal.candidateDigest, outcome: 'rejected' };
    expect((await json<{ reviewOutcome: string }>(await call('POST', rejectedPath, rejectBody,
      randomUUID(), 1), 201)).reviewOutcome).toBe('rejected');
    expect((await call('POST', rejectedPath, { ...rejectBody, outcome: 'approved' }, randomUUID(), 1)).status).toBe(409);
    const second = await json<{ proposalRevision: string }>(await call('POST', '/v1/work-title-corrections', {
      profile: 'work-title-correction-v1', ...secondBasis, title: 'Later proposal', predecessor: null }), 201);
    const secondRead = await json<{ proposal: { candidateDigest: string } }>(await call('GET',
      `/v1/work-title-corrections/${second.proposalRevision.split('/').at(-1)}?actingSubject=${
        encodeURIComponent(actors[0])}`), 200);
    const reviewScope = `work:review:${work}`;
    beforeReview = async () => {
      const epoch = (await pool.query<{ authority_epoch: string }>(
        'SELECT authority_epoch::text FROM access.scope_gate WHERE id = $1', [reviewScope])).rows[0]!.authority_epoch;
      expect(await strongRevokeWorkProtectionScope(environment, access, reviewScope, epoch))
        .toMatchObject({ status: 'complete', pending: 0 });
    };
    expect((await call('POST', `/v1/work-title-corrections/${second.proposalRevision.split('/').at(-1)}/decisions`, {
      ...review, expectedHead: secondBasis.expectedHead, expectedControl: secondBasis.expectedControl,
      expectedControlEpoch: secondBasis.expectedControlEpoch,
      candidateDigest: secondRead.proposal.candidateDigest }, randomUUID(), 1)).status).toBe(409);
    expect((await json<{ contentHead: string }>(await call('GET',
      `/v1/works/${work.split('/').at(-1)}/editorial-state?actingSubject=${encodeURIComponent(actors[0])}`), 200))
      .contentHead).toBe(read.proposal.candidate);

    await grant(0, `work:protect:${work}`, 'work.protection.relax');
    const relaxed = await json<{ protectionRevision: string }>(await call('POST', '/v1/work-title-protections', {
      ...protect, action: 'relax', expectedHead: read.proposal.candidate,
      expectedProtection: protection.protectionRevision, expectedControl: after.controlHead,
      expectedControlEpoch: after.controlEpoch }), 201);
    const titleState = await json<{ basis: { head: string; epoch: string; protection: string };
      contentHead: string }>(await call('GET', `/v1/works/${work.split('/').at(-1)}/title-control?actingSubject=${
        encodeURIComponent(actors[0])}`), 200);
    expect(titleState.basis.protection).toBe(relaxed.protectionRevision);
    const ordinaryEdit = await call('POST', '/v1/content-edits', { profile: 'metadata-only-v1', work,
      expectedHead: titleState.contentHead, titleControl: titleState.basis,
      title: 'Ordinary edit after relaxation', actingSubject: actors[0] });
    if (ordinaryEdit.status !== 200) console.error('ordinary edit after relax', ordinaryEdit.status, await ordinaryEdit.clone().json());
    expect(ordinaryEdit.status).toBe(200);
    const openState = await json<{ contentHead: string; protectionHead: string;
      controlHead: string; controlEpoch: string }>(await call('GET',
      `/v1/works/${work.split('/').at(-1)}/editorial-state?actingSubject=${encodeURIComponent(actors[0])}`), 200);
    await grant(0, `work:protect:${work}`, 'work.protection.confirm');
    const confirmed = await json<{ protectionRevision: string }>(await call('POST', '/v1/work-title-protections', {
      ...protect, action: 'confirm', expectedHead: openState.contentHead,
      expectedProtection: openState.protectionHead, expectedControl: openState.controlHead,
      expectedControlEpoch: openState.controlEpoch }), 201);
    const confirmedState = await json<{ contentHead: string; protectionHead: string;
      protectionMode: string; controlHead: string; controlEpoch: string }>(await call('GET',
      `/v1/works/${work.split('/').at(-1)}/editorial-state?actingSubject=${encodeURIComponent(actors[0])}`), 200);
    expect(confirmedState).toMatchObject({ contentHead: openState.contentHead,
      protectionHead: confirmed.protectionRevision, protectionMode: 'review-required',
      controlEpoch: String(BigInt(openState.controlEpoch) + 1n) });
    const costs: Array<{ queries: number; bytes: number; commandBytes: number }> = [];
    for (const size of [0, 4, 16]) {
      for (let i = 0; i < size; i++) await json(await call('POST', '/v1/works', {
        profile: 'metadata-only-v1', title: `Unrelated cost Work ${size}-${i}`, actingSubject: actors[0] }), 201);
      graphQueries = 0; graphReadBytes = 0; proposalCommandBytes = 0;
      await json(await call('POST', '/v1/work-title-corrections', {
        profile: 'work-title-correction-v1', ...basis, expectedHead: confirmedState.contentHead,
        expectedProtection: confirmedState.protectionHead, expectedControl: confirmedState.controlHead,
        expectedControlEpoch: confirmedState.controlEpoch, title: `Bounded proposal ${size}`,
        predecessor: null }), 201);
      costs.push({ queries: graphQueries, bytes: graphReadBytes, commandBytes: proposalCommandBytes });
    }
    expect(new Set(costs.map(cost => cost.queries)).size).toBe(1);
    expect(Math.max(...costs.map(cost => cost.bytes))).toBeLessThan(25_000);
    expect(Math.max(...costs.map(cost => cost.commandBytes))).toBeLessThan(30_000);
  } finally { await Promise.all([pool.end(), relayPool.end(), account.close()]); }
}, 180_000);
