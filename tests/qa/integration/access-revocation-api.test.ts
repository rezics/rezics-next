import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { GraphTerminalProof } from '../../../services/main/src/modules/access/admission.ts';
import { governedWiki, iri, policyHarness, rule, type PolicyHarness } from './access-policy-harness.ts';

const revocations = '/v1/access/revocations';
type Revocation = { revocationId: string; state: string; affectedWork: number; pending: number;
  fenceAuthorityEpoch: string; replayed?: boolean; target: { generation: string } };

async function revocationBody(h: PolicyHarness, issuer: string, scope: string, kind: string, id: string,
  mode: 'ordinary' | 'strong', extra: Record<string, unknown> = {}) {
  return { profile: 'access-revocation-v1', revocationId: randomUUID(), issuerSubject: issuer, mode,
    scopeId: scope, expectedAuthorityEpoch: await h.fixture.epoch(scope),
    target: { kind, id, expectedGeneration: '0' }, ...extra };
}

async function revoke(h: PolicyHarness, issuer: string, scope: string, kind: string, id: string,
  mode: 'ordinary' | 'strong', extra: Record<string, unknown> = {}, key = randomUUID()) {
  const body = await revocationBody(h, issuer, scope, kind, id, mode, extra);
  return { body, key, response: await h.call('POST', revocations, h.managerToken, body, key) };
}

test('IAM07: strong revocation fences new admission and completes only after admitted command and private reads end', async () => {
  const h = await policyHarness();
  try {
    const owner = await h.fixture.agent();
    const a = await h.fixture.agent();
    const contribution = iri();
    const readScope = `contribution:read:${contribution}`;
    await h.q('INSERT INTO access.scope_gate (id) VALUES ($1)', [readScope]);
    await h.fixture.mandate(h.reader, a, 'work.create');
    await h.fixture.mandate(h.reader, a, 'contribution.read');
    await h.fixture.mandate(h.manager, owner, 'access.revoke');
    const commandGrant = await h.fixture.grant(owner, a, 'work:create:root', 'work.create');
    const readGrant = await h.fixture.grant(owner, a, readScope, 'contribution.read');
    const principal = { issuer: h.account.issuer, subject: h.account.b.id };
    const register = (key: string) => h.registry.register({ principal, actingSubject: a,
      scope: 'work:create:root', action: 'work.create', idempotencyKey: key,
      requestDigest: createHash('sha256').update(key).digest('hex') });
    const claimed = await register(`claimed-${randomUUID()}`);
    await h.registry.claim(claimed.id, claimed.requestDigest);
    const waiting = await register(`waiting-${randomUUID()}`);
    const idle = await h.registry.admitContributionSearchRead(principal, a, contribution);
    const sending = await h.registry.admitContributionSearchRead(principal, a, contribution);
    await h.registry.beginContributionSearchDelivery(sending.id, principal, a, contribution);
    const receipt = randomBytes(32).toString('hex');
    await h.registry.armContributionSearchSend(sending.id, receipt);

    // Denied, stale and unavailable requests change nothing.
    const reader = await h.call('POST', revocations, h.readerToken, await revocationBody(h, owner,
      'work:create:root', 'permission_grant', commandGrant, 'strong'));
    expect(reader.status).toBe(403);
    const stale = await revoke(h, owner, 'work:create:root', 'permission_grant', commandGrant, 'strong',
      { expectedAuthorityEpoch: '999' });
    expect([stale.response.status, stale.response.body.code]).toEqual([409, 'policy_stale']);
    await h.q('UPDATE access.recovery_fence SET open = false');
    expect((await revoke(h, owner, 'work:create:root', 'permission_grant', commandGrant, 'strong'))
      .response.status).toBe(503);
    await h.q('UPDATE access.recovery_fence SET open = true');
    expect((await h.q('SELECT active FROM access.permission_grant WHERE id = $1', [commandGrant])).rows[0])
      .toEqual({ active: true });

    // Command fence: in-flight admissions are fixed; nothing new is admitted after it.
    const command = await revoke(h, owner, 'work:create:root', 'permission_grant', commandGrant, 'strong');
    const fenced = command.response.body as Revocation;
    expect([command.response.status, fenced.state, fenced.affectedWork, fenced.pending])
      .toEqual([200, 'draining', 2, 2]);
    expect(await h.ok<Revocation>(h.call('POST', revocations, h.managerToken, command.body, command.key)))
      .toMatchObject({ revocationId: fenced.revocationId, replayed: true, state: 'draining' });
    const changedKey = await h.call('POST', revocations, h.managerToken,
      { ...command.body, mode: 'ordinary' }, command.key);
    expect([changedKey.status, changedKey.body.code]).toEqual([409, 'policy_key_conflict']);
    const again = await revoke(h, owner, 'work:create:root', 'permission_grant', commandGrant, 'strong',
      { target: { kind: 'permission_grant', id: commandGrant, expectedGeneration: '1' } });
    expect(again.response.status).toBe(409);
    await expect(register(`after-${randomUUID()}`)).rejects.toThrow();
    await expect(h.registry.claim(waiting.id, waiting.requestDigest)).rejects.toThrow();
    const read = (id: string) => h.ok<Revocation>(h.call('GET',
      `${revocations}/${id}?issuerSubject=${encodeURIComponent(owner)}`, h.managerToken));
    expect(await read(fenced.revocationId)).toMatchObject({ state: 'draining', pending: 2 });
    const outcome = (admission: typeof claimed, result: 'succeeded' | 'cancelled'): GraphTerminalProof => ({
      outcome: result, admissionId: admission.id, requestDigest: admission.requestDigest,
      authorityEpoch: admission.authorityEpoch, scope: 'work:create:root', dataEpoch: 'fixture-epoch',
      sequence: '7', receipt: `urn:rezics:receipt:${createHash('sha256')
        .update(`${admission.id}\0create-metadata-work`).digest('hex')}` });
    // The command admitted before the fence may finish within its contract.
    await h.registry.recordGraphOutcome(claimed.id, outcome(claimed, 'succeeded'));
    expect(await read(fenced.revocationId)).toMatchObject({ state: 'draining', pending: 1 });
    await h.registry.recordGraphOutcome(waiting.id, outcome(waiting, 'cancelled'));
    expect(await read(fenced.revocationId)).toMatchObject({ state: 'completed', pending: 0 });

    // Search fence: undelivered reads abort at the fence; a sent read stays pending
    // until its matched receipt, even though no new read or delivery is admitted.
    const search = await revoke(h, owner, readScope, 'permission_grant', readGrant, 'strong');
    const readFence = search.response.body as Revocation;
    expect([readFence.state, readFence.affectedWork, readFence.pending]).toEqual(['draining', 2, 1]);
    await expect(h.registry.beginContributionSearchDelivery(idle.id, principal, a, contribution)).rejects.toThrow();
    await expect(h.registry.admitContributionSearchRead(principal, a, contribution)).rejects.toThrow();
    expect(await read(readFence.revocationId)).toMatchObject({ state: 'draining', pending: 1 });
    await h.registry.finishContributionSearchRead(sending.id, 'delivered', receipt);
    expect(await read(readFence.revocationId)).toMatchObject({ state: 'completed', pending: 0 });
    const leases = await h.q(`SELECT id, state FROM access.search_read_lease WHERE id = ANY($1) ORDER BY id`,
      [[idle.id, sending.id]]);
    expect(Object.fromEntries(leases.rows.map(row => [row.id, row.state])))
      .toEqual({ [idle.id]: 'aborted', [sending.id]: 'delivered' });

    // Ordinary revocation only fences later admission and reports no drain.
    const later = await h.fixture.grant(owner, a, 'work:create:root', 'work.create');
    const pendingAdmission = await register(`ordinary-${randomUUID()}`);
    const ordinary = await revoke(h, owner, 'work:create:root', 'permission_grant', later, 'ordinary');
    expect(ordinary.response.body).toMatchObject({ state: 'completed', affectedWork: 0, pending: 0 });
    expect((await h.q('SELECT state FROM access.admission WHERE id = $1', [pendingAdmission.id])).rows[0])
      .toEqual({ state: 'registered' });
  } finally { await h.close(); }
}, 180_000);

