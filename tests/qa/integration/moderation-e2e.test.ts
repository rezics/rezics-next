import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { AccessRealmJoining } from '../../../services/main/src/modules/access/realm-management-joining.ts';
import { AccessRealmRoster } from '../../../services/main/src/modules/access/roster.ts';
import { AccessManagedRealms } from '../../../services/main/src/modules/access/realm-management-managed.ts';
import { AccessMembershipConsents } from '../../../services/main/src/modules/access/membership-consents.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { ManagementDecisionBasis } from '../../../services/main/src/modules/management-reads/decision-basis.ts';
import { ManagementReadStore } from '../../../services/main/src/modules/management-reads/read-store.ts';
import { ownerEvidenceCapture, ownerTargetHeads } from '../../../services/main/src/modules/governance/evidence.ts';
import { ownerModerationEffects } from '../../../services/main/src/modules/governance/effects.ts';
import { ContentModeration } from '../../../services/content/src/moderation.ts';
import { GovernanceStore } from '../../../services/main/src/modules/governance/store.ts';
import { GovernanceRules } from '../../../services/main/src/modules/governance/rules.ts';
import { RealmSubmissionStore } from '../../../services/main/src/modules/realm-submission/store.ts';
import { RealmSubmissionReads } from '../../../services/main/src/modules/realm-submission/reads.ts';
import type { RoleCommand } from '../../../services/main/src/modules/realm-admin/contract.ts';
import type { SubmissionInput, SubmissionView } from '../../../services/main/src/modules/realm-submission/schema.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { REALM_JOIN_COST } from '../../../services/main/src/modules/access/realm-management-joining-contract.ts';
import { REALM_ROSTER_COST } from '../../../services/main/src/modules/access/roster.ts';
import { MANAGED_REALMS_COST } from '../../../services/main/src/modules/access/realm-management-managed.ts';
import { NotificationStore } from '../../../services/main/src/modules/notification/store.ts';
import { NotificationProducer } from '../../../services/main/src/modules/notification-producers/producer.ts';
import { notificationProducerSubjectReader } from '../../../services/main/src/modules/notification-producers/subjects.ts';

