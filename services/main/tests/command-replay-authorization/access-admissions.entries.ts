import { afterAll, beforeAll, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../../tests/qa/support/postgres-cluster.ts';
import { AccessAdmissionRegistry, AdmissionConflict, AdmissionDenied } from '../../src/modules/access/admission.ts';
import { deactivateFixtureController, grantFixtureAgentAttribution,
  grantFixtureAuthority, grantFixturePrincipalAuthority, provisionFixturePerson,
  reduceFixtureGrant, registerFixtureIdentity } from '../../src/modules/access/fixture-authority.ts';
import { AccessPlatformAdministrators } from '../../src/modules/access/platform-administrator.ts';
import { AccessPlatformGrants } from '../../src/modules/access/platform-grants.ts';
import { AccessRepresentations } from '../../src/modules/access/representations.ts';
import { createAdmittedMetadataWork } from '../../src/modules/work/create-admitted.ts';
import { setWorkMetadata } from '../../src/modules/work/metadata-command.ts';
import { setAdmittedWorkScalar } from '../../src/modules/work/edit-admitted.ts';
import { createAdmittedRatingContext } from '../../src/modules/rating/context-admitted.ts';
import { createAdmittedRealmSpace } from '../../src/modules/space/create-admitted.ts';
import { fromPlainText } from '@rezics/document';
import { realmReplyDigest } from '../../src/modules/realm-reply/store.ts';
import { registerReplayCases } from './driver.ts';
import { type ReplayEntry, type Member, type Loss, root, stack, request, principal,
  graphSnapshot, head, loseGrant } from './fixtures.ts';

// Build a current owner schema once and restore isolated copies. No admission,
// saved result or effect is seeded; commands create all replay evidence.
let controllerCluster: PostgresCluster;
let controllerTemplate: Pool;
const controllerCopies: Pool[] = [];
beforeAll(async () => {
  controllerCluster = await startPostgresCluster();
  controllerTemplate = new Pool({ ...controllerCluster.connection, max: 2 });
  await controllerTemplate.query('CREATE DATABASE replay_controller_template');
  const template = new Pool({ ...controllerCluster.connection, database: 'replay_controller_template', max: 2 });
  try {
    for (const file of schemaFiles(root, 'access')) {
      await template.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
  } finally { await template.end(); }
});
afterAll(async () => {
  await Promise.all(controllerCopies.map(pool => pool.end()));
  await controllerTemplate?.end();
  controllerCluster?.remove();
});

async function controllerOwner(member: Member, loss: Loss, administrator: boolean) {
  const database = `replay_${randomUUID().replaceAll('-', '')}`;
  await controllerTemplate.query(`CREATE DATABASE "${database}" TEMPLATE replay_controller_template`);
  const pool = new Pool({ ...controllerCluster.connection, database, max: 4 });
  controllerCopies.push(pool);
  const spare = await stack.member(randomUUID());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const person of [member, spare]) await registerFixtureIdentity(client, {
      principalId: person.principalId, actor: person.actor, ...person.principal,
    });
    await grantFixtureAuthority(client, { scope: 'work:create:root', requireDispatch: true,
      representations: [{ principalId: member.principalId, actor: member.actor, action: 'agent.control',
        lifetime: 'infinity' },
      { principalId: spare.principalId, actor: administrator ? spare.actor : member.actor,
        action: 'agent.control', lifetime: 'infinity' }],
      grant: { actor: member.actor, action: 'agent.control', lifetime: 'infinity' } });
    await client.query('COMMIT');
  } finally { client.release(); }
  const issueResource = async (action: string, validUntil: Date | null, scope = 'platform:access') => {
    const epoch = (await pool.query<{ authority_epoch: string }>(`SELECT authority_epoch::text
      FROM access.scope_gate WHERE id = 'platform:access'`)).rows[0]!.authority_epoch;
    return new AccessPlatformGrants(pool).create({ principal: await principal(spare),
      issuerSubject: spare.actor, expectedAuthorityEpoch: epoch }, randomUUID(), action,
    { principalId: member.principalId }, validUntil,
    { idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) }, scope);
  };
  const resourceDeadline = loss === 'expired' ? new Date(Date.now() + 30_000) : null;
  let resourceGrant: string | null = null;
  if (administrator) {
    await new AccessPlatformAdministrators(pool).designateFirst(
      spare.principal.issuer, spare.principal.subject, () => {});
    await issueResource('platform:use:platform-admin', null);
    resourceGrant = (await issueResource('platform:resource:work.create', resourceDeadline, 'work:create:root')).grant.id;
  } else await provisionFixturePerson(pool, { principalId: member.principalId,
    actor: member.actor, dataEpoch: stack.env.lineage.dataEpoch });
  const control = (await pool.query<{ id: string }>(`SELECT id FROM access.representation
    WHERE principal_id = $1 AND subject_id = $2 AND action = 'agent.control'`,
  [member.principalId, member.actor])).rows[0]!.id;
  const access = new AccessAdmissionRegistry(pool);
  access.configureBaseline(stack.fuseki);
  return { access, pool, lose: async () => {
    if (resourceDeadline && resourceGrant) {
      // Platform episodes retain their issued deadline. Wait for this real,
      // finite owner grant to expire rather than changing an immutable episode.
      await pool.query(`SELECT pg_sleep(GREATEST(0,
        EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp()))) + 0.01)`, [resourceDeadline]);
    } else if (resourceGrant) await reduceFixtureGrant(pool, resourceGrant, { active: false });
    else await deactivateFixtureController(pool, control);
  }, restore: async () => {
    await grantFixtureAuthority(pool, { scope: 'work:create:root', requireDispatch: true,
      representations: [{ principalId: member.principalId, actor: member.actor,
        action: 'agent.control', lifetime: 'infinity' }],
      grant: { actor: member.actor, action: 'agent.control', lifetime: 'infinity' } });
    if (administrator) await issueResource('platform:resource:work.create', null, 'work:create:root');
  } };
}