test('IAM29: revoking one of two independent grants keeps the other source and its provenance under mandatory guards', async () => {
  const h = await policyHarness();
  try {
    const wiki = await governedWiki(h);
    const a = await h.fixture.agent();
    const mandate = await h.fixture.mandate(h.reader, a, 'work.edit');
    await h.fixture.mandate(h.manager, wiki.owner, 'access.revoke');
    await h.fixture.mandate(h.manager, a, 'access.revoke');
    const grants = [await h.fixture.grant(wiki.owner, a, wiki.scope, 'work.edit'),
      await h.fixture.grant(wiki.owner, a, wiki.scope, 'work.edit')].sort();
    await wiki.published([rule.guard({ op: 'authenticated' }), rule.guard({ op: 'represents' })],
      [rule.allow({ op: 'has-grant', action: 'work.edit' })]);
    const both = await wiki.decide(a);
    expect([both.result, both.sources.map(source => source.id)]).toEqual(['allow', grants]);
    const first = await revoke(h, wiki.owner, wiki.scope, 'permission_grant', grants[0]!, 'ordinary');
    expect((first.response.body as Revocation).target.generation).toBe('1');
    const remaining = await wiki.decide(a);
    expect([remaining.result, remaining.sources]).toEqual(['allow',
      [{ kind: 'permission_grant', id: grants[1], generation: '0' }]]);
    const rows = await h.q('SELECT id, active, generation FROM access.permission_grant WHERE id = ANY($1) ORDER BY id',
      [grants]);
    expect(rows.rows).toEqual([{ id: grants[0], active: false, generation: '1' },
      { id: grants[1], active: true, generation: '0' }]);
    const inputs = await h.q(`SELECT kind, permission_grant_id FROM access.decision_snapshot_input
      WHERE decision_id = $1 AND role = 'proof'`, [remaining.decisionId]);
    expect(inputs.rows).toEqual([{ kind: 'permission_grant', permission_grant_id: grants[1] }]);
    // The surviving grant still cannot bypass the mandatory representation guard.
    const guard = await revoke(h, a, wiki.scope, 'representation', mandate, 'ordinary');
    expect(guard.response.status).toBe(200);
    const guarded = await wiki.decide(a);
    expect([guarded.result, guarded.sources]).toEqual(['deny', []]);
    expect((await h.q('SELECT active FROM access.permission_grant WHERE id = $1', [grants[1]])).rows[0])
      .toEqual({ active: true });

    // A protected work.create admission also selects the surviving independent
    // source. Its saved provenance cannot silently switch to the second grant.
    await h.fixture.mandate(h.reader, a, 'work.create');
    const writeGrants = [await h.fixture.grant(wiki.owner, a, 'work:create:root', 'work.create'),
      await h.fixture.grant(wiki.owner, a, 'work:create:root', 'work.create')].sort();
    const registerWrite = async () => {
      const key = `independent-${randomUUID()}`;
      const admission = await h.registry.register({
        principal: { issuer: h.account.issuer, subject: h.account.b.id },
        actingSubject: a, scope: 'work:create:root', action: 'work.create', idempotencyKey: key,
        requestDigest: createHash('sha256').update(key).digest('hex'),
      });
      expect(admission.dispatchEligible).toBe(true);
      return admission;
    };
    const firstWrite = await registerWrite();
    expect((await h.q('SELECT represented_grant_id FROM access.admission WHERE id = $1',
      [firstWrite.id])).rows[0]).toEqual({ represented_grant_id: writeGrants[0] });
    expect((await revoke(h, wiki.owner, 'work:create:root', 'permission_grant', writeGrants[0]!,
      'ordinary')).response.status).toBe(200);
    const secondWrite = await registerWrite();
    expect((await h.q('SELECT represented_grant_id FROM access.admission WHERE id = $1',
      [secondWrite.id])).rows[0]).toEqual({ represented_grant_id: writeGrants[1] });
    expect((await h.registry.register({
      principal: { issuer: h.account.issuer, subject: h.account.b.id }, actingSubject: a,
      scope: 'work:create:root', action: 'work.create', idempotencyKey: firstWrite.idempotencyKey,
      requestDigest: firstWrite.requestDigest,
    })).dispatchEligible).toBe(false);

    // Cost contract: a decision and an ordinary revocation keep constant owner
    // calls, selected rows and writes as unrelated grants, sets and frames grow.
    const other = await h.fixture.agent();
    const b = await h.fixture.agent();
    await h.fixture.mandate(h.reader, b, 'work.edit');
    const measured: { decision: typeof h.costs; revocation: typeof h.costs; publish: typeof h.costs }[] = [];
    for (const size of [0, 32, 256]) {
      if (size) {
        await h.q(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id,
            action, valid_until) SELECT gen_random_uuid(), $1, $2, $3, 'work.edit', now() + interval '1 hour'
          FROM generate_series(1, $4)`, [wiki.owner, other, wiki.scope, size]);
        await h.q('ANALYZE access.permission_grant');
      }
      const target = await h.fixture.grant(wiki.owner, b, wiki.scope, 'work.edit');
      Object.assign(h.costs, { calls: 0, rows: 0, writes: 0 });
      expect((await wiki.decide(b)).result).toBe('allow');
      const decision = { ...h.costs };
      Object.assign(h.costs, { calls: 0, rows: 0, writes: 0 });
      expect((await revoke(h, wiki.owner, wiki.scope, 'permission_grant', target, 'ordinary')).response.status)
        .toBe(200);
      const revocation = { ...h.costs };
      Object.assign(h.costs, { calls: 0, rows: 0, writes: 0 });
      await wiki.published([rule.guard({ op: 'authenticated' }), rule.guard({ op: 'represents' })],
        [rule.allow({ op: 'has-grant', action: 'work.edit' })]);
      measured.push({ decision, revocation, publish: { ...h.costs } });
    }
    expect(measured[1]).toEqual(measured[0]);
    expect(measured[2]).toEqual(measured[0]);
    expect(measured[0]!.decision.calls).toBeLessThanOrEqual(20);
    expect(measured[0]!.decision.writes).toBeLessThanOrEqual(8);
    expect(measured[0]!.revocation.calls).toBeLessThanOrEqual(20);
    expect(measured[0]!.revocation.writes).toBe(4);
    expect(measured[0]!.publish.calls).toBeLessThanOrEqual(20);
    // Epoch, revision, three rules, head advance and receipt.
    expect(measured[0]!.publish.writes).toBe(7);
    const plan = JSON.stringify((await h.q(`EXPLAIN (FORMAT JSON) SELECT id, generation FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'work.edit' AND active
        AND valid_until > now()`, [b, wiki.scope])).rows);
    expect(plan).toContain('permission_grant_active_lookup');
  } finally { await h.close(); }
}, 180_000);
