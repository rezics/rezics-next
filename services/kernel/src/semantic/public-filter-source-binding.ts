import { publicFilterCatalogue } from '../search/discovery-catalogue.ts';
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { nativePopulationStartId } from './public-filter-coverage-population.ts';
import { publicFilterSource, publicFilterSourceOrigin } from './public-filter-source.ts';
import {
  readOriginalPublicFilterProjectionPage,
  readRetainedPublicFilterProjectionPage,
  retainedPublicFilterProjectionDependenciesCurrent,
} from './public-filter-projection.ts';
import { systemClock } from '../clock.ts';
import { runCommand, noEffect, currentCommand } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import {
  readAccountDiscoveryRepairObservation,
  type AccountDiscoveryRepairObservation,
} from '../access/account-discovery-source.ts';
import { readRelease, freeze } from './definitions.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { classifyUnavailability, CommandUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { withConnection, discardConnection } from '../database/pool.ts';
import registerSource from './public-filter-source-binding-register.sql';
import defineSource from './public-filter-source-binding-define.sql';
import readDefinition from './public-filter-source-binding-definition.sql';
import beginBootstrap from './public-filter-source-binding-begin.sql';
import readBootstrap from './public-filter-source-binding-bootstrap.sql';
import adoptBootstrap from './public-filter-source-binding-adopt.sql';
import abortBootstrap from './public-filter-source-binding-abort.sql';
import accountPage from './public-filter-source-binding-account-page.sql';
import { enrollAccountDiscoveryHome } from '../access/account-discovery-reduction.ts';
import { publicFilterCoverageKeys } from './public-filter-coverage-pending.ts';
import { PUBLIC_FILTER_ACCOUNT_DOMAIN } from './public-filter-coverage-maintenance.ts';
import {
  beginPublicFilterCoverageBaseline,
  adoptPublicFilterCoverageBaseline,
} from './public-filter-coverage-baseline.ts';
import {
  readPublicFilterCreationWindow,
  readPublicFilterCreationEvent,
  type PublicFilterCreationWindow,
} from './public-filter-creation-window.ts';
import {
  readPublicFilterRepairVerification,
  readPublicFilterRepairVerificationTip,
  retainPublicFilterRepairVerification,
  readPublicFilterRepairHomeSeal,
  advancePublicFilterRepairAckFrontier,
} from './public-filter-repair-chain.ts';
import { encodePublicFilterNativeState } from '../search/public-filter-custody.ts';
import repairState from './public-filter-source-binding-repair-state.sql';
import repairRead from './public-filter-source-binding-repair-read.sql';
import repairSave from './public-filter-source-binding-repair-save.sql';
import repairKeys from './public-filter-source-binding-repair-keys.sql';
import repairAdvance from './public-filter-source-binding-repair-advance.sql';
import repairVersion from './public-filter-source-binding-repair-version.sql';
import repairCurrent from './public-filter-source-binding-repair-current.sql';
import type { Pool } from 'pg';
import { releaseDigest } from '@rezics/definitions';
import { admitFilter, walkFilter } from '@rezics/filter';
import type { Access } from '../request/access.ts';
import type { CustodyDefinition, CustodyRetainedDefinition } from '../search/public-filter-custody-contract.ts';
import { compileFilter } from '../search/filter.ts';
import { compileText } from '../search/text.ts';
import { validateSearchAfter } from '../search/query-payload.ts';
import { compileDiscoveryConsumerCapture, type DiscoveryConsumerCaptureInput } from '../search/discovery.ts';
import { validatePublicSuggestionInput } from '../search/public-suggestion-input.ts';
import {
  readPublicFilterConsumerCustody,
  readGenerationPublicationCustody,
  readPublicFilterRepairSettlement,
} from '../search/public-filter-custody.ts';
import type {
  PublicFilterConsumerCaptureInput,
  PublicFilterConsumerContext,
  PublicCanonicalCaptureInput,
  PublicFilterConsumerUnavailable,
  PublicFilterQueriedObservation,
  PublicSuggestionCaptureInput,
} from '../search/public-filter-consumer-contract.ts';
import type {
  PublicFilterCost,
  PublicFilterDependencyKey,
  PublicFilterProjectionMeaning,
  PublicFilterSource,
  PublicFilterConsumer,
  PublicFilterProjectionObservation,
  PublicFilterProjectionPage,
  PublicFilterRepairLocator,
  PrivacyReductionStart,
  PrivacyReductionObservation,
  PrivacyReductionObservationRequest,
  PublicFilterProjectionFrontier,
} from './public-filter-source-contract.ts';
/** Internal native receipt, resolved from the original independently verified
 * home/window chain. Never accepted by a public callable or a caller ACK setter.
 */
type PublicFilterRepairBaseline = Readonly<{
  bootstrap: string;
  registration: string;
  registrationPartition: number;
  home: number;
  epoch: number;
  receipt: string;
  sourcePosition: string;
  enqueue: string;
  revision: string | null;
  claimRevision: string | null;
  observation: string;
  execution: string;
  settlement: string;
  consumer: string;
  physicalTarget: string;
  incarnation: string;
}>;

/** ACK only this original baseline's complete prefix. Subsequent Source positions
 * and native enqueue revisions remain obligations even if delivered meanwhile.
 * Apply and ACK serialize on the SAME registration and coverage-summary locks.
 */
async function acknowledgePublicFilterRepairBaseline(
  pool: Pool,
  baseline: PublicFilterRepairBaseline,
  deadline: number,
): Promise<boolean> {
  requireAccessDeadline(deadline);
  return withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(deadline - Date.now()))}ms'`);
      const owner = (
        await client.query<{ write_state: string }>(
          `/* semantic.native-keyed:2:3 */
         SELECT p.write_state,p.epoch,e.owner_epoch,e.complete FROM core.partition p
         JOIN semantic.public_filter_home_enrollment e ON
           (e.partition_no,e.bootstrap)=(p.partition_no,$2::uuid)
         WHERE p.partition_no=$1 AND e.complete AND e.owner_epoch=p.epoch
         FOR SHARE OF p,e`,
          [baseline.registrationPartition, baseline.bootstrap],
        )
      ).rows[0];
      if (!owner || owner.write_state !== 'active')
        throw new CommandUnavailableError('fenced', baseline.registrationPartition);
      // Registration installs the physical target before its registration row.
      // Keep that native lock order while fencing the incarnation through ACK.
      const target = (
        await client.query<{ incarnation: string }>(
          `/* semantic.native-keyed:1:2 */
         SELECT incarnation FROM search.public_filter_target
         WHERE (partition_no,physical_target)=($1,$2) FOR SHARE`,
          [baseline.registrationPartition, baseline.physicalTarget],
        )
      ).rows[0];
      if (target?.incarnation !== baseline.incarnation)
        throw new CommandUnavailableError('fenced', baseline.registrationPartition);
      const registration = (
        await client.query<{ state: string; consumer: string; physical_target: string }>(
          `/* semantic.native-keyed:1:2 */
         SELECT state,consumer,physical_target FROM search.public_filter_registration
         WHERE (partition_no,id)=($1,$2) FOR UPDATE`,
          [baseline.registrationPartition, baseline.registration],
        )
      ).rows[0];
      if (
        registration?.state !== 'active' ||
        registration.consumer !== baseline.consumer ||
        registration.physical_target !== baseline.physicalTarget
      )
        throw new CommandUnavailableError('fenced', baseline.registrationPartition);
      const summary = (
        await client.query<{
          source_epoch: number;
          baseline_bootstrap: string;
          acknowledged_position: string;
          acknowledged_native_enqueue: string;
        }>(
          `/* semantic.native-keyed:1:3 */
         SELECT source_epoch,baseline_bootstrap::text,acknowledged_position::text,
           acknowledged_native_enqueue::text
         FROM search.public_filter_coverage_home
         WHERE (partition_no,registration,source_home)=($1,$2,$3) FOR UPDATE`,
          [baseline.registrationPartition, baseline.registration, baseline.home],
        )
      ).rows[0];
      const original = (
        await client.query<{
          receipt: string;
          source_epoch: number;
          source_position: string;
          native_enqueue_revision: string;
          native_revision: string | null;
          native_claim_revision: string | null;
        }>(
          `/* semantic.native-keyed:1:4 */
         SELECT receipt,source_epoch,source_position::text,native_enqueue_revision::text,
           native_revision::text,native_claim_revision::text
         FROM search.public_filter_coverage_baseline
         WHERE (partition_no,registration,bootstrap,source_home)=($1,$2,$3,$4)`,
          [baseline.registrationPartition, baseline.registration, baseline.bootstrap, baseline.home],
        )
      ).rows[0];
      if (
        !summary ||
        !original ||
        summary.source_epoch !== baseline.epoch ||
        summary.baseline_bootstrap !== baseline.bootstrap ||
        original.receipt !== baseline.receipt ||
        original.source_epoch !== baseline.epoch ||
        original.source_position !== baseline.sourcePosition ||
        original.native_enqueue_revision !== baseline.enqueue ||
        original.native_revision !== baseline.revision ||
        original.native_claim_revision !== baseline.claimRevision ||
        BigInt(summary.acknowledged_position) > BigInt(baseline.sourcePosition) ||
        BigInt(summary.acknowledged_native_enqueue) > BigInt(baseline.enqueue)
      )
        throw new CommandUnavailableError('contention', baseline.registrationPartition);
      // The verified full native baseline plus its original creation/change
      // successors covers every obligation through these exact positions. This
      // is not max(delivered), a counter tick, or an event-delivery receipt.
      const acknowledged = await client.query(
        `/* semantic.native-keyed:1:3 */
         UPDATE search.public_filter_coverage_home SET
           acknowledged_position=$4::bigint,acknowledged_native_enqueue=$5::bigint,
           acknowledged_native_revision=$6::bigint,acknowledged_native_claim_revision=$7::bigint,
           acknowledged_baseline=$8::uuid,
           acknowledged_observation=$9,acknowledged_execution=$10,acknowledged_settlement=$11,
           behind=(relevant_position>$4::bigint OR native_enqueue_revision>$5::bigint
             OR native_revision IS DISTINCT FROM $6::bigint
             OR native_claim_revision IS DISTINCT FROM $7::bigint)
         WHERE (partition_no,registration,source_home)=($1,$2,$3)
         RETURNING source_epoch,acknowledged_position::text,acknowledged_native_enqueue::text,
           acknowledged_native_revision::text,acknowledged_native_claim_revision::text,
           acknowledged_baseline::text,acknowledged_observation,acknowledged_execution,
           acknowledged_settlement,behind`,
        [
          baseline.registrationPartition,
          baseline.registration,
          baseline.home,
          baseline.sourcePosition,
          baseline.enqueue,
          baseline.revision,
          baseline.claimRevision,
          baseline.bootstrap,
          baseline.observation,
          baseline.execution,
          baseline.settlement,
        ],
      );
      if (acknowledged.rowCount !== 1) throw new CommandUnavailableError('contention', baseline.registrationPartition);
      requireAccessDeadline(deadline);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(client, rollbackError as Error);
      }
      throw error;
    }
  });
}

/** Agreed additive native binding handoff. The Source producer owns all implementation. */
export type JoinedPopulationRequest =
  | Readonly<{ kind: 'queried'; phase: 'start' | 'status'; queried: PublicFilterQueriedObservation }>
  | Readonly<{
      kind: 'queried';
      phase: 'final';
      queried: PublicFilterQueriedObservation;
      execution: string;
    }>;

export interface PublicFilterNativeSource extends PublicFilterSource {
  resolvePublicFilterDefinition(
    request: Readonly<{ meaning: PublicFilterProjectionMeaning; capture: PublicCanonicalCaptureInput }>,
    context: PublicFilterConsumerContext,
  ): Promise<
    | Readonly<{ status: 'bound'; definition: CustodyDefinition<PublicCanonicalCaptureInput>; cost: PublicFilterCost }>
    | PublicFilterConsumerUnavailable
  >;
  readPrivacyReductionHeads(request: PrivacyReductionObservationRequest): Promise<PrivacyReductionObservation>;
  readPrivacyReductionHeads(
    request: JoinedPopulationRequest,
    context: PublicFilterConsumerContext,
  ): Promise<PrivacyReductionObservation>;
}

export type { PublicFilterQueriedObservation } from '../search/public-filter-consumer-contract.ts';
export type NativePublicSource = Readonly<{
  id: string;
  partition: number;
  epoch: number;
  configuration: string;
}>;
/** Immutable root input. Refill size/frontier belongs to Search's retained execution lineage. */
export type PublicFilterSourceCaptureInput =
  | PublicFilterConsumerCaptureInput
  | DiscoveryConsumerCaptureInput
  | PublicSuggestionCaptureInput;
