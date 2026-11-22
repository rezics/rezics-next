import { MAX_PAGE_READS } from '@rezics/composition';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { releaseDigest, type Release } from '@rezics/definitions';
import { facetProperties } from '@rezics/filter';
import type { Source } from '@rezics/definitions/bulk';
import type { Pool, PoolClient } from 'pg';
import { prepareReadDecisions } from '../request/access.ts';
import type { AccessCheck } from '../access/index.ts';
import { mintReadTime, type AuthoritativeTime, type CommandTransaction } from '../command/command.ts';
import {
  discardConnection,
  isPostgresTransactionAbort,
  withBoundedCommandConnection,
  withBoundedReadConnection,
  withBoundedReadOnlyTransaction,
  withConnection,
} from '../database/pool.ts';
import {
  AccessUnavailableError,
  classifyUnavailability,
  requireAccessDeadline,
  throwAccessUnavailable,
} from '../access/unavailable.ts';
import { subjectReadEligibility } from './eligibility.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import { readFences, type SourceFenceTuple } from '../content/index.ts';
import { sourceTuple } from './fences.ts';
import { GLOBAL_SUBJECT_CONTEXT as GLOBAL_CONTEXT } from './contract/subject-values.ts';
import { factDataTypes, resolveItem, type FactRow, type Statement } from './item.ts';
import { indexedStatement } from './scope-leaf-selection.ts';
import {
  hasVerifiedReleaseDigest,
  readBaseReleases,
  readRelease,
  verifiedBaseReleaseBody,
} from './definition-release-read.ts';
import { nativeSourceQuery } from '../database/native-source-query.ts';
import { hasPublicFilterMeaningShape } from './public-filter-source-contract.ts';
import type {
  PrivacyReductionHead,
  PublicFilterCost,
  PublicFilterDependency,
  PublicFilterProjectionFrontier,
  PublicFilterProjectionMeaning,
  PublicFilterProjectionObservation,
  PublicFilterProjectionPage,
  PublicFilterProjectionRecord,
  PublicFilterProjectionRequest,
  PublicFilterProjectionRetirement,
  PublicFilterSubjectIdentities,
  PublicFilterSubjectIdentityRequest,
  PublicFilterSourceFactory,
} from './public-filter-source-contract.ts';
import type { PublicFilterAccessBindingPort } from './source-binding-port.ts';
import readIdentityFloors from './public-filter-identity-floors.sql';
import readInstalledIdentityFloors from './public-filter-installed-identity-floors.sql';
import readIdentityPointsQuery from './public-filter-identity-points.sql';
import readSubjects from './search-source-subjects.sql';
import readPrivacyHead from './public-filter-projection-head-read.sql';
import readBuild from './public-filter-projection-build-read.sql';
import startBuild from './public-filter-projection-build-start.sql';
import {
  advanceProjectionCleanupSql,
  checkProjectionCleanupSql,
  prepareProjectionBuildSql,
  readCurrentProjectionHeadPageSql,
  retainCurrentProjectionHeadsSql,
  startProjectionWithHeadsSql,
} from './public-filter-projection-build-write.ts';
import readPage from './public-filter-projection-page.sql';
import readProjectionRoot from './public-filter-projection-root.sql';
import readRetainedHeadPage from './public-filter-projection-head-page.sql';
import readCurrentRetainedHead from './public-filter-projection-head-current.sql';
import upsertRetainedHeads from './public-filter-projection-head-upsert.sql';
import { identitySourceSupportJob, identitySourceSupportRoot } from './identity-source-support-scope.ts';
import {
  invalidateProjectionBuildSql,
  lockProjectionBuildForHeadsSql,
  lockProjectionBuildForRetirementSql,
  retiredProjectionMeaning,
  retireProjectionHeadSql,
  verifyCompletedPublicFilterProjectionSql,
} from './public-filter-projection-build-control.ts';
import readOriginalPage from './public-filter-projection-replay-read.sql';
import readReplayHead from './public-filter-projection-replay-head.sql';
import writeOriginalPage from './public-filter-projection-replay-write.sql';

type Configuration = Parameters<PublicFilterSourceFactory>[0];
type SubjectRow = {
  route: number;
  id: string;
  type: string;
  visibility: string;
  securityRevision: string;
  currentRelease: string | null;
  redirect: string | null;
  selection_ready: boolean;
  current_revision: number | null;
};
type SelectedRow = {
  route: number;
  subject_id: string;
  slot_id: string;
  candidate_id: string;
  property: string;
  rank: 'normal' | 'preferred';
  ordinal: number;
  revision: number;
  body: unknown;
  release: string;
  source: unknown;
  compact: boolean;
  consent_account: string | null;
  eligible: boolean | null;
};
type BuildRow = {
  build_id: string;
  generation: string;
  route: number;
  owner_epoch: number;
  source_position: string;
  privacy_position: string;
  terminal_id: string;
  subject_revision: number;
  security_revision: string;
  current_release: string;
};
type ProjectionCleanup = { build: string; generation: bigint; successor: string; step: number; inputLimit: number };
type CleanupCursor = {
  phase: 'cleanup';
  subject: string;
  meaning: string;
  previous: string;
  step: number;
  inputLimit: number;
};
type PageCursor =
  | CleanupCursor
  | { phase: 'selection'; property: string; slot: string; candidate: string }
  | { phase: 'dependencies'; partition: number };
type CursorResult = PageCursor | null | false;
type OrdinaryWrite = (BuildRow & { charged?: number }) | CleanupResult | ReclaimedBuild | 'identity_pending' | null;
type MutableCost = { -readonly [K in keyof PublicFilterCost]: PublicFilterCost[K] };
type StoredHead = { partition_no: number; owner_epoch: number; position: string };
export type PublicFilterProjectionReplayIdentity = Readonly<{
  bootstrap: string;
  execution: string;
  predecessor: string | null;
}>;

/** Original producer request, without the caller's transient deadline. */
export type RetainedPublicFilterProjectionRequest = Readonly<{
  identity: PublicFilterProjectionReplayIdentity;
  subject: string;
  meaning: Pick<PublicFilterProjectionMeaning, 'digest'>;
  inputLimit: number;
  frontier: PublicFilterProjectionFrontier | null;
}>;

function originalProjectionRequestDigest(request: RetainedPublicFilterProjectionRequest): string {
  return replayDigest(
    encodeReplayValue({
      identity: {
        bootstrap: request.identity.bootstrap,
        execution: request.identity.execution,
        predecessor: request.identity.predecessor,
      },
      subject: request.subject,
      meaning: { digest: request.meaning.digest },
      inputLimit: request.inputLimit,
      frontier: request.frontier,
    }),
  );
}

/** Read an original page only. A missing page never falls back to current projection.
 * The Source verifier separately validates the bootstrap, execution and producer step.
 */
export async function readRetainedPublicFilterProjectionPage(
  pool: Pool,
  input: RetainedPublicFilterProjectionRequest,
  context: Readonly<{ deadline: number }>,
): Promise<PublicFilterProjectionPage | null> {
  const deadline = context.deadline;
  const request = structuredClone(input);
  requireAccessDeadline(deadline);
  const routed = routePartition(request.subject);
  if (
    !routed ||
    !validRetainedMeaning(request.meaning) ||
    !UUID.test(request.identity.bootstrap) ||
    !request.identity.execution ||
    request.identity.execution.length > 4096 ||
    (request.identity.predecessor !== null && !UUID.test(request.identity.predecessor)) ||
    !Number.isInteger(request.inputLimit) ||
    request.inputLimit < 1 ||
    request.inputLimit > 1000
  )
    throw new TypeError('Invalid original projection page locator');
  const stored = await withBoundedReadConnection(
    pool,
    deadline,
    (client) =>
      nativeSourceQuery(client, readOriginalPage, {
        partition_no: 0,
        bootstrap: request.identity.bootstrap,
        execution: request.identity.execution,
        predecessor: request.identity.predecessor ?? '',
        route: routed.route,
        subject_id: request.subject,
        request_digest: originalProjectionRequestDigest(request),
      }),
    boundedProjectionReadOptions(deadline),
  );
  requireAccessDeadline(deadline);
  if (!stored) return null;
  if (replayDigest(stored.page_data) !== stored.page_digest)
    throw new Error('Retained projection page digest mismatch');
  const page = decodeReplayValue<PublicFilterProjectionPage>(stored.page_data);
  if (
    (page.status !== 'complete' && page.status !== 'progress') ||
    page.source.subject !== request.subject ||
    page.source.partition !== routed.partition
  )
    throw new Error('Retained projection page identity mismatch');
  return page;
}

/** Validate the retained build's actual dependency heads without producing a new page.
 * The caller has already resolved the exact original page and separately verifies
 * its native original/terminal command fences. Every query uses the caller's meter.
 */
