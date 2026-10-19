import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import type { ContentCore, SaveDraftCommand, SaveDraftResult } from '../../content/src/core.ts';
import type { AdmissionRequest, VerifiedPrincipal } from '../src/modules/access/admission.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { WorkReadMoved, WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { platformAdministratorProof, savePlatformAdministratorProof } from '../src/modules/access/platform-administrator.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';

const authorBaseline = await import('../src/modules/access/author-baseline.ts');
const zoneAuthority = await import('../src/modules/space/create-authority.ts');
const replyRoot = await import('../src/modules/realm-reply/root.ts');
const authoredWorks = new Map<string, string>();
const zoneOwnerships = new Set<string>();
const rootDecisions = new Map<string, boolean | Error>();
const rootReads: { resource: string; revision: string; principal: unknown; actor: string | undefined }[] = [];
const graph = { query: async () => ({ boolean: true, results: { bindings: [] } }) };
const { configureDisclosure } = await import('../src/modules/disclosure/read.ts');
configureDisclosure(({ fuseki: graph,
  lineage: { dataEpoch: 'reply-authorship-test', routingEpoch: 'test' } } as unknown as WorkActivationEnvironment), null);

await mock.module('../src/modules/access/author-baseline.ts', () => ({
  ...authorBaseline,
  authorWorkGeneration: async (_client: unknown, _graph: unknown, principal: string,
    actor: string, work: string) => authoredWorks.get(`${principal}:${actor}:${work}`) ?? null,
}));
await mock.module('../src/modules/space/create-authority.ts', () => ({
  ...zoneAuthority,
  zoneSpaceCreatorAllowed: async (_client: unknown, _graph: unknown, principal: string,
    actor: string, zone: string) => zoneOwnerships.has(`${principal}:${actor}:${zone}`),
}));
await mock.module('../src/modules/realm-reply/root.ts', () => ({
  ...replyRoot,
  publicReplyRoot: async () => true,
  readableReplyRoot: async (...args: Parameters<typeof replyRoot.readableReplyRoot>) => {
    const [, resource, revision, , principal, actor] = args;
    rootReads.push({ resource, revision, principal, actor });
    const decision = rootDecisions.get(`${resource}:${revision}`) ?? true;
    if (decision instanceof Error) throw decision;
    return decision;
  },
}));

const { AccessAdmissionRegistry, AdmissionDenied, AdmissionConflict, AdmissionUnavailable } =
  await import('../src/modules/access/admission.ts');
