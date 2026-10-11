import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { migrateContent } from '../../content/src/migrate.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { FusekiClient, type CommandEnvelope, type CommandResult, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { completeErasureTarget, ErasureUnavailable, journalErasure, readErasure,
  sha256 } from '../src/modules/erasure/journal.ts';
import { verifyErasure } from '../src/modules/erasure/reconcile.ts';
import { contentErasureDigest, ErasureService, requestContentErasure,
  type ContentErasureInput } from '../src/modules/erasure/request.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');
const graphProfile = 'erasure-graph-v1';
const sequence = '7';

interface GraphProof { receipt: string; dataEpoch: string; sequence: string }
interface TargetRow { ordinal: number; owner: string; target_kind: string; target_ref: string }
type Binding = NonNullable<SparqlResult['results']>['bindings'][number];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value)!;
}

function historicalCompletionEvidence(erasureId: string, erasureEpoch: string, target: TargetRow,
  graphProof: GraphProof): string {
  return sha256(canonical({ erasureId, erasureEpoch,
    target: { ordinal: target.ordinal, owner: target.owner, kind: target.target_kind, ref: target.target_ref },
    graphProof, ...(target.target_kind === 'content_revision' ? { contentState: 'erased' } : {}) }));
}

function completionEvidence(erasureId: string, erasureEpoch: string, target: TargetRow): string {
  return sha256(canonical({ erasureId, erasureEpoch, ordinal: target.ordinal,
    owner: target.owner, kind: target.target_kind, ref: target.target_ref, liveState: 'erased' }));
}

class RequestGraph extends FusekiClient {
  proof: GraphProof | undefined;
  proofRows: Binding[] = [];
  commandCalls = 0;

  constructor(private readonly relay: Pool, readonly lineage: { dataEpoch: string; routingEpoch: string }) {
    super('http://erasure-target-completion.invalid');
  }

  override async commandHealth() {
    return { moduleVersion: 'fixture', instanceId: randomUUID(), publicSearchWriteEpoch: '0',
      publicSearchWriteActive: false, profiles: { [graphProfile]: profileRegistry[graphProfile]!.sha256 } };
  }

  override async query(sparql: string): Promise<SparqlResult> {
    if (sparql.includes('SELECT DISTINCT ?target ?sequence ?receiptEpoch ?currentSequence')) {
      return { results: { bindings: structuredClone(this.proofRows) } };
    }
    if (sparql.includes('SELECT DISTINCT ?graph ?unit ?target')) {
      return { results: { bindings: [] } };
    }
    if (sparql.includes('SELECT DISTINCT ?target WHERE')) {
      const bindings = this.proof ? this.proofRows.map(({ target }) => ({ target })) : [];
      return { results: { bindings } };
    }
    throw new Error(`Unexpected request graph query: ${sparql.slice(0, 100)}`);
  }

  override async commandWithReceipt(_envelope: CommandEnvelope): Promise<CommandResult> {
    this.commandCalls++;
    const erasure = (await this.relay.query<{ id: string; erasure_epoch: string }>(
      `SELECT id, erasure_epoch::text AS erasure_epoch FROM relay.erasure
       WHERE stage = 'requested' ORDER BY erasure_epoch DESC LIMIT 1`)).rows[0];
    if (!erasure) throw new Error('request graph command has no journal entry');
    const targets = (await this.relay.query<TargetRow>(`SELECT ordinal, owner, target_kind, target_ref
      FROM relay.erasure_target WHERE erasure_id = $1 ORDER BY ordinal`, [erasure.id])).rows;
    this.proof = { receipt: `urn:rezics:receipt:erasure-graph:${sha256(erasure.id)}`,
      dataEpoch: this.lineage.dataEpoch, sequence };
    this.proofRows = targets.map(target => ({
      target: { type: 'uri', value: `urn:rezics:content:revision:${target.target_ref}` },
      sequence: { type: 'literal', value: sequence },
      receiptEpoch: { type: 'literal', value: this.lineage.dataEpoch },
      currentSequence: { type: 'literal', value: '20' },
    }));
    return { status: 'committed' } as CommandResult;
  }
}

