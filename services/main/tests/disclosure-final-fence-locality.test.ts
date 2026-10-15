import { afterAll, beforeAll, expect, test } from 'bun:test';
import { foregroundCounted } from '../../../tests/qa/integration/support/operation-cost.ts';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { grantFixtureAuthority, registerFixtureIdentity } from '../src/modules/access/fixture-authority.ts';
import { engageAccessRecoveryFence, releaseAccessRecoveryFence } from '../src/modules/access/admission.ts';
import { migrateContent } from '../../content/src/index.ts';
import { MediaStore } from '../src/modules/media/store.ts';
import { configureMediaVisibility } from '../src/modules/media/visibility.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { discloseContent } from '../src/modules/disclosure/assembly.ts';
import { DISCLOSURE_SUBMISSION_LIMIT } from '../src/modules/disclosure/contract-batching.ts';
import { discloseSearchMatches } from '../src/modules/disclosure/search.ts';
import { scopedEnforcementBasis, SCOPED_ENFORCEMENT_BASIS_SQL } from '../src/modules/disclosure/fence-scope.ts';
import { captureDisclosure, configureDisclosure, configureDisclosureAncestrySource, discloseInventoryWithCost,
  fenceDisclosure, DisclosureStore, DisclosureUnavailable, resolveDisclosureSelections,
  type DisclosureAncestryEvidence, type DisclosureChannel, type DisclosureTarget,
  type OwnerEstablishedGraphParents } from '../src/modules/disclosure/read.ts';
import { GLOBAL_CONTEXT, GovernanceStore, type DecisionInput, type EvidenceTarget } from '../src/modules/governance/store.ts';
import { SPACE_REALM_PROFILE } from '../src/modules/space/create.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => `https://rezics.com/id/${randomUUID()}`;
const rule = { ref: 'urn:rezics:rule:fence-locality', revision: '1', digest: 'a'.repeat(64) };
const principal = { issuer: 'https://account.fence-locality.test', subject: randomUUID() };
const principalId = randomUUID(), actor = native();
const heads = new Map<string, string>();
const realms = new Map<string, string>();
const evidence = new Map<string, DisclosureAncestryEvidence>();
const environment = { fuseki: new FusekiClient('http://graph.invalid'), objectDirectory: '.temp/fence-locality',
  lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
let cluster: PostgresCluster | undefined;
let pool: Pool;
let governance: GovernanceStore;
let reader: DisclosureStore;

beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 6 });
  await migrateContent(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of schemaFiles(root, 'access')) {
      await client.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    await registerFixtureIdentity(client, { principalId, ...principal, actor });
    await grantFixtureAuthority(client, { scope: 'governance:platform', requireDispatch: true,
      representations: [{ principalId, actor, action: 'governance.moderate', lifetime: 'infinity' }],
      grant: { actor, action: 'governance.moderate', lifetime: 'infinity' } });
    await client.query('COMMIT');
  } catch (cause) {
    await client.query('ROLLBACK');
    throw cause;
  } finally { client.release(); }
  governance = governanceStore(pool);
  reader = new DisclosureStore(pool);
  configureDisclosure(environment, reader);
  environment.fuseki.query = async query => ({ results: { bindings: [...heads]
    .filter(([resource]) => query.includes(`<${resource}>`))
    .map(([resource, head]) => ({ resource: { type: 'uri', value: resource }, head: { type: 'uri', value: head } })) } });
  for (const owner of ['graph', 'content', 'media', 'review'] as const) configureDisclosureAncestrySource(environment, owner, {
    read: async targets => targets.map(target => evidence.get(target.resource)!),
    reread: async bases => bases.map(basis => evidence.get(basis.targetResource)!),
  });
}, 120_000);

afterAll(async () => { await pool?.end(); cluster?.remove(); });

