import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync,
  readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { AccessAdmissionRegistry, AdmissionDenied } from '../src/modules/access/admission.ts';
import { AccessOrgRealmParticipation } from '../src/modules/access/org-realm-participation.ts';
import { OrgRealmDenied } from '../src/modules/access/org-realm-authority.ts';
import { AccessOrganizationModeration } from '../src/modules/access/organization-moderation.ts';
import { ORGANIZATION_MODERATION_ACTION } from '../src/modules/access/organization-publication.ts';
import { textPublicationReceiptIri } from '../src/modules/contribution/publish.ts';
import { organizationRejectionInput } from '../src/modules/work/reject-organization-admitted.ts';
import { realmRejectionDigest } from '../src/modules/work/reject-realm.ts';
import { seedOrgRealm } from '../../../tests/qa/support/org-realm.ts';
import { seedManagedOrganization } from '../../../tests/qa/support/managed-organization.ts';
import { AccessManagedOrganizations, type ManagedOrgChange } from '../src/modules/access/managed-organizations.ts';
import { AccessRepresentedMembershipAuthority } from '../src/modules/access/represented-membership-authority.ts';
import { AccessMemberships } from '../src/modules/access/memberships.ts';
import { MANAGED_ORG_ACTION, ManagedOrgDenied, ManagedOrgStale } from '../src/modules/access/managed-org-authority.ts';
import { accessOutboxCoverage, accessStateCoverage } from '../src/modules/work/restore-lineage.ts';
import { assertPgRecoveryFrontier, PgRecoveryFrontierConflict,
  type PgRecoveryFrontier } from '../src/modules/work/pg-recovery-frontier.ts';
import { openRecoveryPayload, RecoveryEnvelopeConflict,
  type RecoveryEnvelope } from '../../account/src/recovery-envelope.ts';