async function admissionSnapshot(pool: Pool, member: Member, resource: string, receipt: string) {
  return { graph: await graphSnapshot(resource, receipt),
    admissions: (await pool.query(`SELECT to_jsonb(a) AS row FROM access.admission a
      WHERE principal_id = $1 ORDER BY id`, [member.principalId])).rows,
    receipts: (await pool.query(`SELECT to_jsonb(r) AS row FROM access.admission_receipt r
      WHERE principal_id = $1 ORDER BY admission_id,outcome`, [member.principalId])).rows,
    proofs: (await pool.query(`SELECT kind,row FROM (
      SELECT 'baseline' AS kind,to_jsonb(b) AS row FROM access.baseline_admission b
        JOIN access.admission a ON a.id = b.admission_id WHERE a.principal_id = $1
      UNION ALL SELECT 'administrator',to_jsonb(b) FROM access.platform_administrator_admission b
        JOIN access.admission a ON a.id = b.admission_id WHERE a.principal_id = $1
      UNION ALL SELECT 'rating',to_jsonb(b) FROM access.realm_rating_admission b
        JOIN access.admission a ON a.id = b.admission_id WHERE a.principal_id = $1
      ) proofs ORDER BY kind,row->>'admission_id'`, [member.principalId])).rows };
}

async function advanceWorkHead(member: Member, pool: Pool, access: AccessAdmissionRegistry,
  saved: Awaited<ReturnType<typeof createAdmittedMetadataWork>>) {
  await grantFixtureAuthority(pool, { scope: `work:edit:${saved.work}`, requireDispatch: true,
    representations: [{ principalId: member.principalId, actor: member.actor, action: 'work.edit', lifetime: '8 hours' }],
    grant: { actor: member.actor, action: 'work.edit', lifetime: '8 hours' } });
  await setAdmittedWorkScalar(stack.env, stack.composition.dependencies.account, access, request(member), {
    work: saved.work, expectedHead: saved.workRevision, scalarValue: { kind: 'boolean', lexical: 'false' },
    actingSubject: member.actor, idempotencyKey: randomUUID() });
}

