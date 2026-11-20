import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { MAX_PAGE_COST, MAX_PAGE_READS } from '@rezics/composition';
import { BoundedReadDeadlineError, withBoundedReadConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { publicFilterCoverageKeys, PUBLIC_FILTER_CATALOGUE_TEXT_KEYS } from './public-filter-coverage-pending.ts';
import { hasPublicFilterMeaningShape } from './public-filter-source-contract.ts';
import { PUBLIC_FILTER_ACCOUNT_DOMAIN } from './public-filter-coverage-maintenance.ts';
import type { PublicCanonicalCaptureInput } from '../search/index.ts';
import type {
  PrivacyReductionObservation,
  PrivacyReductionObservationRequest,
  PublicFilterCost,
  PublicFilterDependencyKey,
  PrivacyReductionStart,
} from './public-filter-source-contract.ts';
import type {
  PublicFilterAccessBindingPort,
  PublicFilterSearchBindingPort,
  SourceBindingCustodyExecution as CustodyExecution,
  SourceBindingRetainedDefinition as CustodyRetainedDefinition,
} from './source-binding-port.ts';

import { readBookRole } from './public-filter-book-role.ts';

const statement = readFileSync(new URL('./public-filter-coverage-population.sql', import.meta.url), 'utf8');
// A sealed publication owns its coverage. The bootstrap constraint excludes a
// serving attachment when publication_job is set, and prepared cuts have no
// PIT withdrawals or own window. Keep the common binding and current probes.
const publicationStatement =
  statement
    .split('/* semantic.own-window */')[0]!
    .replace(
      /\/\* semantic\.attached-coverage \*\/[\s\S]*?\/\* semantic\.end-attached-coverage \*\//,
      `SELECT NULL::uuid AS job,NULL::uuid AS bootstrap,NULL::text AS registration,
        NULL::uuid AS definition,NULL::text AS consumer,NULL::bigint AS generation,
        NULL::bigint AS covered_generation,NULL::text AS coverage_root,NULL::text[] AS coverage_keys
      WHERE false`,
    )
    .replace(
      /\/\* semantic\.book-withdrawals \*\/[\s\S]*?\/\* semantic\.end-book-withdrawals \*\//,
      'AND scope.book_withdrawals IS NULL',
    ) +
  `\nSELECT b.*,EXISTS(SELECT 1 FROM pending) AS pending,EXISTS(SELECT 1 FROM fenced) AS fenced,
    coalesce((SELECT jsonb_agg(to_jsonb(h)) FROM heads h),'[]'::jsonb) AS heads,
    NOT EXISTS(SELECT 1 FROM pending) AND NOT EXISTS(SELECT 1 FROM fenced)
      AND NOT EXISTS(SELECT 1 FROM heads) AS admitted,
    0 AS own_homes,0 AS own_subjects,0 AS own_births,
    NULL::text AS inserted_start,NULL::text AS started_page,NULL::text AS finished_page,
    '[]'::jsonb AS page_children
  FROM binding b WHERE EXISTS (SELECT 1 FROM population)`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function nativePopulationStartId(locator: string): string {
  if (!locator.startsWith('population:') || !uuid.test(locator.slice(11)))
    throw new TypeError('Invalid native population start');
  return locator.slice(11);
}
type Cost = { -readonly [K in keyof PublicFilterCost]: PublicFilterCost[K] } & {
  statements: number;
  rows: number;
  bytes: number;
};
type Head = {
  phase: 'pending' | 'changed';
  source_home: number;
  source_epoch: number;
  current_epoch: number | null;
  position: string | null;
  population_fenced: boolean | null;
};
export type PopulationRequest = Extract<PrivacyReductionObservationRequest, { kind: 'population' }>;
export type PopulationBinding = {
  slot: number;
  observation: string;
  registration: string;
  queried: string;
  covered: string;
  consumer: string;
  definition: string;
  bootstrap: string;
  read_definition: string;
  bootstrap_consumer: string;
  snapshot_kind: string;
  book_withdrawals: unknown;
  covered_generation: string;
  source_id: string;
  configuration: string;
  owner_epoch: number;
  release_digest: string;
  capture: string;
  dependency_keys: PublicFilterDependencyKey[];
  coverage_keys: string[];
  start_generation: string | null;
  page_id: string | null;
  page_state: string | null;
  page_rounds: number | null;
  page_charged: number | null;
  page_ceiling: number | null;
  page_tail: string | null;
  tail_consumed: number | null;
  boundary: string | null;
  boundary_consumed: number | null;
  boundary_window: string | null;
  page_children: {
    id: string;
    execution: string;
    consumer_window: string | null;
    page_ordinal: number | null;
    page_parent: string | null;
    page_consumed: number | null;
    page_size: number | null;
    page_raw: number | null;
    page_status: string | null;
  }[];
};
type Row = PopulationBinding & {
  coverage_generation: string;
  incarnation: string;
  coverage_root: string;
  route_digest: string;
  execution: string | null;
  consumer_window: string | null;
  start_id: string | null;
  start_deadline: string | null;
  pending: boolean;
  fenced: boolean;
  admitted: boolean;
  inserted_start: string | null;
  started_page: string | null;
  finished_page: string | null;
  heads: Head[];
  own_homes: number;
  own_subjects: number;
  own_births: number;
};
export type PopulationProof = Pick<Row, 'pending' | 'fenced' | 'heads'>;
export type PopulationCost = Cost;
type PublicationPopulation = Readonly<{
  job: string;
  bootstrap: string;
  terminal: Readonly<{ step: string; root: string }>;
}>;

function validBindings(
  row: PopulationBinding,
  request: Extract<PrivacyReductionObservationRequest, { kind: 'population' }>,
  search: PublicFilterSearchBindingPort,
  completed?: Row,
  publication?: PublicationPopulation,
) {
  const q = request.queried;
  const retained = search.decodeState<{ digest: string; data: CustodyRetainedDefinition }>(row.definition);
  const definition = retained.data;
  const capture = search.decodeState<PublicCanonicalCaptureInput>(row.capture);
  search.catalogue(q.consumer, 'representation' in capture);
  const covered = search.decodeState<{ observation: string }>(row.covered);
  const expectedKeys = [
    ...publicFilterCoverageKeys(
      row.dependency_keys,
      'catalogueCoverage' in capture && capture.catalogueCoverage === true,
    ),
    ...('representation' in capture ? [PUBLIC_FILTER_ACCOUNT_DOMAIN] : []),
  ].sort();
  if (
    !hasPublicFilterMeaningShape(definition.meaning) ||
    (!('authority' in definition.meaning.release) && Object.keys(definition.meaning.release.types).length === 0) ||
    retained.digest !== createHash('sha256').update(search.encodeState(definition)).digest('hex') ||
    definition.readDefinition !== row.read_definition ||
    !isDeepStrictEqual(definition.source, {
      id: row.source_id,
      partition: 0,
      epoch: row.owner_epoch,
      configuration: row.configuration,
    }) ||
    definition.meaning.digest !== row.release_digest ||
    !isDeepStrictEqual(definition.capture, capture) ||
    !isDeepStrictEqual(definition.dependencyKeys, row.dependency_keys) ||
    !isDeepStrictEqual(expectedKeys, row.coverage_keys) ||
    !isDeepStrictEqual(search.decodeState(row.bootstrap_consumer), q.consumer) ||
    covered.observation !== `0:${row.bootstrap}` ||
    (row.book_withdrawals !== null &&
      (q.snapshot.kind !== 'pit' || !('bookTypeList' in capture) || capture.bookTypeList !== true)) ||
    row.snapshot_kind !== q.snapshot.kind ||
    row.queried !== search.encodeState(q) ||
    row.consumer !== search.encodeConsumer(q.consumer) ||
    q.consumer.meaningDigest !== row.release_digest ||
    q.consumer.readDefinition !== row.read_definition
  )
    return false;
  if (publication) {
    if (!completed || completed.execution === null || completed.consumer_window !== null || row.page_id !== null)
      return false;
    const execution = search.decodeState<CustodyExecution>(completed.execution);
    return (
      execution.id === request.execution &&
      isDeepStrictEqual(execution.start, request.start) &&
      Array.isArray(execution.ownRows) &&
      execution.ownRows.length === 0
    );
  }
  if (request.start !== null) {
    // Known relevant change is already sufficient to block; no own/child scan
    // is dispatched after this indexed fail-fast result.
    if (completed?.heads.length) return true;
    if (row.page_id !== null) {
      if (
        row.page_children.length !== row.page_rounds ||
        row.page_children.length < 1 ||
        row.page_children.length > 3 ||
        row.page_id !== nativePopulationStartId(request.start.observation) ||
        row.page_tail !== request.execution ||
        (row.page_state === 'sealed'
          ? completed !== undefined && completed.finished_page !== row.page_id
          : row.page_state !== 'finished')
      )
        return false;
      let parent = row.boundary;
      let previous = row.boundary_window === null ? null : search.decodeState<NativeWindow>(row.boundary_window);
      let charged = 0;
      for (const [index, child] of row.page_children.entries()) {
        if (
          !child.consumer_window ||
          child.page_ordinal !== index + 1 ||
          child.page_status !== 'complete' ||
          child.page_parent !== parent ||
          child.page_consumed === null ||
          child.page_size === null
        )
          return false;
        const execution = search.decodeState<CustodyExecution>(child.execution);
        const window = search.decodeState<NativeWindow>(child.consumer_window);
        const consumed = child.page_consumed;
        if (
          !validWindow(execution, window, request.start, 'representation' in capture) ||
          execution.id !== child.id ||
          window.parent !== parent ||
          consumed < 0 ||
          consumed > (previous?.raw.length ?? 0) ||
          window.rounds !== index + 1 ||
          window.raw.length > child.page_size ||
          window.raw.length !== child.page_raw ||
          window.consumed !== (previous?.consumed ?? 0) + consumed ||
          (index === 0 && consumed !== row.boundary_consumed) ||
          !isDeepStrictEqual(
            window.before,
            previous === null
              ? definition.capture.after
              : consumed === 0
                ? previous.before
                : previous.raw[consumed - 1]!.sort,
          )
        )
          return false;
        charged += window.raw.length;
        if (window.charged !== charged) return false;
        parent = child.id;
        previous = window;
      }
      return (
        parent === request.execution &&
        charged === row.page_charged &&
        charged <= row.page_ceiling! &&
        row.tail_consumed !== null &&
        row.tail_consumed >= 0 &&
        row.tail_consumed <= previous!.raw.length
      );
    }
    if (!completed || completed.execution === null || completed.consumer_window === null) return false;
    const execution = search.decodeState<CustodyExecution>(completed.execution);
    const window = search.decodeState<NativeWindow>(completed.consumer_window);
    if (
      execution.id !== request.execution ||
      !validWindow(execution, window, request.start, 'representation' in capture) ||
      !Number.isInteger(window.rounds) ||
      window.rounds < 1 ||
      window.rounds > 3
    )
      return false;
  }
  return true;
}

type NativeWindow = {
  raw: (
    | { id: string; sort: unknown }
    | { key: { id: string; owner: string; kind: string; route: number }; sort: unknown }
  )[];
  parent: string | null;
  consumed: number;
  before: unknown;
  rounds: number;
  charged: number;
};
function validWindow(execution: CustodyExecution, window: NativeWindow, start: PrivacyReductionStart, mixed: boolean) {
  return (
    isDeepStrictEqual(execution.start, start) &&
    Array.isArray(window.raw) &&
    window.raw.length <= 200 &&
    Array.isArray(execution.ownRows) &&
    execution.ownRows.length === window.raw.length &&
    execution.ownRows.every((own, index) => {
      const raw = window.raw[index]!;
      if (!uuid.test(own.original) || !uuid.test(own.terminal)) return false;
      if (!('key' in raw)) return !mixed && !own.metadataKind && raw.id === own.original;
      const key = raw.key;
      if (!mixed || key.id !== own.original) return false;
      if (key.owner === 'semantic') return own.metadataKind === undefined;
      if (own.terminal !== own.original) return false;
      if (key.owner === 'accounts') return key.kind === 'account' && own.metadataKind === undefined;
      return (
        own.metadataKind === key.kind &&
        routeOf(key.id) === key.route &&
        ((key.owner === 'commerce' && key.kind === 'collection') ||
          (key.owner === 'content' && (key.kind === 'review' || key.kind === 'space')))
      );
    })
  );
}

function reservePopulationRole(final: boolean): Cost {
  return {
    inputKeys: 64,
    candidates: 0,
    accessPoints: 0,
    dependencyPoints: 32,
    engineSearches: 0,
    engineIteratorSteps: 0,
    outputSlots: 0,
    resultWrites: final ? 0 : 1,
    frontierWrites: 0,
    statements: 0,
    rows: 32,
    bytes: 0,
  };
}

function populationResult(
  row: Row,
  request: PopulationRequest,
  cost: Cost,
  start: string | null,
  pageId: string | null,
  search: PublicFilterSearchBindingPort,
  publication?: PublicationPopulation,
): PrivacyReductionObservation {
  // The single population CTE checks the common withdrawals and reads the head
  // once. Births, keyed home controls and own Subjects are per retained window.
  const withdrawals = row.slot === 0 && Array.isArray(row.book_withdrawals) ? row.book_withdrawals.length : 0;
  const headsRead = row.slot === 0 ? row.heads.length : 0;
  cost.inputKeys += 4 * withdrawals + 4 * row.own_births;
  cost.dependencyPoints += 3 * withdrawals + 2 * row.own_births;
  cost.rows += 3 * withdrawals + 2 * row.own_births;
  cost.inputKeys += row.coverage_keys.length + 5 * row.own_homes + 2 * row.own_subjects;
  cost.dependencyPoints += 2 * headsRead + 2 * row.own_homes + row.own_subjects;
  cost.rows += 2 * headsRead + 2 * row.own_homes + row.own_subjects;
  const final = request.start !== null;
  if (
    cost.inputKeys > 1000 ||
    cost.bytes > 4 * 1024 * 1024 ||
    !validBindings(row, request, search, row, publication) ||
    row.pending ||
    row.fenced ||
    row.heads.some(
      (head) =>
        head.current_epoch === null ||
        head.position === null ||
        head.population_fenced ||
        head.current_epoch !== head.source_epoch,
    ) ||
    (!final && row.heads.length > 0) ||
    (row.heads.length === 0 &&
      (!row.admitted || (!final && (row.inserted_start !== start || (pageId !== null && row.started_page !== pageId)))))
  )
    return { status: 'unready', reason: 'metadata_missing', cost };
  const heads = row.heads.map((head) => ({
    phase: head.phase,
    head: { partition: head.source_home, epoch: head.current_epoch!, position: BigInt(head.position!) },
  }));
  return {
    status: 'observed',
    coverage: 'all_native_homes',
    start: publication ? request.start! : { observation: `population:${start}` },
    routingComplete: true,
    unacknowledged: heads.filter((head) => head.phase === 'pending').map((head) => head.head),
    changed: heads.filter((head) => head.phase === 'changed').map((head) => head.head),
    blocking: heads.map((head) => ({ ...head, scope: 'filter_or_order' })),
    cost,
  };
}

/** Each role reads its own current snapshot. Grouped Book pages bind every
 * original plan before sharing publication and keyed owner probes.
 */
async function readPopulations(
  pool: Pool,
  routeKey: Uint8Array,
  requests: readonly PopulationRequest[],
  search: PublicFilterSearchBindingPort,
  access: PublicFilterAccessBindingPort,
  publication?: PublicationPopulation,
  bookPage = true,
): Promise<PrivacyReductionObservation[]> {
  if (!requests.length || requests.length > MAX_PAGE_READS) throw new RangeError('Invalid population page width');
  const final = requests[0]!.start !== null;
  const costs = requests.map((request) => reservePopulationRole(request.start !== null));
  const unready = () =>
    costs.map((cost) => ({ status: 'unready' as const, reason: 'metadata_missing' as const, cost }));
  let dispatched = false;
  let accounted = false;
  let deadlineSelected = false;
  const deadline = Math.min(...requests.map((request) => request.context.deadline));
  const requireDeadline = () => {
    try {
      access.requireDeadline(deadline);
    } catch (error) {
      deadlineSelected = true;
      throw error;
    }
  };
  try {
    requireDeadline();
    if (publication && bookPage) return unready();
    const admitted = requests.map((request) => structuredClone(request));
    const members = admitted.map((request, slot) => {
      const q = request.queried;
      if (
        !Number.isSafeInteger(request.context.deadline) ||
        (request.start !== null) !== final ||
        (final ? typeof request.execution !== 'string' || !request.execution : request.execution !== undefined) ||
        !q ||
        !/^0:/.test(q.snapshot.observation)
      )
        throw new TypeError('Invalid native population role');
      if (
        publication &&
        (request.start?.observation !== `0:${publication.bootstrap}` ||
          q.snapshot.kind !== 'prepared' ||
          q.snapshot.build !== request.start.observation ||
          !uuid.test(publication.job) ||
          !uuid.test(publication.bootstrap) ||
          !uuid.test(publication.terminal.step) ||
          !/^[0-9a-f]{64}$/.test(publication.terminal.root))
      )
        throw new TypeError('Invalid publication population');
      const pageId = final ? null : search.coverageStart(requests[slot]!.context);
      if (bookPage && (q.snapshot.kind !== 'pit' || (!final && pageId === null)))
        throw new TypeError('A composed population requires native pages');
      const start = publication
        ? null
        : final
          ? nativePopulationStartId(request.start!.observation)
          : (pageId ?? randomUUID());
      if (pageId !== null || final) costs[slot]!.resultWrites++;
      return {
        slot,
        observation: q.snapshot.observation,
        queried: search.encodeState(q),
        consumer: search.encodeConsumer(q.consumer),
        physical_target: q.consumer.physicalTarget,
        incarnation: q.consumer.incarnation,
        execution_id: request.execution ?? null,
        start_id: start,
        deadline: request.context.deadline,
        page_id: pageId,
        publication_job: publication?.job,
        publication_bootstrap: publication?.bootstrap,
        terminal_step: publication?.terminal.step,
        terminal_root: publication?.terminal.root,
      };
    });
    if (
      new Set(members.map((m) => m.observation)).size !== members.length ||
      new Set(members.map((m) => m.start_id)).size !== members.length
    )
      return unready();
    if (bookPage) {
      for (const cost of costs) {
        cost.inputKeys = cost.dependencyPoints = cost.rows = cost.resultWrites = 0;
      }
      dispatched = true;
      const observations = await withRequestDeadline(deadline, () =>
        withBoundedReadConnection(
          pool,
          deadline,
          (client) =>
            readBookRole(
              client,
              admitted,
              members,
              costs,
              createHash('sha256').update(routeKey).digest('hex'),
              deadline,
              search,
              (row, request) => validBindings(row, request, search),
            ),
          { isUncertainSettledQueryError: () => true },
        ),
      );
      accounted = true;
      requireDeadline();
      return observations;
    }
    // The publication seal binds one prepared execution with no page or window.
    // validBindings still decodes it and demands the exact start and empty own rows.
    const sql = (publication ? publicationStatement : statement).replace(
      'semantic.privacy-role',
      final ? 'semantic.privacy-final' : 'semantic.privacy-start',
    );
    const values = [
      JSON.stringify(members),
      Date.now(),
      createHash('sha256').update(routeKey).digest('hex'),
      [...PUBLIC_FILTER_CATALOGUE_TEXT_KEYS],
      members.length,
      MAX_PAGE_COST,
    ];
    const shared = costs[0]!;
    shared.statements++;
    shared.bytes = Buffer.byteLength(sql) + Buffer.byteLength(search.encodeState(values));
    dispatched = true;
    const result = await withRequestDeadline(deadline, () =>
      withBoundedReadConnection(
        pool,
        deadline,
        (client) => {
          const query = { text: sql, values, query_timeout: Math.max(1, deadline - Date.now()) };
          return client.query<Row>(query);
        },
        { isUncertainSettledQueryError: () => true },
      ),
    );
    shared.bytes += Buffer.byteLength(search.encodeState(result.rows));
    if (!result.rows.length) {
      accounted = true;
      requireDeadline();
      return unready();
    }
    if (result.rows.length !== 1 || result.rows[0]!.slot !== 0)
      throw new TypeError('Incomplete native population binding');
    const observations = result.rows.map((row, slot) => {
      const member = members[slot]!;
      return populationResult(row, admitted[slot]!, costs[slot]!, member.start_id, member.page_id, search, publication);
    });
    accounted = true;
    requireDeadline();
    return observations;
  } catch (error) {
    if (dispatched && !accounted) {
      // Unknown work on any submitted member keeps the full original reservation.
      for (const cost of costs) {
        if (bookPage) cost.resultWrites = Math.max(cost.resultWrites, final ? 1 : 2);
        cost.inputKeys = Math.max(cost.inputKeys, 1000);
        cost.dependencyPoints = Math.max(cost.dependencyPoints, 32 + 468 + 4);
        cost.rows = Math.max(cost.rows, 32 + 468 + 4);
      }
    }
    if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) return unready();
    if (
      error instanceof BoundedReadDeadlineError ||
      access.classifyUnavailability(error) !== undefined ||
      (error && typeof error === 'object' && 'code' in error)
    )
      return costs.map((cost) => ({
        status: 'unavailable',
        reason: deadlineSelected || error instanceof BoundedReadDeadlineError ? 'deadline' : 'dependency_unavailable',
        cost,
      }));
    throw error;
  }
}

export function readPublicFilterPagePopulations(
  pool: Pool,
  routeKey: Uint8Array,
  requests: readonly PopulationRequest[],
  search: PublicFilterSearchBindingPort,
  access: PublicFilterAccessBindingPort,
) {
  return readPopulations(pool, routeKey, requests, search, access);
}

export async function readPublicFilterPopulation(
  pool: Pool,
  routeKey: Uint8Array,
  request: PopulationRequest,
  search: PublicFilterSearchBindingPort,
  access: PublicFilterAccessBindingPort,
  publication?: PublicationPopulation,
): Promise<PrivacyReductionObservation> {
  const [result] = await readPopulations(pool, routeKey, [request], search, access, publication, false);
  return result!;
}
