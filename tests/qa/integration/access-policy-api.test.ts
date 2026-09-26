import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import {
  governedWiki, memberOf, policyHarness, realm, rule, type PolicyHarness,
} from './access-policy-harness.ts';

const changes = '/v1/access/policy-changes';
const snapshot = (h: PolicyHarness, id: string | null) => h.q(`SELECT outcome, reason, policy_revision,
    deciding_rule_id, rule_trace FROM access.decision_snapshot WHERE id = $1`, [id])
  .then(result => result.rows[0] as { outcome: string; reason: string; policy_revision: string;
    deciding_rule_id: string | null });

test('IAM15/IAM16/IAM19: wiki policy revisions exclude Realm sets by basis, follow reorder and keep references purpose-bound', async () => {
  const h = await policyHarness();
  try {
    const wiki = await governedWiki(h);
    const [x, y] = [await realm(h), await realm(h)];
    const [a, b] = [await h.fixture.agent(), await h.fixture.agent()];
    const mandates: Record<string, string> = {};
    for (const agent of [a, b]) {
      mandates[agent] = await h.fixture.mandate(h.reader, agent, 'work.edit');
      await h.fixture.grant(wiki.owner, agent, wiki.scope, 'work.edit');
    }
    await h.fixture.agentMember('realm', y, a);

    // Template write: only the set owner's representative admits a reference.
    const denied = await h.call('POST', changes, h.readerToken, { profile: 'access-policy-change-v1',
      action: 'admit-set', issuerSubject: x, expectedAuthorityEpoch: await h.fixture.epoch(wiki.scope),
      setAdmissionId: randomUUID(), setKind: 'realm', basis: 'authenticated_principal',
      referencingScopeId: wiki.scope, purpose: 'resource-exclusion',
      validUntil: new Date(Date.now() + 3_600_000).toISOString() });
    expect([denied.status, denied.body.code]).toEqual([403, 'policy_denied']);
    const principalX = await wiki.admit(x, 'authenticated_principal');
    const actorY = await wiki.admit(y, 'acting_subject');
    const guards = [rule.guard({ op: 'authenticated' }), rule.guard({ op: 'represents' })];
    const exclusionX = rule.deny(memberOf(principalX, 'authenticated_principal'));
    const exclusionY = rule.deny(memberOf(actorY, 'acting_subject'));
    const grantAllow = rule.allow({ op: 'has-grant', action: 'work.edit' }, ['work.edit']);
    const noManage = await h.account.tokenFor(h.account.a, 'openid work:read');
    const firstBody = await wiki.body(guards, [exclusionX, exclusionY, grantAllow]);
    expect((await h.call('POST', changes, noManage, firstBody)).status).toBe(401);
    const key = randomUUID();
    const first = await h.ok<{ revision: string; authorityEpoch: string; replayed: boolean }>(
      h.call('POST', changes, h.managerToken, firstBody, key));
    expect([first.revision, first.replayed]).toEqual(['1', false]);
    wiki.advance(first.revision);
    expect(await h.ok(h.call('POST', changes, h.managerToken, firstBody, key)))
      .toMatchObject({ revision: '1', authorityEpoch: first.authorityEpoch, replayed: true });
    const changed = await h.call('POST', changes, h.managerToken, { ...firstBody, ordered: [grantAllow] }, key);
    expect([changed.status, changed.body.code]).toEqual([409, 'policy_key_conflict']);
    const stale = await h.call('POST', changes, h.managerToken, firstBody);
    expect([stale.status, stale.body.code]).toEqual([409, 'policy_stale']);

    // IAM15: the acting-subject exclusion follows only the selected Agent; the
    // principal exclusion follows the Account across every Agent it selects.
    expect((await wiki.decide(a)).result).toBe('deny');
    const allowedB = await wiki.decide(b);
    expect([allowedB.result, allowedB.policyRevision]).toEqual(['allow', '1']);
    expect((await wiki.decide(null)).result).toBe('deny');
    await h.fixture.principalMember('realm', x, h.reader);
    const switched = await Promise.all([wiki.decide(a), wiki.decide(b)]);
    expect(switched.map(decision => decision.result)).toEqual(['deny', 'deny']);
    expect(await snapshot(h, switched[1]!.decisionId)).toMatchObject({ outcome: 'deny',
      reason: 'rule-deny', deciding_rule_id: exclusionX.ruleId, policy_revision: '1' });
    const inputs = await h.q(`SELECT kind, observed FROM access.decision_snapshot_input
      WHERE decision_id = $1 ORDER BY ordinal`, [switched[1]!.decisionId]);
    expect(inputs.rows).toContainEqual({ kind: 'private_membership', observed: 'present' });

    // IAM16: moving the exception ahead of the exclusion changes meaning only by revision.
    const exception = rule.allow({ op: 'subject-is', subject: b });
    await wiki.published(guards, [exception, exclusionX, exclusionY, grantAllow]);
    const excepted = await wiki.decide(b);
    expect([excepted.result, excepted.policyRevision]).toEqual(['allow', '2']);
    expect((await wiki.decide(a)).result).toBe('deny');
    await h.q('UPDATE access.representation SET active = false WHERE id = $1', [mandates[b]]);
    const guarded = await wiki.decide(b);
    expect(guarded.result).toBe('deny');
    expect(await snapshot(h, guarded.decisionId)).toMatchObject({ reason: 'mandatory-guard-failed' });
    await h.fixture.mandate(h.reader, b, 'work.edit');
    expect((await wiki.decide(b)).result).toBe('allow');
    await wiki.published(guards, [exclusionX, exception, exclusionY, grantAllow]);
    const reordered = await wiki.decide(b);
    expect([reordered.result, reordered.policyRevision]).toEqual(['deny', '3']);
    expect(await snapshot(h, reordered.decisionId)).toMatchObject({ deciding_rule_id: exclusionX.ruleId });
    const readRevision = (revision: string, token = h.managerToken) => h.call('GET',
      `/v1/access/policies/${wiki.policyId}/revisions/${revision}?issuerSubject=${encodeURIComponent(wiki.owner)}`,
      token);
    const revisionTwo = await h.ok<{ ordered: { ruleId: string }[]; combiningAlgorithm: string;
      references: unknown[] }>(readRevision('2'));
    expect(revisionTwo.ordered.map(item => item.ruleId)).toEqual([exception.ruleId, exclusionX.ruleId,
      exclusionY.ruleId, grantAllow.ruleId]);
    expect([revisionTwo.combiningAlgorithm, revisionTwo.references.length]).toEqual(['first-applicable', 2]);
    expect((await h.ok<{ ordered: { ruleId: string }[] }>(readRevision('3'))).ordered[1]!.ruleId)
      .toBe(exception.ruleId);
    expect((await readRevision('3', h.readerToken)).status).toBe(403);

    // IAM19: a private set reference is admitted for one scope and purpose. Every
    // unusable reference gets the same answer, and decisions carry no reasons.
    const other = await governedWiki(h);
    const refusals = await Promise.all([
      other.publish(guards, [rule.deny(memberOf(principalX, 'authenticated_principal'))]),
      wiki.publish(guards, [rule.allow(memberOf(principalX, 'authenticated_principal'))]),
      wiki.publish(guards, [rule.deny(memberOf(randomUUID(), 'authenticated_principal'))]),
    ]);
    expect(refusals.map(refusal => refusal.status)).toEqual([409, 409, 409]);
    expect(new Set(refusals.map(refusal => JSON.stringify(refusal.body))).size).toBe(1);
    expect(refusals[0]!.body.code).toBe('policy_reference_not_admitted');
    const eligibility = await other.admit(x, 'authenticated_principal', 'resource-eligibility');
    await other.published(guards, [rule.allow(memberOf(eligibility, 'authenticated_principal'))]);
    expect(Object.keys(reordered).sort()).toEqual(['authorityEpoch', 'decisionId', 'expiresAt',
      'policyId', 'policyRevision', 'profile', 'result', 'reusable', 'sources']);
    const probe = await h.call('POST', '/v1/access/policy-decisions', h.managerToken, {
      profile: 'access-policy-decision-v1', scopeId: wiki.scope, action: 'work.edit', actingSubject: null,
      principal: h.reader });
    expect(probe.status).toBe(400);
    // Withdrawing the admission makes members and non-members equally unavailable.
    const outsider = await h.fixture.agent();
    await h.fixture.mandate(h.manager, outsider, 'work.edit');
    await h.fixture.grant(wiki.owner, outsider, wiki.scope, 'work.edit');
    expect((await wiki.decide(outsider, 'work.edit', h.managerToken)).result).toBe('allow');
    await wiki.revokeSet(x, principalX);
    expect([(await wiki.decide(b)).result, (await wiki.decide(outsider, 'work.edit', h.managerToken)).result])
      .toEqual(['unavailable', 'unavailable']);

    // Recovery and lock fences return unavailable rather than a decision or change.
    await h.q('UPDATE access.recovery_fence SET open = false');
    expect((await h.call('POST', '/v1/access/policy-decisions', h.readerToken, {
      profile: 'access-policy-decision-v1', scopeId: wiki.scope, action: 'work.edit',
      actingSubject: b })).status).toBe(503);
    expect((await wiki.publish(guards, [grantAllow])).status).toBe(503);
    await h.q('UPDATE access.recovery_fence SET open = true');
    const holder = await h.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM access.scope_gate WHERE id = $1 FOR UPDATE', [wiki.scope]);
      expect((await wiki.publish(guards, [grantAllow])).status).toBe(503);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  } finally { await h.close(); }
}, 180_000);