const { resolveZonePageContent } = await import('../src/modules/access/zone-content-authority.ts');
const { saveAdmittedContentDraft } = await import('../src/modules/content-publication/draft.ts');
const { nativePostType } = await import('../src/modules/work/work-kinds.ts');
const root = resolve(import.meta.dir, '../../..');
const nativeId = () => `https://rezics.com/id/${randomUUID()}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
let cluster: PostgresCluster | undefined;
let pool: Pool;

beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 4, connectionTimeoutMillis: 1000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of schemaFiles(root, 'access')) {
      await client.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}, 60_000);

afterAll(async () => {
  await pool?.end();
  cluster?.remove();
  await mock.module('../src/modules/access/author-baseline.ts', () => authorBaseline);
  await mock.module('../src/modules/space/create-authority.ts', () => zoneAuthority);
  await mock.module('../src/modules/realm-reply/root.ts', () => replyRoot);
});

function principal(): VerifiedPrincipal {
  const identity = { issuer: 'https://account.reply-authorship.test', subject: randomUUID(), emailVerified: true };
  return { ...identity, currentAssertion: async () => identity };
}

async function actor(identity: VerifiedPrincipal, kind: 'person' | 'organization' | 'service',
  provisioned = true) {
  const found = await pool.query<{ id: string }>(`SELECT id FROM access.principal
    WHERE account_issuer = $1 AND account_subject = $2`, [identity.issuer, identity.subject]);
  const principalId = found.rows[0]?.id ?? (await pool.query<{ id: string }>(`INSERT INTO access.principal
    (id, account_issuer, account_subject) VALUES ($1,$2,$3) RETURNING id`,
  [randomUUID(), identity.issuer, identity.subject])).rows[0]!.id;
  const agent = nativeId();
  const controlId = randomUUID();
  await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [agent]);
  await pool.query(`INSERT INTO access.representation
    (id, principal_id, subject_id, action, valid_until)
    VALUES ($1,$2,$3,'agent.control','infinity')`, [controlId, principalId, agent]);
  let provisionId: string | null = null;
  if (provisioned) {
    provisionId = randomUUID();
    await pool.query(`INSERT INTO access.agent_provision
      (id, principal_id, idempotency_key, request_digest, agent_id, agent_kind, display_name,
       principal_epoch, state, graph_data_epoch, graph_sequence, representation_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,0,'active','reply-authorship-test',1,$8)`,
    [provisionId, principalId, `fixture-${randomUUID()}`, digest(randomUUID()), agent, kind, kind, controlId]);
  }
  const access = new AccessAdmissionRegistry(pool);
  access.configureBaseline(graph as never);
  return { identity, principalId, agent, controlId, provisionId, access };
}

async function grant(principalId: string, actingSubject: string,
  action: string, scope: string) {
  const representationId = randomUUID();
  const grantId = randomUUID();
  await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
  await pool.query(`INSERT INTO access.representation
    (id, principal_id, subject_id, action, valid_until)
    VALUES ($1,$2,$3,$4,'infinity')`, [representationId, principalId, actingSubject, action]);
  await pool.query(`INSERT INTO access.permission_grant
    (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
    VALUES ($1,$2,$3,$4,$5,'infinity')`, [grantId, actingSubject, actingSubject, scope, action]);
  return { representationId, grantId };
}

async function platformGrant(principalId: string, actingSubject: string,
  permission: string, scope: string) {
  const grantId = randomUUID();
  await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
  await pool.query(`INSERT INTO access.principal_permission_grant
    (id, issuer_subject, principal_id, scope_id, action, valid_until)
    VALUES ($1,$2,$3,$4,$5,'infinity')`, [grantId, actingSubject, principalId, scope, permission]);
  await pool.query(`INSERT INTO access.platform_grant_episode
    (id, principal_grant_id, issuer_subject, permission, scope_id, assigned_by_principal, receipt)
    VALUES ($1,$1,$2,$3,$4,$5,$6)`, [grantId, actingSubject, permission, scope, principalId,
    `urn:rezics:access-receipt:${digest(`${grantId}:${permission}:${scope}`)}`]);
}

async function platformAdministratorGrants(principalId: string, actingSubject: string,
  action: string, scope: string) {
  await platformGrant(principalId, actingSubject, 'platform:use:platform-admin', 'platform:access');
  await platformGrant(principalId, actingSubject, `platform:resource:${action}`, scope);
}

async function legacyAdministratorAdmission(input: AdmissionRequest, principalId: string) {
  const id = randomUUID();
  await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [input.scope]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO access.admission
      (id, principal_id, acting_subject, scope_id, action, idempotency_key, request_digest,
       authority_epoch, expires_at, state, authority_witness)
      SELECT $1,$2,$3,$4,$5,$6,$7,g.authority_epoch,clock_timestamp() + interval '1 minute','registered',
        jsonb_build_array(jsonb_build_object('table','principal','id',($2::uuid)::text,'generation','0'),
          jsonb_build_object('table','authority_subject','id',$3::text,'generation','0'))
      FROM access.scope_gate g WHERE g.id = $4`,
    [id, principalId, input.actingSubject, input.scope, input.action, input.idempotencyKey, input.requestDigest]);
    await client.query(`INSERT INTO access.admission_receipt
      (admission_id, principal_id, action, idempotency_key, request_digest, outcome)
      VALUES ($1,$2,$3,$4,$5,'registered')`,
    [id, principalId, input.action, input.idempotencyKey, input.requestDigest]);
    const proof = await platformAdministratorProof(client, principalId, input.actingSubject, true,
      { action: input.action, scope: input.scope });
    expect(proof).not.toBeNull();
    await savePlatformAdministratorProof(client, id, proof!);
    await client.query('COMMIT');
    return id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function request(identity: VerifiedPrincipal, actingSubject: string, action: string, scope: string,
  extra: Partial<AdmissionRequest> = {}): AdmissionRequest {
  const key = `reply-authorship-${randomUUID()}`;
  return { principal: identity, actingSubject, action, scope, idempotencyKey: key,
    requestDigest: digest(key), ...extra };
}

