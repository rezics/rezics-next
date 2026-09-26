import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { catalogDescriptionVariantId } from '../../../services/main/src/modules/catalog/commands.ts';
import { MANAGED_ORG_ACTION } from '../../../services/main/src/modules/access/managed-org-authority.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';

let started: Promise<MediaStack> | undefined;
const stack = () => started ??= startMediaStack('catalog-descriptions');
afterAll(async () => { if (started) await (await started).stop(); });

test('IAM37: a Realm content editor publishes an Organization description without organization control', async () => {
  const { member, accessPool, content, fuseki } = await stack();
  const organizationOwner = await member('organization-owner');
  const realmEditor = await member('realm-editor');
  const ungrantedEditor = await member('ungranted-editor');
  const organization = `https://rezics.com/id/${randomUUID()}`;
  const realm = realmEditor.actor;
  const variantId = catalogDescriptionVariantId(organization, 'en');
  await fuseki.update(`PREFIX schema: <https://schema.org/>
    INSERT DATA { GRAPH <urn:rezics:graph:current> { <${organization}> a schema:Organization } }`);
  await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'institution')", [organization]);
  await accessPool.query('INSERT INTO access.org_participation_subject (subject) VALUES ($1)', [organization]);
  await accessPool.query(`INSERT INTO access.membership_policy (kind, owner_subject, revision, terms_revision)
    VALUES ('org',$1,1,'description-test-terms')`, [organization]);
  await accessPool.query(`INSERT INTO access.org_realm_policy (realm, manager_subject, revision, terms_revision)
    VALUES ($1,$1,1,'description-test-terms')`, [realm]);

  const issueContentGrant = async (scope: string, action: 'content.draft' | 'content.publish') => {
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
    [randomUUID(), realmEditor.principalId, realm, action]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$3,$4,$5,now() + interval '1 hour')`,
    [randomUUID(), organization, realm, scope, action]);
  };
  const draftScope = `content:draft:${organization}`;
  const publishScope = `content:publish:${variantId}`;
  await issueContentGrant(publishScope, 'content.publish');
  const assignmentAction = 'access.grant.assign.content.draft';
  const assignmentIssuer = `https://rezics.com/id/${randomUUID()}`;
  const draftGrantId = randomUUID();
  await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'institution')",
    [assignmentIssuer]);
  await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [draftScope]);
  await accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
    VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
  [randomUUID(), organizationOwner.principalId, organization, assignmentAction]);
  await accessPool.query(`INSERT INTO access.permission_grant
    (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
    VALUES ($1,$2,$3,$4,$5,now() + interval '1 hour')`,
  [randomUUID(), assignmentIssuer, organization, draftScope, assignmentAction]);
  await accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
    VALUES ($1,$2,$3,'content.draft',now() + interval '1 hour')`,
  [randomUUID(), realmEditor.principalId, realm]);

  const gate = await accessPool.query<{ authority_epoch: string }>(
    'SELECT authority_epoch::text FROM access.scope_gate WHERE id = $1', [draftScope]);
  const issuedGrantInput = {
    profile: 'access-organization-content-draft-grant-change-v1', organizationSubject: organization,
    recipientSubject: realm, grantId: draftGrantId, expectedAuthorityEpoch: gate.rows[0]!.authority_epoch,
    validUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
  const issuedGrant = await organizationOwner.send('POST', '/v1/access/organization-content-draft-grants',
    issuedGrantInput, 'iam37-org-issues-description-draft-grant');
  expect(issuedGrant.status).toBe(200);
  expect(await issuedGrant.json()).toMatchObject({ organizationSubject: organization,
    recipientSubject: realm, grantId: draftGrantId, scope: draftScope, action: 'content.draft' });
  const issuedGrantReplay = await organizationOwner.send('POST', '/v1/access/organization-content-draft-grants',
    issuedGrantInput, 'iam37-org-issues-description-draft-grant');
  expect(issuedGrantReplay.status).toBe(200);
  const currentDraftGate = await accessPool.query<{ authority_epoch: string }>(
    'SELECT authority_epoch::text FROM access.scope_gate WHERE id = $1', [draftScope]);
  const deniedCheck = await ungrantedEditor.send('POST', '/v1/me/acting-context-checks', {
    profile: 'content-draft-acting-context-check-v1', task: 'content.draft',
    resource: organization, actingSubject: realm, expectedAuthorityEpoch: currentDraftGate.rows[0]!.authority_epoch });
  expect(deniedCheck.status).toBe(403);
  const denied = await ungrantedEditor.send('PATCH',
    `/v1/catalog/resources/${organization.split('/').at(-1)}/descriptions`, {
      profile: 'catalog-description-v1', language: { kind: 'tag', tag: 'en', originalTag: 'en' },
      direction: 'ltr', expectedHead: null, description: 'Unauthorized description', actingSubject: realm });
  expect(denied.status).toBe(403);
  expect((await accessPool.query('SELECT 1 FROM access.admission WHERE acting_subject = $1 AND action = $2',
    [realm, 'content.draft'])).rowCount).toBe(0);

  const draftInput = { profile: 'catalog-description-v1',
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
    expectedHead: null, description: 'A public description owned by the organization.', actingSubject: realm };
  const path = `/v1/catalog/resources/${organization.split('/').at(-1)}/descriptions`;
  const graphCallsBeforeEdit = fuseki.queries;
  const savedResponse = await realmEditor.send('PATCH', path, draftInput, 'iam37-description-edit');
  expect(savedResponse.status).toBe(201);
  expect(fuseki.queries - graphCallsBeforeEdit).toBe(2);
  const saved = await savedResponse.json() as { resourceId: string; variantId: string; revisionId: string;
    sourcePosition: { dataEpoch: string } };
  expect(saved).toMatchObject({ resourceId: organization, variantId });
  const exact = (await content.readExactBatch([saved.revisionId], async ids => new Set(ids)))[0];
  expect(exact).toMatchObject({ status: 'available', reference: { model: 'catalog-description-v1',
    resourceId: organization, variantId }, body: { body: draftInput.description } });

  const replay = await realmEditor.send('PATCH', path, draftInput, 'iam37-description-edit');
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ revisionId: saved.revisionId, replayed: true });
  const stale = await realmEditor.send('PATCH', path, { ...draftInput, description: 'Stale edit' },
    'iam37-description-stale');
  expect(stale.status).toBe(409);

  const publicationInput = {
    profile: 'content-publication-v1', targetProfile: 'catalog-description-v1',
    preparationId: `iam37-${randomUUID()}`, revisionId: saved.revisionId,
    expectedDigest: exact && exact.status === 'available' ? exact.reference.byteDigest : '',
    expectedContentEpoch: saved.sourcePosition.dataEpoch, resourceId: organization, variantId,
    expectedPublicationHead: null, actingSubject: realm,
  };
  const originalCommand = fuseki.commandWithReceipt.bind(fuseki);
  fuseki.commandWithReceipt = async () => { throw new Error('simulated lost command response'); };
  const partialPublication = await realmEditor.send('POST', '/v1/content-publications', publicationInput,
    'iam37-description-publication');
  fuseki.commandWithReceipt = originalCommand;
  expect(partialPublication.status).toBe(202);
  const publication = await realmEditor.send('POST', '/v1/content-publications', publicationInput,
    'iam37-description-publication');
  expect(publication.status).toBe(200);
  const published = await publication.json() as { status: string; decision: string };
  expect(published.status).toBe('active');
  expect((await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
    GRAPH <urn:rezics:graph:current> { <${variantId}> rv:resource <${organization}> ;
      rv:contentPublicationHead <${published.decision}> } }`)).boolean).toBe(true);

  const controlGrant = randomUUID();
  await accessPool.query(`INSERT INTO access.scope_gate (id) VALUES ('work:create:root') ON CONFLICT DO NOTHING`);
  await accessPool.query(`INSERT INTO access.managed_org_grant
      (id, organization_subject, organization_generation, organization_admission_generation,
       recipient_kind, recipient_id, recipient_realm, recipient_subject, recipient_generation,
       recipient_admission_generation, action, delegation_ceiling, valid_from, valid_until, issuer_proof)
    SELECT $1, o.subject, s.generation, o.generation, 'realm', p.realm, p.realm, p.manager_subject,
      manager.generation, p.revision, $2, 0, now() - interval '1 minute', now() + interval '1 hour', '{}'::jsonb
    FROM access.org_participation_subject o JOIN access.authority_subject s ON s.id = o.subject
    JOIN access.org_realm_policy p ON p.realm = $3
    JOIN access.authority_subject manager ON manager.id = p.manager_subject
    WHERE o.subject = $4`, [controlGrant, MANAGED_ORG_ACTION.roster, realm, organization]);
  const control = await realmEditor.send('POST', '/v1/access/organization-roster-policy', {
    profile: 'access-organization-roster-policy-v1', organizationSubject: organization,
    recipient: { kind: 'realm', id: realm }, grantId: controlGrant, expectedGrantGeneration: '1',
    representationId: randomUUID(), expectedRepresentationGeneration: '1', expectedPolicyRevision: '1',
    admissionsOpen: false,
  }, 'iam37-no-organization-control');
  expect(control.status).toBe(403);

  const concurrent = await Promise.all([
    realmEditor.send('PATCH', path, { ...draftInput, expectedHead: saved.revisionId, description: 'Concurrent A' },
      'iam37-concurrent-a'),
    realmEditor.send('PATCH', path, { ...draftInput, expectedHead: saved.revisionId, description: 'Concurrent B' },
      'iam37-concurrent-b'),
  ]);
  expect(concurrent.map(response => response.status).sort()).toEqual([201, 409]);

  const issuedBy = await accessPool.query<{ issuer_subject: string; recipient_subject: string; scope_id: string;
    action: string; assigned_by_principal: string; issuer_representation_action: string; ceiling_action: string }>(`
    SELECT g.issuer_subject, g.recipient_subject, g.scope_id, g.action,
      l.assigned_by_principal::text, l.issuer_representation_action, l.ceiling_action
    FROM access.permission_grant g JOIN access.grant_lineage l ON l.grant_id = g.id
    WHERE g.id = $1 AND g.active`, [draftGrantId]);
  expect(issuedBy.rows).toEqual([{ issuer_subject: organization, recipient_subject: realm,
    scope_id: draftScope, action: 'content.draft', assigned_by_principal: organizationOwner.principalId,
    issuer_representation_action: assignmentAction, ceiling_action: assignmentAction }]);
}, 180_000);
