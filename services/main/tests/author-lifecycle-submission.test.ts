import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { boundedPool, NestedPoolCheckoutError, nestedPoolCheckoutMode, setNestedPoolCheckoutMode } from '../src/infrastructure/pg-pool.ts';
import { AccessAdmissionRegistry, AdmissionDenied, type RegisteredAdmission,
  type VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { RealmSubmissionStore } from '../src/modules/realm-submission/store.ts';
import { SubmissionUnavailable, type ResourceSubmissionInput } from '../src/modules/realm-submission/schema.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => `https://rezics.com/id/${randomUUID()}`;
const previousMode = nestedPoolCheckoutMode();
let cluster: PostgresCluster | undefined;
let pool: Pool;

beforeAll(async () => {
  setNestedPoolCheckoutMode('throw');
  cluster = await startPostgresCluster();
  pool = boundedPool({ ...cluster.connection, max: 1, connectionTimeoutMillis: 1_000 });
  for (const file of schemaFiles(root, 'access')) {
    await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
  }
}, 120_000);

afterAll(async () => {
  await pool?.end();
  cluster?.remove();
  setNestedPoolCheckoutMode(previousMode);
}, 60_000);

async function pending(kind: 'contribution' | 'work') {
  const principalId = randomUUID(), actor = native(), realm = native(), work = native(), mainVersion = native();
  const principal: VerifiedPrincipal = { issuer: 'https://account.author-lifecycle.test', subject: randomUUID() };
  await pool.query('INSERT INTO access.principal(id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [principalId, principal.issuer, principal.subject]);
  await pool.query("INSERT INTO access.authority_subject(id,kind) VALUES ($1,'agent'),($2,'institution')", [actor, realm]);
  for (const [action, scope] of [['review.decide', `review:decide:${realm}`],
    ['publication.adopt', `publication:adopt:${realm}`]] as const) {
    await grantFixtureAuthority(pool, { scope, requireDispatch: true,
      representations: [{ principalId, actor, action, lifetime: 'infinity' }],
      grant: { actor, action, lifetime: 'infinity' } });
  }
  const id = randomUUID(), revision = randomUUID();
  const target: ResourceSubmissionInput | null = kind === 'work'
    ? { kind, actingSubject: actor, work, mainVersion, workRevision: native() } : null;
  await pool.query(`INSERT INTO access.realm_submission
    (id,realm,kind,work,main_version,contribution,publication_decision,selected_draft,
     submitting_agent,state,revision,target)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11)`,
  [id, realm, kind, work, mainVersion, target ? null : native(), target ? null : native(),
    target ? null : native(), actor, revision, target]);
  const boundary = new Error('Native adoption boundary reached');
  const boundaryIdle: number[] = [];
  // Only the graph admission fence is answered. No adoption or terminal receipt
  // is invented: the test inspects the real committed SQL reservation instead.
  const env = { lineage: { dataEpoch: 'author-submission', routingEpoch: 'author-submission' },
    fuseki: { query: async (query: string) => {
      if (query.includes('ASK { GRAPH') && query.includes('rv:restoreHold')) return { boolean: true };
      boundaryIdle.push(pool.idleCount);
      throw boundary;
    } } } as WorkActivationEnvironment;
  const access = new AccessAdmissionRegistry(pool);
  const input = { actingSubject: actor, expectedRevision: revision, outcome: 'accept' as const,
    expectedSelectionHead: null, publicReason: null, internalNote: null };
  return { principal, actor, realm, id, revision, target, boundary, boundaryIdle, env, access, input, key: randomUUID() };
}

function observe(access: AccessAdmissionRegistry, afterAdoptionClaim?: (admission: RegisteredAdmission) => Promise<void>) {
  const fences: { action: string; transaction: string }[] = [], refusals: unknown[] = [];
  const owner: ConstructorParameters<typeof RealmSubmissionStore>[1] = {
    register: access.register.bind(access), recordGraphOutcome: access.recordGraphOutcome.bind(access),
    claim: async (...args) => {
      const claimed = await access.claim(...args);
      if (claimed.action === 'publication.adopt') await afterAdoptionClaim?.(claimed);
      return claimed;
    },
    fenceClaim: async (client, ...args) => {
      const transaction = (await client.query('SELECT txid_current()::text AS id')).rows[0]!.id as string;
      try {
        const claimed = await access.fenceClaim(client, ...args);
        fences.push({ action: claimed.action, transaction });
        return claimed;
      } catch (error) { refusals.push(error); throw error; }
    },
  };
  return { owner, fences, refusals };
}

async function unreserved(id: string) {
  expect((await pool.query('SELECT state FROM access.realm_submission WHERE id=$1', [id])).rows[0]!.state).toBe('pending');
  expect((await pool.query('SELECT 1 FROM access.realm_submission_operation WHERE submission_id=$1', [id])).rowCount).toBe(0);
}

test.each(['contribution', 'work'] as const)('%s review commits independently admitted adoption with one bounded connection', async kind => {
  const f = await pending(kind);
  const nested: NestedPoolCheckoutError[] = [];
  const observed = { query: pool.query.bind(pool), connect: async () => {
    try { return await pool.connect(); }
    catch (error) { if (error instanceof NestedPoolCheckoutError) nested.push(error); throw error; }
  } } as Pool;
  const measured = observe(new AccessAdmissionRegistry(observed));
  const store = new RealmSubmissionStore(observed, measured.owner, f.env);
  let failure: unknown;
  try { await store.decide(f.principal, f.realm, f.id, f.input, f.key); } catch (error) { failure = error; }
  expect(nested).toEqual([]);
  expect(failure).toBe(f.boundary);
  expect(measured.fences.map(fence => fence.action)).toEqual(['review.decide', 'publication.adopt']);
  expect(new Set(measured.fences.map(fence => fence.transaction)).size).toBe(1);
  expect(f.boundaryIdle).toEqual([1]);
  const row = (await pool.query(`SELECT state,decision_operation FROM access.realm_submission WHERE id=$1`, [f.id])).rows[0]!;
  expect(row.state).toBe('deciding');
  const operation = (await pool.query(`SELECT adoption,result FROM access.realm_submission_operation
    WHERE admission_id=$1`, [row.decision_operation])).rows[0]!;
  expect(operation.result).toBeNull();
  expect(kind === 'work' ? operation.adoption.input.expectedHead : operation.adoption.input.expectedSelectionHead).toBeNull();
  const admission = (await pool.query(`SELECT state,action,scope_id FROM access.admission WHERE id=$1`,
    [operation.adoption.admission.id])).rows[0]!;
  expect(admission).toEqual({ state: 'claimed', action: 'publication.adopt', scope_id: `publication:adopt:${f.realm}` });
  // Retry resumes the same immutable reservation despite the row's new revision.
  await expect(store.decide(f.principal, f.realm, f.id, f.input, f.key)).rejects.toBe(f.boundary);
  expect(measured.fences).toHaveLength(2);
  expect((await pool.query('SELECT count(*)::int AS count FROM access.realm_submission_operation WHERE submission_id=$1',
    [f.id])).rows[0]!.count).toBe(1);
}, 30_000);

test.each(['contribution', 'work'] as const)('%s review checks the exact revision again after independent admission', async kind => {
  const f = await pending(kind), changed = randomUUID();
  const measured = observe(f.access, async () => {
    await pool.query(`UPDATE access.realm_submission SET revision=$2,generation=generation+1 WHERE id=$1`, [f.id, changed]);
  });
  const store = new RealmSubmissionStore(pool, measured.owner, f.env);
  // Cancellation acknowledgement also stops at the graph boundary. It cannot
  // turn the failed SQL CAS into a saved deciding reservation.
  await expect(store.decide(f.principal, f.realm, f.id, f.input, f.key)).rejects.toBe(f.boundary);
  await unreserved(f.id);
  expect((await pool.query('SELECT revision FROM access.realm_submission WHERE id=$1', [f.id])).rows[0]!.revision).toBe(changed);
  expect(measured.fences.map(fence => fence.action)).toEqual(['review.decide', 'publication.adopt']);
}, 30_000);

test.each([
  ['contribution', 'review.decide'], ['work', 'review.decide'],
  ['contribution', 'publication.adopt'], ['work', 'publication.adopt'],
] as const)('%s review refuses %s authority revoked after admission', async (kind, action) => {
  const f = await pending(kind);
  const scope = `${action === 'review.decide' ? 'review:decide' : 'publication:adopt'}:${f.realm}`;
  const measured = observe(f.access, async () => {
    const gate = (await pool.query('SELECT authority_epoch FROM access.scope_gate WHERE id=$1', [scope])).rows[0]!;
    await f.access.closeScope(scope, gate.authority_epoch);
  });
  const store = new RealmSubmissionStore(pool, measured.owner, f.env);
  await expect(store.decide(f.principal, f.realm, f.id, f.input, f.key)).rejects.toBe(f.boundary);
  await unreserved(f.id);
  expect(measured.refusals).toHaveLength(1);
  expect(measured.refusals[0]).toBeInstanceOf(AdmissionDenied);
  expect(measured.fences.map(fence => fence.action)).toEqual(action === 'review.decide' ? [] : ['review.decide']);
}, 30_000);

test('review reservation retains the recovery fence after independent admission', async () => {
  const f = await pending('work');
  const measured = observe(f.access, async () => {
    await pool.query('UPDATE access.recovery_fence SET open=false WHERE id');
  });
  const store = new RealmSubmissionStore(pool, measured.owner, f.env);
  try {
    await expect(store.decide(f.principal, f.realm, f.id, f.input, f.key)).rejects.toBeInstanceOf(SubmissionUnavailable);
    await unreserved(f.id);
    expect(f.boundaryIdle).toEqual([]);
  } finally { await pool.query('UPDATE access.recovery_fence SET open=true WHERE id'); }
}, 30_000);