export const entries: ReplayEntry[] = [
  { operation: 'POST /v1/works', authorityClass: 'domain-grant',
    scope: 'work:create:root', action: 'work.create', family: 'shared Access admissions',
    owners: ['modules/work/create-admitted.ts#createAdmittedMetadataWork'],
    subcases: ['represented Work creation', 'represented Work creation mandate', 'direct-principal Work creation'],
    denied: AdmissionDenied, conflict: AdmissionConflict, registration: 'turned',
    requestBuilder: async (subcase, loss) => {
      const direct = subcase === 'direct-principal Work creation';
      const member = await stack.member(randomUUID());
      const pool = stack.accessPool;
      const access = stack.access;
      const grant = direct
        ? await grantFixturePrincipalAuthority(pool, { principalId: member.principalId, actor: member.actor,
          scope: 'work:create:root', action: 'work.create', lifetime: '8 hours', requireDispatch: true })
        : await member.grant('work:create:root', 'work.create');
      if (direct) await grantFixtureAgentAttribution(pool, { principalId: member.principalId, actor: member.actor,
        scope: 'work:create:root', action: 'work.create', lifetime: '8 hours', requireDispatch: true });
      const input = { actingSubject: member.actor, title: `Replay ${randomUUID()}`,
        language: 'en', idempotencyKey: randomUUID(),
        ...(direct ? { authorityPath: 'direct-principal' as const } : {}) };
      let saved: Awaited<ReturnType<typeof createAdmittedMetadataWork>>;
      return { command: async (fresh, changed) => {
        const result = await createAdmittedMetadataWork(stack.env, stack.composition.dependencies.account,
          access, request(member), { ...input, ...(fresh ? { idempotencyKey: randomUUID() } : {}),
            ...(changed ? { title: 'Different binding' } : {}) });
        saved ??= result;
        return result;
      }, advance: () => advanceWorkHead(member, pool, access, saved), lose: async () => {
        if (subcase === 'represented Work creation mandate' && loss === 'revoked') {
          await member.grant('work:create:root', 'access.representation.manage');
          const mandate = (await pool.query<{ id: string; generation: string }>(`SELECT id,generation::text
            FROM access.representation WHERE principal_id = $1 AND subject_id = $2 AND action = 'work.create'`,
          [member.principalId, member.actor])).rows[0]!;
          const epoch = (await pool.query<{ authority_epoch: string }>(`SELECT authority_epoch::text
            FROM access.scope_gate WHERE id = 'work:create:root'`)).rows[0]!.authority_epoch;
          await new AccessRepresentations(pool).revoke({ principal: await principal(member), issuerSubject: member.actor,
            expectedAuthorityEpoch: epoch, idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) },
          mandate.id, mandate.generation);
        } else await loseGrant(member, grant!, loss);
      }, restore: async () => {
        if (direct) {
          await grantFixturePrincipalAuthority(pool, { principalId: member.principalId, actor: member.actor,
            scope: 'work:create:root', action: 'work.create', lifetime: '8 hours', requireDispatch: true });
          await grantFixtureAgentAttribution(pool, { principalId: member.principalId, actor: member.actor,
            scope: 'work:create:root', action: 'work.create', lifetime: '8 hours', requireDispatch: true });
        } else await member.grant('work:create:root', 'work.create');
      }, snapshot: () => admissionSnapshot(pool, member, saved.work, saved.receipt) };
    } }
];

