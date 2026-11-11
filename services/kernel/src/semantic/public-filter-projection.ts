import { createHash, createHmac, randomUUID } from 'node:crypto';
import { releaseDigest, type Release } from '@rezics/definitions';
import { facetProperties } from '@rezics/filter';
import type { Source } from '@rezics/definitions/bulk';
import type { Pool, PoolClient } from 'pg';
import type { AccessCheck } from '../access/index.ts';
import { mintReadTime, type AuthoritativeTime } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { subjectReadEligibility } from './eligibility.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import { readFences, type SourceFenceTuple } from '../content/index.ts';
import { sourceTuple } from './fences.ts';
import { GLOBAL_SUBJECT_CONTEXT as GLOBAL_CONTEXT } from './contract/subject-values.ts';
import { factDataTypes, resolveItem, type FactRow, type Statement } from './item.ts';
import { indexedStatement } from './search-source.ts';
import { readRelease } from './definition-release-read.ts';
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
  PublicFilterSourceFactory,
} from './public-filter-source-contract.ts';
import type { PublicFilterAccessBindingPort } from './source-binding-port.ts';
import readReleases from './search-source-releases.sql';
import readSubjects from './search-source-subjects.sql';
import readPrivacyHead from './public-filter-projection-head-read.sql';
import readBuild from './public-filter-projection-build-read.sql';
import startBuild from './public-filter-projection-build-start.sql';
import retireBuildHeads from './public-filter-projection-build-retire.sql';
import readPage from './public-filter-projection-page.sql';
import readRetainedHeadPage from './public-filter-projection-head-page.sql';
import readCurrentRetainedHead from './public-filter-projection-head-current.sql';
import upsertRetainedHeads from './public-filter-projection-head-upsert.sql';
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
type PageCursor =
  | { phase: 'selection'; property: string; slot: string; candidate: string }
  | { phase: 'dependencies'; partition: number };