test('Person reply proof selection revalidates while ordinary and Zone drafts retain steward authority', async () => {
  const identity = principal();
  const person = await actor(identity, 'person');
  const organization = await actor(identity, 'organization');
  const rootTarget = nativeId();
  const rootRevision = randomUUID();
  const draft = request(identity, person.agent, 'content.draft', `content:draft:${nativeId()}`, {
    baselineRelatedWork: rootTarget, baselineSourceRevision: rootRevision,
  });
  const personReply = await person.access.register(draft);
  const proof = (await pool.query(`SELECT b.provision_id, b.representation_id, b.related_work, b.source_revision,
      p.agent_kind FROM access.baseline_admission b JOIN access.agent_provision p ON p.id = b.provision_id
      WHERE b.admission_id = $1`, [personReply.id])).rows[0];
  expect(proof).toMatchObject({ provision_id: person.provisionId, representation_id: person.controlId,
    related_work: rootTarget, source_revision: rootRevision, agent_kind: 'person' });
  expect(await person.access.register(draft)).toMatchObject({ id: personReply.id, dispatchEligible: true, replayed: true });

  for (const label of ['Work', 'Post']) {
    const resource = nativeId();
    authoredWorks.set(`${organization.principalId}:${organization.agent}:${resource}`, '4');
    const ordinary = await organization.access.register(request(identity, organization.agent,
      'content.draft', `content:draft:${resource}`));
    const saved = (await pool.query(`SELECT b.provision_id, b.related_work, b.author_work,
        b.author_generation FROM access.baseline_admission b WHERE b.admission_id = $1`, [ordinary.id])).rows[0];
    expect(saved).toEqual({ provision_id: organization.provisionId, related_work: null,
      author_work: resource, author_generation: '4' });
    expect(ordinary.dispatchEligible, `${label} draft remains steward-authorized`).toBe(true);
  }

  const zone = nativeId();
  const page = nativeId();
  zoneOwnerships.add(`${organization.principalId}:${organization.agent}:${zone}`);
  const zoneDraft = await organization.access.register(request(identity, organization.agent,
    'content.draft', `content:draft:${page}`, { resolvedZonePage: zone }));
  expect((await pool.query(`SELECT b.provision_id, b.realm_membership, b.author_work
    FROM access.baseline_admission b WHERE b.admission_id = $1`, [zoneDraft.id])).rows[0])
    .toEqual({ provision_id: organization.provisionId, realm_membership: 'zone-page', author_work: zone });

  await person.access.claim(personReply.id, draft.requestDigest, identity);
  await person.access.recordGraphOutcome(personReply.id, { admissionId: personReply.id,
    requestDigest: personReply.requestDigest, authorityEpoch: personReply.authorityEpoch,
    scope: personReply.scope, receipt: `urn:rezics:receipt:${digest(`${personReply.id}\0content-draft-save`)}`,
    dataEpoch: 'reply-authorship-test', sequence: '1', outcome: 'succeeded' });
  const pendingDraft = request(identity, person.agent, 'content.draft', `content:draft:${nativeId()}`, {
    baselineRelatedWork: nativeId(), baselineSourceRevision: randomUUID(),
  });
  const pendingReply = await person.access.register(pendingDraft);
  const replacementPrincipalId = randomUUID();
  await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
    VALUES ($1,'https://replacement.reply-authorship.test',$2)`, [replacementPrincipalId, randomUUID()]);
  await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES ($1,$2,$3,'agent.control','infinity')`, [randomUUID(), replacementPrincipalId, person.agent]);
  await pool.query('UPDATE access.representation SET active = false WHERE id = $1', [person.controlId]);
  // Current authority gates receipt disclosure for terminal and pending replies.
  await expect(person.access.register(draft)).rejects.toBeInstanceOf(AdmissionDenied);
  await expect(person.access.register(pendingDraft)).rejects.toBeInstanceOf(AdmissionDenied);
  await expect(person.access.claim(pendingReply.id, pendingDraft.requestDigest, identity))
    .rejects.toBeInstanceOf(AdmissionDenied);

  expect(resolveZonePageContent({ action: 'content.draft', scope: `content:draft:${page}`,
    resolvedZonePage: zone, baselineRelatedWork: rootTarget, baselineSourceRevision: rootRevision }))
    .toEqual({ kind: 'refused' });
  await expect(organization.access.register(request(identity, organization.agent, 'content.draft',
    `content:draft:${nativeId()}`, { resolvedZonePage: zone,
      baselineRelatedWork: rootTarget, baselineSourceRevision: rootRevision }))).rejects.toBeInstanceOf(AdmissionDenied);
});

