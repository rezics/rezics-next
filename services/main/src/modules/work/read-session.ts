import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { fusekiReadBudget, FusekiQueryResponseTooLarge, FusekiReadBudgetExceeded,
  type SparqlResult } from '../../infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
// `deps.media` is declared by module augmentation in the media routes; import it
// so programs that reach this file without the route module still see it.
import type {} from '../../routes/media.ts';
import { AccountAssertionDenied } from '../account/verify-assertion.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { readResourceSummaries, type ResourceSummary } from '../media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { DATASET, GRAPHS, RV, iri, lit } from './activate.ts';
import { WORK_READ_COST } from './read-contract.ts';
export { publicWork, unerased } from './public-patterns.ts';

export class WorkReadInvalid extends Error {}
export class WorkReadMissing extends Error {}
export class WorkReadMoved extends Error {}
export class WorkReadUnavailable extends Error {}
export class WorkReadLimit extends Error {}
export type ReadRow = NonNullable<SparqlResult['results']>['bindings'][number];
export interface ReadPosition { dataEpoch: string; sequence: string }
export interface ReadOptions { language?: string; actingSubject?: string; cursor?: string; limit?: number;
  scope?: 'global' | 'realm' | 'mine'; realm?: string }
export const READ_PREFIX = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
  PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
  PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
  PREFIX skos: <http://www.w3.org/2004/02/skos/core#>`;
// Process-local encrypted cursors intentionally expire on restart; never authorization.
const cursorKey = randomBytes(32);
interface Cursor { version: 1; binding: string; position: ReadPosition; after: string; order: string }
const bindingOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function encodeReadCursor(binding: unknown, position: ReadPosition, after: string, order = ''): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cursorKey, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ version: 1, binding: bindingOf(binding),
    position, after, order } satisfies Cursor)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}
export function decodeReadCursor(token: string | undefined, binding: unknown, position: ReadPosition): Cursor | null {
  if (!token) return null;
  let decoded: Cursor;
  try {
    if (token.length > 2048 || !/^[\w-]+$/.test(token)) throw new Error('cursor');
    const bytes = Buffer.from(token, 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', cursorKey, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    decoded = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString()) as Cursor;
    if (decoded.version !== 1 || decoded.binding !== bindingOf(binding)
      || typeof decoded.after !== 'string' || typeof decoded.order !== 'string') throw new Error('cursor');
  } catch { throw new WorkReadInvalid('Cursor is invalid or expired'); }
  if (decoded.position.dataEpoch !== position.dataEpoch || decoded.position.sequence !== position.sequence) {
    throw new WorkReadMoved('Collection changed; restart from the first page');
  }
  return decoded;
}

export class WorkReadSession {
  principal: VerifiedPrincipal | null = null;
  constructor(readonly deps: MainWorkDependencies, readonly request: Request, readonly options: ReadOptions,
    readonly position: ReadPosition) {}

  async query(body: string, limit: number): Promise<ReadRow[]> {
    this.checkDeadline();
    const rows = (await this.deps.environment.fuseki.query(`${READ_PREFIX}\n${body}`,
      WORK_READ_COST.queryBytes)).results?.bindings ?? [];
    if (rows.length > limit) throw new WorkReadLimit('Read exceeds its bounded relation');
    return rows;
  }

  async summaries(resources: string[]): Promise<ResourceSummary[]> {
    this.checkDeadline();
    if (!resources.length) return [];
    const reader = { restrictedTitles: this.deps.governance?.store
      ? (heads: readonly { work: string; revision: string }[], context: string) =>
        this.deps.governance!.store.restrictedTitles(heads, context) : undefined,
    canReadWork: this.principal && this.options.actingSubject ? (work: string) =>
      this.deps.access.canReadWork(this.principal!, this.options.actingSubject!, work) : undefined };
    const result = await readResourceSummaries(this.deps.environment, this.deps.media?.store, reader,
      { resources, context: DEFAULT_MEDIA_CONTEXT, language: this.options.language?.toLowerCase() ?? null });
    if (result.generation.graph !== `${this.position.dataEpoch}:${this.position.sequence}`) {
      throw new WorkReadMoved('Graph changed during the read');
    }
    return result.summaries;
  }

  async scope() {
    this.checkDeadline();
    const kind = this.options.scope ?? 'global';
    if ((kind === 'realm') !== !!this.options.realm) throw new WorkReadInvalid('Realm is required only for Realm scope');
    if (kind === 'mine' && !this.principal) throw new AccountAssertionDenied('Mine requires authentication');
    if (kind === 'realm') {
      const rows = await this.query(`SELECT ?realm WHERE { GRAPH ${iri(GRAPHS.current)} {
        BIND(${iri(this.options.realm!)} AS ?realm)
        ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
        ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public . } } LIMIT 2`, 1);
      if (!rows.length) throw new WorkReadMissing('Resource is unavailable');
    }
    return { kind, realm: this.options.realm ?? null };
  }

  checkDeadline(): void { fusekiReadBudget.getStore()?.signal.throwIfAborted(); }
}

async function position(deps: MainWorkDependencies): Promise<ReadPosition> {
  const env = deps.environment;
  const rows = (await env.fuseki.query(`${READ_PREFIX} SELECT ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} .
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } } } LIMIT 2`, 8192)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.epoch || !/^\d+$/.test(rows[0].sequence?.value ?? '')) {
    throw new WorkReadUnavailable('Graph is unavailable');
  }
  return { dataEpoch: rows[0].epoch.value, sequence: rows[0].sequence!.value };
}

export async function workRead<T>(deps: MainWorkDependencies, request: Request, options: ReadOptions,
  operation: (session: WorkReadSession) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(WORK_READ_COST.deadlineMs);
  try {
    return await fusekiReadBudget.run({ signal, callsLeft: WORK_READ_COST.graphCalls,
      bytesLeft: WORK_READ_COST.graphBytes }, async () => {
      const session = new WorkReadSession(deps, request, options, await position(deps));
      if (request.headers.has('authorization')) {
        if (!options.actingSubject) throw new WorkReadInvalid('actingSubject is required for authenticated reads');
        session.principal = await deps.account.verify(request, ['work:read']);
        if (!await deps.access.activePrincipalId(session.principal)) throw new AccountAssertionDenied('Principal is inactive');
      } else if (options.actingSubject) throw new AccountAssertionDenied('Authentication is required');
      const result = await operation(session);
      const after = await position(deps);
      if (after.dataEpoch !== session.position.dataEpoch || after.sequence !== session.position.sequence) {
        throw new WorkReadMoved('Graph changed during the read');
      }
      if (session.principal && !await deps.access.activePrincipalId(session.principal)) {
        throw new AccountAssertionDenied('Principal is inactive');
      }
      signal.throwIfAborted();
      return result;
    });
  } catch (error) {
    if (error instanceof FusekiReadBudgetExceeded || error instanceof FusekiQueryResponseTooLarge) {
      throw new WorkReadLimit('Work read budget exceeded');
    }
    if (signal.aborted) throw new WorkReadUnavailable('Work read deadline exceeded');
    throw error;
  }
}

export function pageResult<T>(session: WorkReadSession, items: T[], nextCursor: string | null) {
  return { items, nextCursor, sourcePosition: session.position,
    count: { value: items.length, kind: 'exact-page' as const, total: null } };
}