type CursorResult = PageCursor | null | false;
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
  meaning: Pick<PublicFilterProjectionMeaning, 'digest' | 'type'>;
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
      meaning: { digest: request.meaning.digest, type: request.meaning.type },
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
    !UUID.test(request.identity.bootstrap) ||
    !request.identity.execution ||
    request.identity.execution.length > 4096 ||
    (request.identity.predecessor !== null && !UUID.test(request.identity.predecessor)) ||
    !Number.isInteger(request.inputLimit) ||
    request.inputLimit < 1 ||
    request.inputLimit > 1000
  )
    throw new TypeError('Invalid original projection page locator');
  const stored = await withConnection(pool, (client) =>
    readOriginalPage.run(client, {
      partition_no: 0,
      bootstrap: request.identity.bootstrap,
      execution: request.identity.execution,
      predecessor: request.identity.predecessor ?? '',
      route: routed.route,
      subject_id: request.subject,
      request_digest: originalProjectionRequestDigest(request),
    }),
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
    meaning: Pick<PublicFilterProjectionMeaning, 'digest' | 'type'>;
  }>,
  context: Readonly<{ deadline: number }>,
): Promise<boolean> {
  const { page, meaning } = structuredClone(request);
  const deadline = context.deadline;
  requireAccessDeadline(deadline);
  const routed = routePartition(page.source.subject);
  if (!routed) return false;
  const build = rows(
    await readBuild.run(pool, {
      partition_no: routed.partition,
      route: routed.route,
      subject_id: page.source.subject,
      meaning_digest: meaning.digest,
      meaning_type: meaning.type,
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
  )
    return false;
  const terminal = routePartition(page.source.terminal);
  if (!terminal) return false;
  const homes = new Set([routed.partition, terminal.partition]);
  const dependencies = [
    ...page.repairLocators.flatMap((locator) => locator.dependencies),
    ...page.records.flatMap((record) => record.dependencies),
  ];
  for (const dependency of dependencies) {
    // A Semantic privacy head cannot stand in for an original Account tuple.
    // Until that tuple is retained by this projection build, consent replay is
    // unknown and cannot produce a verified repair receipt.
    if (dependency.kind === 'consent') return false;
    const route = dependency.kind === 'sourceTuple' ? dependency.tuple.route : dependency.route;
    if (!Number.isInteger(route) || route < 0 || route > 65535) return false;
    homes.add(partitionOf(route));
  }
  // These are the original build's keyed retained heads, not a current catalogue
  // enumeration or a newly captured replacement for the original Source page.
  for (const partition of homes) {
    requireAccessDeadline(deadline);
    const head = await readReplayHead.run(pool, { build_id: page.frontier.build, partition_no: partition });
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
): PublicFilterProjectionPage => ({ status: 'unready', reason, cost });
const unavailable = (
  reason: 'missing_owner' | 'moved' | 'deadline' | 'dependency_unavailable',
  cost = emptyCost(),
): PublicFilterProjectionPage => ({ status: 'unavailable', reason, cost });

function validMeaning(meaning: PublicFilterProjectionMeaning): boolean {
  return (
    !!meaning &&
    typeof meaning.digest === 'string' &&
    releaseDigest(meaning.release) === meaning.digest &&
    typeof meaning.type === 'string' &&
    Object.hasOwn(meaning.release.types, meaning.type)
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
    if (
      !object(value) ||
      (value.phase === 'selection' &&
        (typeof value.property !== 'string' ||
          value.property.length < 1 ||
          value.property.length > 256 ||
          typeof value.slot !== 'string' ||
          !UUID.test(value.slot) ||
          typeof value.candidate !== 'string' ||
          !UUID.test(value.candidate))) ||
      (value.phase === 'dependencies' &&
        (!Number.isInteger(value.partition) ||
          (value.partition as number) < -1 ||
          (value.partition as number) > 4095)) ||
      (value.phase !== 'selection' && value.phase !== 'dependencies')
    )
      return false;
    return value.phase === 'selection'
      ? {
          phase: 'selection',
          property: value.property as string,
          slot: value.slot as string,
          candidate: value.candidate as string,
        }
      : { phase: 'dependencies', partition: value.partition as number };
  } catch {
    return false;
  }
}

async function inSnapshot<T>(pool: Pool, deadline: number, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withConnection(pool, async (client) => {
    requireAccessDeadline(deadline);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await client.query(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(deadline - Date.now()))}ms'`);
      const result = await work(client);
      requireAccessDeadline(deadline);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(client, rollbackError as Error);
      }
      requireAccessDeadline(deadline);
      throw error;
    }
  });
}

