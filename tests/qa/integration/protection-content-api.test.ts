import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore, type VariantIdentity } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { sealContentProtectionAdmission, strongRevokeProtectionScope }
  from '../../../services/main/src/modules/protection/admitted.ts';
import { protectionReceiptIri } from '../../../services/main/src/modules/protection/receipt-family.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { ContentProtectionStore, type CorrectionDecisionInput, type CorrectionProposal }
  from '../../../services/main/src/modules/protection/content-store.ts';
import { PROTECTION_RULE } from '../../../services/main/src/modules/protection/schema.ts';
import { ratingAccount } from '../support/rating-account.ts';

const nativeId = () => `https://rezics.com/id/${randomUUID()}`;

async function protectionFixture(apps: Record<string, string>) {
  const account = await ratingAccount(apps, 'openid work:read content:protect content:correct content:review');
  const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
  const pool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
  await migrateContent(pool);
  const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
  const env = { fuseki, lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! },
    objectDirectory: resolve('.temp', `protection-${randomUUID()}`) };
  const access = new AccessAdmissionRegistry(accessPool, apps.FUSEKI_TITLE_ADMISSION_KEY);
  const principalId = randomUUID(), otherPrincipalId = randomUUID(), actor = nativeId();
  await accessPool.query(`INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3),($4,$2,$5)`,
    [principalId, account.issuer, account.a.id, otherPrincipalId, account.b.id]);
  await accessPool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [actor]);
  const grant = async (scope: string, action: string) => {
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await accessPool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), principalId, actor, action]);
    await accessPool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
  };
  const close = async () => { await Promise.all([pool.end(), accessPool.end(), account.close()]); };
  return { account, accessPool, pool, env, access, actor, grant, close };
}