test('IAM17/IAM22: unresolved or over-budget evidence stops first-applicable evaluation without weakening guards', async () => {
  const h = await policyHarness();
  try {
    const wiki = await governedWiki(h);
    const x = await realm(h);
    const [a, b, outsider] = [await h.fixture.agent(), await h.fixture.agent(), await h.fixture.agent()];
    for (const agent of [a, b]) {
      await h.fixture.mandate(h.reader, agent, 'work.edit');
      await h.fixture.mandate(h.reader, agent, 'work.read');
      await h.fixture.grant(wiki.owner, agent, wiki.scope, 'work.edit');
    }
    await h.fixture.mandate(h.manager, outsider, 'work.edit');
    await h.fixture.grant(wiki.owner, outsider, wiki.scope, 'work.edit');
    await h.fixture.principalMember('realm', x, h.reader);
    const guards = [rule.guard({ op: 'authenticated' }), rule.guard({ op: 'represents' })];
    const grantAllow = rule.allow({ op: 'has-grant', action: 'work.edit' });
    const early = await wiki.admit(x, 'authenticated_principal');
    const late = await wiki.admit(x, 'acting_subject');
    const exception = rule.allow({ op: 'subject-is', subject: b });
    const exclusion = rule.deny(memberOf(early, 'authenticated_principal'));
    const lower = rule.deny(memberOf(late, 'acting_subject'));
    await wiki.published(guards, [exception, exclusion, lower, grantAllow]);
    expect((await wiki.decide(outsider, 'work.edit', h.managerToken)).result).toBe('allow');
    await wiki.revokeSet(x, early);
    await wiki.revokeSet(x, late);
    // IAM22: rule 1 decides before the unavailable lower rules are reached.
    const decidedFirst = await wiki.decide(b);
    expect(decidedFirst.result).toBe('allow');
    expect(await snapshot(h, decidedFirst.decisionId)).toMatchObject({ reason: 'rule-allow',
      deciding_rule_id: exception.ruleId });
    // IAM17: an unavailable earlier exclusion is never non-membership, for a member
    // or a non-member, and never falls through to the later grant.
    for (const [agent, token] of [[a, h.readerToken], [outsider, h.managerToken]] as const) {
      const unknown = await wiki.decide(agent, 'work.edit', token);
      expect(unknown.result).toBe('unavailable');
      expect(await snapshot(h, unknown.decisionId)).toMatchObject({ outcome: 'indeterminate',
        reason: 'set-admission-unavailable', deciding_rule_id: exclusion.ruleId });
    }
    // not(unavailable) stays unavailable and cannot become an allow.
    const absent = await wiki.admit(x, 'authenticated_principal');
    const guardSet = await wiki.admit(x, 'acting_subject');
    await wiki.published(guards, [rule.allow({ op: 'not', arg: memberOf(absent, 'authenticated_principal') },
      ['work.read']), grantAllow]);
    await wiki.revokeSet(x, absent);
    expect((await wiki.decide(a, 'work.read')).result).toBe('unavailable');
    // A mandatory guard with unavailable evidence blocks even an earlier exception.
    await wiki.published([...guards, rule.guard({ op: 'not', arg: memberOf(guardSet, 'acting_subject') })],
      [exception, grantAllow]);
    expect((await wiki.decide(b)).result).toBe('allow');
    await wiki.revokeSet(x, guardSet);
    const guardUnknown = await wiki.decide(b);
    expect(guardUnknown.result).toBe('unavailable');
    expect(await snapshot(h, guardUnknown.decisionId)).toMatchObject({ reason: 'set-admission-unavailable' });
    // IAM17 budget: exhausting the revision's state budget on an earlier exclusion is unavailable.
    const budgeted = await wiki.admit(x, 'acting_subject');
    await wiki.published([rule.guard({ op: 'authenticated' })], [rule.deny({ op: 'any', args: [
      { op: 'subject-is', subject: outsider }, memberOf(budgeted, 'acting_subject')] }), grantAllow],
    { limits: { maxStates: 3 } });
    const exhausted = await wiki.decide(a);
    expect(exhausted.result).toBe('unavailable');
    expect(await snapshot(h, exhausted.decisionId)).toMatchObject({ outcome: 'indeterminate',
      reason: 'budget-exhausted' });
    await wiki.published([rule.guard({ op: 'authenticated' })], [grantAllow], { limits: { maxStates: 3 } });
    expect((await wiki.decide(a)).result).toBe('allow');
  } finally { await h.close(); }
}, 180_000);