export type PublicSourceCaptureInput = PublicFilterSourceCaptureInput;
export type PublicFilterSourceDefinition = Readonly<{
  source: NativePublicSource;
  readDefinition: string;
  meaning: PublicFilterProjectionMeaning;
  capture: PublicFilterSourceCaptureInput;
  dependencyKeys: readonly PublicFilterDependencyKey[];
}>;
export type PublicFilterBindingFailure = Readonly<{
  status: 'unready' | 'unavailable';
  reason:
    | 'source_missing'
    | 'configuration_changed'
    | 'definition_missing'
    | 'observation_lost'
    | 'execution_missing'
    | 'binding_mismatch'
    | 'owner_unavailable'
    | 'identity_pending'
    | 'deadline';
  cost: PublicFilterCost;
}>;
export type PublicFilterSourceBinding = Readonly<{
  /** Older basic bindings have no repair producer. Native bootstrap bindings always provide this method. */
  readRepairStep?(
    request: NativeSourceRepairStepRead,
    context: PublicFilterConsumerContext,
  ): Promise<NativeSourceRepairStepVerification>;
  readRepairReceipt?(
    request: NativeSourceRepairRead,
    context: PublicFilterConsumerContext,
  ): Promise<NativeSourceRepairVerification>;
  resolve(
    request: Readonly<{
      source: PublicFilterSource;
      meaning: PublicFilterProjectionMeaning;
      capture: PublicFilterSourceCaptureInput;
    }>,
    context: PublicFilterConsumerContext,
  ): Promise<
    | Readonly<{ status: 'resolved'; definition: PublicFilterSourceDefinition; cost: PublicFilterCost }>
    | PublicFilterBindingFailure
  >;
  join(
    request: Readonly<{
      queried: PublicFilterQueriedObservation;
      execution?: string;
    }>,
    context: PublicFilterConsumerContext,
  ): Promise<
    | Readonly<{
        status: 'joined';
        definition: PublicFilterSourceDefinition;
        queried: PublicFilterQueriedObservation;
        covered: PrivacyReductionStart;
        execution: Readonly<{
          id: string;
          start: PrivacyReductionStart;
          ownRows: readonly Readonly<{ original: string; terminal: string }>[];
        }> | null;
        cost: PublicFilterCost;
      }>
    | PublicFilterBindingFailure
  >;
}>;

/** Source-owned bootstrap state; the consumer and retained observation remain Search-owned. */
export type PublicSourceBootstrap = Readonly<{
  id: string;
  definition: PublicFilterSourceDefinition;
  consumer: PublicFilterConsumer;
  snapshot: 'pit' | 'prepared';
  covered: PrivacyReductionStart;
}>;
export type PublicSourceBootstrapResult =
  | Readonly<{ status: 'begun'; bootstrap: PublicSourceBootstrap; cost: PublicFilterCost }>
  | PublicFilterBindingFailure;
export type PublicSourceBootstrapRecovery =
  | Readonly<{ status: 'begun'; bootstrap: PublicSourceBootstrap; queried: null; cost: PublicFilterCost }>
  | Readonly<{
      status: 'adopted';
      bootstrap: PublicSourceBootstrap;
      queried: PublicFilterQueriedObservation;
      cost: PublicFilterCost;
    }>
  | Readonly<{ status: 'pending'; cost: PublicFilterCost }>
  | PublicFilterBindingFailure;
const nativeSourceRepairReceipt: unique symbol = Symbol('native Source repair receipt');
/** Durable original-module locator. Its fields locate evidence; none certifies completion. */
export type NativeSourceRepairLocator = Readonly<{
  bootstrap: string;
  execution: string;
  step: string;
  locatorDigest: string;
}>;
export type NativeSourceRepairReceipt = NativeSourceRepairLocator & Readonly<{ [nativeSourceRepairReceipt]: true }>;
export type NativeSourceRepairRead = Readonly<{
  receipt: NativeSourceRepairLocator;
  queried: PublicFilterQueriedObservation;
  execution: string;
}>;
/** Exact retained native successor request. Locators identify Source evidence; they confer no authority. */
export type NativeSourceRepairStepRead = Readonly<{
  bootstrap: string;
  queried: PublicFilterQueriedObservation;
  execution: string;
  predecessor: string | null;
}>;
export type NativeSourceRepairStepVerification =
  | Readonly<{
      status: 'verified';
      step: string;
      predecessor: string | null;
      frontier: string | null;
      complete: boolean;
      receipts: readonly NativeSourceRepairLocator[];
      cost: PublicFilterCost;
    }>
  | PublicFilterBindingFailure;
export type NativeSourceRepairVerification =
  | Readonly<{ status: 'verified'; repair: PublicSourceRepair; cost: PublicFilterCost }>
  | PublicFilterBindingFailure;
export type PublicSourceRepair = Readonly<{
  kind: 'local' | 'foreign';
  locator: PublicFilterRepairLocator;
  source: PublicFilterProjectionObservation;
  projection: PublicFilterProjectionPage;
  receipt: NativeSourceRepairReceipt;
}>;
export type PublicSourceRepairPage =
  | Readonly<{ status: 'progress'; repairs: readonly PublicSourceRepair[]; frontier: string; cost: PublicFilterCost }>
  | Readonly<{ status: 'complete'; repairs: readonly PublicSourceRepair[]; frontier: null; cost: PublicFilterCost }>
  | PublicFilterBindingFailure;
export type PublicFilterSourceBootstrapBinding = PublicFilterSourceBinding &
  Readonly<{
    readRepairStep(
      request: NativeSourceRepairStepRead,
      context: PublicFilterConsumerContext,
    ): Promise<NativeSourceRepairStepVerification>;
    /** Acyclic Source verification. Reads basic Search custody, never Search settlement. */
    readRepairReceipt(
      request: NativeSourceRepairRead,
      context: PublicFilterConsumerContext,
    ): Promise<NativeSourceRepairVerification>;
    begin(
      request: Readonly<{
        source: PublicFilterSource;
        meaning: PublicFilterProjectionMeaning;
        capture: PublicFilterSourceCaptureInput;
        consumer: PublicFilterConsumer;
        snapshot: 'pit' | 'prepared';
      }>,
      context: PublicFilterConsumerContext,
    ): Promise<PublicSourceBootstrapResult>;
    adopt(
      request: Readonly<{ bootstrap: string; queried: PublicFilterQueriedObservation }>,
      context: PublicFilterConsumerContext,
    ): Promise<
      | Readonly<{
          status: 'adopted';
          bootstrap: PublicSourceBootstrap;
          queried: PublicFilterQueriedObservation;
          cost: PublicFilterCost;
        }>
      | PublicFilterBindingFailure
    >;
    abort(
      request: Readonly<{ bootstrap: string }>,
      context: PublicFilterConsumerContext,
    ): Promise<Readonly<{ status: 'aborted' | 'pending'; cost: PublicFilterCost }> | PublicFilterBindingFailure>;
    recover(
      request: Readonly<{ bootstrap: string }>,
      context: PublicFilterConsumerContext,
    ): Promise<PublicSourceBootstrapRecovery>;
    repairPage(
      request: Readonly<{
        bootstrap: string;
        queried: PublicFilterQueriedObservation;
        execution: string;
        frontier: string | null;
        inputLimit: number;
      }>,
      context: PublicFilterConsumerContext,
    ): Promise<PublicSourceRepairPage>;
    settle(
      request: Readonly<{ bootstrap: string; queried: PublicFilterQueriedObservation; execution: string }>,
      context: PublicFilterConsumerContext,
    ): ReturnType<PublicFilterSourceBinding['join']>;
  }>;

/** Internal native preparation handoff; the bootstrap remains the original persisted Source cut. */
type NativePreparationInput =
  | Parameters<PublicFilterSourceBootstrapBinding['begin']>[0]
  | Readonly<{ bootstrap: string }>;
export type NativePublicFilterPreparation =
  | PublicSourceBootstrapResult
  | Readonly<{
      status: 'preparing';
      bootstrap: PublicSourceBootstrap;
      cost: PublicFilterCost;
    }>;
const nativePreparations = new WeakMap<
  PublicFilterSourceBinding,
  (input: NativePreparationInput, context: PublicFilterConsumerContext) => Promise<NativePublicFilterPreparation>
>();

// These private factory associations locate original native bodies. The bodies
// resolve persisted custody and owner facts on every call; the association is
// neither a repair receipt nor population/serving authority.
const nativeAccountRepairs = new WeakMap<
  PublicFilterSourceBinding,
  (
    request: NativeSourceRepairStepRead,
    context: PublicFilterConsumerContext,
  ) => Promise<Readonly<{ account: AccountDiscoveryRepairObservation | null; cost: PublicFilterCost }>>
>();
const nativeRepairStarts = new WeakMap<
  PublicFilterSourceBinding,
  (
    request: Readonly<{ bootstrap: string; queried: PublicFilterQueriedObservation }>,
    context: PublicFilterConsumerContext,
  ) => Promise<Readonly<{ start: PrivacyReductionStart; cost: PublicFilterCost }>>
>();
const nativeRepairJoins = new WeakMap<PublicFilterSourceBinding, PublicFilterSourceBinding['join']>();

export async function joinNativePublicFilterRepair(
  binding: PublicFilterSourceBinding,
  request: Parameters<PublicFilterSourceBinding['join']>[0],
  context: PublicFilterConsumerContext,
) {
  return nativeRepairJoins.get(binding)?.(request, context) ?? null;
}

export async function readNativePublicFilterAccountRepair(
  binding: PublicFilterSourceBinding,
  request: NativeSourceRepairStepRead,
  context: PublicFilterConsumerContext,
) {
  return nativeAccountRepairs.get(binding)?.(request, context) ?? null;
}
export async function readNativePublicFilterRepairStart(
  binding: PublicFilterSourceBinding,
  request: Readonly<{ bootstrap: string; queried: PublicFilterQueriedObservation }>,
  context: PublicFilterConsumerContext,
) {
  return nativeRepairStarts.get(binding)?.(request, context) ?? null;
}

/** A private factory association locates the native body; it cannot grant coverage or open a PIT. */
export async function advanceNativePublicFilterPreparation(
  binding: PublicFilterSourceBinding,
  input: NativePreparationInput,
  context: PublicFilterConsumerContext,
): Promise<NativePublicFilterPreparation | null> {
  return nativePreparations.get(binding)?.(input, context) ?? null;
}