export async function retainedPublicFilterProjectionDependenciesCurrent(
  pool: Pool,
  request: Readonly<{
    page: Extract<PublicFilterProjectionPage, { status: 'progress' | 'complete' }>;
    meaning: Pick<PublicFilterProjectionMeaning, 'digest'>;
  }>,
  context: Readonly<{ deadline: number }>,
): Promise<boolean> {
  const { page, meaning } = structuredClone(request);
  const deadline = context.deadline;
  requireAccessDeadline(deadline);
  const routed = routePartition(page.source.subject);
  if (!routed || !validRetainedMeaning(meaning)) return false;
  const terminal = routePartition(page.source.terminal);
  if (!terminal) return false;
  const homes = new Set([routed.partition, terminal.partition]);
  const dependencies = [
    ...page.repairLocators.flatMap((locator) => locator.dependencies),
    ...page.records.flatMap((record) => record.dependencies),
  ];
  for (const dependency of dependencies) {
    // A Semantic privacy head cannot stand in for an original Account tuple.
    if (dependency.kind === 'consent') return false;
    const route = dependency.kind === 'sourceTuple' ? dependency.tuple.route : dependency.route;
    if (!Number.isInteger(route) || route < 0 || route > 65535) return false;
    homes.add(partitionOf(route));
  }
  return inSnapshot(pool, deadline, async (client) => {
    if (page.status === 'complete') {
      // The original page digest binds these heads. A different consumer may
      // replace the mutable build while this execution waits to verify its page.
      const heads = new Set(page.requiredHeads.map(({ partition }) => partition));
      if (heads.size !== page.requiredHeads.length || [...homes].some((partition) => !heads.has(partition)))
        return false;
      for (const { partition, epoch, position } of page.requiredHeads) {
        requireAccessDeadline(deadline);
        const current = await nativeSourceQuery(client, readCurrentRetainedHead, { partition_no: partition });
        if (
          !current ||
          current.write_state !== 'active' ||
          current.epoch !== epoch ||
          BigInt(current.position) !== position
        )
          return false;
      }
      return true;
    }
    const build = rows(
      await nativeSourceQuery(client, readBuild, {
        partition_no: routed.partition,
        route: routed.route,
        subject_id: page.source.subject,
        meaning_digest: meaning.digest,
      }),
    )[0];
    if (
      !build ||
      build.build_id !== page.frontier.build ||
      BigInt(build.generation) !== page.frontier.generation ||
      build.owner_epoch !== page.source.epoch ||
      BigInt(build.source_position) !== page.source.position ||
      build.terminal_id !== page.source.terminal ||
      build.subject_revision !== page.source.revision ||
      build.security_revision !== page.source.securityRevision ||
      build.current_release !== page.source.currentRelease
    ) {
      if (page.records.length || page.repairLocators.length) return false;
      return (await readCurrentProjectionCleanupOn(client, page, meaning.digest)) ?? false;
    }
    // These are the original build's keyed retained heads, not a current catalogue
    // enumeration or a newly captured replacement for the original Source page.
    for (const partition of homes) {
      requireAccessDeadline(deadline);
      const head = await nativeSourceQuery(client, readReplayHead, {
        build_id: page.frontier.build,
        partition_no: partition,
      });
      if (
        !head ||
        head.write_state !== 'active' ||
        head.epoch !== head.owner_epoch ||
        head.position !== head.current_position
      )
        return false;
    }
    requireAccessDeadline(deadline);
    return true;
  });
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const rows = <T>(value: T | T[] | null): T[] => (value === null ? [] : Array.isArray(value) ? value : [value]);
function encodeReplayValue(value: unknown): string {
  function pack(entry: unknown): unknown {
    if (entry === undefined) return ['undefined'];
    if (typeof entry === 'bigint') return ['bigint', String(entry)];
    if (Array.isArray(entry)) return ['array', entry.map(pack)];
    if (entry !== null && typeof entry === 'object')
      return [
        'object',
        Object.keys(entry)
          .sort()
          .map((key) => [key, pack((entry as Record<string, unknown>)[key])]),
      ];
    if (typeof entry === 'number' && !Number.isFinite(entry)) throw new TypeError('Finite projection data required');
    if (typeof entry === 'function' || typeof entry === 'symbol') throw new TypeError('Projection data required');
    return ['value', entry];
  }
  const encoded = JSON.stringify(pack(value));
  if (encoded === undefined) throw new TypeError('Projection data could not be retained');
  return encoded;
}

function decodeReplayValue<T>(encoded: string): T {
  function unpack(entry: any): unknown {
    if (entry[0] === 'undefined') return undefined;
    if (entry[0] === 'bigint') return BigInt(entry[1]);
    if (entry[0] === 'array') return entry[1].map(unpack);
    if (entry[0] === 'object')
      return Object.fromEntries(entry[1].map(([key, child]: [string, unknown]) => [key, unpack(child)]));
    if (entry[0] === 'value') return entry[1];
    throw new TypeError('Invalid retained projection page');
  }
  return unpack(JSON.parse(encoded)) as T;
}

function replayDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
const emptyCost = (): PublicFilterCost => ({
  inputKeys: 0,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
});
const unready = (
  reason: 'owner_pending' | 'identity_pending' | 'dependency_pending' | 'metadata_missing',
  cost = emptyCost(),
): Extract<PublicFilterProjectionPage, { status: 'unready' }> => ({ status: 'unready', reason, cost });
const unavailable = (
  reason: 'missing_owner' | 'moved' | 'deadline' | 'dependency_unavailable',
  cost = emptyCost(),
): Extract<PublicFilterProjectionPage, { status: 'unavailable' }> => ({ status: 'unavailable', reason, cost });

function validRetainedMeaning(meaning: unknown): boolean {
  return (
    typeof meaning === 'object' &&
    meaning !== null &&
    !Array.isArray(meaning) &&
    Reflect.ownKeys(meaning).length === 1 &&
    'digest' in meaning &&
    typeof meaning.digest === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(meaning.digest)
  );
}

function validMeaning(meaning: PublicFilterProjectionMeaning): boolean {
  return (
    hasPublicFilterMeaningShape(meaning) &&
    typeof meaning.digest === 'string' &&
    (hasVerifiedReleaseDigest(meaning.release, meaning.digest) || releaseDigest(meaning.release) === meaning.digest) &&
    Object.keys(meaning.release.types).length > 0
  );
}

function cursorToken(routeKey: Uint8Array, build: string, generation: bigint, cursor: PageCursor | null): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  const signature = createHmac('sha256', routeKey).update(`${build}:${generation}:${payload}`).digest('base64url');
  return `${payload}.${signature}`;
}

function readCursor(routeKey: Uint8Array, frontier: PublicFilterProjectionFrontier): CursorResult {
  if (!UUID.test(frontier.build) || frontier.generation < 1n || typeof frontier.continuation !== 'string') return false;
  const [payload, signature, extra] = frontier.continuation.split('.');
  if (!payload || !signature || extra !== undefined) return false;
  const expected = createHmac('sha256', routeKey)
    .update(`${frontier.build}:${frontier.generation}:${payload}`)
    .digest('base64url');
  if (signature.length !== expected.length || !Buffer.from(signature).equals(Buffer.from(expected))) return false;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    if (value === null) return null;
    if (!object(value)) return false;
    if (value.phase === 'cleanup') {
      const { subject, meaning, previous, step, inputLimit } = value;
      if (
        typeof subject !== 'string' ||
        !UUID.test(subject) ||
        typeof meaning !== 'string' ||
        typeof previous !== 'string' ||
        !UUID.test(previous) ||
        typeof step !== 'number' ||
        !Number.isSafeInteger(step) ||
        step < 0 ||
        typeof inputLimit !== 'number' ||
        !Number.isInteger(inputLimit) ||
        inputLimit < 1 ||
        inputLimit > 1000 ||
        frontier.generation < 2n
      )
        return false;
      return { phase: 'cleanup', subject, meaning, previous, step, inputLimit };
    }
    if (
      value.phase === 'dependencies' &&
      typeof value.partition === 'number' &&
      Number.isInteger(value.partition) &&
      value.partition >= -1 &&
      value.partition <= 4095
    )
      return { phase: 'dependencies', partition: value.partition };
    if (
      value.phase === 'selection' &&
      typeof value.property === 'string' &&
      value.property.length >= 1 &&
      value.property.length <= 256 &&
      typeof value.slot === 'string' &&
      UUID.test(value.slot) &&
      typeof value.candidate === 'string' &&
      UUID.test(value.candidate)
    )
      return { phase: 'selection', property: value.property, slot: value.slot, candidate: value.candidate };
    return false;
  } catch {
    return false;
  }
}

function isSettledServerError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const details = error as { code?: unknown; severity?: unknown };
  return typeof details.code === 'string' && /^[0-9A-Z]{5}$/.test(details.code) && details.severity === 'ERROR';
}

function boundedProjectionReadOptions(deadline: number) {
  return {
    deadlineError: () => new AccessUnavailableError('deadline'),
    mapError(error: unknown): unknown {
      try {
        // The physical read race owns deadline selection; keep a settled failure's cause.
        throwAccessUnavailable(error);
      } catch (mapped) {
        return mapped;
      }
      return error;
    },
    isUncertainError: (error: unknown) => classifyUnavailability(error) !== undefined,
    isUncertainSettledQueryError: (error: unknown) => !isSettledServerError(error),
  };
}

function configureIndexedSnapshot(client: PoolClient, timeout: string) {
  return client.query({
    name: 'semantic_indexed_projection_timeout_v1',
    text: "SELECT set_config('statement_timeout',$1,true), set_config('enable_seqscan','off',true)",
    values: [timeout],
  });
}

async function inSnapshot<T>(
  pool: Pool,
  deadline: number,
  work: (client: PoolClient) => Promise<T>,
  indexed = false,
): Promise<T> {
  return withBoundedReadOnlyTransaction(
    pool,
    deadline,
    async (client) => {
      requireAccessDeadline(deadline);
      const timeout = `${Math.max(1, Math.floor(deadline - Date.now()))}ms`;
      if (indexed) {
        await configureIndexedSnapshot(client, timeout);
      } else {
        await client.query(`SET LOCAL statement_timeout = '${timeout}'`);
      }
      return work(client);
    },
    boundedProjectionReadOptions(deadline),
  );
}

async function storedMeaningRelease(client: PoolClient, digest: string): Promise<Release | null> {
  const owner = await readPartition(client, 0);
  if (!owner || owner.writeState !== 'active') return null;
  const found = await readBaseReleases(client, [digest]);
  // Binding also accepts persisted composite digests through the release owner.
  return found.has(digest) ? (found.get(digest) ?? null) : readRelease(client, digest);
}

function sourceObservation(
  partition: number,
  ownerEpoch: number,
  position: bigint,
  subject: SubjectRow,
  terminal: string,
): PublicFilterProjectionObservation {
  return {
    partition,
    epoch: ownerEpoch,
    position,
    subject: subject.id,
    terminal,
    revision: subject.current_revision!,
    securityRevision: subject.securityRevision,
    currentRelease: subject.currentRelease!,
  };
}

function sameSource(left: SubjectRow, right: SubjectRow | undefined): boolean {
  return (
    !!right &&
    left.id === right.id &&
    left.route === right.route &&
    left.type === right.type &&
    left.visibility === right.visibility &&
    left.securityRevision === right.securityRevision &&
    left.currentRelease === right.currentRelease &&
    left.redirect === right.redirect &&
    left.current_revision === right.current_revision &&
    left.selection_ready === right.selection_ready
  );
}

function routePartition(id: string): { route: number; partition: number } | null {
  const route = routeOf(id);
  return route === null ? null : { route, partition: partitionOf(route) };
}

function sourceDependency(route: number, subject: string): PublicFilterDependency {
  return { kind: 'subject', route, subject };
}

function statementIds(row: SelectedRow, release: Release): { ids: string[]; complete: boolean } {
  if (!object(row.body)) return { ids: [], complete: false };
  const ids: string[] = [];
  const add = (datatype: unknown, raw: unknown) => {
    if (datatype !== 'wikibase-item') return;
    if (!object(raw) || raw.type !== 'value' || typeof raw.content !== 'string') return;
    ids.push(raw.content);
  };
  const property = release.properties[row.property];
  if (!property) return { ids, complete: false };
  add(property.datatype, row.body.value);
  if (Array.isArray(row.body.qualifiers)) {
    for (const qualifier of row.body.qualifiers) {
      if (!object(qualifier) || typeof qualifier.property !== 'string' || !object(qualifier.value))
        return { ids, complete: false };
      const definition = release.properties[qualifier.property];
      if (!definition) return { ids, complete: false };
      add(definition.datatype, qualifier.value);
    }
  } else if (row.body.qualifiers !== undefined) return { ids, complete: false };
  if (Array.isArray(row.body.references)) {
    for (const reference of row.body.references) {
      if (!object(reference) || !Array.isArray(reference.parts)) return { ids, complete: false };
      for (const part of reference.parts) {
        if (!object(part) || typeof part.property !== 'string' || !object(part.value)) return { ids, complete: false };
        const definition = release.properties[part.property];
        if (!definition) return { ids, complete: false };
        add(definition.datatype, part.value);
      }
    }
  } else if (row.body.references !== undefined) return { ids, complete: false };
  return { ids, complete: true };
}

