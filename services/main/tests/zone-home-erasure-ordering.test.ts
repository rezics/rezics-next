import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { migrateContent } from '../../content/src/migrate.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { FusekiClient, type CommandEnvelope, type CommandResult, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { readErasure, sha256 } from '../src/modules/erasure/journal.ts';
import { ErasureService, requestContentErasure } from '../src/modules/erasure/request.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { createZoneHomePublicationFixture } from './support/zone-home-publication-fixture.ts';

const root = resolve(import.meta.dir, '../../..');
const graphProfile = 'erasure-graph-v1';
const resource = () => `https://rezics.com/id/${randomUUID()}`;
type Binding = NonNullable<SparqlResult['results']>['bindings'][number];

let cluster: PostgresCluster | undefined;
let admin: Pool | undefined;
let inspectionPool: Pool | undefined;
let relayPool: Pool | undefined;
let contentPool: Pool | undefined;
let preservationPool: Pool | undefined;

beforeAll(async () => {
  cluster = await startPostgresCluster();
  admin = new Pool({ ...cluster.connection, max: 2 });
  const database = `home_erasure_ordering_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${database}`);
  const ownerConnection = { ...cluster.connection, database, max: 4 };
  inspectionPool = new Pool(ownerConnection);
  relayPool = new Pool(ownerConnection);
  contentPool = new Pool(ownerConnection);
  preservationPool = new Pool(ownerConnection);
  await migrateContent(contentPool);
  for (const file of schemaFiles(root, 'relay')) {
    await inspectionPool.query(readFileSync(join(root, 'services/main/migrations/relay', file), 'utf8'));
  }
  await inspectionPool.query(`CREATE SCHEMA access;
    CREATE TABLE access.governance_preservation_hold (
      id uuid PRIMARY KEY, target_resource text NOT NULL, reason text NOT NULL, released_at timestamptz);
    CREATE TABLE access.governance_erasure_postponement (
      hold_id uuid NOT NULL, operation_id text NOT NULL, material_ref text NOT NULL,
      reason text NOT NULL, PRIMARY KEY (hold_id, operation_id, material_ref))`);
}, 120_000);

afterAll(async () => {
  await preservationPool?.end();
  await contentPool?.end();
  await relayPool?.end();
  await inspectionPool?.end();
  await admin?.end();
  cluster?.remove();
});

interface FenceProbe {
  held: boolean;
  attempts: number;
  firstAttempt: Promise<void>;
  signalAttempt: () => void;
}

