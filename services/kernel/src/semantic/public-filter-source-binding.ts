import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { nativePopulationStartId } from './public-filter-coverage-population.ts';
import {
  readOriginalPublicFilterProjectionPage,
  readRetainedPublicFilterProjectionPage,
  retainedPublicFilterProjectionDependenciesCurrent,
} from './public-filter-projection.ts';
import { systemClock } from '../clock.ts';
import { runCommand, noEffect, currentCommand } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import { readRelease } from './definition-release-read.ts';
import { nativeSourceQuery } from './native-source-query.ts';
import { freeze } from './core/freeze.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { ProblemError } from '../http/problem-error.ts';
import { CommandUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { withConnection, discardConnection, withQueryAccounting } from '../database/pool.ts';
import registerSource from './public-filter-source-binding-register.sql';
import defineSource from './public-filter-source-binding-define.sql';
import readDefinition from './public-filter-source-binding-definition.sql';
import beginBootstrap from './public-filter-source-binding-begin.sql';
import readBootstrap from './public-filter-source-binding-bootstrap.sql';
import adoptBootstrap from './public-filter-source-binding-adopt.sql';
import abortBootstrap from './public-filter-source-binding-abort.sql';
import accountPage from './public-filter-source-binding-account-page.sql';
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
import { publicFilterCreationConsumer } from './public-filter-creation-consumer.ts';
import {
  readPublicFilterRepairVerification,
  readPublicFilterRepairVerificationTip,
  retainPublicFilterRepairVerification,
  readPublicFilterRepairHomeSeal,
  advancePublicFilterRepairAckFrontier,
} from './public-filter-repair-chain.ts';
import repairState from './public-filter-source-binding-repair-state.sql';
import repairRead from './public-filter-source-binding-repair-read.sql';
import repairSave from './public-filter-source-binding-repair-save.sql';
import repairKeys from './public-filter-source-binding-repair-keys.sql';
import repairSourceScan from './public-filter-source-binding-repair-source-scan.sql';
import repairAccountScan from './public-filter-source-binding-repair-account-scan.sql';
import repairWindowScan from './public-filter-source-binding-repair-window-scan.sql';
import repairAdvance from './public-filter-source-binding-repair-advance.sql';
import repairVersion from './public-filter-source-binding-repair-version.sql';
import repairCurrent from './public-filter-source-binding-repair-current.sql';
import type { Pool, QueryResult } from 'pg';
import type { Access } from '../access/index.ts';
import type { AccountDiscoveryRepairObservation } from '../access/account-discovery-source.ts';
import type {
  DiscoveryConsumerCaptureInput,
  PublicCanonicalCaptureInput,
  PublicFilterConsumerCaptureInput,
  PublicSuggestionCaptureInput,
} from '../search/index.ts';
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
import type {
  NativeSourceBindingPorts,
  PublicFilterConsumerContext,
  PublicFilterConsumerUnavailable,
  PublicFilterQueriedObservation,
  SourceBindingRetainedDefinition,
  SourceBindingCustodyDefinition,
  SourceBindingRepairSettlement,
  SourceBindingFailureReason,
} from './source-binding-port.ts';
import { sourceBindingApplication } from './source-binding-application.ts';
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
        await client.query<{
          state: string;
          consumer: string;
          physical_target: string;
        }>(
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
  | Readonly<{
      kind: 'queried';
      phase: 'start' | 'status';
      queried: PublicFilterQueriedObservation;
    }>
  | Readonly<{
      kind: 'queried';
      phase: 'final';
      queried: PublicFilterQueriedObservation;
      execution: string;
    }>;

export interface PublicFilterNativeSource extends PublicFilterSource {
  resolvePublicFilterDefinition(
    request: Readonly<{
      meaning: PublicFilterProjectionMeaning;
      capture: PublicCanonicalCaptureInput;
    }>,
    context: PublicFilterConsumerContext,
  ): Promise<
    | Readonly<{
        status: 'bound';
        definition: SourceBindingCustodyDefinition<PublicCanonicalCaptureInput>;
        cost: PublicFilterCost;
      }>
    | PublicFilterConsumerUnavailable
  >;
  readPrivacyReductionHeads(request: PrivacyReductionObservationRequest): Promise<PrivacyReductionObservation>;
  readPrivacyReductionHeads(
    request: JoinedPopulationRequest,
    context: PublicFilterConsumerContext,
  ): Promise<PrivacyReductionObservation>;
}

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
  reason: SourceBindingFailureReason;
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
    | Readonly<{
        status: 'resolved';
        definition: PublicFilterSourceDefinition;
        cost: PublicFilterCost;
      }>
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
  | Readonly<{
      status: 'begun';
      bootstrap: PublicSourceBootstrap;
      cost: PublicFilterCost;
    }>
  | PublicFilterBindingFailure;
export type PublicSourceBootstrapRecovery =
  | Readonly<{
      status: 'begun';
      bootstrap: PublicSourceBootstrap;
      queried: null;
      cost: PublicFilterCost;
    }>
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
  | Readonly<{
      status: 'verified';
      repair: PublicSourceRepair;
      cost: PublicFilterCost;
    }>
  | PublicFilterBindingFailure;
export type PublicSourceRepair = Readonly<{
  kind: 'local' | 'foreign';
  locator: PublicFilterRepairLocator;
  source: PublicFilterProjectionObservation;
  projection: PublicFilterProjectionPage;
  receipt: NativeSourceRepairReceipt;
}>;
export type PublicSourceRepairPage =
  | Readonly<{
      status: 'progress';
      repairs: readonly PublicSourceRepair[];
      frontier: string;
      cost: PublicFilterCost;
    }>
  | Readonly<{
      status: 'complete';
      repairs: readonly PublicSourceRepair[];
      frontier: null;
      cost: PublicFilterCost;
    }>
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
      request: Readonly<{
        bootstrap: string;
        queried: PublicFilterQueriedObservation;
      }>,
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
      request: Readonly<{
        bootstrap: string;
        queried: PublicFilterQueriedObservation;
        execution: string;
      }>,
      context: PublicFilterConsumerContext,
    ): ReturnType<PublicFilterSourceBinding['join']>;
  }>;

/** Original Source operands retained for one Search generation job. No engine state is copied. */
export type NativePublicFilterPublication = Readonly<{
  job: string;
  bootstrap: string;
  queried: PublicFilterQueriedObservation;
  execution: string;
}>;
export type NativePublicFilterPublicationRequest = NativePublicFilterPublication | Readonly<{ job: string }>;
export type NativePublicFilterPublicationCompletion =
  | Readonly<{
      status: 'pending';
      publication: NativePublicFilterPublication;
      reason: PublicFilterBindingFailure['reason'];
      cost: PublicFilterCost;
    }>
  | Readonly<{
      status: 'complete';
      publication: NativePublicFilterPublication;
      definition: PublicFilterSourceDefinition;
      covered: PrivacyReductionStart;
      execution: NonNullable<
        Extract<Awaited<ReturnType<PublicFilterSourceBinding['join']>>, { status: 'joined' }>['execution']
      >;
      observation: Extract<PrivacyReductionObservation, { status: 'observed' }>;
      terminal: Readonly<{ step: string; root: string }>;
      settlement: SourceBindingRepairSettlement;
      cost: PublicFilterCost;
    }>
  | PublicFilterBindingFailure;