function losslessIndex(row: SelectedRow, release: Release): boolean {
  if (!object(row.body) || !Array.isArray(row.body.qualifiers ?? [])) return false;
  for (const qualifier of (row.body.qualifiers ?? []) as unknown[]) {
    if (
      !object(qualifier) ||
      typeof qualifier.property !== 'string' ||
      !object(qualifier.value) ||
      qualifier.value.type !== 'value' ||
      typeof qualifier.value.content !== 'string'
    )
      return false;
    const datatype = release.properties[qualifier.property]?.datatype;
    if (datatype !== 'wikibase-item' && datatype !== 'string') return false;
  }
  return true;
}

function buildStatement(row: SelectedRow, release: Release, subjectType: string): Statement | null {
  const body = object(row.body) ? { ...row.body, rank: row.rank } : row.body;
  const fact: FactRow = {
    kind: 'statement',
    language: null,
    property: row.property,
    statement_id: row.candidate_id,
    operation: 'assert',
    body,
    fact_revision: row.revision,
    fact_release: row.release,
  };
  const types = factDataTypes(release, [fact]);
  if (!types[row.property]) return null;
  const resolved = resolveItem(row.subject_id, [fact], subjectType, types, {
    revision: row.revision,
    release: row.release,
    context: GLOBAL_CONTEXT,
  });
  return resolved.statements[row.property]?.[0] ?? null;
}

function validSource(value: unknown): value is Source | null {
  if (value === null) return true;
  return object(value) && typeof value.source === 'string' && typeof value.external_id === 'string';
}

type IdentityState = { row: SubjectRow; allowed: boolean };
type IdentityRead = {
  states: Map<string, IdentityState>;
  heads: Map<number, PrivacyReductionHead>;
  complete: boolean;
};

/** Each identity home is checked independently; the public decision uses one native T for the whole page. */
async function readPublicIdentities(
  config: Configuration,
  accessPort: PublicFilterAccessBindingPort,
  ids: readonly string[],
  time: AuthoritativeTime,
  deadline: number,
  cost: MutableCost,
  root?: Readonly<{ state: IdentityState; head: PrivacyReductionHead }>,
  inputLimit?: number,
): Promise<IdentityRead> {
  const states = new Map<string, IdentityState>();
  const heads = new Map<number, PrivacyReductionHead>();
  let complete = true;
  let pending = [...new Set(ids)];
  if (root) {
    const { state, head } = root;
    states.set(state.row.id, state);
    heads.set(head.partition, head);
    if (state.row.redirect && !pending.includes(state.row.redirect)) pending.push(state.row.redirect);
  }
  for (let depth = 0; pending.length > 0 && depth < 8; depth++) {
    const groups = new Map<number, { id: string; route: number }[]>();
    for (const id of pending) {
      if (states.has(id)) continue;
      const routed = routePartition(id);
      if (!routed) {
        complete = false;
        continue;
      }
      const group = groups.get(routed.partition) ?? [];
      group.push({ id, route: routed.route });
      groups.set(routed.partition, group);
    }
    pending = [];
    for (const [partition, group] of groups) {
      if (inputLimit !== undefined) {
        if (cost.inputKeys + group.length > inputLimit) return { states, heads, complete: false };
        cost.inputKeys += group.length;
      }
      accessPort.requireDeadline(deadline);
      const checks = new Map<string, AccessCheck>();
      for (const item of group) {
        checks.set(
          item.id,
          await accessPort.checkSubjectRead(
            config.access,
            { kind: 'anonymous' },
            'subject:read',
            { route: item.route, id: item.id, eligibility: subjectReadEligibility({ route: item.route, id: item.id }) },
            { pool: config.pool, deadline },
          ),
        );
        cost.accessPoints++;
      }
      const result = await inSnapshot(config.pool, deadline, async (client) => {
        const owner = await readPartition(client, partition);
        if (!owner || owner.writeState === 'moved' || owner.writeState !== 'active') return null;
        const privacy = await nativeSourceQuery(client, readPrivacyHead, { partition_no: partition });
        if (!privacy) return null;
        const found = rows(
          await nativeSourceQuery(client, readSubjects, {
            partition_no: partition,
            routes: group.map(({ route }) => route),
            subject_ids: group.map(({ id }) => id),
          }),
        ) as SubjectRow[];
        const byId = new Map(found.map((row) => [row.id, row]));
        const allowed = new Map<string, boolean>();
        for (const item of group) {
          const row = byId.get(item.id);
          if (!row) {
            allowed.set(item.id, false);
            continue;
          }
          allowed.set(item.id, await checks.get(item.id)!(client, time));
        }
        return { owner, privacy, byId, allowed };
      });
      cost.dependencyPoints += group.length;
      if (!result) {
        complete = false;
        continue;
      }
      const currentHead = { partition, epoch: result.owner.epoch, position: BigInt(result.privacy.position) };
      const priorHead = heads.get(partition);
      if (priorHead && (priorHead.epoch !== currentHead.epoch || priorHead.position !== currentHead.position)) {
        complete = false;
        continue;
      }
      heads.set(partition, currentHead);
      for (const item of group) {
        const row = result.byId.get(item.id);
        if (!row) {
          complete = false;
          continue;
        }
        const allowed = result.allowed.get(item.id) === true;
        states.set(item.id, { row, allowed });
        if (allowed && row.visibility === 'visible' && row.redirect) pending.push(row.redirect);
      }
    }
  }
  if (pending.some((id) => !states.has(id))) complete = false;
  return { states, heads, complete };
}

function identityWindow(ids: readonly string[], inputLimit: number) {
  const observed: Pick<IdentityRead, 'states' | 'heads' | 'complete'> = {
    states: new Map(),
    heads: new Map(),
    complete: true,
  };
  return { pending: new Set(ids), observed, cost: { ...emptyCost() }, inputLimit, spent: 0 };
}
type IdentityWindow = ReturnType<typeof identityWindow>;
type IdentityPoint = SubjectRow & { epoch: number; privacy_position: string };
type IdentityFloor = { id: string; visible: boolean; revision: string };

async function startIdentityWindow(
  config: Configuration,
  meaning: PublicFilterProjectionMeaning,
  deadline: number,
  keys?: { id: string; route: number }[],
) {
  return inSnapshot(config.pool, deadline, async (client) => {
    if (keys) {
      // Access prepares only after releasing the snapshot of the base release,
      // its owner, the charged first visibility floors and the native read time.
      await client.query('SET LOCAL enable_seqscan = off');
      const points = await nativeSourceQuery(client, readInstalledIdentityFloors, {
        digest: meaning.digest,
        routes: keys.map(({ route }) => route),
        ids: keys.map(({ id }) => id),
      });
      if (points.length) {
        const floors = points.flatMap((row): IdentityFloor[] =>
          row.id !== null && row.visible !== null && row.revision !== null
            ? [{ id: row.id, visible: row.visible, revision: row.revision }]
            : [],
        );
        return { time: await mintReadTime(client, config.clock, config.pool), floors };
      }
    }
    return (await storedMeaningRelease(client, meaning.digest))
      ? { time: await mintReadTime(client, config.clock, config.pool), floors: undefined }
      : null;
  });
}

/** Prepare before checkout, then verify the exact visibility revision and evaluate native Access at T
 * on the same snapshot as the owner, privacy head, redirect and selection evidence. */
async function readIdentityPoints(
  config: Configuration,
  keys: { id: string; route: number }[],
  time: AuthoritativeTime,
  deadline: number,
  initialFloors?: readonly IdentityFloor[],
  retain?: (client: PoolClient, points: Map<string, { row: IdentityPoint; allowed: boolean }>) => Promise<boolean>,
) {
  const context = { pool: config.pool, deadline };
  const actor = { kind: 'anonymous' } as const;
  const input = { ids: keys.map(({ id }) => id), routes: keys.map(({ route }) => route) };
  // Small catalogues can otherwise scan every Subject once per supplied key.
  const floors =
    initialFloors ??
    (await inSnapshot(
      config.pool,
      deadline,
      async (client) => {
        return nativeSourceQuery(client, readIdentityFloors, input);
      },
      true,
    ));
  const prepared = new Map(floors.map((row) => [row.id, row]));
  const decisions = await prepareReadDecisions(config.access, {
    actor,
    actions: new Set(['subject:read']),
    context,
    time,
  });
  const decide = async (client: PoolClient) => {
    const points = (await nativeSourceQuery(client, readIdentityPointsQuery, input)) as IdentityPoint[];
    const result = new Map<string, { row: IdentityPoint; allowed: boolean }>();
    const eligible = new Map<string, IdentityPoint>();
    for (const row of points) {
      const floor = prepared.get(row.id);
      if (!floor) continue;
      if (floor.visible && row.visibility === 'visible' && floor.revision === row.securityRevision)
        eligible.set(row.id, row);
      else result.set(row.id, { row, allowed: false });
    }
    if (eligible.size) {
      const decided = await decisions.decide(
        client,
        {
          action: 'subject:read',
          resourceType: 'semantic.subject',
          ids: [...eligible.keys()],
          eligibility: async (_client, ids) => Object.fromEntries(ids.map((id) => [id, eligible.has(id)])),
        },
        time,
      );
      for (const [id, row] of eligible) {
        const allowed = decided[id]?.allowed;
        if (typeof allowed === 'boolean') result.set(id, { row, allowed });
      }
    }
    return result;
  };
  if (!retain) return inSnapshot(config.pool, deadline, decide, true);
  // No foreign work runs inside this checkout. A complete local observation can
  // retain its own heads on the same snapshot as its native Access decision.
  return withBoundedCommandConnection(
    config.pool,
    deadline,
    async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await configureIndexedSnapshot(client, `${Math.max(1, Math.floor(deadline - Date.now()))}ms`);
      const result = await decide(client);
      const matched = await retain(client, result);
      await client.query(matched ? 'COMMIT' : 'ROLLBACK');
      return result;
    },
    { deadlineError: () => new AccessUnavailableError('deadline') },
  );
}

/** Admit each logical window independently. Shared exact points are charged once and every
 * requester spends its full redirect allowance before entering the next depth. */