function governanceStore(database: Pool) {
  return new GovernanceStore(database, {
    capture: async (_principal, _actor, target) => ({ ...target, state: 'available',
      representation: 'Retained fixture evidence', revisionDigest: 'b'.repeat(64), provenance: {} }),
  }, {
    current: async target => heads.get(target.resource) ?? null,
    realmBasis: async target => realms.has(target.resource) ? { realm: target.resource,
      space: realms.get(target.resource)!, head: heads.get(target.resource)!, profile: SPACE_REALM_PROFILE,
      profileId: 'space-realm-v3', legacy: false } : null,
  }, { current: async () => rule }, {
    participants: async () => [],
    apply: async (operationId, ordinal) => ({ receipt: `urn:rezics:receipt:${operationId}:${ordinal}` }),
  });
}

function target(owner: DisclosureTarget['owner'] = 'graph', component: DisclosureTarget['component'] = 'title') {
  const resource = native(), revision = native();
  heads.set(resource, revision);
  return { owner, resource, revision, component, nameOwnerResolved: true } satisfies DisclosureTarget;
}

async function select(input: DisclosureTarget, parents: readonly { kind: 'work' | 'realm'; resource: string;
  head: string; protectedRevision?: string | null }[] = [], resourceKind: 'work' | 'realm' | 'other' = 'work') {
  const relationshipBasis = { owner: 'graph' as const, kind: parents.length ? 'work-in-realm' as const : 'identity' as const,
    resource: input.resource, revision: input.revision!, targetResource: input.resource, targetRevision: input.revision ?? null,
    token: createHash('sha256').update(JSON.stringify([input, parents])).digest('hex'), dataEpoch: 'epoch' };
  evidence.set(input.resource, { resource: input.resource, resourceKind, status: 'complete', relationshipBasis,
    parents: parents.map(parent => ({ ...parent, owner: 'graph', relationshipBasis })) as unknown as OwnerEstablishedGraphParents });
  return (await resolveDisclosureSelections(environment, [input]))[0]!;
}

async function restrict(input: DisclosureTarget, options: { component?: EvidenceTarget['component']; revision?: string | null;
  effect?: 'disclosure' | 'search'; context?: string; pending?: boolean; revisions?: readonly string[] } = {}) {
  const reported: EvidenceTarget = { owner: input.owner, resource: input.resource, component: options.component ?? input.component,
    revision: options.revision === undefined ? input.revision ?? null : options.revision, locator: null };
  const report = await governance.submitReport(principal, {
    kind: 'content_report', actingSubject: actor, authority: { kind: 'platform', scopeId: 'governance:platform' },
    context: options.context ?? GLOBAL_CONTEXT, target: reported, disclosure: 'private', reasonCode: 'disclosure',
    statement: 'Review retained evidence', evidence: (options.revisions ??
      [reported.revision ?? heads.get(input.resource) ?? null]).map(revision => ({ ...reported, revision })), idempotencyKey: randomUUID(),
  });
  await governance.safety.claim(principal, actor, report.caseId);
  const decision: DecisionInput = {
    caseId: report.caseId, expectedGeneration: report.caseGeneration, actingSubject: actor, outcome: 'restrict',
    targets: (options.revisions ?? [reported.revision]).map(revision => ({ ...reported, revision,
      scopeKind: revision === null ? 'component' : 'exact_revision',
      expectedHead: heads.get(input.resource) ?? null, effect: options.effect ?? 'disclosure' })),
    rule, evidenceDigest: report.evidenceDigest, reversesDecisionId: null, answersStepId: null,
    rationale: null, disclosure: 'private', idempotencyKey: randomUUID(), reasons: {
      facts: 'Reviewed retained evidence.', scope: 'Exact selected target.', duration: 'Until reconsidered.',
      automation: false, contentLanguage: 'en', appealRoute: '/v1/public-reports/{caseId}/correspondence',
    },
  };
  const accepted = await governance.decide(principal, decision, options.pending);
  if (!options.pending) expect(accepted.operation.status).toBe('completed');
  return { decision, accepted };
}

function measured(client: Pick<PoolClient, 'query'>) {
  const statements: string[] = [];
  const proxy = new Proxy(client, { get(source, property) {
    if (property === 'query') return (sql: string, args?: unknown[]) => {
      if (foregroundCounted()) statements.push(sql);
      return source.query(sql, args);
    };
    return Reflect.get(source, property, source);
  } });
  return { client: proxy, statements };
}