test('administrator-backed Work and Post drafts claim and save without reply metadata', async () => {
  const identity = principal();
  const person = await actor(identity, 'person');
  const organization = await actor(identity, 'organization');
  const cases = [
    { label: 'Work', selected: person, type: 'https://schema.org/CreativeWork' },
    { label: 'Post', selected: organization, type: nativePostType },
  ] as const;

  for (const { label, selected, type } of cases) {
    const resourceId = nativeId();
    const scope = `content:draft:${resourceId}`;
    await platformAdministratorGrants(selected.principalId, selected.agent, 'content.draft', scope);
    const env = { lineage: { dataEpoch: randomUUID(), routingEpoch: randomUUID() },
      fuseki: { query: async (query: string) => query.includes('SELECT DISTINCT ?type')
        ? { results: { bindings: [{ type: { value: type } }] } } : { boolean: true } },
    } as unknown as WorkActivationEnvironment;
    const commands: SaveDraftCommand[] = [];
    const content = { saveDraft: async (command: SaveDraftCommand): Promise<SaveDraftResult> => {
      commands.push(command);
      return { outcome: 'succeeded', revisionId: randomUUID(), predecessor: command.expectedHead,
        position: { owner: 'content', dataEpoch: randomUUID(), sequence: '1' }, replayed: false };
    }, readDraftReceipt: async () => null } as unknown as ContentCore;
    const account = { verify: async () => identity };
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const saved = await saveAdmittedContentDraft(env, content, account, selected.access,
      new Request('http://main.local/v1/content-drafts'), {
        resourceId,
        variant: { id: variantId, resourceId,
          language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
        expectedHead: null, body: `${label} steward draft`,
        actingSubject: selected.agent, idempotencyKey: `admin-${label.toLowerCase()}-${randomUUID()}`,
      });
    const admissionId = String(commands[0]?.provenance.admissionId);
    expect(saved.outcome, `${label} draft saves after the administrator claim`).toBe('succeeded');
    expect(commands).toHaveLength(1);
    expect((await pool.query('SELECT 1 FROM access.platform_administrator_admission WHERE admission_id = $1',
      [admissionId])).rowCount).toBe(1);
    expect((await pool.query('SELECT 1 FROM access.baseline_admission WHERE admission_id = $1',
      [admissionId])).rowCount).toBe(0);
    expect((await pool.query('SELECT state FROM access.admission WHERE id = $1', [admissionId])).rows[0]?.state)
      .toBe('sealed');
  }
});

test('explicit draft and create grants cannot replace Person proof for Org or legacy PenName', async () => {
  const identity = principal();
  const person = await actor(identity, 'person');
  const organization = await actor(identity, 'organization');
  const legacyPenName = await actor(identity, 'person', false);

  for (const selected of [organization, legacyPenName]) {
    const rootTarget = nativeId();
    const rootRevision = randomUUID();
    const draft = request(identity, selected.agent, 'content.draft', `content:draft:${nativeId()}`, {
      baselineRelatedWork: rootTarget, baselineSourceRevision: rootRevision,
    });
    await grant(selected.principalId, selected.agent, 'content.draft', draft.scope);
    await expect(selected.access.register(draft)).rejects.toBeInstanceOf(AdmissionDenied);

    const create = request(identity, selected.agent, 'reply.create', `reply:create:${rootTarget}`, {
      baselineSourceRevision: rootRevision,
    });
    await grant(selected.principalId, selected.agent, 'reply.create', create.scope);
    await expect(selected.access.register(create)).rejects.toBeInstanceOf(AdmissionDenied);
  }

  const malformed = request(identity, person.agent, 'content.draft', `content:draft:${nativeId()}`, {
    baselineRelatedWork: nativeId(),
  });
  await grant(person.principalId, person.agent, 'content.draft', malformed.scope);
  await expect(person.access.register(malformed)).rejects.toBeInstanceOf(AdmissionDenied);
});

test('a pending Org reply draft cannot disclose its saved administrator proof without Person authority', async () => {
  const identity = principal();
  const organization = await actor(identity, 'organization');
  const rootTarget = nativeId();
  const rootRevision = randomUUID();
  const input = request(identity, organization.agent, 'content.draft', `content:draft:${nativeId()}`, {
    baselineRelatedWork: rootTarget, baselineSourceRevision: rootRevision,
  });
  await platformAdministratorGrants(organization.principalId, organization.agent,
    input.action, input.scope);
  const id = await legacyAdministratorAdmission(input, organization.principalId);

  await expect(organization.access.register(input)).rejects.toBeInstanceOf(AdmissionDenied);
  await expect(organization.access.register({ ...input, idempotencyKey: randomUUID() }))
    .rejects.toBeInstanceOf(AdmissionDenied);
  expect((await pool.query('SELECT state FROM access.admission WHERE id = $1', [id])).rows)
    .toEqual([{ state: 'registered' }]);
});

test('a Person with platform administrator and resource grants still saves the baseline reply proof', async () => {
  const identity = principal();
  const person = await actor(identity, 'person');
  const rootTarget = nativeId();
  const rootRevision = randomUUID();
  const input = request(identity, person.agent, 'content.draft', `content:draft:${nativeId()}`, {
    baselineRelatedWork: rootTarget, baselineSourceRevision: rootRevision,
  });
  await platformAdministratorGrants(person.principalId, person.agent, input.action, input.scope);

  const client = await pool.connect();
  try {
    expect(await platformAdministratorProof(client, person.principalId, person.agent, true,
      { action: input.action, scope: input.scope })).not.toBeNull();
  } finally {
    client.release();
  }

  const admitted = await person.access.register(input);
  expect(admitted.dispatchEligible).toBe(true);
  expect((await pool.query(`SELECT b.provision_id, b.related_work, b.source_revision, p.agent_kind
    FROM access.baseline_admission b JOIN access.agent_provision p ON p.id = b.provision_id
    WHERE b.admission_id = $1`, [admitted.id])).rows[0]).toEqual({
    provision_id: person.provisionId, related_work: rootTarget,
    source_revision: rootRevision, agent_kind: 'person',
  });
  expect((await pool.query('SELECT admission_id FROM access.platform_administrator_admission WHERE admission_id = $1',
    [admitted.id])).rowCount).toBe(0);
});

test.each(['content.draft', 'media.member-reply.use'])(
  'an installed %s policy refuses baseline and explicit-grant substitution', async action => {
  const identity = principal();
  const member = await actor(identity, 'person');
  const target = nativeId();
  const scope = `content:draft:${target}`;
  const sources = await grant(member.principalId, member.agent, action, scope);
  const policyId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1 WHERE id = $1', [scope]);
    const epoch = (await client.query<{ authority_epoch: string }>(
      'SELECT authority_epoch::text FROM access.scope_gate WHERE id = $1', [scope])).rows[0]!.authority_epoch;
    await client.query(`INSERT INTO access.policy (id, scope_id, owner_subject, head_revision)
      VALUES ($1,$2,$3,1)`, [policyId, scope, member.agent]);
    await client.query(`INSERT INTO access.policy_revision
      (policy_id, revision, scope_id, profile, combining_algorithm, default_effect,
       mandatory_count, ordered_count, reference_count, max_states, max_input_rows, deadline_ms, digest,
       published_by_principal, publisher_subject, publisher_representation_id,
       publisher_representation_generation, publisher_grant_id, publisher_grant_generation,
       result_authority_epoch)
      VALUES ($1,1,$2,'access-policy-v1','first-applicable','deny',0,0,0,100,100,500,$3,
        $4,$5,$6,0,$7,0,$8)`, [policyId, scope, digest(policyId), member.principalId, member.agent,
      sources.representationId, sources.grantId, epoch]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const input = request(identity, member.agent, action, scope,
    { baselineRelatedWork: nativeId(),
      baselineSourceRevision: action === 'content.draft' ? randomUUID() : nativeId() });
  await expect(member.access.register(input)).rejects.toBeInstanceOf(AdmissionDenied);
});

test.each(['reply.create', 'media.member-reply.use'])(
  'a pending legacy %s without Person proof remains nondispatchable', async action => {
  const identity = principal();
  const member = await actor(identity, 'person');
  const rootTarget = nativeId();
  const rootRevision = action === 'reply.create' ? randomUUID() : nativeId();
  const input = request(identity, member.agent, action,
    action === 'reply.create' ? `reply:create:${rootTarget}` : `content:draft:${nativeId()}`, {
    ...(action === 'media.member-reply.use' ? { baselineRelatedWork: rootTarget } : {}),
    baselineSourceRevision: rootRevision,
  });
  const id = randomUUID();
  await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [input.scope]);
  await pool.query(`INSERT INTO access.admission
    (id, principal_id, acting_subject, scope_id, action, idempotency_key, request_digest,
     authority_epoch, expires_at, state, authority_witness)
    SELECT $1,$2,$3,$4,$5,$6,$7,g.authority_epoch,clock_timestamp() + interval '1 minute','registered',
      jsonb_build_array(jsonb_build_object('table','principal','id',($2::uuid)::text,'generation','0'),
        jsonb_build_object('table','authority_subject','id',$3::text,'generation','0'))
    FROM access.scope_gate g WHERE g.id = $4`,
  [id, member.principalId, member.agent, input.scope, input.action, input.idempotencyKey, input.requestDigest]);
  await pool.query(`INSERT INTO access.admission_receipt
    (admission_id, principal_id, action, idempotency_key, request_digest, outcome)
    VALUES ($1,$2,$3,$4,$5,'registered')`,
  [id, member.principalId, input.action, input.idempotencyKey, input.requestDigest]);

  expect(await member.access.register(input)).toMatchObject({ id, replayed: true, dispatchEligible: false });
  await expect(member.access.claim(id, input.requestDigest, identity)).rejects.toBeInstanceOf(AdmissionDenied);
});

test('member-reply Media saves and rechecks its own Person and exact root proof through final dispatch', async () => {
  const identity = principal();
  const person = await actor(identity, 'person');
  const rootTarget = nativeId();
  const rootRevision = nativeId();
  const input = request(identity, person.agent, 'media.member-reply.use', `content:draft:${nativeId()}`, {
    baselineRelatedWork: rootTarget, baselineSourceRevision: rootRevision,
  });
  await grant(person.principalId, person.agent, input.action, input.scope);
  await platformAdministratorGrants(person.principalId, person.agent, input.action, input.scope);

  const admitted = await person.access.register(input);
  expect(admitted.dispatchEligible).toBe(true);
  expect((await pool.query(`SELECT b.provision_id, b.related_work, b.source_revision, b.author_work,
    p.agent_kind FROM access.baseline_admission b JOIN access.agent_provision p ON p.id = b.provision_id
    WHERE b.admission_id = $1`, [admitted.id])).rows[0]).toEqual({
    provision_id: person.provisionId, related_work: rootTarget, source_revision: rootRevision,
    author_work: null, agent_kind: 'person',
  });
  expect((await pool.query('SELECT admission_id FROM access.platform_administrator_admission WHERE admission_id = $1',
    [admitted.id])).rowCount).toBe(0);
  expect(await person.access.register(input)).toMatchObject({ id: admitted.id, replayed: true, dispatchEligible: true });
  for (const changed of [
    { requestDigest: digest('different Media use') },
    { baselineRelatedWork: nativeId() },
    { baselineSourceRevision: nativeId() },
  ]) {
    await expect(person.access.register({ ...input, ...changed })).rejects.toBeInstanceOf(AdmissionConflict);
  }
  await person.access.claim(admitted.id, input.requestDigest, identity);
  let dispatched = 0;
  await person.access.withOwnerAuthority(input, async client => {
    await person.access.fenceClaim(client, admitted.id, input.requestDigest, identity);
    dispatched++;
  });
  expect(dispatched).toBe(1);
  expect(rootReads.at(-1)).toMatchObject({ resource: rootTarget, revision: rootRevision,
    principal: { issuer: identity.issuer, subject: identity.subject }, actor: person.agent });
  await expect(person.access.withOwnerAuthority(input, async client => {
    rootDecisions.set(`${rootTarget}:${rootRevision}`, false);
    await person.access.fenceClaim(client, admitted.id, input.requestDigest, identity);
    dispatched++;
  })).rejects.toBeInstanceOf(AdmissionDenied);
  expect(dispatched).toBe(1);
});

test('member-reply Media refuses foreign controllers, non-Persons and grant or administrator substitutes', async () => {
  const identity = principal();
  const person = await actor(identity, 'person');
  const foreign = await actor(principal(), 'person');
  const organization = await actor(identity, 'organization');
  const service = await actor(identity, 'service');
  const unprovisioned = await actor(identity, 'person', false);
  for (const selected of [foreign, organization, service, unprovisioned]) {
    const input = request(identity, selected.agent, 'media.member-reply.use', `content:draft:${nativeId()}`, {
      baselineRelatedWork: nativeId(), baselineSourceRevision: nativeId(),
    });
    await grant(person.principalId, selected.agent, input.action, input.scope);
    await platformAdministratorGrants(person.principalId, selected.agent, input.action, input.scope);
    let dispatched = false;
    await expect(person.access.register(input)).rejects.toBeInstanceOf(AdmissionDenied);
    await expect(person.access.withOwnerAuthority(input, async () => { dispatched = true; }))
      .rejects.toBeInstanceOf(AdmissionDenied);
    expect(dispatched).toBe(false);
  }
  const input = request({ ...identity, emailVerified: false }, person.agent,
    'media.member-reply.use', `content:draft:${nativeId()}`, {
      baselineRelatedWork: nativeId(), baselineSourceRevision: nativeId(),
    });
  await expect(person.access.register(input)).rejects.toBeInstanceOf(AdmissionDenied);
});

test('member-reply Media cannot fall through to Work authority with malformed or missing root metadata', async () => {
  const identity = principal();
  const person = await actor(identity, 'person');
  const reply = nativeId();
  const scope = `content:draft:${reply}`;
  const metadata = { baselineRelatedWork: nativeId(), baselineSourceRevision: nativeId() };
  authoredWorks.set(`${person.principalId}:${person.agent}:${reply}`, '0');
  await grant(person.principalId, person.agent, 'media.member-reply.use', scope);
  await platformAdministratorGrants(person.principalId, person.agent, 'media.member-reply.use', scope);
  for (const invalid of [
    { baselineRelatedWork: undefined, baselineSourceRevision: undefined },
    { baselineRelatedWork: undefined }, { baselineSourceRevision: undefined },
    { baselineRelatedWork: 'https://example.test/root' }, { baselineSourceRevision: randomUUID() },
    { baselineContribution: nativeId() }, { baselineCollectionCreate: true },
    { resolvedZonePage: nativeId() }, { editorialPermit: randomUUID() },
    { scope: `content:publish:${reply}` }, { scope: 'content:draft:invalid' },
    { requireExplicitGrant: true }, { authorityPath: 'direct-principal' as const },
  ]) {
    const input = request(identity, person.agent, 'media.member-reply.use', scope, { ...metadata, ...invalid });
    await expect(person.access.register(input)).rejects.toBeInstanceOf(AdmissionDenied);
  }
  expect((await pool.query('SELECT id FROM access.admission WHERE scope_id = $1', [scope])).rowCount).toBe(0);
});

test.each(['control', 'email', 'root'] as const)(
  'member-reply Media stops replay, claim and final dispatch after %s authority loss', async loss => {
    const identity = principal();
    const person = await actor(identity, 'person');
    const input = request(identity, person.agent, 'media.member-reply.use', `content:draft:${nativeId()}`, {
      baselineRelatedWork: nativeId(), baselineSourceRevision: nativeId(),
    });
    const admitted = await person.access.register(input);
    await person.access.claim(admitted.id, input.requestDigest, identity);
    if (loss === 'control') {
      const replacementPrincipalId = randomUUID();
      await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
        VALUES ($1,'https://replacement.reply-authorship.test',$2)`, [replacementPrincipalId, randomUUID()]);
      await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,'agent.control','infinity')`, [randomUUID(), replacementPrincipalId, person.agent]);
      await pool.query('UPDATE access.representation SET active = false WHERE id = $1', [person.controlId]);
    } else if (loss === 'email') {
      identity.emailVerified = false;
      identity.currentAssertion = async () => identity;
    } else {
      rootDecisions.set(`${input.baselineRelatedWork}:${input.baselineSourceRevision}`, false);
    }
    await expect(person.access.register(input)).rejects.toBeInstanceOf(AdmissionDenied);
    await expect(person.access.claim(admitted.id, input.requestDigest, identity)).rejects.toBeInstanceOf(AdmissionDenied);
    let dispatched = false;
    await expect(person.access.withOwnerAuthority(input, async () => { dispatched = true; }))
      .rejects.toBeInstanceOf(AdmissionDenied);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(person.access.fenceClaim(client, admitted.id, input.requestDigest, identity))
        .rejects.toBeInstanceOf(AdmissionDenied);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(dispatched).toBe(false);
  });