async function readIdentityWindows(
  config: Configuration,
  port: PublicFilterAccessBindingPort,
  windows: IdentityWindow[],
  meaning: PublicFilterProjectionMeaning,
  deadline: number,
  time?: AuthoritativeTime,
  firstFloors?: readonly IdentityFloor[],
  retain?: (client: PoolClient, observation: IdentityRead) => Promise<boolean>,
) {
  if (!time && !hasVerifiedReleaseDigest(meaning.release, meaning.digest)) {
    const initial = await startIdentityWindow(config, meaning, deadline);
    if (!initial) return false;
    time = initial.time;
  }
  for (let depth = 0; depth < 8; depth++) {
    const owners = new Map<string, IdentityWindow[]>();
    for (const window of windows) {
      const ids = [...window.pending].filter((id) => !window.observed.states.has(id));
      window.pending.clear();
      if (window.spent + ids.length > window.inputLimit) {
        window.observed.complete = false;
        continue;
      }
      window.spent += ids.length;
      for (const id of ids) {
        if (!routePartition(id)) {
          window.observed.complete = false;
          continue;
        }
        const members = owners.get(id);
        if (members) members.push(window);
        else owners.set(id, [window]);
      }
    }
    if (!owners.size) break;
    const ids = [...owners.keys()];
    for (let offset = 0; offset < ids.length; offset += 200) {
      port.requireDeadline(deadline);
      const keys = ids.slice(offset, offset + 200).map((id) => ({ id, route: routeOf(id)! }));
      for (const [i, { id }] of keys.entries()) {
        const members = owners.get(id)!;
        const payer = members[(offset + i) % members.length]!;
        payer.cost.inputKeys++;
        payer.cost.accessPoints++;
        payer.cost.dependencyPoints++;
      }
      let initialFloors = depth === 0 ? firstFloors : undefined;
      if (!time) {
        const initial = await startIdentityWindow(config, meaning, deadline, keys);
        if (!initial) return false;
        time = initial.time;
        initialFloors = initial.floors;
      }
      const observe = (result: Map<string, { row: IdentityPoint; allowed: boolean }>) => {
        for (const { id, route } of keys) {
          const state = result.get(id);
          const partition = partitionOf(route);
          for (const { observed, pending } of owners.get(id)!) {
            if (!state) {
              observed.complete = false;
              continue;
            }
            const { epoch, privacy_position } = state.row;
            const position = BigInt(privacy_position);
            const prior = observed.heads.get(partition);
            if (prior && (prior.epoch !== epoch || prior.position !== position)) {
              observed.complete = false;
              continue;
            }
            observed.heads.set(partition, { partition, epoch, position });
            observed.states.set(id, state);
            if (state.allowed && state.row.visibility === 'visible' && state.row.redirect)
              pending.add(state.row.redirect);
          }
        }
      };
      const lastBatch = offset + keys.length === ids.length;
      if (retain && windows.length === 1 && lastBatch) {
        await readIdentityPoints(config, keys, time, deadline, initialFloors, async (client, result) => {
          observe(result);
          const { observed, pending } = windows[0]!;
          if (!observed.complete || [...pending].some((id) => !observed.states.has(id))) return true;
          return retain(client, observed);
        });
      } else {
        observe(await readIdentityPoints(config, keys, time, deadline, initialFloors));
      }
    }
  }
  for (const { observed, pending } of windows)
    if ([...pending].some((id) => !observed.states.has(id))) observed.complete = false;
  return true;
}

function resolveIdentity(
  root: string,
  states: ReadonlyMap<string, IdentityState>,
): { visible: boolean; path: string[]; terminal: string } {
  const path: string[] = [];
  const seen = new Set<string>();
  let id: string | null = root;
  for (let depth = 0; id !== null && depth < 8; depth++) {
    if (seen.has(id)) return { visible: false, path, terminal: root };
    seen.add(id);
    path.push(id);
    const state = states.get(id);
    if (!state || !state.allowed || state.row.visibility !== 'visible') return { visible: false, path, terminal: root };
    id = state.row.redirect;
  }
  if (id !== null || path.length === 0) return { visible: false, path, terminal: root };
  return { visible: true, path, terminal: path.at(-1)! };
}

/** Current identity evidence for one ordinary window or the first windows of a composed Book page. */
export async function readPublicFilterSubjectIdentityWindows(
  config: Configuration,
  requests: readonly PublicFilterSubjectIdentityRequest[],
  accessPort: PublicFilterAccessBindingPort,
): Promise<readonly PublicFilterSubjectIdentities[]> {
  if (!requests.length || requests.length > MAX_PAGE_READS) throw new TypeError('Invalid public identity windows');
  const meaning = requests[0]!.meaning;
  const deadline = Math.min(...requests.map(({ context }) => context.deadline));
  const members = requests.map((request) => {
    const subjects = [...new Set(request.subjects)];
    if (
      !subjects.length ||
      subjects.length > 200 ||
      !Number.isSafeInteger(request.inputLimit) ||
      request.inputLimit < subjects.length ||
      request.inputLimit > 1000 ||
      !validMeaning(request.meaning) ||
      request.meaning.digest !== meaning.digest ||
      subjects.some((id) => !routePartition(id))
    )
      throw new TypeError('Invalid native public identity request');
    return { subjects, window: identityWindow(subjects, request.inputLimit) };
  });
  if (identitySourceSupportRoot() || identitySourceSupportJob())
    return members.map(({ window }) => unready('identity_pending', window.cost));
  try {
    if (config.access.prepareReadDecisions) {
      const ready = await readIdentityWindows(
        config,
        accessPort,
        members.map(({ window }) => window),
        meaning,
        deadline,
      );
      if (!ready) return members.map(({ window }) => unready('metadata_missing', window.cost));
    } else {
      const initial = await startIdentityWindow(config, meaning, deadline);
      if (!initial) return members.map(({ window }) => unready('metadata_missing', window.cost));
      const { time } = initial;
      for (const { subjects, window } of members)
        window.observed = await readPublicIdentities(
          config,
          accessPort,
          subjects,
          time,
          deadline,
          window.cost,
          undefined,
          window.inputLimit,
        );
    }
    requireAccessDeadline(deadline);
    return members.map(({ subjects, window: { observed, cost } }) => {
      if (!observed.complete) return unready('dependency_pending', cost);
      const rows = [];
      for (const subject of subjects) {
        const row = observed.states.get(subject)?.row;
        if (!row?.selection_ready || !row.current_revision || row.currentRelease !== meaning.digest)
          return unready('metadata_missing', cost);
        const partition = partitionOf(row.route);
        if (!observed.heads.has(partition)) return unready('owner_pending', cost);
        rows.push({
          subject,
          partition,
          securityRevision: row.securityRevision,
          currentRelease: row.currentRelease,
          terminal: resolveIdentity(subject, observed.states).terminal,
        });
      }
      return { status: 'observed', rows, cost };
    });
  } catch (error) {
    if (accessPort.isUnavailable(error))
      return members.map(({ window }) =>
        Date.now() >= deadline ? unavailable('deadline', window.cost) : unready('dependency_pending', window.cost),
      );
    throw error;
  }
}

function observationMatches(build: BuildRow, source: SubjectRow, ownerEpoch: number, privacy: string): boolean {
  return (
    build.route === source.route &&
    build.owner_epoch === ownerEpoch &&
    build.source_position.length > 0 &&
    BigInt(build.privacy_position) === BigInt(privacy) &&
    build.subject_revision === source.current_revision &&
    build.security_revision === source.securityRevision &&
    build.current_release === source.currentRelease
  );
}

/** Check a completed build at the current Source revision without reopening its selection. */
export async function verifyCompletedPublicFilterProjectionInSnapshot(
  tx: CommandTransaction,
  routeKey: Uint8Array,
  subjectId: string,
  terminal: string,
  release: string,
  epoch: number,
  frontier: PublicFilterProjectionFrontier,
): Promise<boolean> {
  const home = routePartition(subjectId);
  const cursor = readCursor(routeKey, frontier);
  if (!home || !cursor || cursor.phase !== 'dependencies') return false;
  return (
    (
      await tx.query(verifyCompletedPublicFilterProjectionSql, [
        home.partition,
        home.route,
        subjectId,
        frontier.build,
        String(frontier.generation),
        epoch,
        release,
        terminal,
        cursor.partition,
      ])
    ).rowCount === 1
  );
}

function sourceWitness(
  partition: number,
  epoch: number,
  position: bigint,
  privacyPosition: bigint,
  subject: SubjectRow,
) {
  return [
    partition,
    subject.route,
    subject.id,
    epoch,
    position.toString(),
    privacyPosition.toString(),
    subject.type,
    subject.visibility,
    subject.securityRevision,
    subject.currentRelease,
    subject.redirect,
    subject.current_revision,
    subject.selection_ready,
  ];
}

function projectionHeads(heads: ReadonlyMap<number, PrivacyReductionHead>) {
  return [...heads.values()].map((head) => ({
    partition_no: head.partition,
    owner_epoch: head.epoch,
    position: head.position.toString(),
  }));
}

async function ensureBuildHeads(
  client: PoolClient,
  build: Pick<BuildRow, 'build_id' | 'generation'>,
  heads: ReadonlyMap<number, PrivacyReductionHead>,
): Promise<boolean> {
  if (
    !(await client.query(lockProjectionBuildForHeadsSql, [build.build_id, build.generation, retiredProjectionMeaning]))
      .rowCount
  )
    return false;
  if (heads.size === 0) return true;
  const retained = rows(
    await nativeSourceQuery(client, upsertRetainedHeads, {
      build_id: build.build_id,
      heads: projectionHeads(heads),
    }),
  );
  return retained.length === heads.size;
}

async function readProjectionDependencyHeads(
  pool: Pool,
  build: string,
  after: number,
  limit: number,
  deadline: number,
  cost: MutableCost,
) {
  if (!identitySourceSupportJob()) {
    const { rows: retained } = await withBoundedReadConnection(
      pool,
      deadline,
      (client) =>
        client.query<StoredHead & { current: boolean }>(readCurrentProjectionHeadPageSql, [build, after, limit]),
      boundedProjectionReadOptions(deadline),
    );
    cost.inputKeys = Math.max(cost.inputKeys, retained.length || 1);
    cost.dependencyPoints += retained.length;
    if (retained.some((head) => !head.current)) return null;
    return {
      heads: retained.map((head) => ({
        partition: head.partition_no,
        epoch: head.owner_epoch,
        position: BigInt(head.position),
      })),
      after: retained.at(-1)?.partition_no ?? after,
      complete: retained.length < limit,
    };
  }
  // Identity receiving meters each native owner seek against its admitted work plan.
  const retained = rows(
    await inSnapshot(pool, deadline, (client) =>
      nativeSourceQuery(client, readRetainedHeadPage, { build_id: build, after_partition: after, input_limit: limit }),
    ),
  ) as StoredHead[];
  cost.inputKeys = Math.max(cost.inputKeys, retained.length || 1);
  cost.dependencyPoints += retained.length;
  const heads: PrivacyReductionHead[] = [];
  for (const expected of retained) {
    const current = await inSnapshot(pool, deadline, (client) =>
      nativeSourceQuery(client, readCurrentRetainedHead, { partition_no: expected.partition_no }),
    );
    if (
      !current ||
      current.write_state !== 'active' ||
      current.epoch !== expected.owner_epoch ||
      BigInt(current.position) !== BigInt(expected.position)
    )
      return null;
    heads.push({ partition: expected.partition_no, epoch: current.epoch, position: BigInt(current.position) });
  }
  return { heads, after: retained.at(-1)?.partition_no ?? after, complete: retained.length < limit };
}

