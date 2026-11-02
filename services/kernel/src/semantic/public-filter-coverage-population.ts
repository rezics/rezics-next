import { publicFilterCatalogue } from '../search/discovery-catalogue.ts';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { classifyUnavailability, requireAccessDeadline } from '../access/unavailable.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import {
  decodePublicFilterNativeState as decode,
  encodePublicFilterNativeState as encode,
} from '../search/public-filter-custody.ts';
import type { CustodyRetainedDefinition, CustodyExecution } from '../search/public-filter-custody-contract.ts';
import { publicFilterCoverageKeys } from './public-filter-coverage-pending.ts';
import { publicFilterCoverageStart } from '../search/public-filter-coverage-page.ts';
import { PUBLIC_FILTER_ACCOUNT_DOMAIN } from './public-filter-coverage-maintenance.ts';
import type { PublicCanonicalCaptureInput } from '../search/public-filter-consumer-contract.ts';
import type {
  PrivacyReductionObservation,
  PrivacyReductionObservationRequest,
  PublicFilterCost,
  PublicFilterDependencyKey,
  PrivacyReductionStart,
} from './public-filter-source-contract.ts';

const statement = readFileSync(new URL('./public-filter-coverage-population.sql', import.meta.url), 'utf8');
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
type Row = {
  observation: string;
  registration: string;
  queried: string;
  covered: string;
  consumer: string;
  definition: string;
  coverage_generation: string;
  incarnation: string;
  bootstrap: string;
  read_definition: string;
  bootstrap_consumer: string;
  snapshot_kind: string;
  covered_generation: string;
  coverage_root: string;
  source_id: string;
  configuration: string;
  owner_epoch: number;
  route_digest: string;
  release_digest: string;
  subject_type: string;
  capture: string;
  dependency_keys: PublicFilterDependencyKey[];
  coverage_keys: string[];
  execution: string | null;
  consumer_window: string | null;
  start_id: string | null;
  start_generation: string | null;
  start_deadline: string | null;
  pending: boolean;
  fenced: boolean;
  admitted: boolean;
  inserted_start: string | null;
  started_page: string | null;
  finished_page: string | null;
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
  heads: Head[];
  own_homes: number;
  own_subjects: number;
};
function validBindings(row: Row, request: Extract<PrivacyReductionObservationRequest, { kind: 'population' }>) {
  const q = request.queried;
  const retained = decode<{ digest: string; data: CustodyRetainedDefinition }>(row.definition);
  const definition = retained.data;
  const capture = decode<PublicCanonicalCaptureInput>(row.capture);
  publicFilterCatalogue(q.consumer, 'representation' in capture);
  const covered = decode<{ observation: string }>(row.covered);
  const expectedKeys = [
    ...publicFilterCoverageKeys(row.dependency_keys),
    ...('representation' in capture ? [PUBLIC_FILTER_ACCOUNT_DOMAIN] : []),
  ].sort();
  if (
    retained.digest !== createHash('sha256').update(encode(definition)).digest('hex') ||
    definition.readDefinition !== row.read_definition ||
    !isDeepStrictEqual(definition.source, {
      id: row.source_id,
      partition: 0,
      epoch: row.owner_epoch,
      configuration: row.configuration,
    }) ||
    definition.meaning.digest !== row.release_digest ||
    definition.meaning.type !== row.subject_type ||
    !isDeepStrictEqual(definition.capture, capture) ||
    !isDeepStrictEqual(definition.dependencyKeys, row.dependency_keys) ||
    !isDeepStrictEqual(expectedKeys, row.coverage_keys) ||
    !isDeepStrictEqual(decode(row.bootstrap_consumer), q.consumer) ||
    covered.observation !== `0:${row.bootstrap}` ||
    row.snapshot_kind !== q.snapshot.kind ||
    row.queried !== encode(q) ||
    row.consumer !== encode(q.consumer) ||
    q.consumer.meaningDigest !== row.release_digest ||
    q.consumer.readDefinition !== row.read_definition
  )
    return false;
  if (request.start !== null) {
    // Known relevant change is already sufficient to block; no own/child scan
    // is dispatched after this indexed fail-fast result.
    if (row.heads.length) return true;
    if (row.page_id !== null) {
      if (
        row.page_children.length !== row.page_rounds ||
        row.page_children.length < 1 ||
        row.page_children.length > 3 ||
        row.page_id !== nativePopulationStartId(request.start.observation) ||
        row.page_tail !== request.execution ||
        (row.page_state === 'sealed' ? row.finished_page !== row.page_id : row.page_state !== 'finished')
      )
        return false;
      let parent = row.boundary;
      let previous = row.boundary_window === null ? null : decode<NativeWindow>(row.boundary_window);
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
        const execution = decode<CustodyExecution>(child.execution);
        const window = decode<NativeWindow>(child.consumer_window);
        const consumed = child.page_consumed;
        if (
          !validWindow(execution, window, request.start) ||
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
    if (row.execution === null || row.consumer_window === null) return false;
    const execution = decode<CustodyExecution>(row.execution);
    const window = decode<{ raw: ({ id: string } | { key: { id: string; owner: string } })[]; rounds: number }>(
      row.consumer_window,
    );
    if (
      execution.id !== request.execution ||
      !isDeepStrictEqual(execution.start, request.start) ||
      !Array.isArray(execution.ownRows) ||
      !Array.isArray(window.raw) ||
      window.raw.length > 200 ||
      !Number.isInteger(window.rounds) ||
      window.rounds < 1 ||
      window.rounds > 3 ||
      execution.ownRows.length !== window.raw.length ||
      execution.ownRows.some((own, i) => {
        const raw = window.raw[i]!;
        return (
          !uuid.test(own.original) ||
          !uuid.test(own.terminal) ||
          own.original !== ('key' in raw ? raw.key.id : raw.id) ||
          ('key' in raw && raw.key.owner === 'accounts' && own.terminal !== own.original)
        );
      })
    )
      return false;
  }
  return true;
}

type NativeWindow = {
  raw: ({ id: string; sort: unknown } | { key: { id: string; owner: string }; sort: unknown })[];
  parent: string | null;
  consumed: number;
  before: unknown;
  rounds: number;
  charged: number;
};
function validWindow(execution: CustodyExecution, window: NativeWindow, start: PrivacyReductionStart) {
  return (
    isDeepStrictEqual(execution.start, start) &&
    Array.isArray(window.raw) &&
    window.raw.length <= 200 &&
    Array.isArray(execution.ownRows) &&
    execution.ownRows.length === window.raw.length &&
    execution.ownRows.every((own, index) => {
      const raw = window.raw[index]!;
      return (
        uuid.test(own.original) &&
        uuid.test(own.terminal) &&
        own.original === ('key' in raw ? raw.key.id : raw.id) &&
        (!('key' in raw) || raw.key.owner !== 'accounts' || own.terminal === own.original)
      );
    })
  );
}

/** One native statement snapshot covers binding, pending, independent native
 * Account/claim maintenance, immutable generations, and keyed own-row controls.
 * A start is retained only after all indexed barriers are empty. Repair/ACK never
 * changes this row or the original covered generation.
 */
export async function readPublicFilterPopulation(
  pool: Pool,
  routeKey: Uint8Array,
  request: Extract<PrivacyReductionObservationRequest, { kind: 'population' }>,
): Promise<PrivacyReductionObservation> {
  const final = request.start !== null;
  // Reserve misses, controls and the attempted start write before submitting SQL.
  // Two role reads use at most 64 fixed rows; summaries add exactly their native
  // summary + current-head point. Keyed own controls have their separate page cost.
  const cost: Cost = {
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
  let accounted = false;
  const unready = (): PrivacyReductionObservation => ({ status: 'unready', reason: 'metadata_missing', cost });
  try {
    const deadline = request.context.deadline;
    requireAccessDeadline(deadline);
    if (!Number.isSafeInteger(deadline)) return unready();
    // A malformed final role must never fall through SQL's NULL execution
    // branch and attempt a new start without its write reservation.
    if (
      final ? typeof request.execution !== 'string' || request.execution.length === 0 : request.execution !== undefined
    )
      return unready();
    const q = request.queried;
    if (!q || !/^0:/.test(q.snapshot.observation)) return unready();
    const pageId = final ? null : publicFilterCoverageStart(request.context);
    const start = final ? nativePopulationStartId(request.start!.observation) : (pageId ?? randomUUID());
    if (pageId !== null) cost.resultWrites++;
    if (final) cost.resultWrites++; // attempted native root finish, including misses
    const sql = statement.replace('semantic.privacy-role', final ? 'semantic.privacy-final' : 'semantic.privacy-start');
    const values = [
      0,
      q.snapshot.observation,
      encode(q),
      encode(q.consumer),
      Date.now(),
      q.consumer.physicalTarget,
      q.consumer.incarnation,
      createHash('sha256').update(routeKey).digest('hex'),
      final ? request.execution : null,
      start,
      deadline,
      pageId,
    ];
    cost.statements++;
    cost.bytes += Buffer.byteLength(sql) + Buffer.byteLength(encode(values));
    const query = { text: sql, values, query_timeout: Math.max(1, deadline - Date.now()) };
    const result = await withRequestDeadline(deadline, () => pool.query<Row>(query));
    cost.bytes += Buffer.byteLength(encode(result.rows));
    const row = result.rows[0];
    if (!row || result.rows.length !== 1) {
      accounted = true;
      requireAccessDeadline(deadline);
      return unready();
    }
    cost.inputKeys += row.coverage_keys.length + 5 * row.own_homes + 2 * row.own_subjects;
    cost.dependencyPoints += 2 * row.heads.length + 2 * row.own_homes + row.own_subjects;
    cost.rows += 2 * row.heads.length + 2 * row.own_homes + row.own_subjects;
    accounted = true;
    requireAccessDeadline(deadline);
    if (
      cost.inputKeys > 1000 ||
      cost.bytes > 4 * 1024 * 1024 ||
      !validBindings(row, request) ||
      row.pending ||
      row.fenced ||
      row.heads.some(
        (head) =>
          head.current_epoch === null ||
          head.position === null ||
          head.population_fenced ||
          head.current_epoch !== head.source_epoch,
      )
    )
      return unready();
    if (
      (!final && row.heads.length > 0) ||
      (row.heads.length === 0 &&
        (!row.admitted ||
          (!final && (row.inserted_start !== start || (pageId !== null && row.started_page !== pageId)))))
    )
      return unready();
    const heads = row.heads.map((head) => ({
      phase: head.phase,
      head: { partition: head.source_home, epoch: head.current_epoch!, position: BigInt(head.position!) },
    }));
    return {
      status: 'observed',
      coverage: 'all_native_homes',
      start: { observation: `population:${start}` },
      routingComplete: true,
      unacknowledged: heads.filter((head) => head.phase === 'pending').map((head) => head.head),
      changed: heads.filter((head) => head.phase === 'changed').map((head) => head.head),
      blocking: heads.map((head) => ({ ...head, scope: 'filter_or_order' })),
      cost,
    };
  } catch (error) {
    if (cost.statements > 0 && !accounted) {
      // A lost/failed statement cannot refund unknown native work. Each
      // dispatched own control needs at least two of the 936 remaining keys;
      // keep that entire possible prefix, plus both changed/behind controls.
      cost.inputKeys = 1000;
      cost.dependencyPoints += 468 + 4;
      cost.rows += 468 + 4;
    }
    if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) return unready();
    if (classifyUnavailability(error) !== undefined || (error && typeof error === 'object' && 'code' in error))
      return {
        status: 'unavailable',
        reason: Date.now() >= request.context.deadline ? 'deadline' : 'dependency_unavailable',
        cost,
      };
    throw error;
  }
}
