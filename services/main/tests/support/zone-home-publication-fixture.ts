import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { fromPlainText } from '@rezics/document';
import type { ContentCore, ExactContentReference, PublicationPreparation } from '../../../content/src/core.ts';
import { profileRegistry } from '../../../../packages/model/src/generated/profiles.ts';
import { FusekiClient, type CommandEnvelope, type CommandResult, type SparqlResult } from '../../src/infrastructure/fuseki.ts';
import { AdmissionDenied, type AdmissionRequest, type RegisteredAdmission } from '../../src/modules/access/admission.ts';
import { withPreservationFence } from '../../src/modules/public-report/preservation.ts';
import { prepareComponent, RV, hash, type WorkActivationEnvironment } from '../../src/modules/work/activate.ts';
import { publishZoneSite } from '../../src/modules/zone/configuration.ts';
import { ZONE_CONFIG_FORMAT, ZONE_LIMITS, ZONE_PROFILE, zonePublishedPageBinding } from '../../src/modules/zone/config-format.ts';

const resource = () => `https://rezics.com/id/${randomUUID()}`;
const cells = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { type: 'literal', value }]));

export interface ZoneHomePublicationFixtureOptions {
  preservationPool: Pool;
  homeDocument?: string;
  contentRevisionId?: string;
  firstHome?: string;
  onBeforeCommit?: (home: string) => Promise<void>;
  onCommit?: (home: string) => Promise<void> | void;
  onSettle?: () => Promise<void> | void;
  authority?: 'allow' | 'deny';
  fence?: 'real' | 'held' | 'unavailable';
}