/** Invalidate the old generation under the build lock and reclaim one exact dependency head. */
async function retireIdentityProjectionHead(
  client: PoolClient,
  partition: number,
  subject: string,
): Promise<PublicFilterProjectionRetirement | null> {
  const prior = (
    await client.query<{ build_id: string; generation: string; meaning_digest: string }>(
      lockProjectionBuildForRetirementSql,
      [partition, subject],
    )
  ).rows[0];
  if (!prior) return null;
  const removed = (await client.query<{ partition_no: number }>(retireProjectionHeadSql, [prior.build_id])).rows[0];
  if (!removed) return null;
  let generation = prior.generation;
  if (prior.meaning_digest !== retiredProjectionMeaning) {
    const marked = (
      await client.query<{ generation: string }>(invalidateProjectionBuildSql, [
        prior.build_id,
        prior.generation,
        retiredProjectionMeaning,
      ])
    ).rows[0];
    if (!marked) throw new Error('Projection retirement lost the original build');
    generation = marked.generation;
  }
  return { build: prior.build_id, generation, partition: removed.partition_no };
}

function projectionBuildInput(
  meaning: PublicFilterProjectionMeaning,
  observation: PublicFilterProjectionObservation,
  expected: SubjectRow,
  privacyPosition: bigint,
  build: string,
) {
  return {
    partition_no: observation.partition,
    route: expected.route,
    subject_id: observation.subject,
    meaning_digest: meaning.digest,
    build_id: build,
    owner_epoch: observation.epoch,
    source_position: observation.position.toString(),
    privacy_position: privacyPosition.toString(),
    terminal_id: observation.terminal,
    subject_revision: observation.revision,
    security_revision: observation.securityRevision,
    current_release: observation.currentRelease,
  };
}

type StoredProjectionObservation = Omit<PublicFilterProjectionObservation, 'position'> & { position: string };
type CleanupResult = { cleanup: ProjectionCleanup; charged: number; source: PublicFilterProjectionObservation };
type ChargedBuild = BuildRow & { charged: number };
type ReclaimedBuild = { started: BuildRow; charged: number; source: PublicFilterProjectionObservation };

function storedProjectionObservation(source: PublicFilterProjectionObservation): StoredProjectionObservation {
  return { ...source, position: source.position.toString() };
}

function projectionCleanupKey(
  subject: SubjectRow,
  observation: PublicFilterProjectionObservation,
  privacyPosition: bigint,
) {
  return JSON.stringify([
    subject.route,
    subject.id,
    subject.type,
    subject.visibility,
    subject.securityRevision,
    subject.currentRelease,
    subject.redirect,
    subject.current_revision,
    subject.selection_ready,
    observation.epoch,
    observation.terminal,
    privacyPosition.toString(),
  ]);
}

async function installProjectionBuildOn(
  client: PoolClient,
  meaning: PublicFilterProjectionMeaning,
  observation: PublicFilterProjectionObservation,
  expected: SubjectRow,
  privacyPosition: bigint,
  build: string,
  heads: ReadonlyMap<number, PrivacyReductionHead>,
): Promise<BuildRow> {
  const input = projectionBuildInput(meaning, observation, expected, privacyPosition, build);
  const created = (
    await client.query<Pick<BuildRow, 'build_id' | 'generation' | 'route'>>(startProjectionWithHeadsSql, [
      ...startBuild['~standard'].query.encode(input),
      JSON.stringify(projectionHeads(heads)),
    ])
  ).rows[0];
  if (!created) throw new Error('Native projection build was not retained');
  return { ...input, ...created };
}

/** The caller owns the repeatable-read transaction, its deadline and its commit. */
async function saveOrdinaryProjectionBuildOn(
  client: PoolClient,
  meaning: PublicFilterProjectionMeaning,
  observation: PublicFilterProjectionObservation,
  expected: SubjectRow,
  privacyPosition: bigint,
  build: string,
  heads: ReadonlyMap<number, PrivacyReductionHead>,
  inputLimit: number,
  headLimit: number,
): Promise<ChargedBuild | CleanupResult | 'identity_pending' | null> {
  const result = await client.query<{
    identity_pending: boolean;
    no_budget: boolean;
    charged: number;
    build: string | null;
    generation: string;
    successor: string;
    step: number;
    source: StoredProjectionObservation;
  }>(prepareProjectionBuildSql, [
    ...sourceWitness(observation.partition, observation.epoch, observation.position, privacyPosition, expected),
    meaning.digest,
    projectionCleanupKey(expected, observation, privacyPosition),
    build,
    inputLimit,
    JSON.stringify(storedProjectionObservation(observation)),
    JSON.stringify(projectionHeads(heads)),
    headLimit,
  ]);
  const row = result.rows[0];
  if (!row || row.no_budget) return null;
  if (row.identity_pending) return 'identity_pending';
  if (row.build)
    return {
      cleanup: {
        build: row.build,
        generation: BigInt(row.generation),
        successor: row.successor,
        step: row.step,
        inputLimit,
      },
      source: { ...row.source, position: BigInt(row.source.position) },
      charged: row.charged,
    };
  return {
    ...(await installProjectionBuildOn(client, meaning, observation, expected, privacyPosition, build, heads)),
    charged: row.charged,
  };
}

async function resumeOrdinaryProjectionCleanupOn(
  client: PoolClient,
  meaning: PublicFilterProjectionMeaning,
  observation: PublicFilterProjectionObservation,
  expected: SubjectRow,
  privacyPosition: bigint,
  cleanup: ProjectionCleanup,
  inputLimit: number,
  heads: ReadonlyMap<number, PrivacyReductionHead>,
): Promise<
  | CleanupResult
  | { started: BuildRow; charged: number; source: PublicFilterProjectionObservation }
  | 'identity_pending'
  | null
> {
  const result = await client.query<{
    identity_pending: boolean;
    installed: boolean;
    step: number;
    charged: number;
    advanced: number | null;
    source: StoredProjectionObservation;
    installed_generation: string | null;
  }>(advanceProjectionCleanupSql, [
    ...sourceWitness(observation.partition, observation.epoch, observation.position, privacyPosition, expected),
    meaning.digest,
    projectionCleanupKey(expected, observation, privacyPosition),
    cleanup.successor,
    cleanup.inputLimit,
    cleanup.build,
    cleanup.generation.toString(),
    cleanup.step,
    Math.min(inputLimit, cleanup.inputLimit),
  ]);
  const row = result.rows[0];
  if (!row) return null;
  if (row.identity_pending) return 'identity_pending';
  const source = { ...row.source, position: BigInt(row.source.position) };
  if (row.step > cleanup.step || row.advanced !== null)
    return { cleanup: { ...cleanup, step: cleanup.step + 1 }, source, charged: row.charged };
  const started = row.installed
    ? {
        ...projectionBuildInput(meaning, source, expected, privacyPosition, cleanup.successor),
        generation: row.installed_generation!,
      }
    : await installProjectionBuildOn(client, meaning, source, expected, privacyPosition, cleanup.successor, heads);
  return { started, source, charged: row.charged };
}

async function readCurrentProjectionCleanupOn(
  client: PoolClient,
  page: Extract<PublicFilterProjectionPage, { status: 'progress' }>,
  meaningDigest: string,
): Promise<boolean | null> {
  if (page.records.length || page.repairLocators.length) return null;
  const terminal = routePartition(page.source.terminal);
  if (!terminal) return false;
  const result = await client.query<{ current: boolean }>(checkProjectionCleanupSql, [
    page.source.partition,
    page.source.subject,
    page.frontier.build,
    page.frontier.generation.toString(),
    meaningDigest,
    JSON.stringify(storedProjectionObservation(page.source)),
    terminal.partition,
  ]);
  return result.rows[0]?.current ?? null;
}

/** A false result may have inserted a subset of the heads. Roll back the caller's transaction. */
async function retainOrdinaryProjectionHeadsOn(
  client: PoolClient,
  build: Pick<BuildRow, 'build_id' | 'generation'>,
  expected: SubjectRow,
  observation: Pick<PublicFilterProjectionObservation, 'partition' | 'epoch' | 'position'>,
  privacyPosition: bigint,
  heads: ReadonlyMap<number, PrivacyReductionHead>,
): Promise<boolean> {
  const result = await client.query<{ retained: number }>(retainCurrentProjectionHeadsSql, [
    ...sourceWitness(observation.partition, observation.epoch, observation.position, privacyPosition, expected),
    build.build_id,
    build.generation,
    retiredProjectionMeaning,
    JSON.stringify(projectionHeads(heads)),
  ]);
  return result.rows[0]?.retained === heads.size;
}

async function saveBuild(
  config: Configuration,
  subject: string,
  meaning: PublicFilterProjectionMeaning,
  observation: PublicFilterProjectionObservation,
  expected: SubjectRow,
  privacyPosition: bigint,
  build: string,
  heads: ReadonlyMap<number, PrivacyReductionHead>,
  deadline: number,
  inputLimit: number,
  headLimit: number,
  cleanup?: ProjectionCleanup,
): Promise<OrdinaryWrite | { retirement: PublicFilterProjectionRetirement }> {
  const route = routeOf(subject)!;
  async function attempt(client: PoolClient) {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(deadline - Date.now()))}ms'`);
    if (!identitySourceSupportJob()) {
      const stored = cleanup
        ? await resumeOrdinaryProjectionCleanupOn(
            client,
            meaning,
            observation,
            expected,
            privacyPosition,
            cleanup,
            inputLimit,
            heads,
          )
        : await saveOrdinaryProjectionBuildOn(
            client,
            meaning,
            observation,
            expected,
            privacyPosition,
            build,
            heads,
            inputLimit,
            headLimit,
          );
      await client.query(stored && stored !== 'identity_pending' ? 'COMMIT' : 'ROLLBACK');
      return stored;
    }
    const owner = await readPartition(client, observation.partition);
    const privacy = await nativeSourceQuery(client, readPrivacyHead, { partition_no: observation.partition });
    const current = rows(
      await nativeSourceQuery(client, readSubjects, {
        partition_no: observation.partition,
        routes: [route],
        subject_ids: [subject],
      }),
    )[0] as SubjectRow | undefined;
    if (
      !owner ||
      owner.writeState !== 'active' ||
      owner.epoch !== observation.epoch ||
      owner.position < observation.position ||
      !privacy ||
      BigInt(privacy.position) !== privacyPosition ||
      !sameSource(expected, current)
    ) {
      await client.query('ROLLBACK');
      return null;
    }
    const retirement = await retireIdentityProjectionHead(client, observation.partition, subject);
    if (retirement) {
      await client.query('COMMIT');
      return { retirement };
    }
    const input = projectionBuildInput(meaning, observation, expected, privacyPosition, build);
    const created = rows(await nativeSourceQuery(client, startBuild, input))[0];
    if (!created) throw new Error('Native projection build was not retained');
    if (!(await ensureBuildHeads(client, created, heads))) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('COMMIT');
    return { ...input, ...created };
  }

  // A competing build can invalidate the snapshot while we wait for its row lock.
  // Recheck the original observation and privacy head in a fresh transaction.
  for (;;) {
    try {
      return await withBoundedCommandConnection(config.pool, deadline, attempt, {
        deadlineError: () => new AccessUnavailableError('deadline'),
      });
    } catch (error) {
      requireAccessDeadline(deadline);
      if (!isPostgresTransactionAbort(error)) throw error;
    }
  }
}