test('unrelated acknowledged Work changes the global cut but needs zero policy replays', async () => {
  const input = target(), unrelated = target();
  const selection = await select(input);
  const { client, statements } = measured(pool);
  const captured = await captureDisclosure(environment, [selection], ANONYMOUS_VIEWER, 'read', client as PoolClient);
  const globalBefore = (await pool.query('SELECT access.site_moderation_basis() AS basis')).rows[0]!.basis;
  await restrict(unrelated);
  const globalAfter = (await pool.query('SELECT access.site_moderation_basis() AS basis')).rows[0]!.basis;
  expect(globalAfter).not.toBe(globalBefore);
  expect(await fenceDisclosure(environment, captured, ANONYMOUS_VIEWER, 'read', client as PoolClient)).toEqual(['visible']);
  expect(statements).toHaveLength(3); // capture policy, isolation check, final policy; zero replays
  expect(statements.filter(sql => sql.includes('WITH fence AS MATERIALIZED'))).toHaveLength(2);
});

for (const changed of ['target', 'parent Work', 'parent Realm', 'whole-Realm closure'] as const) {
  test(`${changed} acknowledgement invalidates exactly its captured selections, with constant statement count`, async () => {
    const input = target('content', 'body'), work = target(), realm = target();
    realms.set(realm.resource, native());
    const selection = await select(input, [
      { kind: 'work', resource: work.resource, head: work.revision, protectedRevision: work.revision },
      { kind: 'realm', resource: realm.resource, head: realm.revision },
    ], 'other');
    const independent = await select(target());
    const { client, statements } = measured(pool);
    const captured = await scopedEnforcementBasis(client, [selection, independent, selection]);
    const cuts = await captureDisclosure(environment, [selection, independent, selection], ANONYMOUS_VIEWER, 'read', client as PoolClient);
    const affected = changed === 'target' ? input : changed === 'parent Work' ? work : realm;
    await restrict(affected, changed === 'whole-Realm closure' ? { component: 'record', revision: null } : {});
    const final = await scopedEnforcementBasis(client, [selection, independent, selection]);
    expect(final.results[0]).not.toBe(captured.results[0]);
    expect(final.results[1]).toBe(captured.results[1]);
    expect(final.results[2]).toBe(final.results[0]);
    expect(statements).toHaveLength(3);
    expect(final.cost).toEqual({ enforcementBasisStatements: 1 });
    expect((await scopedEnforcementBasis(pool, [selection])).results[0]).toBe(final.results[0]);
    await expect(fenceDisclosure(environment, cuts, ANONYMOUS_VIEWER, 'read', client as PoolClient))
      .rejects.toBeInstanceOf(DisclosureUnavailable);
    expect(await fenceDisclosure(environment, [cuts[1]!], ANONYMOUS_VIEWER, 'read', client as PoolClient)).toEqual(['visible']);
  });
}

test('pending acceptance does not change the enforcement basis; acknowledgement and restoration do', async () => {
  const input = target(), selection = await select(input);
  const captured = await scopedEnforcementBasis(pool, [selection]);
  const { decision, accepted } = await restrict(input, { pending: true });
  expect((await scopedEnforcementBasis(pool, [selection])).results).toEqual(captured.results);
  expect((await governance.resumeDecision(principal, actor, accepted.decisionId)).operation.status).toBe('completed');
  const restricted = await scopedEnforcementBasis(pool, [selection]);
  expect(restricted.results).not.toEqual(captured.results);
  const report = await governance.submitReport(principal, {
    kind: 'content_report', actingSubject: actor, authority: { kind: 'platform', scopeId: 'governance:platform' },
    context: GLOBAL_CONTEXT, target: decision.targets[0]!, disclosure: 'private',
    reasonCode: 'disclosure', statement: 'Reconsider retained evidence',
    evidence: [{ ...decision.targets[0]!, locator: null }], idempotencyKey: randomUUID(),
  });
  expect(report.caseId).toBe(decision.caseId);
  await governance.safety.claim(principal, actor, report.caseId);
  expect((await governance.decide(principal, { ...decision, outcome: 'restore',
    expectedGeneration: report.caseGeneration, evidenceDigest: report.evidenceDigest,
    idempotencyKey: randomUUID() })).operation.status).toBe('completed');
  const restored = await scopedEnforcementBasis(pool, [selection]);
  expect(restored.results).not.toEqual(restricted.results);
  expect(restored.results).not.toEqual(captured.results);
});