async function storedMeaningRelease(pool: Pool, digest: string, deadline: number): Promise<Release | null> {
  return inSnapshot(pool, deadline, async (client) => {
    const owner = await readPartition(client, 0);
    if (!owner || owner.writeState !== 'active') return null;
    const found = rows(await readReleases.run(client, { route: 0, digests: [digest] })) as {
      digest: string;
      body: unknown;
    }[];
    const body = found.find((row) => row.digest === digest)?.body;
    // Binding accepts persisted composite digests through the release owner.
    // Resolve that same immutable authority instead of treating a missing base
    // release row as missing meaning or trusting the caller's release body.
    if (body === undefined) return readRelease(client, digest);
    if (!object(body)) return null;
    try {
      return releaseDigest(body as unknown as Release) === digest ? (body as unknown as Release) : null;
    } catch {
      return null;
    }
  });
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
  epochs: Map<number, number>;
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
): Promise<IdentityRead> {
  const states = new Map<string, IdentityState>();
  const heads = new Map<number, PrivacyReductionHead>();
  const epochs = new Map<number, number>();
  let complete = true;
  let pending = [...new Set(ids)];
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
        const privacy = await readPrivacyHead.run(client, { partition_no: partition });
        if (!privacy) return null;
        const found = rows(
          await readSubjects.run(client, {
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
      epochs.set(partition, result.owner.epoch);
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
  return { states, heads, epochs, complete };
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

async function ensureBuildHeads(
  client: PoolClient,
  build: string,
  heads: ReadonlyMap<number, PrivacyReductionHead>,
): Promise<boolean> {
  if (heads.size === 0) return true;
  const retained = rows(
    await upsertRetainedHeads.run(client, {
      build_id: build,
      heads: [...heads.values()].map((head) => ({
        partition_no: head.partition,
        owner_epoch: head.epoch,
        position: head.position.toString(),
      })),
    }),
  );
  return retained.length === heads.size;
}

async function saveBuild(
  config: Configuration,
  subject: string,
  meaning: PublicFilterProjectionMeaning,
  observation: PublicFilterProjectionObservation,
  privacyPosition: bigint,
  build: string,
  heads: ReadonlyMap<number, PrivacyReductionHead>,
  deadline: number,
): Promise<BuildRow | null> {
  const route = routeOf(subject)!;
  return withConnection(config.pool, async (client) => {
    requireAccessDeadline(deadline);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      await client.query(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(deadline - Date.now()))}ms'`);
      const owner = await readPartition(client, observation.partition);
      const privacy = await readPrivacyHead.run(client, { partition_no: observation.partition });
      const current = rows(
        await readSubjects.run(client, {
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
        !current ||
        current.id !== subject ||
        current.current_revision !== observation.revision ||
        current.securityRevision !== observation.securityRevision ||
        current.currentRelease !== observation.currentRelease
      ) {
        await client.query('ROLLBACK');
        return null;
      }
      await retireBuildHeads.run(client, { partition_no: observation.partition, subject_id: subject });
      const created = rows(
        await startBuild.run(client, {
          partition_no: observation.partition,
          route,
          subject_id: subject,
          meaning_digest: meaning.digest,
          meaning_type: meaning.type,
          build_id: build,
          owner_epoch: observation.epoch,
          source_position: observation.position.toString(),
          privacy_position: privacyPosition.toString(),
          terminal_id: observation.terminal,
          subject_revision: observation.revision,
          security_revision: observation.securityRevision,
          current_release: observation.currentRelease,
        }),
      )[0] as BuildRow | undefined;
      if (!created) throw new Error('Native projection build was not retained');
      if (!(await ensureBuildHeads(client, created.build_id, heads))) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query('COMMIT');
      return {
        ...created,
        owner_epoch: observation.epoch,
        source_position: observation.position.toString(),
        privacy_position: privacyPosition.toString(),
        terminal_id: observation.terminal,
        subject_revision: observation.revision,
        security_revision: observation.securityRevision,
        current_release: observation.currentRelease,
      } as BuildRow;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(client, rollbackError as Error);
      }
      requireAccessDeadline(deadline);
      throw error;
    }
  });
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
  const deadline = request.context.deadline;
  const { route, partition } = routed;

  type SourceWindow = {
    owner: NonNullable<Awaited<ReturnType<typeof readPartition>>>;
    subject: SubjectRow;
    privacyPosition: string;
    time: AuthoritativeTime;
    build: BuildRow | null;
    rows: SelectedRow[];
  };

  try {
    const pinnedRelease = await storedMeaningRelease(config.pool, request.meaning.digest, deadline);
    if (!pinnedRelease) return unready('metadata_missing', cost);
    const meaning = { ...request.meaning, release: pinnedRelease };
    const snapshot = await inSnapshot(
      config.pool,
      deadline,
      async (client): Promise<SourceWindow | PublicFilterProjectionPage> => {
        const owner = await readPartition(client, partition);
        if (!owner) return unavailable('missing_owner', cost);
        if (owner.writeState === 'moved') return unavailable('moved', cost);
        if (owner.writeState !== 'active') return unready('owner_pending', cost);

        const sourceRows = rows(
          await readSubjects.run(client, { partition_no: partition, routes: [route], subject_ids: [request.subject] }),
        ) as SubjectRow[];
        const subject = sourceRows[0];
        if (!subject) return unavailable('missing_owner', cost);
        if (!subject.selection_ready) return unready('owner_pending', cost);
        if (!subject.current_revision || !subject.currentRelease) return unready('metadata_missing', cost);
        const privacy = await readPrivacyHead.run(client, { partition_no: partition });
        if (!privacy) return unready('metadata_missing', cost);
        const time = await mintReadTime(client, config.clock);
        const buildRows = request.frontier
          ? rows(
              await readBuild.run(client, {
                partition_no: partition,
                route,
                subject_id: request.subject,
                meaning_digest: meaning.digest,
                meaning_type: meaning.type,
              }),
            )
          : [];
        const build = (buildRows[0] as BuildRow | undefined) ?? null;
        if (
          request.frontier &&
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

        const selectionPhase = cursor?.phase !== 'dependencies';
        const afterCursor = cursor?.phase === 'selection' ? cursor : null;
        const properties = facetProperties(meaning.release, [subject.type]);
        const selected = selectionPhase
          ? (rows(
              await readPage.run(client, {
                partition_no: partition,
                route,
                subject_id: request.subject,
                properties,
                after_property: afterCursor?.property ?? '',
                after_slot: afterCursor?.slot ?? ZERO_UUID,
                after_candidate: afterCursor?.candidate ?? ZERO_UUID,
                input_limit: request.inputLimit,
              }),
            ) as SelectedRow[])
          : [];
        cost.inputKeys = Math.max(1, selected.length);
        cost.candidates = selected.length;
        return { owner, subject, privacyPosition: privacy.position, time, build, rows: selected };
      },
    );
    if ('status' in snapshot) return snapshot;

    let nextCursor: PageCursor =
      cursor?.phase === 'dependencies'
        ? cursor
        : snapshot.rows.length === request.inputLimit
          ? {
              phase: 'selection',
              property: snapshot.rows.at(-1)!.property,
              slot: snapshot.rows.at(-1)!.slot_id,
              candidate: snapshot.rows.at(-1)!.candidate_id,
            }
          : { phase: 'dependencies', partition: -1 };
    const pageRows = snapshot.rows;
    const releaseCache = new Map<string, Release | null>([[meaning.digest, meaning.release]]);
    const prepared = new Map<SelectedRow, { statement: Statement; ids: string[]; tuple: SourceFenceTuple | null }>();
    const targetIds = new Set<string>([request.subject]);
    const tupleList: SourceFenceTuple[] = [];
    const repairLocators: import('./public-filter-source-contract.ts').PublicFilterRepairLocator[] = [];
    let metadataMissing = false;

    const missingDigests = [...new Set(pageRows.map(({ release }) => release))].filter(
      (digest) => !releaseCache.has(digest),
    );
    if (missingDigests.length) {
      const releases = await withConnection(config.pool, async (client) => {
        requireAccessDeadline(deadline);
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          await client.query(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(deadline - Date.now()))}ms'`);
          const owner = await readPartition(client, 0);
          if (!owner || owner.writeState !== 'active') {
            await client.query('ROLLBACK');
            return null;
          }
          const found = rows(await readReleases.run(client, { route: 0, digests: missingDigests })) as {
            digest: string;
            body: unknown;
          }[];
          const result = new Map<string, Release>();
          for (const row of found) {
            try {
              if (object(row.body) && releaseDigest(row.body as unknown as Release) === row.digest)
                result.set(row.digest, row.body as unknown as Release);
            } catch {
              // A malformed stored release is unresolved metadata, never an empty facet.
            }
          }
          const storedDigests = new Set(found.map((row) => row.digest));
          for (const digest of missingDigests) {
            if (storedDigests.has(digest)) continue;
            const release = await readRelease(client, digest);
            if (release) result.set(digest, release);
          }
          requireAccessDeadline(deadline);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            discardConnection(client, rollbackError as Error);
          }
          requireAccessDeadline(deadline);
          throw error;
        }
      });
      if (!releases) return unready('metadata_missing', cost);
      for (const digest of missingDigests) releaseCache.set(digest, releases.get(digest) ?? null);
    }

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

    const identities = await readPublicIdentities(config, accessPort, [...targetIds], snapshot.time, deadline, cost);
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
        const privacy = await readPrivacyHead.run(client, { partition_no: home });
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
      identities.epochs.set(home, result.owner.epoch);
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

    const currentSource = await inSnapshot(config.pool, deadline, async (client) => {
      const owner = await readPartition(client, partition);
      const privacy = await readPrivacyHead.run(client, { partition_no: partition });
      const currentRows = rows(
        await readSubjects.run(client, { partition_no: partition, routes: [route], subject_ids: [request.subject] }),
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

    const heads = new Map(identities.heads);
    heads.set(partition, {
      partition,
      epoch: snapshot.owner.epoch,
      position: BigInt(snapshot.privacyPosition),
    });
    let retained = snapshot.build;
    if (!request.frontier) {
      const initialObservation = sourceObservation(
        partition,
        snapshot.owner.epoch,
        snapshot.owner.position,
        snapshot.subject,
        sourceIdentity.terminal,
      );
      retained = await saveBuild(
        config,
        request.subject,
        meaning,
        initialObservation,
        BigInt(snapshot.privacyPosition),
        randomUUID(),
        heads,
        deadline,
      );
      if (!retained) return unready('dependency_pending', cost);
      cost.frontierWrites++;
    } else if (retained) {
      const retainedHeads = await withConnection(config.pool, async (client) => {
        requireAccessDeadline(deadline);
        await client.query('BEGIN');
        try {
          await client.query(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(deadline - Date.now()))}ms'`);
          const matches = await ensureBuildHeads(client, retained!.build_id, heads);
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
    let complete = false;
    if (nextCursor.phase === 'selection') {
      return { status: 'progress', source: observation, records, repairLocators, frontier, cost };
    }
    const dependencyCursor = nextCursor;
    const retainedHeads = rows(
      await inSnapshot(config.pool, deadline, (client) =>
        readRetainedHeadPage.run(client, {
          build_id: retained.build_id,
          after_partition: dependencyCursor.partition,
          input_limit: request.inputLimit,
        }),
      ),
    ) as StoredHead[];
    cost.inputKeys = Math.max(cost.inputKeys, retainedHeads.length || 1);
    cost.dependencyPoints += retainedHeads.length;
    for (const expected of retainedHeads) {
      const current = await inSnapshot(config.pool, deadline, (client) =>
        readCurrentRetainedHead.run(client, { partition_no: expected.partition_no }),
      );
      if (
        !current ||
        current.write_state !== 'active' ||
        current.epoch !== expected.owner_epoch ||
        BigInt(current.position) !== BigInt(expected.position)
      )
        return request.frontier
          ? { status: 'changed', frontier: request.frontier, cost }
          : unready('dependency_pending', cost);
      stepHeads.set(expected.partition_no, {
        partition: expected.partition_no,
        epoch: current.epoch,
        position: BigInt(current.position),
      });
    }
    complete = retainedHeads.length < request.inputLimit;
    if (retainedHeads.length > 0) nextCursor = { phase: 'dependencies', partition: retainedHeads.at(-1)!.partition_no };
    const finalFrontier: PublicFilterProjectionFrontier = {
      ...frontier,
      continuation: cursorToken(config.routeKey, retained.build_id, BigInt(retained.generation), nextCursor),
    };
    if (!complete)
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
    meaning: { digest: request.meaning.digest, type: request.meaning.type },
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
        meaning: { digest: request.meaning.digest, type: request.meaning.type },
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
    writeOriginalPage.run(client, { ...values, page_data: pageData, page_digest: replayDigest(pageData) }),
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
