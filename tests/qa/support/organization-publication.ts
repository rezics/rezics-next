import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { ORGANIZATION_MODERATION_ACTION, type OrganizationPublicationTarget }
  from '../../../services/main/src/modules/access/organization-publication.ts';
import { createAdmittedTextContribution } from '../../../services/main/src/modules/contribution/create-admitted.ts';
import { publishAdmittedTextContribution } from '../../../services/main/src/modules/contribution/publish-admitted.ts';
import { createAdmittedRealmSpace } from '../../../services/main/src/modules/space/create-admitted.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { createAdmittedMetadataWork } from '../../../services/main/src/modules/work/create-admitted.ts';
import { selectAdmittedMainDefault } from '../../../services/main/src/modules/work/select-main-admitted.ts';
import { selectAdmittedRealmLocal } from '../../../services/main/src/modules/work/select-realm-admitted.ts';
import { seedOrgRealm } from './org-realm.ts';

export const moderationScopes = 'openid access:manage work:create work:edit work:read space:create realm:adopt realm:reject';
export type ModerationPost = (path: string, token: string, body: object, key?: string) => Promise<Response>;

/** Small scenario, actual admitted commands. Installation records never synthesize graph receipts. */
export async function organizationPublicationFixture(pool: Pool, env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  accounts: { issuer: string; realmAccount: string; orgAccount: string; realmToken: string; orgToken: string },
  post: ModerationPost) {
  const f = await seedOrgRealm(pool, accounts.issuer, { realm: accounts.realmAccount, org: accounts.orgAccount });
  const access = new AccessAdmissionRegistry(pool);
  const request = (token: string) => new Request('http://main.local/', {
    headers: { authorization: `Bearer ${token}` } });
  const realmRequest = request(accounts.realmToken), orgRequest = request(accounts.orgToken);
  const grant = async (subject: string, principal: string, scope: string, action: string) => {
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    const representationId = randomUUID(), grantId = randomUUID();
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,$4,clock_timestamp() + interval '1 hour')`, [representationId, principal, subject, action]);
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,$4,clock_timestamp() + interval '1 hour')`, [grantId, subject, scope, action]);
    return { representationId, grantId };
  };
  const orgGrant = (scope: string, action: string) => grant(f.org, f.orgPrincipalId, scope, action);
  const realmGrant = (scope: string, action: string) => grant(f.realmManager, f.realmPrincipalId, scope, action);
  await orgGrant('work:create:root', 'work.create');
  const work = await createAdmittedMetadataWork(env, account, access, orgRequest,
    { title: 'Independent organization publication', actingSubject: f.org, idempotencyKey: randomUUID() });
  await orgGrant(`contribution:create:${work.work}`, 'contribution.create');
  const body = `organizationmoderationtoken${randomUUID().replaceAll('-', '')}`;
  const draft = await createAdmittedTextContribution(env, account, access, orgRequest,
    { work: work.work, actingSubject: f.org, body, language: 'en', idempotencyKey: randomUUID() });
  if (!draft.contribution || !draft.draftRevision) throw new Error('fixture draft missing');
  await orgGrant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
  const published = await publishAdmittedTextContribution(env, account, access, orgRequest,
    { contribution: draft.contribution, expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: f.org, idempotencyKey: randomUUID() });
  if (!published.publicationDecision) throw new Error('fixture publication missing');
  await orgGrant(`publication:select:${work.mainVersion}`, 'publication.select');
  const main = await selectAdmittedMainDefault(env, account, access, orgRequest,
    { context: { kind: 'main-version-default', id: work.mainVersion }, work: work.work,
      contribution: draft.contribution, publicationDecision: published.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: f.org, idempotencyKey: randomUUID() });
  await realmGrant('space:create:root', 'space.create');
  const realms = [];
  for (const name of ['Target Realm', 'Independent other Realm']) {
    const space = await createAdmittedRealmSpace(env, account, access, realmRequest,
      { name, actingSubject: f.realmManager, idempotencyKey: randomUUID() });
    if (!space.realm) throw new Error('fixture Realm missing');
    await pool.query(`INSERT INTO access.org_realm_policy (realm, manager_subject, revision, terms_revision)
      VALUES ($1,$2,1,'terms-1')`, [space.realm, f.realmManager]);
    await realmGrant(`publication:adopt:${space.realm}`, 'publication.adopt');
    const selection = await selectAdmittedRealmLocal(env, account, access, realmRequest,
      { context: { kind: 'realm-local', id: space.realm }, work: work.work, mainVersion: work.mainVersion,
        contribution: draft.contribution, publicationDecision: published.publicationDecision,
        expectedSelectionHead: null, selectionBasis: 'realm-manager-review',
        actingSubject: f.realmManager, idempotencyKey: randomUUID() });
    if (!selection.selection) throw new Error('fixture Realm selection missing');
    realms.push({ space, realm: space.realm, selection });
  }
  const [local, other] = realms;
  if (!local || !other) throw new Error('fixture Realms missing');
  const join = async (realm: string, generation = '0') => {
    const basis = { realm, organizationSubject: f.org, expectedGeneration: generation, expectedPolicyRevision: '1' };
    const proposal = await post('/v1/access/org-realm-proposals', accounts.realmToken,
      { ...basis, profile: 'access-org-realm-proposal-v1', termsRevision: 'terms-1' });
    if (proposal.status !== 200) throw new Error(`fixture invitation ${proposal.status}: ${await proposal.text()}`);
    const { proposalId } = await proposal.json() as { proposalId: string };
    const joined = await post('/v1/access/org-realm-changes', accounts.orgToken,
      { ...basis, profile: 'access-org-realm-change-v1', action: 'join', proposalId, termsRevision: 'terms-1' });
    if (joined.status !== 200) throw new Error(`fixture join ${joined.status}: ${await joined.text()}`);
    return await joined.json() as { participationId: string; generation: string; proposalId: string };
  };
  const joined = await join(local.realm), otherJoined = await join(other.realm);
  const manager = await realmGrant(`publication:reject:${local.realm}`, ORGANIZATION_MODERATION_ACTION);
  const target: OrganizationPublicationTarget = {
    realm: local.realm, organizationSubject: f.org, participationId: joined.participationId,
    participationGeneration: joined.generation, proposalId: joined.proposalId, policyRevision: '1',
    work: work.work, mainVersion: work.mainVersion, expectedWorkHead: work.workRevision,
    selection: local.selection.selection!, contribution: draft.contribution,
    publicationDecision: published.publicationDecision, selectedDraft: draft.draftRevision,
    actingSubject: f.realmManager, representationId: manager.representationId, representationGeneration: '0',
  };
  return { f, access, grant, orgGrant, realmGrant, request, realmRequest, orgRequest,
    work, body, draft, published, main, local, other, joined, otherJoined, manager, target, join };
}