function probeFence(owner: Pool, probe: FenceProbe): Pool {
  return new Proxy(owner, { get(target, property) {
    if (property === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(connection, method) {
        if (method === 'query') return async (sql: string, values?: unknown[]) => {
          if (sql.startsWith('BEGIN')) probe.held = false;
          const lock = sql.includes('pg_advisory_xact_lock(hashtextextended($1, 931))');
          if (lock) {
            probe.attempts++;
            probe.signalAttempt();
          }
          const result = await connection.query(sql, values);
          if (lock) probe.held = true;
          if (sql === 'COMMIT' || sql === 'ROLLBACK') probe.held = false;
          return result;
        };
        const value = Reflect.get(connection, method, connection);
        return typeof value === 'function' ? value.bind(connection) : value;
      } }) as PoolClient;
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as Pool;
}

class HomeClosureGraph extends FusekiClient {
  readonly homes: string[];
  readonly inventories: { held: boolean; homes: string[] }[] = [];
  readonly suppressionAttempts: string[][] = [];
  proofRows: Binding[] = [];

  constructor(readonly relay: Pool, readonly homeDocument: string, firstHome: string,
    readonly lineage: { dataEpoch: string; routingEpoch: string }, readonly fence: FenceProbe) {
    super('http://home-erasure-ordering.invalid');
    this.homes = [firstHome];
  }

  override async commandHealth() {
    return { moduleVersion: 'fixture', instanceId: randomUUID(), publicSearchWriteEpoch: '0',
      publicSearchWriteActive: false, profiles: { [graphProfile]: profileRegistry[graphProfile]!.sha256 } };
  }

  override async query(sparql: string): Promise<SparqlResult> {
    if (sparql.includes('SELECT DISTINCT ?revision ?owner ?erased ?owned')) {
      this.inventories.push({ held: this.fence.held, homes: [...this.homes] });
      return { results: { bindings: this.homes.map(revision => ({
        revision: { type: 'uri', value: revision },
        owner: { type: 'uri', value: this.homeDocument },
        erased: { type: 'literal', value: 'false', datatype: 'http://www.w3.org/2001/XMLSchema#boolean' },
        owned: { type: 'literal', value: 'true', datatype: 'http://www.w3.org/2001/XMLSchema#boolean' },
      })) } };
    }
    if (sparql.includes('SELECT DISTINCT ?graph ?unit ?target')) return { results: { bindings: [] } };
    if (sparql.includes('SELECT DISTINCT ?target ?sequence ?receiptEpoch ?currentSequence')) {
      return { results: { bindings: structuredClone(this.proofRows) } };
    }
    if (sparql.includes('SELECT DISTINCT ?target WHERE')) {
      return { results: { bindings: this.proofRows.map(({ target }) => ({ target })) } };
    }
    throw new Error(`Unexpected home closure query: ${sparql.slice(0, 100)}`);
  }

  override async commandWithReceipt(envelope: CommandEnvelope): Promise<CommandResult> {
    const targets = envelope.validations.flatMap(validation => validation.focus);
    this.suppressionAttempts.push(targets);
    if (this.homes.some(home => !targets.includes(home))) {
      return { status: 'invalid', report: { reason: 'live selecting home revision absent from exact closure' } } as CommandResult;
    }
    const erasure = (await this.relay.query<{ id: string }>(
      `SELECT id FROM relay.erasure WHERE stage = 'requested' ORDER BY erasure_epoch DESC LIMIT 1`)).rows[0];
    if (!erasure || envelope.receipt !== `urn:rezics:receipt:erasure-graph:${sha256(erasure.id)}`) {
      throw new Error('home suppression receipt does not name the retained journal');
    }
    const journal = (await this.relay.query<{ target_kind: string; target_ref: string }>(
      'SELECT target_kind, target_ref FROM relay.erasure_target WHERE erasure_id = $1', [erasure.id])).rows;
    const retained = journal.map(row => row.target_kind === 'content_revision'
      ? `urn:rezics:content:revision:${row.target_ref}` : `https://rezics.com/id/${row.target_ref}`);
    if (retained.length !== targets.length || retained.some(target => !targets.includes(target))) {
      throw new Error('native command and durable journal target closure differ');
    }
    this.proofRows = targets.map(target => ({
      target: { type: 'uri', value: target },
      sequence: { type: 'literal', value: '7' },
      receiptEpoch: { type: 'literal', value: this.lineage.dataEpoch },
      currentSequence: { type: 'literal', value: '7' },
    }));
    return { status: 'committed' } as CommandResult;
  }
}

async function contentRevision(publication: Pick<ReturnType<typeof createZoneHomePublicationFixture>,
  'reference' | 'serializedJson' | 'body'>): Promise<string> {
  const { reference, serializedJson, body } = publication;
  const { language } = reference;
  await contentPool!.query(`INSERT INTO content.variant
    (id, resource_id, language_kind, language_tag, original_language_tag, direction)
    VALUES ($1, $2, $3, $4, $5, $6)`, [reference.variantId, reference.resourceId, language.kind,
    language.kind === 'tag' ? language.tag : null, language.kind === 'tag' ? language.originalTag : null, reference.direction]);
  await contentPool!.query(`INSERT INTO content.revision (id, variant_id, operation_id, format, model, provenance,
    byte_digest, byte_length, serialized_bytes, body)
    VALUES ($1, $2, $3, 'rezics-content-json-v1', $4, '{}'::jsonb, $5, $6, $7, $8::jsonb)`,
  [reference.revisionId, reference.variantId, `home-erasure-${reference.revisionId}`, reference.model,
    reference.byteDigest, reference.byteLength, Buffer.from(serializedJson), JSON.stringify(body)]);
  return reference.revisionId;
}

// Home erasure closure ordering rule: fence, inventory, journal, suppression proof, release; retries recompute closure under the fence.
test.failing('a racing home cut is journaled under the publication fence and remains complete on retry', async () => {
  const homeDocument = resource(), firstHome = resource();
  let signalAttempt!: () => void;
  const fence: FenceProbe = { held: false, attempts: 0,
    firstAttempt: new Promise<void>(resolveAttempt => { signalAttempt = resolveAttempt; }),
    signalAttempt: () => signalAttempt() };
  const graph = new HomeClosureGraph(inspectionPool!, homeDocument, firstHome,
    { dataEpoch: randomUUID(), routingEpoch: randomUUID() }, fence);
  let racingHome!: string, signalPublisher!: () => void, releasePublisher!: () => void;
  const publisherEntered = new Promise<void>(resolveEntered => { signalPublisher = resolveEntered; });
  const publisherGate = new Promise<void>(resolveGate => { releasePublisher = resolveGate; });
  const publication = createZoneHomePublicationFixture({ preservationPool: preservationPool!, homeDocument, firstHome,
    onBeforeCommit: async home => { racingHome = home; signalPublisher(); await publisherGate; },
    onCommit: home => { graph.homes.push(home); } });
  const revision = await contentRevision(publication);
  const environment = { fuseki: graph, lineage: graph.lineage, objectDirectory: join(root, '.temp') } as unknown as WorkActivationEnvironment;
  const admissionId = randomUUID(), principalId = randomUUID();
  const input = { actingSubject: resource(), resourceId: homeDocument,
    revisionIds: [revision], idempotencyKey: randomUUID() };
  const account = { verify: async () => ({ issuer: 'https://account.example', subject: 'home-erasure-owner' }) } as never;
  const access = {
    register: async (request: { actingSubject: string; scope: string; action: string;
      idempotencyKey: string; requestDigest: string }) => ({ ...request,
      id: admissionId, principalId, authorityEpoch: '1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'registered' as const,
      dispatchEligible: true, replayed: false }),
    claim: async () => undefined,
    recordGraphOutcome: async () => undefined,
  } as never;
  const service = new ErasureService(relayPool!, contentPool!, probeFence(preservationPool!, fence));
  const published = publication.publish().then(result => ({ result, error: undefined }),
    (error: unknown) => ({ result: undefined, error }));
  const request = () => requestContentErasure(service, environment, account, access,
    new Request('http://main.local'), input).then(result => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }));
  let initial: ReturnType<typeof request> | undefined;
  try {
    await Promise.race([publisherEntered, published.then(outcome => {
      throw new Error(`site publication ended before its native switch: ${String(outcome.error)}`);
    })]);
    initial = request();
    await Promise.race([fence.firstAttempt, initial.then(outcome => {
      throw new Error(`erasure ended before the publication fence: ${String(outcome.error)}`);
    })]);
    const journalBeforeFence = (await inspectionPool!.query<{ target_ref: string }>(
      `SELECT target.target_ref FROM relay.erasure_target target
       JOIN relay.erasure intent ON intent.id = target.erasure_id WHERE intent.operation_id = $1`,
      [`erasure:${admissionId}`])).rows.map(target => target.target_ref).sort();
    releasePublisher();
    const publicationResult = await published;
    expect(publicationResult.error).toBeUndefined();
    expect(publicationResult.result?.homeRevision).toBe(racingHome);
    const first = await initial;
    const journalId = (await inspectionPool!.query<{ id: string }>(
      'SELECT id FROM relay.erasure WHERE operation_id = $1', [`erasure:${admissionId}`])).rows[0]!.id;
    const beforeRetry = await readErasure(inspectionPool!, journalId);
    const retry = await request();
    const afterRetry = await readErasure(inspectionPool!, journalId);
    const expectedRefs = [revision, firstHome.slice('https://rezics.com/id/'.length),
      racingHome.slice('https://rezics.com/id/'.length)].sort();
    expect({
      journalBeforeFence,
      inventoryUnderFence: graph.inventories.every(inventory => inventory.held),
      initialTargets: beforeRetry.targets.map(target => target.ref).sort(),
      retryTargets: afterRetry.targets.map(target => target.ref).sort(),
      firstError: first.error,
      retryError: retry.error,
      replayed: retry.result?.replayed,
      retryStage: afterRetry.stage,
      completed: afterRetry.targets.every(target => target.completionState === 'completed'),
    }).toEqual({ journalBeforeFence: [], inventoryUnderFence: true, initialTargets: expectedRefs, retryTargets: expectedRefs,
      firstError: undefined, retryError: undefined, replayed: true, retryStage: 'inventory_complete', completed: true });
  } finally {
    releasePublisher();
    await published;
    await initial;
    publication.cleanup();
  }
}, 15_000);