test('member-reply Media distinguishes unavailable root reads from denied or superseded roots', async () => {
  const identity = principal();
  const person = await actor(identity, 'person');
  const input = request(identity, person.agent, 'media.member-reply.use', `content:draft:${nativeId()}`, {
    baselineRelatedWork: nativeId(), baselineSourceRevision: nativeId(),
  });
  const rootKey = `${input.baselineRelatedWork}:${input.baselineSourceRevision}`;
  const admitted = await person.access.register(input);
  await person.access.claim(admitted.id, input.requestDigest, identity);
  rootDecisions.set(rootKey, new WorkReadMoved('root revision moved'));
  await expect(person.access.register(input)).rejects.toBeInstanceOf(WorkReadMoved);
  await expect(person.access.claim(admitted.id, input.requestDigest, identity)).rejects.toBeInstanceOf(WorkReadMoved);
  rootDecisions.set(rootKey, new WorkReadUnavailable('root owner unavailable'));
  await expect(person.access.register(input)).rejects.toBeInstanceOf(AdmissionUnavailable);
  await expect(person.access.claim(admitted.id, input.requestDigest, identity)).rejects.toBeInstanceOf(AdmissionUnavailable);
  let dispatched = false;
  await expect(person.access.withOwnerAuthority(input, async () => { dispatched = true; }))
    .rejects.toBeInstanceOf(AdmissionUnavailable);
  expect(dispatched).toBe(false);
  rootDecisions.set(rootKey, false);
  await expect(person.access.register({ ...input, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(AdmissionDenied);
  await expect(person.access.register(input)).rejects.toBeInstanceOf(AdmissionDenied);
});