const nativePublicationCompletions = new WeakMap<
  PublicFilterSourceBinding,
  (
    request: NativePublicFilterPublicationRequest,
    context: PublicFilterConsumerContext,
  ) => Promise<NativePublicFilterPublicationCompletion>
>();

/** Resolve the persisted original job/cut, then independently read its native completion.
 * Search calls this from its existing publication writer fence. The result grants no activation.
 */
/** Public constructor resolves through the application installed by Semantic composition. */
export function createPublicFilterSourceBinding(
  pool: Pool,
  routing: Uint8Array,
  access: Access,
): PublicFilterSourceBootstrapBinding {
  return sourceBindingApplication().createBinding(pool, routing, access);
}

export async function readNativePublicFilterPublicationCompletion(
  binding: PublicFilterSourceBinding,
  request: NativePublicFilterPublicationRequest,
  context: PublicFilterConsumerContext,
): Promise<NativePublicFilterPublicationCompletion> {
  const read = nativePublicationCompletions.get(binding);
  return read
    ? read(request, context)
    : {
        status: 'unready',
        reason: 'source_missing',
        cost: publicFilterBindingCost(),
      };
}

/** Internal native preparation handoff; the bootstrap remains the original persisted Source cut. */
type NativePreparationInput =
  | (Parameters<PublicFilterSourceBootstrapBinding['begin']>[0] & Readonly<{ inputLimit?: number }>)
  | Readonly<{ bootstrap: string; inputLimit?: number }>;
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
  ) => Promise<
    Readonly<{
      account: AccountDiscoveryRepairObservation | null;
      cost: PublicFilterCost;
    }>
  >
