import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentModeration } from '../../../services/content/src/moderation.ts';
import { AccessMembershipConsents } from '../../../services/main/src/modules/access/membership-consents.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { realmManager, realmTransaction } from '../../../services/main/src/modules/access/realm-management-authority.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { disclosureViewer, namePolicyPrincipal } from '../../../services/main/src/modules/disclosure/viewer.ts';
import { ownerModerationEffects } from '../../../services/main/src/modules/governance/effects.ts';
import { ownerEvidenceCapture, ownerTargetHeads } from '../../../services/main/src/modules/governance/evidence.ts';
import { GovernanceInvalid, GovernanceStore, type DecisionInput } from '../../../services/main/src/modules/governance/store.ts';
import { createAdmittedRealmSpace } from '../../../services/main/src/modules/space/create-admitted.ts';
import { createAdmittedMetadataWork } from '../../../services/main/src/modules/work/create-admitted.ts';
import { editAdmittedMetadataWork } from '../../../services/main/src/modules/work/edit-admitted.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import {
  captureDisclosure,
  configureDisclosure,
  configureDisclosureAncestrySource,
  DISCLOSURE_CHANNELS,
  DisclosureStore,
  DisclosureUnavailable,
  disclose,
  fenceDisclosure,
  resolveDisclosureSelections,
  type DisclosureAncestryEvidence,
  type DisclosureAncestrySource,
  type DisclosureChannel,
  type DisclosureRelationshipBasis,
  type DisclosureTarget,
  type OwnerEstablishedGraphParent,
  type OwnerEstablishedGraphParents,
} from '../../../services/main/src/modules/disclosure/read.ts';
import {
  ANONYMOUS_VIEWER,
  type Viewer,
} from '../../../services/main/src/modules/suitability/policy.ts';
import { authorCreditFixture, nativeId } from '../fixtures/author-credit.ts';
import { claimFixture, fixtureReasons } from './g-565-decision-support.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
interface PlanNode {
  'Node Type': string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Relation Name'?: string;
  'Rows Removed by Filter'?: number;
  'Subplan Name'?: string;
  'CTE Name'?: string;
  Plans?: PlanNode[];
}
function planNodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(planNodes)];
}

type RealmFixture = Awaited<ReturnType<typeof authorCreditFixture>>;

/** Owner evidence is explicit in this policy fixture; acknowledgement and all
 * mapped fence/epoch work belong to the real GovernanceStore and effect owner. */