function contentOwner(pool: Pool, reportNonErasedProof = false): Pool {
  let reportOnce = reportNonErasedProof;
  return new Proxy(pool, { get(target, property) {
    if (property === 'query') return async (sql: string, values?: unknown[]) => {
      const result = await target.query(sql, values);
      if (reportOnce && sql.includes('SELECT wanted.id::text AS id, r.availability')) {
        reportOnce = false;
        return { ...result, rows: result.rows.map(row => ({ ...row, availability: 'available',
          erasure_id: null, erasure_epoch: null })) };
      }
      return result;
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as Pool;
}

let cluster: PostgresCluster | undefined;
let admin: Pool | undefined;
let pool: Pool | undefined;

beforeAll(async () => {
  cluster = await startPostgresCluster();
  admin = new Pool({ ...cluster.connection, max: 2 });
  const database = `erasure_completion_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${database}`);
  pool = new Pool({ ...cluster.connection, database, max: 12 });
  await migrateContent(pool);
  const relayDirectory = join(root, 'services/main/migrations/relay');
  for (const file of schemaFiles(root, 'relay')) {
    await pool.query(readFileSync(join(relayDirectory, file), 'utf8'));
  }
  await pool.query(`CREATE SCHEMA access;
    CREATE TABLE access.governance_preservation_hold (
      id uuid PRIMARY KEY, target_resource text NOT NULL, reason text NOT NULL, released_at timestamptz);
    CREATE TABLE access.governance_erasure_postponement (
      hold_id uuid NOT NULL, operation_id text NOT NULL, material_ref text NOT NULL,
      reason text NOT NULL, PRIMARY KEY (hold_id, operation_id, material_ref))`);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  cluster?.remove();
});

async function contentRevisions(resourceId: string, count: number): Promise<string[]> {
  const variant = `urn:rezics:variant:${randomUUID()}`;
  await pool!.query(`INSERT INTO content.variant (id, resource_id, language_kind, direction)
    VALUES ($1, $2, 'zxx', 'none')`, [variant, resourceId]);
  const ids = Array.from({ length: count }, () => randomUUID());
  const digest = createHash('sha256').update('{}').digest('hex');
  for (const id of ids) {
    await pool!.query(`INSERT INTO content.revision (id, variant_id, operation_id, format, model, provenance,
      byte_digest, byte_length, serialized_bytes, body)
      VALUES ($1, $2, $3, 'rezics-content-json-v1', 'fixture', '{}'::jsonb, $4, 2, $5, '{}'::jsonb)`,
    [id, variant, `erasure-target-completion-${id}`, digest, Buffer.from('{}')]);
  }
  return ids;
}

function admissionAccess(id: string, principalId: string) {
  return { register: async (request: { actingSubject: string; scope: string; action: string;
      idempotencyKey: string; requestDigest: string }) => ({ id, principalId,
      actingSubject: request.actingSubject, scope: request.scope, action: request.action,
      idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest,
      authorityEpoch: '1', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      state: 'registered' as const, dispatchEligible: true, replayed: false }),
    claim: async () => undefined,
    recordGraphOutcome: async () => undefined,
  } as never;
}

function inputFor(resourceId: string, revisionIds: string[]): ContentErasureInput {
  return { actingSubject: `https://rezics.com/id/${randomUUID()}`, resourceId, revisionIds,
    idempotencyKey: randomUUID() };
}

function serviceFor(graph: RequestGraph, content = contentOwner(pool!)): {
  service: ErasureService; environment: WorkActivationEnvironment;
} {
  const environment = { fuseki: graph, lineage: graph.lineage, objectDirectory: join(root, '.temp') } as unknown as WorkActivationEnvironment;
  return { service: new ErasureService(pool!, content, pool!), environment };
}

test('request records exact target completion, fails closed on missing Content proof, and resumes partial completion', async () => {
  const lineage = { dataEpoch: randomUUID(), routingEpoch: randomUUID() };

  const normalResource = `https://rezics.com/id/${randomUUID()}`;
  const normalIds = await contentRevisions(normalResource, 2);
  const normalInput = inputFor(normalResource, normalIds);
  const normalAdmission = randomUUID();
  const normalPrincipal = randomUUID();
  const normalGraph = new RequestGraph(pool!, lineage);
  const normal = serviceFor(normalGraph);
  const account = { verify: async () => ({ issuer: 'https://account.example', subject: 'request-worker' }) } as never;
  const normalResult = await requestContentErasure(normal.service, normal.environment, account,
    admissionAccess(normalAdmission, normalPrincipal), new Request('http://main.local'), normalInput);

  expect(normalResult.report.stage).toBe('reconciling');
  expect(normalResult.report.targets).toHaveLength(normalIds.length);
  expect(normalResult.report.targets.every(target => target.completionState === 'completed'
    && target.completionEvidenceRef !== null && target.completedAt !== null)).toBe(true);
  expect(new Set(normalResult.report.targets.map(target => target.completionEvidenceRef)).size)
    .toBe(normalIds.length);
  expect(normalGraph.proof).toBeDefined();
  for (const target of normalResult.report.targets) {
    expect(target.completionEvidenceRef).toBe(completionEvidence(normalResult.report.erasureId,
      normalResult.report.erasureEpoch, { ordinal: target.ordinal, owner: target.owner,
        target_kind: target.kind, target_ref: target.ref }));
  }
  const normalBeforeVerify = structuredClone(normalResult.report.targets);
  const normalVerification = await verifyErasure(pool!, { content: pool! }, normalResult.report.erasureId,
    `verify:${randomUUID()}`);
  expect(normalVerification.state).toBe('reconciled');
  const normalVerified = await readErasure(pool!, normalResult.report.erasureId);
  expect(normalVerified.stage).toBe('verified');
  expect(normalVerified.targets).toEqual(normalBeforeVerify);

  const unavailableResource = `https://rezics.com/id/${randomUUID()}`;
  const unavailableIds = await contentRevisions(unavailableResource, 1);
  const unavailableInput = inputFor(unavailableResource, unavailableIds);
  const unavailableAdmission = randomUUID();
  const unavailablePrincipal = randomUUID();
  const unavailableGraph = new RequestGraph(pool!, lineage);
  const unavailable = serviceFor(unavailableGraph, contentOwner(pool!, true));
  await expect(requestContentErasure(unavailable.service, unavailable.environment, account,
    admissionAccess(unavailableAdmission, unavailablePrincipal), new Request('http://main.local'),
    unavailableInput)).rejects.toBeInstanceOf(ErasureUnavailable);
  const unavailableId = (await pool!.query<{ id: string }>(
    'SELECT id FROM relay.erasure WHERE operation_id = $1', [`erasure:${unavailableAdmission}`])).rows[0]!.id;
  const unavailableReport = await readErasure(pool!, unavailableId);
  expect(unavailableReport.stage).toBe('fenced');
  expect(unavailableReport.suppression).toBe('suppressed');
  expect(unavailableReport.verifiedAt).toBeNull();
  expect(unavailableReport.targets.map(target => target.completionState)).toEqual(['pending']);
  await expect(verifyErasure(pool!, { content: pool! }, unavailableId, `verify:${randomUUID()}`))
    .rejects.toBeInstanceOf(ErasureUnavailable);

  const retryResource = `https://rezics.com/id/${randomUUID()}`;
  const retryIds = await contentRevisions(retryResource, 2);
  const retryInput = inputFor(retryResource, retryIds);
  const retryAdmission = randomUUID();
  const retryPrincipal = randomUUID();
  const retryDigest = contentErasureDigest(retryInput);
  const journaled = await journalErasure(pool!, { operationId: `erasure:${retryAdmission}`,
    requestDigest: retryDigest, kind: 'revision', principalId: retryPrincipal,
    admissionId: retryAdmission, authorityEpoch: '1',
    targets: retryIds.map(ref => ({ kind: 'content_revision' as const, ref })) });
  const partial = await readErasure(pool!, journaled.erasureId);
  const retryGraph = new RequestGraph(pool!, lineage);
  const seededProof: GraphProof = { receipt: `urn:rezics:receipt:erasure-graph:${sha256(journaled.erasureId)}`,
    dataEpoch: lineage.dataEpoch, sequence };
  const seededEvidence = historicalCompletionEvidence(journaled.erasureId, journaled.erasureEpoch,
    { ordinal: partial.targets[0]!.ordinal, owner: partial.targets[0]!.owner,
      target_kind: partial.targets[0]!.kind, target_ref: partial.targets[0]!.ref }, seededProof);
  await completeErasureTarget(pool!, journaled.erasureId, partial.targets[0]!.ordinal, seededEvidence);
  const partialReport = await readErasure(pool!, journaled.erasureId);
  const alreadyCompleted = partialReport.targets[0]!;
  expect(alreadyCompleted.completionState).toBe('completed');
  expect(partialReport.targets[1]!.completionState).toBe('pending');

  const retry = serviceFor(retryGraph);
  const retryResult = await requestContentErasure(retry.service, retry.environment, account,
    admissionAccess(retryAdmission, retryPrincipal), new Request('http://main.local'), retryInput);
  expect(retryResult.replayed).toBe(true);
  expect(retryResult.report.targets.map(target => target.completionState)).toEqual(['completed', 'completed']);
  expect(retryResult.report.targets[0]!.completionEvidenceRef).toBe(seededEvidence);
  expect(retryResult.report.targets[0]!.completedAt).toBe(alreadyCompleted.completedAt);
  expect(retryResult.report.targets[1]!.completionEvidenceRef).toBe(completionEvidence(
    journaled.erasureId, journaled.erasureEpoch,
    { ordinal: retryResult.report.targets[1]!.ordinal, owner: retryResult.report.targets[1]!.owner,
      target_kind: retryResult.report.targets[1]!.kind, target_ref: retryResult.report.targets[1]!.ref }));
  const retryVerification = await verifyErasure(pool!, { content: pool! }, journaled.erasureId,
    `verify:${randomUUID()}`);
  expect(retryVerification.state).toBe('reconciled');
  expect((await readErasure(pool!, journaled.erasureId)).stage).toBe('verified');
}, 120_000);