type Member = Awaited<ReturnType<MediaStack['member']>>;
async function json<T>(response: Response, status = 200): Promise<T> {
  const value: unknown = await response.json();
  expect(response.status,JSON.stringify(value)).toBe(status);
  return value as T;
}
interface InvitationResult { invitation: { id: string; state: string; member: string; termsRevision: string }; replayed: boolean }
async function setup() {
  const stack = await startMediaStack('moderation-e2e');
  const owner = await stack.member('owner');
  const outsider = await stack.member('outsider');
  const members = [owner,outsider];
  const deniedScopes = new Set<string>();
  const measurements = { sql: 0, graph: 0 };
  const pool = new Proxy(stack.accessPool,{ get(target,property) {
    if (property === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client,{ get(connection,member) {
        if (member === 'query') return (...args: unknown[]) => { measurements.sql++; return Reflect.apply(connection.query,connection,args); };
        const value = Reflect.get(connection,member);
        return typeof value === 'function' ? value.bind(connection) : value;
      } });
    };
    if (property === 'query') return (...args: unknown[]) => { measurements.sql++; return Reflect.apply(target.query,target,args); };
    const value = Reflect.get(target,property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const env = { ...stack.env,fuseki: new Proxy(stack.fuseki,{ get(target,property) {
    if (property === 'query') return (...args: unknown[]) => { measurements.graph++; return Reflect.apply(target.query,target,args); };
    const value = Reflect.get(target,property);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) };
  await owner.grant('space:create:root','space.create');
  await stack.accessPool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES ($1,$2,$3,'agent.control','infinity')`,[randomUUID(),owner.principalId,owner.actor]);
  const rules = new GovernanceRules(stack.accessPool);
  const heads = ownerTargetHeads({ graph: stack.env,content: stack.contentPool });
  const governance = new GovernanceStore(stack.accessPool,ownerEvidenceCapture({
    graph: { env: stack.env,canReadWork: (principal,actor,work) => stack.access.canReadWork(principal,actor,work) },
    content: { core: stack.content,canRead: async (_principal,_actor,ids) => new Set(ids) },
  }),heads,rules,ownerModerationEffects(new ContentModeration(stack.contentPool),stack.env));
  const app = createMainApp(stack.fuseki,{ environment: stack.env,access: stack.access,
    realmAdmin: new AccessRealmManagement(stack.accessPool),realmJoining: new AccessRealmJoining(pool,env),
    realmRoster: new AccessRealmRoster(pool,env),managedRealms: new AccessManagedRealms(pool,env),
    membershipConsents: new AccessMembershipConsents(stack.accessPool),agentProvisioning: new AgentProvisioning(stack.accessPool,stack.env),
    managementReads: new ManagementReadStore(stack.accessPool,stack.env),managementDecisionBasis: new ManagementDecisionBasis(stack.accessPool,stack.env,heads),
    governance: { store: governance,rules },realmSubmissions: new RealmSubmissionStore(stack.accessPool,stack.access,stack.env),
    realmSubmissionReads: new RealmSubmissionReads(stack.accessPool),
    account: { verify: async (request,scopes) => {
      if (scopes?.some(scope => deniedScopes.has(scope))) throw new AccountAssertionDenied('OAuth consent missing');
      const member = members.find(m => request.headers.get('authorization') === `Bearer ${m.token}`);
      if (!member) throw new AccountAssertionDenied('Bearer required');
      return member.principal;
    } } });
  const call = (member: Member | null,method: string,path: string,body?: unknown,key = randomUUID()) =>
    app.handle(new Request(`http://main.test${path}`,{ method,headers: {
      ...(member ? { authorization: `Bearer ${member.token}` } : {}),'content-type': 'application/json','idempotency-key': key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const person = async (name: string) => {
    const member = await stack.member(name);
    members.push(member);
    const result = await json<{ agent: string }>(await call(member,'POST','/v1/agents',{
      profile: 'agent-provision-v1',kind: 'person',displayName: name }),201);
    member.actor = result.agent;
    return member;
  };
  const created = await json<{ realm: string }>(await call(owner,'POST','/v1/spaces',{
    profile: 'space-realm-v1',name: 'End to end moderation',capabilities: ['realm'],actingSubject: owner.actor }),201);
  const realm = created.realm;
  const root = `/v1/realms/${realm.slice(-36)}`;
  await json(await call(owner,'POST',`${root}/management`,{ actingSubject: owner.actor }));
  const read = (member: Member,path: string) => call(member,'GET',`${path}${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(member.actor)}`);
  const settings = async (selfJoin = false,visibility = 'public') => {
    const before = await json<{ generation: string; ruleBasis: { revision: string | null } }>(await read(owner,`${root}/settings`));
    return json<{ generation: string; ruleBasis: { ref: string; revision: string; digest: string } }>(await call(owner,'PUT',`${root}/settings`,{
      actingSubject: owner.actor,expectedGeneration: before.generation,expectedRulesRevision: before.ruleBasis.revision,
      reason: 'Set community admission and rules',settings: { visibility,reviewRequired: true,whoMaySubmit: 'granted',selfJoin: visibility === 'public' && selfJoin,
        rules: [{ id: 'respect',title: { original: 'en',labels: { en: 'Respect others','zh-Hans': '尊重他人' } },
          body: { original: 'en',labels: { en: 'No personal abuse.','zh-Hans': '禁止人身攻击。' } },governanceRule: null }] } }),201);
  };
  const invite = async (member: Member,expiresInSeconds = 300) => json<InvitationResult>(await call(owner,'POST',`${root}/invitations`,{
    actingSubject: owner.actor,member: member.actor,expiresInSeconds }));
  const respond = (member: Member,id: string,action = 'accept',listed = false,key = randomUUID()) => call(member,'POST',
    `${root}/invitations/${id}/response`,{ actingSubject: member.actor,action,listed },key);
  const role = async (change: RoleCommand['change']) => {
    const before = await json<{ generation: string }>(await read(owner,`${root}/roles`));
    const input = { actingSubject: owner.actor,expectedGeneration: before.generation,reason: 'Assign review responsibility',change };
    const preview = await json<{ digest: string }>(await call(owner,'POST',`${root}/role-impact`,input));
    return json(await call(owner,'POST',`${root}/role-changes`,{ ...input,impactDigest: preview.digest }),201);
  };
  return { stack,owner,outsider,members,deniedScopes,measurements,call,read,person,realm,root,settings,invite,respond,role };
}

test('G314 joining: provisioned person consents, accepts only own invitation, retries atomically, opts into public roster',async () => {
  const s = await setup();
  try {
    const member = await s.person('Member');
    const consent = await json<{ consentReference: string }>(await s.call(member,'POST','/v1/me/membership-consents',{
      profile: 'access-membership-consent-v1',kind: 'realm',ownerSubject: s.realm,memberSubject: member.actor,
      expectedGeneration: '0',expectedPolicyRevision: '0',termsRevision: 'realm-membership-v1' }));
    expect(consent.consentReference).toBeString();
    expect((await s.call(s.outsider,'POST','/v1/me/membership-consents',{
      profile: 'access-membership-consent-v1',kind: 'realm',ownerSubject: s.realm,memberSubject: member.actor,
      expectedGeneration: '0',expectedPolicyRevision: '0',termsRevision: 'realm-membership-v1' })).status).toBe(403);
    const invited = await s.invite(member);
    const sent = await json<{ items: { id: string; member: string; createdAt: string; state: string }[] }>(
      await s.read(s.owner,`${s.root}/invitations`));
    expect(sent.items).toMatchObject([{ id: invited.invitation.id, member: member.actor, state: 'pending' }]);
    expect(Date.parse(sent.items[0]!.createdAt)).toBeGreaterThan(0);
    expect((await s.read(s.outsider,`${s.root}/invitations`)).status).toBe(403);
    const notices = new NotificationStore(s.stack.accessPool);
    notices.setDefaultReadSubjectReader(notificationProducerSubjectReader(
      s.stack.accessPool, s.stack.contentPool, s.stack.env));
    const producer = new NotificationProducer(s.stack.accessPool, null, s.stack.contentPool,
      s.stack.fuseki, notices, null);
    expect(await producer.runAccessOnce()).toBeGreaterThan(0);
    expect(await notices.unreadCount(member.principal)).toEqual({ count: 1, overflow: false });
    expect((await s.read(member,'/v1/me/realm-invitations')).headers.get('cache-control')).toBe('private, no-store');
    expect((await s.respond(s.outsider,invited.invitation.id)).status).toBe(403);
    expect((await s.call(s.outsider,'POST',`${s.root}/invitations`,{
      actingSubject: s.outsider.actor,member: member.actor,expiresInSeconds: 300 })).status).toBe(403);
    const key = randomUUID();
    const results = await Promise.all([s.respond(member,invited.invitation.id,'accept',false,key),s.respond(member,invited.invitation.id,'accept',false,key)]);
    const accepted = await Promise.all(results.map(r => json<InvitationResult>(r)));
    expect(accepted.map(r => r.replayed).sort()).toEqual([false,true]);
    expect(accepted[0]!.invitation.state).toBe('accepted');
    expect(await notices.unreadCount(member.principal)).toEqual({ count: 0, overflow: false });
    expect((await s.respond(member,invited.invitation.id,'decline',false,key)).status).toBe(409);
    expect((await s.respond(member,invited.invitation.id)).status).toBe(409);
    expect(await json(await s.call(null,'GET',`${s.root}/roster`))).toEqual({ items: [],nextCursor: null });
    await json(await s.call(member,'PUT',`${s.root}/roster/listing`,{
      actingSubject: member.actor,expectedMembershipGeneration: '1',listed: true }));
    expect(await json(await s.call(null,'GET',`${s.root}/roster`))).toMatchObject({ items: [{ agent: member.actor,displayName: 'Member',featured: false }] });
    expect((await s.call(s.outsider,'PUT',`${s.root}/roster/listing`,{
      actingSubject: member.actor,expectedMembershipGeneration: '1',listed: false })).status).toBe(403);
    await json(await s.call(s.owner,'PUT',`${s.root}/roster/featured`,{
      actingSubject: s.owner.actor,member: member.actor,expectedMembershipGeneration: '1',featured: true }));
    expect(await json(await s.call(null,'GET',`${s.root}/roster?featured=true`))).toMatchObject({ items: [{ agent: member.actor,featured: true }] });
    await json(await s.call(member,'PUT',`${s.root}/roster/listing`,{
      actingSubject: member.actor,expectedMembershipGeneration: '1',listed: false }));
    expect(await json(await s.call(null,'GET',`${s.root}/roster?featured=true`))).toEqual({ items: [],nextCursor: null });
    expect((await s.call(s.owner,'PUT',`${s.root}/roster/featured`,{
      actingSubject: s.owner.actor,member: member.actor,expectedMembershipGeneration: '1',featured: true })).status).toBe(409);
    const grants = (await s.stack.accessPool.query(`SELECT action FROM access.permission_grant WHERE recipient_subject = $1`,[member.actor])).rows;
    expect(grants).toEqual([{ action: 'access.membership.consent' }]);
    expect((await s.stack.accessPool.query(`SELECT count(*)::int AS n FROM access.membership_history WHERE membership_id IN
      (SELECT id FROM access.membership WHERE member_subject = $1)`,[member.actor])).rows[0].n).toBe(1);
  } finally { await s.stack.stop(); }
},120_000);

test('G314 joining: expired, declined, revoked, stale-policy and revoked-authority invitations never join',async () => {
  const s = await setup();
  try {
    const member = await s.person('Invitee');
    const declined = await s.invite(member);
    await json(await s.respond(member,declined.invitation.id,'decline'));
    expect((await s.respond(member,declined.invitation.id)).status).toBe(409);
    const expired = await s.invite(member);
    await s.stack.accessPool.query(`UPDATE access.realm_invitation SET expires_at = now() - interval '1 second' WHERE id = $1`,[expired.invitation.id]);
    expect((await s.respond(member,expired.invitation.id)).status).toBe(409);
    const revoked = await s.invite(member);
    await json(await s.call(s.owner,'POST',`${s.root}/invitations/${revoked.invitation.id}/revoke`,{ actingSubject: s.owner.actor }));
    expect((await s.respond(member,revoked.invitation.id)).status).toBe(409);
    const stale = await s.invite(member);
    await s.stack.accessPool.query(`UPDATE access.membership_policy SET revision = revision + 1,terms_revision = 'terms-v2'
      WHERE kind = 'realm' AND owner_subject = $1`,[s.realm]);
    expect([403,409]).toContain((await s.respond(member,stale.invitation.id)).status);
    const revokedAuthority = await s.invite(member);
    await s.stack.accessPool.query(`UPDATE access.permission_grant SET active = false WHERE recipient_subject = $1
      AND scope_id = $2 AND action = 'realm.members.manage'`,[s.owner.actor,`governance:realm:${s.realm}`]);
    expect((await s.respond(member,revokedAuthority.invitation.id)).status).toBe(403);
    expect((await s.stack.accessPool.query(`SELECT count(*)::int AS n FROM access.membership WHERE owner_subject = $1`,[s.realm])).rows[0].n).toBe(0);
    expect((await s.stack.accessPool.query(`SELECT count(*)::int AS n FROM access.membership_consent_use u
      JOIN access.membership_consent c ON c.id = u.consent_id WHERE c.owner_subject = $1`,[s.realm])).rows[0].n).toBe(0);
  } finally { await s.stack.stop(); }
},120_000);

test('G314 self-join: only explicitly open public Realms, bans and revoked consent fail closed, private roster denied',async () => {
  const s = await setup();
  try {
    const member = await s.person('Self joiner');
    const input = { actingSubject: member.actor,expectedMembershipGeneration: '0',expectedPolicyRevision: '0',
      termsRevision: 'realm-membership-v1',listed: true };
    expect((await s.call(member,'POST',`${s.root}/join`,input)).status).toBe(403);
    await s.settings(true);
    const policy = await json<{ policyRevision: string }>(await s.read(member,`${s.root}/joining`));
    expect(policy).toMatchObject({ selfJoin: true,state: 'absent' });
    input.expectedPolicyRevision = policy.policyRevision;
    await s.stack.accessPool.query(`INSERT INTO access.membership_ban (kind,owner_subject,member_subject,active,reason_ref)
      VALUES ('realm',$1,$2,true,'fixture-ban')`,[s.realm,member.actor]);
    expect((await s.call(member,'POST',`${s.root}/join`,input)).status).toBe(403);
    await s.stack.accessPool.query(`UPDATE access.membership_ban SET active = false WHERE owner_subject = $1`,[s.realm]);
    await s.stack.accessPool.query(`UPDATE access.permission_grant SET active = false WHERE recipient_subject = $1`,[member.actor]);
    expect((await s.call(member,'POST',`${s.root}/join`,input)).status).toBe(403);
    const second = await s.person('Listed person');
    const key = randomUUID();
    s.measurements.sql = 0;
    await json(await s.call(second,'POST',`${s.root}/join`,{ ...input,actingSubject: second.actor },key));
    expect(s.measurements.sql).toBeLessThanOrEqual(REALM_JOIN_COST.sqlStatements);
    expect(await json(await s.call(second,'POST',`${s.root}/join`,{ ...input,actingSubject: second.actor },key))).toMatchObject({ replayed: true });
    await s.settings(true,'private');
    expect((await s.call(null,'GET',`${s.root}/roster`)).status).toBe(403);
    expect((await s.call(member,'POST',`${s.root}/join`,input)).status).toBe(403);
    await s.stack.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id');
    expect((await s.read(second,'/v1/me/realm-invitations')).status).toBe(503);
    await s.stack.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id');
  } finally { await s.stack.stop(); }
},120_000);

test('G314 reviewers: owner and role bundles decide real submissions; revocation fences prepared admissions',async () => {
  const s = await setup();
  try {
    const reviewer = await s.person('Reviewer');
    const author = await s.stack.member('author'); s.members.push(author);
    await author.grant(`submission:submit:${s.realm}`,'submission.submit');
    const candidate = async (): Promise<SubmissionView> => {
      const work = await s.stack.privateWork(author.actor);
      const contribution = await s.stack.contribution(work.work,author.actor,'en','A reviewable contribution');
      const rows = (await s.stack.fuseki.query(`SELECT ?draft WHERE { GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(contribution.decision)} <${RV}selectedDraft> ?draft } }`)).results!.bindings;
      const input: SubmissionInput = { actingSubject: author.actor,kind: 'contribution',work: work.work,mainVersion: work.mainVersion,
        contribution: contribution.contribution,publicationDecision: contribution.decision,selectedDraft: rows[0]!.draft!.value,correctionOf: null };
      return (await json<{ submission: SubmissionView }>(await s.call(author,'POST',`${s.root}/submissions`,input),201)).submission;
    };
    const decide = (member: Member,row: SubmissionView,outcome: 'accept'|'reject'|'request-changes') => s.call(member,'POST',
      `${s.root}/submissions/${row.id}/decisions`,{ actingSubject: member.actor,expectedRevision: row.revision,outcome,
        expectedSelectionHead: null,publicReason: outcome === 'accept' ? null : 'Please improve the attribution.',internalNote: null });
    const first = await candidate();
    expect((await decide(reviewer,first,'accept')).status).toBe(403);
    await json(await decide(s.owner,first,'accept'));
    const roleId = randomUUID();
    await s.role({ kind: 'role',roleId,name: 'Reviewers',permissions: ['review.decide','publication.adopt'] });
    await s.role({ kind: 'assignment',roleId,member: reviewer.actor,assigned: true,validUntil: new Date(Date.now() + 300_000).toISOString() });
    for (const outcome of ['accept','reject','request-changes'] as const) await json(await decide(reviewer,await candidate(),outcome));
    expect((await s.read(reviewer,`${s.root}/moderation?type=contribution_submission`)).status).toBe(200);
    expect((await s.read(reviewer,`${s.root}/moderation`)).status).toBe(404);
    const digest = 'e'.repeat(64);
    const pending = await s.stack.access.register({ principal: reviewer.principal,actingSubject: reviewer.actor,
      action: 'review.decide',scope: `review:decide:${s.realm}`,idempotencyKey: randomUUID(),requestDigest: digest });
    await s.role({ kind: 'assignment',roleId,member: reviewer.actor,assigned: false,validUntil: new Date(Date.now() + 300_000).toISOString() });
    await expect(s.stack.access.claim(pending.id,digest)).rejects.toThrow();
    expect((await decide(reviewer,await candidate(),'reject')).status).toBe(403);
    await s.stack.accessPool.query(`UPDATE access.permission_grant SET active = false
      WHERE recipient_subject = $1 AND action IN ('review.decide','publication.adopt')`,[s.owner.actor]);
    await json(await s.call(s.owner,'POST',`${s.root}/management`,{ actingSubject: s.owner.actor }));
    expect((await decide(s.owner,await candidate(),'reject')).status).toBe(403);
  } finally { await s.stack.stop(); }
},120_000);

test('G314 moderation basis: retained private statement, exact evidence and rule feed a real decision; denied and stale reads',async () => {
  const s = await setup();
  try {
    await s.settings();
    const reporter = await s.stack.member('reporter'); s.members.push(reporter);
    const work = await s.stack.publicWork(reporter.actor);
    await reporter.grant(`work:read:${work.work}`,'work.read');
    const head = (await s.stack.fuseki.query(`SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(work.work)} <${RV}head> ?head } }`)).results!.bindings[0]!.head!.value;
    const makeReport = async (statement: string) => {
      const key = randomUUID();
      return json<{ caseId: string; evidenceDigest: string }>(await s.call(reporter,'POST','/v1/reports',{
        profile: 'content-report-v1',actingSubject: reporter.actor,authority: { kind: 'realm',scopeId: `governance:realm:${s.realm}` },
        context: s.realm,target: { owner: 'graph',resource: work.work,component: 'title' },disclosure: 'private',
        reasonCode: 'abuse',statement,evidence: [{ owner: 'graph',resource: work.work,component: 'title',revision: head,locator: null }],idempotencyKey: key },key),201);
    };
    const report = await makeReport('Private explanation only moderators may see');
    await makeReport('A second independent statement');
    const path = `${s.root}/moderation/${report.caseId}`;
    expect((await s.read(s.outsider,path)).status).toBe(403);
    expect((await s.read(reporter,path)).status).toBe(403);
    type Basis = { generation: string; ruleBasis: { ref: string; revision: string; digest: string };
      reports: { statement: string; evidenceDigest: string; evidence: { expectedHead: string; revision: string }[] }[]; nextCursor: string };
    const basis = await json<Basis>(await s.read(s.owner,`${path}?limit=1`));
    expect(basis.reports[0]!.statement).toBe('Private explanation only moderators may see');
    expect(basis.reports[0]!.evidenceDigest).toBe(report.evidenceDigest);
    expect(basis.reports[0]!.evidence[0]).toMatchObject({ revision: head,expectedHead: head });
    expect(basis.nextCursor).toBeString();
    expect((await json<Basis>(await s.read(s.owner,`${path}?cursor=${basis.nextCursor}`))).reports[0]!.statement).toBe('A second independent statement');
    const key = randomUUID();
    const decision = { profile: 'moderation-decision-v1',caseId: report.caseId,expectedGeneration: basis.generation,
      actingSubject: s.owner.actor,outcome: 'restrict',targets: [{ owner: 'graph',resource: work.work,component: 'title',locator: null,
        scopeKind: 'exact_revision',revision: head,expectedHead: basis.reports[0]!.evidence[0]!.expectedHead,effect: 'disclosure' }],
      rule: { ref: basis.ruleBasis.ref,revision: basis.ruleBasis.revision,digest: basis.ruleBasis.digest },evidenceDigest: report.evidenceDigest,
      reversesDecisionId: null,answersStepId: null,rationale: 'Violates the Realm rule',disclosure: 'private',idempotencyKey: key };
    await json(await s.call(s.owner,'POST','/v1/moderation/decisions',decision,key),202);
    await json(await s.call(s.owner,'POST','/v1/moderation/decisions',decision,key),200);
    expect(await json(await s.read(s.owner,`${s.root}/moderation`)))
      .toMatchObject({ items: [] });
    expect(await json(await s.read(s.owner,`${s.root}/moderation?state=closed`)))
      .toMatchObject({ items: [{ id: report.caseId, decisionHead: expect.any(String) }] });
    expect(await json(await s.read(s.owner,'/v1/me/managed-realms')))
      .toMatchObject({ items: [{ openCount: { value: 0, kind: 'exact' } }] });
    expect((await s.read(s.owner,`${path}?cursor=${basis.nextCursor}`)).status).toBe(409);
    await s.stack.accessPool.query(`UPDATE access.permission_grant SET active = false WHERE recipient_subject = $1
      AND scope_id = $2 AND action = 'governance.moderate'`,[s.owner.actor,`governance:realm:${s.realm}`]);
    expect((await s.read(s.owner,path)).status).toBe(403);
  } finally { await s.stack.stop(); }
},120_000);

test('G314 managed Realms: acting identity, scoped permissions/counts and OAuth ceilings; revocation hides the Realm',async () => {
  const s = await setup();
  try {
    const reviewer = await s.person('Queue reviewer');
    const roleId = randomUUID();
    await s.role({ kind: 'role',roleId,name: 'Review queue',permissions: ['review.decide'] });
    await s.role({ kind: 'assignment',roleId,member: reviewer.actor,assigned: true,validUntil: new Date(Date.now() + 300_000).toISOString() });
    const caseId = randomUUID();
    await s.stack.accessPool.query(`INSERT INTO access.governance_case
      (id,kind,authority_kind,authority_scope_id,context,target_owner,target_resource,target_component,disclosure)
      VALUES ($1,'content_report','realm',$2,$3,'graph',$4,'title','private')`,[caseId,`governance:realm:${s.realm}`,s.realm,s.owner.actor]);
    const generation = (await json<{ generation: string }>(await s.read(s.owner,`${s.root}/roles`))).generation;
    await json(await s.call(s.owner,'POST',`${s.root}/escalations`,{ actingSubject: s.owner.actor,expectedGeneration: generation,
      reason: 'Needs owner review',itemKind: 'report',itemId: caseId,expectedItemGeneration: '0' }),201);
    const result = await json<{ items: { permissions: string[]; openCount: unknown; escalatedCount: unknown; latestActivity: string }[] }>(await s.read(s.owner,'/v1/me/managed-realms'));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ openCount: { value: 1,kind: 'exact' },escalatedCount: { value: 1,kind: 'exact' } });
    expect(result.items[0]!.permissions).toContain('publication.adopt');
    expect(result.items[0]!.latestActivity).toBeString();
    expect(await json(await s.read(reviewer,'/v1/me/managed-realms'))).toMatchObject({ items: [{ permissions: ['review.decide'],openCount: { value: 0 } }] });
    expect((await s.call(s.outsider,'GET',`/v1/me/managed-realms?actingSubject=${encodeURIComponent(s.owner.actor)}`)).status).toBe(403);
    s.deniedScopes.add('governance:decide');
    expect(await json(await s.read(s.owner,'/v1/me/managed-realms'))).toMatchObject({ items: [{ permissions: ['publication.adopt','review.decide'],openCount: { value: 0 } }] });
    s.deniedScopes.clear();
    await s.role({ kind: 'assignment',roleId,member: reviewer.actor,assigned: false,validUntil: new Date(Date.now() + 300_000).toISOString() });
    expect(await json(await s.read(reviewer,'/v1/me/managed-realms'))).toEqual({ items: [],nextCursor: null });
  } finally { await s.stack.stop(); }
},120_000);

test('G314 cost: exact queue aggregates stay constant across history growth and update atomically with closure',async () => {
  const s = await setup();
  try {
    const readCounts = async () => {
      s.measurements.sql = 0; s.measurements.graph = 0;
      const page = await json<{ items: { openCount: { value: number; kind: string }; escalatedCount: { value: number } }[] }>(await s.read(s.owner,'/v1/me/managed-realms'));
      expect(s.measurements.graph).toBeLessThanOrEqual(MANAGED_REALMS_COST.graphCalls);
      return { item: page.items[0]!,sql: s.measurements.sql };
    };
    const empty = await readCounts();
    for (const size of [10,1000]) {
      await s.stack.accessPool.query(`INSERT INTO access.governance_case
        (id,kind,authority_kind,authority_scope_id,context,target_owner,target_resource,target_component,disclosure)
        SELECT gen_random_uuid(),'content_report','realm',$1,$2,'graph','https://rezics.com/id/' || gen_random_uuid(),'title','private'
        FROM generate_series(1,$3::int - (SELECT count(*)::int FROM access.governance_case WHERE context = $2))`,
      [`governance:realm:${s.realm}`,s.realm,size]);
      const grown = await readCounts();
      expect(grown.sql).toBe(empty.sql);
      expect(grown.item.openCount).toEqual({ value: size,kind: 'exact' });
    }
    const queue = await json<{ items: { id: string }[] }>(await s.read(s.owner,`${s.root}/moderation?state=open&type=content_report`));
    const caseId = queue.items[0]!.id;
    await json(await s.call(s.owner,'POST',`${s.root}/escalations`,{ actingSubject: s.owner.actor,expectedGeneration: '0',
      reason: 'Owner disposition needed',itemKind: 'report',itemId: caseId,expectedItemGeneration: '0' }),201);
    expect((await readCounts()).item.escalatedCount.value).toBe(1);
    await s.stack.accessPool.query(`UPDATE access.governance_case SET state = 'closed',closed_at = clock_timestamp()
      WHERE context = $1`,[s.realm]);
    const closed = await readCounts();
    expect(closed.sql).toBe(empty.sql);
    expect(closed.item.openCount).toEqual({ value: 0,kind: 'exact' });
    expect(closed.item.escalatedCount.value).toBe(0);
  } finally { await s.stack.stop(); }
},120_000);

test('G314 roster: bounded public pages, consent revocation and membership episodes prevent restored exposure',async () => {
  const s = await setup();
  try {
    await s.settings(true);
    const people = [];
    for (const name of ['One','Two','Three']) {
      const person = await s.person(name); people.push(person);
      const policy = await json<{ policyRevision: string }>(await s.read(person,`${s.root}/joining`));
      await json(await s.call(person,'POST',`${s.root}/join`,{ actingSubject: person.actor,expectedMembershipGeneration: '0',
        expectedPolicyRevision: policy.policyRevision,termsRevision: 'realm-membership-v1',listed: true }));
    }
    const collected: string[] = [];
    let after: string | null = null;
    do {
      s.measurements.sql = 0; s.measurements.graph = 0;
      const page: { items: { agent: string }[]; nextCursor: string | null } = await json(await s.call(null,'GET',
        `${s.root}/roster?limit=1${after ? `&after=${encodeURIComponent(after)}` : ''}`));
      expect(s.measurements.sql).toBeLessThanOrEqual(REALM_ROSTER_COST.sqlStatements);
      expect(s.measurements.graph).toBe(REALM_ROSTER_COST.graphCalls);
      collected.push(...page.items.map(item => item.agent)); after = page.nextCursor;
    } while (after);
    expect(collected).toEqual(people.map(person => person.actor).sort());
    const person = people[0]!;
    await json(await s.call(s.owner,'PUT',`${s.root}/roster/featured`,{
      actingSubject: s.owner.actor,member: person.actor,expectedMembershipGeneration: '1',featured: true }));
    const generation = (await json<{ generation: string }>(await s.read(s.owner,`${s.root}/roles`))).generation;
    await json(await s.call(s.owner,'POST',`${s.root}/members`,{ actingSubject: s.owner.actor,expectedGeneration: generation,
      member: person.actor,expectedMembershipGeneration: '1',action: 'remove',reason: 'Remove old episode',consent: null,durationSeconds: null }),201);
    const policy = await json<{ policyRevision: string }>(await s.read(person,`${s.root}/joining`));
    await json(await s.call(person,'POST',`${s.root}/join`,{ actingSubject: person.actor,expectedMembershipGeneration: '2',
      expectedPolicyRevision: policy.policyRevision,termsRevision: 'realm-membership-v1',listed: false }));
    expect(await json(await s.call(null,'GET',`${s.root}/roster?featured=true`))).toEqual({ items: [],nextCursor: null });
    expect((await s.call(person,'PUT',`${s.root}/roster/listing`,{
      actingSubject: person.actor,expectedMembershipGeneration: '1',listed: true })).status).toBe(409);
    const rows = await json<{ items: { agent: string }[] }>(await s.call(null,'GET',`${s.root}/roster`));
    expect(rows.items.map(item => item.agent)).not.toContain(person.actor);
  } finally { await s.stack.stop(); }
},120_000);
