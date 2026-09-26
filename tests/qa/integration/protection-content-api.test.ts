import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ContentCore, type VariantIdentity } from '../../../services/content/src/core.ts';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { sealContentProtectionAdmission } from '../../../services/main/src/modules/protection/admitted.ts';
import { ContentProtectionStore, type CorrectionDecisionInput, type CorrectionProposal }
  from '../../../services/main/src/modules/protection/content-store.ts';
import { PROTECTION_RULE } from '../../../services/main/src/modules/protection/schema.ts';
import { authorCreditFixture, nativeId } from '../fixtures/author-credit.ts';

test('SYS02/SYS11/SYS14: admitted Content protection and review through Account, Access and the Content owner', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through selected QA integration');
  const f = await authorCreditFixture(Bun.env as Record<string, string>, resolve('.temp', `protection-${randomUUID()}`));
  try {
    const owner = new ContentProtectionStore(f.pool);
    let hold: ((input: CorrectionDecisionInput) => Promise<void>) | undefined;
    const store = new Proxy(owner, { get(target, property) {
      if (property === 'decideCorrection') return async (input: CorrectionDecisionInput) => {
        const hook = hold; hold = undefined; if (hook) await hook(input);
        return target.decideCorrection(input);
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
    expect(await (await protect('confirm', null)).json()).toMatchObject({ code: 'authority_denied' });
    await f.grant(`content:protect:${resourceId}`, 'content.protection.confirm');
    const key = randomUUID();
    const confirmed = await protect('confirm', null, key);
    expect(confirmed.status).toBe(201);
    const protection = (await confirmed.json() as { value: { id: string } }).value.id;
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
    const approval = await decide('approved', reviewer, f.account.tokenB, approvalKey);
    expect(approval.status).toBe(201);
    const replay = await decide('approved', reviewer, f.account.tokenB, approvalKey);
    expect(replay.status).toBe(200);
    const [first, second] = [await approval.json() as Record<string, any>, await replay.json() as Record<string, any>];
    expect(second).toEqual({ ...first, replayed: true });
    expect(first.value).toMatchObject({ outcome: 'approved', application: { baseHead: head,
      successorHead: proposal.candidateRevision, protectionHead: protection } });
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
  } finally { await f.close(); }
}, 180_000);