test('SYS02/SYS11/SYS14: admitted Content protection and review through Account, Access and the Content owner', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through selected QA integration');
  const f = await protectionFixture(Bun.env as Record<string, string>);
  try {
    const owner = new ContentProtectionStore(f.pool);
    let hold: ((input: CorrectionDecisionInput) => Promise<void>) | undefined;
    let loseDecision = false;
    let missingReceiptFor: string | null = null;
    let decisionDispatches = 0;
    const store = new Proxy(owner, { get(target, property) {
      if (property === 'readReceipt') return async (operationId: string) => operationId === missingReceiptFor
        ? null : target.readReceipt(operationId);
      if (property === 'decideCorrection') return async (input: CorrectionDecisionInput) => {
        decisionDispatches++;
        const hook = hold; hold = undefined; if (hook) await hook(input);
        const result = await target.decideCorrection(input);
        if (loseDecision) { loseDecision = false; throw new Error('lost Content acknowledgement'); }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const dependencies: MainWorkDependencies & { editorialProtection: ContentProtectionStore } = {
      environment: f.env, account: f.account.verifier, access: f.access, editorialProtection: store };
    const app = createMainApp(f.env.fuseki, dependencies);
    const call = (method: string, path: string, body?: object, key = randomUUID(), token = f.account.tokenA) =>
      app.handle(new Request(`http://main.local${path}`, { method, headers: { authorization: `Bearer ${token}`,
        'idempotency-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) }));

    // A second principal reviews through its own Agent; grants name distinct actions.
    const reviewerPrincipal = (await f.accessPool.query<{ id: string }>(
      'SELECT id FROM access.principal WHERE account_subject = $1', [f.account.b.id])).rows[0]!.id;
    const reviewer = nativeId();
    await f.accessPool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [reviewer]);
    const grantTo = async (principal: string, subject: string, scope: string, action: string) => {
      await f.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await f.accessPool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), principal, subject, action]);
      await f.accessPool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), subject, scope, action]);
    };

    const resourceId = nativeId();
    const variant: VariantIdentity = { id: `urn:rezics:variant:${randomUUID()}`, resourceId,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' };
    const content = new ContentCore(f.pool);
    const head = (await content.saveDraft({ operationId: `seed-${randomUUID()}`, variant, expectedHead: null,
      model: 'content-shape-v1', sourceRevision: null, provenance: { editor: 'fixture' },
      serializedJson: JSON.stringify({ body: 'Original synopsis' }) })).revisionId!;
    const target = { resourceId, variantId: variant.id };
    const protect = (action: string, expectedProtectionHead: string | null, key?: string, token?: string) =>
      call('POST', '/v1/editorial-protections', { profile: 'content-draft-protection-v1', ...target, action,
        actingSubject: f.actor, expectedContentHead: head, expectedProtectionHead, expectedRuleRevision: PROTECTION_RULE,
        reason: 'Repeated vandalism', evidence: ['urn:rezics:evidence:report-1'] }, key, token);

    await f.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [`content:protect:${resourceId}`]);
    expect((await protect('confirm', null, undefined, 'invalid')).status).toBe(401);
    expect((await protect('confirm', null, undefined, f.account.noScope)).status).toBe(401);
    expect(await (await protect('confirm', null)).json()).toMatchObject({ code: 'authority_denied' });
    await f.grant(`content:protect:${resourceId}`, 'content.protection.confirm');
    const key = randomUUID();
    const confirmed = await protect('confirm', null, key);
    expect(confirmed.status).toBe(201);
    const confirmedBody = await confirmed.json() as { operation: string; value: { id: string };
      position: { dataEpoch: string; sequence: string } };
    const protection = confirmedBody.value.id;
    const protectionAdmission = confirmedBody.operation.split(':').at(-1)!;
    const sealedProtection = (await f.accessPool.query<{ state: string; graph_receipt: string;
      graph_data_epoch: string; graph_sequence: string }>(`SELECT state, graph_receipt, graph_data_epoch,
        graph_sequence FROM access.admission WHERE id = $1`, [protectionAdmission])).rows[0]!;
    expect(sealedProtection).toEqual({ state: 'sealed',
      graph_receipt: protectionReceiptIri(protectionAdmission, 'content.protection.confirm'),
      graph_data_epoch: confirmedBody.position.dataEpoch, graph_sequence: confirmedBody.position.sequence });
    // Same key replays; the same key with another intent never rewrites the recorded request.
    expect(await (await protect('confirm', null, key)).json()).toMatchObject({ value: { id: protection }, replayed: true });
    expect(await (await call('POST', '/v1/editorial-protections', { profile: 'content-draft-protection-v1', ...target,
      action: 'confirm', actingSubject: f.actor, expectedContentHead: head, expectedProtectionHead: null,
      expectedRuleRevision: PROTECTION_RULE, reason: 'Another reason', evidence: [] }, key)).json())
      .toMatchObject({ code: 'idempotency_conflict' });
    expect(await (await protect('confirm', null)).json()).toMatchObject({ code: 'stale_protection' });
    // Relaxation is a distinct capability; confirm authority does not grant it.
    expect(await (await protect('relax', protection)).json()).toMatchObject({ code: 'authority_denied' });
    // The unchanged draft writer fails closed at the owner.
    await expect(content.saveDraft({ operationId: `bypass-${randomUUID()}`, variant, expectedHead: head,
      model: 'content-shape-v1', sourceRevision: null, provenance: { editor: 'fixture' },
      serializedJson: '{"body":"vandal"}' })).rejects.toMatchObject({ constraint: 'variant_correction_required' });

    await f.grant(`content:correct:${resourceId}`, 'content.correction.propose');
    const proposed = await call('POST', '/v1/corrections', { profile: 'content-draft-correction-v1', ...target,
      body: 'Corrected synopsis', predecessor: null, actingSubject: f.actor, expectedContentHead: head,
      expectedProtectionHead: protection, expectedRuleRevision: PROTECTION_RULE, reason: 'Wrong year',
      evidence: ['urn:rezics:evidence:edition'] });
    expect(proposed.status).toBe(201);
    const proposal = (await proposed.json() as { value: CorrectionProposal }).value;
    const decide = (outcome: 'approved' | 'rejected', subject: string, token: string, decisionKey?: string) =>
      call('POST', `/v1/corrections/${proposal.proposalRevision}/decisions`, { profile: 'content-draft-correction-decision-v1',
        outcome, expectedCandidateDigest: proposal.candidateDigest, expectedDecisionHead: null, actingSubject: subject,
        expectedContentHead: head, expectedProtectionHead: protection, expectedRuleRevision: PROTECTION_RULE,
        reason: 'Checked against the edition', evidence: [] }, decisionKey, token);
    // The proposer holds review authority too, but is not independent of the proposal.
    await f.grant(`content:review:${resourceId}`, 'content.correction.review');
    expect(await (await decide('approved', f.actor, f.account.tokenA)).json()).toMatchObject({ code: 'reviewer_not_independent' });
    await grantTo(reviewerPrincipal, reviewer, `content:review:${resourceId}`, 'content.correction.review');

    // A delayed approval loses to a terminal cancellation of its own identity.
    const delayedKey = randomUUID();
    hold = async input => {
      await sealContentProtectionAdmission(owner, { action: 'content.correction.review',
        id: input.operationId.split(':').at(-1)!, requestDigest: input.requestDigest } as RegisteredAdmission);
    };
    expect(await (await decide('approved', reviewer, f.account.tokenB, delayedKey)).json()).toMatchObject({ code: 'cancelled' });
    expect(await (await decide('approved', reviewer, f.account.tokenB, delayedKey)).json()).toMatchObject({ code: 'cancelled' });

    // Lost response: the committed approval replays by key; a new key has no second effect.
    const approvalKey = randomUUID();
    loseDecision = true;
    const approval = await decide('approved', reviewer, f.account.tokenB, approvalKey);
    expect(approval.status).toBe(200);
    const replay = await decide('approved', reviewer, f.account.tokenB, approvalKey);
    expect(replay.status).toBe(200);
    const [first, second] = [await approval.json() as Record<string, any>, await replay.json() as Record<string, any>];
    expect(second).toEqual({ ...first, replayed: true });
    expect(first.replayed).toBe(true);
    expect(first.value).toMatchObject({ outcome: 'approved', application: { baseHead: head,
      successorHead: proposal.candidateRevision, protectionHead: protection } });
    const decisionAdmission = String(first.operation).split(':').at(-1)!;
    expect((await f.accessPool.query<{ state: string; graph_receipt: string }>(
      'SELECT state, graph_receipt FROM access.admission WHERE id = $1', [decisionAdmission])).rows[0])
      .toEqual({ state: 'sealed', graph_receipt: protectionReceiptIri(decisionAdmission, 'content.correction.review') });
    expect((await decide('rejected', reviewer, f.account.tokenB, approvalKey)).status).toBe(409);
    expect((await f.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM content.correction_application WHERE proposal_revision = $1',
      [proposal.proposalRevision])).rows[0]!.count).toBe('1');
    // A restored Content cut without this receipt cannot execute a sealed Access
    // intent again. The route reports pending until the recovery frontier settles.
    missingReceiptFor = String(first.operation);
    const beforeOldRetry = decisionDispatches;
    expect(await (await decide('approved', reviewer, f.account.tokenB, approvalKey)).json())
      .toEqual({ operationId: first.operation, status: 'reconciling' });
    expect(decisionDispatches).toBe(beforeOldRetry);
    missingReceiptFor = null;
    expect(await (await decide('rejected', reviewer, f.account.tokenB)).json()).toMatchObject({ code: 'decision_exists' });

    // Reads apply current read authority; each state entry keeps its own availability.
    const path = `/v1/corrections/${proposal.proposalRevision}?actingSubject=${encodeURIComponent(f.actor)}`;
    expect((await call('GET', path)).status).toBe(404);
    await f.grant(`work:read:${resourceId}`, 'work.read');
    expect(await (await call('GET', path)).json()).toMatchObject({ proposal: { proposalRevision: proposal.proposalRevision },
      decision: { outcome: 'approved' }, candidateAvailable: true });
    const hidden = { resourceId: nativeId(), variantId: `urn:rezics:variant:${randomUUID()}` };
    expect(await (await call('POST', '/v1/editorial-state-queries', { actingSubject: f.actor, targets: [target, hidden] })).json())
      .toEqual({ items: [{ ...target, availability: 'available', state: { ...target, contentHead: proposal.candidateRevision,
        protection: { id: protection, epoch: '1', action: 'confirm', mode: 'review-required', ruleRevision: PROTECTION_RULE },
        effectiveMode: 'review-required', ruleRevision: PROTECTION_RULE } }, { ...hidden, availability: 'unavailable' }] });
    const list = await (await call('GET', `/v1/corrections?target=${encodeURIComponent(variant.id)}&resourceId=${
      encodeURIComponent(resourceId)}&actingSubject=${encodeURIComponent(f.actor)}`)).json() as { items: unknown[]; next: null };
    expect(list).toMatchObject({ items: [{ proposalRevision: proposal.proposalRevision }], next: null });
    const repeated = await (await call('POST', '/v1/editorial-state-queries', {
      actingSubject: f.actor, targets: [target, target],
    })).json() as { items: Array<{ state: { contentHead: string } }> };
    expect(repeated.items).toHaveLength(2);
    expect(repeated.items.map(item => item.state.contentHead)).toEqual([proposal.candidateRevision, proposal.candidateRevision]);
    const wrongTarget = Buffer.from(JSON.stringify({ target: hidden.variantId,
      createdAt: new Date().toISOString(), id: proposal.proposalRevision })).toString('base64url');
    expect((await call('GET', `/v1/corrections?target=${encodeURIComponent(variant.id)}&resourceId=${
      encodeURIComponent(resourceId)}&actingSubject=${encodeURIComponent(f.actor)}&cursor=${wrongTarget}`)).status).toBe(400);

    // A delayed review loses to strong Access scope closure. The Content receipt
    // and Access terminal proof agree, and the protected head stays adopted.
    const secondResponse = await call('POST', '/v1/corrections', { profile: 'content-draft-correction-v1', ...target,
      body: 'Another suggestion', predecessor: null, actingSubject: f.actor,
      expectedContentHead: proposal.candidateRevision, expectedProtectionHead: protection,
      expectedRuleRevision: PROTECTION_RULE, reason: 'New evidence', evidence: [] });
    expect(secondResponse.status).toBe(201);
    const secondProposal = (await secondResponse.json() as { value: CorrectionProposal }).value;
    hold = async () => {
      const scope = `content:review:${resourceId}`;
      const epoch = (await f.accessPool.query<{ authority_epoch: string }>(
        'SELECT authority_epoch::text FROM access.scope_gate WHERE id = $1', [scope])).rows[0]!.authority_epoch;
      expect(await strongRevokeProtectionScope(f.access, owner, scope, epoch))
        .toMatchObject({ status: 'complete', pending: 0 });
    };
    const fencedDecision = await call('POST', `/v1/corrections/${secondProposal.proposalRevision}/decisions`, {
      profile: 'content-draft-correction-decision-v1', outcome: 'approved',
      expectedCandidateDigest: secondProposal.candidateDigest, expectedDecisionHead: null,
      actingSubject: reviewer, expectedContentHead: proposal.candidateRevision,
      expectedProtectionHead: protection, expectedRuleRevision: PROTECTION_RULE,
      reason: 'Review before closure', evidence: [],
    }, randomUUID(), f.account.tokenB);
    expect(fencedDecision.status).toBe(403);
    expect(await fencedDecision.json()).toMatchObject({ code: 'cancelled' });
    expect((await owner.editorialStates([variant.id]))[0]).toMatchObject({
      contentHead: proposal.candidateRevision, protection: { id: protection } });

    // Owner events share the Content outbox but have a distinct recipe. The
    // projection relay acknowledges them in sequence without treating them as
    // publication candidates or blocking later Content events.
    const highWater = await content.ownerPosition();
    const events = await content.readOutbox(highWater.dataEpoch, '0', 50);
    expect(events.filter(event => event.eventType.startsWith('content.protection.')
      || event.eventType.startsWith('content.correction.')).length).toBeGreaterThan(0);
    expect(events.filter(event => event.eventType.startsWith('content.protection.')
      || event.eventType.startsWith('content.correction.')).every(event => event.recipe === 'editorial-protection-v1'))
      .toBe(true);
    const cursor = new ContentProjectionCursor(f.pool);
    const consumer = `protection-${randomUUID()}`;
    await cursor.initialize(consumer);
    for (let i = 0; i < events.length; i++) {
      expect(await relayContentProjectionOnce(f.env, content, cursor, consumer)).toMatchObject({ disposition: 'ignored' });
    }
    expect((await cursor.read(consumer)).sequence).toBe(highWater.sequence);
  } finally { await f.close(); }
}, 180_000);