function makeDependencies(
  row: SelectedRow,
  targetIds: readonly string[],
  identityStates: ReadonlyMap<string, IdentityState>,
  tuple: SourceFenceTuple | null,
): PublicFilterDependency[] {
  const route = row.route;
  const values: PublicFilterDependency[] = [
    sourceDependency(route, row.subject_id),
    { kind: 'selection', route, subject: row.subject_id, slot: row.slot_id, candidate: row.candidate_id },
  ];
  for (const id of targetIds) {
    const targetRoute = routeOf(id);
    if (targetRoute !== null) values.push(sourceDependency(targetRoute, id));
    const identity = resolveIdentity(id, identityStates);
    for (const dependencyId of identity.path) {
      const dependencyRoute = routeOf(dependencyId);
      if (dependencyRoute !== null) values.push(sourceDependency(dependencyRoute, dependencyId));
    }
  }
  if (tuple) values.push({ kind: 'sourceTuple', tuple });
  if (row.consent_account)
    values.push({
      kind: 'consent',
      route,
      account: row.consent_account,
      subject: row.subject_id,
      candidate: row.candidate_id,
    });
  return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
}

/** Native selected-key source. No history fold, subject hydration, or sampled relation witness is used. */
export async function readPublicFilterProjectionPage(
  config: Configuration,
  request: PublicFilterProjectionRequest,
  accessPort: PublicFilterAccessBindingPort,
): Promise<PublicFilterProjectionPage> {
  const cost: MutableCost = { ...emptyCost() };
  const routed = routePartition(request.subject);
  if (
    !routed ||
    !Number.isInteger(request.inputLimit) ||
    request.inputLimit < 1 ||
    request.inputLimit > 1000 ||
    !Number.isSafeInteger(request.context.deadline) ||
    request.context.deadline <= Date.now() ||
    !validMeaning(request.meaning)
  )
    throw new TypeError('Invalid native public projection request');

  let cursor: CursorResult = null;
  if (request.frontier) {
    cursor = readCursor(config.routeKey, request.frontier);
    if (cursor === false) return { status: 'changed', frontier: request.frontier, cost };
  }
  const frontier = request.frontier;
  const cleanup: ProjectionCleanup | undefined =
    cursor?.phase === 'cleanup' && frontier
      ? {
          build: cursor.previous,
          generation: frontier.generation - 1n,
          successor: frontier.build,
          step: cursor.step,
          inputLimit: cursor.inputLimit,
        }
      : undefined;
  if (
    cursor?.phase === 'cleanup' &&
    (cursor.subject !== request.subject || cursor.meaning !== request.meaning.digest || identitySourceSupportJob())
  )
    return { status: 'changed', frontier: frontier!, cost };
  const deadline = request.context.deadline;
  const probeLimit = Math.floor((request.inputLimit - 1) / 2);
  const { route, partition } = routed;
  const supportRoot = identitySourceSupportRoot();
  if (supportRoot && supportRoot.original !== request.subject) return unavailable('missing_owner', cost);

  type SourceWindow = {
    owner: NonNullable<Awaited<ReturnType<typeof readPartition>>>;
    subject: SubjectRow;
    privacyPosition: string;
    meaning: PublicFilterProjectionMeaning;
    time: AuthoritativeTime;
    build: BuildRow | null;
    rows: SelectedRow[];
    releases: Map<string, Release>;
    selectionLimit: number;
    headLimit: number;
    probed: number;
    floors: readonly IdentityFloor[] | undefined;
  };

  try {
    const supportRelease = identitySourceSupportJob()
      ? await readRelease(config.pool, request.meaning.digest)
      : undefined;
    if (supportRelease === null) return unready('metadata_missing', cost);
    const snapshot = await inSnapshot(
      config.pool,
      deadline,
      async (client): Promise<SourceWindow | PublicFilterProjectionPage> => {
        const root = supportRelease
          ? undefined
          : rows(
              await nativeSourceQuery(client, readProjectionRoot, {
                route,
                subject_id: request.subject,
                meaning_digest: request.meaning.digest,
                with_build: !!request.frontier,
                probe_limit: probeLimit,
              }),
            )[0];
        if (!supportRelease && !root?.release_owner) return unready('metadata_missing', cost);
        const release =
          supportRelease ??
          (root?.installed ? verifiedBaseReleaseBody(request.meaning.digest) : undefined) ??
          (await readRelease(client, request.meaning.digest));
        if (!release) return unready('metadata_missing', cost);
        const meaning = { ...request.meaning, release };
        const owner = root
          ? root.write_state && root.node !== null && root.epoch !== null && root.owner_position !== null
            ? {
                partitionNo: partition,
                node: root.node,
                writeState: root.write_state as 'active' | 'moved' | 'fenced',
                movedTo: root.moved_to,
                epoch: root.epoch,
                position: BigInt(root.owner_position),
              }
            : null
          : await readPartition(client, partition);
        if (!owner) return unavailable('missing_owner', cost);
        if (owner.writeState === 'moved') return unavailable('moved', cost);
        if (owner.writeState !== 'active') return unready('owner_pending', cost);

        const subject = root
          ? (root.subject as SubjectRow | null)
          : (
              rows(
                await nativeSourceQuery(client, readSubjects, {
                  partition_no: partition,
                  routes: [route],
                  subject_ids: [request.subject],
                }),
              ) as SubjectRow[]
            )[0];
        if (!subject) return unavailable('missing_owner', cost);
        const rootTime =
          supportRoot && subject.visibility === 'visible'
            ? await mintReadTime(client, config.clock, config.pool)
            : null;
        await supportRoot?.check(client, owner, subject.visibility, rootTime);
        if (!subject.selection_ready) return unready('owner_pending', cost);
        if (!subject.current_revision || !subject.currentRelease) return unready('metadata_missing', cost);
        const privacy = root
          ? root.privacy_position !== null
            ? { position: root.privacy_position }
            : null
          : await nativeSourceQuery(client, readPrivacyHead, { partition_no: partition });
        if (!privacy) return unready('metadata_missing', cost);
        const time = rootTime ?? (await mintReadTime(client, config.clock, config.pool));
        const buildRows = root
          ? [root.build]
          : request.frontier
            ? rows(
                await nativeSourceQuery(client, readBuild, {
                  partition_no: partition,
                  route,
                  subject_id: request.subject,
                  meaning_digest: meaning.digest,
                }),
              )
            : [];
        const build = cleanup ? null : ((buildRows[0] as BuildRow | undefined) ?? null);
        if (
          request.frontier &&
          !cleanup &&
          (!build ||
            build.build_id !== request.frontier.build ||
            BigInt(build.generation) !== request.frontier.generation)
        )
          return { status: 'changed', frontier: request.frontier, cost };
        if (
          build &&
          (!observationMatches(build, subject, owner.epoch, privacy.position) || build.terminal_id.length === 0)
        )
          return { status: 'changed', frontier: request.frontier!, cost };

        const probed = root?.probed_heads ?? 0;
        const firstWithPrior = !request.frontier && root?.has_prior;
        // Retiring a wide generation spends this step on its old keys. Small prior builds
        // leave room to select records and replace the heads in one ordinary page.
        const selectionLimit =
          cleanup || (firstWithPrior && (root.retiring || probed >= probeLimit))
            ? 0
            : request.inputLimit - 2 * probed - (firstWithPrior ? 1 : 0);
        const selectionPhase = cursor?.phase !== 'dependencies' && selectionLimit > 0;
        const afterCursor = cursor?.phase === 'selection' ? cursor : null;
        const properties = facetProperties(meaning.release, [subject.type]);
        const selected = selectionPhase
          ? (rows(
              await nativeSourceQuery(client, readPage, {
                partition_no: partition,
                route,
                subject_id: request.subject,
                properties,
                after_property: afterCursor?.property ?? '',
                after_slot: afterCursor?.slot ?? ZERO_UUID,
                after_candidate: afterCursor?.candidate ?? ZERO_UUID,
                input_limit: selectionLimit,
              }),
            ) as SelectedRow[])
          : [];
        cost.inputKeys = Math.max(1, selected.length + probed);
        cost.candidates = selected.length;
        const releases = new Map([[meaning.digest, meaning.release]]);
        const missing = [...new Set(selected.map((row) => row.release))].filter((digest) => !releases.has(digest));
        if (missing.length) {
          if (!root && (await readPartition(client, 0))?.writeState !== 'active')
            return unready('metadata_missing', cost);
          const found = await readBaseReleases(client, missing);
          for (const digest of missing) {
            const release = found.has(digest) ? found.get(digest) : await readRelease(client, digest);
            if (!release) return unready('metadata_missing', cost);
            releases.set(digest, release);
          }
        }
        let floors: readonly IdentityFloor[] | undefined;
        if (!supportRelease && config.access.prepareReadDecisions) {
          // Each statement's own stored release decodes its target identities. Access then checks
          // these visibility floors again on its separate authorized snapshot.
          const ids = [
            ...new Set([subject.id, ...selected.flatMap((row) => statementIds(row, releases.get(row.release)!).ids)]),
          ];
          if (ids.length <= 200 && ids.every((id) => routeOf(id) !== null)) {
            floors = await nativeSourceQuery(client, readIdentityFloors, {
              ids,
              routes: ids.map((id) => routeOf(id)!),
            });
          }
        }
        return {
          owner,
          subject,
          meaning,
          privacyPosition: privacy.position,
          time,
          build,
          rows: selected,
          releases,
          floors,
          selectionLimit,
          probed,
          headLimit: request.inputLimit - probed - selected.length,
        };
      },
    );
    if ('status' in snapshot) return snapshot;
    const { meaning } = snapshot;

    // A native identity cursor entering dependencies has already retained the selection.
    // Each next turn rechecks the build's current source and reads one bounded head page.
    if (identitySourceSupportJob() && cursor?.phase === 'dependencies' && snapshot.build) {
      const build = snapshot.build;
      const page = await readProjectionDependencyHeads(
        config.pool,
        build.build_id,
        cursor.partition,
        request.inputLimit,
        deadline,
        cost,
      );
      if (!page) return { status: 'changed', frontier: request.frontier!, cost };
      if (page.complete) {
        const current = await inSnapshot(config.pool, deadline, async (client) => {
          const owner = await readPartition(client, partition);
          if (!owner || owner.writeState !== 'active' || owner.epoch !== build.owner_epoch) return false;
          const latest = (
            rows(
              await nativeSourceQuery(client, readBuild, {
                partition_no: partition,
                route,
                subject_id: request.subject,
                meaning_digest: meaning.digest,
              }),
            ) as BuildRow[]
          )[0];
          return latest?.build_id === build.build_id && latest.generation === build.generation;
        });
        if (!current) return { status: 'changed', frontier: request.frontier!, cost };
      }
      const generation = BigInt(build.generation);
      const frontier = {
        build: build.build_id,
        generation,
        continuation: cursorToken(config.routeKey, build.build_id, generation, {
          phase: 'dependencies',
          partition: page.after,
        }),
      };
      const source = sourceObservation(
        partition,
        build.owner_epoch,
        BigInt(build.source_position),
        snapshot.subject,
        build.terminal_id,
      );
      const common = { source, frontier, records: [], repairLocators: [], cost };
      return page.complete
        ? { ...common, status: 'complete', requiredHeads: page.heads }
        : { ...common, status: 'progress' };
    }

    let nextCursor: PageCursor =
      cursor?.phase === 'dependencies'
        ? cursor
        : snapshot.selectionLimit > 0 && snapshot.rows.length === snapshot.selectionLimit
          ? {
              phase: 'selection',
              property: snapshot.rows.at(-1)!.property,
              slot: snapshot.rows.at(-1)!.slot_id,
              candidate: snapshot.rows.at(-1)!.candidate_id,
            }
          : { phase: 'dependencies', partition: -1 };
    const pageRows = snapshot.rows;
    const releaseCache = snapshot.releases;
    const prepared = new Map<SelectedRow, { statement: Statement; ids: string[]; tuple: SourceFenceTuple | null }>();
    const targetIds = new Set<string>([request.subject]);
    const tupleList: SourceFenceTuple[] = [];
    const repairLocators: import('./public-filter-source-contract.ts').PublicFilterRepairLocator[] = [];
    let metadataMissing = false;

    for (const row of pageRows) {
      const selection: PublicFilterDependency = {
        kind: 'selection',
        route: row.route,
        subject: row.subject_id,
        slot: row.slot_id,
        candidate: row.candidate_id,
      };
      const fallbackDependencies: PublicFilterDependency[] = [sourceDependency(row.route, row.subject_id), selection];
      if (!validSource(row.source)) {
        metadataMissing = true;
        repairLocators.push({
          subject: row.subject_id,
          slot: row.slot_id,
          candidate: row.candidate_id,
          property: row.property,
          dependencies: fallbackDependencies,
        });
        continue;
      }

      const statementRelease = releaseCache.get(row.release);
      if (!statementRelease) {
        metadataMissing = true;
        repairLocators.push({
          subject: row.subject_id,
          slot: row.slot_id,
          candidate: row.candidate_id,
          property: row.property,
          dependencies: fallbackDependencies,
        });
        continue;
      }
      let tuple: SourceFenceTuple | null = null;
      if (row.source && Object.hasOwn(row.source, 'source')) {
        try {
          tuple = sourceTuple(config.routeKey, row.source);
          tupleList.push(tuple);
        } catch {
          metadataMissing = true;
          repairLocators.push({
            subject: row.subject_id,
            slot: row.slot_id,
            candidate: row.candidate_id,
            property: row.property,
            dependencies: fallbackDependencies,
          });
          continue;
        }
      }

      const decoded = statementIds(row, statementRelease);
      const statement = buildStatement(row, statementRelease, snapshot.subject.type);
      if (!decoded.complete || !statement) {
        metadataMissing = true;
        repairLocators.push({
          subject: row.subject_id,
          slot: row.slot_id,
          candidate: row.candidate_id,
          property: row.property,
          dependencies: fallbackDependencies,
        });
        continue;
      }
      const ids = [...new Set(decoded.ids)];
      for (const id of ids) targetIds.add(id);
      prepared.set(row, { statement, ids, tuple });
      const dependencies: PublicFilterDependency[] = [
        ...fallbackDependencies,
        ...ids.flatMap((id) => {
          const idRoute = routeOf(id);
          return idRoute === null ? [] : [sourceDependency(idRoute, id)];
        }),
        ...(tuple ? [{ kind: 'sourceTuple' as const, tuple }] : []),
        ...(row.consent_account
          ? [
              {
                kind: 'consent' as const,
                route: row.route,
                account: row.consent_account,
                subject: row.subject_id,
                candidate: row.candidate_id,
              },
            ]
          : []),
      ];
      repairLocators.push({
        subject: row.subject_id,
        slot: row.slot_id,
        candidate: row.candidate_id,
        property: row.property,
        dependencies,
      });
    }
    if (metadataMissing) return unready('metadata_missing', cost);

    let identities: IdentityRead;
    const write: { result?: OrdinaryWrite } = {};
    if (config.access.prepareReadDecisions && !identitySourceSupportJob() && !supportRoot) {
      // Every selected row and redirect keeps its own dependency and public Access
      // decision. Group the exact native points on their shared physical database.
      const retain = async (client: PoolClient, observed: IdentityRead) => {
        const original = observed.states.get(request.subject);
        const home = observed.heads.get(partition);
        if (
          !sameSource(snapshot.subject, original?.row) ||
          !home ||
          home.epoch !== snapshot.owner.epoch ||
          home.position !== BigInt(snapshot.privacyPosition)
        )
          return true;
        const terminal = resolveIdentity(request.subject, observed.states).terminal;
        if (snapshot.build && snapshot.build.terminal_id !== terminal) return true;
        const at = sourceObservation(partition, home.epoch, snapshot.owner.position, snapshot.subject, terminal);
        let build: OrdinaryWrite;
        if (cleanup) {
          build = await resumeOrdinaryProjectionCleanupOn(
            client,
            meaning,
            at,
            snapshot.subject,
            home.position,
            cleanup,
            request.inputLimit,
            observed.heads,
          );
        } else if (snapshot.build) {
          const retained = await retainOrdinaryProjectionHeadsOn(
            client,
            snapshot.build,
            snapshot.subject,
            at,
            home.position,
            observed.heads,
          );
          build = retained ? snapshot.build : null;
        } else {
          build = await saveOrdinaryProjectionBuildOn(
            client,
            meaning,
            at,
            snapshot.subject,
            home.position,
            randomUUID(),
            observed.heads,
            request.inputLimit,
            snapshot.headLimit,
          );
        }
        write.result = build;
        return build !== null && build !== 'identity_pending';
      };
      for (;;) {
        const window = identityWindow([...targetIds], targetIds.size * 8);
        delete write.result;
        try {
          await readIdentityWindows(
            config,
            accessPort,
            [window],
            meaning,
            deadline,
            snapshot.time,
            snapshot.floors,
            tupleList.length === 0 ? retain : undefined,
          );
          identities = window.observed;
          break;
        } catch (error) {
          if (!isPostgresTransactionAbort(error)) throw error;
          requireAccessDeadline(deadline);
        } finally {
          cost.accessPoints += window.cost.accessPoints;
          cost.dependencyPoints += window.cost.dependencyPoints;
        }
      }
    } else {
      identities = await readPublicIdentities(
        config,
        accessPort,
        [...targetIds],
        snapshot.time,
        deadline,
        cost,
        supportRoot
          ? {
              state: { row: snapshot.subject, allowed: true },
              head: { partition, epoch: snapshot.owner.epoch, position: BigInt(snapshot.privacyPosition) },
            }
          : undefined,
      );
    }
    if (!identities.complete) return unready('dependency_pending', cost);
    const observedSourceHead = identities.heads.get(partition);
    if (
      !observedSourceHead ||
      observedSourceHead.epoch !== snapshot.owner.epoch ||
      observedSourceHead.position !== BigInt(snapshot.privacyPosition)
    )
      return request.frontier
        ? { status: 'changed', frontier: request.frontier, cost }
        : unready('dependency_pending', cost);
    const sourceIdentity = resolveIdentity(request.subject, identities.states);
    if (!sameSource(snapshot.subject, identities.states.get(request.subject)?.row)) {
      return request.frontier
        ? { status: 'changed', frontier: request.frontier, cost }
        : unready('dependency_pending', cost);
    }
    if (snapshot.build && sourceIdentity.terminal !== snapshot.build.terminal_id)
      return { status: 'changed', frontier: request.frontier!, cost };

    const fenceResults = new Map<string, boolean>();
    const tupleGroups = new Map<number, SourceFenceTuple[]>();
    for (const tuple of tupleList) {
      const home = partitionOf(tuple.route);
      const values = tupleGroups.get(home) ?? [];
      values.push(tuple);
      tupleGroups.set(home, values);
    }
    for (const [home, values] of tupleGroups) {
      const result = await inSnapshot(config.pool, deadline, async (client) => {
        const owner = await readPartition(client, home);
        if (!owner || owner.writeState !== 'active') return null;
        const fences = [] as Awaited<ReturnType<typeof readFences>>[number][];
        for (let offset = 0; offset < values.length; offset += 100)
          fences.push(...(await readFences(client, values.slice(offset, offset + 100))));
        const privacy = await nativeSourceQuery(client, readPrivacyHead, { partition_no: home });
        if (!privacy) return null;
        return { owner, fences, privacy };
      });
      if (!result) return unready('dependency_pending', cost);
      const currentHead = {
        partition: home,
        epoch: result.owner.epoch,
        position: BigInt(result.privacy.position),
      };
      const priorHead = identities.heads.get(home);
      if (priorHead && (priorHead.epoch !== currentHead.epoch || priorHead.position !== currentHead.position))
        return request.frontier
          ? { status: 'changed', frontier: request.frontier, cost }
          : unready('dependency_pending', cost);
      identities.heads.set(home, currentHead);
      cost.dependencyPoints += values.length;
      for (const fence of result.fences)
        fenceResults.set(
          JSON.stringify([fence.route, fence.source, fence.external_id, fence.field_group]),
          !fence.takenDown,
        );
    }

    for (const row of pageRows) {
      const fact = prepared.get(row);
      const locatorIndex = repairLocators.findIndex(
        (locator) => locator.subject === row.subject_id && locator.candidate === row.candidate_id,
      );
      if (fact && locatorIndex >= 0) {
        repairLocators[locatorIndex] = {
          ...repairLocators[locatorIndex]!,
          dependencies: makeDependencies(row, fact.ids, identities.states, fact.tuple),
        };
      }
    }

    const records: PublicFilterProjectionRecord[] = [];
    for (const row of pageRows) {
      const fact = prepared.get(row);
      if (!fact || row.eligible !== true) continue;
      const targetVisible = fact.ids.every((id) => resolveIdentity(id, identities.states).visible);
      const tupleKey = fact.tuple
        ? JSON.stringify([fact.tuple.route, fact.tuple.source, fact.tuple.external_id, fact.tuple.field_group])
        : null;
      const tupleVisible = tupleKey === null || fenceResults.get(tupleKey) === true;
      if (!sourceIdentity.visible || !targetVisible || !tupleVisible) continue;
      const indexed = losslessIndex(row, releaseCache.get(row.release) ?? meaning.release)
        ? indexedStatement(
            { property: row.property, body: row.body } as Parameters<typeof indexedStatement>[0],
            releaseCache.get(row.release) ?? meaning.release,
          )
        : null;
      const dependencies = makeDependencies(row, fact.ids, identities.states, fact.tuple);
      records.push({
        subject: row.subject_id,
        terminal: sourceIdentity.terminal,
        slot: row.slot_id,
        candidate: row.candidate_id,
        revision: row.revision,
        release: row.release,
        rank: row.rank,
        ordinal: row.ordinal,
        source: row.source as Source | null,
        statement: fact.statement,
        indexed,
        dependencies,
      });
    }
    cost.outputSlots = records.length;
    cost.resultWrites = records.length;

    if (identitySourceSupportJob() && (request.frontier || !supportRoot)) {
      const currentSource = await inSnapshot(config.pool, deadline, async (client) => {
        const owner = await readPartition(client, partition);
        const privacy = await nativeSourceQuery(client, readPrivacyHead, { partition_no: partition });
        const currentRows = rows(
          await nativeSourceQuery(client, readSubjects, {
            partition_no: partition,
            routes: [route],
            subject_ids: [request.subject],
          }),
        ) as SubjectRow[];
        return { owner, privacy, subject: currentRows[0] };
      });
      if (
        !currentSource.owner ||
        currentSource.owner.writeState !== 'active' ||
        currentSource.owner.epoch !== snapshot.owner.epoch ||
        !currentSource.privacy ||
        BigInt(currentSource.privacy.position) !== BigInt(snapshot.privacyPosition) ||
        !sameSource(snapshot.subject, currentSource.subject)
      )
        return request.frontier
          ? { status: 'changed', frontier: request.frontier, cost }
          : unready('dependency_pending', cost);
    }

    const heads = new Map(identities.heads);
    heads.set(partition, {
      partition,
      epoch: snapshot.owner.epoch,
      position: BigInt(snapshot.privacyPosition),
    });
    let retained = snapshot.build;
    if (write.result !== undefined || !request.frontier || cleanup) {
      const stored =
        write.result !== undefined
          ? write.result
          : await saveBuild(
              config,
              request.subject,
              meaning,
              sourceObservation(
                partition,
                snapshot.owner.epoch,
                snapshot.owner.position,
                snapshot.subject,
                sourceIdentity.terminal,
              ),
              snapshot.subject,
              BigInt(snapshot.privacyPosition),
              randomUUID(),
              heads,
              deadline,
              request.inputLimit,
              snapshot.headLimit,
              cleanup,
            );
      if (!stored)
        return request.frontier
          ? { status: 'changed', frontier: request.frontier, cost }
          : unready('dependency_pending', cost);
      if (stored === 'identity_pending') return unready(stored, cost);
      if (!request.frontier || cleanup) cost.frontierWrites++;
      if ('retirement' in stored)
        return { status: 'unready', reason: 'dependency_pending', cost, retirement: stored.retirement };
      cost.inputKeys = Math.max(1, snapshot.probed + snapshot.rows.length + (stored.charged ?? 0));
      const progress = (
        build: string,
        generation: bigint,
        source: PublicFilterProjectionObservation,
        cursor: PageCursor | null,
      ): PublicFilterProjectionPage => ({
        status: 'progress',
        source,
        records: [],
        repairLocators: [],
        cost,
        frontier: { build, generation, continuation: cursorToken(config.routeKey, build, generation, cursor) },
      });
      if ('cleanup' in stored) {
        const { build, successor, generation, step, inputLimit } = stored.cleanup;
        return progress(successor, generation + 1n, stored.source, {
          phase: 'cleanup',
          subject: request.subject,
          meaning: meaning.digest,
          previous: build,
          step,
          inputLimit,
        });
      }
      retained = 'started' in stored ? stored.started : stored;
      if ('started' in stored || !snapshot.selectionLimit) {
        const source =
          'started' in stored
            ? stored.source
            : sourceObservation(
                partition,
                retained.owner_epoch,
                BigInt(retained.source_position),
                snapshot.subject,
                retained.terminal_id,
              );
        return progress(retained.build_id, BigInt(retained.generation), source, null);
      }
    } else if (retained) {
      const retainedHeads = await withConnection(config.pool, async (client) => {
        requireAccessDeadline(deadline);
        await client.query('BEGIN');
        try {
          await client.query(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(deadline - Date.now()))}ms'`);
          const matches = identitySourceSupportJob()
            ? await ensureBuildHeads(client, retained!, heads)
            : await retainOrdinaryProjectionHeadsOn(
                client,
                retained!,
                snapshot.subject,
                { partition, epoch: snapshot.owner.epoch, position: snapshot.owner.position },
                BigInt(snapshot.privacyPosition),
                heads,
              );
          await client.query(matches ? 'COMMIT' : 'ROLLBACK');
          return matches;
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            discardConnection(client, rollbackError as Error);
          }
          throw error;
        }
      });
      if (!retainedHeads) return { status: 'changed', frontier: request.frontier, cost };
    }
    if (!retained) return unready('metadata_missing', cost);

    const frontier: PublicFilterProjectionFrontier = {
      build: retained.build_id,
      generation: BigInt(retained.generation),
      continuation: cursorToken(config.routeKey, retained.build_id, BigInt(retained.generation), nextCursor),
    };
    const observation = sourceObservation(
      partition,
      retained.owner_epoch,
      BigInt(retained.source_position),
      snapshot.subject,
      retained.terminal_id,
    );
    const stepHeads = new Map(heads);
    if (nextCursor.phase === 'selection' || identitySourceSupportJob()) {
      return { status: 'progress', source: observation, records, repairLocators, frontier, cost };
    }
    const page = await readProjectionDependencyHeads(
      config.pool,
      retained.build_id,
      nextCursor.partition,
      request.inputLimit,
      deadline,
      cost,
    );
    if (!page)
      return request.frontier
        ? { status: 'changed', frontier: request.frontier, cost }
        : unready('dependency_pending', cost);
    for (const head of page.heads) stepHeads.set(head.partition, head);
    nextCursor = { phase: 'dependencies', partition: page.after };
    const finalFrontier: PublicFilterProjectionFrontier = {
      ...frontier,
      continuation: cursorToken(config.routeKey, retained.build_id, BigInt(retained.generation), nextCursor),
    };
    if (!page.complete)
      return { status: 'progress', source: observation, records, repairLocators, frontier: finalFrontier, cost };
    const requiredHeads = [...stepHeads.values()].sort((left, right) => left.partition - right.partition);
    return {
      status: 'complete',
      source: observation,
      records,
      repairLocators,
      frontier: finalFrontier,
      requiredHeads,
      cost,
    };
  } catch (error) {
    if (isPostgresTransactionAbort(error)) return unready('dependency_pending', cost);
    if (accessPort.isUnavailable(error))
      return Date.now() >= deadline ? unavailable('deadline', cost) : unready('dependency_pending', cost);
    throw error;
  }
}