async function restriction(
  f: RealmFixture,
  resource: string,
  component: 'record' | 'title' | 'name' | 'publication',
  revision: string | null = null,
  effect: 'disclosure' | 'search' = 'disclosure',
  narrower: {
    authority?: 'platform' | 'realm' | 'resource_owner';
    scope?: string;
    context?: string;
    locator?: string | null;
    scopeKind?: 'component' | 'exact_revision';
  } = {},
) {
  const principal = { issuer: f.account.issuer, subject: f.account.a.id };
  const scope = narrower.scope ?? 'governance:platform';
  await grantFixtureAuthority(f.accessPool, { scope, requireDispatch: true,
    representations: [{ principalId: f.principalId, actor: f.actor, action: 'governance.moderate', lifetime: '8 hours' }],
    grant: { actor: f.actor, action: 'governance.moderate', lifetime: '8 hours' } });
  const heads = ownerTargetHeads({ graph: f.env });
  const store = new GovernanceStore(f.accessPool, {
    capture: async (_principal, _actor, target) => ({ ...target, state: 'available',
      representation: 'application/json', revisionDigest: digest(JSON.stringify(target)),
      provenance: { capturedBy: 'disclosure-policy-fixture' } }),
  }, heads, { current: async () => ({ revision: '1', digest: digest('disclosure-parent-rule') }) },
  ownerModerationEffects(new ContentModeration(f.pool), f.env));
  const target = { owner: 'graph' as const, resource, component, revision, locator: narrower.locator ?? null };
  const expectedHead = await heads.current(target);
  const authority = narrower.authority ?? 'platform';
  const report = await store.submitReport(principal, {
    kind: 'content_report', actingSubject: f.actor, authority: { kind: authority, scopeId: scope },
    context: narrower.context ?? 'urn:rezics:context:global',
    target: { owner: 'graph', resource, component }, disclosure: 'private', reasonCode: 'disclosure',
    statement: 'Review the exact owner-established disclosure grain', evidence: [target], idempotencyKey: randomUUID(),
  });
  const claim = async () => {
    if (authority !== 'platform') return;
    if (scope === 'governance:platform') await store.safety.claim(principal, f.actor, report.caseId);
    else await claimFixture(f.accessPool, report.caseId, f.principalId, f.actor);
  };
  await claim();
  const input: DecisionInput = {
    caseId: report.caseId, expectedGeneration: report.caseGeneration, actingSubject: f.actor, outcome: 'restrict',
    targets: [{ ...target, scopeKind: narrower.scopeKind ?? (revision === null ? 'component' : 'exact_revision'), expectedHead, effect }],
    rule: { ref: 'urn:rezics:rule:disclosure-parent', revision: '1', digest: digest('disclosure-parent-rule') },
    evidenceDigest: report.evidenceDigest, reversesDecisionId: null, answersStepId: null,
    rationale: 'Reviewed fixture evidence', disclosure: 'private', reasons: fixtureReasons, idempotencyKey: randomUUID(),
  };
  const accepted = await store.decide(principal, input, true);
  expect(accepted.operation.status).not.toBe('completed');
  const confirmed = await store.resumeDecision(principal, f.actor, accepted.decisionId);
  // A missing Realm effect owner must be a visible dependency failure. A fake
  // receipt would let this fixture claim closure without actual acknowledgement.
  expect(confirmed.operation.status, JSON.stringify(confirmed.operation)).toBe('completed');
  return async () => {
    await claim();
    const restored = await store.decide(principal, { ...input, outcome: 'restore',
      expectedGeneration: confirmed.caseGeneration, reversesDecisionId: accepted.decisionId,
      idempotencyKey: randomUUID() }, true);
    const released = await store.resumeDecision(principal, f.actor, restored.decisionId);
    expect(released.operation.status, JSON.stringify(released.operation)).toBe('completed');
  };
}

async function realmViewers(f: RealmFixture, realm: string) {
  const managerPrincipal = await f.account.verifier.verify(new Request('https://main.test',
    { headers: { authorization: `Bearer ${f.account.tokenA}` } }), []);
  const memberPrincipal = await f.account.verifier.verify(new Request('https://main.test',
    { headers: { authorization: `Bearer ${f.account.tokenB}` } }), []);
  const provisioned = await new AgentProvisioning(f.accessPool, f.env).provision(f.account.verifier,
    new Request('https://main.test', { headers: { authorization: `Bearer ${f.account.tokenB}` } }),
    { kind: 'person', displayName: 'Realm disclosure member' }, randomUUID());
  expect(provisioned.state).toBe('active');
  const memberActor = provisioned.agent;
  const policy = (await f.accessPool.query<{ revision: string; terms: string }>(
    "SELECT revision::text,terms_revision AS terms FROM access.membership_policy WHERE kind = 'realm' AND owner_subject = $1", [realm],
  )).rows[0]!;
  const generation = (await f.accessPool.query<{ generation: string }>(
    'SELECT generation::text FROM access.realm_admin_revision WHERE realm = $1', [realm],
  )).rows[0]!.generation;
  await grantFixtureAuthority(f.accessPool, { scope: `governance:realm:${realm}`, requireDispatch: true,
    representations: [{ principalId: f.principalId, actor: f.actor, action: 'realm.members.manage', lifetime: '8 hours' }],
    grant: { actor: f.actor, action: 'realm.members.manage', lifetime: '8 hours' } });
  await grantFixtureAuthority(f.accessPool, { scope: 'work:create:root', requireDispatch: true,
    representations: [{ principalId: f.otherPrincipal, actor: memberActor, action: 'access.membership.consent', lifetime: '8 hours' }],
    grant: { actor: memberActor, action: 'access.membership.consent', lifetime: '8 hours' } });
  const consent = await new AccessMembershipConsents(f.accessPool).issue({ principal: memberPrincipal,
    kind: 'realm', ownerSubject: realm, memberSubject: memberActor, expectedGeneration: '0',
    expectedPolicyRevision: policy.revision, termsRevision: policy.terms,
    idempotencyKey: randomUUID(), requestDigest: digest('realm-disclosure-membership') });
  const joined = await new AccessRealmManagement(f.accessPool).changeMember(managerPrincipal, realm, {
    actingSubject: f.actor, member: memberActor, action: 'add', expectedGeneration: generation,
    expectedMembershipGeneration: '0', reason: 'Join the disclosure policy fixture',
    consent: consent.consentReference, durationSeconds: null,
  }, randomUUID(), f.env);
  expect(joined.membershipGeneration).toBe('1');
  expect((await f.accessPool.query(`SELECT state FROM access.membership
    WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2`, [realm, memberActor])).rows)
    .toEqual([{ state: 'joined' }]);
  const manager = await realmTransaction(f.accessPool, realm, false,
    client => realmManager(client, managerPrincipal, realm, f.actor));
  expect(manager.id).toBe(f.principalId);
  const memberViewer = disclosureViewer(memberPrincipal, memberActor);
  const managerViewer = disclosureViewer(managerPrincipal, f.actor);
  expect(namePolicyPrincipal(memberViewer)).toBe(memberPrincipal);
  expect(namePolicyPrincipal(managerViewer)).toBe(managerPrincipal);
  return [ANONYMOUS_VIEWER, memberViewer, managerViewer];
}