>();
const nativeRepairStarts = new WeakMap<
  PublicFilterSourceBinding,
  (
    request: Readonly<{
      bootstrap: string;
      queried: PublicFilterQueriedObservation;
    }>,
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
  request: Readonly<{
    bootstrap: string;
    queried: PublicFilterQueriedObservation;
  }>,
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
  engineRequests: number;
};
function publicFilterBindingCost(): BindingCost {
  return {
    statements: 0,
    rows: 0,
    bytes: 0,
    engineRequests: 0,
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
export class PublicFilterSourceDefinitionError extends Error {
  constructor(readonly reason: PublicFilterBindingFailure['reason']) {
    super(reason);
  }
}
class BindingError extends PublicFilterSourceDefinitionError {}

/** Load only an existing immutable read definition. The optional byte cap lets native callers
 * debit a fixed upper bound before the retained capture and dependency keys are read.
 */
export async function readNativePublicFilterSourceDefinition(
  id: string,
  db: Pool,
  routeDigest: string,
  search: NativeSourceBindingPorts['search'],
  maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<Readonly<{ definition: PublicFilterSourceDefinition; bytes: number }>> {
  if (!uuid.test(id)) throw new BindingError('definition_missing');
  if (!/^[a-f0-9]{64}$/.test(routeDigest)) throw new TypeError('Invalid Source route digest');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('Invalid Source definition byte bound');
  const row = await nativeSourceQuery(db, readDefinition, {
    read_definition: id,
    max_bytes: maxBytes,
  });
  if (!row) throw new BindingError('definition_missing');
  if (row.route_digest !== routeDigest) throw new BindingError('configuration_changed');
  const bytes = Number(row.definition_bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes) throw new BindingError('binding_mismatch');
  const release = await readRelease(db, row.release_digest);
  if (!release || !release.types[row.subject_type]) throw new BindingError('definition_missing');
  let capture: PublicSourceCaptureInput;
  let keys: readonly PublicFilterDependencyKey[];
  const meaning = {
    digest: row.release_digest,
    release,
    type: row.subject_type,
  };
  try {
    capture = decode<PublicSourceCaptureInput>(row.capture);
    keys = search.deriveDependencyKeys(meaning, capture);
  } catch {
    throw new BindingError('binding_mismatch');
  }
  if (!isDeepStrictEqual(keys, row.dependency_keys)) throw new BindingError('binding_mismatch');
  return {
    definition: {
      source: {
        id: row.source_id,
        partition: 0,
        epoch: row.owner_epoch,
        configuration: row.configuration,
      },
      readDefinition: id,
      meaning,
      capture,
      dependencyKeys: keys,
    },
    bytes,
  };
}
function checkDeadline(context: PublicFilterConsumerContext): void {
  if (!Number.isFinite(context.deadline) || context.deadline <= Date.now()) throw new BindingError('deadline');
}
/** Charge native release lookups as well as Source SQL, including failed submissions. */
function measuredQueries<T>(cost: BindingCost, body: () => Promise<T>): Promise<T> {
  return withQueryAccounting(
    {
      async query(text, parameters, dispatch) {
        // Authored native point queries declare their complete keyed relation
        // footprint. Reserve it before submission, including misses, CAS loss
        // and thrown attempts. A joined result is not another native row.
        const native = /^\s*\/\* semantic\.native-keyed:(\d+):(\d+) \*\//.exec(text);
        const writes = native !== null && /^\s*(?:\/\*[\s\S]*?\*\/\s*)*(?:INSERT|UPDATE|DELETE)\b/.test(text);
        cost.statements++;
        cost.inputKeys += native ? Number(native[2]) : parameters.length;
        cost.bytes += Buffer.byteLength(text) + Buffer.byteLength(encode(parameters));
        if (native) {
          cost.rows += Number(native[1]);
          cost.dependencyPoints += Number(native[1]);
          if (writes) cost.resultWrites++;
        }
        const result = await dispatch();
        const { rowCount, rows } = result as QueryResult;
        if (!native) {
          cost.rows += rowCount ?? 0;
          cost.dependencyPoints += rowCount ?? 0;
        }
        cost.bytes += Buffer.byteLength(encode(rows));
        if (!native && /\b(INSERT|UPDATE|DELETE)\b/.test(text)) cost.resultWrites += rowCount ?? 0;
        return result;
      },
      connection: (dispatch) => dispatch(),
    },
    body,
  );
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

/** Native Source-owned registration; the origin association only locates the constructor configuration. */
export function createNativePublicFilterSourceBinding(
  pool: Pool,
  routing: Uint8Array,
  access: Access,
  ports: NativeSourceBindingPorts,
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
      const result = await withRequestDeadline(deadline, () => measuredQueries(cost, () => work(cost, pool)));
      checkDeadline({ deadline });
      return result;
    } catch (error) {
      if (error instanceof BindingError) return fail(error.reason, cost);
      if (error instanceof TypeError || error instanceof RangeError) return fail('binding_mismatch', cost);
      const reason = ports.access.classifyUnavailability(error);
      if (reason !== undefined || (error instanceof ProblemError && error.code === 'dependency_unavailable'))
        return fail(Date.now() >= deadline ? 'deadline' : 'owner_unavailable', cost);
      throw error;
    }
  }
  async function loadDefinition(id: string, db: Pool): Promise<PublicFilterSourceDefinition> {
    return (await readNativePublicFilterSourceDefinition(id, db, routeDigest, ports.search)).definition;
  }
  const readers = new Map<string, PublicFilterSource>();
  const sourceReader = (definition: PublicFilterSourceDefinition) =>
    readers.get(definition.source.id) ??
    ports.sourceFactory({
      pool,
      routeKey: new Uint8Array(nativeRouting),
      access,
      clock: systemClock,
    });
  function nativeId(locator: string): string {
    if (typeof locator !== 'string' || !locator.startsWith('0:') || !uuid.test(locator.slice(2)))
      throw new BindingError('observation_lost');
    return locator.slice(2);
  }
  function requireSameDefinition(own: PublicFilterSourceDefinition, retained: SourceBindingRetainedDefinition): void {
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
    const row = await nativeSourceQuery(db, readBootstrap, { bootstrap: nativeId(locator) });
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
    resumeAccountScan?: {
      partition: number;
      epoch: number;
      after: { route: number; id: string };
    };
  };
  type RepairRecord = {
    input: RepairState;
    next: RepairState;
    output: {
      digest: string;
      source: PublicFilterProjectionObservation;
      frontier: PublicFilterProjectionFrontier;
      request: {
        inputLimit: number;
        frontier: PublicFilterProjectionFrontier | null;
      };
    } | null;
    account?: AccountDiscoveryRepairObservation;
    scan?: Readonly<{ kind: 'semantic' | 'accounts'; homes: number; digest: string }>;
    windowBatch?: Readonly<{ from: number; count: number; examined: number; digest: string; packed: string }>;
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
  const repairHomeBatchLimit = 128;
  const preparationHomeBatchLimit = 16;
  const preparationInputLimit = 1000;
  const preparationHomeParameterEstimate = 96;
  async function scanSemanticHomes(
    state: RepairState,
    inputLimit: number,
    db: Pool,
    cost: BindingCost,
    retainedAdvance?: string,
  ): Promise<Readonly<{ next: RepairState; receipt: NonNullable<RepairRecord['scan']> }>> {
    if (
      state.phase !== 'scan' ||
      state.owner === 'accounts' ||
      state.partition < 0 ||
      state.partition >= 4096 ||
      state.subject !== null ||
      state.projection !== null
    )
      throw new BindingError('binding_mismatch');
    const limit = Math.min(inputLimit, repairHomeBatchLimit, 4096 - state.partition);
    const through = state.partition + limit - 1;
    // Reserve the maximum bounded seek work before dispatch. Successful reads
    // refund homes the recursive query did not reach; failed reads retain it.
    cost.inputKeys += limit;
    const rows = await nativeSourceQuery(db, repairSourceScan, {
      partition_no: state.partition,
      through,
      after_route: state.after?.route ?? state.partition * 16,
      after_id: state.after?.id ?? '00000000-0000-0000-0000-000000000000',
    });
    if (rows.length < 1 || rows.length > limit) throw new BindingError('binding_mismatch');
    cost.inputKeys -= limit - rows.length;
    for (const [index, row] of rows.entries()) {
      if (row.partition_no !== state.partition + index) throw new BindingError('binding_mismatch');
      if (row.epoch === null || row.write_state !== 'active') throw new BindingError('owner_unavailable');
      if (index === 0 && state.epoch !== null && state.epoch !== row.epoch)
        throw new BindingError('configuration_changed');
      if ((row.subject_id === null) !== (row.route === null)) throw new BindingError('binding_mismatch');
      if (index < rows.length - 1 && row.subject_id !== null) throw new BindingError('binding_mismatch');
    }
    const last = rows.at(-1)!;
    let next: RepairState;
    if (last.subject_id !== null) {
      if (
        last.route === null ||
        routeOf(last.subject_id) !== last.route ||
        partitionOf(last.route) !== last.partition_no
      )
        throw new BindingError('binding_mismatch');
      cost.candidates++;
      next = {
        ...state,
        partition: last.partition_no,
        epoch: last.epoch,
        subject: last.subject_id,
        after: { route: last.route, id: last.subject_id },
        phase: 'advance',
        advance: retainedAdvance ?? randomUUID(),
        version: null,
        projection: null,
      };
    } else {
      next = {
        ...state,
        partition: state.partition + rows.length,
        after: null,
        epoch: null,
      };
    }
    return {
      next,
      receipt: {
        kind: 'semantic',
        homes: rows.length,
        digest: hash(encode({ input: state, inputLimit, rows })),
      },
    };
  }
  function packClosedCreationWindows(windows: readonly PublicFilterCreationWindow[]): string {
    const output = Buffer.alloc(windows.length * 44);
    for (const [index, window] of windows.entries()) {
      if (
        window.position !== window.base + 1n ||
        window.through !== window.base ||
        window.sequence !== 0 ||
        window.eventCount !== null ||
        !/^[0-9a-f]{64}$/.test(window.receipt)
      )
        throw new BindingError('binding_mismatch');
      const offset = index * 44;
      output.writeUInt32BE(window.epoch, offset);
      output.writeBigUInt64BE(window.base, offset + 4);
      Buffer.from(window.receipt, 'hex').copy(output, offset + 12);
    }
    return output.toString('base64');
  }
  function creationWindowFromBatch(
    batch: NonNullable<RepairRecord['windowBatch']>,
    home: number,
  ): PublicFilterCreationWindow | null {
    if (
      !Number.isInteger(batch.from) ||
      batch.from < 0 ||
      batch.from >= 4096 ||
      !Number.isInteger(batch.count) ||
      batch.count < 0 ||
      batch.count > batch.examined ||
      batch.count > repairHomeBatchLimit ||
      !Number.isInteger(batch.examined) ||
      batch.examined < 1 ||
      batch.examined > repairHomeBatchLimit ||
      batch.from + batch.count > 4096 ||
      batch.from + batch.examined > 4096 ||
      !/^[0-9a-f]{64}$/.test(batch.digest)
    )
      throw new BindingError('binding_mismatch');
    const packed = Buffer.from(batch.packed, 'base64');
    if (packed.length !== batch.count * 44 || packed.toString('base64') !== batch.packed)
      throw new BindingError('binding_mismatch');
    const offset = home - batch.from;
    if (offset < 0 || offset >= batch.count) return null;
    const start = offset * 44;
    const epoch = packed.readUInt32BE(start);
    const base = packed.readBigUInt64BE(start + 4);
    const receipt = packed.subarray(start + 12, start + 44).toString('hex');
    if (epoch < 1 || !/^[0-9a-f]{64}$/.test(receipt)) throw new BindingError('binding_mismatch');
    return {
      partition: home,
      epoch,
      receipt,
      base,
      through: base,
      position: base + 1n,
      sequence: 0,
      eventCount: null,
    };
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
      // Query accounting charges the projected row. The original enrollment, native
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
      return {
        ...rest,
        partition: state.partition + 1,
        epoch: null,
        phase: 'window',
      };
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
  async function scanCreationWindows(
    bootstrap: string,
    state: RepairState,
    inputLimit: number,
    db: Pool,
    cost: BindingCost,
  ): Promise<Readonly<{ next: RepairState; batch: NonNullable<RepairRecord['windowBatch']> }>> {
    if (
      state.phase !== 'window' ||
      state.owner !== 'semantic' ||
      state.partition < 0 ||
      state.partition >= 4096 ||
      state.subject !== null ||
      state.bridge ||
      state.resumeBridge ||
      state.projection !== null
    )
      throw new BindingError('binding_mismatch');
    const limit = Math.min(inputLimit, repairHomeBatchLimit, 4096 - state.partition);
    const through = state.partition + limit - 1;
    const consumer = publicFilterCreationConsumer(nativeId(bootstrap));
    cost.rows += limit * 2;
    cost.dependencyPoints += limit * 2;
    cost.inputKeys += limit;
    const rows = await nativeSourceQuery(db, repairWindowScan, {
      bootstrap: nativeId(bootstrap),
      consumer,
      partition_no: state.partition,
      through,
    });
    if (rows.length < 1 || rows.length > limit) throw new BindingError('binding_mismatch');
    const closed: PublicFilterCreationWindow[] = [];
    let open: PublicFilterCreationWindow | undefined;
    for (const [index, row] of rows.entries()) {
      const partition = state.partition + index;
      if (
        row.partition_no !== partition ||
        row.epoch === null ||
        row.write_state !== 'active' ||
        row.owner_epoch !== row.epoch ||
        !row.complete ||
        row.creation_consumer !== consumer ||
        row.base === null ||
        row.receipt === null ||
        row.head === null ||
        row.checkpoint === null ||
        (row.checkpoint_epoch !== null && row.checkpoint_epoch !== row.epoch)
      )
        throw new BindingError('owner_unavailable');
      if (index === 0 && state.epoch !== null && state.epoch !== row.epoch)
        throw new BindingError('configuration_changed');
      const base = BigInt(row.base);
      const head = BigInt(row.head);
      const checkpoint = BigInt(row.checkpoint);
      if (base < 0n || head < base || checkpoint > base || !/^[0-9a-f]{64}$/.test(row.receipt))
        throw new BindingError('configuration_changed');
      const window: PublicFilterCreationWindow = {
        partition,
        epoch: row.epoch,
        receipt: row.receipt,
        base,
        through: head,
        position: base + 1n,
        sequence: 0,
        eventCount: null,
      };
      if (head === base) closed.push(window);
      else {
        if (index !== rows.length - 1) throw new BindingError('binding_mismatch');
        open = window;
      }
    }
    const unused = limit - rows.length;
    cost.rows -= unused * 2;
    cost.dependencyPoints -= unused * 2;
    cost.inputKeys -= unused;
    cost.candidates += rows.length;
    const next: RepairState = open
      ? { ...state, epoch: open.epoch, phase: 'bridge', bridge: open }
      : { ...state, partition: state.partition + rows.length, epoch: null, phase: 'window' };
    return {
      next,
      batch: {
        from: state.partition,
        count: closed.length,
        examined: rows.length,
        digest: hash(encode({ input: state, inputLimit, consumer, rows })),
        packed: packClosedCreationWindows(closed),
      },
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
    const current = await nativeSourceQuery(db, repairCurrent, {
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
  async function nextAccountRepairFromKey(
    state: RepairState,
    key: { route: number; id: string } | undefined,
    db: Pool,
  ): Promise<RepairState> {
    if (state.epoch === null || state.resumeAccountScan || state.resumeBridge)
      throw new BindingError('binding_mismatch');
    if (!key)
      return {
        ...state,
        partition: state.partition + 1,
        after: null,
        epoch: null,
      };
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
      resumeAccountScan: {
        partition: state.partition,
        epoch: state.epoch,
        after: key,
      },
    };
  }
  async function nextAccountRepair(state: RepairState, db: Pool, cost: BindingCost): Promise<RepairState> {
    return nextAccountRepairFromKey(state, await accountRepairKey(state, db, cost), db);
  }
  async function scanAccountHomes(
    state: RepairState,
    inputLimit: number,
    db: Pool,
    cost: BindingCost,
  ): Promise<Readonly<{ next: RepairState; receipt: NonNullable<RepairRecord['scan']> }>> {
    if (
      state.owner !== 'accounts' ||
      state.phase !== 'scan' ||
      state.partition < 0 ||
      state.partition >= 4096 ||
      state.subject !== null ||
      state.projection !== null ||
      state.resumeAccountScan ||
      state.resumeBridge
    )
      throw new BindingError('binding_mismatch');
    const claims = state.claimInputs === true;
    const arms = claims ? 3 : 2;
    const limit = Math.min(inputLimit, repairHomeBatchLimit, 4096 - state.partition);
    const through = state.partition + limit - 1;
    cost.inputKeys += limit * arms;
    const rows = await nativeSourceQuery(db, repairAccountScan, {
      partition_no: state.partition,
      through,
      after_route: state.after?.route ?? state.partition * 16,
      after_id: state.after?.id ?? '00000000-0000-0000-0000-000000000000',
      claim_inputs: claims,
    });
    if (rows.length < 1 || rows.length > limit) throw new BindingError('binding_mismatch');
    cost.inputKeys -= (limit - rows.length) * arms;
    let candidateCount = 0;
    for (const [index, row] of rows.entries()) {
      const home = state.partition + index;
      const count = row.candidate_count === null ? 0 : Number(row.candidate_count);
      const keys: unknown = row.candidate_keys;
      if (
        row.partition_no !== home ||
        row.epoch === null ||
        row.write_state !== 'active' ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > arms ||
        !Array.isArray(keys) ||
        keys.length !== count ||
        (count === 0) !== (row.route === null && row.account_id === null) ||
        (count > 0 && (row.route === null || row.account_id === null)) ||
        (index < rows.length - 1 && count !== 0)
      )
        throw new BindingError('owner_unavailable');
      for (const candidate of keys) {
        if (
          !Array.isArray(candidate) ||
          candidate.length !== 2 ||
          !Number.isInteger(candidate[0]) ||
          candidate[0] < home * 16 ||
          candidate[0] >= (home + 1) * 16 ||
          typeof candidate[1] !== 'string' ||
          !uuid.test(candidate[1])
        )
          throw new BindingError('binding_mismatch');
      }
      if (count > 0 && (keys[0][0] !== row.route || keys[0][1] !== row.account_id))
        throw new BindingError('binding_mismatch');
      if (index === 0 && state.epoch !== null && state.epoch !== row.epoch)
        throw new BindingError('configuration_changed');
      candidateCount = count;
    }
    cost.candidates += candidateCount;
    const last = rows.at(-1)!;
    const key = last.route === null ? undefined : { route: last.route, id: last.account_id! };
    const positioned: RepairState = {
      ...state,
      partition: last.partition_no,
      epoch: last.epoch,
      after: key ?? null,
    };
    const next = key
      ? await nextAccountRepairFromKey(positioned, key, db)
      : {
          ...state,
          partition: state.partition + rows.length,
          after: null,
          epoch: null,
        };
    return {
      next,
      receipt: {
        kind: 'accounts',
        homes: rows.length,
        digest: hash(encode({ input: state, inputLimit, rows })),
      },
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
    const old = await nativeSourceQuery(db, repairRead, {
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
      const previous = await nativeSourceQuery(db, repairState, {
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
      scan: RepairRecord['scan'],
      windowBatch: RepairRecord['windowBatch'],
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
        next = {
          ...next,
          owner: 'accounts',
          partition: 0,
          after: null,
          subject: null,
          epoch: null,
          phase: 'scan',
        };
      } else {
        next = {
          ...next,
          owner: 'semantic',
          partition: 0,
          after: null,
          subject: null,
          epoch: null,
          phase: 'window',
        };
      }
    } else if (state.phase === 'window' && (!replay || replay.windowBatch)) {
      const scanned = await scanCreationWindows(bootstrap.id, state, request.inputLimit, db, cost);
      next = scanned.next;
      windowBatch = scanned.batch;
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
    } else if (state.phase === 'scan' && (!replay || replay.scan)) {
      if (state.owner === 'accounts') {
        const scanned = await scanAccountHomes(state, request.inputLimit, db, cost);
        next = scanned.next;
        scan = scanned.receipt;
      } else {
        const scanned = await scanSemanticHomes(state, request.inputLimit, db, cost, replay?.next.advance);
        next = scanned.next;
        scan = scanned.receipt;
      }
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
          account = replay?.account ?? (await ports.access.readAccountRepair(db, state.subject, context));
          const current = await ports.access.readAccountRepair(db, state.subject, context);
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
        const key = await nativeSourceQuery(db, repairKeys, {
          partition_no: state.partition,
          after_route: state.after?.route ?? state.partition * 16,
          after_id: state.after?.id ?? '00000000-0000-0000-0000-000000000000',
        });
        if (!key)
          next = {
            ...next,
            partition: state.partition + 1,
            after: null,
            epoch: null,
          };
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
            clock: ports.sourceOrigin(sourceReader(bootstrap.definition))?.clock ?? systemClock,
          },
          async (tx) => {
            const existing = await nativeSourceQuery(tx, repairVersion, values);
            if (existing && (existing.transaction_id === null || existing.native_xid === null))
              throw new BindingError('owner_unavailable');
            if (existing) return noEffect(existing);
            // The original advancement and its first genuine keyed privacy
            // baseline are both attempted writes, including a lost CAS.
            cost.resultWrites += 2;
            const result = await nativeSourceQuery(tx, repairAdvance, {
              ...values,
              transaction_id: currentCommand(tx).transactionId,
            });
            const inserted = Array.isArray(result) ? result[0] : result;
            if (!inserted) throw new BindingError('owner_unavailable');
            return {
              value: inserted,
              events: [
                {
                  type: 'com.rezics.semantic.public-source.advanced.v1',
                  subject: state.subject!,
                  data: {
                    id: state.subject!,
                    bootstrap: id,
                    execution: request.execution,
                  },
                },
              ],
            };
          },
        );
        if (advancement.value.owner_epoch !== owner.epoch || BigInt(advancement.value.position) > advancement.position)
          throw new BindingError('configuration_changed');
        next = {
          ...next,
          version: BigInt(advancement.value.position),
          phase: 'project',
        };
      } else {
        const source = sourceReader(bootstrap.definition);
        const origin = ports.sourceOrigin(source);
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
          ports.access,
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
          request: {
            inputLimit: request.inputLimit,
            frontier: state.projection,
          },
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
              : {
                  ...next,
                  subject: null,
                  phase: 'scan',
                  projection: null,
                  version: null,
                }
            : { ...next, projection: output.frontier };
      }
    }
    checkDeadline(context);
    const record: RepairRecord = {
      input: state,
      next,
      output,
      ...(scan ? { scan } : {}),
      ...(windowBatch ? { windowBatch } : {}),
      ...(account ? { account } : {}),
    };
    if (replay && encode(record) !== encode(replay)) throw new BindingError('binding_mismatch');
    if (!old) {
      const saved = await nativeSourceQuery(db, repairSave, {
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
      const retained = await ports.search.readConsumerCustody(pool, input, {
        deadline,
      });
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
            start.consumer !== ports.search.encodeConsumer(retained.queried.consumer) ||
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
      const origin = ports.sourceOrigin(request.source);
      if (!origin || origin.pool !== pool || origin.access !== access || hash(origin.routeKey) !== routeDigest)
        return fail('source_missing');
      try {
        meaning = structuredClone(request.meaning);
        capture = structuredClone(request.capture);
      } catch {
        return fail('binding_mismatch');
      }
      return run(context, async (cost, db) => {
        const keys = ports.search.deriveDependencyKeys(meaning, capture);
        const encoded = encode(capture);
        if (Buffer.byteLength(encoded) > 1048576) throw new BindingError('binding_mismatch');
        // Caller digest equality is checked again against the actual immutable release owner.
        const release = await readRelease(db, meaning.digest);
        if (!release || !isDeepStrictEqual(release, meaning.release) || !release.types[meaning.type])
          throw new BindingError('definition_missing');
        const source = (await nativeSourceQuery(db, registerSource, { route_digest: routeDigest }))[0];
        if (!source) throw new BindingError('owner_unavailable');
        const definition = (
          await nativeSourceQuery(db, defineSource, {
            source_id: source.source_id,
            configuration: source.configuration,
            route_digest: routeDigest,
            release_digest: meaning.digest,
            subject_type: meaning.type,
            capture_digest: hash(encoded),
            capture: encoded,
            dependency_keys: [...keys],
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
    retainedDefinition?: PublicFilterSourceDefinition,
    inputLimit = preparationInputLimit,
  ): Promise<NativePublicFilterPreparation> {
    const deadline = context.deadline;
    let capture: PublicSourceCaptureInput, consumer: PublicFilterConsumer;
    const snapshot = request.snapshot;
    try {
      capture = structuredClone(request.capture);
      consumer = structuredClone(request.consumer);
      ports.search.catalogue(consumer, 'representation' in capture);
    } catch {
      return fail('binding_mismatch');
    }
    if (snapshot !== 'pit' && snapshot !== 'prepared') return fail('binding_mismatch');
    const resolved = retainedDefinition
      ? { status: 'resolved' as const, definition: retainedDefinition, cost: publicFilterBindingCost() }
      : await binding.resolve({ source: request.source, meaning: request.meaning, capture }, { deadline });
    if (resolved.status !== 'resolved') return resolved;
    readers.set(resolved.definition.source.id, request.source);
    return run({ deadline }, async (cost, db) => {
      addCost(cost, resolved.cost);
      // Validate the already registered physical consumer through its real owner, before making a cut.
      const registration = await ports.search.readGenerationPublicationCustody(pool, consumer, 0, { deadline });
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
            await nativeSourceQuery(db, beginBootstrap, {
              bootstrap: randomUUID(),
              read_definition: resolved.definition.readDefinition,
              request_key: hash(encode({ consumer, snapshot })),
              consumer: encode(consumer),
              snapshot_kind: snapshot,
              mixed: 'representation' in capture,
            })
          )[0];
      if (!inserted) throw new BindingError('configuration_changed');
      let cut = await loadBootstrap('0:' + inserted.bootstrap, db, resolved.definition);
      if (cut.row.state === 'capturing') {
        const baseline = {
          bootstrap: inserted.bootstrap,
          registration: registration.registration,
          definition: resolved.definition.readDefinition,
          consumer: ports.search.encodeConsumer(consumer),
          accounts: 'representation' in capture,
        };
        // The immutable definition and current Search registration are joined once
        // per affordable batch. Each native owner receipt below remains its own
        // transaction and is adopted before the Source cursor can pass that home.
        const keys = publicFilterCoverageKeys(resolved.definition.dependencyKeys);
        // Keep enough room for Search's own capture and its independent replay
        // reads. A broad compiler closure therefore gets a smaller home batch.
        const homeInputEstimate = preparationHomeParameterEstimate + keys.length + Number('representation' in capture);
        const remainingInputBudget = Math.min(preparationInputLimit, inputLimit) - cost.inputKeys;
        const homeBatchLimit = Math.max(
          0,
          Math.min(preparationHomeBatchLimit, Math.floor(Math.max(0, remainingInputBudget) / homeInputEstimate)),
        );
        try {
          await beginPublicFilterCoverageBaseline(db, baseline, deadline);
          let accountAfter = cut.row.account_after;
          let coverageAfter = cut.row.coverage_after;
          for (let batch = 0; batch < homeBatchLimit; batch++) {
            if (accountAfter >= 4096) break;
            if (accountAfter !== coverageAfter) throw new BindingError('owner_unavailable');
            // The new original enrollment retains both native heads. Their FK
            // controls are separate from the earlier explicit owner-head reads.
            cost.inputKeys += 2;
            cost.dependencyPoints += 2;
            cost.rows += 2;
            const receipt = await ports.access.enrollAccountHome(
              db,
              {
                partition: accountAfter,
                bootstrap: inserted.bootstrap,
                registration: registration.registration,
                readDefinition: resolved.definition.readDefinition,
                keys: 'representation' in capture ? [...keys, PUBLIC_FILTER_ACCOUNT_DOMAIN].sort() : keys,
                accounts: 'representation' in capture,
              },
              { deadline },
            );
            if (!receipt.complete)
              return {
                status: 'preparing' as const,
                bootstrap: cut.bootstrap,
                cost,
              };
            // Reserve the deferred original-baseline -> current-summary retention
            // control before staging adoption; rollback cannot refund the attempt.
            cost.inputKeys += 3;
            cost.dependencyPoints++;
            cost.rows++;
            const adopted = await adoptPublicFilterCoverageBaseline(db, baseline, receipt, deadline);
            const advanced = (
              await nativeSourceQuery(db, accountPage, {
                bootstrap: inserted.bootstrap,
                after_partition: accountAfter,
                next_partition: accountAfter + 1,
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
            if (!advanced) return { status: 'preparing' as const, bootstrap: cut.bootstrap, cost };
            // Keep the two in-memory cursors paired with the committed CAS;
            // the first cut row is intentionally not reloaded for every home.
            accountAfter++;
            coverageAfter++;
          }
        } catch (error) {
          // Access contention leaves the native enrollment transaction rolled
          // back. The already committed prefix and exact next-home cursor remain
          // durable, so Search can retry without substituting a new original cut.
          if (ports.access.classifyUnavailability(error) !== 'contention') throw error;
          const retained = await loadBootstrap('0:' + inserted.bootstrap, db, resolved.definition);
          return { status: 'preparing' as const, bootstrap: retained.bootstrap, cost };
        }
      }
      const begun = await loadBootstrap('0:' + inserted.bootstrap, db, resolved.definition);
      if (begun.row.state === 'capturing') return { status: 'preparing' as const, bootstrap: begun.bootstrap, cost };
      if (begun.row.state !== 'begun' || !begun.row.coverage_sealed || begun.row.coverage_after !== 4096)
        throw new BindingError('owner_unavailable');
      return { status: 'begun' as const, bootstrap: begun.bootstrap, cost };
    });
  }

  async function settleNative(
    request: Parameters<PublicFilterSourceBootstrapBinding['settle']>[0],
    context: PublicFilterConsumerContext,
    publicationCost?: BindingCost,
  ) {
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
      const original = seal.after === 4096 ? null : decode<RepairRecord>(seal.state);
      let retainedWindow: PublicFilterCreationWindow | null = null;
      if (original?.windowBatch) {
        if (original.input.phase !== 'window') throw new BindingError('binding_mismatch');
        retainedWindow = creationWindowFromBatch(original.windowBatch, seal.home);
        if (!retainedWindow) throw new BindingError('owner_unavailable');
      } else if (original) {
        if (
          original.input.phase !== 'bridge' ||
          !original.input.bridge ||
          original.input.partition !== seal.home ||
          original.input.bridge.position <= original.input.bridge.through ||
          original.next.partition !== seal.home + 1 ||
          original.next.phase !== 'window'
        )
          throw new BindingError('binding_mismatch');
        retainedWindow = original.input.bridge;
      }
      const verify = async () => {
        if (original?.windowBatch && retainedWindow) {
          cost.rows += 2;
          cost.dependencyPoints += 2;
          cost.inputKeys++;
          const current = await readPublicFilterCreationWindow(
            db,
            { bootstrap: nativeId(input.bootstrap), partition: seal.home },
            { deadline },
            retainedWindow,
          );
          if (!isDeepStrictEqual(current, retainedWindow)) throw new BindingError('configuration_changed');
          return;
        }
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
      const authority = async () => {
        if (!original) return null;
        if (!retainedWindow) throw new BindingError('binding_mismatch');
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
            [seal.home, nativeId(input.bootstrap), retainedWindow.receipt, joined.definition.readDefinition],
          )
        ).rows[0];
        if (
          !row ||
          row.owner_epoch !== retainedWindow.epoch ||
          row.receipt !== retainedWindow.receipt ||
          BigInt(row.current_creation) < retainedWindow.through
        )
          throw new BindingError('configuration_changed');
        return row;
      };
      const before = await authority();
      const readSettlement = () =>
        ports.search.readRepairSettlement(pool, { queried: input.queried, execution: input.execution }, { deadline });
      const spent = publicationCost ? { ...publicationCost } : undefined;
      if (spent) addCost(spent, cost);
      const settled = await (spent ? ports.search.withRepairAllowance(spent, readSettlement) : readSettlement());
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
          consumer: ports.search.encodeConsumer(settled.queried.consumer),
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
      return {
        ...joined,
        terminal: { step: seal.terminal, root: seal.root },
        settlement: settled.settlement,
        cost,
      };
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
        const row = await nativeSourceQuery(db, repairRead, {
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
          const predecessor = await nativeSourceQuery(db, repairState, {
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
        let expectedScan: RepairRecord['scan'];
        let expectedWindowBatch: RepairRecord['windowBatch'];
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
                : {
                    ...record.input,
                    subject: null,
                    phase: 'scan',
                    projection: null,
                    version: null,
                  }
              : { ...record.input, projection: record.output.frontier };
        } else if (record.account) {
          if (
            record.input.owner !== 'accounts' ||
            record.input.phase !== 'account' ||
            record.input.subject !== record.account.id ||
            receiptDigests.length !== 0
          )
            throw new BindingError('binding_mismatch');
          const current = await ports.access.readAccountRepair(db, record.account.id, { deadline });
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
            (record.input.phase === 'bridge' && record.windowBatch !== undefined) ||
            (record.input.phase === 'window' &&
              !record.windowBatch &&
              (!record.next.bridge || record.next.phase !== 'bridge'))
          )
            throw new BindingError('binding_mismatch');
          if (record.input.phase === 'window' && record.windowBatch) {
            const scanned = await scanCreationWindows(input.bootstrap, record.input, row.input_limit, db, cost);
            expected = scanned.next;
            expectedWindowBatch = scanned.batch;
          } else {
            expected = await advanceCreationBridge(
              input.bootstrap,
              record.input,
              db,
              { deadline },
              'representation' in cut.definition.capture,
              cost,
              record.next,
            );
          }
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
          if (record.scan) {
            if (record.scan.kind !== (state.owner === 'accounts' ? 'accounts' : 'semantic'))
              throw new BindingError('binding_mismatch');
            if (record.scan.kind === 'accounts') {
              const scanned = await scanAccountHomes(state, row.input_limit, db, cost);
              expected = scanned.next;
              expectedScan = scanned.receipt;
            } else {
              const scanned = await scanSemanticHomes(state, row.input_limit, db, cost, record.next.advance);
              expected = scanned.next;
              expectedScan = scanned.receipt;
            }
          } else {
            const owner = await readPartition(db, state.partition);
            if (!owner || owner.writeState !== 'active' || (state.epoch !== null && state.epoch !== owner.epoch))
              throw new BindingError('configuration_changed');
            const base = { ...state, epoch: owner.epoch };
            if (state.owner === 'accounts') {
              expected = await nextAccountRepair(base, db, cost);
            } else {
              const key = await nativeSourceQuery(db, repairKeys, {
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
                : {
                    ...base,
                    partition: state.partition + 1,
                    after: null,
                    epoch: null,
                  };
            }
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
          const advancement = await nativeSourceQuery(db, repairVersion, {
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
          expected = {
            ...record.input,
            epoch: owner.epoch,
            version: BigInt(advancement.position),
            phase: 'project',
          };
        }
        if (
          !expected ||
          encode(expected) !== encode(record.next) ||
          encode(expectedScan ?? null) !== encode(record.scan ?? null) ||
          encode(expectedWindowBatch ?? null) !== encode(record.windowBatch ?? null)
        )
          throw new BindingError('binding_mismatch');
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
              : record.input.phase === 'window' && record.windowBatch && record.windowBatch.count > 0
                ? { closedHome: record.windowBatch.from }
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
        const row = await nativeSourceQuery(db, repairState, {
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
            identity: {
              bootstrap: nativeId(receipt.bootstrap),
              execution: execution,
              predecessor: row.predecessor,
            },
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
            await nativeSourceQuery(db, adoptBootstrap, {
              bootstrap: cut.row.bootstrap,
              observation: joined.queried.snapshot.observation,
            })
          )[0]
        )
          throw new BindingError('binding_mismatch');
        return {
          status: 'adopted' as const,
          bootstrap: cut.bootstrap,
          queried: joined.queried,
          cost,
        };
      });
    },
    async abort(request, context) {
      const id = request.bootstrap;
      return run(context, async (cost, db) => {
        const cut = await loadBootstrap(id, db);
        const result = (await nativeSourceQuery(db, abortBootstrap, { bootstrap: cut.row.bootstrap }))[0];
        if (!result) throw new BindingError('configuration_changed');
        // Search's public lookup cannot distinguish closed from unknown/expired/uncertain native custody.
        // Persist the barrier and retain the cut; neither a timeout nor observation_lost proves closure.
        return {
          status: result.state === 'aborted' ? ('aborted' as const) : ('pending' as const),
          cost,
        };
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
        const native = await ports.search.readGenerationPublicationCustody(
          pool,
          cut.bootstrap.consumer,
          0,
          { deadline },
          cut.row.queried ?? cut.row.publication_observation ?? undefined,
        );
        addCost(cost, native.cost);
        if (!('definition' in native)) return { ...native, cost };
        requireSameDefinition(cut.definition, native.definition);
        if (native.queried === null) {
          if (cut.row.state !== 'begun' || cut.row.queried !== null || !cut.row.coverage_sealed)
            return { status: 'pending' as const, cost };
          return {
            status: 'begun' as const,
            bootstrap: cut.bootstrap,
            queried: null,
            cost,
          };
        }
        const joined = await binding.join({ queried: native.queried }, { deadline });
        addCost(cost, joined.cost);
        if (joined.status !== 'joined') return { ...joined, cost };
        if (encode(joined.covered) !== encode(cut.bootstrap.covered)) return { status: 'pending' as const, cost };
        if (
          !(
            await nativeSourceQuery(db, adoptBootstrap, {
              bootstrap: cut.row.bootstrap,
              observation: joined.queried.snapshot.observation,
            })
          )[0]
        )
          throw new BindingError('binding_mismatch');
        return {
          status: 'adopted' as const,
          bootstrap: cut.bootstrap,
          queried: joined.queried,
          cost,
        };
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
        return repairNative(cut.bootstrap, joined, input, db, cost, {
          deadline,
        });
      });
    },
    settle: settleNative,
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
      const row = await nativeSourceQuery(db, repairRead, {
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
      const current = await ports.access.readAccountRepair(db, record.account.id, context);
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
    if (!('bootstrap' in input)) return beginRetained(input, context, undefined, undefined, input.inputLimit);
    const retained = await run(context, async (cost, db) => {
      const cut = await loadBootstrap(input.bootstrap, db);
      if (cut.row.state !== 'capturing' && cut.row.state !== 'begun') throw new BindingError('observation_lost');
      return { status: 'retained' as const, cut, cost };
    });
    if (retained.status !== 'retained') return retained;
    if (retained.cut.row.state === 'begun') {
      if (!retained.cut.row.coverage_sealed || retained.cut.row.coverage_after !== 4096)
        return fail('owner_unavailable', retained.cost);
      return {
        status: 'begun',
        bootstrap: retained.cut.bootstrap,
        cost: retained.cost,
      };
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
      retained.cut.definition,
      input.inputLimit,
    );
    addCost(retained.cost, result.cost);
    if ('bootstrap' in result && result.bootstrap.id !== input.bootstrap)
      return fail('observation_lost', retained.cost);
    return { ...result, cost: retained.cost };
  });
  nativePublicationCompletions.set(bootstrapBinding, async (request, context) => {
    const input = structuredClone(request),
      deadline = context.deadline;
    return run({ deadline }, async (cost, db) => {
      // Pin the original operands before any dispatch/adoption uncertainty. Search owns the
      // generation record; Source stores only its locator and its own original binding operands.
      if ('bootstrap' in input) {
        const joined = await joinNative({ queried: input.queried, execution: input.execution }, { deadline }, true);
        addCost(cost, joined.cost);
        if (joined.status !== 'joined') return { ...joined, cost };
        const cut = await loadBootstrap(input.bootstrap, db, joined.definition);
        if (cut.bootstrap.snapshot !== 'prepared' || encode(cut.bootstrap.covered) !== encode(joined.covered))
          throw new BindingError('binding_mismatch');
        cost.frontierWrites++;
        const pinned = await db.query(
          `/* semantic.native-keyed:3:6 */
           UPDATE semantic.public_filter_bootstrap b
           SET publication_job=$2::uuid,publication_observation=$3,publication_execution=$4
           FROM search.generation_publication j,core.partition p
           WHERE (b.partition_no,b.bootstrap)=(0,$1::uuid) AND p.partition_no=0
             AND p.write_state='active' AND p.epoch=b.owner_epoch
             AND b.state IN ('begun','adopted')
             AND (b.queried IS NULL OR b.queried=$3)
             AND (b.publication_job IS NULL OR
               (b.publication_job,b.publication_observation,b.publication_execution)=($2::uuid,$3,$4))
             AND (j.partition_no,j.job)=(0,$2::uuid) AND j.consumer=$5::jsonb
             AND j.physical_target=$6 AND j.native_incarnation=$7
             AND j.source_home=0 AND j.binding->>'readDefinition'=b.read_definition::text
             AND (j.observation IS NULL OR j.observation=$3)
           RETURNING b.bootstrap`,
          [
            nativeId(input.bootstrap),
            input.job,
            input.queried.snapshot.observation,
            input.execution,
            input.queried.consumer,
            input.queried.consumer.physicalTarget,
            input.queried.consumer.incarnation,
          ],
        );
        if (pinned.rowCount !== 1) throw new BindingError('binding_mismatch');
      }
      const retained = (
        await db.query<{
          bootstrap: string;
          observation: string;
          execution: string;
        }>(
          `/* semantic.native-keyed:3:5 */
         SELECT b.bootstrap::text,b.publication_observation AS observation,b.publication_execution AS execution
         FROM semantic.public_filter_bootstrap b
         JOIN core.partition p ON p.partition_no=b.partition_no
         JOIN search.generation_publication j ON (j.partition_no,j.job)=(b.partition_no,b.publication_job)
         WHERE (b.partition_no,b.publication_job)=(0,$1::uuid)
           AND p.write_state='active' AND p.epoch=b.owner_epoch
           AND b.state IN ('begun','adopted') AND b.coverage_sealed
           AND j.source_home=0 AND j.binding->>'readDefinition'=b.read_definition::text
           AND (j.observation IS NULL OR j.observation=b.publication_observation)`,
          [input.job],
        )
      ).rows[0];
      if (!retained) throw new BindingError('observation_lost');
      const bootstrap = '0:' + retained.bootstrap;
      const cut = await loadBootstrap(bootstrap, db);
      // Never use the "latest observation" lookup, even when adoption lost its reply.
      const native = await ports.search.readGenerationPublicationCustody(
        pool,
        cut.bootstrap.consumer,
        0,
        { deadline },
        retained.observation,
      );
      addCost(cost, native.cost);
      if (!('definition' in native)) return { ...native, cost };
      if (!native.queried) throw new BindingError('observation_lost');
      requireSameDefinition(cut.definition, native.definition);
      const publication: NativePublicFilterPublication = {
        job: input.job,
        bootstrap,
        queried: native.queried,
        execution: retained.execution,
      };
      const adopted = await bootstrapBinding.adopt({ bootstrap, queried: native.queried }, { deadline });
      addCost(cost, adopted.cost);
      if (adopted.status !== 'adopted')
        return { status: 'pending' as const, publication, reason: adopted.reason, cost };
      const settled = await settleNative(publication, { deadline }, cost);
      addCost(cost, settled.cost);
      if (settled.status !== 'joined') return { status: 'pending' as const, publication, reason: settled.reason, cost };
      // Clean current population alone cannot replace the independently verified original
      // chain and Search's dispatch/winner/copy/writer/physical-target completion above.
      const observation = await sourceReader(cut.definition).readPrivacyReductionHeads({
        kind: 'population',
        queried: native.queried,
        start: settled.execution!.start,
        execution: retained.execution,
        context: { deadline },
      });
      addCost(cost, observation.cost);
      if (
        observation.status !== 'observed' ||
        !observation.routingComplete ||
        observation.unacknowledged.length ||
        observation.blocking.some(({ phase, scope }) => phase === 'pending' || scope === 'unresolved')
      )
        return { status: 'pending' as const, publication, reason: 'owner_unavailable' as const, cost };
      return {
        status: 'complete' as const,
        publication,
        definition: settled.definition,
        covered: settled.covered,
        execution: settled.execution!,
        observation,
        terminal: settled.terminal,
        settlement: settled.settlement,
        cost,
      };
    });
  });
  return Object.freeze(bootstrapBinding);
}