/**
 * Retain one exact Source page under the native Search repair lineage that produced it.
 * A retry resolves the original serialized page before inspecting mutable current rows.
 */
export async function readOriginalPublicFilterProjectionPage(
  config: Configuration,
  request: PublicFilterProjectionRequest,
  identity: PublicFilterProjectionReplayIdentity,
  accessPort: PublicFilterAccessBindingPort,
): Promise<PublicFilterProjectionPage> {
  const routed = routePartition(request.subject);
  if (
    !routed ||
    !UUID.test(identity.bootstrap) ||
    typeof identity.execution !== 'string' ||
    identity.execution.length < 1 ||
    identity.execution.length > 4096 ||
    (identity.predecessor !== null && !UUID.test(identity.predecessor))
  )
    throw new TypeError('Invalid retained projection identity');
  if (
    !Number.isInteger(request.inputLimit) ||
    request.inputLimit < 1 ||
    request.inputLimit > 1000 ||
    !Number.isSafeInteger(request.context.deadline) ||
    request.context.deadline <= Date.now() ||
    !validMeaning(request.meaning)
  )
    throw new TypeError('Invalid retained projection request');
  const requestKey = originalProjectionRequestDigest({
    identity,
    subject: request.subject,
    meaning: { digest: request.meaning.digest },
    inputLimit: request.inputLimit,
    frontier: request.frontier,
  });
  const values = {
    partition_no: 0,
    bootstrap: identity.bootstrap,
    execution: identity.execution,
    predecessor: identity.predecessor ?? '',
    route: routed.route,
    subject_id: request.subject,
    request_digest: requestKey,
  };
  const addCost = (page: PublicFilterProjectionPage, delta: Partial<PublicFilterCost>) => ({
    ...page,
    cost: {
      ...page.cost,
      inputKeys: page.cost.inputKeys + (delta.inputKeys ?? 0),
      candidates: page.cost.candidates + (delta.candidates ?? 0),
      accessPoints: page.cost.accessPoints + (delta.accessPoints ?? 0),
      dependencyPoints: page.cost.dependencyPoints + (delta.dependencyPoints ?? 0),
      engineSearches: page.cost.engineSearches + (delta.engineSearches ?? 0),
      engineIteratorSteps: page.cost.engineIteratorSteps + (delta.engineIteratorSteps ?? 0),
      outputSlots: page.cost.outputSlots + (delta.outputSlots ?? 0),
      resultWrites: page.cost.resultWrites + (delta.resultWrites ?? 0),
      frontierWrites: page.cost.frontierWrites + (delta.frontierWrites ?? 0),
    },
  });
  const lookup = () =>
    readRetainedPublicFilterProjectionPage(
      config.pool,
      {
        identity,
        subject: request.subject,
        meaning: { digest: request.meaning.digest },
        inputLimit: request.inputLimit,
        frontier: request.frontier,
      },
      request.context,
    );

  const retained = await lookup();
  if (retained) return addCost(retained, { inputKeys: 1 });

  const produced = await readPublicFilterProjectionPage(config, request, accessPort);
  if (produced.status !== 'progress' && produced.status !== 'complete') return addCost(produced, { inputKeys: 1 });
  const page = addCost(produced, { inputKeys: 1, frontierWrites: 1 });
  const pageData = encodeReplayValue(page);
  const inserted = await withConnection(config.pool, (client) =>
    nativeSourceQuery(client, writeOriginalPage, {
      ...values,
      page_data: pageData,
      page_digest: replayDigest(pageData),
    }),
  );
  if (inserted) return page;

  // A concurrent retry may have retained its page first. Use that exact winner and account for
  // the work performed by this losing producer without returning its mutable reconstruction.
  const winner = await lookup();
  if (!winner) throw new Error('Retained projection page disappeared');
  return addCost(winner, {
    inputKeys: produced.cost.inputKeys + 2,
    candidates: produced.cost.candidates,
    accessPoints: produced.cost.accessPoints,
    dependencyPoints: produced.cost.dependencyPoints,
    engineSearches: produced.cost.engineSearches,
    engineIteratorSteps: produced.cost.engineIteratorSteps,
    outputSlots: produced.cost.outputSlots,
    resultWrites: produced.cost.resultWrites,
    frontierWrites: produced.cost.frontierWrites,
  });
}