/** Large unrelated inventory uses supported Access-local source effects.
 * It never manufactures graph fences solely to inflate the plan fixture. */
async function unrelatedFences(f: RealmFixture, count: number) {
  const principal = { issuer: f.account.issuer, subject: f.account.a.id };
  const source = new GovernanceStore(f.accessPool, ownerEvidenceCapture({
    source: async (_principal, record) => ({ record, retention: 'retained', byteDigest: digest(record), mediaType: 'application/json' }),
  }), ownerTargetHeads({}), { current: async () => ({ revision: '1', digest: digest('unrelated-source-rule') }) });
  for (let start = 0; start < count; start += 16) {
    const resources = Array.from({ length: Math.min(16, count - start) }, nativeId);
    const report = await source.submitReport(principal, {
      kind: 'content_report', actingSubject: f.actor, authority: { kind: 'platform', scopeId: 'governance:platform' },
      context: 'urn:rezics:context:global', target: { owner: 'source', resource: resources[0]!, component: 'record' },
      disclosure: 'private', reasonCode: 'disclosure', statement: 'Review unrelated source records',
      evidence: resources.map(resource => ({ owner: 'source', resource, component: 'record', revision: nativeId(), locator: null })),
      idempotencyKey: randomUUID(),
    });
    await source.safety.claim(principal, f.actor, report.caseId);
    const decision = await source.decide(principal, {
      caseId: report.caseId, expectedGeneration: report.caseGeneration, actingSubject: f.actor, outcome: 'restrict',
      targets: resources.map(resource => ({ owner: 'source', resource, component: 'record', locator: null,
        scopeKind: 'component', revision: null, expectedHead: null, effect: 'disclosure' })),
      rule: { ref: 'urn:rezics:rule:unrelated-source', revision: '1', digest: digest('unrelated-source-rule') },
      evidenceDigest: report.evidenceDigest, reversesDecisionId: null, answersStepId: null,
      rationale: 'Reviewed unrelated records', disclosure: 'private', reasons: fixtureReasons, idempotencyKey: randomUUID(),
    });
    expect(decision.operation.status, JSON.stringify(decision.operation)).toBe('completed');
  }
}