test('IAM20: decisions over an atomic grant/exclusion switch never combine two snapshots into an allow', async () => {
  const h = await policyHarness();
  try {
    const wiki = await governedWiki(h);
    const x = await realm(h);
    const a = await h.fixture.agent();
    await h.fixture.mandate(h.reader, a, 'work.edit');
    const grant = await h.fixture.grant(wiki.owner, a, wiki.scope, 'work.edit');
    const membership = await h.fixture.agentMember('realm', x, a);
    const excluded = await wiki.admit(x, 'acting_subject');
    await wiki.published([rule.guard({ op: 'represents' })], [
      rule.deny(memberOf(excluded, 'acting_subject')), rule.allow({ op: 'has-grant', action: 'work.edit' })]);
    // State A: no grant and no membership. State B: grant and excluded membership.
    const switchTo = async (stateB: boolean) => {
      const client = await h.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE access.permission_grant SET active = $2 WHERE id = $1', [grant, stateB]);
        await client.query(`UPDATE access.membership SET state = $2, generation = generation + 1
          WHERE id = $1`, [membership, stateB ? 'joined' : 'left']);
        await client.query('COMMIT');
      } finally { client.release(); }
    };
    await switchTo(false);
    let running = true;
    let switches = 0;
    const switcher = (async () => {
      while (running) { await switchTo(switches % 2 === 0); switches++; }
    })();
    const results: string[] = [];
    try {
      for (let round = 0; round < 25; round++) {
        results.push(...(await Promise.all(Array.from({ length: 6 }, () => wiki.decide(a))))
          .map(decision => decision.result));
      }
    } finally {
      running = false;
      await switcher;
    }
    expect(switches).toBeGreaterThan(10);
    expect(results.length).toBe(150);
    expect(results.filter(result => result === 'allow')).toEqual([]);
    expect(new Set(results)).toEqual(new Set(['deny']));
    // Each stored frame records one consistent state: grant sources appear only
    // together with a present joined membership, never with an absent one.
    const frames = await h.q(`SELECT d.id, bool_or(i.kind = 'permission_grant') AS granted,
        bool_or(i.kind = 'membership' AND i.observed = 'present') AS member
      FROM access.decision_snapshot d JOIN access.decision_snapshot_input i ON i.decision_id = d.id
      WHERE d.scope_id = $1 GROUP BY d.id`, [wiki.scope]);
    expect(frames.rows.length).toBe(150);
    expect(frames.rows.filter(row => row.granted || !row.member)).toEqual([]);
    // A frame stitched from another snapshot is refused by the owner schema.
    const current = (await h.q('SELECT generation FROM access.permission_grant WHERE id = $1', [grant])).rows[0]!;
    const stitched = h.q(`WITH frame AS (SELECT * FROM access.decision_snapshot WHERE scope_id = $1 LIMIT 1)
      INSERT INTO access.decision_snapshot_input (decision_id, ordinal, role, kind, observed,
        object_generation, permission_grant_id)
      SELECT id, 64, 'proof', 'permission_grant', 'present', $2::bigint + 1, $3 FROM frame`,
    [wiki.scope, current.generation, grant]);
    await expect(stitched).rejects.toMatchObject({ code: '23514' });
  } finally { await h.close(); }
}, 180_000);