test('a late lower-xid acknowledgement on another matching row advances the basis even at the same epoch', async () => {
  const input = target(), selection = await select(input);
  const lower = await restrict(input, { pending: true });
  const later = await restrict(input, { component: 'record', revision: null, pending: true });
  const client = await pool.connect();
  // Governance owns all enforcement writes. Savepoints lend one controlled
  // outer commit without replacing acknowledgement or editing Access rows.
  const held = new Proxy(client, { get(source, property) {
    if (property === 'release') return () => {};
    if (property === 'query') return (sql: string, args?: unknown[]) => {
      if (sql.startsWith('BEGIN')) return source.query('SAVEPOINT acknowledgement');
      if (sql === 'COMMIT') return source.query('RELEASE SAVEPOINT acknowledgement');
      if (sql === 'ROLLBACK') return source.query('ROLLBACK TO SAVEPOINT acknowledgement');
      return source.query(sql, args);
    };
    const value: unknown = Reflect.get(source, property, source);
    return typeof value === 'function' ? value.bind(source) : value;
  } });
  const heldPool = new Proxy(pool, { get(source, property) {
    if (property === 'connect') return async () => held;
    const value: unknown = Reflect.get(source, property, source);
    return typeof value === 'function' ? value.bind(source) : value;
  } });
  try {
    await client.query('BEGIN');
    await client.query('SELECT txid_current()');
    expect((await governance.resumeDecision(principal, actor, later.accepted.decisionId)).operation.status).toBe('completed');
    const captured = await scopedEnforcementBasis(pool, [selection]);
    expect((await governanceStore(heldPool).resumeDecision(principal, actor, lower.accepted.decisionId)).operation.status)
      .toBe('completed');
    expect((await scopedEnforcementBasis(pool, [selection])).results).toEqual(captured.results);
    await client.query('COMMIT');
    expect((await scopedEnforcementBasis(pool, [selection])).results).not.toEqual(captured.results);
    expect((await pool.query(`SELECT fence_epoch::text FROM access.governance_enforcement
      WHERE resource = $1 ORDER BY component`, [input.resource])).rows).toEqual([{ fence_epoch: '1' }, { fence_epoch: '1' }]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('scope excludes other revisions, contexts, components and channel effects on the same Work', async () => {
  const input = target(), selection = await select(input);
  const captured = await scopedEnforcementBasis(pool, [selection]);
  await restrict(input, { revision: native() });
  await restrict(input, { context: native() });
  await restrict(input, { component: 'body' });
  await restrict(input, { effect: 'search' });
  expect((await scopedEnforcementBasis(pool, [selection])).results).toEqual(captured.results);
  expect((await scopedEnforcementBasis(pool, [selection], 'search')).results).not.toEqual(captured.results);
});

test('body aliases and exact protected parent revisions belong to the scoped basis', async () => {
  const input = target('content', 'body'), work = target(), realm = target();
  const protectedRevision = native();
  const selection = await select(input, [
    { kind: 'work', resource: work.resource, head: work.revision, protectedRevision },
    { kind: 'realm', resource: realm.resource, head: realm.revision },
  ], 'other');
  const captured = await scopedEnforcementBasis(pool, [selection]);
  await restrict(work, { revision: protectedRevision });
  const parent = await scopedEnforcementBasis(pool, [selection]);
  expect(parent.results).not.toEqual(captured.results);
  await restrict({ ...input, owner: 'graph' });
  expect((await scopedEnforcementBasis(pool, [selection])).results).not.toEqual(parent.results);
});

for (const size of [65, 501, 512, 1_024, 1_536, 2_048]) {
  test(`${size} real owner decisions and scoped bases preserve duplicates, chunk counts and all measured statements`, async () => {
    const visible = target(), denied = target();
    await restrict(denied);
    const selections = [await select(visible), await select(denied)];
    const inputs = Array.from({ length: size }, (_, index) => selections[index % 2]!);
    const { client, statements } = measured(pool);
    const scoped = await scopedEnforcementBasis(client, inputs);
    const chunks = Math.ceil(size / 64);
    expect(scoped.submissions).toBe(chunks);
    expect(scoped.cost.enforcementBasisStatements).toBe(statements.length);
    expect(statements).toHaveLength(chunks);
    expect(scoped.results).toEqual(inputs.map((_item, index) => scoped.results[index % 2]!));
    statements.length = 0;
    const targets = inputs.map(selection => ({ ...selection.target, ancestry: selection.ancestry }));
    const read = await reader.readAtCut(targets, ANONYMOUS_VIEWER, 'read', client as PoolClient);
    expect(read.decisions).toEqual(inputs.map((_item, index) => index % 2 ? 'tombstone' : 'visible'));
    expect(read.fenceBases.map(basis => basis.enforcementCut)).toEqual([...scoped.results]);
    expect(read.cost.statements).toBe(statements.length);
    expect(read.cost.ownerStatements).toBe(chunks);
    expect(read.cost.recoveryStatements).toBe(chunks);
    expect(statements).toHaveLength(chunks);
    for (const entry of [reader.read.bind(reader), reader.readWithAnonymousNames.bind(reader)]) {
      statements.length = 0;
      const result = await entry(targets, ANONYMOUS_VIEWER, 'read', client as PoolClient);
      expect(Array.isArray(result) ? result : result.decisions).toEqual(read.decisions);
      expect(statements).toHaveLength(chunks);
    }
    statements.length = 0;
    const inventory = await discloseInventoryWithCost(environment, targets, ANONYMOUS_VIEWER, 'read', client as PoolClient);
    expect(inventory.decisions).toEqual(read.decisions);
    expect(inventory.cost.statements).toBe(statements.length);
    expect(inventory.cost.ownerStatements).toBe(chunks);
    expect(statements).toHaveLength(chunks);
    statements.length = 0;
    const cuts = await captureDisclosure(environment, inputs, ANONYMOUS_VIEWER, 'read', client as PoolClient);
    expect(cuts.map(cut => cut.decision)).toEqual(read.decisions);
    expect(cuts.cost!.statements).toBe(statements.length);
    expect(cuts.cost!.ownerStatements).toBe(chunks);
    expect(statements).toHaveLength(chunks);
    statements.length = 0;
    const fenced = await fenceDisclosure(environment, cuts, ANONYMOUS_VIEWER, 'read', client as PoolClient);
    expect(fenced).toEqual(read.decisions);
    expect(fenced.cost!.statements).toBe(statements.length);
    expect(fenced.cost!.ownerStatements).toBe(chunks);
    expect(statements).toHaveLength(chunks * 2); // one isolation and one policy statement per chunk
    const regrouped = [cuts[64]!, cuts[1]!, cuts[0]!, cuts.at(-1)!];
    expect(await fenceDisclosure(environment, regrouped, ANONYMOUS_VIEWER, 'read', client as PoolClient))
      .toEqual(regrouped.map(cut => cut.decision));
  }, 30_000);
}

test('over-cap and empty scoped submissions perform no owner statements', async () => {
  const selection = await select(target()), { client, statements } = measured(pool);
  await expect(scopedEnforcementBasis(client, Array(DISCLOSURE_SUBMISSION_LIMIT + 1).fill(selection))).rejects.toBeInstanceOf(DisclosureUnavailable);
  expect(await scopedEnforcementBasis(client, [])).toEqual({ results: [], cost: {}, submissions: 0 });
  expect(statements).toHaveLength(0);
});

test('direct owner costs count optional name probes and every actual SQL statement across chunks', async () => {
  const { nameOwnerResolved: _resolved, ...input } = target();
  const selection = await select(input);
  const { client, statements } = measured(pool);
  // A pool-only owner resolves names in Access; its checkout is still lent.
  const poolOnlyReader = new DisclosureStore(client as unknown as Pool);
  const issued = { ...selection.target, ancestry: selection.ancestry };
  const result = await poolOnlyReader.readAtCut(Array(65).fill(issued), ANONYMOUS_VIEWER, 'read');
  expect(result.decisions).toEqual(Array(65).fill('visible'));
  expect(result.cost).toEqual({ ownerStatements: 2, recoveryStatements: 2, statements: 4,
    nameOwnerQueries: 0, nameOwnerStatements: 2 });
  expect(result.cost.statements).toBe(statements.length);
  expect(statements).toHaveLength(4);
});

test('the embeddable expression shares the policy statement snapshot and recovery remains a separate global fence', async () => {
  const input = target(), selection = await select(input);
  const basis = await scopedEnforcementBasis(pool, [selection]);
  const cuts = await captureDisclosure(environment, [selection], ANONYMOUS_VIEWER, 'read');
  const rows = (await pool.query(`WITH requested AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS wanted(ordinal int, owner text, resource text,
      component text, revision text, context text, "resourceKind" text, parents jsonb))
    SELECT ${SCOPED_ENFORCEMENT_BASIS_SQL} AS basis, fence.generation::text AS generation
    FROM requested wanted CROSS JOIN access.recovery_fence fence WHERE fence.id`,
  [JSON.stringify([{ ...input, ordinal: 0, context: GLOBAL_CONTEXT, resourceKind: 'work', parents: [] }]),
    ['disclosure'], GLOBAL_CONTEXT])).rows;
  expect(rows[0]!.basis).toBe(basis.results[0]);
  const held = await engageAccessRecoveryFence(pool);
  await releaseAccessRecoveryFence(pool, held);
  expect((await pool.query('SELECT generation::text FROM access.recovery_fence WHERE id')).rows[0]!.generation)
    .not.toBe(rows[0]!.generation);
  expect((await scopedEnforcementBasis(pool, [selection])).results).toEqual(basis.results);
  await expect(fenceDisclosure(environment, cuts, ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(DisclosureUnavailable);
});

test('public final fences refuse snapshot-isolated lent transactions before policy work', async () => {
  const selection = await select(target());
  const cuts = await captureDisclosure(environment, [selection], ANONYMOUS_VIEWER, 'read');
  const held = await pool.connect();
  try {
    await held.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const { client, statements } = measured(held);
    await expect(fenceDisclosure(environment, cuts, ANONYMOUS_VIEWER, 'read', client as PoolClient))
      .rejects.toBeInstanceOf(DisclosureUnavailable);
    expect(statements).toEqual(['SHOW transaction_isolation']);
  } finally {
    await held.query('ROLLBACK');
    held.release();
  }
});

test('missing, reordered, malformed or unavailable owner results fail closed', async () => {
  const selections = [await select(target()), await select(target())];
  for (const rows of [[], [{ ordinal: 0, basis: 'bad' }, { ordinal: 1, basis: 'a'.repeat(64) }],
    [{ ordinal: 1, basis: 'a'.repeat(64) }, { ordinal: 0, basis: 'a'.repeat(64) }]]) {
    const client = { query: async () => ({ rows }) } as unknown as Pick<PoolClient, 'query'>;
    await expect(scopedEnforcementBasis(client, selections)).rejects.toBeInstanceOf(DisclosureUnavailable);
  }
  const unavailable = { query: async () => { throw new Error('Access unavailable'); } } as unknown as PoolClient;
  await expect(scopedEnforcementBasis(unavailable, selections)).rejects.toBeInstanceOf(DisclosureUnavailable);
  await expect(scopedEnforcementBasis(pool, selections, 'invalid' as DisclosureChannel)).rejects.toBeInstanceOf(DisclosureUnavailable);
});


test('assembly submits the whole over-cap content inventory before any policy or hydration work', async () => {
  const input = target('content', 'body');
  await select(input, [], 'other');
  const { client, statements } = measured(pool);
  configureDisclosure(environment, new DisclosureStore(client as unknown as Pool));
  try {
    await expect(discloseContent(environment, Array(DISCLOSURE_SUBMISSION_LIMIT + 1).fill({
      status: 'available', reference: { resourceId: input.resource }, revisionId: input.revision,
    }))).rejects.toThrow('Disclosure submission exceeds');
    expect(statements).toHaveLength(0);
  } finally { configureDisclosure(environment, reader); }
});


test('a public 512-match body search admits all 1,536 expanded descriptors in 24 owner chunks', async () => {
  const work = target(), contribution = target('graph', 'body');
  const matches = Array.from({ length: 512 }, () => ({ work: work.resource,
    contribution: contribution.resource, revision: work.revision, matchedField: 'body' }));
  const originalQuery = environment.fuseki.query;
  environment.fuseki.query = async (query, ...args) => query.includes('AS ?nameOwner')
    ? { results: { bindings: [work, contribution].filter(input => query.includes(`<${input.resource}>`))
      .map(input => ({ work: { type: 'uri', value: input.resource } })) } }
    : query.includes('SELECT ?work ?head WHERE')
    ? { results: { bindings: [{ work: { type: 'uri', value: work.resource },
      head: { type: 'uri', value: work.revision } }] } }
    : originalQuery.call(environment.fuseki, query, ...args);
  for (const owner of ['graph', 'content'] as const) configureDisclosureAncestrySource(environment, owner, {
    read: async inputs => inputs.map(input => {
      const relationshipBasis = { owner: input.owner as 'graph' | 'content', kind: 'publication' as const,
        resource: input.resource, revision: input.revision!, targetResource: input.resource,
        targetRevision: input.revision ?? null, token: 'a'.repeat(64), dataEpoch: 'epoch' };
      return { resource: input.resource, resourceKind: 'other' as const, status: 'complete' as const,
        relationshipBasis, parents: [{ owner: 'graph' as const, kind: 'work' as const,
          resource: work.resource, head: work.revision, protectedRevision: work.revision, relationshipBasis }] };
    }),
    reread: async () => [],
  });
  const { client, statements } = measured(pool);
  configureDisclosure(environment, new DisclosureStore(client as unknown as Pool));
  try {
    expect(await discloseSearchMatches(environment, matches)).toEqual(matches);
    expect(statements).toHaveLength(24);
  } finally {
    environment.fuseki.query = originalQuery;
    configureDisclosure(environment, reader);
    for (const owner of ['graph', 'content'] as const) configureDisclosureAncestrySource(environment, owner, {
      read: async targets => targets.map(target => evidence.get(target.resource)!),
      reread: async bases => bases.map(basis => evidence.get(basis.targetResource)!),
    });
  }
});


test('resolve reports all source SQL, and inventory includes real media visibility SQL', async () => {
  const input = target('media', 'body');
  const { client, statements } = measured(pool);
  const mediaEnv = { ...environment };
  configureDisclosure(mediaEnv, new DisclosureStore(client as unknown as Pool));
  configureDisclosureAncestrySource(mediaEnv, 'media', {
    read: async inputs => {
      await client.query('SELECT 1');
      return inputs.map(input => ({ resource: input.resource, resourceKind: 'other', status: 'complete',
        relationshipBasis: { owner: 'media', kind: 'media-use', resource: input.resource,
          revision: input.revision!, targetResource: input.resource, targetRevision: input.revision!,
          token: 'a'.repeat(64), dataEpoch: 'epoch' }, parents: [] }));
    },
    reread: async () => [],
  });
  const selections = await resolveDisclosureSelections(mediaEnv, Array(65).fill(input));
  expect(selections.cost!.statements).toBe(statements.length);
  expect(statements).toHaveLength(2);
  // A raw MediaStore executes its real visibilityFacts SQL. Empty owner rows
  // avoid attachment projections while still exercising the media owner read.
  const mediaPool = new Pool({ ...cluster!.connection, max: 2 });
  const mediaMeasured = measured(mediaPool);
  // Register this pool at the same SQL boundary as an ordinary owner store.
  new DisclosureStore(mediaMeasured.client as unknown as Pool);
  configureMediaVisibility({ environment: mediaEnv, media: {
    store: new MediaStore(mediaMeasured.client as unknown as Pool, {} as never),
  }, access: {} } as unknown as MainWorkDependencies);
  statements.length = 0;
  try {
    const result = await discloseInventoryWithCost(mediaEnv, [input], ANONYMOUS_VIEWER, 'media', client as PoolClient);
    expect(result.cost.statements).toBe(statements.length + mediaMeasured.statements.length);
    expect(mediaMeasured.statements).toHaveLength(1);
    expect(result.cost.mediaStatements).toBe(1);
    expect(result.decisions).toEqual(['hidden']);
  } finally { await mediaPool.end(); }
});


for (const change of ['restoration', 'recovery generation'] as const) {
  test(`hidden search captures still refuse a changed ${change}`, async () => {
    const input = target(), selection = await select(input);
    const { decision } = await restrict(input, { effect: 'search' });
    const cuts = await captureDisclosure(environment, [selection], ANONYMOUS_VIEWER, 'search');
    expect(cuts[0]!.decision).toBe('hidden');
    if (change === 'recovery generation') {
      const held = await engageAccessRecoveryFence(pool);
      await releaseAccessRecoveryFence(pool, held);
    } else {
      const report = await governance.submitReport(principal, {
        kind: 'content_report', actingSubject: actor, authority: { kind: 'platform', scopeId: 'governance:platform' },
        context: GLOBAL_CONTEXT, target: decision.targets[0]!, disclosure: 'private',
        reasonCode: 'disclosure', statement: 'Reconsider retained evidence',
        evidence: [{ ...decision.targets[0]!, locator: null }], idempotencyKey: randomUUID(),
      });
      await governance.safety.claim(principal, actor, report.caseId);
      await governance.decide(principal, { ...decision, outcome: 'restore', expectedGeneration: report.caseGeneration,
        evidenceDigest: report.evidenceDigest, idempotencyKey: randomUUID() });
    }
    await expect(fenceDisclosure(environment, cuts, ANONYMOUS_VIEWER, 'search'))
      .rejects.toThrow('Disclosure enforcement cut moved');
  });
}


type EnforcementPlan = { 'Relation Name'?: string; 'Node Type': string; 'Actual Rows': number;
  'Actual Loops': number; 'Rows Removed by Filter'?: number; 'Rows Removed by Index Recheck'?: number;
  Plans?: EnforcementPlan[] };
function enforcementRowsExamined(plan: EnforcementPlan): number {
  const own = plan['Relation Name'] === 'governance_enforcement' && plan['Node Type'] !== 'Bitmap Index Scan'
    ? (plan['Actual Rows'] + (plan['Rows Removed by Filter'] ?? 0) + (plan['Rows Removed by Index Recheck'] ?? 0))
      * plan['Actual Loops'] : 0;
  return own + (plan.Plans ?? []).reduce((sum, child) => sum + enforcementRowsExamined(child), 0);
}

test('exact title basis examines constant enforcement rows with 1,000 excluded historical revision/context rows', async () => {
  const input = target(), selection = await select(input);
  await restrict(input);
  const explain = async () => {
    await pool.query('ANALYZE access.governance_enforcement');
    const held = await pool.connect();
    try {
      await held.query('BEGIN');
      // Compare the indexed probe at both populations, rather than a small-
      // table sequential scan chosen only because it happens to be cheaper.
      await held.query('SET LOCAL enable_seqscan = off');
      let examined = -1;
      const explaining = { query: async (sql: string, args?: unknown[]) => {
        const rows = (await held.query<{ 'QUERY PLAN': { Plan: EnforcementPlan }[] }>(
          `EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) ${sql}`, args)).rows;
        examined = enforcementRowsExamined(rows[0]!['QUERY PLAN'][0]!.Plan);
        return held.query(sql, args);
      } } as unknown as Pick<PoolClient, 'query'>;
      const basis = await scopedEnforcementBasis(explaining, [selection]);
      return { basis: basis.results[0], examined };
    } finally { await held.query('ROLLBACK'); held.release(); }
  };
  const before = await explain();
  for (const context of [GLOBAL_CONTEXT, native()]) {
    const revisions = Array.from({ length: 500 }, native);
    for (let offset = 0; offset < revisions.length; offset += 16)
      await restrict(input, { revision: revisions[offset], context, revisions: revisions.slice(offset, offset + 16) });
  }
  const after = await explain();
  expect(after.basis).toBe(before.basis);
  expect(after.examined).toBe(before.examined);
  expect(after.examined).toBeLessThanOrEqual(2);
}, 120_000);