// These commands belong to other areas' named uncovered inventories. Qualify
// their shared Access branches without changing those owners' coverage claims.
const sharedPathQualifications: ReplayEntry[] = [
  ...(['baseline', 'administrator'] as const).map((kind): ReplayEntry => ({
    operation: 'POST /v1/works', authorityClass: kind === 'baseline' ? 'controller' : 'domain-grant',
    scope: 'work:create:root', action: 'work.create',
    family: `shared Access ${kind} admissions`, owners: ['modules/work/create-admitted.ts#createAdmittedMetadataWork'],
    subcases: [`saved ${kind} Work creation`], ...(kind === 'baseline' ? { losses: ['revoked'] as Loss[] } : {}),
    denied: AdmissionDenied, conflict: AdmissionConflict, registration: 'turned',
    requestBuilder: async (_subcase, loss) => {
      const member = await stack.member(randomUUID(), { verified: true });
      const owner = await controllerOwner(member, loss, kind === 'administrator');
      const input = { actingSubject: member.actor, title: `Saved ${kind}`, language: 'en', idempotencyKey: randomUUID(),
        ...(kind === 'baseline' ? { authorAgent: member.actor } : {}) };
      let saved: Awaited<ReturnType<typeof createAdmittedMetadataWork>>;
      return { command: async (fresh, changed) => {
        const result = await createAdmittedMetadataWork(stack.env, stack.composition.dependencies.account,
          owner.access, request(member), { ...input, ...(fresh ? { idempotencyKey: randomUUID() } : {}),
            ...(changed ? { title: 'Different binding' } : {}) });
        saved ??= result;
        return result;
      }, advance: () => advanceWorkHead(member, owner.pool, owner.access, saved),
      lose: owner.lose, restore: owner.restore,
      snapshot: () => admissionSnapshot(owner.pool, member, saved.work, saved.receipt) };
    },
  })),
  { operation: 'PUT /v1/works/{}/metadata', authorityClass: 'domain-grant',
    scope: 'work:edit:{work}', action: 'work.edit', family: 'shared Access metadata admissions',
    owners: ['modules/work/metadata-command.ts#setWorkMetadata'], subcases: ['represented sealed Work edit'],
    denied: AdmissionDenied, conflict: AdmissionConflict, registration: 'turned',
    requestBuilder: async () => {
      const member = await stack.member(randomUUID());
      await member.grant('work:create:root', 'work.create');
      const work = await createAdmittedMetadataWork(stack.env, stack.composition.dependencies.account,
        stack.access, request(member), { actingSubject: member.actor, title: 'Metadata replay target',
          language: 'en', idempotencyKey: randomUUID() });
      const grant = await member.grant(`work:edit:${work.work}`, 'work.edit');
      const input = { work: work.work, expectedHead: null, actingSubject: member.actor, idempotencyKey: randomUUID(),
        state: { kind: 'header' as const, originalTitle: null, localized: [{ language: 'en', title: 'Saved title',
          description: 'Saved description', mainVersionLabel: null }] } };
      let saved: Awaited<ReturnType<typeof setWorkMetadata>>;
      return { command: async (fresh, changed) => {
        const result = await setWorkMetadata(stack.composition.dependencies, request(member), { ...input,
          ...(fresh ? { idempotencyKey: randomUUID() } : {}),
          ...(changed ? { state: { ...input.state, originalTitle: { value: 'Different binding', language: 'en' } } } : {}) });
        saved ??= result;
        return result;
      }, advance: async () => { await setWorkMetadata(stack.composition.dependencies, request(member), {
        ...input, expectedHead: saved.revision, idempotencyKey: randomUUID(),
        state: { ...input.state, originalTitle: { value: 'Advanced head', language: 'en' } } }); },
      lose: loss => loseGrant(member, grant, loss),
      restore: async () => { await member.grant(`work:edit:${work.work}`, 'work.edit'); },
      snapshot: () => admissionSnapshot(stack.accessPool, member, saved.component, saved.receipt) };
    } },
  { operation: 'POST /v1/spaces', authorityClass: 'domain-grant',
    scope: 'space:create:root', action: 'space.create', family: 'shared Access saved witness admissions',
    owners: ['modules/space/create-admitted.ts#createAdmittedRealmSpace'], subcases: ['sealed generic witness'],
    denied: AdmissionDenied, conflict: AdmissionConflict, registration: 'turned',
    requestBuilder: async () => {
      const member = await stack.member(randomUUID());
      const grant = await member.grant('space:create:root', 'space.create');
      const input = { name: 'Saved Realm', actingSubject: member.actor, idempotencyKey: randomUUID() };
      let saved: Awaited<ReturnType<typeof createAdmittedRealmSpace>>;
      return { command: async (fresh, changed) => {
        const result = await createAdmittedRealmSpace(stack.env, stack.composition.dependencies.account,
          stack.access, request(member), { ...input, ...(fresh ? { idempotencyKey: randomUUID() } : {}),
            ...(changed ? { name: 'Different binding' } : {}) }, stack.composition.dependencies.realmAdmin);
        saved ??= result;
        return result;
      }, lose: loss => loseGrant(member, grant, loss),
      restore: async () => { await member.grant('space:create:root', 'space.create'); },
      snapshot: () => admissionSnapshot(stack.accessPool, member, saved.realm!, saved.receipt) };
    } },
  { operation: 'POST /v1/realm-reply-placements', authorityClass: 'domain-grant',
    scope: 'reply:place:{realm}', action: 'reply.place', family: 'shared Access Realm participation admissions',
    owners: ['modules/realm-reply/store.ts#RealmReplyStore.place'], subcases: ['sealed result after Realm participation denial'],
    losses: ['revoked'], denied: AdmissionDenied, conflict: AdmissionConflict, registration: 'turned',
    requestBuilder: async () => {
      const member = await stack.member(randomUUID(), { verified: true });
      await provisionFixturePerson(stack.accessPool, { principalId: member.principalId, actor: member.actor,
        dataEpoch: stack.env.lineage.dataEpoch });
      const created = await member.send('POST', '/v1/spaces', { profile: 'space-realm-v1',
        name: 'Replay conversation', capabilities: ['realm'], actingSubject: member.actor,
        initialSettings: { visibility: 'public', reviewRequired: false, reviewMode: 'open',
          whoMaySubmit: 'granted', selfJoin: false, rules: [] } });
      expect(created.status, await created.clone().text()).toBe(201);
      const { realm } = await created.json() as { realm: string };
      const work = await stack.publicWork(member.actor);
      const rootRevision = await head(work.work);
      const reply = `https://rezics.com/id/${randomUUID()}`, variantId = `urn:rezics:variant:${randomUUID()}`;
      const draft = await member.send('POST', '/v1/member-reply-drafts', { profile: 'member-reply-draft-v1',
        reply, variantId, rootTarget: work.work, rootRevision, expectedHead: null,
        language: 'en', direction: 'ltr', document: fromPlainText('Replay participation', 'blocks'),
        actingSubject: member.actor });
      expect(draft.status, await draft.clone().text()).toBe(201);
      const revision = await draft.json() as { revisionId: string; revisionDigest: string };
      const owner = stack.composition.dependencies.realmReplies!;
      const identity = { reply, variantId, revisionId: revision.revisionId, author: member.actor,
        rootTarget: work.work, rootRevision, parentReply: null, parentRevision: null, contextRevision: null };
      await owner.create(await principal(member), identity, randomUUID(), realmReplyDigest(identity));
      const manager = await stack.member(randomUUID());
      await manager.grant(`governance:realm:${realm}`, 'realm.members.manage');
      await manager.grant(`governance:realm:${realm}`, 'realm.settings.manage');
      const input = { realm, reply, revisionId: revision.revisionId, revisionDigest: revision.revisionDigest,
        reviewDecisionId: null, expectedHead: null };
      const key = randomUUID();
      const manage = async (action: 'ban' | 'unban') => {
        const { generation } = await stack.composition.dependencies.realmAdmin!.settings(
          await principal(manager), realm, manager.actor, stack.env);
        const membership = (await stack.accessPool.query<{ generation: string }>(`SELECT generation::text
          FROM access.membership WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2`,
        [realm, member.actor])).rows[0];
        await stack.composition.dependencies.realmAdmin!.changeMember(await principal(manager), realm, {
          actingSubject: manager.actor, member: member.actor, action, expectedGeneration: generation,
          expectedMembershipGeneration: membership?.generation ?? '0',
          reason: 'Replay authority qualification', consent: null, durationSeconds: null,
        }, randomUUID(), stack.env);
      };
      return { command: async (fresh, changed) => {
        const intent = { ...input, ...(changed ? { revisionDigest: 'b'.repeat(64) } : {}) };
        const result = await owner.place(await principal(member), member.actor, intent,
          fresh ? randomUUID() : key, realmReplyDigest(intent));
        return result;
      }, lose: () => manage('ban'), restore: () => manage('unban'),
      snapshot: async () => {
        const admission = (await stack.accessPool.query<{ id: string; graph_receipt: string }>(`SELECT id,graph_receipt
          FROM access.admission WHERE principal_id = $1 AND action = 'reply.place' AND idempotency_key = $2`,
        [member.principalId, key])).rows[0]!;
        return { admission: await admissionSnapshot(stack.accessPool, member, reply, admission.graph_receipt),
          contentReceipts: (await stack.contentPool.query(`SELECT to_jsonb(r) AS row FROM content.receipt r
            WHERE operation_id = $1 OR operation_id = $1 || ':settle' ORDER BY operation_id`, [admission.id])).rows,
          revision: (await stack.contentPool.query(`SELECT to_jsonb(r) AS row FROM content.revision r
            WHERE id = $1`, [revision.revisionId])).rows };
      } };
    } },
  { operation: 'POST /v1/rating-contexts', authorityClass: 'domain-grant',
    scope: 'rating:context:{realm}', action: 'rating.context.create', family: 'shared Access rating admissions',
    owners: ['modules/rating/context-admitted.ts#createAdmittedRatingContext'], subcases: ['saved Realm rating authority'],
    denied: AdmissionDenied, conflict: AdmissionConflict, registration: 'turned',
    requestBuilder: async () => {
      const member = await stack.member(randomUUID());
      await member.grant('space:create:root', 'space.create');
      const created = await member.send('POST', '/v1/spaces', { profile: 'space-realm-v1',
        name: 'Replay rating Realm', capabilities: ['realm'], actingSubject: member.actor });
      expect(created.status, await created.clone().text()).toBe(201);
      const { realm } = await created.json() as { realm: string };
      const grant = await member.grant(`governance:realm:${realm}`, 'rating.configure');
      const input = { realm, question: 'Saved question', actingSubject: member.actor, idempotencyKey: randomUUID() };
      let saved: Awaited<ReturnType<typeof createAdmittedRatingContext>>;
      return { command: async (fresh, changed) => {
        const result = await createAdmittedRatingContext(stack.env, stack.composition.dependencies.account,
          stack.access, request(member), { ...input, ...(fresh ? { idempotencyKey: randomUUID() } : {}),
            ...(changed ? { question: 'Different binding' } : {}) });
        saved ??= result;
        return result;
      }, lose: loss => loseGrant(member, grant, loss),
      restore: async () => { await member.grant(`governance:realm:${realm}`, 'rating.configure'); },
      snapshot: () => admissionSnapshot(stack.accessPool, member, saved.context!, saved.receipt) };
    } }
];
registerReplayCases(sharedPathQualifications);