const root = resolve(import.meta.dir, '../../..');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('OPS03/IAM07/IAM06/IAM23/IAM24: archived Access WAL restores exact authority and participation (partial)', async () => {
  const state = join(root, '.temp', `access-pitr-${Bun.randomUUIDv7()}`);
  const manifestKey = 'ab'.repeat(32);
  const primaryData = join(state, 'primary');
  const baseBackup = join(state, 'base-backup');
  const incompleteData = join(state, 'incomplete');
  const incompleteArchive = join(state, 'incomplete-wal');
  const restoredData = join(state, 'restored');
  const walArchive = join(state, 'wal-archive');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(walArchive, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', primaryData, '-A', 'trust', '--no-instructions'], { cwd: state });
  appendFileSync(join(primaryData, 'postgresql.conf'), `\nwal_level = replica\narchive_mode = on\n` +
    `unix_socket_directories = ''\n` +
    `archive_command = 'test ! -e ${walArchive}/%f && cp %p ${walArchive}/%f'\n`);
  const primaryPort = await freePort();
  let primaryStarted = false;
  let incompleteStarted = false;
  let restoredStarted = false;
  let primary: Pool | undefined;
  let incomplete: Pool | undefined;
  let restored: Pool | undefined;
  const startRecovery = async (data: string, archive: string, label: string) => {
    cpSync(baseBackup, data, { recursive: true });
    rmSync(join(data, 'pg_wal'), { recursive: true });
    mkdirSync(join(data, 'pg_wal'), { mode: 0o700 });
    appendFileSync(join(data, 'postgresql.auto.conf'),
      `\narchive_mode = off\nrestore_command = 'cp ${archive}/%f %p'\n`);
    writeFileSync(join(data, 'recovery.signal'), '');
    const port = await freePort();
    execFileSync('pg_ctl', ['-D', data, '-l', join(state, `${label}.log`),
      '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start'], { cwd: state });
    if (label === 'incomplete') incompleteStarted = true;
    else restoredStarted = true;
    const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres' });
    let recovering = true;
    for (let attempt = 0; attempt < 120; attempt++) {
      recovering = (await pool.query<{ recovering: boolean }>('SELECT pg_is_in_recovery() AS recovering'))
        .rows[0]?.recovering ?? true;
      if (!recovering) break;
      await Bun.sleep(100);
    }
    expect(recovering).toBe(false);
    return pool;
  };
  try {
    execFileSync('pg_ctl', ['-D', primaryData, '-l', join(state, 'primary.log'),
      '-o', `-h 127.0.0.1 -p ${primaryPort}`, '-w', 'start'], { cwd: state });
    primaryStarted = true;
    primary = new Pool({ host: '127.0.0.1', port: primaryPort, user: process.env.USER,
      database: 'postgres' });
    const migrations = join(root, 'services/main/migrations/access');
    for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: migrations })].sort()) {
      await primary.query(readFileSync(join(migrations, file), 'utf8'));
    }
    const principalId = Bun.randomUUIDv7();
    const actingSubject = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    const principal = { issuer: 'https://account.pitr.test', subject: 'pitr-user' };
    const request = { principal, actingSubject, scope: 'work:create:root',
      action: 'work.create', idempotencyKey: 'before-backup',
      requestDigest: createHash('sha256').update('before-backup').digest('hex') };
    await primary.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principalId, principal.issuer, principal.subject]);
    await primary.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root')");
    await primary.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actingSubject]);
    await primary.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'work.create', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actingSubject]);
    await primary.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, 'work:create:root', 'work.create', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actingSubject]);
    const registry = new AccessAdmissionRegistry(primary);
    const admitted = await registry.register(request);
    expect(admitted.authorityEpoch).toBe('0');

    execFileSync('pg_basebackup', ['-D', baseBackup, '-Fp', '-Xs', '--checkpoint=fast',
      '-h', '127.0.0.1', '-p', String(primaryPort), '-U', process.env.USER ?? 'edge'], { cwd: state });
    // This local PostgreSQL package omits pg_waldump; WAL replay is checked below.
    execFileSync('pg_verifybackup', ['--no-parse-wal', baseBackup], { cwd: state });
    // These episodes occur after the base backup and must arrive through archived WAL.
    const orgFixture = await seedOrgRealm(primary, 'https://account.pitr.test',
      { realm: 'realm-manager', org: 'organization-manager' });
    const orgRealm = new AccessOrgRealmParticipation(primary);
    const orgBasis = { realm: orgFixture.realm, organizationSubject: orgFixture.org,
      expectedGeneration: '0', expectedPolicyRevision: '1' };
    const proposal = await orgRealm.propose(orgFixture.realmPrincipal,
      { ...orgBasis, termsRevision: 'terms-1' }, 'pitr-proposal');
    const orgJoin = { ...orgBasis, action: 'join' as const, proposalId: proposal.proposalId,
      termsRevision: 'terms-1' };
    const joined = await orgRealm.change(orgFixture.orgPrincipal, orgJoin, 'pitr-org-join');
    // Storage-only WAL fixture: graph evidence itself is qualified by the paired
    // real graph-loss test, not by these synthetic receipt coordinates.
    const native = () => `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    const contribution = native(), managerRepresentation = Bun.randomUUIDv7();
    const publicationScope = `contribution:publish:${contribution}`;
    const moderationScope = `publication:reject:${orgFixture.realm}`;
    await primary.query('INSERT INTO access.scope_gate (id) VALUES ($1),($2)', [publicationScope, moderationScope]);
    for (const [subject, identity, scope, action, representation] of [
      [orgFixture.org, orgFixture.orgPrincipalId, publicationScope, 'contribution.publish', Bun.randomUUIDv7()],
      [orgFixture.realmManager, orgFixture.realmPrincipalId, moderationScope, ORGANIZATION_MODERATION_ACTION, managerRepresentation],
    ]) {
      await primary.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [representation, identity, subject, action]);
      await primary.query(`INSERT INTO access.permission_grant
        (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [Bun.randomUUIDv7(), subject, scope, action]);
    }
    const publisher = await registry.register({ principal: orgFixture.orgPrincipal,
      actingSubject: orgFixture.org, scope: publicationScope, action: 'contribution.publish',
      idempotencyKey: 'pitr-publisher', requestDigest: 'a'.repeat(64) });
    await registry.claim(publisher.id, publisher.requestDigest);
    const publisherProof = { admissionId: publisher.id, receipt: textPublicationReceiptIri(publisher.id),
      outcome: 'succeeded' as const, requestDigest: publisher.requestDigest, authorityEpoch: publisher.authorityEpoch,
      scope: publicationScope, dataEpoch: 'pitr-graph-fixture', sequence: '1' };
    await registry.recordGraphOutcome(publisher.id, publisherProof);
    const moderationTarget = { realm: orgFixture.realm, organizationSubject: orgFixture.org,
      participationId: joined.participationId!, participationGeneration: joined.generation,
      proposalId: proposal.proposalId, policyRevision: '1', work: native(), mainVersion: native(),
      expectedWorkHead: native(), selection: native(), contribution, publicationDecision: native(), selectedDraft: native(),
      actingSubject: orgFixture.realmManager, representationId: managerRepresentation, representationGeneration: '0' };
    const moderation = await new AccessOrganizationModeration(primary).admit(orgFixture.realmPrincipal,
      moderationTarget, publisherProof, 'pitr-moderation', realmRejectionDigest(organizationRejectionInput(moderationTarget)));
    const moderationRow = (await primary.query('SELECT * FROM access.organization_publication_moderation WHERE admission_id = $1', [moderation.id])).rows[0];
    const orgSuspend = { ...orgBasis, expectedGeneration: '1', action: 'suspend' as const,
      reasonReference: 'pitr-suspension' };
    const suspended = await orgRealm.change(orgFixture.realmPrincipal, orgSuspend, 'pitr-org-suspend');
    expect(suspended).toMatchObject({ state: 'suspended', generation: '2', banned: true });
    // Explicit management is not created or removed by structural participation.
    // Grant, protected effect and revoke all occur after the saved base backup.
    const managedFixture = await seedManagedOrganization(primary, orgFixture);
    const managedOwner = new AccessManagedOrganizations(primary);
    const managedIssue: ManagedOrgChange = { operation: 'issue', organizationSubject: orgFixture.org,
      expectedAuthorityEpoch: '2', recipient: { kind: 'realm', id: orgFixture.realm },
      actions: [MANAGED_ORG_ACTION.roster], delegationCeiling: 0,
      validFrom: new Date(Date.now() - 1000).toISOString(), validUntil: new Date(Date.now() + 1200_000).toISOString() };
    const managedGrant = await managedOwner.change(orgFixture.orgPrincipal, managedIssue, 'pitr-managed-issue');
    const managedPolicy = { organizationSubject: orgFixture.org, recipient: { kind: 'realm' as const, id: orgFixture.realm },
      grantId: managedGrant.grantId, expectedGrantGeneration: '1',
      representationId: managedFixture.recipientRepresentation, expectedRepresentationGeneration: '0',
      expectedPolicyRevision: '1', admissionsOpen: false };
    const managedEffect = await managedOwner.setRosterPolicy(orgFixture.realmPrincipal, managedPolicy, 'pitr-managed-policy');
    const managedRevoke: ManagedOrgChange = { operation: 'revoke', organizationSubject: orgFixture.org,
      expectedAuthorityEpoch: '4', grantId: managedGrant.grantId, expectedGeneration: '1' };
    const managedRevoked = await managedOwner.change(orgFixture.orgPrincipal, managedRevoke, 'pitr-managed-revoke');
    // The paired move is absent from the base backup; both effects and the receipt must replay from WAL.
    const transfer = await seedOrgRealm(primary, 'https://account.pitr.test',
      { realm: 'transfer-realm-manager', org: 'transfer-organization-manager' });
    const transferBasis = { realm: transfer.realm, organizationSubject: transfer.org,
      expectedGeneration: '0', expectedPolicyRevision: '1', termsRevision: 'terms-1' };
    const sourceInvitation = await orgRealm.propose(transfer.realmPrincipal, transferBasis, 'pitr-move-source-proposal');
    const transferSource = await orgRealm.change(transfer.orgPrincipal,
      { ...transferBasis, action: 'join', proposalId: sourceInvitation.proposalId }, 'pitr-move-source-join');
    const targetInvitation = await orgRealm.propose(transfer.realmPrincipal,
      { ...transferBasis, realm: transfer.otherRealm }, 'pitr-move-target-proposal');
    const moveInput = { organizationSubject: transfer.org,
      source: { realm: transfer.realm, participationId: transferSource.participationId!, expectedGeneration: '1',
        expectedPolicyRevision: '1', proposalId: sourceInvitation.proposalId },
      target: { realm: transfer.otherRealm, expectedGeneration: '0', expectedPolicyRevision: '1',
        proposalId: targetInvitation.proposalId, termsRevision: 'terms-1' } };
    const moved = await orgRealm.move(transfer.orgPrincipal, moveInput, 'pitr-move');
    const movePair = (await primary.query('SELECT * FROM access.org_realm_move WHERE id = $1', [moved.moveId])).rows[0];
    const moveHistories = (await primary.query(`SELECT * FROM access.org_realm_history
      WHERE participation_id = ANY($1::uuid[]) ORDER BY participation_id, generation`,
    [[moved.source.participationId, moved.target.participationId]])).rows;
    // Consent and one-use evidence must survive the isolated Access restore.
    const consentId = Bun.randomUUIDv7();
    const membershipId = Bun.randomUUIDv7();
    const consentRepresentationId = Bun.randomUUIDv7();
    const consentGrantId = Bun.randomUUIDv7();
    await primary.query(`INSERT INTO access.membership_policy
      (kind, owner_subject, revision, terms_revision)
      VALUES ('org',$1,1,'pitr-terms')`, [actingSubject]);
    await primary.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'access.membership.consent',now() + interval '1 hour')`,
    [consentRepresentationId, principalId, actingSubject]);
    await primary.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,'work:create:root','access.membership.consent',now() + interval '1 hour')`,
    [consentGrantId, actingSubject]);
    await primary.query(`INSERT INTO access.membership_consent
      (id, principal_id, principal_epoch, kind, owner_subject, member_subject,
        member_generation, policy_revision, terms_revision, next_generation,
        representation_id, representation_generation, grant_id, grant_generation, expires_at)
      VALUES ($1,$2,0,'org',$3,$3,0,1,'pitr-terms',1,$4,0,$5,0,now() + interval '5 minutes')`,
    [consentId, principalId, actingSubject, consentRepresentationId, consentGrantId]);
    await primary.query(`INSERT INTO access.membership
      (id, kind, owner_subject, member_subject, state, generation,
        policy_revision, terms_revision, consent_reference)
      VALUES ($1,'org',$2,$2,'joined',1,1,'pitr-terms',$3)`,
    [membershipId, actingSubject, consentId]);
    await primary.query(`INSERT INTO access.membership_history
      (membership_id, generation, state, policy_revision, terms_revision,
        consent_reference, changed_by_principal)
      VALUES ($1,1,'joined',1,'pitr-terms',$2,$3)`,
    [membershipId, consentId, principalId]);
    await primary.query(`INSERT INTO access.membership_consent_use
      (consent_id, membership_id, generation) VALUES ($1,$2,1)`,
    [consentId, membershipId]);
    const privateConsentId = Bun.randomUUIDv7();
    const privateMembershipId = Bun.randomUUIDv7();
    const privateGrantId = Bun.randomUUIDv7();
    await primary.query(`INSERT INTO access.private_membership_consent
      (id, principal_id, principal_epoch, kind, owner_subject, policy_revision,
        terms_revision, next_generation, expires_at)
      VALUES ($1,$2,0,'org',$3,1,'pitr-terms',1,now() + interval '5 minutes')`,
    [privateConsentId, principalId, actingSubject]);
    await primary.query(`INSERT INTO access.private_membership
      (id, kind, owner_subject, principal_id, state, generation,
        policy_revision, terms_revision, consent_reference)
      VALUES ($1,'org',$2,$3,'joined',1,1,'pitr-terms',$4)`,
    [privateMembershipId, actingSubject, principalId, privateConsentId]);
    await primary.query(`INSERT INTO access.private_membership_history
      (membership_id, generation, state, policy_revision, terms_revision,
        consent_reference, changed_by_principal)
      VALUES ($1,1,'joined',1,'pitr-terms',$2,$3)`,
    [privateMembershipId, privateConsentId, principalId]);
    await primary.query(`INSERT INTO access.private_membership_consent_use
      (consent_id, membership_id, generation) VALUES ($1,$2,1)`,
    [privateConsentId, privateMembershipId]);
    await primary.query(`INSERT INTO access.principal_permission_grant
      (id, issuer_subject, principal_id, scope_id, action, valid_until,
        private_membership_id, private_membership_generation)
      VALUES ($1,$2,$3,'work:create:root','work.create',now() + interval '1 hour',$4,1)`,
    [privateGrantId, actingSubject, principalId, privateMembershipId]);
    const groupId = Bun.randomUUIDv7(), groupGrantId = Bun.randomUUIDv7();
    const privateGroupMemberId = Bun.randomUUIDv7(), privateRoleBindingId = Bun.randomUUIDv7();
    const roleFamilyId = Bun.randomUUIDv7();
    await primary.query(`INSERT INTO access.recipient_group (id, scope_id)
      VALUES ($1,'work:create:root')`, [groupId]);
    await primary.query(`INSERT INTO access.group_permission_grant
      (id, group_id, issuer_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$3,'work:create:root','work.create',now() + interval '1 hour')`,
    [groupGrantId, groupId, actingSubject]);
    await primary.query(`INSERT INTO access.private_group_member
      (id, group_id, principal_id, private_membership_id,
        private_membership_generation, assigned_by_principal)
      VALUES ($1,$2,$3,$4,1,$3)`,
    [privateGroupMemberId, groupId, principalId, privateMembershipId]);
    const roleFixture = await primary.connect();
    try {
      await roleFixture.query('BEGIN');
      await roleFixture.query(`INSERT INTO access.role_family
        (id, owner_subject, scope_id, head_revision)
        VALUES ($1,$2,'work:create:root',1)`, [roleFamilyId, actingSubject]);
      await roleFixture.query(`INSERT INTO access.role_revision
        (family_id, revision, permissions) VALUES ($1,1,ARRAY['work.create']::text[])`,
      [roleFamilyId]);
      await roleFixture.query('COMMIT');
    } catch (error) { await roleFixture.query('ROLLBACK'); throw error; }
    finally { roleFixture.release(); }
    await primary.query(`INSERT INTO access.private_role_binding
      (id, family_id, role_revision, issuer_subject, principal_id,
        private_membership_id, private_membership_generation, valid_until,
        assigned_by_principal)
      VALUES ($1,$2,1,$3,$4,$5,1,now() + interval '1 hour',$4)`,
    [privateRoleBindingId, roleFamilyId, actingSubject, principalId, privateMembershipId]);
    // IAM26: all request, mandate, B-to-A grant, consent, effect and receipts
    // are written after the base backup, then recovered from archived WAL.
    const representedP = { issuer: 'https://account.pitr.test', subject: 'pitr-represented-p' };
    const representedAManager = { issuer: representedP.issuer, subject: 'pitr-represented-a-manager' };
    const representedBManager = { issuer: representedP.issuer, subject: 'pitr-represented-b-manager' };
    const representedTarget = { issuer: representedP.issuer, subject: 'pitr-represented-target' };
    const representedIds = [Bun.randomUUIDv7(), Bun.randomUUIDv7(), Bun.randomUUIDv7(), Bun.randomUUIDv7()];
    const [A, B, C] = [native(), native(), native()];
    for (const [index, identity] of [representedP, representedAManager,
      representedBManager, representedTarget].entries()) {
      await primary.query(`INSERT INTO access.principal
        (id, account_issuer, account_subject) VALUES ($1,$2,$3)`,
      [representedIds[index], identity.issuer, identity.subject]);
    }
    for (const subject of [A, B, C]) {
      await primary.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')`,
      [subject]);
    }
    for (const subject of [A, B]) {
      await primary.query(`INSERT INTO access.membership_policy
        (kind, owner_subject, revision, terms_revision) VALUES ('org',$1,1,'pitr-iam26-terms')`,
      [subject]);
    }
    const representedPConsent = Bun.randomUUIDv7();
    await primary.query(`INSERT INTO access.private_membership_consent
      (id, principal_id, principal_epoch, kind, owner_subject, policy_revision,
        terms_revision, next_generation, expires_at)
      VALUES ($1,$2,0,'org',$3,1,'pitr-iam26-terms',1,now() + interval '5 minutes')`,
    [representedPConsent, representedIds[0], A]);
    await primary.query(`INSERT INTO access.private_membership
      (id, kind, owner_subject, principal_id, state, generation,
        policy_revision, terms_revision, consent_reference)
      VALUES ($1,'org',$2,$3,'joined',1,1,'pitr-iam26-terms',$4)`,
    [Bun.randomUUIDv7(), A, representedIds[0], representedPConsent]);
    for (const [id, subject, action] of [
      [representedIds[1], A, 'access.representation.manage'],
      [representedIds[1], A, 'access.representation.assign.membership.manage.org'],
      [representedIds[2], B, 'access.grant.assign.membership.manage.org'],
      [representedIds[3], C, 'access.membership.consent'],
    ]) {
      await primary.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '2 hours')`,
      [Bun.randomUUIDv7(), id, subject, action]);
      await primary.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,'work:create:root',$3,now() + interval '2 hours')`,
      [Bun.randomUUIDv7(), subject, action]);
    }
    const representedAuthority = new AccessRepresentedMembershipAuthority(primary);
    const representedEpoch = () => primary!.query<{ authority_epoch: string }>(`
      SELECT authority_epoch FROM access.scope_gate WHERE id = 'work:create:root'`)
      .then(row => row.rows[0]!.authority_epoch);
    const representedUntil = new Date(Date.now() + 60 * 60_000);
    const representedGrantId = Bun.randomUUIDv7();
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    const grantInput = { principal: representedBManager, issuerSubject: B, ownerSubject: B,
      expectedAuthorityEpoch: await representedEpoch(), idempotencyKey: 'pitr-iam26-grant',
      requestDigest: digest('pitr-iam26-grant') };
    await representedAuthority.grant(grantInput, representedGrantId, A, representedUntil);
    const representedRequestId = Bun.randomUUIDv7();
    await representedAuthority.request(representedP, representedRequestId, A, B,
      representedUntil, 'pitr-iam26-request', digest('pitr-iam26-request'));
    const representedMandateId = Bun.randomUUIDv7();
    const acceptInput = { principal: representedAManager, issuerSubject: A, ownerSubject: B,
      expectedAuthorityEpoch: await representedEpoch(), idempotencyKey: 'pitr-iam26-accept',
      requestDigest: digest('pitr-iam26-accept') };
    await representedAuthority.accept(acceptInput, representedRequestId, representedMandateId);
    const representedConsentId = Bun.randomUUIDv7();
    const targetRepresentationId = (await primary.query<{ id: string }>(`
      SELECT id FROM access.representation WHERE principal_id = $1 AND subject_id = $2
        AND action = 'access.membership.consent'`, [representedIds[3], C])).rows[0]!.id;
    const targetGrantId = (await primary.query<{ id: string }>(`
      SELECT id FROM access.permission_grant WHERE recipient_subject = $1
        AND action = 'access.membership.consent'`, [C])).rows[0]!.id;
    await primary.query(`INSERT INTO access.membership_consent
      (id, principal_id, principal_epoch, kind, owner_subject, member_subject,
        member_generation, policy_revision, terms_revision, next_generation,
        representation_id, representation_generation, grant_id, grant_generation, expires_at)
      VALUES ($1,$2,0,'org',$3,$4,0,1,'pitr-iam26-terms',1,$5,0,$6,0,
        now() + interval '5 minutes')`,
    [representedConsentId, representedIds[3], B, C, targetRepresentationId, targetGrantId]);
    const representedChange = { principal: representedP, kind: 'org' as const,
      ownerSubject: B, memberSubject: C, action: 'join' as const,
      expectedGeneration: '0', expectedPolicyRevision: '1',
      termsRevision: 'pitr-iam26-terms', consentReference: representedConsentId,
      idempotencyKey: 'pitr-iam26-effect', requestDigest: digest('pitr-iam26-effect'),
      represented: { actingSubject: A, representationId: representedMandateId,
        expectedRepresentationGeneration: '0', grantId: representedGrantId,
        expectedGrantGeneration: '0', expectedPrincipalEpoch: '0',
        expectedActingGeneration: '0', expectedOwnerGeneration: '0',
        expectedAuthorityEpoch: await representedEpoch() } };
    const representedEffect = await new AccessMemberships(primary).change(representedChange);
    const beforeClosureEpoch = await representedEpoch();
    const closure = await registry.strongCloseScope('work:create:root', beforeClosureEpoch);
    const closedEpoch = (BigInt(beforeClosureEpoch) + 1n).toString();
    expect(closure.authorityEpoch).toBe(closedEpoch);
    expect(closure.pending).toBe(1);
    const principalFence = await registry.strongDeactivatePrincipal(principalId, '0');
    expect(principalFence.enforcementEpoch).toBe('1');
    const sourceOutbox = await accessOutboxCoverage(primary);
    const sourceState = await accessStateCoverage(primary);
    const frontierCommand = join(root, 'services/main/src/pg-recovery-frontier.ts');
    const primaryUrl = `postgres://127.0.0.1:${primaryPort}/postgres?user=${process.env.USER}`;
    const captured = execFileSync(process.execPath, [frontierCommand, 'capture'], {
      cwd: root, env: { ...process.env, PG_RECOVERY_DATABASE_URL: primaryUrl }, encoding: 'utf8' });
    const frontier = JSON.parse(captured) as PgRecoveryFrontier;
    expect(frontier.systemIdentifier).toMatch(/^[0-9]+$/);
    const frontierFile = join(state, 'frontier.json');
    writeFileSync(frontierFile, JSON.stringify(frontier));
    const manifestCommand = join(root, 'services/main/src/access-recovery-manifest.ts');
    const sealed = execFileSync(process.execPath, [manifestCommand, 'capture'], {
      cwd: root, env: { ...process.env, ACCESS_RECOVERY_DATABASE_URL: primaryUrl,
        RECOVERY_MANIFEST_HMAC_KEY: manifestKey }, encoding: 'utf8' });
    const manifest = openRecoveryPayload<{ pg: PgRecoveryFrontier;
      outbox: typeof sourceOutbox; state: typeof sourceState }>(
      sealed, manifestKey, 'access-recovery-manifest');
    expect(manifest.outbox).toEqual(sourceOutbox);
    expect(manifest.state).toEqual(sourceState);
    const envelope = JSON.parse(sealed) as RecoveryEnvelope;
    expect(() => openRecoveryPayload(JSON.stringify({ ...envelope,
      payload: `A${envelope.payload.slice(1)}`,
    }), manifestKey, 'access-recovery-manifest')).toThrow(RecoveryEnvelopeConflict);
    expect(() => openRecoveryPayload(sealed, 'cd'.repeat(32),
      'access-recovery-manifest')).toThrow(RecoveryEnvelopeConflict);
    const manifestFile = join(state, 'access-manifest.json');
    writeFileSync(manifestFile, sealed);
    const requiredWal = frontier.walFile;
    await primary.query('SELECT pg_switch_wal()');
    for (let attempt = 0; attempt < 120 && !existsSync(join(walArchive, requiredWal)); attempt++) {
      await Bun.sleep(100);
    }
    expect(existsSync(join(walArchive, requiredWal))).toBe(true);
    await primary.end();
    primary = undefined;
    execFileSync('pg_ctl', ['-D', primaryData, '-m', 'fast', '-w', 'stop'], { cwd: state });
    primaryStarted = false;

    mkdirSync(incompleteArchive, { mode: 0o700 });
    for (const file of readdirSync(walArchive)) {
      if (file < requiredWal) copyFileSync(join(walArchive, file), join(incompleteArchive, file));
    }
    incomplete = await startRecovery(incompleteData, incompleteArchive, 'incomplete');
    const incompleteGate = await incomplete.query<{
      authority_epoch: string; open: boolean; dispatch_open: boolean }>(
      "SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = 'work:create:root'");
    expect(incompleteGate.rows[0]).toEqual({ authority_epoch: '0', open: true, dispatch_open: true });
    expect((await incomplete.query<{ active: boolean }>(
      'SELECT active FROM access.principal WHERE id = $1', [principalId])).rows[0]?.active).toBe(true);
    expect(await accessOutboxCoverage(incomplete)).not.toEqual(sourceOutbox);
    expect(await accessStateCoverage(incomplete)).not.toEqual(sourceState);
    await expect(assertPgRecoveryFrontier(incomplete, frontier))
      .rejects.toBeInstanceOf(PgRecoveryFrontierConflict);
    const incompletePort = (await incomplete.query<{ port: string }>('SHOW port')).rows[0]!.port;
    expect(() => execFileSync(process.execPath, [frontierCommand, 'verify', frontierFile], {
      cwd: root, env: { ...process.env,
        PG_RECOVERY_DATABASE_URL: `postgres://127.0.0.1:${incompletePort}/postgres?user=${process.env.USER}` },
      stdio: 'pipe',
    })).toThrow();
    expect(() => execFileSync(process.execPath, [manifestCommand, 'verify', manifestFile], {
      cwd: root, env: { ...process.env,
        ACCESS_RECOVERY_DATABASE_URL: `postgres://127.0.0.1:${incompletePort}/postgres?user=${process.env.USER}`,
        RECOVERY_MANIFEST_HMAC_KEY: manifestKey }, stdio: 'pipe',
    })).toThrow();
    await incomplete.end();
    incomplete = undefined;
    execFileSync('pg_ctl', ['-D', incompleteData, '-m', 'fast', '-w', 'stop'], { cwd: state });
    incompleteStarted = false;

    restored = await startRecovery(restoredData, walArchive, 'restored');
    const gate = await restored.query<{ authority_epoch: string; open: boolean; dispatch_open: boolean }>(
      "SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = 'work:create:root'");
    expect(gate.rows[0]).toEqual({ authority_epoch: closedEpoch, open: false, dispatch_open: false });
    expect((await restored.query<{ active: boolean }>(
      'SELECT active FROM access.principal WHERE id = $1', [principalId])).rows[0]?.active).toBe(false);
    expect((await restored.query('SELECT * FROM access.organization_publication_moderation WHERE admission_id = $1',
      [moderation.id])).rows[0]).toEqual(moderationRow);
    expect((await restored.query('SELECT state FROM access.admission WHERE id = $1', [moderation.id])).rows[0].state).toBe('claimed');
    await expect(restored.query('DELETE FROM access.organization_publication_moderation WHERE admission_id = $1', [moderation.id])).rejects.toThrow();
    expect((await restored.query<{ generation: string }>(`
      SELECT generation FROM access.membership_consent_use WHERE consent_id = $1`,
    [consentId])).rows[0]?.generation).toBe('1');
    expect((await restored.query<{ generation: string }>(`
      SELECT generation FROM access.private_membership_consent_use WHERE consent_id = $1`,
    [privateConsentId])).rows[0]?.generation).toBe('1');
    expect((await restored.query<{ private_membership_generation: string }>(`
      SELECT private_membership_generation FROM access.principal_permission_grant WHERE id = $1`,
    [privateGrantId])).rows[0]?.private_membership_generation).toBe('1');
    expect((await restored.query<{ private_membership_generation: string }>(`
      SELECT private_membership_generation FROM access.private_group_member WHERE id = $1`,
    [privateGroupMemberId])).rows[0]?.private_membership_generation).toBe('1');
    expect((await restored.query<{ private_membership_generation: string; role_revision: string }>(`
      SELECT private_membership_generation, role_revision
      FROM access.private_role_binding WHERE id = $1`,
    [privateRoleBindingId])).rows[0]).toMatchObject({
      private_membership_generation: '1', role_revision: '1' });
    expect((await restored.query(`SELECT principal_id, subject_id, action, resource_subject,
      private_membership_generation FROM access.representation WHERE id = $1`,
    [representedMandateId])).rows[0]).toMatchObject({ principal_id: representedIds[0],
      subject_id: A, action: 'access.membership.manage.org', resource_subject: B,
      private_membership_generation: '1' });
    expect((await restored.query(`SELECT issuer_subject, recipient_subject, scope_id, action
      FROM access.permission_grant WHERE id = $1`, [representedGrantId])).rows[0])
      .toMatchObject({ issuer_subject: B, recipient_subject: A,
        scope_id: `access:org-roster:${B.slice(-36)}`, action: 'access.membership.manage.org' });
    expect((await restored.query(`SELECT changed_by_principal, acting_subject,
      representation_id, grant_id FROM access.membership_history
      WHERE membership_id = $1 AND generation = 1`, [representedEffect.membershipId])).rows[0])
      .toMatchObject({ changed_by_principal: representedIds[0], acting_subject: A,
        representation_id: representedMandateId, grant_id: representedGrantId });
    expect(await accessOutboxCoverage(restored)).toEqual(sourceOutbox);
    expect(await accessStateCoverage(restored)).toEqual(sourceState);
    expect((await restored.query('SELECT * FROM access.org_realm_move WHERE id = $1', [moved.moveId])).rows[0]).toEqual(movePair);
    expect((await restored.query(`SELECT * FROM access.org_realm_history
      WHERE participation_id = ANY($1::uuid[]) ORDER BY participation_id, generation`,
    [[moved.source.participationId, moved.target.participationId]])).rows).toEqual(moveHistories);
    expect((await restored.query('SELECT participation_id, generation FROM access.org_realm_proposal_use WHERE proposal_id = $1',
      [targetInvitation.proposalId])).rows[0]).toEqual({ participation_id: moved.target.participationId, generation: '1' });
    await expect(restored.query('DELETE FROM access.org_realm_move WHERE id = $1', [moved.moveId])).rejects.toThrow();
    expect((await restored.query(`SELECT active, generation FROM access.managed_org_grant WHERE id = $1`,
      [managedGrant.grantId])).rows[0]).toEqual({ active: false, generation: '2' });
    expect((await restored.query(`SELECT generation, operation FROM access.managed_org_grant_event
      WHERE grant_id = $1 ORDER BY generation`, [managedGrant.grantId])).rows)
      .toEqual([{ generation: '1', operation: 'issue' }, { generation: '2', operation: 'revoke' }]);
    expect((await restored.query(`SELECT open, revision FROM access.membership_policy
      WHERE kind = 'org' AND owner_subject = $1`, [orgFixture.org])).rows[0])
      .toEqual({ open: false, revision: '2' });
    expect((await restored.query(`SELECT grant_id, grant_generation, admissions_open FROM access.org_roster_policy_history
      WHERE organization_subject = $1 AND policy_revision = 2`, [orgFixture.org])).rows[0])
      .toEqual({ grant_id: managedGrant.grantId, grant_generation: '1', admissions_open: false });
    await expect(restored.query('DELETE FROM access.org_roster_policy_history')).rejects.toThrow();
    await expect(restored.query('DELETE FROM access.managed_org_grant_event')).rejects.toThrow();
    await expect(restored.query('DELETE FROM access.managed_org_receipt')).rejects.toThrow();
    expect((await restored.query(`SELECT generation, state FROM access.org_realm_participation
      WHERE id = $1`, [joined.participationId])).rows[0]).toEqual({ generation: '2', state: 'suspended' });
    expect((await restored.query(`SELECT generation, active FROM access.org_realm_ban
      WHERE realm = $1 AND organization_subject = $2`, [orgFixture.realm, orgFixture.org])).rows[0])
      .toEqual({ generation: '1', active: true });
    expect((await restored.query(`SELECT generation FROM access.org_realm_history
      WHERE participation_id = $1 ORDER BY generation`, [joined.participationId])).rows)
      .toEqual([{ generation: '1' }, { generation: '2' }]);
    expect((await restored.query(`SELECT reason_reference FROM access.org_realm_history
      WHERE participation_id = $1 AND generation = 2`, [joined.participationId])).rows[0]?.reason_reference)
      .toBe('pitr-suspension');
    expect((await restored.query(`SELECT generation FROM access.org_realm_proposal_use
      WHERE proposal_id = $1`, [proposal.proposalId])).rows[0]?.generation).toBe('1');
    await expect(restored.query('DELETE FROM access.org_realm_history')).rejects.toThrow();
    await expect(restored.query('DELETE FROM access.org_realm_receipt')).rejects.toThrow();
    await expect(assertPgRecoveryFrontier(restored, frontier)).resolves.toBeUndefined();
    const restoredPort = (await restored.query<{ port: string }>('SHOW port')).rows[0]!.port;
    expect(execFileSync(process.execPath, [frontierCommand, 'verify', frontierFile], {
      cwd: root, env: { ...process.env,
        PG_RECOVERY_DATABASE_URL: `postgres://127.0.0.1:${restoredPort}/postgres?user=${process.env.USER}` },
      encoding: 'utf8',
    })).toContain('reached retained WAL frontier');
    expect(execFileSync(process.execPath, [manifestCommand, 'verify', manifestFile], {
      cwd: root, env: { ...process.env,
        ACCESS_RECOVERY_DATABASE_URL: `postgres://127.0.0.1:${restoredPort}/postgres?user=${process.env.USER}`,
        RECOVERY_MANIFEST_HMAC_KEY: manifestKey }, encoding: 'utf8',
    })).toContain('matches retained WAL and row coverage');
    const recovered = new AccessAdmissionRegistry(restored);
    await expect(recovered.claim(admitted.id, request.requestDigest)).rejects.toBeInstanceOf(AdmissionDenied);
    await expect(recovered.register({ ...request, idempotencyKey: 'after-recovery' }))
      .rejects.toBeInstanceOf(AdmissionDenied);
    const restoredOrgRealm = new AccessOrgRealmParticipation(restored);
    await expect(restoredOrgRealm.move(transfer.orgPrincipal, moveInput, 'pitr-move')).rejects.toBeInstanceOf(OrgRealmDenied);
    await expect(restoredOrgRealm.change(orgFixture.orgPrincipal, orgJoin, 'pitr-org-join'))
      .rejects.toBeInstanceOf(OrgRealmDenied);
    const restoredManaged = new AccessManagedOrganizations(restored);
    await expect(restoredManaged.setRosterPolicy(orgFixture.realmPrincipal, managedPolicy, 'pitr-managed-policy'))
      .rejects.toBeInstanceOf(ManagedOrgDenied);
    // Reopening is local to this isolated copy, after exact source coverage verification.
    await restored.query("UPDATE access.scope_gate SET open = true, dispatch_open = true WHERE id = 'work:create:root'");
    expect(await new AccessMemberships(restored).change(representedChange))
      .toEqual({ ...representedEffect, replayed: true });
    expect(await new AccessRepresentedMembershipAuthority(restored).accept(
      acceptInput, representedRequestId, representedMandateId))
      .toBe((BigInt(grantInput.expectedAuthorityEpoch) + 2n).toString());
    for (const snapshot of [moved.source, moved.target]) {
      expect(await restoredOrgRealm.read(transfer.orgPrincipal, { realm: snapshot.realm,
        organizationSubject: transfer.org, side: 'organization' })).toEqual(snapshot);
    }
    expect(await restoredOrgRealm.move(transfer.orgPrincipal, moveInput, 'pitr-move')).toEqual({ ...moved, replayed: true });
    await expect(restoredOrgRealm.move(transfer.orgPrincipal, { ...moveInput,
      target: { ...moveInput.target, termsRevision: 'changed' } }, 'pitr-move')).rejects.toThrow('another intent');
    await expect(restoredOrgRealm.move(transfer.orgPrincipal, moveInput, 'pitr-move-fresh')).rejects.toThrow();
    expect(await restoredManaged.change(orgFixture.orgPrincipal, managedIssue, 'pitr-managed-issue'))
      .toEqual({ ...managedGrant, replayed: true });
    expect(await restoredManaged.change(orgFixture.orgPrincipal, managedRevoke, 'pitr-managed-revoke'))
      .toEqual({ ...managedRevoked, replayed: true });
    expect(await restoredManaged.setRosterPolicy(orgFixture.realmPrincipal, managedPolicy, 'pitr-managed-policy'))
      .toEqual({ ...managedEffect, replayed: true });
    await expect(restoredManaged.setRosterPolicy(orgFixture.realmPrincipal, managedPolicy, 'pitr-new-policy'))
      .rejects.toBeInstanceOf(ManagedOrgStale);
    await expect(restoredManaged.setRosterPolicy(orgFixture.realmPrincipal,
      { ...managedPolicy, expectedGrantGeneration: '2', expectedPolicyRevision: '2' }, 'pitr-revoked-policy'))
      .rejects.toBeInstanceOf(ManagedOrgDenied);
    expect(await restoredOrgRealm.change(orgFixture.orgPrincipal, orgJoin, 'pitr-org-join'))
      .toEqual({ ...joined, replayed: true });
    expect(await restoredOrgRealm.change(orgFixture.realmPrincipal, orgSuspend, 'pitr-org-suspend'))
      .toEqual({ ...suspended, replayed: true });
    await expect(restoredOrgRealm.propose(orgFixture.realmPrincipal,
      { ...orgBasis, expectedGeneration: '2', termsRevision: 'terms-1' }, 'pitr-rejoin'))
      .rejects.toBeInstanceOf(OrgRealmDenied);
  } finally {
    await restored?.end();
    if (restoredStarted) execFileSync('pg_ctl', ['-D', restoredData, '-m', 'fast', '-w', 'stop'], { cwd: state });
    await incomplete?.end();
    if (incompleteStarted) execFileSync('pg_ctl', ['-D', incompleteData, '-m', 'fast', '-w', 'stop'], { cwd: state });
    await primary?.end();
    if (primaryStarted) execFileSync('pg_ctl', ['-D', primaryData, '-m', 'fast', '-w', 'stop'], { cwd: state });
  }
}, 120_000);