/** Exercises the exported site owner with exact Content custody and the real SQL target lock. */
export function createZoneHomePublicationFixture(options: ZoneHomePublicationFixtureOptions) {
  const homeDocument = options.homeDocument ?? resource(), zone = resource(), space = resource(), navigation = resource();
  const head = resource(), navigationRevision = resource(), admissionId = randomUUID(), principalId = randomUUID();
  const contentRevisionId = options.contentRevisionId ?? randomUUID(), variantId = `urn:rezics:variant:${randomUUID()}`;
  const contentEpoch = randomUUID(), lineage = { dataEpoch: randomUUID(), routingEpoch: randomUUID() };
  const objectDirectory = mkdtempSync(join(resolve(import.meta.dir, '../../../../.temp'), 'home-publication-owner-'));
  const manifest = prepareComponent(objectDirectory, zone, { configuration: {
    format: ZONE_CONFIG_FORMAT, zone, space, navigation, homeDocument, state: 'active', disclosure: 'public',
    budget: { timeMs: ZONE_LIMITS.queryBudgetMs, rows: ZONE_LIMITS.queryBudgetRows }, queryBlocks: [], model: ZONE_PROFILE,
  } }, ZONE_PROFILE);
  const body = { body: 'Home', document: fromPlainText('Home', 'blocks') }, serializedJson = JSON.stringify(body), byteDigest = hash(serializedJson);
  const reference: ExactContentReference = { owner: 'content', resourceId: homeDocument, variantId, revisionId: contentRevisionId,
    format: 'rezics-content-json-v1', model: 'content-shape-v1', byteDigest, byteLength: Buffer.byteLength(serializedJson),
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', sourceRevision: null,
    predecessor: null, provenance: {} };
  const position = { owner: 'content' as const, dataEpoch: contentEpoch, sequence: '4' };
  let admission: RegisteredAdmission | undefined, preparation: PublicationPreparation | undefined;
  let terminal: Record<string, string> | undefined, published: Record<string, string> | undefined;
  const state = { fenceHeld: false, fenceAttempts: 0, settlements: 0, pins: 0, authorityScopes: [] as string[], commits: [] as string[] };
  let signalFenceAttempt!: () => void;
  const firstFenceAttempt = new Promise<void>(resolveAttempt => { signalFenceAttempt = resolveAttempt; });
  const pool = new Proxy(options.preservationPool, { get(target, property) {
    if (property === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(connection, method) {
        if (method === 'query') return async (sql: string, values?: unknown[]) => {
          const lock = sql.includes('pg_advisory_xact_lock(hashtextextended($1, 931))');
          if (lock) { state.fenceAttempts++; signalFenceAttempt(); }
          const result = await connection.query(sql, values);
          if (lock) state.fenceHeld = true;
          if (sql === 'COMMIT' || sql === 'ROLLBACK') state.fenceHeld = false;
          return result;
        };
        const value = Reflect.get(connection, method, connection);
        return typeof value === 'function' ? value.bind(connection) : value;
      } }) as PoolClient;
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as Pool;
  class PublicationGraph extends FusekiClient {
    constructor() { super('http://home-publication-owner.invalid'); }
    override async commandHealth() {
      return { moduleVersion: 'fixture', instanceId: randomUUID(), publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
        profiles: Object.fromEntries(Object.entries(profileRegistry).map(([key, profile]) => [key, profile.sha256])) };
    }
    override async query(query: string): Promise<SparqlResult> {
      if (query.includes('SELECT ?outcome ?reason')) return { results: { bindings: terminal ? [cells(terminal)] : [] } };
      if (query.includes('SELECT ?zone ?revision')) return { results: { bindings: published ? [cells(published)] : [] } };
      if (query.includes('SELECT ?space ?navigation ?head')) return { results: { bindings: [cells({ space, navigation,
        head, manifest: `urn:rezics:sha256:${manifest}`, state: `${RV}Active`, spaceDisclosure: `${RV}Public`, homeDocument,
        ...(options.firstHome ? { homeRevision: options.firstHome } : {}) })] } };
      if (query.includes('SELECT DISTINCT ?type ?zone')) return { results: { bindings: [cells({ type: `${RV}ZoneHomeDocument`, zone })] } };
      if (query.includes('SELECT ?admission ?receipt ?digest')) return { results: { bindings: [cells({ admission: randomUUID(),
        receipt: `urn:rezics:receipt:${'c'.repeat(64)}`, digest: 'd'.repeat(64) })] } };
      if (query.includes('ASK')) return { boolean: !query.includes('rv:rejectionKind rv:InvalidProfile') };
      throw new Error(`Unexpected site owner query: ${query.slice(0, 120)}`);
    }
    override async commandWithReceipt(envelope: CommandEnvelope): Promise<CommandResult> {
      if (terminal) return { status: 'committed' } as CommandResult;
      const revision = envelope.validations.find(validation => validation.shape === `${ZONE_PROFILE}/revision-shape`)?.focus[0];
      const home = envelope.validations.find(validation => validation.shape === `${ZONE_PROFILE}/home-revision-shape`)?.focus[0];
      if (home) {
        if (!state.fenceHeld) throw new Error('Native home switch is outside the shared publication fence');
        if (!revision || !envelope.update.includes(`<${homeDocument}> a rv:ZoneHomeDocument ; rv:homeDocumentHead <${home}>`)
          || !envelope.update.includes(`<${zone}> rv:homeDocument <${homeDocument}>`)) throw new Error('Site command lost native owner identity');
        await options.onBeforeCommit?.(home);
        if (!state.fenceHeld) throw new Error('Publication fence ended before native commit');
        state.commits.push(home);
        await options.onCommit?.(home);
        published = { zone, revision, routesRevision: navigationRevision, navigationRevision, themeRevision: head,
          count: '1', admissionId, digest: envelope.digest, authorityEpoch: '1', scope: `zone:edit:${zone}`,
          dataEpoch: lineage.dataEpoch, sequence: '8', binding: zonePublishedPageBinding(revision, homeDocument, contentRevisionId),
          page: homeDocument, variant: variantId, contentRevision: `urn:rezics:content:revision:${contentRevisionId}`,
          byteDigest, language: 'en', homeDocument, homeRevision: home };
      }
      terminal = { outcome: `${RV}${home ? 'Succeeded' : 'Cancelled'}`, digest: envelope.digest, admission: admissionId,
        epoch: '1', scope: `zone:edit:${zone}`, dataEpoch: lineage.dataEpoch, sequence: '8',
        ...(revision && home ? { owner: zone, revision } : {}) };
      return { status: 'committed' } as CommandResult;
    }
  }
  const graph = new PublicationGraph();
  const env = { fuseki: graph, lineage, objectDirectory } as WorkActivationEnvironment;
  const content = {
    owningResourceForRevision: async () => homeDocument,
    ownerPosition: async () => position,
    readExactBatch: async () => [{ revisionId: contentRevisionId, status: 'available', reference, serializedJson, body }],
    preparePublication: async (operationId: string) => {
      state.pins++;
      preparation = { operationId, reference, position, status: 'pending', pinActive: true, replayed: false };
      return preparation;
    },
    readPublicationPreparation: async () => preparation,
    settlePublication: async (_operationId: string, _preparationId: string, proof: { outcome: string }) => {
      if (state.fenceHeld) throw new Error('Content settlement must follow the release of the publication fence');
      state.settlements++;
      await options.onSettle?.();
      return { status: proof.outcome === 'active' ? 'active' : 'rejected', pinActive: false, position, replayed: state.settlements > 1 };
    },
  } as unknown as ContentCore;
  const account = { verify: async () => ({ issuer: 'https://account.test', subject: 'editor', emailVerified: true }) };
  const access = {
    activePrincipalId: async () => principalId,
    register: async (request: AdmissionRequest) => {
      const replayed = admission !== undefined;
      admission ??= { ...request, id: admissionId, principalId, authorityEpoch: '1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'registered', dispatchEligible: true, replayed: false };
      return { ...admission, replayed, ...(terminal ? { state: 'sealed' as const } : {}) };
    },
    claim: async () => ({ ...admission!, state: 'claimed' as const }),
    recordGraphOutcome: async () => undefined,
    withOwnerAuthority: async (authority: AdmissionRequest, write: (client: PoolClient) => Promise<unknown>) => {
      state.authorityScopes.push(authority.scope);
      if (authority.action === 'zone.edit' && options.authority === 'deny') throw new AdmissionDenied('Zone editor withdrawn');
      return write({ query: async () => ({ rows: [], rowCount: 1 }) } as unknown as PoolClient);
    },
    ...(options.fence === 'unavailable' ? {} : { withPreservationFence: <T>(resource: string, operationId: string, write: () => Promise<T>) =>
      options.fence === 'held' ? Promise.resolve({ held: true as const }) : withPreservationFence(pool, resource, operationId, write) }),
  } as unknown as Parameters<typeof publishZoneSite>[2];
  const input = { zone, expectedHead: head, actingSubject: resource(), idempotencyKey: randomUUID(),
    routesRevision: navigationRevision, navigationRevision,
    pages: [{ page: homeDocument, variantId, revisionId: contentRevisionId, byteDigest, contentEpoch }] };
  return { homeDocument, zone, admissionId, contentRevisionId, reference, serializedJson, body, state, firstFenceAttempt,
    publish: () => publishZoneSite(env, account, access, new Request('http://main.test/v1/zone-site-publications'), input, content),
    cleanup: () => rmSync(objectDirectory, { recursive: true, force: true }) };
}