type BindingCost = { -readonly [K in keyof PublicFilterCost]: number } & {
  statements: number;
  rows: number;
  bytes: number;
};
function publicFilterBindingCost(): BindingCost {
  return {
    statements: 0,
    rows: 0,
    bytes: 0,
    inputKeys: 0,
    candidates: 0,
    accessPoints: 0,
    dependencyPoints: 0,
    engineSearches: 0,
    engineIteratorSteps: 0,
    outputSlots: 0,
    resultWrites: 0,
    frontierWrites: 0,
  };
}
function addCost(target: BindingCost, value: PublicFilterCost): void {
  for (const key of Object.keys(target) as (keyof BindingCost)[]) {
    const amount = (value as Partial<BindingCost>)[key];
    if (amount !== undefined) target[key] += amount;
  }
}
// Tagged, sorted encoding preserves explicit undefined and bigint without reserving caller JSON keys.
function encode(value: unknown): string {
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
    if (typeof entry === 'number' && !Number.isFinite(entry)) throw new TypeError('Finite input required');
    if (typeof entry === 'function' || typeof entry === 'symbol') throw new TypeError('Data input required');
    return ['value', entry];
  }
  return JSON.stringify(pack(value));
}
function decode<T>(value: string): T {
  function unpack(entry: any): unknown {
    if (entry[0] === 'undefined') return undefined;
    if (entry[0] === 'bigint') return BigInt(entry[1]);
    if (entry[0] === 'array') return entry[1].map(unpack);
    if (entry[0] === 'object')
      return Object.fromEntries(entry[1].map(([key, child]: [string, unknown]) => [key, unpack(child)]));
    if (entry[0] === 'value') return entry[1];
    throw new TypeError('Invalid stored Source data');
  }
  return unpack(JSON.parse(value)) as T;
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function packRepairLocatorDigests(locators: readonly PublicFilterRepairLocator[], inputLimit: number): Buffer {
  if (locators.length > Math.min(256, inputLimit)) throw new BindingError('owner_unavailable');
  const digests = locators.map((locator) => hash(encode(locator)));
  return Buffer.concat(digests.map((digest) => Buffer.from(digest, 'hex')));
}
function unpackRepairLocatorDigests(value: unknown, inputLimit: number): readonly string[] {
  const packed =
    typeof value === 'string' ? value : value instanceof Uint8Array ? Buffer.from(value).toString('hex') : null;
  if (
    packed === null ||
    packed.length % 64 !== 0 ||
    packed.length / 64 > inputLimit ||
    !/^(?:[0-9a-f]{64})*$/.test(packed)
  )
    throw new BindingError('owner_unavailable');
  return Array.from({ length: packed.length / 64 }, (_, index) => packed.slice(index * 64, (index + 1) * 64));
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
class BindingError extends Error {
  constructor(readonly reason: PublicFilterBindingFailure['reason']) {
    super(reason);
  }
}
function checkDeadline(context: PublicFilterConsumerContext): void {
  if (!Number.isFinite(context.deadline) || context.deadline <= Date.now()) throw new BindingError('deadline');
}
/** Charge native release lookups as well as Source SQL, including failed submissions. */
function measuredPool(pool: Pool, cost: BindingCost): Pool {
  function wrap<T extends object>(target: T): T {
    return new Proxy(target, {
      get(object, key) {
        const value: unknown = Reflect.get(object, key, object);
        if (key === 'query' && typeof value === 'function')
          return async (text: string, values?: unknown[]) => {
            // Authored native point queries declare their complete keyed relation
            // footprint. Reserve it before submission, including misses, CAS loss
            // and thrown attempts. A joined result is not another native row.
            const native = /^\s*\/\* semantic\.native-keyed:(\d+):(\d+) \*\//.exec(text);
            const writes = native !== null && /^\s*(?:\/\*[\s\S]*?\*\/\s*)*(?:INSERT|UPDATE|DELETE)\b/.test(text);
            cost.statements++;
            cost.inputKeys += native ? Number(native[2]) : (values?.length ?? 0);
            cost.bytes += Buffer.byteLength(text) + Buffer.byteLength(encode(values));
            if (native) {
              cost.rows += Number(native[1]);
              cost.dependencyPoints += Number(native[1]);
              if (writes) cost.resultWrites++;
            }
            const result = await value.call(object, text, values);
            if (!native) {
              cost.rows += result.rowCount ?? 0;
              cost.dependencyPoints += result.rowCount ?? 0;
            }
            cost.bytes += Buffer.byteLength(encode(result.rows));
            if (!native && /\b(INSERT|UPDATE|DELETE)\b/.test(text)) cost.resultWrites += result.rowCount ?? 0;
            return result;
          };
        if (key === 'connect' && typeof value === 'function') return async () => wrap(await value.call(object));
        return typeof value === 'function' ? value.bind(object) : value;
      },
    });
  }
  return wrap(pool);
}
/** Shared constructor validation; routing is the existing native routeKey, never a callback. */
function validatePublicFilterBindingConfiguration(pool: Pool, routing: Uint8Array, access: Access): void {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function')
    throw new TypeError('A native pool is required');
  if (!(routing instanceof Uint8Array) || routing.byteLength < 32)
    throw new TypeError('Route key must contain at least 32 bytes');
  if (!access || typeof access.authorize !== 'function' || typeof access.authenticate !== 'function')
    throw new TypeError('A native Access instance is required');
}

/** Only the admitted shared tree and existing compilers determine dependency closure. */
function captureKeys(meaning: PublicFilterProjectionMeaning, input: PublicFilterConsumerCaptureInput) {
  if (meaning.digest !== releaseDigest(meaning.release) || !meaning.release.types[meaning.type])
    throw new TypeError('Unknown projection meaning');
  if (
    !Object.hasOwn(input, 'filterDocument') ||
    !Object.hasOwn(input, 'text') ||
    !Number.isInteger(input.size) ||
    input.size < 1 ||
    input.size > 200 ||
    !['id', 'name', 'relevance', 'collections', 'rating'].includes(input.sort)
  )
    throw new TypeError('Complete capture input is required');
  // Rating's phased tuple is admitted by its existing native planner, not ordinary search_after.
  // Native rating/generation metadata cannot be verified until the producer registration is available.
  if (input.sort !== 'rating') validateSearchAfter(input);
  if (input.filterDocument !== undefined) {
    for (const node of walkFilter(input.filterDocument))
      if ('owner' in node || 'saved' in node) throw new TypeError('Only expanded public filters may bind');
    const admitted = admitFilter(input.filterDocument, meaning.release);
    if (!isDeepStrictEqual(admitted, input.filterDocument)) throw new TypeError('Capture must already be admitted');
  }
  const filter =
    input.filterDocument === undefined
      ? undefined
      : compileFilter(input.filterDocument, { prefix: 'f', relationOverflow: true });
  const text = input.text === undefined ? undefined : compileText(input.text, { field: 'search_text', prefix: 't' });
  const overflowProperties = filter
    ? [...new Set(filter.leaves.flatMap((leaf) => (leaf.facet === 'statement' ? [leaf.property] : [])))]
    : undefined;
  for (const [key, value] of Object.entries({
    filter: filter?.query,
    query: text?.query,
    boost: text?.leaves
      .filter((leaf) => !leaf.negated)
      .map((leaf) => leaf.value)
      .join(' '),
    overflowProperties,
  })) {
    if (Object.hasOwn(input, key) && !isDeepStrictEqual(input[key as keyof typeof input], value))
      throw new TypeError('Compiled capture differs from its retained input');
  }
  const keys: PublicFilterDependencyKey[] = [
    { kind: 'order', order: input.sort },
    { kind: 'type' },
    { kind: 'field', field: 'id' },
  ];
  for (const leaf of filter?.leaves ?? []) {
    if (leaf.facet === 'type') keys.push({ kind: 'type' });
    else {
      keys.push({ kind: 'property', property: leaf.property });
      for (const qualifier of leaf.qualifiers ?? []) keys.push({ kind: 'property', property: qualifier.property });
    }
  }
  if (text)
    keys.push(...(['labels', 'aliases', 'descriptions'] as const).map((field) => ({ kind: 'field' as const, field })));
  if (['name', 'collections', 'rating'].includes(input.sort))
    keys.push({ kind: 'field', field: 'name_sort' }, { kind: 'field', field: 'labels' });
  if (input.sort === 'collections') keys.push({ kind: 'function', input: 'public_collection_count' });
  if (input.sort === 'rating') keys.push({ kind: 'function', input: 'public_rating' });
  return keys.filter((key, index) => keys.findIndex((other) => isDeepStrictEqual(key, other)) === index);
}

function deriveCaptureKeys(
  meaning: PublicFilterProjectionMeaning,
  input: PublicSourceCaptureInput,
): PublicFilterDependencyKey[] {
  if (meaning.digest !== releaseDigest(meaning.release) || !meaning.release.types[meaning.type])
    throw new TypeError('Unknown native meaning');
  let keys: readonly PublicFilterDependencyKey[];
  if ('purpose' in input) {
    validatePublicSuggestionInput(input);
    keys = [
      { kind: 'type' },
      { kind: 'field', field: 'id' },
      { kind: 'field', field: 'labels' },
      { kind: 'field', field: 'aliases' },
      { kind: 'field', field: 'name_sort' },
      { kind: 'order', order: 'name' },
      { kind: 'order', order: 'id' },
    ];
  } else if ('representation' in input) {
    keys = [
      ...compileDiscoveryConsumerCapture(input, meaning, undefined).dependencyKeys,
      { kind: 'field', field: 'id' },
      ...(input.sort === 'name'
        ? [
            { kind: 'field' as const, field: 'name_sort' as const },
            { kind: 'field' as const, field: 'labels' as const },
            { kind: 'field' as const, field: 'aliases' as const },
          ]
        : []),
    ];
  } else keys = captureKeys(meaning, input);
  return keys.filter((key, i) => keys.findIndex((other) => isDeepStrictEqual(key, other)) === i);
}

function allCaptureKeys(
  meaning: PublicFilterProjectionMeaning,
  input: PublicSourceCaptureInput,
): PublicFilterDependencyKey[] {
  try {
    return deriveCaptureKeys(meaning, input);
  } catch {
    throw new BindingError('binding_mismatch');
  }
}

/** Native Source-owned registration; the origin association only locates the constructor configuration. */
export function createPublicFilterSourceBinding(
  pool: Pool,
  routing: Uint8Array,
  access: Access,
): PublicFilterSourceBootstrapBinding {
  validatePublicFilterBindingConfiguration(pool, routing, access);
  const nativeRouting = new Uint8Array(routing);
  const routeDigest = hash(nativeRouting);
  const fail = (
    reason: PublicFilterBindingFailure['reason'],
    cost: PublicFilterCost = publicFilterBindingCost(),
  ): PublicFilterBindingFailure => ({
    status: ['source_missing', 'definition_missing', 'identity_pending'].includes(reason) ? 'unready' : 'unavailable',
    reason,
    cost,
  });
  async function run<T>(
    context: PublicFilterConsumerContext,
    work: (cost: BindingCost, db: Pool) => Promise<T>,
  ): Promise<T | PublicFilterBindingFailure> {
    const cost = publicFilterBindingCost();
    const deadline = context.deadline;
    try {
      checkDeadline({ deadline });
      const result = await withRequestDeadline(deadline, () => work(cost, measuredPool(pool, cost)));
      checkDeadline({ deadline });
      return result;
    } catch (error) {
      if (error instanceof BindingError) return fail(error.reason, cost);
      if (error instanceof TypeError || error instanceof RangeError) return fail('binding_mismatch', cost);
      const reason = classifyUnavailability(error);
      if (reason !== undefined || (error && typeof error === 'object' && 'code' in error))
        return fail(Date.now() >= deadline ? 'deadline' : 'owner_unavailable', cost);
      throw error;
    }
  }
  async function loadDefinition(id: string, db: Pool): Promise<PublicFilterSourceDefinition> {
    if (!uuid.test(id)) throw new BindingError('definition_missing');
    const row = await readDefinition.run(db, { read_definition: id });
    if (!row) throw new BindingError('definition_missing');
    if (row.route_digest !== routeDigest) throw new BindingError('configuration_changed');
    const release = await readRelease(db, row.release_digest);
    if (!release || !release.types[row.subject_type]) throw new BindingError('definition_missing');
    const capture = decode<PublicSourceCaptureInput>(row.capture);
    const meaning = { digest: row.release_digest, release, type: row.subject_type };
    const keys = allCaptureKeys(meaning, capture);
    if (!isDeepStrictEqual(keys, row.dependency_keys)) throw new BindingError('binding_mismatch');
    return {
      source: { id: row.source_id, partition: 0, epoch: row.owner_epoch, configuration: row.configuration },
      readDefinition: id,
      meaning,
      capture,
      dependencyKeys: keys,
    };
  }
  const readers = new Map<string, PublicFilterSource>();
  const sourceReader = (definition: PublicFilterSourceDefinition) =>
    readers.get(definition.source.id) ??
    publicFilterSource({ pool, routeKey: new Uint8Array(nativeRouting), access, clock: systemClock });
  function nativeId(locator: string): string {
    if (typeof locator !== 'string' || !locator.startsWith('0:') || !uuid.test(locator.slice(2)))
      throw new BindingError('observation_lost');
    return locator.slice(2);
  }
  function requireSameDefinition(own: PublicFilterSourceDefinition, retained: CustodyRetainedDefinition): void {
    if (
      encode(own.source) !== encode(retained.source) ||
      own.readDefinition !== retained.readDefinition ||
      own.meaning.digest !== retained.meaning.digest ||
      own.meaning.type !== retained.meaning.type ||
      encode(own.capture) !== encode(retained.capture) ||
      encode(own.dependencyKeys) !== encode(retained.dependencyKeys)
    )
      throw new BindingError('binding_mismatch');
    if ('authority' in retained.meaning.release) {
      if (
        retained.meaning.release.authority !== 'semantic.readRelease' ||
        retained.meaning.release.digest !== own.meaning.digest
      )
        throw new BindingError('binding_mismatch');
    } else if (!isDeepStrictEqual(own.meaning.release, retained.meaning.release))
      throw new BindingError('binding_mismatch');
  }
  async function loadBootstrap(locator: string, db: Pool, knownDefinition?: PublicFilterSourceDefinition) {
    const row = await readBootstrap.run(db, { bootstrap: nativeId(locator) });
    if (!row) throw new BindingError('observation_lost');
    if (knownDefinition && knownDefinition.readDefinition !== row.read_definition)
      throw new BindingError('binding_mismatch');
    const definition = knownDefinition ?? (await loadDefinition(row.read_definition, db));
    if (row.owner_epoch !== definition.source.epoch) throw new BindingError('configuration_changed');
    if (row.snapshot_kind !== 'pit' && row.snapshot_kind !== 'prepared') throw new BindingError('binding_mismatch');
    const bootstrap: PublicSourceBootstrap = {
      id: locator,
      definition,
      consumer: decode<PublicFilterConsumer>(row.consumer),
      snapshot: row.snapshot_kind,
      covered: { observation: locator },
    };
    return { row, definition, bootstrap };
  }
  function requirePopulationBaseline(row: NonNullable<Awaited<ReturnType<typeof readBootstrap.run>>>) {
    if (
      row.account_after !== 4096 ||
      row.coverage_after !== 4096 ||
      !row.coverage_sealed ||
      row.coverage_generation === null ||
      row.coverage_root === null
    )
      throw new BindingError('owner_unavailable');
  }
  type Joined = Extract<Awaited<ReturnType<PublicFilterSourceBinding['join']>>, { status: 'joined' }>;
  type RepairState = {
    owner?: 'semantic' | 'accounts';
    partition: number;
    after: { route: number; id: string } | null;
    subject: string | null;
    phase: 'scan' | 'advance' | 'project' | 'account' | 'window' | 'bridge';
    advance: string;
    version: bigint | null;
    epoch: number | null;
    projection: PublicFilterProjectionFrontier | null;
    bridge?: PublicFilterCreationWindow;
    /** Return to the exact captured event successor after its actual owner repair. */
    resumeBridge?: PublicFilterCreationWindow;
    /** This original traversal includes both local and foreign claim intents. */
    claimInputs?: true;
    /** Release a claim home before repairing its independently routed Account. */
    resumeAccountScan?: { partition: number; epoch: number; after: { route: number; id: string } };
  };
  type RepairRecord = {
    input: RepairState;
    next: RepairState;
    output: {
      digest: string;
      source: PublicFilterProjectionObservation;
      frontier: PublicFilterProjectionFrontier;
      request: { inputLimit: number; frontier: PublicFilterProjectionFrontier | null };
    } | null;
    account?: AccountDiscoveryRepairObservation;
  };
  type Projection = Extract<PublicFilterProjectionPage, { status: 'progress' | 'complete' }>;
  function projectionDigest(page: Projection): string {
    return hash(
      encode({
        status: page.status,
        source: page.source,
        records: page.records,
        repairLocators: page.repairLocators,
        frontier: page.frontier,
        heads: page.status === 'complete' ? page.requiredHeads : undefined,
      }),
    );
  }
  function resumeCreationBridge(state: RepairState): RepairState {
    const window = state.resumeBridge;
    if (!window) throw new BindingError('binding_mismatch');
    const { resumeBridge: _resume, ...rest } = state;
    return {
      ...rest,
      owner: 'semantic',
      partition: window.partition,
      epoch: window.epoch,
      subject: null,
      after: null,
      phase: 'bridge',
      version: null,
      projection: null,
      bridge: window,
    };
  }
  function resumeAccountScan(state: RepairState): RepairState {
    const scan = state.resumeAccountScan;
    if (!scan || state.resumeBridge) throw new BindingError('binding_mismatch');
    const { resumeAccountScan: _resume, ...rest } = state;
    return {
      ...rest,
      owner: 'accounts',
      partition: scan.partition,
      epoch: scan.epoch,
      after: scan.after,
      subject: null,
      phase: 'scan',
      version: null,
      projection: null,
    };
  }
  async function advanceCreationBridge(
    bootstrap: string,
    state: RepairState,
    db: Pool,
    context: PublicFilterConsumerContext,
    accounts: boolean,
    cost: BindingCost,
    retained?: RepairState,
  ): Promise<RepairState> {
    if (state.resumeBridge || state.subject !== null || state.projection !== null)
      throw new BindingError('binding_mismatch');
    if (state.phase === 'window') {
      // measuredPool charges the projected row. The original enrollment, native
      // owner and retention checkpoint are three separately keyed inputs.
      cost.rows += 2;
      cost.dependencyPoints += 2;
      cost.inputKeys++;
      const window = await readPublicFilterCreationWindow(
        db,
        { bootstrap: nativeId(bootstrap), partition: state.partition },
        context,
        retained?.bridge,
      );
      return { ...state, epoch: window.epoch, phase: 'bridge', bridge: window };
    }
    if (
      state.phase !== 'bridge' ||
      !state.bridge ||
      state.partition !== state.bridge.partition ||
      state.epoch !== state.bridge.epoch
    )
      throw new BindingError('binding_mismatch');
    // An exhausted interval still revalidates all three binding rows. A live
    // event additionally reads its exact outbox point; neither is a packed-row
    // exemption from native control/point accounting.
    const extraRows = state.bridge.position > state.bridge.through ? 2 : 3;
    cost.rows += extraRows;
    cost.dependencyPoints += extraRows;
    cost.inputKeys++;
    const result = await readPublicFilterCreationEvent(
      db,
      { bootstrap: nativeId(bootstrap), window: state.bridge },
      context,
    );
    if (result.event === null) {
      const { bridge: _bridge, ...rest } = state;
      return { ...rest, partition: state.partition + 1, epoch: null, phase: 'window' };
    }
    const event = result.event;
    const subject = event.type.startsWith('com.rezics.subject.') || event.type.startsWith('com.rezics.statement.');
    const account =
      accounts &&
      [
        'com.rezics.access.account-updated.v1',
        'com.rezics.access.account-tombstoned.v1',
        'com.rezics.access.account-discovery-changed.v1',
      ].includes(event.type);
    if (!subject && !account) return { ...state, bridge: result.next };
    const route = event.subject === null ? null : routeOf(event.subject);
    if (route === null || (subject && partitionOf(route) !== state.partition))
      throw new BindingError('binding_mismatch');
    // The event home and the Account home may differ (claim delivery). Resolve
    // the owner on the next bounded step; no foreign home is joined here.
    const { bridge: _bridge, ...rest } = state;
    const owner = await readPartition(db, partitionOf(route));
    if (!owner || owner.writeState !== 'active') throw new BindingError('owner_unavailable');
    return {
      ...rest,
      owner: account ? 'accounts' : 'semantic',
      partition: partitionOf(route),
      epoch: owner.epoch,
      subject: event.subject,
      after: null,
      phase: account ? 'account' : 'advance',
      advance: retained?.advance ?? randomUUID(),
      version: null,
      projection: null,
      resumeBridge: result.next,
    };
  }
  function producedRepair(
    bootstrap: string,
    execution: string,
    step: string,
    projection: Projection,
    locator: PublicFilterRepairLocator,
  ): PublicSourceRepair {
    const receipt = Object.freeze({
      bootstrap,
      execution,
      step,
      locatorDigest: hash(encode(locator)),
      [nativeSourceRepairReceipt]: true as const,
    });
    return {
      kind: locator.dependencies.some(
        (dependency) => 'route' in dependency && partitionOf(dependency.route) !== projection.source.partition,
      )
        ? 'foreign'
        : 'local',
      locator,
      source: projection.source,
      projection,
      receipt,
    };
  }
  async function currentRepairHome(
    bootstrap: string,
    execution: string,
    state: RepairState,
    source: PublicFilterProjectionObservation,
    db: Pool,
  ): Promise<void> {
    const route = routeOf(state.subject!);
    if (
      route === null ||
      partitionOf(route) !== state.partition ||
      state.phase !== 'project' ||
      state.version === null ||
      state.epoch === null ||
      source.subject !== state.subject ||
      source.partition !== state.partition ||
      source.epoch !== state.epoch ||
      source.position < state.version
    )
      throw new BindingError('binding_mismatch');
    // A single home-local statement is the last source-home read after staged foreign projection work.
    const current = await repairCurrent.run(db, {
      partition_no: state.partition,
      bootstrap: nativeId(bootstrap),
      execution,
      step: state.advance,
      route,
      subject_id: state.subject!,
      source_position: String(source.position),
      security_revision: source.securityRevision,
      current_release: source.currentRelease,
      revision: source.revision,
      terminal: source.terminal,
    });
    if (!current || current.owner_epoch !== source.epoch || BigInt(current.position) !== state.version)
      throw new BindingError('configuration_changed');
  }
  function repairChain(bootstrap: PublicSourceBootstrap, joined: Joined) {
    if (!joined.execution) throw new BindingError('execution_missing');
    return {
      bootstrap: nativeId(bootstrap.id),
      execution: joined.execution.id,
      binding: hash(
        encode({
          definition: bootstrap.definition,
          consumer: bootstrap.consumer,
          snapshot: bootstrap.snapshot,
          covered: joined.covered,
          queried: joined.queried,
          execution: joined.execution,
        }),
      ),
    };
  }
  async function accountRepairKey(state: RepairState, db: Pool, cost: BindingCost) {
    const claims = state.claimInputs === true;
    cost.inputKeys += claims ? 3 : 2;
    // Return each arm's admitted point so actual rows and bytes, including the
    // losing lookahead, are charged. The bounded merge never scans a home.
    const keys = (
      await db.query<{ route: number; id: string }>(
        `SELECT route,id::text FROM (
         (SELECT route,account_id AS id FROM access.account
          WHERE route >= $1 AND route < $2 AND (route,account_id)>($3,$4::uuid)
          ORDER BY route,account_id LIMIT 1)
         UNION ALL
         (SELECT route,account_id AS id FROM access.account_discovery_intent
          WHERE route >= $1 AND route < $2 AND (route,account_id)>($3,$4::uuid)
          ORDER BY route,account_id LIMIT 1)
         ${
           claims
             ? `UNION ALL
         (SELECT route,account_id AS id FROM access.account_discovery_claim_intent
          WHERE route >= $1 AND route < $2 AND (route,account_id)>($3,$4::uuid)
          ORDER BY route,account_id LIMIT 1)`
             : ''
         }
       ) keys`,
        [
          state.partition * 16,
          (state.partition + 1) * 16,
          state.after?.route ?? state.partition * 16,
          state.after?.id ?? '00000000-0000-0000-0000-000000000000',
        ],
      )
    ).rows;
    return keys.sort((a, b) => a.route - b.route || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)))[0];
  }
  async function nextAccountRepair(state: RepairState, db: Pool, cost: BindingCost): Promise<RepairState> {
    if (state.epoch === null || state.resumeAccountScan || state.resumeBridge)
      throw new BindingError('binding_mismatch');
    const key = await accountRepairKey(state, db, cost);
    if (!key) return { ...state, partition: state.partition + 1, after: null, epoch: null };
    const route = routeOf(key.id);
    if (route === null) throw new BindingError('binding_mismatch');
    const home = partitionOf(route);
    if (home === state.partition) return { ...state, subject: key.id, after: key, phase: 'account' };
    if (state.claimInputs !== true) throw new BindingError('binding_mismatch');
    // A claim's route is not the Account's route. Keep its exact original raw
    // key frontier, release that home, then read the actual Account owner.
    const owner = await readPartition(db, home);
    if (!owner || owner.writeState !== 'active') throw new BindingError('owner_unavailable');
    return {
      ...state,
      partition: home,
      epoch: owner.epoch,
      subject: key.id,
      after: null,
      phase: 'account',
      resumeAccountScan: { partition: state.partition, epoch: state.epoch, after: key },
    };
  }
  function terminalRepairState(state: RepairState): boolean {
    return (
      state.partition === 4096 &&
      state.owner === 'semantic' &&
      state.phase === 'window' &&
      state.subject === null &&
      state.after === null &&
      state.epoch === null &&
      state.version === null &&
      state.projection === null &&
      state.bridge === undefined &&
      state.resumeBridge === undefined &&
      state.resumeAccountScan === undefined &&
      state.claimInputs === true
    );
  }
  async function repairNative(
    bootstrap: PublicSourceBootstrap,
    joined: Joined,
    request: { execution: string; frontier: string | null; inputLimit: number },
    db: Pool,
    cost: BindingCost,
    context: PublicFilterConsumerContext,
  ): Promise<PublicSourceRepairPage> {
    const id = nativeId(bootstrap.id);
    if (
      !request.execution ||
      request.execution.length > 4096 ||
      (request.frontier !== null && !uuid.test(request.frontier))
    )
      throw new BindingError('binding_mismatch');
    const chain = repairChain(bootstrap, joined);
    if (request.frontier !== null && !(await readPublicFilterRepairVerification(db, chain, request.frontier))) {
      const tip = await readPublicFilterRepairVerificationTip(db, chain);
      if (tip?.complete) throw new BindingError('binding_mismatch');
      const verified = await bootstrapBinding.readRepairStep!(
        {
          bootstrap: bootstrap.id,
          queried: joined.queried,
          execution: request.execution,
          predecessor: tip?.step ?? null,
        },
        context,
      );
      addCost(cost, verified.cost);
      if (verified.status !== 'verified' || !(await readPublicFilterRepairVerification(db, chain, request.frontier)))
        return fail('owner_unavailable', cost);
    }
    const old = await repairRead.run(db, {
      bootstrap: id,
      execution: request.execution,
      predecessor: request.frontier ?? '',
    });
    if (old && (old.receipt_protocol !== 1 || old.input_limit !== request.inputLimit))
      throw new BindingError('owner_unavailable');
    const retainedLocatorDigests = old
      ? unpackRepairLocatorDigests(old.repair_locator_digests, old.input_limit!)
      : null;
    const replay = old ? decode<RepairRecord>(old.state) : null;
    const step = old?.step ?? randomUUID();
    let state: RepairState;
    if (replay) state = replay.input;
    else if (request.frontier !== null) {
      const previous = await repairState.run(db, {
        bootstrap: id,
        execution: request.execution,
        step: request.frontier,
      });
      if (!previous || previous.complete) throw new BindingError('binding_mismatch');
      state = decode<RepairRecord>(previous.state).next;
    } else
      state = {
        partition: 0,
        after: null,
        subject: null,
        phase: 'scan',
        advance: randomUUID(),
        version: null,
        epoch: null,
        projection: null,
        claimInputs: true,
      };
    let next = structuredClone(state);
    let repairs: PublicSourceRepair[] = [],
      output: RepairRecord['output'] = null,
      account: AccountDiscoveryRepairObservation | undefined,
      complete = false;
    if (state.partition === 4096) {
      if (state.phase === 'window') {
        // Every original scan, enrollment/pin and captured event successor was
        // independently checked before extending this native prefix. Completion
        // closes that captured window; it grants neither receiver ACK nor serving.
        if (
          !terminalRepairState(state) ||
          request.frontier === null ||
          !(await readPublicFilterRepairVerification(db, chain, request.frontier))
        )
          throw new BindingError('owner_unavailable');
        complete = true;
      } else if ('representation' in bootstrap.definition.capture && state.owner !== 'accounts') {
        next = { ...next, owner: 'accounts', partition: 0, after: null, subject: null, epoch: null, phase: 'scan' };
      } else {
        next = { ...next, owner: 'semantic', partition: 0, after: null, subject: null, epoch: null, phase: 'window' };
      }
    } else if (state.phase === 'window' || state.phase === 'bridge') {
      next = await advanceCreationBridge(
        bootstrap.id,
        state,
        db,
        context,
        'representation' in bootstrap.definition.capture,
        cost,
        replay?.next,
      );
    } else {
      const owner = await readPartition(db, state.partition);
      if (!owner || owner.writeState !== 'active') throw new BindingError('owner_unavailable');
      if (state.epoch !== null && state.epoch !== owner.epoch) throw new BindingError('configuration_changed');
      next.epoch = owner.epoch;
      if (state.owner === 'accounts') {
        if (state.phase === 'scan') {
          // Raw owner keys include fenced/tombstoned rows and outstanding native
          // deletion intents. Each arm seeks one indexed key; no live-only page
          // may silently drop a previously indexed Account.
          next = await nextAccountRepair(next, db, cost);
        } else if (state.phase === 'account' && state.subject !== null) {
          account = replay?.account ?? (await readAccountDiscoveryRepairObservation(db, state.subject, context));
          const current = await readAccountDiscoveryRepairObservation(db, state.subject, context);
          if (
            account.head.partition !== state.partition ||
            account.head.epoch !== owner.epoch ||
            !isDeepStrictEqual({ ...current, position: account.position }, account)
          )
            throw new BindingError('configuration_changed');
          cost.inputKeys += 2;
          cost.candidates++;
          next = state.resumeBridge
            ? resumeCreationBridge(next)
            : state.resumeAccountScan
              ? resumeAccountScan(next)
              : { ...next, subject: null, phase: 'scan' };
        } else throw new BindingError('binding_mismatch');
      } else if (state.phase === 'scan') {
        const key = await repairKeys.run(db, {
          partition_no: state.partition,
          after_route: state.after?.route ?? state.partition * 16,
          after_id: state.after?.id ?? '00000000-0000-0000-0000-000000000000',
        });
        if (!key) next = { ...next, partition: state.partition + 1, after: null, epoch: null };
        else {
          // Raw keys include hidden/redirected/rejected originals. No returned-hit subset supplies work.
          cost.candidates++;
          next = {
            ...next,
            subject: key.subject_id,
            after: { route: key.route, id: key.subject_id },
            phase: 'advance',
            advance: replay?.next.advance ?? randomUUID(),
            version: null,
            projection: null,
          };
        }
      } else if (state.phase === 'advance') {
        const route = routeOf(state.subject!);
        if (route === null || partitionOf(route) !== state.partition) throw new BindingError('binding_mismatch');
        const values = {
          partition_no: state.partition,
          bootstrap: id,
          execution: request.execution,
          step: state.advance,
          route,
          subject_id: state.subject!,
        };
        const advancement = await runCommand(
          db,
          {
            partition: state.partition,
            deadline: context.deadline,
            clock: publicFilterSourceOrigin(sourceReader(bootstrap.definition))?.clock ?? systemClock,
          },
          async (tx) => {
            const existing = await repairVersion.run(tx, values);
            if (existing && (existing.transaction_id === null || existing.native_xid === null))
              throw new BindingError('owner_unavailable');
            if (existing) return noEffect(existing);
            // The original advancement and its first genuine keyed privacy
            // baseline are both attempted writes, including a lost CAS.
            cost.resultWrites += 2;
            const result = await repairAdvance.run(tx, { ...values, transaction_id: currentCommand(tx).transactionId });
            const inserted = Array.isArray(result) ? result[0] : result;
            if (!inserted) throw new BindingError('owner_unavailable');
            return {
              value: inserted,
              events: [
                {
                  type: 'com.rezics.semantic.public-source.advanced.v1',
                  subject: state.subject!,
                  data: { id: state.subject!, bootstrap: id, execution: request.execution },
                },
              ],
            };
          },
        );
        if (advancement.value.owner_epoch !== owner.epoch || BigInt(advancement.value.position) > advancement.position)
          throw new BindingError('configuration_changed');
        next = { ...next, version: BigInt(advancement.value.position), phase: 'project' };
      } else {
        const source = sourceReader(bootstrap.definition);
        const origin = publicFilterSourceOrigin(source);
        if (!origin) throw new BindingError('source_missing');
        if (
          replay?.output &&
          (!replay.output.request ||
            replay.output.request.inputLimit !== request.inputLimit ||
            encode(replay.output.request.frontier) !== encode(state.projection))
        )
          throw new BindingError('binding_mismatch');
        const page = await readOriginalPublicFilterProjectionPage(
          origin,
          {
            subject: state.subject!,
            meaning: bootstrap.definition.meaning,
            inputLimit: request.inputLimit,
            frontier: state.projection,
            context,
          },
          {
            bootstrap: nativeId(bootstrap.id),
            execution: request.execution,
            predecessor: request.frontier,
          },
        );
        addCost(cost, page.cost);
        if (page.status !== 'progress' && page.status !== 'complete') {
          if (page.status === 'changed') throw new BindingError('binding_mismatch');
          throw new BindingError(
            page.reason === 'identity_pending'
              ? 'identity_pending'
              : page.reason === 'deadline'
                ? 'deadline'
                : 'owner_unavailable',
          );
        }
        if (
          page.source.partition !== state.partition ||
          page.source.subject !== state.subject ||
          page.source.epoch !== owner.epoch ||
          state.version === null ||
          page.source.position < state.version
        )
          throw new BindingError('binding_mismatch');
        await currentRepairHome(bootstrap.id, request.execution, state, page.source, db);
        const digest = projectionDigest(page);
        if (
          retainedLocatorDigests &&
          !isDeepStrictEqual(
            page.repairLocators.map((locator) => hash(encode(locator))),
            retainedLocatorDigests,
          )
        )
          throw new BindingError('binding_mismatch');
        if (replay?.output && replay.output.digest !== digest) throw new BindingError('binding_mismatch');
        output = replay?.output ?? {
          digest,
          source: page.source,
          frontier: page.frontier,
          request: { inputLimit: request.inputLimit, frontier: state.projection },
        };
        // This frontier was emitted by the real Source. Replays revalidate the exact source/version/content.
        const projection = { ...page, frontier: output.frontier };
        repairs = page.repairLocators.map((locator) => ({
          kind: locator.dependencies.some(
            (dependency) => 'route' in dependency && partitionOf(dependency.route) !== state.partition,
          )
            ? ('foreign' as const)
            : ('local' as const),
          locator,
          source: page.source,
          projection,
          receipt: Object.freeze({
            [nativeSourceRepairReceipt]: true as const,
            bootstrap: bootstrap.id,
            execution: request.execution,
            step,
            locatorDigest: hash(encode(locator)),
          }),
        }));
        next =
          page.status === 'complete'
            ? state.resumeBridge
              ? resumeCreationBridge(next)
              : { ...next, subject: null, phase: 'scan', projection: null, version: null }
            : { ...next, projection: output.frontier };
      }
    }
    checkDeadline(context);
    const record: RepairRecord = { input: state, next, output, ...(account ? { account } : {}) };
    if (replay && encode(record) !== encode(replay)) throw new BindingError('binding_mismatch');
    if (!old) {
      const saved = await repairSave.run(db, {
        bootstrap: id,
        execution: request.execution,
        step,
        predecessor: request.frontier ?? '',
        state: encode(record),
        complete,
        input_limit: request.inputLimit,
        repair_locator_digests: packRepairLocatorDigests(
          repairs.map((repair) => repair.locator),
          request.inputLimit,
        ),
      });
      // A concurrent successor cannot discard an independently produced Source page. Retry its retained predecessor.
      if (!(Array.isArray(saved) ? saved[0] : saved)) throw new BindingError('binding_mismatch');
      cost.frontierWrites++;
    }
    return complete
      ? { status: 'complete', repairs, frontier: null, cost }
      : { status: 'progress', repairs, frontier: step, cost };
  }
  async function joinNative(
    request: Parameters<PublicFilterSourceBinding['join']>[0],
    context: PublicFilterConsumerContext,
    maintenance = false,
  ): ReturnType<PublicFilterSourceBinding['join']> {
    let input: typeof request;
    try {
      input = structuredClone(request);
    } catch {
      return fail('binding_mismatch');
    }
    const deadline = context.deadline;
    return run({ deadline }, async (cost, db) => {
      const retained = await readPublicFilterConsumerCustody(pool, input, { deadline });
      addCost(cost, retained.cost);
      if (retained.status !== 'found') return { ...retained, cost };
      const definition = await loadDefinition(retained.definition.readDefinition, db);
      requireSameDefinition(definition, retained.definition);
      // Custody owns immutable root input and lineage. Never compare refill frontier/size to it.
      const cut = await loadBootstrap(retained.covered.observation, db, definition);
      if (
        cut.definition.readDefinition !== definition.readDefinition ||
        encode(cut.bootstrap.consumer) !== encode(retained.queried.consumer) ||
        cut.bootstrap.snapshot !== retained.queried.snapshot.kind ||
        cut.row.state === 'aborting' ||
        cut.row.state === 'aborted'
      )
        throw new BindingError('binding_mismatch');
      if (!maintenance) requirePopulationBaseline(cut.row);
      if (retained.execution !== null) {
        const startLocator = retained.execution.start.observation;
        if (startLocator.startsWith('population:')) {
          const start = (
            await db.query<{
              bootstrap: string;
              read_definition: string;
              consumer: string;
              observation: string;
              covered_generation: string;
              start_generation: string;
              owner_epoch: number;
            }>(
              `/* semantic.native-keyed:1:2 */
            SELECT bootstrap::text,read_definition::text,consumer,observation,
              covered_generation::text,start_generation::text,owner_epoch
            FROM semantic.public_filter_population_start WHERE partition_no=0 AND id=$1::uuid`,
              [nativePopulationStartId(startLocator)],
            )
          ).rows[0];
          if (
            !start ||
            start.bootstrap !== cut.row.bootstrap ||
            start.read_definition !== definition.readDefinition ||
            start.consumer !== encodePublicFilterNativeState(retained.queried.consumer) ||
            start.observation !== retained.queried.snapshot.observation ||
            start.covered_generation !== cut.row.coverage_generation ||
            start.owner_epoch !== definition.source.epoch
          )
            throw new BindingError('binding_mismatch');
        } else {
          const started = await loadBootstrap(startLocator, db, definition);
          if (
            started.definition.readDefinition !== definition.readDefinition ||
            encode(started.bootstrap.consumer) !== encode(retained.queried.consumer) ||
            started.bootstrap.snapshot !== retained.queried.snapshot.kind ||
            started.row.state === 'aborting' ||
            started.row.state === 'aborted'
          )
            throw new BindingError('binding_mismatch');
          if (!maintenance) requirePopulationBaseline(started.row);
        }
      }
      freeze(definition);
      return {
        status: 'joined' as const,
        definition,
        queried: retained.queried,
        covered: retained.covered,
        execution: retained.execution,
        cost,
      };
    });
  }
  const binding: PublicFilterSourceBinding = {
    async resolve(request, context) {
      // Capture all caller data and constructor identity before the first suspension.
      let meaning: PublicFilterProjectionMeaning, capture: PublicSourceCaptureInput;
      const origin = publicFilterSourceOrigin(request.source);
      if (!origin || origin.pool !== pool || origin.access !== access || hash(origin.routeKey) !== routeDigest)
        return fail('source_missing');
      try {
        meaning = structuredClone(request.meaning);
        capture = structuredClone(request.capture);
      } catch {
        return fail('binding_mismatch');
      }
      return run(context, async (cost, db) => {
        const keys = allCaptureKeys(meaning, capture);
        const encoded = encode(capture);
        if (Buffer.byteLength(encoded) > 1048576) throw new BindingError('binding_mismatch');
        // Caller digest equality is checked again against the actual immutable release owner.
        const release = await readRelease(db, meaning.digest);
        if (!release || !isDeepStrictEqual(release, meaning.release) || !release.types[meaning.type])
          throw new BindingError('definition_missing');
        const source = (await registerSource.run(db, { route_digest: routeDigest }))[0];
        if (!source) throw new BindingError('owner_unavailable');
        const definition = (
          await defineSource.run(db, {
            source_id: source.source_id,
            configuration: source.configuration,
            route_digest: routeDigest,
            release_digest: meaning.digest,
            subject_type: meaning.type,
            capture_digest: hash(encoded),
            capture: encoded,
            dependency_keys: keys,
            coverage_keys: [
              ...publicFilterCoverageKeys(keys),
              ...('representation' in capture ? [PUBLIC_FILTER_ACCOUNT_DOMAIN] : []),
            ].sort(),
          })
        )[0];
        if (!definition) throw new BindingError('configuration_changed');
        const native = await loadDefinition(definition.read_definition, db);
        freeze(native);
        return { status: 'resolved' as const, definition: native, cost };
      });
    },
    join: joinNative,
  };
  async function beginRetained(
    request: Parameters<PublicFilterSourceBootstrapBinding['begin']>[0],
    context: PublicFilterConsumerContext,
    retainedId?: string,
  ): Promise<NativePublicFilterPreparation> {
    const deadline = context.deadline;
    let capture: PublicSourceCaptureInput, consumer: PublicFilterConsumer;
    const snapshot = request.snapshot;
    try {
      capture = structuredClone(request.capture);
      consumer = structuredClone(request.consumer);
      publicFilterCatalogue(consumer, 'representation' in capture);
    } catch {
      return fail('binding_mismatch');
    }
    if (snapshot !== 'pit' && snapshot !== 'prepared') return fail('binding_mismatch');
    const resolved = await binding.resolve({ source: request.source, meaning: request.meaning, capture }, { deadline });
    if (resolved.status !== 'resolved') return resolved;
    readers.set(resolved.definition.source.id, request.source);
    return run({ deadline }, async (cost, db) => {
      addCost(cost, resolved.cost);
      // Validate the already registered physical consumer through its real owner, before making a cut.
      const registration = await readGenerationPublicationCustody(pool, consumer, 0, { deadline });
      addCost(cost, registration.cost);
      if (!('definition' in registration)) return { ...registration, cost };
      requireSameDefinition(resolved.definition, registration.definition);
      if (
        consumer.readDefinition !== resolved.definition.readDefinition ||
        consumer.meaningDigest !== resolved.definition.meaning.digest
      )
        throw new BindingError('binding_mismatch');
      const existing = retainedId === undefined ? null : await loadBootstrap(retainedId, db, resolved.definition);
      if (
        existing &&
        (encode(existing.bootstrap.consumer) !== encode(consumer) ||
          existing.bootstrap.snapshot !== snapshot ||
          (existing.row.state !== 'capturing' && existing.row.state !== 'begun'))
      )
        throw new BindingError('binding_mismatch');
      const inserted = existing
        ? { bootstrap: existing.row.bootstrap }
        : (
            await beginBootstrap.run(db, {
              bootstrap: randomUUID(),
              read_definition: resolved.definition.readDefinition,
              request_key: hash(encode({ consumer, snapshot })),
              consumer: encode(consumer),
              snapshot_kind: snapshot,
              mixed: 'representation' in capture,
            })
          )[0];
      if (!inserted) throw new BindingError('configuration_changed');
      const cut = await loadBootstrap('0:' + inserted.bootstrap, db, resolved.definition);
      if (cut.row.state === 'capturing') {
        const baseline = {
          bootstrap: inserted.bootstrap,
          registration: registration.registration,
          definition: resolved.definition.readDefinition,
          consumer: encodePublicFilterNativeState(consumer),
          accounts: 'representation' in capture,
        };
        await beginPublicFilterCoverageBaseline(db, baseline, deadline);
        // One original native home per retained preparation step. Account and
        // Source writers share the locks used by this enrollment. Its original
        // tuple survives replay and is not replaced by a current read snapshot.
        const keys = publicFilterCoverageKeys(resolved.definition.dependencyKeys);
        // The new original enrollment retains both native heads. Their FK
        // controls are separate from the earlier explicit owner-head reads,
        // including a rejected or replayed enrollment attempt.
        cost.inputKeys += 2;
        cost.dependencyPoints += 2;
        cost.rows += 2;
        const receipt = await enrollAccountDiscoveryHome(
          db,
          {
            partition: cut.row.account_after,
            bootstrap: inserted.bootstrap,
            registration: registration.registration,
            readDefinition: resolved.definition.readDefinition,
            keys: 'representation' in capture ? [...keys, PUBLIC_FILTER_ACCOUNT_DOMAIN].sort() : keys,
            accounts: 'representation' in capture,
          },
          { deadline },
        );
        if (!receipt.complete) return { status: 'preparing' as const, bootstrap: cut.bootstrap, cost };
        // Reserve the deferred original-baseline -> current-summary retention
        // control before staging adoption; rollback cannot refund the attempt.
        cost.inputKeys += 3;
        cost.dependencyPoints++;
        cost.rows++;
        const adopted = await adoptPublicFilterCoverageBaseline(db, baseline, receipt, deadline);
        const advanced = (
          await accountPage.run(db, {
            bootstrap: inserted.bootstrap,
            after_partition: cut.row.account_after,
            next_partition: cut.row.account_after + 1,
            head_count: 1,
            coverage_generation: String(adopted.generation),
            coverage_root: adopted.root,
            registration: registration.registration.id,
            heads: [
              {
                partition: receipt.partition,
                epoch: receipt.epoch,
                revision: String(receipt.revision),
                claim_revision: String(receipt.claimRevision),
              },
            ],
          })
        )[0];
        if (!advanced || cut.row.account_after + 1 !== 4096)
          return { status: 'preparing' as const, bootstrap: cut.bootstrap, cost };
      }
      const begun = await loadBootstrap('0:' + inserted.bootstrap, db, resolved.definition);
      if (begun.row.state !== 'begun' || !begun.row.coverage_sealed || begun.row.coverage_after !== 4096)
        throw new BindingError('owner_unavailable');
      return { status: 'begun' as const, bootstrap: begun.bootstrap, cost };
    });
  }

  const bootstrapBinding: PublicFilterSourceBootstrapBinding = {
    ...binding,
    async readRepairStep(request, context) {
      const input = structuredClone(request),
        deadline = context.deadline;
      return run({ deadline }, async (cost, db) => {
        if (
          !input.bootstrap.startsWith('0:') ||
          !input.execution ||
          input.execution.length > 4096 ||
          (input.predecessor !== null && !uuid.test(input.predecessor))
        )
          throw new BindingError('binding_mismatch');
        const bootstrapId = nativeId(input.bootstrap);
        const joined = await joinNative({ queried: input.queried, execution: input.execution }, { deadline }, true);
        addCost(cost, joined.cost);
        if (joined.status !== 'joined') return { ...joined, cost };
        const cut = await loadBootstrap(input.bootstrap, db, joined.definition);
        if (
          cut.row.state !== 'adopted' ||
          cut.row.queried !== joined.queried.snapshot.observation ||
          encode(cut.bootstrap.covered) !== encode(joined.covered)
        )
          throw new BindingError('binding_mismatch');
        const row = await repairRead.run(db, {
          bootstrap: bootstrapId,
          execution: input.execution,
          predecessor: input.predecessor ?? '',
        });
        if (!row || row.receipt_protocol !== 1 || row.input_limit === null || row.predecessor !== input.predecessor)
          throw new BindingError('owner_unavailable');
        const record = decode<RepairRecord>(row.state);
        const receiptDigests = unpackRepairLocatorDigests(row.repair_locator_digests, row.input_limit);
        // Resolve the actual native predecessor, not an asserted matching cursor.
        // Its immutable successor binds the next input even on a crash/replay.
        if (input.predecessor !== null) {
          const predecessor = await repairState.run(db, {
            bootstrap: bootstrapId,
            execution: input.execution,
            step: input.predecessor,
          });
          if (
            !predecessor ||
            predecessor.complete ||
            predecessor.receipt_protocol !== 1 ||
            encode(decode<RepairRecord>(predecessor.state).next) !== encode(record.input)
          )
            throw new BindingError('binding_mismatch');
        } else if (
          record.input.partition !== 0 ||
          record.input.owner !== undefined ||
          record.input.phase !== 'scan' ||
          record.input.after !== null ||
          record.input.subject !== null ||
          record.input.epoch !== null ||
          record.input.version !== null ||
          record.input.projection !== null ||
          record.input.bridge !== undefined ||
          record.input.resumeBridge !== undefined ||
          record.input.resumeAccountScan !== undefined
        ) {
          throw new BindingError('binding_mismatch');
        }
        const chain = repairChain(cut.bootstrap, joined);
        if (!uuid.test(row.step) || !uuid.test(record.input.advance)) throw new BindingError('binding_mismatch');
        let expected: RepairState | undefined;
        if (row.complete) {
          if (
            !terminalRepairState(record.input) ||
            input.predecessor === null ||
            record.output !== null ||
            record.account !== undefined ||
            receiptDigests.length !== 0 ||
            !(await readPublicFilterRepairVerification(db, chain, input.predecessor))
          )
            throw new BindingError('owner_unavailable');
          expected = record.input;
        } else if (record.input.partition === 4096) {
          if (
            record.input.phase !== 'scan' ||
            record.input.subject !== null ||
            record.input.after !== null ||
            record.input.epoch !== null ||
            record.output !== null ||
            record.account !== undefined ||
            receiptDigests.length !== 0
          )
            throw new BindingError('binding_mismatch');
          expected =
            'representation' in cut.definition.capture && record.input.owner !== 'accounts'
              ? {
                  ...record.input,
                  owner: 'accounts',
                  partition: 0,
                  after: null,
                  subject: null,
                  epoch: null,
                  phase: 'scan',
                }
              : {
                  ...record.input,
                  owner: 'semantic',
                  partition: 0,
                  after: null,
                  subject: null,
                  epoch: null,
                  phase: 'window',
                };
        } else if (record.output) {
          if (
            record.input.phase !== 'project' ||
            record.input.subject === null ||
            !record.output.request ||
            record.output.request.inputLimit !== row.input_limit ||
            encode(record.output.request.frontier) !== encode(record.input.projection)
          )
            throw new BindingError('owner_unavailable');
          const page = await readRetainedPublicFilterProjectionPage(
            db,
            {
              identity: {
                bootstrap: nativeId(input.bootstrap),
                execution: input.execution,
                predecessor: input.predecessor,
              },
              subject: record.input.subject,
              meaning: cut.definition.meaning,
              inputLimit: row.input_limit,
              frontier: record.input.projection,
            },
            { deadline },
          );
          if (!page) throw new BindingError('owner_unavailable');
          if (page.status !== 'progress' && page.status !== 'complete')
            throw new BindingError(page.status === 'changed' ? 'binding_mismatch' : 'owner_unavailable');
          // Charge this original-page verification, rather than replaying the
          // historical producer's SQL/Access accounting from its serialized page.
          cost.candidates += page.records.length;
          cost.inputKeys += page.repairLocators.length;
          const currentDigests = page.repairLocators.map((locator) => hash(encode(locator)));
          if (
            projectionDigest(page) !== record.output.digest ||
            encode(page.source) !== encode(record.output.source) ||
            encode(page.frontier) !== encode(record.output.frontier) ||
            !isDeepStrictEqual(currentDigests, receiptDigests)
          )
            throw new BindingError('binding_mismatch');
          if (
            !(await retainedPublicFilterProjectionDependenciesCurrent(
              db,
              {
                page,
                meaning: cut.definition.meaning,
              },
              { deadline },
            ))
          )
            throw new BindingError('owner_unavailable');
          await currentRepairHome(input.bootstrap, input.execution, record.input, page.source, db);
          expected =
            page.status === 'complete'
              ? record.input.resumeBridge
                ? resumeCreationBridge(record.input)
                : { ...record.input, subject: null, phase: 'scan', projection: null, version: null }
              : { ...record.input, projection: record.output.frontier };
        } else if (record.account) {
          if (
            record.input.owner !== 'accounts' ||
            record.input.phase !== 'account' ||
            record.input.subject !== record.account.id ||
            receiptDigests.length !== 0
          )
            throw new BindingError('binding_mismatch');
          const current = await readAccountDiscoveryRepairObservation(db, record.account.id, { deadline });
          if (
            !isDeepStrictEqual({ ...current, position: record.account.position }, record.account) ||
            record.account.head.partition !== record.input.partition ||
            record.account.head.epoch !== record.input.epoch
          )
            throw new BindingError('configuration_changed');
          expected = record.input.resumeBridge
            ? resumeCreationBridge(record.input)
            : record.input.resumeAccountScan
              ? resumeAccountScan(record.input)
              : { ...record.input, subject: null, phase: 'scan' };
        } else if (record.input.phase === 'window' || record.input.phase === 'bridge') {
          if (
            receiptDigests.length !== 0 ||
            record.input.partition >= 4096 ||
            (record.input.phase === 'window' && (!record.next.bridge || record.next.phase !== 'bridge'))
          )
            throw new BindingError('binding_mismatch');
          expected = await advanceCreationBridge(
            input.bootstrap,
            record.input,
            db,
            { deadline },
            'representation' in cut.definition.capture,
            cost,
            record.next,
          );
        } else if ((record.input.phase !== 'scan' && record.input.phase !== 'advance') || receiptDigests.length !== 0) {
          throw new BindingError('owner_unavailable');
        } else if (record.input.phase === 'scan') {
          const state = record.input;
          if (
            state.partition < 0 ||
            state.partition >= 4096 ||
            !Number.isInteger(state.partition) ||
            state.subject !== null ||
            state.projection !== null ||
            state.bridge ||
            state.resumeBridge ||
            state.resumeAccountScan
          )
            throw new BindingError('binding_mismatch');
          const owner = await readPartition(db, state.partition);
          if (!owner || owner.writeState !== 'active' || (state.epoch !== null && state.epoch !== owner.epoch))
            throw new BindingError('configuration_changed');
          const base = { ...state, epoch: owner.epoch };
          if (state.owner === 'accounts') {
            expected = await nextAccountRepair(base, db, cost);
          } else {
            const key = await repairKeys.run(db, {
              partition_no: state.partition,
              after_route: state.after?.route ?? state.partition * 16,
              after_id: state.after?.id ?? '00000000-0000-0000-0000-000000000000',
            });
            if (!uuid.test(record.next.advance)) throw new BindingError('binding_mismatch');
            expected = key
              ? {
                  ...base,
                  subject: key.subject_id,
                  after: { route: key.route, id: key.subject_id },
                  phase: 'advance',
                  advance: record.next.advance,
                  version: null,
                  projection: null,
                }
              : { ...base, partition: state.partition + 1, after: null, epoch: null };
          }
        } else if (record.input.phase === 'advance') {
          const route = record.input.subject === null ? null : routeOf(record.input.subject);
          if (
            route === null ||
            partitionOf(route) !== record.input.partition ||
            record.input.epoch === null ||
            record.next.phase !== 'project' ||
            record.next.epoch !== record.input.epoch ||
            record.next.version === null
          )
            throw new BindingError('binding_mismatch');
          const advancement = await repairVersion.run(db, {
            partition_no: record.input.partition,
            bootstrap: bootstrapId,
            execution: input.execution,
            step: record.input.advance,
            route,
            subject_id: record.input.subject!,
          });
          const owner = await readPartition(db, record.input.partition);
          if (
            !advancement ||
            advancement.transaction_id === null ||
            advancement.native_xid === null ||
            advancement.owner_epoch !== record.input.epoch ||
            BigInt(advancement.position) !== record.next.version ||
            !owner ||
            owner.writeState !== 'active' ||
            owner.epoch !== advancement.owner_epoch
          )
            throw new BindingError('owner_unavailable');
          expected = { ...record.input, epoch: owner.epoch, version: BigInt(advancement.position), phase: 'project' };
        }
        if (!expected || encode(expected) !== encode(record.next)) throw new BindingError('binding_mismatch');
        const current = await loadBootstrap(input.bootstrap, db);
        if (
          current.row.state !== 'adopted' ||
          current.row.queried !== cut.row.queried ||
          encode(current.definition) !== encode(cut.definition)
        )
          throw new BindingError('configuration_changed');
        await retainPublicFilterRepairVerification(
          db,
          chain,
          {
            step: row.step,
            predecessor: row.predecessor,
            state: row.state,
            complete: row.complete,
            inputLimit: row.input_limit,
            digests: row.repair_locator_digests!,
            ...(record.input.phase === 'bridge' &&
            record.input.bridge &&
            record.input.bridge.position > record.input.bridge.through &&
            record.next.phase === 'window' &&
            record.next.partition === record.input.partition + 1
              ? { closedHome: record.input.partition }
              : {}),
          },
          { deadline },
          (controls) => {
            cost.rows += controls.rows;
            cost.dependencyPoints += controls.rows;
            cost.inputKeys += controls.keys;
            cost.bytes += controls.bytes;
            cost.frontierWrites += controls.frontierWrites ?? 0;
          },
        );
        return {
          status: 'verified' as const,
          step: row.step,
          predecessor: row.predecessor,
          frontier: row.complete ? null : row.step,
          complete: row.complete,
          receipts: receiptDigests.map((locatorDigest) => ({
            bootstrap: input.bootstrap,
            execution: input.execution,
            step: row.step,
            locatorDigest,
          })),
          cost,
        };
      });
    },
    async readRepairReceipt(request, context) {
      // Copy data fields only: neither an in-process brand nor its deserialized absence is evidence.
      const receipt: NativeSourceRepairLocator = {
        bootstrap: request.receipt.bootstrap,
        execution: request.receipt.execution,
        step: request.receipt.step,
        locatorDigest: request.receipt.locatorDigest,
      };
      const queried = structuredClone(request.queried),
        execution = request.execution,
        deadline = context.deadline;
      return run({ deadline }, async (cost, db) => {
        if (
          receipt.execution !== execution ||
          !uuid.test(receipt.step) ||
          !/^[0-9a-f]{64}$/.test(receipt.locatorDigest)
        )
          throw new BindingError('binding_mismatch');
        // Preparation stays acyclic: this is basic immutable Search custody, never its settlement reader.
        const joined = await joinNative({ queried, execution }, { deadline }, true);
        addCost(cost, joined.cost);
        if (joined.status !== 'joined') return { ...joined, cost };
        const cut = await loadBootstrap(receipt.bootstrap, db, joined.definition);
        if (
          cut.row.state !== 'adopted' ||
          cut.row.queried !== joined.queried.snapshot.observation ||
          encode(cut.bootstrap.covered) !== encode(joined.covered)
        )
          throw new BindingError('binding_mismatch');
        const row = await repairState.run(db, {
          bootstrap: nativeId(receipt.bootstrap),
          execution,
          step: receipt.step,
        });
        if (!row || row.receipt_protocol !== 1 || row.input_limit === null) throw new BindingError('owner_unavailable');
        const receiptDigests = unpackRepairLocatorDigests(row.repair_locator_digests, row.input_limit);
        const record = decode<RepairRecord>(row.state);
        if (!record.output || record.input.phase !== 'project' || row.complete)
          throw new BindingError('binding_mismatch');
        // Resolve the exact original native projection input and allowance. A freshly generated build,
        // changed continuation, newer Source position or equivalent caller body fails the digest check.
        const page = await readRetainedPublicFilterProjectionPage(
          db,
          {
            identity: { bootstrap: nativeId(receipt.bootstrap), execution: execution, predecessor: row.predecessor },
            subject: record.input.subject!,
            meaning: cut.definition.meaning,
            inputLimit: row.input_limit,
            frontier: record.input.projection,
          },
          { deadline },
        );
        if (!page) throw new BindingError('owner_unavailable');
        if (page.status !== 'progress' && page.status !== 'complete')
          throw new BindingError(page.status === 'changed' ? 'binding_mismatch' : 'owner_unavailable');
        cost.candidates += page.records.length;
        cost.inputKeys += page.repairLocators.length;
        if (
          projectionDigest(page) !== record.output.digest ||
          encode(page.source) !== encode(record.output.source) ||
          encode(page.frontier) !== encode(record.output.frontier) ||
          !isDeepStrictEqual(
            page.repairLocators.map((locator) => hash(encode(locator))),
            receiptDigests,
          )
        )
          throw new BindingError('binding_mismatch');
        const locator = page.repairLocators.find((candidate) => hash(encode(candidate)) === receipt.locatorDigest);
        if (!locator) throw new BindingError('binding_mismatch');
        // Validate original retained foreign heads, then recheck local native authority
        // after releasing those homes. No newly produced page can replace the original.
        if (
          !(await retainedPublicFilterProjectionDependenciesCurrent(
            db,
            {
              page,
              meaning: cut.definition.meaning,
            },
            { deadline },
          ))
        )
          throw new BindingError('owner_unavailable');
        await currentRepairHome(receipt.bootstrap, execution, record.input, page.source, db);
        const current = await loadBootstrap(receipt.bootstrap, db);
        if (
          current.row.state !== 'adopted' ||
          current.row.queried !== cut.row.queried ||
          encode(current.definition) !== encode(cut.definition)
        )
          throw new BindingError('configuration_changed');
        return {
          status: 'verified' as const,
          repair: producedRepair(receipt.bootstrap, execution, receipt.step, page, locator),
          cost,
        };
      });
    },
    async begin(request, context) {
      const result = await beginRetained(request, context);
      return result.status === 'preparing' ? fail('owner_unavailable', result.cost) : result;
    },
    async adopt(request, context) {
      const input = structuredClone(request),
        deadline = context.deadline;
      const joined = await binding.join({ queried: input.queried }, { deadline });
      if (joined.status !== 'joined') return joined;
      return run({ deadline }, async (cost, db) => {
        addCost(cost, joined.cost);
        const cut = await loadBootstrap(input.bootstrap, db, joined.definition);
        if (
          encode(joined.covered) !== encode(cut.bootstrap.covered) ||
          joined.definition.readDefinition !== cut.definition.readDefinition ||
          encode(joined.queried.consumer) !== encode(cut.bootstrap.consumer) ||
          joined.queried.snapshot.kind !== cut.bootstrap.snapshot
        )
          throw new BindingError('binding_mismatch');
        if (
          !(
            await adoptBootstrap.run(db, {
              bootstrap: cut.row.bootstrap,
              observation: joined.queried.snapshot.observation,
            })
          )[0]
        )
          throw new BindingError('binding_mismatch');
        return { status: 'adopted' as const, bootstrap: cut.bootstrap, queried: joined.queried, cost };
      });
    },
    async abort(request, context) {
      const id = request.bootstrap;
      return run(context, async (cost, db) => {
        const cut = await loadBootstrap(id, db);
        const result = (await abortBootstrap.run(db, { bootstrap: cut.row.bootstrap }))[0];
        if (!result) throw new BindingError('configuration_changed');
        // Search's public lookup cannot distinguish closed from unknown/expired/uncertain native custody.
        // Persist the barrier and retain the cut; neither a timeout nor observation_lost proves closure.
        return { status: result.state === 'aborted' ? ('aborted' as const) : ('pending' as const), cost };
      });
    },
    async recover(request, context) {
      const id = request.bootstrap,
        deadline = context.deadline;
      return run({ deadline }, async (cost, db) => {
        const cut = await loadBootstrap(id, db);
        if (cut.row.state === 'aborting' || cut.row.state === 'aborted' || cut.row.state === 'capturing')
          return { status: 'pending' as const, cost };
        // Search may have committed retain/open before the caller crashed before adoption.
        // Resolve its actual owner record; an absent/uncertain observation never proves no physical effect.
        const native = await readGenerationPublicationCustody(
          pool,
          cut.bootstrap.consumer,
          0,
          { deadline },
          cut.row.queried ?? undefined,
        );
        addCost(cost, native.cost);
        if (!('definition' in native)) return { ...native, cost };
        requireSameDefinition(cut.definition, native.definition);
        if (native.queried === null) {
          if (cut.row.state !== 'begun' || cut.row.queried !== null || !cut.row.coverage_sealed)
            return { status: 'pending' as const, cost };
          return { status: 'begun' as const, bootstrap: cut.bootstrap, queried: null, cost };
        }
        const joined = await binding.join({ queried: native.queried }, { deadline });
        addCost(cost, joined.cost);
        if (joined.status !== 'joined') return { ...joined, cost };
        if (encode(joined.covered) !== encode(cut.bootstrap.covered)) return { status: 'pending' as const, cost };
        if (
          !(
            await adoptBootstrap.run(db, {
              bootstrap: cut.row.bootstrap,
              observation: joined.queried.snapshot.observation,
            })
          )[0]
        )
          throw new BindingError('binding_mismatch');
        return { status: 'adopted' as const, bootstrap: cut.bootstrap, queried: joined.queried, cost };
      });
    },
    async repairPage(request, context) {
      const input = structuredClone(request),
        deadline = context.deadline;
      if (!Number.isInteger(input.inputLimit) || input.inputLimit < 1 || input.inputLimit > 256)
        throw new RangeError('Repair inputLimit must be 1 through 256');
      const joined = await joinNative({ queried: input.queried, execution: input.execution }, { deadline }, true);
      if (joined.status !== 'joined') return joined;
      return run({ deadline }, async (cost, db) => {
        addCost(cost, joined.cost);
        const cut = await loadBootstrap(input.bootstrap, db, joined.definition);
        if (
          cut.row.state !== 'adopted' ||
          cut.row.queried !== joined.queried.snapshot.observation ||
          encode(joined.covered) !== encode(cut.bootstrap.covered)
        )
          throw new BindingError('binding_mismatch');
        return repairNative(cut.bootstrap, joined, input, db, cost, { deadline });
      });
    },
    async settle(request, context) {
      const input = structuredClone(request),
        deadline = context.deadline;
      const joined = await joinNative({ queried: input.queried, execution: input.execution }, { deadline }, true);
      if (joined.status !== 'joined') return joined;
      return run({ deadline }, async (cost, db) => {
        addCost(cost, joined.cost);
        const cut = await loadBootstrap(input.bootstrap, db, joined.definition);
        if (
          cut.row.state !== 'adopted' ||
          cut.row.queried !== joined.queried.snapshot.observation ||
          encode(joined.covered) !== encode(cut.bootstrap.covered)
        )
          throw new BindingError('binding_mismatch');
        const chain = repairChain(cut.bootstrap, joined);
        const seal = await readPublicFilterRepairHomeSeal(db, chain);
        // This is the actual independent terminal prefix, not the producer's
        // complete flag, an exhausted enumeration or a clean serving probe.
        if (!seal || seal.after < 0 || seal.after > 4096 || (seal.after < 4096 && !seal.step))
          throw new BindingError('owner_unavailable');
        const terminal = await readPublicFilterRepairVerification(db, chain, seal.terminal);
        if (!terminal?.complete || terminal.root !== seal.root || terminal.next !== null)
          throw new BindingError('binding_mismatch');
        const predecessor = seal.after === 4096 ? terminal.predecessor : seal.predecessor;
        const verify = async () => {
          const verified = await bootstrapBinding.readRepairStep(
            {
              bootstrap: input.bootstrap,
              queried: input.queried,
              execution: input.execution,
              predecessor,
            },
            { deadline },
          );
          addCost(cost, verified.cost);
          if (
            verified.status !== 'verified' ||
            verified.step !== (seal.after === 4096 ? seal.terminal : seal.step) ||
            verified.complete !== (seal.after === 4096)
          )
            throw new BindingError('owner_unavailable');
        };
        await verify();
        const original = seal.after === 4096 ? null : decode<RepairRecord>(seal.state);
        if (
          original &&
          (original.input.phase !== 'bridge' ||
            !original.input.bridge ||
            original.input.partition !== seal.home ||
            original.input.bridge.position <= original.input.bridge.through ||
            original.next.partition !== seal.home + 1 ||
            original.next.phase !== 'window')
        )
          throw new BindingError('binding_mismatch');
        const authority = async () => {
          if (!original) return null;
          // Reserve each of the six native relation points once, independently
          // of whether the join succeeds or returns no current authority.
          const row = (
            await db.query<{
              registration: string;
              registration_partition: number;
              owner_epoch: number;
              receipt: string;
              source_position: string;
              native_enqueue_revision: string;
              native_revision: string | null;
              native_claim_revision: string | null;
              current_position: string;
              current_creation: string;
              current_revision: string;
              current_claim: string;
            }>(
              `/* semantic.native-keyed:6:9 */
             SELECT e.registration,e.registration_partition,e.owner_epoch,e.receipt,e.source_position::text,
               e.native_enqueue_revision::text,e.native_revision::text,e.native_claim_revision::text,
               h.position::text AS current_position,p.position::text AS current_creation,
               a.revision::text AS current_revision,a.claim_revision::text AS current_claim,
               e.complete,p.epoch,p.write_state,h.owner_epoch AS source_epoch,
               c.consumer,c.position::text AS checkpoint_position,c.epoch AS checkpoint_epoch,
               b.state,b.coverage_sealed,b.coverage_after
             FROM semantic.public_filter_home_enrollment e
             JOIN core.partition p ON p.partition_no=e.partition_no
             JOIN semantic.public_filter_privacy_head h ON h.partition_no=e.partition_no
             JOIN access.account_discovery_population a ON a.partition_no=e.partition_no
             JOIN core.consumer_checkpoint c ON (c.partition_no,c.consumer)=(e.partition_no,e.creation_consumer)
             JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap)=(0,e.bootstrap)
             WHERE (e.partition_no,e.bootstrap)=($1,$2) AND e.complete AND e.receipt=$3
               AND e.read_definition=$4 AND p.write_state='active' AND p.epoch=e.owner_epoch
               AND h.owner_epoch=p.epoch AND h.position>=e.source_position
               AND c.position<=e.creation_position AND (c.epoch IS NULL OR c.epoch=p.epoch)
               AND b.state='adopted' AND b.coverage_sealed AND b.coverage_after=4096`,
              [seal.home, nativeId(input.bootstrap), original.input.bridge!.receipt, joined.definition.readDefinition],
            )
          ).rows[0];
          if (
            !row ||
            row.owner_epoch !== original.input.bridge!.epoch ||
            row.receipt !== original.input.bridge!.receipt ||
            BigInt(row.current_creation) < original.input.bridge!.through
          )
            throw new BindingError('configuration_changed');
          return row;
        };
        const before = await authority();
        const settled = await readPublicFilterRepairSettlement(
          pool,
          { queried: input.queried, execution: input.execution },
          { deadline },
        );
        addCost(cost, settled.cost);
        if (settled.status !== 'settled') return { ...settled, cost };
        requireSameDefinition(cut.definition, settled.definition);
        if (
          !isDeepStrictEqual(settled.queried, joined.queried) ||
          !joined.execution ||
          settled.execution.id !== joined.execution.id ||
          !isDeepStrictEqual(settled.execution.start, joined.execution.start) ||
          !isDeepStrictEqual(settled.execution.ownRows, joined.execution.ownRows)
        )
          throw new BindingError('binding_mismatch');
        // Search performs staged foreign owner reads. Re-read the original Source window after it
        // releases them; the native settlement locator alone cannot preserve Source currency.
        await verify();
        const after = await authority();
        if (!isDeepStrictEqual(before, after)) throw new BindingError('configuration_changed');
        if (after) {
          const baseline: PublicFilterRepairBaseline = {
            bootstrap: nativeId(input.bootstrap),
            registration: after.registration,
            registrationPartition: after.registration_partition,
            home: seal.home,
            epoch: after.owner_epoch,
            receipt: after.receipt,
            sourcePosition: after.source_position,
            enqueue: after.native_enqueue_revision,
            revision: after.native_revision,
            claimRevision: after.native_claim_revision,
            observation: settled.queried.snapshot.observation,
            execution: settled.execution.id,
            settlement: settled.settlement.id,
            consumer: encodePublicFilterNativeState(settled.queried.consumer),
            physicalTarget: settled.queried.consumer.physicalTarget,
            incarnation: settled.queried.consumer.incarnation,
          };
          await acknowledgePublicFilterRepairBaseline(db, baseline, deadline);
          // The Source frontier is adopted only after the actual registration
          // ACK commit. A crash before this CAS repeats that same prefix safely.
          cost.frontierWrites++;
          if (!(await advancePublicFilterRepairAckFrontier(db, chain, seal.terminal, seal.home)))
            throw new BindingError('owner_unavailable');
          if (seal.home !== 4095) return fail('owner_unavailable', cost);
        }
        return { ...joined, cost };
      });
    },
  };
  nativeRepairJoins.set(bootstrapBinding, (request, context) => joinNative(request, context, true));
  nativeRepairStarts.set(bootstrapBinding, async (request, context) => {
    const result = await run(context, async (cost, db) => {
      const joined = await joinNative({ queried: request.queried }, context, true);
      addCost(cost, joined.cost);
      if (joined.status !== 'joined') throw new BindingError(joined.reason);
      const cut = await loadBootstrap(request.bootstrap, db, joined.definition);
      if (
        !cut.row.coverage_sealed ||
        cut.row.coverage_after !== 4096 ||
        cut.row.state !== 'adopted' ||
        cut.row.queried !== joined.queried.snapshot.observation ||
        encode(cut.bootstrap.covered) !== encode(joined.covered)
      )
        throw new BindingError('binding_mismatch');
      // This is an original maintenance locator, not a clean population result.
      // It cannot authorize enumeration or renew an immutable served observation.
      return { status: 'start' as const, start: joined.covered, cost };
    });
    if (result.status !== 'start') throw new BindingError(result.reason);
    return result;
  });
  nativeAccountRepairs.set(bootstrapBinding, async (request, context) => {
    const result = await run(context, async (cost, db) => {
      const joined = await joinNative({ queried: request.queried, execution: request.execution }, context, true);
      addCost(cost, joined.cost);
      if (joined.status !== 'joined') throw new BindingError(joined.reason);
      const cut = await loadBootstrap(request.bootstrap, db, joined.definition);
      if (
        cut.row.state !== 'adopted' ||
        cut.row.queried !== joined.queried.snapshot.observation ||
        encode(cut.bootstrap.covered) !== encode(joined.covered)
      )
        throw new BindingError('binding_mismatch');
      const row = await repairRead.run(db, {
        bootstrap: nativeId(request.bootstrap),
        execution: request.execution,
        predecessor: request.predecessor ?? '',
      });
      if (!row || row.receipt_protocol !== 1) throw new BindingError('owner_unavailable');
      const record = decode<RepairRecord>(row.state);
      if (!record.account) return { status: 'account' as const, account: null, cost };
      if (
        row.complete ||
        !('representation' in cut.definition.capture) ||
        record.input.owner !== 'accounts' ||
        record.input.phase !== 'account' ||
        record.input.subject !== record.account.id ||
        record.account.head.partition !== record.input.partition ||
        record.account.head.epoch !== record.input.epoch
      )
        throw new BindingError('binding_mismatch');
      const current = await readAccountDiscoveryRepairObservation(db, record.account.id, context);
      if (!isDeepStrictEqual({ ...current, position: record.account.position }, record.account))
        throw new BindingError('configuration_changed');
      const original = await loadBootstrap(request.bootstrap, db, joined.definition);
      if (original.row.state !== 'adopted' || original.row.queried !== cut.row.queried)
        throw new BindingError('configuration_changed');
      return { status: 'account' as const, account: record.account, cost };
    });
    if (result.status !== 'account') throw new BindingError(result.reason);
    return result;
  });
  nativePreparations.set(bootstrapBinding, async (input, context) => {
    if (!('bootstrap' in input)) return beginRetained(input, context);
    const retained = await run(context, async (cost, db) => {
      const cut = await loadBootstrap(input.bootstrap, db);
      if (cut.row.state !== 'capturing' && cut.row.state !== 'begun') throw new BindingError('observation_lost');
      return { status: 'retained' as const, cut, cost };
    });
    if (retained.status !== 'retained') return retained;
    if (retained.cut.row.state === 'begun') {
      if (!retained.cut.row.coverage_sealed || retained.cut.row.coverage_after !== 4096)
        return fail('owner_unavailable', retained.cost);
      return { status: 'begun', bootstrap: retained.cut.bootstrap, cost: retained.cost };
    }
    const result = await beginRetained(
      {
        source: sourceReader(retained.cut.definition),
        meaning: retained.cut.definition.meaning,
        capture: retained.cut.definition.capture,
        consumer: retained.cut.bootstrap.consumer,
        snapshot: retained.cut.bootstrap.snapshot,
      },
      context,
      input.bootstrap,
    );
    addCost(retained.cost, result.cost);
    if ('bootstrap' in result && result.bootstrap.id !== input.bootstrap)
      return fail('observation_lost', retained.cost);
    return { ...result, cost: retained.cost };
  });
  return Object.freeze(bootstrapBinding);
}
