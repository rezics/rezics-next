import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { withTelemetrySpan } from '@rezics/observability/runtime';
import { GraphReadFence, fencedGraphQuery, graphReadVersion } from '../../infrastructure/graph-read-fence.ts';
import { assertFusekiReadActive, fusekiReadBudget, withFusekiReadRequest, FusekiReadDeadlineExceeded,
  snapshotFusekiReadDiagnostics, FusekiQueryResponseTooLarge, FusekiReadBudgetExceeded,
  type FusekiReadDiagnosticSnapshot,
  type SparqlResult } from '../../infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
// `deps.media` is declared by module augmentation in the media routes; import it
// so programs that reach this file without the route module still see it.
import type {} from '../../routes/media.ts';
import { AccountAssertionDenied, verifyRequestAccount, type VerifiedAccountAssertion } from '../account/verify-assertion.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { readResourceSummaries, type ResourceSummary, type SummaryInput, type SummaryReader,
  type SummaryMedia } from '../media/summary.ts';
import { readerLanguages } from '../display-language/select.ts';
import { readRealmPolicy } from '../space/policy.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { DATASET, GRAPHS, RV, iri, lit } from './activate.ts';
import { WORK_READ_COST } from './read-contract.ts';
import { SearchSnapshotMoved } from './search-readiness.ts';
import { fenceAuthorNames } from '../source/author-name-read.ts';
import { optionalPreview } from '../query/optional-preview.ts';
import { knownSearchPosition, searchGraphSnapshot } from '../search/snapshot-state.ts';
import { disclosureViewer, withDisclosureViewer } from '../disclosure/viewer.ts';
import type { Viewer } from '../suitability/policy.ts';
import { publicLanguageRequest } from '../display-language/public-request.ts';
import { discloseInventory, type DisclosureChannel, type DisclosureTarget } from '../disclosure/read.ts';
export { publicWork, unerased } from './public-patterns.ts';

export class WorkReadInvalid extends Error {}
export class WorkReadMissing extends Error {}
export class WorkReadMoved extends Error {}
export class WorkReadExpired extends WorkReadMoved {}
/** `code` is a bounded token of the fixed reason, so the logged 503 names which
 * read refused (the class alone cannot tell a moved basis from a missing one). */
export class WorkReadUnavailable extends Error {
  readonly code: string;
  readonly phase?: string;
  readonly diagnostics?: FusekiReadDiagnosticSnapshot;
  constructor(message?: string, options?: ErrorOptions & { phase?: string; diagnostics?: FusekiReadDiagnosticSnapshot }) {
    super(message, options);
    this.code = (message ?? 'unavailable').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
    this.phase = options?.phase;
    this.diagnostics = options?.diagnostics;
  }
}
export class WorkReadLimit extends Error {}
export type ReadRow = NonNullable<SparqlResult['results']>['bindings'][number];
export interface ReadPosition { dataEpoch: string; sequence: string; dependencyToken?: string }
export interface ReadOptions { language?: string; languages?: string; actingSubject?: string; cursor?: string; limit?: number;
  /** Only the server-selected, effect-free template executor may enable POST retries. */
  readOnlyTemplate?: boolean;
  /** The Work header and editions bind selected dependencies, rather than the dataset counter. */
  localBasis?: boolean;
  /** Edition pages consume both supported record profiles; the header consumes its selected metadata profile. */
  localProfiles?: readonly string[];
  scope?: 'global' | 'realm' | 'mine'; realm?: string;
  /** Trusted internal audience for public hydration; grants no Agent or private Realm authority. */
  publicViewer?: Viewer;
  /** Internal owner promise: its continuation addresses retained immutable rows. */
  retainedBasis?: boolean;
  /** Owner reads with live disclosure fences may return a stale result as the graph advances. */
  movingGraph?: boolean }
export const READ_PREFIX = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
  PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
  PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
  PREFIX skos: <http://www.w3.org/2004/02/skos/core#>`;
// Process-local encrypted cursors intentionally expire on restart; never authorization.
const cursorKey = randomBytes(32);
interface Cursor { version: 1; binding: string; position: ReadPosition; after: string; order: string;
  expiresAt?: number }
const bindingOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Query order is immaterial to a dependency set; preserve RDF term identity. */
export const readRowsToken = (rows: readonly ReadRow[]) => bindingOf(rows.map(row =>
  Object.entries(row).sort(([a], [b]) => a.localeCompare(b)).map(([key, term]) =>
    [key, Object.entries(term).sort(([a], [b]) => a.localeCompare(b))]))
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
export const readDependencyToken = (value: unknown) => createHash('sha256').update(JSON.stringify(value,
  (_key, item: unknown) => item instanceof Map ? [...item].sort(([a], [b]) => String(a).localeCompare(String(b)))
    : item instanceof Set ? [...item].sort() : item)).digest('hex');
const activeReadSession = new AsyncLocalStorage<WorkReadSession>();
export function encodeReadCursor(binding: unknown, position: ReadPosition, after: string, order = '', expiresAt?: number): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cursorKey, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ version: 1, binding: bindingOf(binding),
    position, after, order, expiresAt } satisfies Cursor)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}
export function decodeReadCursor(token: string | undefined, binding: unknown, position: ReadPosition,
  retained = false): Cursor | null {
  if (!token) return null;
  let decoded: Cursor;
  try {
    if (token.length > 2048 || !/^[\w-]+$/.test(token)) throw new Error('cursor');
    const bytes = Buffer.from(token, 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', cursorKey, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    decoded = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString()) as Cursor;
    if (decoded.version !== 1 || decoded.binding !== bindingOf(binding)
      || typeof decoded.after !== 'string' || typeof decoded.order !== 'string'
      || !decoded.position || typeof decoded.position.dataEpoch !== 'string'
      || typeof decoded.position.sequence !== 'string'
      || decoded.position.dependencyToken !== undefined
        && (typeof decoded.position.dependencyToken !== 'string' || !/^[0-9a-f]{64}$/.test(decoded.position.dependencyToken))
      || decoded.expiresAt !== undefined && !Number.isSafeInteger(decoded.expiresAt)) throw new Error('cursor');
  } catch { throw new WorkReadInvalid('Cursor is invalid or expired'); }
  if (decoded.expiresAt !== undefined && decoded.expiresAt <= Date.now()) {
    throw new WorkReadExpired('Read basis expired; restart from the first page');
  }
  // Only an owner with immutable retained rows may relax the graph sequence.
  // The epoch remains a recovery fence; a cursor never grants disclosure.
  if (decoded.position.dataEpoch !== position.dataEpoch
    || (position.dependencyToken !== undefined || decoded.position.dependencyToken !== undefined
      ? decoded.position.dependencyToken !== position.dependencyToken
      : (!retained || decoded.expiresAt === undefined) && decoded.position.sequence !== position.sequence)) {
    throw new WorkReadExpired('Collection changed; restart from the first page');
  }
  return decoded;
}

export class WorkReadSession {
  private readonly retainedReads = new Map<string, Promise<unknown>>();
  /** Share hydration within this attempt; the registered dependency still reads
   * its owner afresh at completion. Never share this cache across requests. */
  async retained<T>(key: string, read: () => Promise<T>): Promise<T> {
    this.checkDeadline();
    let value = this.retainedReads.get(key);
    if (!value) {
      value = read();
      this.retainedReads.set(key, value);
    }
    const result = await value;
    this.checkDeadline();
    return structuredClone(result) as T;
  }
  private readonly children = new Set<WorkReadSession>();
  private captureDependencies = true;
  /** Moving inventories own their live-row fences; every other read captures selected inputs. */
  get fencesSelectedUnits() { return !this.options.movingGraph || !!this.options.localBasis; }
  private readonly queryDependencies = new Map<string, { limit: number; maxBytes: number; token: string;
    fenceRows?: (rows: readonly ReadRow[]) => ReadRow[] }>();
  private readonly ownerDependencies = new Map<string, { token: string; read: () => Promise<unknown> }>();
  /** A qualified owner may advance the opening basis before consuming inputs.
   * Continuations and already selected dependencies must instead restart. */
  repin(position: ReadPosition): void {
    if (position.dataEpoch !== this.position.dataEpoch || this.options.cursor
      || new URL(this.request.url).searchParams.has('cursor')
      || this.queryDependencies.size || this.ownerDependencies.size || this.children.size) {
      throw new WorkReadMoved('Read basis changed after selection');
    }
    this.position.sequence = position.sequence;
  }
  async dependency(name: string, read: () => Promise<unknown>): Promise<string> {
    this.checkDeadline();
    return this.observeDependency(name, await read(), read);
  }
  async canPreviewWork(work: string): Promise<boolean> {
    this.checkDeadline();
    if (!this.principal || !this.options.actingSubject) return false;
    const read = () => {
      if (!this.deps.access.canPreviewWork) throw new WorkReadUnavailable('Work preview authority is unavailable');
      return this.deps.access.canPreviewWork(this.principal!, this.options.actingSubject!, work);
    };
    const allowed = await read();
    this.observeDependency(`work-preview:${work}:${this.options.actingSubject}`, allowed, read);
    return allowed;
  }
  observeDependency(name: string, value: unknown, read: () => Promise<unknown>): string {
    const token = readDependencyToken(value);
    if (this.fencesSelectedUnits && this.captureDependencies) {
      const previous = this.ownerDependencies.get(name);
      if (previous && previous.token !== token) throw new WorkReadMoved('Selected dependency changed');
      this.ownerDependencies.set(name, { token, read });
    }
    return token;
  }
  /** Admission scans may inspect many unshown candidates. Fence their selected
   * result, rather than retaining every candidate's descriptive revision. */
  async selection<T>(name: string, read: (probe: WorkReadSession) => Promise<T>,
    selectedValue: (value: T) => unknown = value => value): Promise<T> {
    this.checkDeadline();
    const reread = async () => {
      const probe = new WorkReadSession(this.deps, this.request, this.options, { ...this.position });
      probe.captureDependencies = false;
      probe.principal = this.principal;
      probe.readingLanguages = this.readingLanguages;
      probe.restorePriors = this.restorePriors;
      return withWorkReadSession(probe, async () => {
        try { return await read(probe); }
        finally { await probe.fenceAuthority(); }
      });
    };
    const value = await reread();
    this.observeDependency(`selection:${name}`, selectedValue(value), async () => selectedValue(await reread()));
    return value;
  }
  /** Recheck only the bounded inputs consumed by this page. Retries share its HTTP budget. */
  async fenceDependencies() {
    this.checkDeadline();
    for (const [body, prior] of this.queryDependencies) {
      const rows = await this.query(body, prior.limit, prior.fenceRows, prior.maxBytes);
      if (readRowsToken(prior.fenceRows ? prior.fenceRows(rows) : rows) !== prior.token) {
        throw new WorkReadMoved('Selected head changed');
      }
    }
    for (const prior of this.ownerDependencies.values()) {
      this.checkDeadline();
      if (readDependencyToken(await prior.read()) !== prior.token) throw new WorkReadMoved('Selected dependency changed');
    }
    await this.fenceSummaryMedia();
    for (const child of this.children) { this.checkDeadline(); await child.fenceDependencies(); }
  }
  async fenceAuthority(): Promise<void> {
    this.checkDeadline();
    try {
      await this.fenceRealms();
      // A selection probe's mutable attribution is part of its registered
      // selected result, rather than a fence on every candidate it inspected.
      if (this.captureDependencies) await fenceAuthorNames(this);
      for (const child of this.children) { this.checkDeadline(); await child.fenceAuthority(); }
    } finally {
      try {
        this.checkDeadline();
        if (this.principal && !await this.deps.access.activePrincipalId(this.principal)) {
          throw new AccountAssertionDenied('Principal is inactive');
        }
      } finally {
        this.checkDeadline();
        await this.deps.access.assertRecoveryOpen();
      }
    }
  }
  private readonly deliveredSummaryAssets = new Set<string>();
  /** Snapshot of the signed-in reader's Main preference, shared by every name read. */
  readingLanguages: readonly string[] | null = null;
  get displayLanguages(): string[] {
    const ordered = this.request.headers.get('x-rezics-display-languages');
    const browserFallbacks = this.readingLanguages !== null
      ? readerLanguages(null, this.request.headers.get('accept-language')).join(',') : null;
    return readerLanguages([this.options.language, this.options.languages,
      this.readingLanguages?.join(','), ordered, browserFallbacks]
      .filter(Boolean).join(',') || null, this.request.headers.get('accept-language'));
  }
  principal: VerifiedPrincipal | null = null;
  /** Renewal changes budget expiry, while identity, consent and disclosure still
   * bind continuation. Every request separately verifies its current assertion. */
  get cursorIdentity() {
    if (!this.principal) return null;
    const { accountExpiresAt: _expiry, currentAssertion: _verify, ...identity } = this.principal as VerifiedAccountAssertion;
    return identity;
  }
  /** Work heads already read by summary batches in this session. */
  private readonly workRevisions = new Map<string, string>();
  workRevision(work: string) { return this.workRevisions.get(work); }
  get viewer() { return this.principal ? disclosureViewer(this.principal, this.options.actingSubject)
    : this.options.publicViewer ?? disclosureViewer(null); }
  async disclosure(targets: readonly DisclosureTarget[], channel: DisclosureChannel = 'read') {
    this.checkDeadline();
    const read = () => discloseInventory(this.deps.environment, targets, this.viewer, channel);
    const result = await read();
    this.observeDependency(`disclosure:${channel}:${JSON.stringify(targets)}`, result, read);
    return result;
  }
  stale = false;
  private readonly realmProofs = new Map<string, string>();
  /** Cutover priors from the opening graph position. Null when that position
   * was already known and this read has not loaded the chain. An empty map
   * means the opening read proved there is no restore cutover. */
  restorePriors: ReadonlyMap<string, string> | null = null;

  async realm(realm: string) {
    return this.retained(`realm:${realm}`, () => this.readRealm(realm));
  }

  private async readRealm(realm: string) {
    const policy = await readRealmPolicy(this.deps.environment, realm);
    if (!policy) throw new WorkReadMissing('Realm is unavailable');
    this.observeDependency(`realm-policy:${realm}`, policy, () => readRealmPolicy(this.deps.environment, realm));
    if (policy.visibility === 'private') {
      const proof = this.principal && this.options.actingSubject
        ? await this.deps.access.realmReadProof?.(this.principal, this.options.actingSubject, realm) : null;
      if (!proof) throw new WorkReadMissing('Realm is unavailable');
      const prior = this.realmProofs.get(realm);
      if (prior && prior !== proof) throw new WorkReadMoved('Realm membership changed');
      this.realmProofs.set(realm, proof);
    }
    return policy;
  }

  async fenceRealms() {
    for (const [realm, proof] of this.realmProofs) {
      this.checkDeadline();
      if (await this.deps.access.realmReadProof?.(this.principal!, this.options.actingSubject!, realm) !== proof) {
        throw new WorkReadMissing('Realm is unavailable');
      }
    }
  }
  constructor(readonly deps: MainWorkDependencies, readonly request: Request, readonly options: ReadOptions,
    readonly position: ReadPosition, readonly graphSnapshotFenced = false, readonly attemptCount = 1) {
    const parent = activeReadSession.getStore();
    if (parent?.position === position) {
      parent.children.add(this);
      this.captureDependencies = parent.captureDependencies;
    }
  }

  async query(body: string, limit: number, fenceRows?: (rows: readonly ReadRow[]) => ReadRow[],
    maxBytes: number = WORK_READ_COST.queryBytes): Promise<ReadRow[]> {
    this.checkDeadline();
    const graph = this.deps.environment.fuseki, query = `${READ_PREFIX}\n${body}`;
    const rows = (await fencedGraphQuery(graph, query, maxBytes,
      () => graph.query(query, maxBytes))).results?.bindings ?? [];
    if (rows.length > limit) throw new WorkReadLimit('Read exceeds its bounded relation');
    if (this.fencesSelectedUnits && this.captureDependencies) {
      const token = readRowsToken(fenceRows ? fenceRows(rows) : rows), prior = this.queryDependencies.get(body);
      if (prior && prior.token !== token) throw new WorkReadMoved('Selected head changed');
      this.queryDependencies.set(body, { limit, maxBytes, token, fenceRows });
    }
    return rows;
  }

  async summaries(resources: string[], optionalMedia = false): Promise<ResourceSummary[]> {
    return this.retained(`summaries:${JSON.stringify([resources, optionalMedia])}`,
      () => this.readSummaries(resources, optionalMedia));
  }

  private async readSummaries(resources: string[], optionalMedia: boolean): Promise<ResourceSummary[]> {
    this.checkDeadline();
    if (!resources.length) return [];
    const reader = { viewer: this.viewer, realmReadProof: this.principal && this.options.actingSubject ? (realm: string) =>
      Promise.resolve(this.deps.access.realmReadProof?.(this.principal!, this.options.actingSubject!, realm) ?? null) : undefined,
    canReadWork: this.principal && this.options.actingSubject ? (work: string) =>
      this.deps.access.canReadWork(this.principal!, this.options.actingSubject!, work) : undefined };
    const result = await this.summaryBatch({ resources, context: DEFAULT_MEDIA_CONTEXT,
      language: this.options.language?.toLowerCase() ?? null, languages: this.displayLanguages,
      settleNonAgentNameOwners: 'includingAbsent' }, reader, this.deps.media?.store, optionalMedia);
    return result.summaries;
  }

  /** Transport-specific summary inputs share the same selected dependency and
   * authority close as headers and cards, including merged identities. */
  async summaryBatch(input: SummaryInput, reader: SummaryReader, media: SummaryMedia | undefined,
    optionalMedia = false) {
    this.checkDeadline();
    const proof = reader.realmReadProof;
    const selectedReader: SummaryReader = { ...reader, ...(proof ? {
      realmReadProof: async (realm: string) => {
        const value = await proof(realm);
        this.observeDependency(`summary-realm-proof:${realm}`, value, () => proof(realm));
        return value;
      },
    } : {}) };
    const assetsByReference = new Map<string, string>();
    const summaryMedia = media ? {
      avatarRows: async (...args: Parameters<typeof media.avatarRows>) => {
        const row = optionalMedia ? await optionalPreview(this, () => media.avatarRows(...args)) : await media.avatarRows(...args);
        if (row) for (const [reference, avatar] of row.rows) {
          if (avatar?.asset) assetsByReference.set(reference, `https://rezics.com/id/${avatar.asset}`);
        }
        return row;
      },
    } : undefined;
    const summaryInput = (localBasis: boolean) => ({ ...input, localBasis });
    const result = await readResourceSummaries(this.deps.environment, summaryMedia, selectedReader,
      summaryInput(true));
    const rememberWorkRevisions = (revisions: ReadonlyMap<string, string>) => {
      for (const [work, revision] of revisions) this.workRevisions.set(work, revision);
    };
    rememberWorkRevisions(result.workRevisions);
    if (this.captureDependencies) {
      const key = `summaries:${JSON.stringify(input)}`;
      // Raw graph rows and avatar selections include private revisions and
      // undisclosed Assets. Only admitted values can move this reader's basis.
      const selected = (batch: typeof result) => {
        const visibleWorks = new Set(batch.summaries.flatMap(summary => summary.status === 'available'
          ? [summary.reference, ...(summary.work ? [summary.work] : []),
            ...(summary.parts ? [summary.parts.subject, ...summary.parts.frames]
              .flatMap(part => [part.reference, ...(part.work ? [part.work] : [])]) : [])] : []));
        return [this.position.dataEpoch, batch.generation.media?.split(':')[0] ?? null, batch.summaries,
          new Map([...batch.workRevisions].filter(([work]) => visibleWorks.has(work)))];
      };
      const token = readDependencyToken(selected(result));
      const previous = this.ownerDependencies.get(key);
      if (previous && previous.token !== token) throw new WorkReadMoved('Summary dependency changed');
      this.ownerDependencies.set(key, { token, read: async () => {
        const fresh = await readResourceSummaries(this.deps.environment, summaryMedia, selectedReader, summaryInput(true));
        rememberWorkRevisions(fresh.workRevisions);
        return selected(fresh);
      } });
    }
    for (const summary of result.summaries) {
      if (summary.status !== 'available' || summary.avatar.kind !== 'image') continue;
      const asset = assetsByReference.get(summary.reference);
      if (asset) this.deliveredSummaryAssets.add(asset);
    }
    return result;
  }

  /** Selected summaries close names, visible covers and media recovery epochs.
   * Close delivered Assets' disclosure again after those consistency checks. */
  async fenceSummaryMedia() {
    const assets = [...this.deliveredSummaryAssets];
    if (assets.length && (await this.disclosure(assets.map(resource => ({ owner: 'media',resource,component: 'cover' })), 'summary'))
      .some(decision => decision !== 'visible')) throw new WorkReadMoved('Avatar disclosure changed');
  }

  async scope() {
    this.checkDeadline();
    const kind = this.options.scope ?? 'global';
    if ((kind === 'realm') !== !!this.options.realm) throw new WorkReadInvalid('Realm is required only for Realm scope');
    if (kind === 'mine' && !this.principal) throw new AccountAssertionDenied('Mine requires authentication');
    if (kind === 'realm') {
      await this.realm(this.options.realm!);
    }
    return { kind, realm: this.options.realm ?? null };
  }

  checkDeadline(): void { assertFusekiReadActive(); }
}

async function position(deps: MainWorkDependencies, fresh = false, restoreLineage = false): Promise<ReadPosition & {
  priors: ReadonlyMap<string, string> | null; graphVersion?: string;
}> {
  const env = deps.environment;
  const known = knownSearchPosition(env.fuseki, env.lineage);
  if (known && !fresh) return { dataEpoch: known.dataEpoch, sequence: known.sequence, priors: null };
  const fence = `GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} .
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }`;
  // A restore hold still returns no row, so the read answers unavailable.
  // Ordinary reads keep the historical select list. New discussion order also
  // binds the restore chain here; a second round trip would exceed that page's cap.
  if (!restoreLineage) {
    const result = await env.fuseki.query(`${READ_PREFIX} SELECT ?epoch ?sequence WHERE {
    ${fence} } } LIMIT 2`, 8192);
    const rows = result.results?.bindings ?? [];
    if (rows.length !== 1 || rows[0]?.epoch?.value !== env.lineage.dataEpoch || !/^\d+$/.test(rows[0].sequence?.value ?? '')) {
      throw new WorkReadUnavailable('Graph is unavailable');
    }
    return { dataEpoch: rows[0].epoch.value, sequence: rows[0].sequence!.value, priors: null,
      graphVersion: graphReadVersion(result) };
  }
  const result = await env.fuseki.query(`${READ_PREFIX} SELECT ?epoch ?sequence ?cutEpoch ?prior WHERE {
    ${fence}
      OPTIONAL { ?cutover a rv:RestoreCutover ; rv:dataEpoch ?cutEpoch ; rv:priorDataEpoch ?prior } } } LIMIT 34`, 8192);
  const rows = result.results?.bindings ?? [];
  const epoch = rows[0]?.epoch?.value, sequence = rows[0]?.sequence?.value ?? '';
  if (!rows.length || epoch !== env.lineage.dataEpoch || !/^\d+$/.test(sequence)
    || rows.some(row => row.epoch?.value !== epoch || row.sequence?.value !== sequence)) {
    throw new WorkReadUnavailable('Graph is unavailable');
  }
  const priors = new Map<string, string>();
  for (const row of rows) {
    if (!row.cutEpoch && !row.prior) continue;
    const cut = row.cutEpoch?.value, previous = row.prior?.value;
    if (!cut || !previous || priors.has(cut) && priors.get(cut) !== previous) {
      throw new WorkReadUnavailable('Restore lineage is ambiguous');
    }
    priors.set(cut, previous);
  }
  if (priors.size > 32) throw new WorkReadUnavailable('Restore lineage exceeds its bound');
  return { dataEpoch: epoch, sequence, priors, graphVersion: graphReadVersion(result) };
}

export function withWorkReadSession<T>(session: WorkReadSession, operation: () => Promise<T>): Promise<T> {
  return activeReadSession.run(session, () => withDisclosureViewer(session.viewer, operation));
}

/** Owner adapters retain the enclosing reader's authority and dependency fence. */
export const currentWorkReadSession = () => activeReadSession.getStore();

/** Public inventories retain live Account age/preferences without adopting bearer authority. */
export async function publicWorkRead<T>(deps: MainWorkDependencies, request: Request,
  options: Omit<ReadOptions, 'actingSubject' | 'publicViewer'>,
  operation: (session: WorkReadSession) => Promise<T>, url: string | URL = request.url): Promise<T> {
  if (!fusekiReadBudget.getStore()) return withFusekiReadRequest(request, {
    calls: WORK_READ_COST.graphCalls, bytes: WORK_READ_COST.graphBytes, deadlineMs: WORK_READ_COST.deadlineMs,
  }, () => publicWorkRead(deps, request, options, operation, url));
  assertFusekiReadActive();
  const principal = request.headers.has('authorization')
    ? await verifyRequestAccount(deps.account, request, ['work:read']) : null;
  assertFusekiReadActive();
  return workRead(deps, publicLanguageRequest(request, url),
    { ...options, publicViewer: disclosureViewer(principal) }, operation);
}

export async function workRead<T>(deps: MainWorkDependencies, request: Request, options: ReadOptions,
  operation: (session: WorkReadSession) => Promise<T>,
  complete?: (result: T, session: WorkReadSession) => T): Promise<T> {
  const outer = fusekiReadBudget.getStore();
  const deadline = AbortSignal.timeout(WORK_READ_COST.deadlineMs);
  const signal = AbortSignal.any([request.signal, deadline, ...(outer ? [outer.signal] : [])]);
  let callsLeft: number = WORK_READ_COST.graphCalls, bytesLeft: number = WORK_READ_COST.graphBytes;
  // Allocate once, outside the retry loop: every attempt debits both this read
  // and any enclosing search's call/byte budget and shares their deadline.
  const budget = { signal,
    attempt: 1,
    diagnostics: outer?.diagnostics,
    deadline: Math.min(performance.now() + WORK_READ_COST.deadlineMs, outer?.deadline ?? Infinity),
    readPhase: 'position',
    get callsLeft() { return Math.min(callsLeft, outer?.callsLeft ?? callsLeft); },
    set callsLeft(value: number) { const used = this.callsLeft - value; callsLeft -= used; if (outer) outer.callsLeft -= used; },
    get bytesLeft() { return Math.min(bytesLeft, outer?.bytesLeft ?? bytesLeft); },
    set bytesLeft(value: number) { const used = this.bytesLeft - value; bytesLeft -= used; if (outer) outer.bytesLeft -= used; },
  };
  try {
    return await fusekiReadBudget.run(budget, async () => {
      // Fuseki HTTP operations each own a transaction, not the whole callback:
      // https://jena.apache.org/documentation/rdfconnection/#remote-transactions
      // Retry first pages and explicitly retained continuations. Internal build callbacks and commands
      // can commit effects and must never be replayed by this envelope. Attempts
      // share one deadline/call/byte budget and repeat every authority check.
      const url = new URL(request.url);
      // Some owners decode their own cursor without forwarding it in options.
      const hasCursor = !!options.cursor || url.searchParams.has('cursor');
      const attempts = !options.movingGraph && (!hasCursor || options.retainedBasis) && (request.method === 'GET' || options.readOnlyTemplate)
        && url.pathname.startsWith('/v1/') ? WORK_READ_COST.attempts : 1;
      for (let attempt = 0; ; attempt++) {
        assertFusekiReadActive();
        const callsBefore = budget.callsLeft, bytesBefore = budget.bytesLeft;
        budget.attempt = attempt + 1;
        try {
          return await withTelemetrySpan('main.work_read.attempt', async () => {
            budget.readPhase = 'position';
            const located = await position(deps, options.localBasis
              || searchGraphSnapshot.getStore()?.graphBasis === 'selected-units', url.searchParams.get('sort') === 'new');
            const session = new WorkReadSession(deps, request, options,
              { dataEpoch: located.dataEpoch, sequence: located.sequence }, false, attempt + 1);
            session.restorePriors = located.priors;
            budget.readPhase = 'admission';
            session.checkDeadline();
            if (request.headers.has('authorization')) {
              if (!options.actingSubject) throw new WorkReadInvalid('actingSubject is required for authenticated reads');
              // The rate-limit admission covers this attempt only. A retry verifies
              // again, and each attempt rechecks that the principal remains active.
              session.principal = await verifyRequestAccount(deps.account, request, ['work:read']);
              session.checkDeadline();
              if (!await deps.access.activePrincipalId(session.principal)) throw new AccountAssertionDenied('Principal is inactive');
              if (deps.personPreferences) {
                session.checkDeadline();
                session.readingLanguages = await deps.personPreferences.languagesForReader(session.principal);
              }
            } else if (options.actingSubject) throw new AccountAssertionDenied('Authentication is required');
            return activeReadSession.run(session, () => withDisclosureViewer(session.viewer, async () => {
              let result: T;
              const graphFence = new GraphReadFence(deps.environment.fuseki);
              let closingVersion: string | undefined;
              // Every completed attempt closes its authority check, including a
              // failed consistency fence; retries cannot defer revocation.
              try {
                budget.readPhase = 'read';
                session.checkDeadline();
                result = located.graphVersion && !options.movingGraph
                  ? await graphFence.capture(() => operation(session)) : await operation(session);
                budget.readPhase = 'closing-position';
                const after = await position(deps, true);
                if (after.dataEpoch !== session.position.dataEpoch
                  || options.movingGraph && after.sequence !== session.position.sequence) {
                  if (options.movingGraph && after.dataEpoch === session.position.dataEpoch) {
                    session.stale = true;
                  } else {
                    throw new WorkReadMoved('Graph changed during the read');
                  }
                }
                budget.readPhase = 'dependency-fence';
                if (located.graphVersion && after.graphVersion === located.graphVersion && !options.movingGraph) {
                  // Graph inputs can be retained; every SQL owner check stays live.
                  await graphFence.verify(() => session.fenceDependencies());
                  closingVersion = after.graphVersion;
                } else await session.fenceDependencies();
              } finally {
                if (!signal.aborted) budget.readPhase = 'authority-fence';
                await session.fenceAuthority();
              }
              if (graphFence.reused) {
                budget.readPhase = 'closing-fence';
                session.checkDeadline();
                // Close after authority too: an owner callback may commit graph inputs.
                const closed = await position(deps, true);
                if (closed.dataEpoch !== session.position.dataEpoch || closed.graphVersion !== closingVersion) {
                  // Unrelated writes need no quiet dataset: replay only selected inputs.
                  try { await session.fenceDependencies(); }
                  finally { await session.fenceAuthority(); }
                }
              }
              session.checkDeadline();
              return complete ? complete(result, session) : result;
            }));
          });
        } catch (error) {
          assertFusekiReadActive();
          if (!(error instanceof WorkReadMoved || error instanceof SearchSnapshotMoved)
            || error instanceof WorkReadExpired || attempts === 1) throw error;
          const callsUsed = callsBefore - budget.callsLeft, bytesUsed = bytesBefore - budget.bytesLeft;
          if (attempt + 1 === attempts || budget.callsLeft < callsUsed || budget.bytesLeft < bytesUsed) {
            throw new WorkReadUnavailable('A consistent graph read could not be obtained within its budget', { cause: error });
          }
          budget.readPhase = 'retry-wait';
          await delay(Math.min(WORK_READ_COST.retryDelayMs * 2 ** attempt,
            WORK_READ_COST.maximumRetryDelayMs), undefined, { signal });
        }
      }
    });
  } catch (error) {
    if (error instanceof FusekiReadBudgetExceeded || error instanceof FusekiQueryResponseTooLarge) {
      throw new WorkReadLimit('Work read budget exceeded', { cause: error });
    }
    if (signal.aborted || error instanceof FusekiReadDeadlineExceeded) {
      throw new WorkReadUnavailable(request.signal.aborted ? 'Work read cancelled' : 'Work read deadline exceeded', {
        cause: error, phase: budget.readPhase, diagnostics: snapshotFusekiReadDiagnostics(budget),
      });
    }
    throw error;
  }
}

export function pageResult<T>(session: WorkReadSession, items: T[], nextCursor: string | null) {
  return { items, nextCursor, sourcePosition: session.position,
    count: { value: items.length, kind: 'exact-page' as const, total: null } };
}