test('IAM33: a proof handle is revalidated after revoke, expiry, leave/rejoin, role revision and actor switch', async () => {
  const h = await policyHarness();
  try {
    const wiki = await governedWiki(h, 'work:create:root');
    const [a, b, org] = [await h.fixture.agent(), await h.fixture.agent(), await h.fixture.agent('institution')];
    for (const agent of [a, b]) await h.fixture.mandate(h.reader, agent, 'work.create');
    await h.fixture.mandate(h.manager, wiki.owner, 'access.revoke');
    await wiki.published([rule.guard({ op: 'authenticated' }), rule.guard({ op: 'represents' })],
      [rule.allow({ op: 'has-grant', action: 'work.create' })]);
    const direct = await h.fixture.grant(wiki.owner, a, wiki.scope, 'work.create');
    const family = randomUUID();
    const binding = randomUUID();
    await h.q(`WITH f AS (INSERT INTO access.role_family (id, owner_subject, scope_id, head_revision)
        VALUES ($1, $2, 'work:create:root', 1) RETURNING id)
      INSERT INTO access.role_revision (family_id, revision, permissions)
        SELECT id, 1, ARRAY['work.create'] FROM f`, [family, wiki.owner]);
    await h.q(`INSERT INTO access.role_binding (id, family_id, role_revision, issuer_subject, recipient_subject,
        valid_until, assigned_by_principal) VALUES ($1, $2, 1, $3, $4, now() + interval '1 hour', $5)`,
    [binding, family, wiki.owner, a, h.manager]);
    const decide = (actor: string, extra: Record<string, unknown> = {}) =>
      wiki.decide(actor, 'work.create', h.readerToken, { reusable: true, ...extra });
    const revalidate = (decisionId: string | null, actor: string | null, token = h.readerToken) =>
      h.call('POST', '/v1/access/policy-decision-revalidations', token, {
        profile: 'access-policy-decision-revalidation-v1', decisionId, scopeId: wiki.scope,
        action: 'work.create', actingSubject: actor });
    const handle = await decide(a);
    expect([handle.result, handle.reusable, handle.sources.map(source => source.id).sort()])
      .toEqual(['allow', true, [direct, binding].sort()]);
    expect((await revalidate(handle.decisionId, a)).status).toBe(200);
    // Actor switch and another principal cannot reuse the bound handle.
    expect((await revalidate(handle.decisionId, b)).body.code).toBe('proof_handle_mismatch');
    expect((await revalidate(handle.decisionId, a, h.managerToken)).status).toBe(403);
    // Expiry.
    const brief = await decide(a, { validitySeconds: 1 });
    await Bun.sleep(1_200);
    expect((await revalidate(brief.decisionId, a)).body.code).toBe('proof_handle_stale');
    // Revoke one source: the handle is stale; a fresh decision keeps the other source.
    await h.ok(h.call('POST', '/v1/access/revocations', h.managerToken, { profile: 'access-revocation-v1',
      revocationId: randomUUID(), issuerSubject: wiki.owner, mode: 'ordinary', scopeId: wiki.scope,
      expectedAuthorityEpoch: await h.fixture.epoch(wiki.scope),
      target: { kind: 'permission_grant', id: direct, expectedGeneration: '0' } }));
    expect((await revalidate(handle.decisionId, a)).body.code).toBe('proof_handle_stale');
    const pinned = await decide(a);
    expect(pinned.sources.map(source => source.id)).toEqual([binding]);
    // Role revision: a new empty family revision leaves the pinned binding's handle
    // valid; revoking that binding makes it stale and a new-revision binding cannot rescue it.
    await h.q(`INSERT INTO access.role_revision (family_id, revision, permissions) VALUES ($1, 2, '{}')`, [family]);
    await h.q('UPDATE access.role_family SET head_revision = 2 WHERE id = $1', [family]);
    expect((await revalidate(pinned.decisionId, a)).status).toBe(200);
    await h.q('UPDATE access.role_binding SET active = false WHERE id = $1', [binding]);
    await h.q(`INSERT INTO access.role_binding (id, family_id, role_revision, issuer_subject, recipient_subject,
        valid_until, assigned_by_principal) VALUES ($1, $2, 2, $3, $4, now() + interval '1 hour', $5)`,
    [randomUUID(), family, wiki.owner, a, h.manager]);
    expect((await revalidate(pinned.decisionId, a)).body.code).toBe('proof_handle_stale');
    expect((await decide(a)).result).toBe('deny');
    // Leave/rejoin: a grant bound to membership episode 1 does not survive episode 3.
    await h.fixture.memberSet('org', org);
    const episode = await h.fixture.agentMember('org', org, a);
    const dependent = await h.fixture.grant(wiki.owner, a, wiki.scope, 'work.create', { id: episode, generation: 1 });
    const episodic = await decide(a);
    expect(episodic.sources.map(source => source.id)).toEqual([dependent]);
    await h.q(`UPDATE access.membership SET state = 'left', generation = 2 WHERE id = $1`, [episode]);
    await h.q('UPDATE access.permission_grant SET active = false WHERE id = $1', [dependent]);
    await h.q(`UPDATE access.membership SET state = 'joined', generation = 3 WHERE id = $1`, [episode]);
    expect((await revalidate(episodic.decisionId, a)).body.code).toBe('proof_handle_stale');
    await expect(h.q('UPDATE access.permission_grant SET active = true WHERE id = $1', [dependent]))
      .rejects.toMatchObject({ code: '23514' });
    expect((await decide(a)).result).toBe('deny');
    // Non-reusable decisions and denials are never handles.
    const once = await wiki.decide(b, 'work.create');
    expect(once.reusable).toBe(false);
    expect((await revalidate(once.decisionId, b)).body.code).toBe('proof_handle_mismatch');
  } finally { await h.close(); }
}, 180_000);