test('Realm disclosure: real Access preserves Work and Realm fences, independent publication and final-cut races', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const directory = resolve('.temp', `disclosure-parents-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const f = await authorCreditFixture(Bun.env as Record<string, string>, directory,
    'openid work:create work:edit work:read work:protect source:intake source:acquire source:convert source:propose source:adopt source:correspond source:read space:create agent:create');
  try {
    const request = (token = f.account.tokenA) => new Request('https://main.test', { headers: { authorization: `Bearer ${token}` } });
    await grantFixtureAuthority(f.accessPool, { scope: 'space:create:root', requireDispatch: true,
      representations: [{ principalId: f.principalId, actor: f.actor, action: 'space.create', lifetime: '8 hours' }],
      grant: { actor: f.actor, action: 'space.create', lifetime: '8 hours' } });
    const createdRealm = await createAdmittedRealmSpace(f.env, f.account.verifier, f.access, request(), {
      name: 'Realm disclosure fixture', actingSubject: f.actor, idempotencyKey: randomUUID(),
    }, new AccessRealmManagement(f.accessPool));
    const createdWork = await createAdmittedMetadataWork(f.env, f.account.verifier, f.access, request(), {
      title: 'Protected Work original head', language: 'en', actingSubject: f.actor, idempotencyKey: randomUUID(),
    });
    await grantFixtureAuthority(f.accessPool, { scope: `work:edit:${createdWork.work}`, requireDispatch: true,
      representations: [{ principalId: f.principalId, actor: f.actor, action: 'work.edit', lifetime: '8 hours' }],
      grant: { actor: f.actor, action: 'work.edit', lifetime: '8 hours' } });
    const editedWork = await editAdmittedMetadataWork(f.env, f.account.verifier, f.access, request(), {
      work: createdWork.work, expectedHead: createdWork.workRevision, title: 'Protected Work current head',
      actingSubject: f.actor, idempotencyKey: randomUUID(),
    });
    const work = createdWork.work, realm = createdRealm.realm!, reply = nativeId();
    const workHead = editedWork.revision, realmHead = createdRealm.realmRevision!, pinnedWorkHead = createdWork.workRevision;
    let currentWorkHead = workHead,
      token = digest('selected-placement'),
      sourceAvailable = true;
    const body: DisclosureTarget = {
      owner: 'content',
      resource: reply,
      component: 'body',
      revision: randomUUID(),
    };
    const media: DisclosureTarget = {
      owner: 'media',
      resource: `urn:rezics:media:${randomUUID()}`,
      component: 'media_use',
      revision: randomUUID(),
    };
    const direct: DisclosureTarget = {
      owner: 'graph',
      resource: realm,
      component: 'record',
      revision: realmHead,
    };
    const independent: DisclosureTarget = {
      owner: 'content',
      resource: `urn:rezics:publication:${randomUUID()}`,
      component: 'body',
      revision: randomUUID(),
    };
    const targets = [body, media, direct, independent];
    const relationship = (target: DisclosureTarget): DisclosureRelationshipBasis => ({
      owner: target.owner === 'media' ? 'media' : target.owner === 'graph' ? 'graph' : 'content',
      kind:
        target === direct
          ? 'identity'
          : target === independent
            ? 'publication'
            : target === media
              ? 'media-use'
              : 'realm-placement',
      resource:
        target === direct ? realm : `urn:rezics:disclosure-occurrence:${target.resource.slice(-36)}`,
      revision: target === direct ? realmHead : 'urn:rezics:disclosure-occurrence:revision:1',
      targetResource: target.resource,
      targetRevision: target.revision ?? null,
      token,
      dataEpoch: f.env.lineage.dataEpoch,
    });
    const evidence = (input: DisclosureTarget): DisclosureAncestryEvidence => {
      const selected = targets.find(
        (target) => target.owner === input.owner && target.resource === input.resource,
      );
      if (!selected) throw new Error('Unknown fixture occurrence');
      const parents: OwnerEstablishedGraphParents =
        selected === direct || selected === independent
          ? []
          : [
              {
                owner: 'graph',
                kind: 'work',
                resource: work,
                head: currentWorkHead,
                protectedRevision: pinnedWorkHead,
                relationshipBasis: relationship(selected),
              },
              {
                owner: 'graph',
                kind: 'realm',
                resource: realm,
                head: realmHead,
                relationshipBasis: relationship(selected),
              },
            ];
      return {
        resource: input.resource,
        resourceKind: selected === direct ? 'realm' : 'other',
        relationshipBasis: relationship(selected),
        parents,
        status: sourceAvailable ? 'complete' : 'unavailable',
      };
    };
    const source: DisclosureAncestrySource = {
      read: async (inputs) => inputs.map(evidence),
      reread: async (bases) =>
        bases.map((basis) =>
          evidence(targets.find((target) => target.resource === basis.targetResource)!),
        ),
    };
    const reader = new DisclosureStore(f.accessPool);
    configureDisclosure(f.env, reader);
    for (const owner of ['graph', 'content', 'media'] as const)
      configureDisclosureAncestrySource(f.env, owner, source);
    const capture = async (
      inputs = targets,
      channel: DisclosureChannel = 'read',
      viewer: Viewer = ANONYMOUS_VIEWER,
    ) => captureDisclosure(f.env, await resolveDisclosureSelections(f.env, inputs), viewer, channel);
    const decisions = async (
      inputs = targets,
      channel: DisclosureChannel = 'read',
      viewer: Viewer = ANONYMOUS_VIEWER,
    ) => (await capture(inputs, channel, viewer)).map((cut) => cut.decision);
    const restrict = (
      resource: string,
      component: 'record' | 'title' | 'name' | 'publication',
      revision: string | null = null,
      effect: 'disclosure' | 'search' = 'disclosure',
    ) => restriction(f, resource, component, revision, effect);
    const client = await f.accessPool.connect();
    try {
      await client.query('BEGIN');
      await grantFixtureAuthority(client, {
        scope: 'governance:platform',
        requireDispatch: true,
        representations: [
          {
            principalId: f.principalId,
            actor: f.actor,
            action: 'governance.moderate',
            lifetime: '8 hours',
          },
        ],
        grant: { actor: f.actor, action: 'governance.moderate', lifetime: '8 hours' },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    // Admitted heads are live graph data; the explicit trusted ancestry
    // source isolates disclosure policy from the consuming owner adapters.
    expect(await decisions()).toEqual(['visible', 'visible', 'visible', 'visible']);

    const viewers = await realmViewers(f, realm);
    await expect(restriction(f, realm, 'record', null, 'disclosure', { scopeKind: 'exact_revision' }))
      .rejects.toBeInstanceOf(GovernanceInvalid);
    expect(await decisions([body, media, independent])).toEqual(['visible', 'visible', 'visible']);

    const snapshotObserver = new Pool({ connectionString: f.accessPool.options.connectionString, max: 4 });
    const staleSnapshot = await f.accessPool.connect();
    let releaseSnapshotRestriction: (() => Promise<void>) | undefined;
    try {
      await staleSnapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const selection = await resolveDisclosureSelections(f.env, [body]);
      const oldCut = await captureDisclosure(f.env, selection, ANONYMOUS_VIEWER, 'read', staleSnapshot);
      expect(oldCut[0]!.decision).toBe('visible');
      releaseSnapshotRestriction = await restriction({ ...f, accessPool: snapshotObserver }, realm, 'record');
      // A final fence on the capture snapshot must refuse: that snapshot cannot
      // observe the independently committed closure.
      await expect(fenceDisclosure(f.env, oldCut, ANONYMOUS_VIEWER, 'read', staleSnapshot))
        .rejects.toBeInstanceOf(DisclosureUnavailable);
    } finally {
      await staleSnapshot.query('ROLLBACK');
      staleSnapshot.release();
      try { await releaseSnapshotRestriction?.(); } finally { await snapshotObserver.end(); }
    }

    const narrowerTuples = [
      { label: 'non-platform authority', authority: 'resource_owner' as const },
      { label: 'non-platform scope', scope: `governance:realm:${realm}` },
      { label: 'non-global context', context: realm },
      { label: 'located record', locator: 'urn:rezics:record:fragment' },
    ];
    for (const { label, ...tuple } of narrowerTuples) {
      if (tuple.scope)
        await grantFixtureAuthority(f.accessPool, {
          scope: tuple.scope, requireDispatch: true,
          representations: [{ principalId: f.principalId, actor: f.actor, action: 'governance.moderate', lifetime: '8 hours' }],
          grant: { actor: f.actor, action: 'governance.moderate', lifetime: '8 hours' },
        });
      const release = await restriction(f, realm, 'record', null, 'disclosure', tuple);
      try {
        expect(await decisions([body, media, independent]), label).toEqual(['visible', 'visible', 'visible']);
      } finally { await release(); }
    }

    // Narrower Realm controls do not create whole-Realm closure or propagate
    // into a thread body/media use. They remain after whole-Realm restoration.
    const narrower: Array<() => Promise<void>> = [];
    narrower.push(await restrict(realm, 'title'));
    narrower.push(await restrict(realm, 'name'));
    narrower.push(await restrict(realm, 'publication'));
    narrower.push(await restrict(realm, 'record', realmHead));
    narrower.push(await restrict(realm, 'record', null, 'search'));
    for (const channel of ['read', 'thread'] as const)
      expect(await decisions([body, media, independent], channel)).toEqual([
        'visible',
        'visible',
        'visible',
      ]);

    const releaseWork = await restrict(work, 'title', workHead);
    // Low-level policy batches remain usable by existing owners. Public
    // compatibility reads below still require positively established ancestry.
    expect(await reader.read([body], ANONYMOUS_VIEWER, 'read')).toEqual(['visible']);
    expect(await reader.read([{ ...body, work, workRevision: workHead }], ANONYMOUS_VIEWER, 'read'))
      .toEqual(['tombstone']);
    expect(await reader.read([{ ...body, work }], ANONYMOUS_VIEWER, 'read')).toEqual(['tombstone']);
    const constrained = await capture([body]);
    expect(constrained[0]!.decision).toBe('tombstone');
    expect(constrained[0]!.parents.map((parent) => parent.kind)).toEqual(['work', 'realm']);
    const releaseRealm = await restrict(realm, 'record');
    for (const viewer of viewers) {
      for (const channel of DISCLOSURE_CHANNELS) {
        expect(await decisions(targets, channel, viewer)).toEqual([
          'hidden',
          'hidden',
          'hidden',
          'visible',
        ]);
      }
    }
    expect(await fenceDisclosure(f.env, constrained, ANONYMOUS_VIEWER, 'read')).toEqual(['hidden']);
    await releaseRealm();
    expect(await decisions([body])).toEqual(['tombstone']);
    // Graph-owned body occurrences may share their Work parent's identity.
    // Their Content revision cannot replace either exact Work fence basis.
    const selfWork: DisclosureTarget = {
      owner: 'graph', resource: work, component: 'body', revision: randomUUID(),
      work, workRevision: pinnedWorkHead,
    };
    targets.push(selfWork);
    expect(await decisions([selfWork])).toEqual(['tombstone']);
    expect(await decisions([{ ...direct, component: 'title', nameOwnerResolved: true }])).toEqual([
      'tombstone',
    ]);
    await releaseWork();
    expect(await decisions([body])).toEqual(['visible']);
    for (const release of narrower) await release();

    const pinnedRelease = await restrict(work, 'title', pinnedWorkHead);
    expect(await decisions([body])).toEqual(['tombstone']);
    const oldCut = await capture([body]);
    const movedWork = await editAdmittedMetadataWork(f.env, f.account.verifier, f.access, request(), {
      work, expectedHead: currentWorkHead, title: 'Protected Work moved head', actingSubject: f.actor, idempotencyKey: randomUUID(),
    });
    currentWorkHead = movedWork.revision;
    await expect(fenceDisclosure(f.env, oldCut, ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(
      DisclosureUnavailable,
    );
    expect(await decisions([body])).toEqual(['tombstone']);
    expect(await decisions([selfWork])).toEqual(['tombstone']);
    const [legacy] = await resolveDisclosureSelections(f.env, [
      { ...body, work, workRevision: pinnedWorkHead },
    ]);
    expect(
      (
        legacy!.ancestry.parents.find(
          (parent) => parent.kind === 'work',
        ) as OwnerEstablishedGraphParent
      ).protectedRevision,
    ).toBe(pinnedWorkHead);
    await pinnedRelease();

    const oldNameRelease = await restrict(work, 'name', workHead);
    const currentName: DisclosureTarget = {
      owner: 'graph', resource: work, component: 'name', work, nameOwnerResolved: true,
    };
    // Choose the name from the owner-established current Work head, rather
    // than treating a missing request revision as an unknown historical name.
    targets[targets.indexOf(selfWork)] = currentName;
    expect(await decisions([currentName])).toEqual(['visible']);
    await oldNameRelease();
    targets.splice(targets.indexOf(currentName), 1);

    const placed = await capture([body]);
    token = digest('replacement-placement-review-attachment');
    await expect(fenceDisclosure(f.env, placed, ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(
      DisclosureUnavailable,
    );
    const beforeClose = await capture([body]);
    const releaseLate = await restrict(realm, 'record');
    expect(await fenceDisclosure(f.env, beforeClose, ANONYMOUS_VIEWER, 'read')).toEqual(['hidden']);
    const hidden = await capture([body]);
    await releaseLate();
    expect(await fenceDisclosure(f.env, hidden, ANONYMOUS_VIEWER, 'read')).toEqual(['hidden']);

    // Unrelated fences must not turn the exact parent lookup into ancestry
    // enumeration. Read the native plan rather than infer cost from call count.
    await unrelatedFences(f, 512);
    await f.accessPool.query('ANALYZE access.governance_enforcement');
    const batch = Array.from({ length: 64 }, (): DisclosureTarget => ({
      ...body,
      resource: nativeId(),
    }));
    targets.push(...batch);
    const measured = await f.accessPool.connect();
    let policyQuery: { sql: string; args: unknown[] } | undefined;
    const recorded = new Proxy(measured, {
      get(client, property) {
        if (property === 'query')
          return (sql: string, args?: unknown[]) => {
            if (sql.includes('WITH fence AS MATERIALIZED') && sql.includes('parent_edges'))
              policyQuery = { sql, args: args ?? [] };
            return client.query(sql, args);
          };
        const value: unknown = Reflect.get(client, property, client);
        return typeof value === 'function' ? value.bind(client) : value;
      },
    });
    try {
      const selections = await resolveDisclosureSelections(f.env, batch);
      const cuts = await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read', recorded);
      expect(cuts.map((cut) => cut.decision)).toEqual(Array.from({ length: 64 }, () => 'visible'));
      expect(cuts.flatMap((cut) => cut.parents)).toHaveLength(128);
      expect(policyQuery).toBeDefined();
      const plan = (
        await measured.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
          `EXPLAIN (ANALYZE, FORMAT JSON) ${policyQuery!.sql}`,
          policyQuery!.args,
        )
      ).rows[0]!['QUERY PLAN'][0]!.Plan;
      expect(plan['Actual Rows']).toBe(64);
      const parentNodes = planNodes(plan).filter(
        (node) =>
          node['CTE Name'] === 'parent_edges' || node['Subplan Name'] === 'CTE parent_edges',
      );
      expect(parentNodes.length).toBeGreaterThan(0);
      for (const node of parentNodes) expect(node['Actual Rows']).toBeLessThanOrEqual(128);
      const enforcementNodes = planNodes(plan).filter(node => node['Relation Name'] === 'governance_enforcement');
      expect(enforcementNodes.length).toBeGreaterThan(0);
      for (const node of enforcementNodes) {
        // A scan of unrelated retained fences would grow with the owner table,
        // even when its final result and parent-edge cardinality stay bounded.
        expect(node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)).toBeLessThanOrEqual(128);
      }
    } finally {
      measured.release();
      targets.splice(targets.length - batch.length, batch.length);
    }

    const paused = await f.accessPool.connect();
    try {
      await paused.query('BEGIN');
      await paused.query('UPDATE access.recovery_fence SET open=false WHERE id');
      const selection = await resolveDisclosureSelections(f.env, [body]);
      await expect(
        captureDisclosure(f.env, selection, ANONYMOUS_VIEWER, 'read', paused),
      ).rejects.toBeInstanceOf(DisclosureUnavailable);
    } finally {
      await paused.query('ROLLBACK');
      paused.release();
    }
    sourceAvailable = false;
    await expect(capture([body])).rejects.toBeInstanceOf(DisclosureUnavailable);
    await expect(disclose(f.env, [body], ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(
      DisclosureUnavailable,
    );
  } finally {
    await f.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
