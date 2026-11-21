import { readFileSync } from 'node:fs';
import { bookBindingStep, bookCostShare } from '../request/book-binding-steps.ts';
import { MAX_PAGE_READS } from '@rezics/composition';
import { isDeepStrictEqual } from 'node:util';
import { bookPreparationTiming } from '../search/book-preparation-timing.ts';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { nativePopulationStartId, readPublicFilterPopulation } from './public-filter-coverage-population.ts';
import {
  readOriginalPublicFilterProjectionPage,
  readRetainedPublicFilterProjectionPage,
  retainedPublicFilterProjectionDependenciesCurrent,
} from './public-filter-projection.ts';
import { systemClock } from '../clock.ts';
import { runCommand, noEffect, currentCommand, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import { hasVerifiedReleaseDigest, readRelease } from './definition-release-read.ts';
import { withReadTransaction } from './read.ts';
import { nativeSourceQuery } from '../database/native-source-query.ts';
import { freeze } from './core/freeze.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { ProblemError } from '../http/problem-error.ts';
import { CommandUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { withConnection, discardConnection, withQueryAccounting } from '../database/pool.ts';
import registerSource from './public-filter-source-binding-register.sql';
import defineSource from './public-filter-source-binding-define.sql';
import lookupDefinition from './public-filter-source-binding-lookup.sql';
import readDefinition from './public-filter-source-binding-definition.sql';
import captureBookWithdrawals from './public-filter-book-withdrawals.sql';
import beginBootstrap from './public-filter-source-binding-begin.sql';
import readBootstrap from './public-filter-source-binding-bootstrap.sql';
import adoptBootstrap from './public-filter-source-binding-adopt.sql';
import abortBootstrap from './public-filter-source-binding-abort.sql';
import { publicFilterCoverageKeys, PUBLIC_FILTER_CATALOGUE_TEXT_KEYS } from './public-filter-coverage-pending.ts';
import { PUBLIC_FILTER_ACCOUNT_DOMAIN } from './public-filter-coverage-maintenance.ts';
import {
  beginPublicFilterCoverageBaseline,
  adoptPublicFilterCoverageBaselinePage,
  adoptColdEnrollment,
  coldEnrollmentFunding,
  prepareColdEnrollment,
  type ColdEnrollmentRequest,
  type PreparedEnrollmentRange,
} from './public-filter-coverage-baseline.ts';
import {
  readPublicFilterCreationWindow,
  readPublicFilterCreationEvent,
  readPublicFilterCreationEvents,
  publicFilterCreationAction,
  type PublicFilterCreationWindow,
} from './public-filter-creation-window.ts';
import { publicFilterCreationConsumer } from './public-filter-creation-consumer.ts';
import { mixedCreationPrefixHomes, readPublicFilterCreationPrefix } from './public-filter-creation-prefix.ts';
import {
  publicFilterRepairPageRoot,
  readPublicFilterRepairVerification,
  readPublicFilterRepairVerificationTip,
  retainPublicFilterRepairVerification,
  readPublicFilterRepairHomeSeal,
  adoptPublicFilterManifestAck,
  readPublicFilterRepairHomeBatches,
  advancePublicFilterRepairAckFrontier,
  PUBLIC_FILTER_REPAIR_ACK_BATCH_LIMIT,
} from './public-filter-repair-chain.ts';
import repairState from './public-filter-source-binding-repair-state.sql';
import repairRead from './public-filter-source-binding-repair-read.sql';
import repairLink from './public-filter-source-binding-repair-link.sql';
import repairProof from './public-filter-source-binding-repair-proof.sql';
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
import { planPublicFilterEnrollment } from './public-filter-preparation-budget.ts';
import type { AccountDiscoveryEnrollment } from '../access/account-discovery-reduction.ts';
import {
  retainedAccountDiscoveryRepairCurrent,
  type AccountDiscoveryRepairObservation,
} from '../access/account-discovery-source.ts';
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
  SourceBindingCustodyExecution,
  SourceBindingRepairSettlement,
  SourceBindingFailureReason,
} from './source-binding-port.ts';
import { sourceBindingApplication } from './source-binding-application.ts';
import { hasPublicFilterMeaningShape } from './public-filter-source-contract.ts';
/** Internal native receipt, resolved from the original independently verified
 * home/window chain. Never accepted by a public callable or a caller ACK setter.
 */
type PublicFilterRepairBaseline = Readonly<{
  bootstrap: string;
  registration: string;
  registrationPartition: number;
  observation: string;
  execution: string;
  settlement: string;
  consumer: string;
  physicalTarget: string;
  incarnation: string;
}>;
type PublicFilterRepairHome = Readonly<{
  home: number;
  epoch: number;
  receipt: string;
  source_position: string;
  enqueue: string;
  revision: string | null;
  claim_revision: string | null;
}>;

/** ACK only this original baseline's complete prefix. Subsequent Source positions
 * and native enqueue revisions remain obligations even if delivered meanwhile.
 * Apply and ACK serialize on the SAME registration and coverage-summary locks.
 */
async function acknowledgePublicFilterRepairBaseline(
  pool: Pool,
  baseline: PublicFilterRepairBaseline,
  homes: readonly PublicFilterRepairHome[],
  deadline: number,
): Promise<void> {
  requireAccessDeadline(deadline);
  if (
    !homes.length ||
    homes.length > PUBLIC_FILTER_REPAIR_ACK_BATCH_LIMIT ||
    homes.some((home, index) => home.home !== homes[0]!.home + index)
  )
    throw new TypeError('Receiver ACK requires a bounded contiguous home range');
  const firstHome = homes[0]!.home;
  const afterHome = firstHome + homes.length;
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
      // The registration lock consumes the locked target key, matching the
      // order in which registration installs the target and registration rows.
      const authority = await client.query(
        `/* semantic.native-keyed:2:4 */
         WITH target AS MATERIALIZED (
           SELECT partition_no,physical_target FROM search.public_filter_target
           WHERE (partition_no,physical_target)=($1,$2) AND incarnation=$3
           FOR SHARE
         )
         SELECT registration.id FROM target
         CROSS JOIN LATERAL (
           SELECT r.id FROM search.public_filter_registration r
           WHERE (r.partition_no,r.id)=(target.partition_no,$4)
             AND r.physical_target=target.physical_target
             AND r.state='active' AND r.consumer=$5
           FOR UPDATE OF r
         ) registration`,
        [
          baseline.registrationPartition,
          baseline.physicalTarget,
          baseline.incarnation,
          baseline.registration,
          baseline.consumer,
        ],
      );
      if (authority.rowCount !== 1) throw new CommandUnavailableError('fenced', baseline.registrationPartition);
      // Lock and confirm the whole original receiver prefix before changing it.
      // Later obligations remain behind their actual native revision and position.
      // Give the cold planner index bounds even before it has registration statistics.
      const acknowledged = await client.query(
        `/* semantic.native-keyed:${3 * homes.length}:${10 * homes.length}:${homes.length} */
         WITH eligible AS MATERIALIZED (
           SELECT x.* FROM jsonb_to_recordset($3::jsonb) AS x(
             home integer,epoch integer,receipt text,source_position bigint,
             enqueue bigint,revision bigint,claim_revision bigint)
           JOIN search.public_filter_coverage_home h
             ON (h.partition_no,h.registration,h.source_home)=($1,$2,x.home)
           JOIN search.public_filter_coverage_baseline b
             ON (b.partition_no,b.registration,b.bootstrap,b.source_home)=($1,$2,$4::uuid,x.home)
           WHERE h.source_home >= $8 AND h.source_home < $9
             AND b.source_home >= $8 AND b.source_home < $9
             AND h.source_epoch=x.epoch AND h.baseline_bootstrap=$4
             AND b.receipt=x.receipt AND b.source_epoch=x.epoch
             AND b.source_position=x.source_position AND b.native_enqueue_revision=x.enqueue
             AND b.native_revision IS NOT DISTINCT FROM x.revision
             AND b.native_claim_revision IS NOT DISTINCT FROM x.claim_revision
             AND h.acknowledged_position<=x.source_position AND h.acknowledged_native_enqueue<=x.enqueue
           ORDER BY h.source_home FOR UPDATE OF h
         )
         UPDATE search.public_filter_coverage_home h SET
           acknowledged_position=x.source_position,acknowledged_native_enqueue=x.enqueue,
           acknowledged_native_revision=x.revision,acknowledged_native_claim_revision=x.claim_revision,
           acknowledged_baseline=$4::uuid,
           acknowledged_observation=$5,acknowledged_execution=$6,acknowledged_settlement=$7,
           behind=(h.relevant_position>x.source_position OR h.native_enqueue_revision>x.enqueue
             OR h.native_revision IS DISTINCT FROM x.revision
             OR h.native_claim_revision IS DISTINCT FROM x.claim_revision)
         FROM eligible x
         WHERE (h.partition_no,h.registration,h.source_home)=($1,$2,x.home)
           AND h.source_home >= $8 AND h.source_home < $9
           AND (SELECT count(*) FROM eligible)=jsonb_array_length($3::jsonb)
         RETURNING h.source_home`,
        [
          baseline.registrationPartition,
          baseline.registration,
          JSON.stringify(homes),
          baseline.bootstrap,
          baseline.observation,
          baseline.execution,
          baseline.settlement,
          firstHome,
          afterHome,
        ],
      );
      if (acknowledged.rowCount !== homes.length)
        throw new CommandUnavailableError('contention', baseline.registrationPartition);
      requireAccessDeadline(deadline);
      await client.query('COMMIT');
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

/** Same native head reader, with one role snapshot for an admitted set of Book pages. */
export type PagePopulationRequest = Readonly<{
  kind: 'page';
  members: readonly Extract<PrivacyReductionObservationRequest, { kind: 'population' }>[];
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
  readPrivacyReductionHeads(request: PagePopulationRequest): Promise<readonly PrivacyReductionObservation[]>;
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
  /** Read an already retained definition through the current Source owner. */
  readDefinition?(
    request: Readonly<{ source: PublicFilterSource; id: string }>,
    context: PublicFilterConsumerContext,
  ): ReturnType<PublicFilterSourceBinding['resolve']>;
  resolve(
    request: Readonly<{
      source: PublicFilterSource;
      meaning: PublicFilterProjectionMeaning;
      capture: PublicFilterSourceCaptureInput;
      readOnly?: boolean;
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
      /** The mixed page protocol checks current coverage at START and FINAL. */
      mixedCoveragePage?: true;
    }>,
    context: PublicFilterConsumerContext,
  ): Promise<
    | Readonly<{
        status: 'joined';
        bookPopulation?: string;
        definition: PublicFilterSourceDefinition;
        queried: PublicFilterQueriedObservation;
        covered: PrivacyReductionStart;
        execution: SourceBindingCustodyExecution | null;
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
  /** An immutable parent job for this serving cut, resolved through native coverage. */
  coveragePublication?: string;
  /** Scheduling hint only. Grouped Source roles independently verify all persisted controls. */
  bookPopulation?: string;
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
  /** A continuation funded for a Subject home scan only. */
  scanOnly?: true;
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
export type NativeBookPreparation = {
  source: PublicFilterSource;
  meaning: PublicFilterProjectionMeaning;
  capture: PublicFilterSourceCaptureInput;
  consumer: PublicFilterConsumer;
  snapshot: 'pit' | 'prepared';
  definition: PublicFilterSourceDefinition;
  inputLimit: number;
};
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
    /** Fence only an expired, unadopted serving observation before Search drains its original physical copies. */
    fenceExpiredRegistration?(
      request: Readonly<{ bootstrap: string; registration: string; work: string }>,
      context: PublicFilterConsumerContext,
    ): Promise<Readonly<{ status: 'fenced' | 'pending'; cost: PublicFilterCost }> | PublicFilterBindingFailure>;
    /** Finish the original Search handoff after Source committed adoption and its serving request ended. */
    releaseAdoptedRegistration?(
      request: Readonly<{ bootstrap: string; registration: string; observation: string; work: string }>,
      context: PublicFilterConsumerContext,
    ): Promise<
      | Readonly<{ status: 'released' | 'pending'; cost: PublicFilterCost }>
      | Readonly<{ status: 'closing'; observations: readonly PublicFilterQueriedObservation[]; cost: PublicFilterCost }>
      | PublicFilterBindingFailure
    >;
    abort(
      request: Readonly<{
        bootstrap: string;
        closedPreparation?: Readonly<{
          registration: string;
          observation: string;
          work: string;
          populationJob?: string;
        }>;
      }>,
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
        /** Separate home-scan allowance for the original Subject publication. */
        homeLimit?: number;
        scanOnly?: true;
      }>,
      context: PublicFilterConsumerContext,
    ): Promise<PublicSourceRepairPage>;
    settleMixed?(
      request: Readonly<{ bootstrap: string; queried: PublicFilterQueriedObservation; execution: string }>,
      context: PublicFilterConsumerContext,
      spent: PublicFilterCost & Readonly<{ bytes: number }>,
    ): Promise<Awaited<ReturnType<PublicFilterSourceBinding['join']>> & { advanced?: boolean }>;
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
type NativePublicationSpent = Readonly<Pick<BindingCost, 'inputKeys' | 'bytes'>>;
export type NativePublicFilterPublicationCompletion =
  | Readonly<{
      status: 'pending';
      publication: NativePublicFilterPublication;
      reason: PublicFilterBindingFailure['reason'];
      advanced?: boolean;
      ackAttempted?: true;
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
    spent?: NativePublicationSpent,
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
  spent?: NativePublicationSpent,
): Promise<NativePublicFilterPublicationCompletion> {
  const read = nativePublicationCompletions.get(binding);
  return read
    ? read(request, context, spent)
    : {
        status: 'unready',
        reason: 'source_missing',
        cost: publicFilterBindingCost(),
      };
}

/** Internal native preparation handoff; the bootstrap remains the original persisted Source cut. */
type SubjectEnrollment = Readonly<{
  consumer: PublicFilterConsumer;
  source: PublicFilterSourceDefinition['source'];
  registration: { partition: number; id: string };
  capturingOnly?: true;
}>;
type NativePreparationInput =
  | (Parameters<PublicFilterSourceBootstrapBinding['begin']>[0] &
      Readonly<{
        inputLimit?: number;
        usePublishedCoverage?: true | 'reconcile' | 'independent-pit';
        definition?: PublicFilterSourceDefinition;
      }>)
  | Readonly<{
      bootstrap: string;
      inputLimit?: number;
      subjectEnrollment?: SubjectEnrollment;
      coldEnrollment?: ColdEnrollmentRequest;
    }>;
type FreshPitTransfer = (
  queried: PublicFilterQueriedObservation,
  previousWork: string,
  adoptedWork: string,
) => Promise<{ transferred: boolean; cost: PublicFilterCost } | PublicFilterBindingFailure>;
export type NativePublicFilterPreparation =
  | (Extract<PublicSourceBootstrapResult, { status: 'begun' }> & {
      enrollmentAdvanced?: true;
      freshPit?: Readonly<{
        independent?: true;
        transfer?: FreshPitTransfer;
        unopened(initialWork?: string): Promise<{ unopened: boolean; cost: PublicFilterCost } | PublicFilterBindingFailure>;
        adopt(queried: PublicFilterQueriedObservation): ReturnType<PublicFilterSourceBootstrapBinding['adopt']>;
      }>;
    })
  | PublicFilterBindingFailure
  | Readonly<{ status: 'repairing'; bootstrapId: string; cost: PublicFilterCost }>
  | Readonly<{
      status: 'preparing';
      bootstrap: PublicSourceBootstrap;
      enrollmentAdvanced: boolean;
      cost: PublicFilterCost;
    }>;
type NativePreparationResult =
  | NativePublicFilterPreparation
  | Readonly<{ status: 'enrollment-sealed'; cost: PublicFilterCost }>
  | Readonly<{ status: 'ranges-prepared'; ranges: readonly PreparedEnrollmentRange[]; cost: BindingCost }>
  | Readonly<{ status: 'range-adopted' | 'range-pending'; cost: BindingCost }>;
const nativePreparations = new WeakMap<
  PublicFilterSourceBinding,
  (input: NativePreparationInput, context: PublicFilterConsumerContext) => Promise<NativePreparationResult>
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
type SubjectRepairWriterObligation = Pick<
  PublicFilterProjectionObservation,
  'subject' | 'partition' | 'epoch' | 'position'
>;
type NativeRepairEvidence = Readonly<{
  repairs: readonly PublicSourceRepair[];
  account: AccountDiscoveryRepairObservation | null;
  subject?: SubjectRepairWriterObligation;
  nextScan?: Readonly<{ inputKeys: number; bytes: number }>;
}>;
// A verified response may carry bodies already checked by that invocation.
// A copied response or another binding cannot recover this evidence.
const publicFilterRepairEvidence = new WeakMap<
  Extract<NativeSourceRepairStepVerification, { status: 'verified' }>,
  Readonly<{ binding: PublicFilterSourceBinding; evidence: NativeRepairEvidence }>
>();

export function nativePublicFilterRepairEvidence(
  binding: PublicFilterSourceBinding,
  step: Extract<NativeSourceRepairStepVerification, { status: 'verified' }>,
): NativeRepairEvidence | undefined {
  const evidence = publicFilterRepairEvidence.get(step);
  return evidence?.binding === binding ? evidence.evidence : undefined;
}

type NativeRepairStartInput = Readonly<{
  bootstrap: string;
  queried: PublicFilterQueriedObservation;
  publicationJob?: string;
}>;
const nativeRepairStarts = new WeakMap<
  PublicFilterSourceBinding,
  (
    request: NativeRepairStartInput,
    context: PublicFilterConsumerContext,
  ) => Promise<Readonly<{ start: PrivacyReductionStart; cost: PublicFilterCost }>>
>();
const nativeRepairJoins = new WeakMap<PublicFilterSourceBinding, PublicFilterSourceBinding['join']>();
type RepairAccountReadPlan = Readonly<{
  ids: readonly string[];
  charge(cost?: PublicFilterCost): void;
}>;
type RepairReadBatch = <T>(
  input: Omit<NativeSourceRepairStepRead, 'predecessor'>,
  context: PublicFilterConsumerContext,
  read: () => Promise<T>,
  accounts?: RepairAccountReadPlan,
) => Promise<T>;
const nativeRepairReadBatches = new WeakMap<PublicFilterSourceBinding, RepairReadBatch>();

/** Share the immutable execution join within an independent Search settlement.
 * Each Source step still checks its predecessor, owner data and current cut.
 */
export function withNativePublicFilterRepairReadBatch<T>(
  binding: PublicFilterSourceBinding,
  input: Omit<NativeSourceRepairStepRead, 'predecessor'>,
  context: PublicFilterConsumerContext,
  read: () => Promise<T>,
  accounts?: RepairAccountReadPlan,
): Promise<T> {
  return nativeRepairReadBatches.get(binding)?.(input, context, read, accounts) ?? read();
}

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
  request: NativeRepairStartInput,
  context: PublicFilterConsumerContext,
) {
  return nativeRepairStarts.get(binding)?.(request, context) ?? null;
}

const nativeBookPageRestorations = new WeakMap<PublicFilterSourceBinding, PublicFilterSourceBinding['join']>();
const nativeBookPreparations = new WeakMap<
  PublicFilterSourceBinding,
  (
    members: readonly NativeBookPreparation[],
    context: PublicFilterConsumerContext,
  ) => Promise<NativePublicFilterPreparation[]>
>();
type BookPreparationGroup = { members: readonly NativeBookPreparation[] };

/** A private factory association locates the native body. Each child still resolves its registration and cut. */
export function advanceNativePublicFilterPreparation(
  binding: PublicFilterSourceBinding,
  input: { pageObservation: PublicFilterQueriedObservation },
  context: PublicFilterConsumerContext,
): Promise<Awaited<ReturnType<PublicFilterSourceBinding['join']>> | null>;
export function advanceNativePublicFilterPreparation(
  binding: PublicFilterSourceBinding,
  input: BookPreparationGroup,
  context: PublicFilterConsumerContext,
): Promise<NativePublicFilterPreparation[] | null>;
export function advanceNativePublicFilterPreparation(
  binding: PublicFilterSourceBinding,
  input: {
    bootstrap: string;
    inputLimit: number;
    subjectEnrollment: SubjectEnrollment;
    coldEnrollment: ColdEnrollmentRequest;
  },
  context: PublicFilterConsumerContext,
): Promise<NativePreparationResult | null>;
export function advanceNativePublicFilterPreparation(
  binding: PublicFilterSourceBinding,
  input: { bootstrap: string; inputLimit?: number; subjectEnrollment: SubjectEnrollment },
  context: PublicFilterConsumerContext,
): Promise<NativePreparationResult | null>;
export function advanceNativePublicFilterPreparation(
  binding: PublicFilterSourceBinding,
  input: Exclude<NativePreparationInput, { bootstrap: string }> | { bootstrap: string; inputLimit?: number },
  context: PublicFilterConsumerContext,
): Promise<NativePublicFilterPreparation | null>;
export async function advanceNativePublicFilterPreparation(
  binding: PublicFilterSourceBinding,
  input: NativePreparationInput | BookPreparationGroup | { pageObservation: PublicFilterQueriedObservation },
  context: PublicFilterConsumerContext,
) {
  if ('pageObservation' in input)
    return nativeBookPageRestorations.get(binding)?.({ queried: input.pageObservation }, context) ?? null;
  if ('members' in input) return nativeBookPreparations.get(binding)?.(input.members, context) ?? null;
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
  db: CommandTransaction,
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
  if (!release || Object.keys(release.types).length === 0) throw new BindingError('definition_missing');
  return { definition: restoreDefinition(id, row, release, search), bytes };
}
type DefinitionRow = Pick<
  NonNullable<Awaited<ReturnType<typeof readDefinition.run>>>,
  'source_id' | 'configuration' | 'owner_epoch' | 'release_digest' | 'capture' | 'dependency_keys'
>;
function restoreDefinition(
  id: string,
  row: DefinitionRow,
  release: PublicFilterProjectionMeaning['release'],
  search: NativeSourceBindingPorts['search'],
): PublicFilterSourceDefinition {
  let capture: PublicSourceCaptureInput;
  let keys: readonly PublicFilterDependencyKey[];
  const meaning = {
    digest: row.release_digest,
    release,
  };
  try {
    capture = decode<PublicSourceCaptureInput>(row.capture);
    keys = search.deriveDependencyKeys(meaning, capture);
  } catch {
    throw new BindingError('binding_mismatch');
  }
  if (!isDeepStrictEqual(keys, row.dependency_keys)) throw new BindingError('binding_mismatch');
  return {
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
  };
}
const handoffServingPit = readFileSync(new URL('./public-filter-source-handoff-pit.sql', import.meta.url), 'utf8');
const retireSplitObservations = readFileSync(
  new URL('./public-filter-source-retire-split.sql', import.meta.url),
  'utf8',
);

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
        const native = /^\s*\/\* semantic\.native-keyed:(\d+):(\d+)(?::(\d+))? \*\//.exec(text);
        const writes = native !== null && /^\s*(?:\/\*[\s\S]*?\*\/\s*)*(?:INSERT|UPDATE|DELETE)\b/.test(text);
        cost.statements++;
        cost.inputKeys += native ? Number(native[2]) : parameters.length;
        cost.bytes += Buffer.byteLength(text) + Buffer.byteLength(encode(parameters));
        if (native) {
          cost.rows += Number(native[1]);
          cost.dependencyPoints += Number(native[1]);
          cost.resultWrites += native[3] === undefined ? Number(writes) : Number(native[3]);
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
  async function loadDefinition(id: string, db: CommandTransaction): Promise<PublicFilterSourceDefinition> {
    return (await readNativePublicFilterSourceDefinition(id, db, routeDigest, ports.search)).definition;
  }
  const readers = new Map<string, PublicFilterSource>();
  // Only immutable definitions just resolved by this binding can be handed on
  // to its original preparation. Registration and the native epoch are checked there.
  const resolvedDefinitions = new WeakSet<PublicFilterSourceDefinition>();
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
      !hasPublicFilterMeaningShape(own.meaning) ||
      !hasPublicFilterMeaningShape(retained.meaning) ||
      encode(own.source) !== encode(retained.source) ||
      own.readDefinition !== retained.readDefinition ||
      own.meaning.digest !== retained.meaning.digest ||
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
  function bookPopulationKey(
    publication: string,
    generation: string,
    epoch: number,
    withdrawals: string | null,
    definition: PublicFilterSourceDefinition,
  ) {
    return JSON.stringify([publication, generation, epoch, withdrawals, definition.dependencyKeys]);
  }
  type BootstrapRow = NonNullable<Awaited<ReturnType<typeof readBootstrap.run>>>;
  async function loadBootstrap(
    locator: string,
    db: CommandTransaction,
    knownDefinition?: PublicFilterSourceDefinition,
    captured?: BootstrapRow,
  ) {
    const row = captured ?? (await nativeSourceQuery(db, readBootstrap, { bootstrap: nativeId(locator) }));
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
      ...(row.coverage_publication ? { coveragePublication: row.coverage_publication } : {}),
      ...(row.coverage_publication &&
      row.coverage_generation !== null &&
      row.snapshot_kind === 'pit' &&
      'bookTypeList' in definition.capture &&
      definition.capture.bookTypeList === true
        ? {
            bookPopulation: bookPopulationKey(
              row.coverage_publication,
              row.coverage_generation,
              row.owner_epoch,
              row.withdrawal_digest,
              definition,
            ),
          }
        : {}),
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
  async function requireServingCoverage(cut: Awaited<ReturnType<typeof loadBootstrap>>, db: Pool) {
    const publication = cut.row.coverage_publication;
    if (!publication) return requirePopulationBaseline(cut.row);
    const consumer = cut.bootstrap.consumer;
    const mixed = 'representation' in cut.definition.capture;
    const coverage = mixed
      ? 'semantic.public_filter_mixed_coverage($1,$2,$3,$4,$5::text)'
      : 'semantic.public_filter_published_coverage($1,$2,$3,$4,$5::text[])';
    // Reuse only the PostgreSQL plan. Each execution checks the current publication and cut.
    const current = await db.query({
      name: mixed ? 'semantic_serving_mixed_coverage_v1' : 'semantic_serving_published_coverage_v1',
      text: `/* semantic.native-keyed:15:20 */
       SELECT 1 FROM ${coverage}
       WHERE generation >= $6::bigint`,
      values: [
        consumer.physicalTarget,
        consumer.incarnation,
        cut.definition.readDefinition,
        publication,
        mixed ? ports.search.encodeConsumer(consumer) : [...PUBLIC_FILTER_CATALOGUE_TEXT_KEYS],
        cut.row.coverage_generation,
      ],
    });
    if (current.rowCount !== 1) throw new BindingError('owner_unavailable');
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
    /** Highest retained position the Subject projection and native writer must cover. */
    bridgeThrough?: bigint;
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
    bridgeEvents?: Readonly<{ count: number; digest: string } | { envelopes: string }>;
    windowBatch?: Readonly<{
      from: number;
      count: number;
      examined: number;
      digest: string;
      packed: string;
      through?: readonly string[];
    }>;
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
  const preparationInputLimit = 1000;
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
        window.through < window.base ||
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
      (batch.through !== undefined && (batch.through.length !== batch.count || batch.count !== batch.examined)) ||
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
    const through = batch.through === undefined ? base : BigInt(batch.through[offset]!);
    if (epoch < 1 || through < base || !/^[0-9a-f]{64}$/.test(receipt)) throw new BindingError('binding_mismatch');
    return {
      partition: home,
      epoch,
      receipt,
      base,
      through,
      position: base + 1n,
      sequence: 0,
      eventCount: null,
    };
  }
  function resumeCreationBridge(state: RepairState): RepairState {
    const window = state.resumeBridge;
    if (!window) throw new BindingError('binding_mismatch');
    const { resumeBridge: _resume, bridgeThrough: _through, ...rest } = state;
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
  function closedCreationBridge(record: RepairRecord) {
    const { input, next, bridgeEvents } = record;
    if (
      input.phase !== 'bridge' ||
      !input.bridge ||
      next.phase !== 'window' ||
      next.partition !== input.bridge.partition + 1 ||
      (input.bridge.position <= input.bridge.through && !bridgeEvents)
    )
      return undefined;
    return input.bridge;
  }
  async function advanceCreationBridge(
    bootstrap: string,
    state: RepairState,
    db: Pool,
    context: PublicFilterConsumerContext,
    accounts: boolean,
    cost: BindingCost,
    options: Readonly<{
      inputLimit: number;
      batch: boolean;
      subjectRange: boolean;
      retained?: Pick<RepairRecord, 'next' | 'bridgeEvents'>;
    }>,
  ): Promise<Readonly<{ next: RepairState; receipt?: RepairRecord['bridgeEvents'] }>> {
    const { inputLimit, batch, retained } = options;
    if (state.resumeBridge || state.bridgeThrough !== undefined || state.subject !== null || state.projection !== null)
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
        retained?.next.bridge,
      );
      return { next: { ...state, epoch: window.epoch, phase: 'bridge', bridge: window } };
    }
    const window = state.bridge;
    if (state.phase !== 'bridge' || !window || state.epoch !== window.epoch) throw new BindingError('binding_mismatch');
    // A verified window batch retains its range start in the successor. Only
    // the first advance may still have that cursor instead of the open home.
    const home = window.partition;
    if (
      state.partition !== home &&
      (state.partition > home ||
        home - state.partition >= repairHomeBatchLimit ||
        window.position !== window.base + 1n ||
        window.position > window.through ||
        window.sequence !== 0)
    )
      throw new BindingError('binding_mismatch');
    const exhausted = window.position > window.through;
    const input = { bootstrap: nativeId(bootstrap), window };
    const original = retained?.bridgeEvents;
    const subjectRange = retained ? original !== undefined && 'envelopes' in original : options.subjectRange;
    if (subjectRange && !options.subjectRange) throw new BindingError('binding_mismatch');
    const retainedCount = original && 'count' in original ? original.count : undefined;
    let bridgeThrough: bigint | undefined;
    let receipt: RepairRecord['bridgeEvents'];
    let result: Awaited<ReturnType<typeof readPublicFilterCreationEvent>>;
    if (!exhausted && (retained ? retained.bridgeEvents !== undefined : batch)) {
      const range = await readPublicFilterCreationEvents(
        db,
        { ...input, accounts, inputLimit, subjectRange, ...(retainedCount === undefined ? {} : { retainedCount }) },
        context,
        cost,
      );
      result = range;
      if (range.packed !== undefined) {
        receipt = { envelopes: range.packed };
        bridgeThrough = BigInt(range.envelopes.at(-1)!.position);
      } else receipt = { count: range.envelopes.length, digest: hash(encode(range.envelopes)) };
    } else {
      // Retained single-event steps replay the exact old read. Closing an
      // exhausted window still revalidates the three original binding rows.
      const extraRows = exhausted ? 2 : 3;
      cost.rows += extraRows;
      cost.dependencyPoints += extraRows;
      cost.inputKeys++;
      result = await readPublicFilterCreationEvent(db, input, context);
    }
    const event = result.event;
    const action = event === null ? null : publicFilterCreationAction(event.type, accounts);
    // A replay keeps its original successor, including earlier receipts that
    // recorded the exhausted cursor as a separate step.
    const closedByRange =
      receipt &&
      action === null &&
      result.next.position > window.through &&
      (!retained || retained.next.phase === 'window');
    if (event === null || closedByRange) {
      const { bridge: _bridge, ...rest } = state;
      return { next: { ...rest, partition: home + 1, epoch: null, phase: 'window' }, receipt };
    }
    if (action === null) return { next: { ...state, partition: home, bridge: result.next }, receipt };
    const route = event.subject === null ? null : routeOf(event.subject);
    if (route === null || (action === 'semantic' && partitionOf(route) !== home))
      throw new BindingError('binding_mismatch');
    // The event home and the Account home may differ (claim delivery). Resolve
    // the owner on the next bounded step; no foreign home is joined here.
    const { bridge: _bridge, ...rest } = state;
    const owner = await readPartition(db, partitionOf(route));
    if (!owner || owner.writeState !== 'active' || (bridgeThrough !== undefined && owner.epoch !== window.epoch))
      throw new BindingError('owner_unavailable');
    return {
      next: {
        ...rest,
        owner: action,
        partition: partitionOf(route),
        epoch: owner.epoch,
        subject: event.subject,
        after: null,
        phase: action === 'accounts' ? 'account' : 'advance',
        advance: retained?.next.advance ?? randomUUID(),
        version: null,
        projection: null,
        resumeBridge: result.next,
        ...(bridgeThrough === undefined ? {} : { bridgeThrough }),
      },
      receipt,
    };
  }
  async function scanIrrelevantCreationPrefix(
    bootstrap: string,
    state: RepairState,
    inputLimit: number,
    db: Pool,
    context: PublicFilterConsumerContext,
    cost: BindingCost,
    accounts: boolean,
    retained?: NonNullable<RepairRecord['windowBatch']>,
  ) {
    if (
      state.phase !== 'window' ||
      state.owner !== 'semantic' ||
      state.epoch !== null ||
      state.subject !== null ||
      state.projection !== null ||
      state.bridge ||
      state.resumeBridge
    )
      throw new BindingError('binding_mismatch');
    const prefix = await readPublicFilterCreationPrefix(
      db,
      {
        bootstrap: nativeId(bootstrap),
        from: state.partition,
        inputLimit,
        ...(accounts && { accounts: true }),
        ...(retained?.through === undefined ? {} : { through: retained.through }),
      },
      context,
      cost,
    );
    if (retained && prefix.length !== retained.count) throw new BindingError('owner_unavailable');
    if (!prefix.length) return null;
    const windows = prefix.map(({ window }) => window);
    return {
      next: { ...state, partition: state.partition + windows.length },
      batch: {
        from: state.partition,
        count: windows.length,
        examined: windows.length,
        digest: hash(encode({ input: state, inputLimit, prefix })),
        packed: packClosedCreationWindows(windows),
        through: windows.map(({ through }) => String(through)),
      },
    };
  }
  async function scanCreationWindows(
    bootstrap: string,
    state: RepairState,
    inputLimit: number,
    db: Pool,
    cost: BindingCost,
    retained?: Pick<RepairRecord, 'windowBatch' | 'next'>,
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
    const maxHomes = Math.min(inputLimit, repairHomeBatchLimit, 4096 - state.partition);
    const limit = retained?.windowBatch?.examined ?? maxHomes;
    if (!Number.isInteger(limit) || limit < 1 || limit > maxHomes) throw new BindingError('binding_mismatch');
    const consumer = publicFilterCreationConsumer(nativeId(bootstrap));
    cost.rows += limit * 2;
    cost.dependencyPoints += limit * 2;
    cost.inputKeys += limit;
    const rows = await nativeSourceQuery(db, repairWindowScan, {
      bootstrap: nativeId(bootstrap),
      consumer,
      partition_no: state.partition,
      through: state.partition + limit - 1,
      replaying: retained !== undefined,
    });
    if (rows.length < 1 || rows.length > limit || (retained && rows.length !== limit))
      throw new BindingError('binding_mismatch');
    const closed: PublicFilterCreationWindow[] = [];
    const originalRows: (typeof rows)[number][] = [];
    const retainedOpen = retained?.next.bridge;
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
      // Only the final home could be open in the saved scan. Later appends
      // must leave its bridge and the digest for all examined homes intact.
      const through = retained ? (retainedOpen?.partition === partition ? retainedOpen.through : base) : head;
      if (
        base < 0n ||
        typeof through !== 'bigint' ||
        through < base ||
        head < through ||
        checkpoint > base ||
        !/^[0-9a-f]{64}$/.test(row.receipt)
      )
        throw new BindingError('configuration_changed');
      originalRows.push(retained ? { ...row, head: String(through) } : row);
      const window: PublicFilterCreationWindow = {
        partition,
        epoch: row.epoch,
        receipt: row.receipt,
        base,
        through,
        position: base + 1n,
        sequence: 0,
        eventCount: null,
      };
      if (through === base) closed.push(window);
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
        digest: hash(encode({ input: state, inputLimit, consumer, rows: originalRows })),
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
      source.position < state.version ||
      (state.bridgeThrough !== undefined && state.version < state.bridgeThrough)
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
  let lastRepairBinding: { release: PublicFilterProjectionMeaning['release']; key: string; digest: string } | undefined;
  function repairChain(bootstrap: PublicSourceBootstrap, joined: Joined) {
    if (!joined.execution) throw new BindingError('execution_missing');
    const basis = {
      definition: bootstrap.definition,
      consumer: bootstrap.consumer,
      snapshot: bootstrap.snapshot,
      covered: joined.covered,
      queried: joined.queried,
      execution: joined.execution,
    };
    // The native definition reader resolves the release before each call.
    // Its frozen body can reuse the original chain digest for identical inputs.
    const { release, ...meaning } = basis.definition.meaning;
    const key = encode({ ...basis, definition: { ...basis.definition, meaning } });
    if (lastRepairBinding?.release !== release || lastRepairBinding.key !== key)
      lastRepairBinding = { release, key, digest: hash(encode(basis)) };
    return {
      bootstrap: nativeId(bootstrap.id),
      execution: joined.execution.id,
      binding: lastRepairBinding.digest,
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
      state.bridgeThrough === undefined &&
      state.resumeAccountScan === undefined &&
      state.claimInputs === true
    );
  }
  function subjectHomeScan(state: RepairState): boolean {
    return (
      state.owner !== 'accounts' &&
      state.phase === 'scan' &&
      state.partition < 4096 &&
      state.subject === null &&
      state.projection === null &&
      state.version === null &&
      state.bridge === undefined &&
      state.resumeBridge === undefined &&
      state.bridgeThrough === undefined &&
      state.resumeAccountScan === undefined
    );
  }
  async function repairNative(
    bootstrap: PublicSourceBootstrap,
    joined: Joined & { cut: Awaited<ReturnType<typeof loadBootstrap>> },
    request: { execution: string; frontier: string | null; inputLimit: number; homeLimit?: number; scanOnly?: true },
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
    const originalSubject = boundSubjectPublication(joined.cut, {
      execution: request.execution,
      queried: joined.queried,
    });
    const keys = { bootstrap: id, execution: request.execution, predecessor: request.frontier ?? '' };
    const link = originalSubject ? await nativeSourceQuery(db, repairLink, { ...keys, binding: chain.binding }) : null;
    async function readVerifiedFrontier(step: string) {
      const row = await nativeSourceQuery(db, repairState, {
        bootstrap: id,
        execution: request.execution,
        step,
      });
      return row?.verified_binding === chain.binding && row.verified_root !== null && row.verified_ordinal !== null
        ? row
        : null;
    }
    let previous =
      request.frontier === null
        ? null
        : link
          ? link.predecessor_verified && link.predecessor_state !== null && link.predecessor_complete !== null
            ? { state: link.predecessor_state, complete: link.predecessor_complete }
            : null
          : await readVerifiedFrontier(request.frontier);
    if (request.scanOnly && (!previous || previous.complete || request.homeLimit !== repairHomeBatchLimit))
      throw new BindingError('owner_unavailable');
    if (request.frontier !== null && !previous) {
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
      if (verified.status !== 'verified') return fail('owner_unavailable', cost);
      previous = await readVerifiedFrontier(request.frontier);
      if (!previous) return fail('owner_unavailable', cost);
    }
    const old = !link
      ? await nativeSourceQuery(db, repairRead, keys)
      : link.step !== null && link.state !== null && link.complete !== null
        ? { ...link, step: link.step, state: link.state, complete: link.complete }
        : null;
    if (old && (old.receipt_protocol !== 1 || old.input_limit === null)) throw new BindingError('owner_unavailable');
    const retainedLocatorDigests = old
      ? unpackRepairLocatorDigests(old.repair_locator_digests, old.input_limit!)
      : null;
    const replay = old ? decode<RepairRecord>(old.state) : null;
    if (request.scanOnly) {
      const predecessor = decode<RepairRecord>(previous!.state);
      if (
        !originalSubject ||
        predecessor.scan?.kind !== 'semantic' ||
        !subjectHomeScan(predecessor.next) ||
        (replay &&
          (replay.scan?.kind !== 'semantic' || encode(replay.input) !== encode(predecessor.next) || old!.complete))
      )
        throw new BindingError('owner_unavailable');
    }
    const step = old?.step ?? randomUUID();
    let state: RepairState;
    if (replay) state = replay.input;
    else if (previous) {
      if (previous.complete) throw new BindingError('binding_mismatch');
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
    const mixed = 'representation' in bootstrap.definition.capture;
    const scansHomes =
      state.partition < 4096 &&
      ((state.phase === 'scan' && (mixed || state.owner !== 'accounts') && (!replay || replay.scan)) ||
        (state.phase === 'window' && state.owner !== 'accounts' && (!replay || replay.windowBatch)));
    // A pending Account home can seek three native keys. Keep both reads of
    // its original scan and the Search page writes inside the same allowance.
    const fundedHomes = scansHomes ? (request.homeLimit ?? request.inputLimit) : request.inputLimit;
    const mixedCreation = mixed && scansHomes && state.phase === 'window' && request.homeLimit !== undefined;
    // Two reads of a creation prefix can use 192 points each. This leaves the
    // remainder of the existing 768-input repair reservation for native custody
    // and the cheaper empty-window seek.
    const offeredLimit =
      state.owner === 'accounts'
        ? Math.max(request.inputLimit, Math.min(fundedHomes, 96))
        : mixedCreation
          ? Math.min(192, fundedHomes + Math.floor(fundedHomes / 2))
          : fundedHomes;
    // A lost reply or upgrade replays the exact original range and digest.
    const inputLimit = old?.input_limit ?? offeredLimit;
    if (
      inputLimit !== offeredLimit &&
      inputLimit !== request.inputLimit &&
      !(mixedCreation && inputLimit === fundedHomes)
    )
      throw new BindingError('owner_unavailable');
    // A lost Search reply can leave a verified empty key scan at this exact
    // predecessor. Return that immutable intent and let the independent reader
    // reopen current Source authority and check the original range.
    if (
      link &&
      old &&
      replay &&
      !old.complete &&
      replay.scan?.kind === 'semantic' &&
      subjectHomeScan(replay.input) &&
      replay.output === null &&
      replay.account === undefined &&
      retainedLocatorDigests?.length === 0 &&
      link.linked &&
      link.verified_root ===
        publicFilterRepairPageRoot(link.predecessor_root ?? chain.binding, {
          step,
          predecessor: request.frontier,
          state: old.state,
          complete: false,
          inputLimit,
          digests: old.repair_locator_digests!,
        })
    )
      return { status: 'progress', repairs: [], frontier: step, cost };
    let next = structuredClone(state);
    let repairs: PublicSourceRepair[] = [],
      output: RepairRecord['output'] = null,
      account: AccountDiscoveryRepairObservation | undefined,
      scan: RepairRecord['scan'],
      windowBatch: RepairRecord['windowBatch'],
      bridgeEvents: RepairRecord['bridgeEvents'],
      complete = false;
    if (state.partition === 4096) {
      if (state.phase === 'window') {
        // Every original scan, enrollment/pin and captured event successor was
        // independently checked before extending this native prefix. Completion
        // closes that captured window; it grants neither receiver ACK nor serving.
        if (!terminalRepairState(state) || !previous) throw new BindingError('owner_unavailable');
        if (joined.cut.row.ack_protocol === 1) {
          const root = await db.query(
            `/* semantic.native-keyed:21:24 */
             SELECT 1 FROM search.public_filter_ack_range WHERE (partition_no,job,binding,first_home,width,witness)=
               (0,$1,$2,0,4096,search.public_filter_ack_range_witness($3,0,4096,search.public_filter_ack_witness(ARRAY['','@ack-retention','@accounts','@source'])))`,
            [request.execution, chain.binding, chain.bootstrap],
          );
          if (!root.rowCount) throw new BindingError('owner_unavailable');
        }
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
      const accounts = mixed;
      const scanPrefix = replay ? replay.windowBatch?.through !== undefined : request.homeLimit !== undefined && !mixed;
      const prefix = scanPrefix
        ? await scanIrrelevantCreationPrefix(
            bootstrap.id,
            state,
            inputLimit,
            db,
            context,
            cost,
            accounts,
            replay?.windowBatch,
          )
        : null;
      const windows =
        prefix ?? (await scanCreationWindows(bootstrap.id, state, inputLimit, db, cost, replay ?? undefined));
      const closed =
        !replay &&
        accounts &&
        (windows.next.phase === 'bridge' ||
          (mixedCreation &&
            (windows.batch?.count ?? 0) < Math.min(4096 - state.partition, mixedCreationPrefixHomes(inputLimit))))
          ? await scanIrrelevantCreationPrefix(bootstrap.id, state, inputLimit, db, context, cost, true)
          : null;
      const scanned = closed && closed.next.partition > windows.next.partition ? closed : windows;
      next = scanned.next;
      windowBatch = scanned.batch;
    } else if (state.phase === 'window' || state.phase === 'bridge') {
      const bridge = await advanceCreationBridge(
        bootstrap.id,
        state,
        db,
        context,
        'representation' in bootstrap.definition.capture,
        cost,
        {
          inputLimit,
          batch: request.homeLimit !== undefined || mixed,
          subjectRange:
            boundSubjectPublication(joined.cut, { execution: request.execution, queried: joined.queried }) &&
            (request.homeLimit !== undefined || replay !== null),
          ...(replay ? { retained: replay } : {}),
        },
      );
      next = bridge.next;
      bridgeEvents = bridge.receipt;
    } else if (state.phase === 'scan' && (!replay || replay.scan)) {
      if (state.owner === 'accounts') {
        const scanned = await scanAccountHomes(state, inputLimit, db, cost);
        next = scanned.next;
        scan = scanned.receipt;
      } else {
        const scanned = await scanSemanticHomes(state, inputLimit, db, cost, replay?.next.advance);
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
        // A saved successor can only replay its original committed advancement.
        // Revalidate the receipt without taking the owner command lock again.
        const retained = replay ? await nativeSourceQuery(db, repairVersion, values) : null;
        if (replay && !retained) throw new BindingError('owner_unavailable');
        const advance = () =>
          runCommand(
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
        const advancement = retained ? { value: retained, position: owner.position } : await advance();
        const position = BigInt(advancement.value.position);
        if (
          advancement.value.transaction_id === null ||
          advancement.value.native_xid === null ||
          advancement.value.owner_epoch !== owner.epoch ||
          position > advancement.position ||
          (state.bridgeThrough !== undefined && position < state.bridgeThrough)
        )
          throw new BindingError('configuration_changed');
        next = {
          ...next,
          version: position,
          phase: 'project',
        };
      } else {
        const source = sourceReader(bootstrap.definition);
        const origin = ports.sourceOrigin(source);
        if (!origin) throw new BindingError('source_missing');
        if (
          replay?.output &&
          (!replay.output.request ||
            replay.output.request.inputLimit !== inputLimit ||
            encode(replay.output.request.frontier) !== encode(state.projection))
        )
          throw new BindingError('binding_mismatch');
        const page = await readOriginalPublicFilterProjectionPage(
          origin,
          {
            subject: state.subject!,
            meaning: bootstrap.definition.meaning,
            inputLimit,
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
            inputLimit,
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
      ...(bridgeEvents ? { bridgeEvents } : {}),
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
        input_limit: inputLimit,
        repair_locator_digests: packRepairLocatorDigests(
          repairs.map((repair) => repair.locator),
          inputLimit,
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
  async function joinNativeCut(
    request: Parameters<PublicFilterSourceBinding['join']>[0],
    context: PublicFilterConsumerContext,
    mode: 'serve' | 'repair' | 'book-page',
  ) {
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
      // An adopted Book cursor restores only the immutable original cut. Its
      // planned page reads this same live publication at START before dispatch.
      const originalPage =
        mode === 'book-page' &&
        retained.execution === null &&
        cut.bootstrap.bookPopulation &&
        cut.row.state === 'adopted' &&
        cut.row.queried === retained.queried.snapshot.observation;
      // Mixed resume still joins the exact cut and execution. The page's
      // population roles verify attached coverage before dispatch and disclosure.
      const mixedPage =
        input.mixedCoveragePage === true &&
        'representation' in definition.capture &&
        cut.row.coverage_publication !== null &&
        cut.row.state === 'adopted' &&
        cut.row.queried === retained.queried.snapshot.observation &&
        (retained.execution === null || retained.execution.start.observation.startsWith('population:'));
      if (mode !== 'repair' && !originalPage && !mixedPage) await requireServingCoverage(cut, db);
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
          const started = startLocator === cut.bootstrap.id ? cut : await loadBootstrap(startLocator, db, definition);
          if (
            started.definition.readDefinition !== definition.readDefinition ||
            encode(started.bootstrap.consumer) !== encode(retained.queried.consumer) ||
            started.bootstrap.snapshot !== retained.queried.snapshot.kind ||
            started.row.state === 'aborting' ||
            started.row.state === 'aborted'
          )
            throw new BindingError('binding_mismatch');
          if (mode !== 'repair') await requireServingCoverage(started, db);
        }
      }
      freeze(definition);
      return {
        status: 'joined' as const,
        ...(cut.bootstrap.bookPopulation ? { bookPopulation: cut.bootstrap.bookPopulation } : {}),
        definition,
        queried: retained.queried,
        covered: retained.covered,
        execution: retained.execution,
        cut,
        cost,
      };
    });
  }
  async function joinNative(
    request: Parameters<PublicFilterSourceBinding['join']>[0],
    context: PublicFilterConsumerContext,
    mode: 'serve' | 'repair' | 'book-page' = 'serve',
  ): ReturnType<PublicFilterSourceBinding['join']> {
    const joined = await joinNativeCut(request, context, mode);
    if (joined.status !== 'joined') return joined;
    const { cut: _cut, ...result } = joined;
    return result;
  }
  function ownsSource(source: PublicFilterSource) {
    const origin = ports.sourceOrigin(source);
    return origin?.pool === pool && origin.access === access && hash(origin.routeKey) === routeDigest;
  }
  const binding: PublicFilterSourceBinding = {
    async readDefinition(request, context) {
      if (!ownsSource(request.source)) return fail('source_missing');
      const id = request.id;
      return run(context, async (cost, db) => {
        const definition = await loadDefinition(id, db);
        freeze(definition);
        return { status: 'resolved' as const, definition, cost };
      });
    },
    async resolve(request, context) {
      const readOnly = request.readOnly === true;
      // Capture all caller data and constructor identity before the first suspension.
      let meaning: PublicFilterProjectionMeaning, capture: PublicSourceCaptureInput;
      if (!ownsSource(request.source)) return fail('source_missing');
      try {
        if (!hasPublicFilterMeaningShape(request.meaning)) return fail('binding_mismatch');
        const { digest, release } = request.meaning;
        meaning = hasVerifiedReleaseDigest(release, digest) ? { digest, release } : structuredClone(request.meaning);
        capture = structuredClone(request.capture);
        if (!hasPublicFilterMeaningShape(meaning) || Object.keys(meaning.release.types).length === 0)
          return fail('binding_mismatch');
      } catch {
        return fail('binding_mismatch');
      }
      return run(context, async (cost, db) => {
        const keys = ports.search.deriveDependencyKeys(meaning, capture);
        const encoded = encode(capture);
        if (Buffer.byteLength(encoded) > 1048576) throw new BindingError('binding_mismatch');
        const definitionInput = {
          route_digest: routeDigest,
          release_digest: meaning.digest,
          capture_digest: hash(encoded),
          capture: encoded,
          dependency_keys: [...keys],
          coverage_keys: [
            ...publicFilterCoverageKeys(keys, 'catalogueCoverage' in capture && capture.catalogueCoverage === true),
            ...('representation' in capture ? [PUBLIC_FILTER_ACCOUNT_DOMAIN] : []),
          ].sort(),
        };
        if (!readOnly && 'bookTypeList' in capture && capture.bookTypeList === true) {
          const plans = bookBindingStep(
            'definitions',
            binding,
            meaning.digest,
            encoded,
            context.deadline,
            { capture, meaning, definitionInput },
            async (members, deadline) => {
              const result = await run({ deadline }, async (cost, db) => {
                const release = await readRelease(db, meaning.digest);
                if (!release || !Object.keys(release.types).length) throw new BindingError('definition_missing');
                const inputs = members.map((m) =>
                  isDeepStrictEqual(m.meaning.release, release) ? m.definitionInput : null,
                );
                if (!inputs.some((i) => i !== null)) throw new BindingError('definition_missing');
                const source = (await nativeSourceQuery(db, registerSource, { route_digest: routeDigest }))[0];
                if (!source) throw new BindingError('owner_unavailable');
                const rows = await db.query<{ read_definition: string; capture_digest: string }>(
                  `WITH input AS (SELECT * FROM jsonb_to_recordset($1) i(capture_digest text,capture text,dependency_keys jsonb,coverage_keys text[])),
                 owner AS MATERIALIZED (SELECT s.* FROM semantic.public_filter_source s JOIN core.partition p USING(partition_no)
                   WHERE (s.partition_no,s.source_id,s.configuration)=(0,$2,$3) AND s.route_digest=$4
                     AND s.owner_epoch=p.epoch AND p.write_state='active'),
                 retained AS MATERIALIZED (
                   SELECT d.read_definition,d.capture_digest FROM owner s CROSS JOIN input i JOIN semantic.public_filter_read_definition d
                     ON d.partition_no=0 AND d.release_digest=$5 AND d.capture_digest=i.capture_digest AND d.capture=i.capture
                       AND d.dependency_keys=i.dependency_keys AND d.coverage_keys=i.coverage_keys
                   WHERE (d.source_id,d.configuration)=(s.source_id,s.configuration) FOR SHARE OF d),
                 added AS (
                   INSERT INTO semantic.public_filter_read_definition
                     (partition_no,source_id,configuration,release_digest,capture_digest,capture,dependency_keys,coverage_keys)
                   SELECT 0,s.source_id,s.configuration,$5,i.capture_digest,i.capture,i.dependency_keys,i.coverage_keys FROM owner s CROSS JOIN input i
                   WHERE NOT EXISTS (SELECT 1 FROM retained r WHERE r.capture_digest=i.capture_digest) ORDER BY i.capture_digest
                   ON CONFLICT(partition_no,source_id,configuration,release_digest,capture_digest) DO UPDATE
                     SET coverage_keys=EXCLUDED.coverage_keys WHERE public_filter_read_definition.capture=EXCLUDED.capture
                       AND public_filter_read_definition.dependency_keys=EXCLUDED.dependency_keys RETURNING read_definition,capture_digest)
                 SELECT * FROM retained UNION ALL SELECT * FROM added`,
                  [
                    JSON.stringify(inputs.filter((i) => i !== null)),
                    source.source_id,
                    source.configuration,
                    routeDigest,
                    meaning.digest,
                  ],
                );
                const ids = new Map(rows.rows.map((r) => [r.capture_digest, r.read_definition]));
                return {
                  cost,
                  definitions: inputs.map((i, index) => {
                    if (!i) return 'definition_missing' as const;
                    const readDefinition = ids.get(i.capture_digest);
                    if (!readDefinition) return 'configuration_changed' as const;
                    const definition: PublicFilterSourceDefinition = {
                      source: {
                        id: source.source_id,
                        partition: 0,
                        epoch: source.owner_epoch,
                        configuration: source.configuration,
                      },
                      readDefinition,
                      meaning: members[index]!.meaning,
                      capture: members[index]!.capture,
                      dependencyKeys: i.dependency_keys,
                    };
                    freeze(definition);
                    resolvedDefinitions.add(definition);
                    return definition;
                  }),
                };
              });
              return members.map((_, index) => {
                const cost = bookCostShare(result.cost, index, members.length);
                if (!('definitions' in result)) return { ...result, cost };
                const definition = result.definitions[index]!;
                return typeof definition === 'string'
                  ? fail(definition, cost)
                  : { status: 'resolved' as const, definition, cost };
              });
            },
          );
          if (plans) return plans;
        }
        // An installed definition resolves from the current Source owner and its exact retained input.
        // First-time registration still reconciles a concurrent writer under the unique keys.
        const [retained] = await nativeSourceQuery(db, lookupDefinition, definitionInput);
        // Caller digest equality is checked again against the actual immutable release owner.
        const release = await readRelease(db, meaning.digest);
        if (!release || !isDeepStrictEqual(release, meaning.release) || Object.keys(release.types).length === 0)
          throw new BindingError('definition_missing');
        if (retained) {
          const definition = restoreDefinition(retained.read_definition, retained, release, ports.search);
          freeze(definition);
          if (!readOnly) resolvedDefinitions.add(definition);
          return { status: 'resolved' as const, definition, cost };
        }
        if (readOnly) throw new BindingError('definition_missing');
        const source = (await nativeSourceQuery(db, registerSource, { route_digest: routeDigest }))[0];
        if (!source) throw new BindingError('owner_unavailable');
        const definition = (
          await nativeSourceQuery(db, defineSource, {
            ...definitionInput,
            source_id: source.source_id,
            configuration: source.configuration,
          })
        )[0];
        if (!definition) throw new BindingError('configuration_changed');
        const native = await loadDefinition(definition.read_definition, db);
        freeze(native);
        resolvedDefinitions.add(native);
        return { status: 'resolved' as const, definition: native, cost };
      });
    },
    join: (request, context) => joinNative(request, context),
  };
  type CaptureMember = { bootstrap: string; definition: string; request_key: string; consumer: string };
  type BookCutReply = { bootstrap: string | null; awaiting: boolean | null; row?: BootstrapRow | undefined };
  type BookCutGroup = {
    member: CaptureMember;
    cost: BindingCost;
    capture: (members: CaptureMember[]) => Promise<
      | {
          rows: readonly (BookCutReply & { definition: string | null })[];
          cost: BindingCost;
        }
      | PublicFilterBindingFailure
    >;
    answer: PromiseWithResolvers<BookCutReply>;
  };
  async function beginRetained(
    request: Parameters<PublicFilterSourceBootstrapBinding['begin']>[0],
    context: PublicFilterConsumerContext,
    existing?: Awaited<ReturnType<typeof loadBootstrap>> & {
      enrollmentRegistration?: { partition: number; id: string };
      receiptPageOnly?: true;
    },
    inputLimit = preparationInputLimit,
    usePublishedCoverage: boolean | 'reconcile' | 'independent-pit' = false,
    definition?: PublicFilterSourceDefinition,
    collect?: (item: BookCutGroup) => void,
    bookRegistration?: Awaited<ReturnType<typeof ports.search.readGenerationPublicationCustody>>,
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
    const known = existing?.definition ?? definition;
    if (
      definition &&
      (!resolvedDefinitions.has(definition) ||
        !ownsSource(request.source) ||
        !isDeepStrictEqual(definition.meaning, request.meaning) ||
        !isDeepStrictEqual(definition.capture, capture))
    )
      return fail('binding_mismatch');
    const resolved = known
      ? { status: 'resolved' as const, definition: known, cost: publicFilterBindingCost() }
      : await binding.resolve({ source: request.source, meaning: request.meaning, capture }, { deadline });
    if (resolved.status !== 'resolved') return resolved;
    readers.set(resolved.definition.source.id, request.source);
    return run({ deadline }, async (cost, db) => {
      addCost(cost, resolved.cost);
      // A new cut depends on the physical registration. Its earlier pages may have expired.
      // Recovery below the binding resolves observations by their original bootstrap.
      const registration =
        bookRegistration ??
        (await ports.search.readGenerationPublicationCustody(
          pool,
          consumer,
          0,
          { deadline },
          undefined,
          'registration',
        ));
      addCost(cost, registration.cost);
      if (!('definition' in registration)) return { ...registration, cost };
      if (
        existing?.enrollmentRegistration &&
        !isDeepStrictEqual(existing.enrollmentRegistration, registration.registration)
      )
        throw new BindingError('binding_mismatch');
      requireSameDefinition(resolved.definition, registration.definition);
      if (
        consumer.readDefinition !== resolved.definition.readDefinition ||
        consumer.meaningDigest !== resolved.definition.meaning.digest
      )
        throw new BindingError('binding_mismatch');
      if (
        existing &&
        (encode(existing.bootstrap.consumer) !== encode(consumer) ||
          existing.bootstrap.snapshot !== snapshot ||
          (existing.row.state !== 'capturing' && existing.row.state !== 'begun'))
      )
        throw new BindingError('binding_mismatch');
      if (usePublishedCoverage && !existing && !('purpose' in capture)) {
        const mixed = 'representation' in capture;
        if (mixed && usePublishedCoverage === 'reconcile') {
          // A background caller needs only the original population job. A
          // settled baseline is enough; the request owns any new serving cut.
          const covered = await db.query(
            `/* semantic.native-keyed:1:4 */
             SELECT 1 FROM semantic.public_filter_mixed_coverage($1,$2,$3,NULL,$4)`,
            [
              consumer.physicalTarget,
              consumer.incarnation,
              resolved.definition.readDefinition,
              ports.search.encodeConsumer(consumer),
            ],
          );
          if (covered.rowCount) throw new BindingError('owner_unavailable');
        }
        const coverage = mixed
          ? 'semantic.public_filter_mixed_coverage($1,$2,$3,NULL,$10)'
          : 'semantic.public_filter_published_coverage($1,$2,$3,NULL,$4::text[])';
        const bookList = !mixed && snapshot === 'pit' && 'bookTypeList' in capture && capture.bookTypeList === true;
        const withdrawals = bookList
          ? `(SELECT proof.book_withdrawals FROM (
                SELECT cut.book_withdrawals FROM semantic.public_filter_bootstrap cut
                WHERE cut.coverage_publication=parent.job AND cut.coverage_generation=parent.generation
                  AND cut.book_withdrawals IS NOT NULL LIMIT 1
              ) proof WHERE NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(proof.book_withdrawals) w
                LEFT JOIN semantic.subject s ON (s.route,s.subject_id)=((w->>'route')::integer,(w->>'id')::uuid)
                WHERE s.visibility IS DISTINCT FROM w->>'visibility'
                  OR s.security_revision::text IS DISTINCT FROM w->>'revision'
              ))`
          : 'NULL::jsonb';
        const independent = usePublishedCoverage === 'independent-pit' && !mixed && !bookList && snapshot === 'pit';
        const newId = randomUUID();
        const attachedCut = async (id: string, row?: BootstrapRow) => {
          const cut = await loadBootstrap('0:' + id, db, resolved.definition, row);
          const bootstrap = cut.bootstrap;
          // A conflict can return an earlier begun cut with an uncertain PIT.
          // Only the UUID inserted by THIS invocation may take the fresh path.
          if (mixed || snapshot !== 'pit' || id !== newId || cut.row.state !== 'begun' || cut.row.queried !== null)
            return { status: 'begun' as const, bootstrap, cost };
          freeze(bootstrap);
          const definitionPayload = registration.registeredDefinition;
          const transfer: FreshPitTransfer = (queried, previousWork, adoptedWork) => {
            const q = structuredClone(queried);
            return run({ deadline }, async (cost, store) => {
              if (
                q.snapshot.kind !== 'pit' ||
                q.snapshot.observation !== bootstrap.id ||
                !isDeepStrictEqual(q.consumer, bootstrap.consumer)
              )
                throw new BindingError('binding_mismatch');
              // The new UUID belongs to this invocation. Validate the current population and the
              // stored bytes from both owners before handing this exact physical receipt to its page.
              const result = await store.query({
                name: 'semantic_fresh_ranked_pit_handoff_v1',
                text: handoffServingPit,
                values: [
                  id,
                  registration.registration.id,
                  q.snapshot.observation,
                  Date.now(),
                  previousWork,
                  adoptedWork,
                  ports.search.encodeState(q),
                  ports.search.encodeState(bootstrap.covered),
                  encode(bootstrap.consumer),
                  bootstrap.definition.readDefinition,
                  cut.row.coverage_publication,
                  cut.row.coverage_generation,
                  bootstrap.definition.meaning.digest,
                  encode(bootstrap.definition.capture),
                  JSON.stringify(bootstrap.definition.dependencyKeys),
                  routeDigest,
                  bootstrap.definition.source.id,
                  bootstrap.definition.source.configuration,
                  bootstrap.consumer.physicalTarget,
                  ports.search.encodeConsumer(bootstrap.consumer),
                  definitionPayload,
                  bootstrap.consumer.incarnation,
                  [...PUBLIC_FILTER_CATALOGUE_TEXT_KEYS],
                ],
              });
              return { transferred: result.rowCount === 1, cost };
            });
          };
          return {
            status: 'begun' as const,
            bootstrap,
            cost,
            freshPit: {
              ...(independent
                ? { independent: true as const, ...(definitionPayload === undefined ? {} : { transfer }) }
                : {}),
              unopened(initialWork?: string) {
                // Recheck under the actual Search registration claim. A competing
                // opener can complete between cut insertion and claim acquisition.
                return run({ deadline }, async (cost, store) => {
                  if (independent) {
                    const opened = await store.query(
                      `/* semantic.native-keyed:5:12:1 */
                       UPDATE search.public_filter_pit_claim c SET state='opening',consumer_work=coalesce($7::text,c.consumer_work)
                       FROM semantic.public_filter_bootstrap b JOIN core.partition p USING(partition_no),
                         search.public_filter_registration r JOIN search.public_filter_target t USING(partition_no,physical_target)
                       WHERE (c.partition_no,c.registration,c.bootstrap)=(0,$1,$2)
                         AND (b.partition_no,b.bootstrap)=(c.partition_no,c.bootstrap) AND b.state='begun' AND b.queried IS NULL
                         AND b.coverage_publication IS NOT NULL AND b.snapshot_kind='pit' AND b.consumer=$3
                         AND p.epoch=b.owner_epoch AND p.write_state='active' AND c.state='new'
                         AND c.deadline>$4 AND (($7::text IS NOT NULL AND c.consumer_work IS NULL)
                           OR ($7::text IS NULL AND c.consumer_work IS NOT NULL))
                         AND (r.partition_no,r.id)=(c.partition_no,c.registration) AND r.state='active'
                         AND r.consumer=$5 AND t.incarnation=$6 RETURNING c.bootstrap`,
                      [
                        registration.registration.id,
                        id,
                        encode(bootstrap.consumer),
                        Date.now(),
                        ports.search.encodeConsumer(bootstrap.consumer),
                        bootstrap.consumer.incarnation,
                        initialWork ?? null,
                      ],
                    );
                    return { unopened: opened.rowCount === 1, cost };
                  }
                  const batch =
                    bookList &&
                    bookBindingStep(
                      'unopened',
                      binding,
                      bootstrap.consumer.physicalTarget,
                      id,
                      deadline,
                      {
                        id,
                        registration: registration.registration.id,
                        locator: bootstrap.id,
                        consumer: ports.search.encodeConsumer(bootstrap.consumer),
                        covered: ports.search.encodeState(bootstrap.covered),
                      },
                      async (members, until) => {
                        const result = await run({ deadline: until }, async (shared, db) => {
                          const rows = await db.query<{ id: string }>(
                            `/* semantic.native-keyed:${members.length * 4}:${members.length * 9} */
                           SELECT i.id FROM jsonb_to_recordset($1) i(id uuid,registration text,locator text,consumer text,covered text)
                           JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap)=(0,i.id)
                           JOIN core.partition p ON p.partition_no=b.partition_no AND p.write_state='active' AND p.epoch=b.owner_epoch
                           JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(b.partition_no,i.registration)
                           WHERE b.state='begun' AND b.queried IS NULL AND r.state='active' AND r.consumer_bootstrap=i.locator AND r.consumer=i.consumer
                             AND NOT EXISTS (SELECT 1 FROM search.public_filter_observation o WHERE (o.partition_no,o.registration)=(0,r.id)
                               AND o.state='open' AND o.prepared_build IS NULL AND md5(o.covered)=md5(i.covered) AND o.covered=i.covered)`,
                            [JSON.stringify(members)],
                          );
                          return { ids: new Set(rows.rows.map((r) => r.id)), cost: shared };
                        });
                        return members.map((m, i) => {
                          const cost = bookCostShare(result.cost, i, members.length);
                          return 'ids' in result ? { unopened: result.ids.has(m.id), cost } : { ...result, cost };
                        });
                      },
                    );
                  if (batch) return batch;
                  const result = await store.query(
                    `/* semantic.native-keyed:4:9 */
                    SELECT b.bootstrap FROM semantic.public_filter_bootstrap b
                    JOIN core.partition p ON p.partition_no=b.partition_no AND p.write_state='active' AND p.epoch=b.owner_epoch
                    JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(b.partition_no,$2)
                    WHERE (b.partition_no,b.bootstrap)=(0,$1) AND b.state='begun' AND b.queried IS NULL
                      AND r.state='active' AND r.consumer_bootstrap=$3 AND r.consumer=$4
                      AND NOT EXISTS (SELECT 1 FROM search.public_filter_observation o
                        WHERE (o.partition_no,o.registration)=(0,r.id) AND o.state='open' AND o.prepared_build IS NULL
                          AND md5(o.covered)=md5($5) AND o.covered=$5)`,
                    [
                      id,
                      registration.registration.id,
                      bootstrap.id,
                      ports.search.encodeConsumer(bootstrap.consumer),
                      ports.search.encodeState(bootstrap.covered),
                    ],
                  );
                  return { unopened: result.rowCount === 1, cost };
                });
              },
              adopt(queried: PublicFilterQueriedObservation) {
                const q = structuredClone(queried);
                return run({ deadline }, async (adoptionCost, store) => {
                  if (q.snapshot.kind !== 'pit' || !isDeepStrictEqual(q.consumer, bootstrap.consumer))
                    throw new BindingError('binding_mismatch');
                  const definitionPayload = registration.registeredDefinition;
                  const batch =
                    bookList &&
                    definitionPayload !== undefined &&
                    bookBindingStep(
                      'adopt',
                      binding,
                      JSON.stringify([q.consumer.physicalTarget, q.consumer.incarnation, q.consumer.meaningDigest]),
                      id,
                      deadline,
                      {
                        id,
                        registration: registration.registration.id,
                        definition: definitionPayload,
                        observation: q.snapshot.observation,
                        queried: ports.search.encodeState(q),
                        covered: ports.search.encodeState(bootstrap.covered),
                      },
                      async (members, until) => {
                        const result = await run({ deadline: until }, async (shared, db) => {
                          // Compare the retained custody bytes and install the Source adoption in the same statement.
                          const rows = await db.query<{ id: string }>(
                            `/* semantic.native-keyed:${members.length * 5 + 2}:${members.length * 11 + 2}:${members.length} */
                          WITH admitted AS MATERIALIZED (
                            SELECT i.* FROM jsonb_to_recordset($1) i(id uuid,registration text,definition text,observation text,queried text,covered text)
                            JOIN search.public_filter_observation o ON (o.partition_no,o.observation)=(0,i.observation)
                            JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(o.partition_no,o.registration)
                            JOIN search.public_filter_target t ON (t.partition_no,t.physical_target)=(r.partition_no,r.physical_target)
                            WHERE r.id=i.registration AND r.state='active' AND r.definition=i.definition AND r.physical_target=$2 AND t.incarnation=$3
                              AND o.state='open' AND o.queried=i.queried AND o.covered=i.covered AND o.expires_at>$4
                              AND (EXISTS (SELECT 1 FROM semantic.definition_release WHERE route=0 AND digest=$5)
                                OR EXISTS (SELECT 1 FROM semantic.release_composite WHERE digest=$5)))
                          UPDATE semantic.public_filter_bootstrap b SET state='adopted',queried=i.observation
                          FROM admitted i, core.partition p WHERE (b.partition_no,b.bootstrap)=(0,i.id)
                            AND p.partition_no=0 AND p.write_state='active' AND p.epoch=b.owner_epoch
                            AND (b.state='begun' OR (b.state='adopted' AND b.queried=i.observation)) RETURNING b.bootstrap AS id`,
                            [
                              JSON.stringify(members),
                              q.consumer.physicalTarget,
                              q.consumer.incarnation,
                              Date.now(),
                              q.consumer.meaningDigest,
                            ],
                          );
                          return { ids: new Set(rows.rows.map((r) => r.id)), cost: shared };
                        });
                        return members.map((m, i) => {
                          const cost = bookCostShare(result.cost, i, members.length);
                          return 'ids' in result ? { adopted: result.ids.has(m.id), cost } : { ...result, cost };
                        });
                      },
                    );
                  if (batch) {
                    const result = await batch;
                    addCost(adoptionCost, result.cost);
                    if ('reason' in result) return { ...result, cost: adoptionCost };
                    if (result.adopted)
                      return { status: 'adopted' as const, bootstrap, queried: q, cost: adoptionCost };
                    // Resolve a legacy payload or concurrent loss through the original custody error mapping.
                  }
                  const retained = await ports.search.readConsumerCustody(pool, { queried: q }, { deadline });
                  addCost(adoptionCost, retained.cost);
                  if (retained.status !== 'found') return { ...retained, cost: adoptionCost };
                  requireSameDefinition(bootstrap.definition, retained.definition);
                  if (
                    !isDeepStrictEqual(retained.queried, q) ||
                    !isDeepStrictEqual(q.consumer, bootstrap.consumer) ||
                    q.snapshot.kind !== 'pit' ||
                    !isDeepStrictEqual(retained.covered, bootstrap.covered)
                  )
                    throw new BindingError('binding_mismatch');
                  const [adopted] = await nativeSourceQuery(store, adoptBootstrap, {
                    bootstrap: id,
                    observation: q.snapshot.observation,
                  });
                  if (!adopted) throw new BindingError('binding_mismatch');
                  return { status: 'adopted' as const, bootstrap, queried: q, cost: adoptionCost };
                });
              },
            },
          };
        };
        const member = {
          bootstrap: newId,
          definition: resolved.definition.readDefinition,
          request_key: hash(encode({ consumer, snapshot })),
          consumer: encode(consumer),
        };
        const captureInputs = {
          target: consumer.physicalTarget,
          incarnation: consumer.incarnation,
          definition: member.definition,
          text_keys: [...PUBLIC_FILTER_CATALOGUE_TEXT_KEYS],
          owner_epoch: resolved.definition.source.epoch,
        };
        if (collect && bookList) {
          // The group can spend the full bounded withdrawal proof. A failed
          // or missing attachment remains charged and proceeds to ordinary recovery.
          if (inputLimit - cost.inputKeys < 210 + 2) throw new BindingError('owner_unavailable');
          const answer = Promise.withResolvers<BookCutReply>();
          collect({
            member,
            cost,
            answer,
            capture: (members) =>
              run({ deadline }, async (shared, store) => {
                try {
                  const rows = await nativeSourceQuery(store, captureBookWithdrawals, { ...captureInputs, members });
                  return {
                    rows: rows.map(({ definition, bootstrap, awaiting, retained }) => ({
                      definition,
                      bootstrap,
                      awaiting,
                      row: bootstrap ? (retained as BootstrapRow) : undefined,
                    })),
                    cost: shared,
                  };
                } catch {
                  return fail(Date.now() >= deadline ? 'deadline' : 'owner_unavailable', shared);
                }
              }),
          });
          const captured = await answer.promise;
          if (captured.bootstrap) return attachedCut(captured.bootstrap, captured.row);
          if (captured.awaiting) throw new BindingError('owner_unavailable');
        } else {
          const attached = await db.query<{ bootstrap: string }>({
            name: independent
              ? 'semantic_attach_request_pit_v1'
              : mixed
                ? 'semantic_attach_mixed_coverage_v1'
                : bookList
                  ? 'semantic_attach_book_coverage_v1'
                  : 'semantic_attach_subject_coverage_v1',
            text: `/* semantic.native-keyed:${independent ? '21:30:2' : bookList ? '36:52:1' : '18:24:1'} */
           WITH parent AS MATERIALIZED (
             SELECT * FROM ${coverage}
           ), cut AS MATERIALIZED (SELECT parent.*, ${withdrawals} AS withdrawals FROM parent)${independent ? ', attached AS (' : ''}
           INSERT INTO semantic.public_filter_bootstrap
             (partition_no,bootstrap,read_definition,request_key,consumer,snapshot_kind,native_snapshot,
              owner_epoch,source_position,state,coverage_generation,coverage_publication,book_withdrawals)
           SELECT 0,$5,$3,$6::text||':'||parent.job::text${bookList ? "||':'||parent.generation::text" : ''},$7,$8,pg_current_snapshot(),
                  p.epoch,p.position,'begun',parent.generation,parent.job,parent.withdrawals
           FROM cut parent JOIN core.partition p ON p.partition_no=0 AND p.write_state='active' AND p.epoch=$9
           WHERE NOT EXISTS (
             SELECT 1 FROM semantic.public_filter_effective_homes(parent.registration,parent.bootstrap,NULL,${bookList ? '9' : '1'}) h
               ${bookList ? 'WHERE semantic.public_filter_book_withdrawal_covers(h,parent.bootstrap,parent.withdrawals) IS NOT TRUE' : ''}
           ) AND NOT EXISTS (
             SELECT 1 FROM semantic.public_filter_privacy_pending k
             WHERE k.live AND k.input_key=ANY(parent.coverage_keys || $4::text[])
           ) AND NOT EXISTS (
             SELECT 1 FROM semantic.public_filter_privacy_head h WHERE h.population_fenced
           )
           ON CONFLICT(partition_no,request_key) WHERE state='begun' AND coverage_publication IS NOT NULL
           DO UPDATE SET request_key=EXCLUDED.request_key RETURNING bootstrap${
             independent
               ? `)
             INSERT INTO search.public_filter_pit_claim(partition_no,registration,bootstrap,deadline,target_prefix,retry_after)
             SELECT 0,$10,bootstrap,$11,regexp_replace($1,'subjects-g[1-9][0-9]*$',''),$11 FROM attached RETURNING bootstrap::text`
               : '::text'
           }`,
            values: [
              consumer.physicalTarget,
              consumer.incarnation,
              resolved.definition.readDefinition,
              mixed ? [] : [...PUBLIC_FILTER_CATALOGUE_TEXT_KEYS],
              newId,
              independent ? 'pit:' + newId : hash(encode({ consumer, snapshot })),
              encode(consumer),
              snapshot,
              resolved.definition.source.epoch,
              ...(independent
                ? [registration.registration.id, deadline]
                : mixed
                  ? [ports.search.encodeConsumer(consumer)]
                  : []),
            ],
          });
          if (attached.rows[0]) return attachedCut(attached.rows[0].bootstrap);
          if (bookList) {
            // Reserve the bounded visibility proof and the returned bootstrap before dispatch.
            if (inputLimit - cost.inputKeys < 210 + 2) throw new BindingError('owner_unavailable');
            const result = await nativeSourceQuery(db, captureBookWithdrawals, { ...captureInputs, members: [member] });
            const withdrawal = result[0];
            if (withdrawal?.bootstrap) return attachedCut(withdrawal.bootstrap, withdrawal.retained as BootstrapRow);
            if (withdrawal?.awaiting) throw new BindingError('owner_unavailable');
          }
        }
        if (mixed) {
          // A second read must not replace the baseline while its original repair
          // is scanning, verifying writers or acknowledging the receiver homes. The
          // adopted job owns its evidence after the preparation PIT expires.
          const pending = await db.query<{ bootstrap: string; complete: boolean }>(
            `/* semantic.native-keyed:9:12 */
             SELECT b.bootstrap::text,coalesce(seal.ready,false) AS complete FROM search.public_filter_coverage_home h
             JOIN search.public_filter_coverage_preparation c ON
               (c.partition_no,c.registration,c.bootstrap)=(h.partition_no,h.registration,h.baseline_bootstrap) AND c.ack_protocol=0
             JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap)=(0,h.baseline_bootstrap)
             JOIN search.public_filter_observation o ON (o.partition_no,o.observation)=(0,b.queried)
             LEFT JOIN LATERAL (
               SELECT true AS ready FROM semantic.public_filter_repair_step s
               WHERE (s.partition_no,s.bootstrap,s.execution)=(0,b.bootstrap,h.acknowledged_execution)
                 AND s.verified_root IS NOT NULL AND s.verified_next IS NULL AND s.complete AND s.ack_after=4096
             ) seal ON true
             WHERE (h.partition_no,h.registration,h.source_home)=(0,$1,0)
               AND b.state='adopted' AND b.consumer=$2 AND b.read_definition=$3 AND b.coverage_publication IS NULL
               AND o.registration=h.registration AND o.consumer_bootstrap='0:'||b.bootstrap::text
               AND o.state='open' AND o.consumer_work IS NOT NULL AND (seal.ready IS NULL
                 OR (seal.ready AND EXISTS (
                   SELECT 1 FROM search.discovery_generation g
                   WHERE g.partition_no=0 AND g.prefix=regexp_replace($4,'discovery-g[1-9][0-9]*$','')
                     AND g.prefix||'discovery-g'||g.generation::text=$4 AND g.index_uuid=$5
                     AND g.state IN ('populating','replaying','reconciling','ready')
                 )))`,
            [
              registration.registration.id,
              encode(consumer),
              resolved.definition.readDefinition,
              consumer.physicalTarget,
              consumer.incarnation,
            ],
          );
          // A completed preparation holds its original baseline through alias publication, even after its PIT expires.
          if (pending.rows[0]?.complete) throw new BindingError('owner_unavailable');
          if (pending.rows[0])
            return { status: 'repairing' as const, bootstrapId: '0:' + pending.rows[0].bootstrap, cost };
        }
      }
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
      const cut = existing ?? (await loadBootstrap('0:' + inserted.bootstrap, db, resolved.definition));
      let keyPageAdvanced = false;
      let committed: Awaited<ReturnType<typeof loadBootstrap>> | undefined;
      let readingCommitted = false;
      if (cut.row.state === 'capturing') {
        const baseline = {
          bootstrap: inserted.bootstrap,
          registration: registration.registration,
          definition: resolved.definition.readDefinition,
          consumer: ports.search.encodeConsumer(consumer),
          accounts: 'representation' in capture,
        };
        const catalogue = 'catalogueCoverage' in capture && capture.catalogueCoverage === true;
        const keys = publicFilterCoverageKeys(resolved.definition.dependencyKeys, catalogue);
        const compilerKeys = baseline.accounts ? [...keys, PUBLIC_FILTER_ACCOUNT_DOMAIN].sort() : keys;
        const grouped = baseline.accounts || catalogue ? ports.access.newAccountEnrollment : undefined;
        if (cut.row.account_after !== cut.row.coverage_after) throw new BindingError('owner_unavailable');
        try {
          if (cut.row.coverage_generation === null) await beginPublicFilterCoverageBaseline(db, baseline, deadline);
          const page = planPublicFilterEnrollment({
            inputBudget: Math.min(preparationInputLimit, inputLimit) - cost.inputKeys,
            keyCount: compilerKeys.length,
            homesLeft: 4096 - cut.row.account_after,
            ...(grouped ? { probeInputsPerHome: grouped.probeInputsPerHome } : {}),
          });
          const receipts: AccountDiscoveryEnrollment[] = [];
          const nativeInput = {
            bootstrap: inserted.bootstrap,
            registration: baseline.registration,
            readDefinition: baseline.definition,
            keys: compilerKeys,
            keyLimit: page.keyLimit,
            accounts: baseline.accounts,
          };
          const enrollment = (partition: number) =>
            ports.access.enrollAccountHome(db, { partition, ...nativeInput }, { deadline });
          let failure: PromiseRejectedResult | undefined;
          while (receipts.length < page.homes) {
            const start = cut.row.account_after + receipts.length;
            const remaining = page.homes - receipts.length;
            const count = Math.min(remaining, grouped?.groupSize ?? 3);
            const partitions = Array.from({ length: count }, (_, i) => start + i);
            const fresh =
              grouped && count > 1 && compilerKeys.length <= page.keyLimit
                ? await grouped.enroll(db, { ...nativeInput, partitions }, { deadline })
                : null;
            if (fresh) {
              receipts.push(...fresh);
              continue;
            }
            const batch: PromiseSettledResult<AccountDiscoveryEnrollment>[] = [];
            for (let offset = 0; offset < count; offset += 3) {
              const ready = await Promise.allSettled(partitions.slice(offset, offset + 3).map(enrollment));
              batch.push(...ready);
              if (ready.some((result) => result.status === 'rejected' || !result.value.complete)) break;
            }
            for (const result of batch) {
              if (result.status === 'rejected') {
                failure = result;
                break;
              }
              if (!result.value.complete) {
                keyPageAdvanced = true;
                break;
              }
              receipts.push(result.value);
            }
            if (receipts.length !== start - cut.row.account_after + count) break;
          }
          committed = await adoptPublicFilterCoverageBaselinePage(
            db,
            baseline,
            receipts,
            deadline,
            existing?.enrollmentRegistration
              ? async (client) => {
                  if (failure || receipts.length !== page.homes) return;
                  readingCommitted = true;
                  return loadBootstrap('0:' + inserted.bootstrap, client, resolved.definition);
                }
              : undefined,
          );
          if (failure) throw failure.reason;
        } catch (error) {
          if (readingCommitted || ports.access.classifyUnavailability(error) !== 'contention') throw error;
        }
      }
      const begun = committed ?? (await loadBootstrap('0:' + inserted.bootstrap, db, resolved.definition));
      if (begun.row.state === 'capturing')
        return {
          status: 'preparing' as const,
          bootstrap: begun.bootstrap,
          enrollmentAdvanced:
            begun.row.coverage_after > cut.row.coverage_after || (!existing?.receiptPageOnly && keyPageAdvanced),
          cost,
        };
      if (begun.row.state !== 'begun' || !begun.row.coverage_sealed || begun.row.coverage_after !== 4096)
        throw new BindingError('owner_unavailable');
      return { status: 'begun' as const, bootstrap: begun.bootstrap, cost };
    });
  }

  async function settleNative(
    request: Parameters<PublicFilterSourceBootstrapBinding['settle']>[0],
    context: PublicFilterConsumerContext,
    publicationCost?: BindingCost,
    mixedMaintenance = false,
  ) {
    const input = structuredClone(request),
      deadline = context.deadline;
    const joined = await joinNative({ queried: input.queried, execution: input.execution }, { deadline }, 'repair');
    if (joined.status !== 'joined') return joined;
    let ackAttempted = false;
    const result = await run({ deadline }, async (cost, db) => {
      addCost(cost, joined.cost);
      const cut = await loadBootstrap(input.bootstrap, db, joined.definition);
      if (
        cut.row.state !== 'adopted' ||
        cut.row.queried !== joined.queried.snapshot.observation ||
        encode(joined.covered) !== encode(cut.bootstrap.covered)
      )
        throw new BindingError('binding_mismatch');
      if (mixedMaintenance && !('representation' in cut.definition.capture)) throw new BindingError('binding_mismatch');
      const chain = repairChain(cut.bootstrap, joined);
      if (cut.row.ack_protocol === 1) {
        if (mixedMaintenance || !boundSubjectPublication(cut, input)) throw new BindingError('binding_mismatch');
        const terminal = await readPublicFilterRepairVerificationTip(db, chain);
        if (!terminal?.complete || terminal.next !== null || !terminal.root)
          throw new BindingError('owner_unavailable');
        const readback = async () => {
          if (publicationCost && publicationCost.inputKeys + cost.inputKeys + 100 > preparationInputLimit)
            throw new BindingError('owner_unavailable');
          const result = await adoptPublicFilterManifestAck(db, chain, terminal.step).catch((error) => {
            ackAttempted = true;
            throw error;
          });
          ackAttempted = result !== null;
          if (result?.advanced) cost.frontierWrites++;
          if (result && !result.advanced && result.after !== 4096) throw new BindingError('owner_unavailable');
          return result;
        };
        const original = await readback();
        if (original?.advanced) return { ...fail('owner_unavailable', cost), advanced: true as const };
        const spent = { ...cost };
        if (publicationCost) addCost(spent, publicationCost);
        // Reserve readback before Search starts; it has its own bounded native
        // winner proof and can return pending over several funded turns.
        spent.inputKeys += 100;
        spent.bytes += 32 * 1024;
        const settled = await ports.search.withRepairAllowance(
          spent,
          () =>
            ports.search.readRepairSettlement(
              pool,
              {
                queried: input.queried,
                execution: input.execution,
                ...(!original && { commitReceiverManifest: true as const }),
              },
              { deadline },
            ),
          true,
        );
        addCost(cost, settled.cost);
        if (settled.status !== 'settled') return { ...settled, cost };
        requireSameDefinition(cut.definition, settled.definition);
        if (
          !isDeepStrictEqual(settled.queried, joined.queried) ||
          !isDeepStrictEqual(settled.execution, joined.execution)
        )
          throw new BindingError('binding_mismatch');
        const committed = await readback();
        if (!committed || committed.settlement !== settled.settlement.id) throw new BindingError('owner_unavailable');
        return committed.advanced
          ? { ...fail('owner_unavailable', cost), advanced: true as const }
          : { ...joined, terminal: { step: terminal.step, root: terminal.root }, settlement: settled.settlement, cost };
      }
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
      const windows: PublicFilterCreationWindow[] = [];
      const batched = publicationCost !== undefined && original?.windowBatch !== undefined;
      // After the first authority read the remaining ACK work is one more
      // authority read (9 keys/home), receiver ACK (10/home + 7), and the
      // terminal prefix update with its trigger (9/home + 7).
      const ackKeys = (homes: number) => 14 + 28 * homes;
      const ackBytes = (homes: number) => 48 * 1024 + 8 * 1024 * homes;
      if (original?.windowBatch) {
        if (original.input.phase !== 'window') throw new BindingError('binding_mismatch');
        const batch = original.windowBatch;
        const available = preparationInputLimit - (publicationCost?.inputKeys ?? 0) - cost.inputKeys;
        const cap = batched
          ? Math.min(PUBLIC_FILTER_REPAIR_ACK_BATCH_LIMIT, Math.max(1, Math.floor((available - ackKeys(1)) / 9)))
          : 1;
        const end = Math.min(4096, seal.home + cap);
        const append = (retained: NonNullable<RepairRecord['windowBatch']>) => {
          const start = seal.home + windows.length;
          for (let home = start; home < Math.min(end, retained.from + retained.count); home++) {
            const window = creationWindowFromBatch(retained, home);
            if (!window) throw new BindingError('owner_unavailable');
            windows.push(window);
          }
        };
        append(batch);
        if (windows.length === 0) throw new BindingError('owner_unavailable');
        // Use the remainder of this ACK page when the next independently
        // verified compact range starts exactly where the current one ends.
        const next = seal.home + windows.length;
        if (next < end) {
          for (const row of await readPublicFilterRepairHomeBatches(db, chain, seal.terminal, next, end)) {
            const original = decode<RepairRecord>(row.state);
            if (
              row.home !== seal.home + windows.length ||
              original.input.phase !== 'window' ||
              original.windowBatch?.from !== row.home
            )
              break;
            append(original.windowBatch);
          }
        }
      } else if (original) {
        const window = closedCreationBridge(original);
        if (!window || window.partition !== seal.home) throw new BindingError('binding_mismatch');
        windows.push(window);
      }
      const verify = async () => {
        if (original?.windowBatch) return; // The authority read checks every retained verified window.
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
      // The completed seal has no open window. Its current terminal verification
      // follows Search's independent settlement on this same allowance.
      if (!publicationCost || seal.after !== 4096) await verify();
      const authority = async (range: readonly PublicFilterCreationWindow[]) => {
        if (!range.length) return [];
        // Drive each authority lookup from its retained window, including on a
        // cold database where joins can otherwise scan a whole relation.
        // Reserve each of the six native relation points even when a check fails.
        const { rows } = await db.query<
          PublicFilterRepairHome & {
            registration: string;
            registration_partition: number;
            current_position: string;
            current_revision: string;
            current_claim: string;
          }
        >(
          `/* semantic.native-keyed:${6 * range.length}:${9 * range.length} */
             SELECT live.*
             FROM jsonb_to_recordset($1::jsonb) AS x(home integer,epoch integer,receipt text,base bigint,through bigint)
             CROSS JOIN LATERAL (
               SELECT e.partition_no AS home,e.registration,e.registration_partition,e.owner_epoch AS epoch,
                 e.receipt,e.source_position::text,e.native_enqueue_revision::text AS enqueue,
                 e.native_revision::text AS revision,e.native_claim_revision::text AS claim_revision,
                 h.position::text AS current_position,
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
               WHERE (e.partition_no,e.bootstrap)=(x.home,$2)
                 AND e.complete AND e.receipt=x.receipt AND e.creation_position=x.base
                 AND e.creation_consumer=$3 AND e.read_definition=$4
                 AND p.position>=x.through
                 AND p.write_state='active' AND p.epoch=e.owner_epoch AND p.epoch=x.epoch
                 AND h.owner_epoch=p.epoch AND h.position>=e.source_position
                 AND c.position<=e.creation_position AND (c.epoch IS NULL OR c.epoch=p.epoch)
                 AND b.state='adopted' AND b.coverage_sealed AND b.coverage_after=4096
               OFFSET 0
             ) live
             ORDER BY live.home`,
          [
            JSON.stringify(
              range.map(({ partition, epoch, receipt, base, through }) => ({
                home: partition,
                epoch,
                receipt,
                base: String(base),
                through: String(through),
              })),
            ),
            chain.bootstrap,
            publicFilterCreationConsumer(chain.bootstrap),
            joined.definition.readDefinition,
          ],
        );
        return rows;
      };
      const before = await authority(windows);
      const gap = windows.findIndex((window, index) => before[index]?.home !== window.partition);
      let count = gap === -1 ? windows.length : gap;
      if (windows.length > 0 && count === 0) throw new BindingError('configuration_changed');
      if (batched) cost.candidates += before.length;
      const readSettlement = () =>
        ports.search.readRepairSettlement(pool, { queried: input.queried, execution: input.execution }, { deadline });
      const spent = publicationCost ? { ...publicationCost } : undefined;
      if (spent) {
        addCost(spent, cost);
        if (batched) {
          // Leave room for at least one fully measured ACK after Search's proof.
          spent.inputKeys += ackKeys(1);
          spent.bytes += ackBytes(1);
        }
      }
      const settled = await (spent ? ports.search.withRepairAllowance(spent, readSettlement, true) : readSettlement());
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
      if (batched && publicationCost) {
        const remaining = preparationInputLimit - publicationCost.inputKeys - cost.inputKeys;
        const bytes = 4 * 1024 * 1024 - publicationCost.bytes - cost.bytes;
        count = Math.min(count, Math.floor((remaining - 14) / 28), Math.floor((bytes - ackBytes(0)) / (8 * 1024)));
        if (count < 1) throw new BindingError('owner_unavailable');
      }
      const range = windows.slice(0, count);
      // Both reads require the live log to cover the captured window. A later
      // unrelated command may advance its tail while Search verifies settlement.
      const current = await authority(range);
      const changed = range.findIndex((_, index) => !isDeepStrictEqual(before[index], current[index]));
      const after = changed === -1 ? current : current.slice(0, changed);
      if (count > 0 && after.length === 0) throw new BindingError('configuration_changed');
      if (after.length) {
        if (
          batched &&
          publicationCost &&
          (publicationCost.inputKeys + cost.inputKeys + 14 + 19 * after.length > preparationInputLimit ||
            publicationCost.bytes + cost.bytes + 32 * 1024 + 4 * 1024 * after.length > 4 * 1024 * 1024)
        )
          throw new BindingError('owner_unavailable');
        const first = after[0]!;
        if (
          after.some(
            (home) =>
              home.registration !== first.registration || home.registration_partition !== first.registration_partition,
          )
        )
          throw new BindingError('binding_mismatch');
        const baseline: PublicFilterRepairBaseline = {
          bootstrap: nativeId(input.bootstrap),
          registration: first.registration,
          registrationPartition: first.registration_partition,
          observation: settled.queried.snapshot.observation,
          execution: settled.execution.id,
          settlement: settled.settlement.id,
          consumer: ports.search.encodeConsumer(settled.queried.consumer),
          physicalTarget: settled.queried.consumer.physicalTarget,
          incarnation: settled.queried.consumer.incarnation,
        };
        ackAttempted = publicationCost !== undefined;
        await acknowledgePublicFilterRepairBaseline(
          db,
          baseline,
          after.map(({ home, epoch, receipt, source_position, enqueue, revision, claim_revision }) => ({
            home,
            epoch,
            receipt,
            source_position,
            enqueue,
            revision,
            claim_revision,
          })),
          deadline,
        );
        // The Source frontier is adopted only after the actual registration
        // ACK commit. A crash before this CAS repeats that same prefix safely.
        cost.frontierWrites++;
        if (!(await advancePublicFilterRepairAckFrontier(db, chain, seal.terminal, seal.home, after.length)))
          throw new BindingError('owner_unavailable');
        bookPreparationTiming?.mark('ackAdvanced', seal.home + after.length);
        // The next turn funds the original population-start and publication-fence proofs.
        if (publicationCost || seal.home + after.length < 4096)
          return { ...fail('owner_unavailable', cost), advanced: true as const };
      }
      return {
        ...joined,
        terminal: { step: seal.terminal, root: seal.root },
        settlement: settled.settlement,
        cost,
      };
    });
    // An uncertain receiver commit or frontier reply resumes settlement of the same terminal.
    return ackAttempted && result.status !== 'joined' && !('advanced' in result)
      ? { ...result, ackAttempted: true as const }
      : result;
  }

  function boundSubjectPublication(
    cut: Awaited<ReturnType<typeof loadBootstrap>>,
    input: { execution: string; queried: PublicFilterQueriedObservation },
  ) {
    return (
      !('representation' in cut.definition.capture) &&
      cut.row.publication_job === input.execution &&
      cut.row.publication_execution === input.execution &&
      cut.row.publication_observation === input.queried.snapshot.observation
    );
  }

  type RepairReadScope = {
    input: Omit<NativeSourceRepairStepRead, 'predecessor'>;
    deadline: number;
    joined?: Extract<Awaited<ReturnType<typeof joinNativeCut>>, { status: 'joined' }>;
    accounts?: { ids: readonly string[]; observations?: ReadonlyMap<string, AccountDiscoveryRepairObservation> };
  };
  const repairReadBatch = new AsyncLocalStorage<RepairReadScope>();
  async function beginBookPages(requests: readonly NativeBookPreparation[], context: PublicFilterConsumerContext) {
    if (requests.length < 1 || requests.length > MAX_PAGE_READS) throw new RangeError('Invalid Book capture width');
    const inputs = requests.map(({ source, definition, ...plan }) => ({
      ...structuredClone(plan),
      source,
      definition,
    }));
    const waits = inputs.map(() => Promise.withResolvers<BookCutGroup | undefined>());
    const first = inputs[0]!;
    const scope = (v: NativeBookPreparation) => [
      v.consumer.physicalTarget,
      v.consumer.incarnation,
      v.definition.source,
      v.definition.meaning.digest,
      v.definition.dependencyKeys,
    ];
    if (
      inputs.some(
        (v) =>
          !resolvedDefinitions.has(v.definition) ||
          v.snapshot !== 'pit' ||
          !('bookTypeList' in v.capture) ||
          v.capture.bookTypeList !== true ||
          !isDeepStrictEqual(scope(v), scope(first)),
      )
    )
      throw new TypeError('Incompatible Book captures');
    if (inputs.length === 1)
      return [await beginRetained(first, context, undefined, first.inputLimit, true, first.definition)];
    const registrations = await ports.search.readBookRegistrations?.(pool, inputs, context);
    const begun: Promise<NativePublicFilterPreparation>[] = [];
    let next = 0;
    // A parked member owns no checkout. Bound the registration and final cut loads on either side of the group.
    async function prepare() {
      while (next < inputs.length) {
        const i = next++,
          v = inputs[i]!;
        begun[i] = beginRetained(
          v,
          context,
          undefined,
          v.inputLimit,
          true,
          v.definition,
          waits[i]!.resolve,
          registrations?.[i],
        ).finally(() => waits[i]!.resolve(undefined));
        void begun[i]!.catch(() => {});
        await waits[i]!.promise;
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, inputs.length) }, prepare));
    const byMember = await Promise.all(waits.map((w) => w.promise));
    const group = byMember.filter((w) => w !== undefined);
    if (group.length) {
      try {
        if (new Set(group.map((v) => v.member.definition)).size !== group.length)
          throw new TypeError('Duplicate Book capture definition');
        const result = await group[0]!.capture(group.map((v) => v.member));
        // The SQL reservation includes the first cut. Attribute one cut to
        // each plan, then split only the common proof and wire envelope.
        const common = publicFilterBindingCost();
        addCost(common, result.cost);
        const dispatched = common.statements > 0;
        if (dispatched) {
          common.resultWrites--;
          common.rows -= 2;
          common.dependencyPoints -= 2;
          common.inputKeys -= 4;
        }
        group.forEach((item, position) => {
          for (const key of Object.keys(common) as (keyof BindingCost)[])
            item.cost[key] += Math.floor((common[key] + position) / group.length);
          if (dispatched) {
            item.cost.resultWrites++;
            item.cost.rows += 2;
            item.cost.dependencyPoints += 2;
            item.cost.inputKeys += 4;
          }
        });
        if (!('rows' in result)) throw new BindingError(result.reason);
        const byDefinition = new Map(result.rows.map((row) => [row.definition, row]));
        if (byDefinition.size !== group.length || group.some((v) => !byDefinition.has(v.member.definition)))
          throw new BindingError('binding_mismatch');
        let position = 0;
        async function attach() {
          while (position < byMember.length) {
            const index = position++,
              member = byMember[index];
            if (member) {
              member.answer.resolve(byDefinition.get(member.member.definition)!);
              await begun[index]!.catch(() => {});
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(4, group.length) }, attach));
      } catch (error) {
        for (const v of group) v.answer.reject(error);
      }
    }
    return Promise.all(begun);
  }
  const bootstrapBinding: PublicFilterSourceBootstrapBinding = {
    ...binding,
    async readRepairStep(request, context) {
      const input = structuredClone(request),
        deadline = context.deadline;
      const observer = bookPreparationTiming;
      const pending = run({ deadline }, async (cost, db) => {
        if (
          !input.bootstrap.startsWith('0:') ||
          !input.execution ||
          input.execution.length > 4096 ||
          (input.predecessor !== null && !uuid.test(input.predecessor))
        )
          throw new BindingError('binding_mismatch');
        const bootstrapId = nativeId(input.bootstrap);
        const batch = repairReadBatch.getStore();
        const scope =
          batch?.deadline === deadline &&
          batch.input.bootstrap === input.bootstrap &&
          batch.input.execution === input.execution &&
          isDeepStrictEqual(batch.input.queried, input.queried)
            ? batch
            : undefined;
        const reused = scope?.joined;
        const joined =
          reused ??
          (await joinNativeCut({ queried: input.queried, execution: input.execution }, { deadline }, 'repair'));
        if (!reused) addCost(cost, joined.cost);
        if (joined.status !== 'joined') return { ...joined, cost };
        const { cut } = joined;
        if (
          cut.bootstrap.id !== input.bootstrap ||
          cut.row.state !== 'adopted' ||
          cut.row.queried !== joined.queried.snapshot.observation ||
          encode(cut.bootstrap.covered) !== encode(joined.covered)
        )
          throw new BindingError('binding_mismatch');
        if (scope) scope.joined = joined;
        const chain = repairChain(cut.bootstrap, joined);
        const originalSubject = boundSubjectPublication(cut, input);
        const keys = {
          bootstrap: bootstrapId,
          execution: input.execution,
          predecessor: input.predecessor ?? '',
        };
        // Settlement reopens a durable verification prefix. Resolve its original
        // page, predecessor and native link together before rechecking live evidence.
        const proof = scope ? await nativeSourceQuery(db, repairProof, { ...keys, binding: chain.binding }) : null;
        const link =
          !scope && originalSubject
            ? await nativeSourceQuery(db, repairLink, { ...keys, binding: chain.binding })
            : null;
        const row = scope ? proof : (link ?? (await nativeSourceQuery(db, repairRead, keys)));
        if (
          !row ||
          row.step === null ||
          row.state === null ||
          row.complete === null ||
          row.receipt_protocol !== 1 ||
          row.input_limit === null ||
          row.predecessor !== input.predecessor
        )
          throw new BindingError('owner_unavailable');
        const step = row.step;
        const record = decode<RepairRecord>(row.state);
        const receiptDigests = unpackRepairLocatorDigests(row.repair_locator_digests, row.input_limit);
        // Resolve the actual native predecessor, not an asserted matching cursor.
        // Its immutable successor binds the next input even on a crash/replay.
        if (input.predecessor !== null) {
          let predecessorState = proof?.predecessor_state ?? link?.predecessor_state;
          if (link) {
            if (link.predecessor_complete !== false || link.predecessor_protocol !== 1)
              throw new BindingError('binding_mismatch');
          } else if (!proof) {
            const predecessor = await nativeSourceQuery(db, repairState, {
              bootstrap: bootstrapId,
              execution: input.execution,
              step: input.predecessor,
            });
            if (!predecessor || predecessor.complete || predecessor.receipt_protocol !== 1)
              throw new BindingError('binding_mismatch');
            predecessorState = predecessor.state;
          }
          if (!predecessorState || encode(decode<RepairRecord>(predecessorState).next) !== encode(record.input))
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
          record.input.bridgeThrough !== undefined ||
          record.input.resumeAccountScan !== undefined
        ) {
          throw new BindingError('binding_mismatch');
        }
        if (!uuid.test(step) || !uuid.test(record.input.advance)) throw new BindingError('binding_mismatch');
        const subjectPublication = originalSubject && record.account === undefined;
        if (
          input.scanOnly &&
          (!subjectPublication ||
            input.predecessor === null ||
            row.complete ||
            !subjectHomeScan(record.input) ||
            record.scan?.kind !== 'semantic' ||
            row.input_limit > repairHomeBatchLimit ||
            record.output !== null ||
            receiptDigests.length !== 0)
        )
          throw new BindingError('owner_unavailable');
        let repairs: PublicSourceRepair[] = [];
        let expected: RepairState | undefined;
        let expectedScan: RepairRecord['scan'];
        let expectedWindowBatch: RepairRecord['windowBatch'];
        let expectedBridgeEvents: RepairRecord['bridgeEvents'];
        let subject: SubjectRepairWriterObligation | undefined;
        if (row.complete) {
          if (
            !terminalRepairState(record.input) ||
            input.predecessor === null ||
            record.output !== null ||
            record.account !== undefined ||
            receiptDigests.length !== 0 ||
            (!proof && !(await readPublicFilterRepairVerification(db, chain, input.predecessor)))
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
              meaning: { digest: cut.definition.meaning.digest },
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
                meaning: { digest: cut.definition.meaning.digest },
              },
              { deadline },
            ))
          )
            throw new BindingError('owner_unavailable');
          await currentRepairHome(input.bootstrap, input.execution, record.input, page.source, db);
          // Every locator shares this verified page and its currentness checks.
          repairs = page.repairLocators.map((locator) =>
            producedRepair(input.bootstrap, input.execution, step, page, locator),
          );
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
            !('representation' in cut.definition.capture) ||
            record.input.owner !== 'accounts' ||
            record.input.phase !== 'account' ||
            record.input.subject !== record.account.id ||
            receiptDigests.length !== 0
          )
            throw new BindingError('binding_mismatch');
          let current: AccountDiscoveryRepairObservation | undefined;
          if (scope?.accounts?.ids.includes(record.account.id)) {
            const batch = scope.accounts;
            batch.observations ??= await ports.access.readAccountRepairs(db, batch.ids, { deadline });
            current = batch.observations.get(record.account.id);
          } else current = await ports.access.readAccountRepair(db, record.account.id, { deadline });
          if (
            !current ||
            !(proof
              ? retainedAccountDiscoveryRepairCurrent(record.account, current)
              : isDeepStrictEqual({ ...current, position: record.account.position }, record.account)) ||
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
            const accounts = 'representation' in cut.definition.capture;
            if (record.windowBatch.through !== undefined && !accounts && !boundSubjectPublication(cut, input))
              throw new BindingError('binding_mismatch');
            const scanned =
              record.windowBatch.through === undefined
                ? await scanCreationWindows(input.bootstrap, record.input, row.input_limit, db, cost, record)
                : await scanIrrelevantCreationPrefix(
                    input.bootstrap,
                    record.input,
                    row.input_limit,
                    db,
                    { deadline },
                    cost,
                    accounts,
                    record.windowBatch,
                  );
            if (!scanned) throw new BindingError('owner_unavailable');
            expected = scanned.next;
            expectedWindowBatch = scanned.batch;
          } else {
            if (
              record.bridgeEvents !== undefined &&
              !subjectPublication &&
              !('representation' in cut.definition.capture)
            )
              throw new BindingError('binding_mismatch');
            const bridge = await advanceCreationBridge(
              input.bootstrap,
              record.input,
              db,
              { deadline },
              'representation' in cut.definition.capture,
              cost,
              { inputLimit: row.input_limit, batch: false, subjectRange: subjectPublication, retained: record },
            );
            expected = bridge.next;
            expectedBridgeEvents = bridge.receipt;
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
            (record.input.bridgeThrough !== undefined && record.next.version < record.input.bridgeThrough) ||
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
          if (record.input.bridgeThrough !== undefined) {
            if (!subjectPublication || !record.input.resumeBridge) throw new BindingError('binding_mismatch');
            subject = {
              subject: record.input.subject!,
              partition: record.input.partition,
              epoch: owner.epoch,
              position: record.input.bridgeThrough,
            };
          }
        }
        if (
          !expected ||
          encode(expected) !== encode(record.next) ||
          encode(expectedScan ?? null) !== encode(record.scan ?? null) ||
          encode(expectedWindowBatch ?? null) !== encode(record.windowBatch ?? null) ||
          encode(expectedBridgeEvents ?? null) !== encode(record.bridgeEvents ?? null)
        )
          throw new BindingError('binding_mismatch');
        const current = await loadBootstrap(input.bootstrap, db, cut.definition);
        if (
          current.row.state !== 'adopted' ||
          current.row.queried !== cut.row.queried ||
          !isDeepStrictEqual(current.definition, cut.definition)
        )
          throw new BindingError('configuration_changed');
        const closedWindow = closedCreationBridge(record);
        const closedHome =
          closedWindow?.partition ??
          (record.input.phase === 'window' && record.windowBatch && record.windowBatch.count > 0
            ? record.windowBatch.from
            : undefined);
        const page = {
          step,
          predecessor: row.predecessor,
          state: row.state,
          complete: row.complete,
          inputLimit: row.input_limit,
          digests: row.repair_locator_digests!,
          ...(closedHome === undefined ? {} : { closedHome }),
        };
        if (proof) {
          if (
            (closedHome !== undefined && proof.verified_home !== closedHome) ||
            proof.verified_root !== publicFilterRepairPageRoot(proof.predecessor_root ?? chain.binding, page)
          )
            throw new BindingError('binding_mismatch');
        } else {
          const alreadyVerified =
            link?.linked === true && !row.complete && subjectHomeScan(record.input) && record.scan?.kind === 'semantic';
          await retainPublicFilterRepairVerification(
            db,
            chain,
            { ...page, alreadyVerified },
            { deadline },
            (controls) => {
              cost.rows += controls.rows;
              cost.dependencyPoints += controls.rows;
              cost.inputKeys += controls.keys;
              cost.bytes += controls.bytes;
              cost.frontierWrites += controls.frontierWrites ?? 0;
            },
          );
        }
        const result = {
          status: 'verified' as const,
          step,
          predecessor: row.predecessor,
          frontier: row.complete ? null : step,
          complete: row.complete,
          receipts: receiptDigests.map((locatorDigest) => ({
            bootstrap: input.bootstrap,
            execution: input.execution,
            step,
            locatorDigest,
          })),
          cost,
        };
        if (repairs.length === receiptDigests.length)
          publicFilterRepairEvidence.set(result, {
            binding: bootstrapBinding,
            evidence: {
              repairs,
              account: record.account ?? null,
              ...(subject ? { subject } : {}),
              ...(!scope && subjectPublication && record.scan?.kind === 'semantic' && subjectHomeScan(record.next)
                ? {
                    nextScan: {
                      // Two full home reads, two exact custody joins, and keyed
                      // predecessor, intent, proof, checkpoint and release work.
                      inputKeys: 2 * repairHomeBatchLimit + 2 * joined.cost.inputKeys + 128,
                      // The same immutable join bodies can be read twice. Also
                      // cover the live bootstrap probes and two bounded scan
                      // results, state records, SQL and Search control traffic.
                      bytes: 4 * joined.cost.bytes + 128 * 1024,
                    },
                  }
                : {}),
            },
          });
        return result;
      });
      if (!observer) return pending;
      const identity = {
        observation: input.queried.snapshot.observation,
        execution: input.execution,
        predecessor: input.predecessor,
      };
      return pending.then(
        (result) => {
          if (result.status !== 'verified')
            observer.repairStepRefusal({ ...identity, status: result.status, reason: result.reason });
          return result;
        },
        (error) => {
          observer.repairStepRefusal({ ...identity, status: 'exception' });
          throw error;
        },
      );
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
        const joined = await joinNative({ queried, execution }, { deadline }, 'repair');
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
            meaning: { digest: cut.definition.meaning.digest },
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
              meaning: { digest: cut.definition.meaning.digest },
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
          !isDeepStrictEqual(current.definition, cut.definition)
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
      return result.status === 'preparing' || result.status === 'repairing'
        ? fail('owner_unavailable', result.cost)
        : result;
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
    async fenceExpiredRegistration({ bootstrap, registration, work }, context) {
      return run(context, async (cost, db) => {
        const retained = decode<{
          registration: { partition: number; id: string };
          bootstrap: { id: string };
          adopted: boolean;
          queried: PublicFilterQueriedObservation | null;
          materializing: PublicFilterQueriedObservation | null;
        }>(work);
        const q = retained.queried;
        const pit = retained.materializing;
        if (
          !q ||
          retained.adopted ||
          retained.registration.partition !== 0 ||
          retained.registration.id !== registration ||
          retained.bootstrap.id !== bootstrap ||
          (q.snapshot.kind === 'prepared' && (q.snapshot.build !== bootstrap || q.snapshot.generation !== 1n)) ||
          (pit && (pit.snapshot.kind !== 'pit' || !isDeepStrictEqual(pit.consumer, q.consumer)))
        )
          throw new BindingError('binding_mismatch');
        // Lock the original claim and expired observation. A competing adoption updates the same
        // Source row. After this barrier it cannot publish the cut, even if Search closes in another process.
        const row = await db.query(
          `/* semantic.native-keyed:7:15:1 */
           WITH claim AS MATERIALIZED (
             SELECT b.bootstrap FROM semantic.public_filter_bootstrap b
             JOIN core.partition p ON p.partition_no=b.partition_no AND p.epoch=b.owner_epoch AND p.write_state='active'
             JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(b.partition_no,$2)
             JOIN search.public_filter_observation o ON (o.partition_no,o.registration,o.observation)=(r.partition_no,r.id,$5)
             WHERE (b.partition_no,b.bootstrap)=(0,$1) AND b.state IN ('begun','aborting') AND b.queried IS NULL
               AND b.publication_job IS NULL AND b.coverage_publication IS NOT NULL AND b.consumer=$8 AND b.snapshot_kind=$9
               AND r.state='active' AND r.consumer_bootstrap=$3 AND r.consumer_work=$4
               AND o.queried=$6 AND o.covered=$7 AND o.expires_at<=$10 AND o.consumer_work IS NULL
               AND ($11::text IS NULL OR EXISTS (
                 SELECT FROM search.public_filter_observation m
                 WHERE (m.partition_no,m.registration,m.observation)=(r.partition_no,r.id,$11)
                   AND m.covered=o.covered AND m.queried=$12 AND m.consumer_work IS NULL
                   AND (m.state='closed' OR m.expires_at<=$10)))
             FOR UPDATE OF b,r,o
           ) UPDATE semantic.public_filter_bootstrap b SET state='aborting' FROM claim
             WHERE (b.partition_no,b.bootstrap)=(0,claim.bootstrap) RETURNING b.bootstrap`,
          [
            nativeId(bootstrap),
            registration,
            bootstrap,
            work,
            q.snapshot.observation,
            ports.search.encodeState(q),
            ports.search.encodeState({ observation: bootstrap }),
            encode(q.consumer),
            q.snapshot.kind,
            Date.now(),
            pit?.snapshot.observation ?? null,
            pit ? ports.search.encodeState(pit) : null,
          ],
        );
        return { status: row.rowCount === 1 ? ('fenced' as const) : ('pending' as const), cost };
      });
    },
    async releaseAdoptedRegistration(request, context) {
      const { bootstrap, registration, observation, work } = request;
      return run({ deadline: context.deadline }, async (cost, db) => {
        const id = nativeId(bootstrap);
        const previous = decode<{
          registration: { partition: number; id: string };
          bootstrap: { id: string };
          queried: PublicFilterQueriedObservation | null;
          adopted: boolean;
          materializing?: unknown;
          execution?: unknown;
          dispatch?: unknown;
          frontier?: unknown;
          repair?: unknown;
          repairPage?: unknown;
          records?: readonly unknown[];
          projectionSource?: unknown;
          rounds?: number;
          charged?: number;
        }>(work);
        if (
          previous.registration.partition !== 0 ||
          previous.registration.id !== registration ||
          previous.bootstrap.id !== bootstrap ||
          previous.queried?.snapshot.observation !== observation
        )
          throw new BindingError('binding_mismatch');
        // The independent observation may already have consumed a page. Never overwrite it.
        // An expired, unclaimed observation still owns the exact adopted work and its erasure locator.
        const result = await db.query(
          `/* semantic.native-keyed:8:12:2 */
           WITH claimed AS MATERIALIZED (
             SELECT r.partition_no,r.id,o.state,o.expires_at,o.consumer_work,o.consumer_bootstrap
             FROM semantic.public_filter_bootstrap b
             JOIN core.partition p ON p.partition_no=b.partition_no AND p.epoch=b.owner_epoch AND p.write_state='active'
             JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(b.partition_no,$2)
             JOIN search.public_filter_observation o ON (o.partition_no,o.observation)=(r.partition_no,b.queried)
             WHERE (b.partition_no,b.bootstrap)=(0,$1) AND b.queried=$3 AND b.state='adopted'
               AND b.coverage_publication IS NOT NULL AND b.publication_job IS NULL AND b.consumer=$8
               AND r.state='active' AND r.consumer_bootstrap=$4 AND r.consumer_work=$5 AND o.registration=r.id
             FOR UPDATE OF r,o
           ), moved AS (
             UPDATE search.public_filter_observation o SET consumer_bootstrap=$4,consumer_work=$6
             FROM claimed c WHERE (o.partition_no,o.registration,o.observation)=(c.partition_no,c.id,$3)
               AND c.state='open' AND c.expires_at<=$7 AND c.consumer_work IS NULL AND c.consumer_bootstrap IS NULL
             RETURNING o.registration
           )
           UPDATE search.public_filter_registration r SET consumer_bootstrap=NULL,consumer_work=NULL
           FROM claimed c WHERE (r.partition_no,r.id)=(c.partition_no,c.id) AND
             ((c.consumer_bootstrap=$4 AND c.consumer_work IS NOT NULL) OR EXISTS (SELECT FROM moved)
               OR (c.state='closed' AND c.consumer_work IS NULL AND c.consumer_bootstrap IS NULL))
           RETURNING (SELECT count(*)::integer FROM moved) AS transferred`,
          [
            id,
            registration,
            observation,
            bootstrap,
            work,
            previous.adopted ? work : encode({ ...previous, adopted: true }),
            Date.now(),
            encode(previous.queried.consumer),
          ],
        );
        if (result.rowCount === 1) {
          cost.frontierWrites += 1 + Number(result.rows[0]!.transferred);
          return { status: 'released' as const, cost };
        }
        if (
          previous.adopted !== false ||
          previous.queried.snapshot.kind !== 'pit' ||
          previous.materializing != null ||
          previous.execution != null ||
          previous.dispatch != null ||
          previous.frontier != null ||
          previous.repair != null ||
          previous.repairPage != null ||
          previous.projectionSource != null ||
          previous.records?.length ||
          previous.rounds ||
          previous.charged
        )
          return { status: 'pending' as const, cost };
        // Two interrupted openers can leave different physical PITs on the same original cut.
        // Retire both expired, unclaimed observations under their own native IDs before clearing the registration.
        const split = await db.query<{ closing: string[]; writes: number; released: boolean }>(
          retireSplitObservations,
          [
            id,
            registration,
            observation,
            bootstrap,
            work,
            ports.search.encodeState(previous.queried),
            encode(previous.queried.consumer),
            ports.search.encodeState({ observation: bootstrap }),
            Date.now(),
            ports.search.encodeConsumer(previous.queried.consumer),
            previous.queried.consumer.incarnation,
          ],
        );
        const retired = split.rows[0];
        if (!retired) return { status: 'pending' as const, cost };
        cost.frontierWrites += retired.writes + Number(retired.released);
        if (retired.released) return { status: 'released' as const, cost };
        return {
          status: 'closing' as const,
          observations: retired.closing.map((value) => ports.search.decodeState<PublicFilterQueriedObservation>(value)),
          cost,
        };
      });
    },
    async abort(request, context) {
      const id = request.bootstrap;
      return run(context, async (cost, db) => {
        const cut = await loadBootstrap(id, db);
        if (request.closedPreparation) {
          // Release this exact unadopted request and its registration in one commit.
          // A replacement has its own build UUID and cannot consume old segments.
          const closed = request.closedPreparation;
          const work = decode<{
            bootstrap: { id: string };
            registration: { id: string };
            adopted: boolean;
            queried: PublicFilterQueriedObservation | null;
            materializing: PublicFilterQueriedObservation | null;
          }>(closed.work);
          const original = work.materializing ?? work.queried;
          if (closed.populationJob) {
            requirePopulationBaseline(cut.row);
            if (
              work.queried ||
              !work.materializing ||
              cut.row.coverage_publication !== null ||
              cut.row.publication_job !== null ||
              cut.row.state !== 'begun'
            )
              throw new BindingError('binding_mismatch');
          }
          if (
            work.adopted !== false ||
            work.bootstrap.id !== id ||
            work.registration.id !== closed.registration ||
            !original ||
            original.snapshot.observation !== closed.observation ||
            (work.materializing && work.materializing.snapshot.kind !== 'pit') ||
            (work.queried && !isDeepStrictEqual(work.queried.consumer, cut.bootstrap.consumer)) ||
            !isDeepStrictEqual(original.consumer, cut.bootstrap.consumer)
          )
            throw new BindingError('binding_mismatch');
          const result = await db.query(
            `/* semantic.native-keyed:${closed.populationJob ? '50:67:19' : '43:49:19'} */
             WITH owned AS MATERIALIZED (
               SELECT b.bootstrap,r.id FROM semantic.public_filter_bootstrap b
               JOIN core.partition p ON p.partition_no=b.partition_no AND p.epoch=b.owner_epoch AND p.write_state='active'
               JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(b.partition_no,$2)
               JOIN search.public_filter_observation o ON (o.partition_no,o.observation)=(r.partition_no,$3)
               WHERE (b.partition_no,b.bootstrap)=(0,$1) AND b.queried IS NULL
                 AND b.publication_job IS NULL AND ${
                   closed.populationJob
                     ? 'b.coverage_publication IS NULL AND search.private_population_build($8::uuid,$2,$4,$9::jsonb)'
                     : 'b.coverage_publication IS NOT NULL'
                 }
                 AND (($6::text IS NULL AND b.state='begun' AND b.snapshot_kind='prepared')
                   OR (b.state='aborting' AND EXISTS (SELECT FROM search.public_filter_observation q
                       WHERE (q.partition_no,q.registration,q.observation)=(r.partition_no,r.id,$6)
                         AND q.state='closed' AND q.queried=$7)))
                 AND r.consumer_bootstrap=$4 AND r.consumer_work=$5 AND r.state='active'
                 AND o.registration=r.id AND o.state='closed' AND NOT EXISTS (
                   SELECT FROM search.public_filter_observation prepared
                   WHERE (prepared.partition_no,prepared.registration,prepared.prepared_build,prepared.prepared_generation)
                     =(0,r.id,$4,1) AND prepared.state='open'
                 )
               FOR UPDATE OF b,r
             ), batch AS MATERIALIZED (
               SELECT s.raw_ordinal FROM owned JOIN search.public_filter_preparation_segment s
                 ON (s.partition_no,s.registration,s.build,s.generation)=(0,owned.id,$4,1)
               ORDER BY s.raw_ordinal LIMIT 17
             ), cleared AS (
               DELETE FROM search.public_filter_preparation_segment s USING owned
               WHERE (s.partition_no,s.registration,s.build,s.generation)=(0,owned.id,$4,1)
                 AND s.raw_ordinal IN (SELECT raw_ordinal FROM batch ORDER BY raw_ordinal LIMIT 16)
               RETURNING s.raw_ordinal
             ), finished AS (
               SELECT owned.* FROM owned WHERE (SELECT count(*) FROM batch)=(SELECT count(*) FROM cleared)
             ), header AS (
               DELETE FROM search.public_filter_prepared p USING finished
               WHERE (p.partition_no,p.registration,p.build,p.generation)=(0,finished.id,$4,1)
               RETURNING p.registration
             ), aborted AS (
               UPDATE semantic.public_filter_bootstrap b SET state='aborted' FROM finished
               WHERE (b.partition_no,b.bootstrap)=(0,finished.bootstrap) RETURNING finished.id
             ) UPDATE search.public_filter_registration r SET consumer_work=NULL,consumer_bootstrap=NULL
               FROM aborted WHERE (r.partition_no,r.id)=(0,aborted.id) RETURNING r.id`,
            [
              cut.row.bootstrap,
              closed.registration,
              closed.observation,
              id,
              closed.work,
              work.queried?.snapshot.observation ?? null,
              work.queried ? ports.search.encodeState(work.queried) : null,
              ...(closed.populationJob ? [closed.populationJob, cut.bootstrap.consumer] : []),
            ],
          );
          return { status: result.rowCount === 1 ? ('aborted' as const) : ('pending' as const), cost };
        }
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
          { bootstrap: cut.bootstrap.covered, snapshot: cut.bootstrap.snapshot },
        );
        addCost(cost, native.cost);
        if (!('definition' in native)) return { ...native, cost };
        requireSameDefinition(cut.definition, native.definition);
        if (native.queried === null) {
          if (cut.row.state !== 'begun' || cut.row.queried !== null) return { status: 'pending' as const, cost };
          if (cut.row.coverage_publication) await requireServingCoverage(cut, db);
          else if (!cut.row.coverage_sealed) return { status: 'pending' as const, cost };
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
      const joined = await joinNativeCut(
        { queried: input.queried, execution: input.execution },
        { deadline },
        'repair',
      );
      if (joined.status !== 'joined') return joined;
      return run({ deadline }, async (cost, db) => {
        addCost(cost, joined.cost);
        const { cut } = joined;
        if (
          cut.bootstrap.id !== input.bootstrap ||
          cut.row.state !== 'adopted' ||
          cut.row.queried !== joined.queried.snapshot.observation ||
          encode(cut.bootstrap.covered) !== encode(joined.covered)
        )
          throw new BindingError('binding_mismatch');
        if (
          input.homeLimit !== undefined &&
          (!Number.isInteger(input.homeLimit) ||
            input.homeLimit < input.inputLimit ||
            input.homeLimit > repairHomeBatchLimit ||
            (!('representation' in cut.definition.capture) && !boundSubjectPublication(cut, input)))
        )
          throw new BindingError('binding_mismatch');
        if (cut.row.coverage_publication) throw new BindingError('owner_unavailable');
        return repairNative(cut.bootstrap, joined, input, db, cost, { deadline });
      });
    },
    settle: settleNative,
    async settleMixed(input, context, spent) {
      if (
        !Number.isSafeInteger(spent.inputKeys) ||
        spent.inputKeys < 0 ||
        spent.inputKeys >= preparationInputLimit ||
        !Number.isSafeInteger(spent.bytes) ||
        spent.bytes < 0 ||
        spent.bytes >= 4 * 1024 * 1024
      )
        return fail('owner_unavailable');
      const original = publicFilterBindingCost();
      addCost(original, spent);
      return settleNative(input, context, original, true);
    },
  };
  nativeRepairJoins.set(bootstrapBinding, (request, context) => joinNative(request, context, 'repair'));
  nativeRepairReadBatches.set(bootstrapBinding, async (input, context, read, accounts) => {
    const ids = accounts ? [...new Set(accounts.ids)] : [];
    const scope: RepairReadScope = {
      input: structuredClone(input),
      deadline: context.deadline,
      ...(ids.length > 0 && ids.length <= 50 && { accounts: { ids } }),
    };
    const result = await repairReadBatch.run(scope, read);
    const original = scope.accounts?.observations;
    if (accounts && original) {
      // Keep the shared Account snapshot current through the full verified run.
      // Core writer positions can advance without changing these Account facts.
      accounts.charge();
      const current = await run(context, async (cost, db) => ({
        status: 'observed' as const,
        observations: await ports.access.readAccountRepairs(db, ids, context),
        cost,
      }));
      accounts.charge(current.cost);
      if (current.status !== 'observed') throw new BindingError(current.reason);
      for (const [id, observation] of original) {
        if (!isDeepStrictEqual({ ...current.observations.get(id), position: observation.position }, observation))
          throw new BindingError('configuration_changed');
      }
    }
    return result;
  });
  nativeRepairStarts.set(bootstrapBinding, async (request, context) => {
    const result = await run(context, async (cost, db) => {
      const joined = await joinNative({ queried: request.queried }, context, 'repair');
      addCost(cost, joined.cost);
      if (joined.status !== 'joined') throw new BindingError(joined.reason);
      const cut = await loadBootstrap(request.bootstrap, db, joined.definition);
      if (
        !cut.row.coverage_sealed ||
        cut.row.coverage_after !== 4096 ||
        encode(cut.bootstrap.covered) !== encode(joined.covered)
      )
        throw new BindingError('binding_mismatch');
      const observation = joined.queried.snapshot.observation;
      const adopted = cut.row.state === 'adopted' && cut.row.queried === observation;
      if (request.publicationJob !== undefined) {
        requirePopulationBaseline(cut.row);
        const begun = cut.row.state === 'begun' && cut.row.queried === null;
        if (
          cut.bootstrap.snapshot !== 'prepared' ||
          (!adopted && !begun) ||
          (cut.row.publication_job !== null &&
            (cut.row.publication_job !== request.publicationJob ||
              cut.row.publication_observation !== observation ||
              cut.row.publication_execution !== request.publicationJob))
        )
          throw new BindingError('binding_mismatch');
        // Publication appends its original execution before Source pins and adopts
        // the tuple. Only the reconciled generation may start from this sealed cut.
        const consumer = joined.queried.consumer;
        const retained = await db.query(
          `/* semantic.native-keyed:1:1 */
           SELECT 1 FROM search.generation_publication
           WHERE (partition_no,job)=(0,$1::uuid) AND phase='reconciled' AND fence IS NULL
             AND consumer=$2::jsonb AND physical_target=$3 AND native_incarnation=$4
             AND source_home=0 AND binding->>'readDefinition'=$5
             AND (observation IS NULL OR observation=$6)`,
          [
            request.publicationJob,
            consumer,
            consumer.physicalTarget,
            consumer.incarnation,
            cut.definition.readDefinition,
            observation,
          ],
        );
        if (retained.rowCount !== 1) throw new BindingError('binding_mismatch');
      } else if (!adopted) {
        throw new BindingError('binding_mismatch');
      }
      // This is an original maintenance locator, not a clean population result.
      // It cannot authorize enumeration or renew an immutable served observation.
      return { status: 'start' as const, start: joined.covered, cost };
    });
    if (result.status !== 'start') throw new BindingError(result.reason);
    return result;
  });
  nativeAccountRepairs.set(bootstrapBinding, async (request, context) => {
    const result = await run(context, async (cost, db) => {
      const joined = await joinNative({ queried: request.queried, execution: request.execution }, context, 'repair');
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
  nativeBookPageRestorations.set(bootstrapBinding, async (request, context) => {
    const q = structuredClone(request.queried);
    const releaseDigest = q.consumer.meaningDigest;
    if (releaseDigest !== null && q.snapshot.kind === 'pit') {
      const batch = bookBindingStep(
        'restore',
        bootstrapBinding,
        JSON.stringify([q.consumer.physicalTarget, q.consumer.incarnation, releaseDigest]),
        q.snapshot.observation,
        context.deadline,
        q,
        async (members, deadline) => {
          const result = await run({ deadline }, async (cost, db) => {
            const release = await readRelease(db, releaseDigest);
            if (!release || !Object.keys(release.types).length) throw new BindingError('definition_missing');
            const rows = await db.query<
              DefinitionRow & {
                id: string;
                bootstrap: string;
                covered: string;
                read_definition: string;
                definition: string;
                coverage_publication: string;
                coverage_generation: string;
                withdrawal_digest: string | null;
              }
            >(
              `WITH members AS (SELECT * FROM jsonb_to_recordset($1) i(id text,queried text,consumer text))
              SELECT i.id,b.bootstrap::text,o.covered,b.read_definition::text,r.definition,b.coverage_publication::text,b.coverage_generation::text,
                encode(sha256(convert_to(b.book_withdrawals::text,'UTF8')),'hex') AS withdrawal_digest,
                s.source_id::text,s.configuration::text,s.owner_epoch,d.release_digest,d.capture,d.dependency_keys
              FROM members i JOIN search.public_filter_observation o ON (o.partition_no,o.observation)=(0,i.id)
              JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(0,o.registration)
              JOIN search.public_filter_target t ON (t.partition_no,t.physical_target)=(0,r.physical_target)
              JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap)=(0,
                CASE WHEN o.consumer_bootstrap ~ '^0:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN substring(o.consumer_bootstrap FROM 3)::uuid END)
              JOIN semantic.public_filter_read_definition d ON (d.partition_no,d.read_definition)=(0,b.read_definition)
              JOIN semantic.public_filter_source s ON (s.partition_no,s.source_id,s.configuration)=(0,d.source_id,d.configuration)
              JOIN core.partition p ON p.partition_no=0 AND p.write_state='active' AND p.epoch=b.owner_epoch AND p.epoch=s.owner_epoch
              WHERE o.queried=i.queried AND o.state='open' AND o.expires_at>$2 AND r.state='active'
                AND r.physical_target=$3 AND t.incarnation=$4 AND d.release_digest=$5 AND s.route_digest=$6
                AND b.consumer=i.consumer AND b.state='adopted' AND b.queried=i.id AND b.snapshot_kind='pit'
                AND b.coverage_publication IS NOT NULL AND b.coverage_generation IS NOT NULL`,
              [
                JSON.stringify(
                  members.map((q) => ({
                    id: q.snapshot.observation,
                    queried: ports.search.encodeState(q),
                    consumer: encode(q.consumer),
                  })),
                ),
                Date.now(),
                q.consumer.physicalTarget,
                q.consumer.incarnation,
                releaseDigest,
                routeDigest,
              ],
            );
            return { rows: new Map(rows.rows.map((r) => [r.id, r])), release, cost };
          });
          return members.map((queried, i) => {
            const cost = bookCostShare(result.cost, i, members.length);
            if (!('rows' in result)) return { ...result, cost };
            const row = result.rows.get(queried.snapshot.observation);
            const fallback = { status: 'recover' as const, cost };
            if (!row) return fallback;
            try {
              const covered = { observation: '0:' + row.bootstrap };
              const definition = restoreDefinition(row.read_definition, row, result.release, ports.search);
              if (
                !('bookTypeList' in definition.capture) ||
                !definition.capture.bookTypeList ||
                row.covered !== ports.search.encodeState(covered)
              )
                return fallback;
              const retained = ports.search.decodeState<{ digest: string; data: SourceBindingRetainedDefinition }>(
                row.definition,
              );
              if (retained.digest !== hash(ports.search.encodeState(retained.data)))
                return fail('binding_mismatch', cost);
              requireSameDefinition(definition, retained.data);
              freeze(definition);
              return {
                status: 'joined' as const,
                definition,
                queried,
                covered,
                execution: null,
                cost,
                bookPopulation: bookPopulationKey(
                  row.coverage_publication,
                  row.coverage_generation,
                  row.owner_epoch,
                  row.withdrawal_digest,
                  definition,
                ),
              };
            } catch (error) {
              if (error instanceof BindingError) return fail(error.reason, cost);
              if (error instanceof TypeError || error instanceof RangeError) return fail('binding_mismatch', cost);
              return fallback;
            }
          });
        },
      );
      if (batch) {
        const result = await batch;
        if (result.status !== 'recover') return result;
        const single = await joinNative({ queried: q }, context, 'book-page');
        const cost = publicFilterBindingCost();
        addCost(cost, result.cost);
        addCost(cost, single.cost);
        return { ...single, cost };
      }
    }
    return joinNative({ queried: q }, context, 'book-page');
  });
  nativeBookPreparations.set(bootstrapBinding, beginBookPages);
  nativePreparations.set(bootstrapBinding, async (input, context) => {
    if (!('bootstrap' in input))
      return beginRetained(
        input,
        context,
        undefined,
        input.inputLimit,
        input.usePublishedCoverage ?? false,
        input.definition,
      );
    if (input.coldEnrollment) {
      return run(context, async (cost, db) => {
        const request = structuredClone(input.coldEnrollment!);
        const expected = structuredClone(input.subjectEnrollment);
        const inputLimit = input.inputLimit ?? preparationInputLimit;
        if (
          !expected?.capturingOnly ||
          expected.registration.partition !== 0 ||
          !Number.isSafeInteger(inputLimit) ||
          inputLimit < 0 ||
          inputLimit > preparationInputLimit
        )
          throw new BindingError('binding_mismatch');
        const { row, definition, bootstrap } = await withReadTransaction(
          db,
          (client) => loadBootstrap(input.bootstrap, client),
          context.deadline,
        );
        if (
          row.coverage_generation === null ||
          bootstrap.snapshot !== 'prepared' ||
          !('catalogueCoverage' in definition.capture) ||
          definition.capture.catalogueCoverage !== true ||
          'representation' in definition.capture ||
          !isDeepStrictEqual(definition.source, expected.source) ||
          encode(bootstrap.consumer) !== encode(expected.consumer) ||
          definition.readDefinition !== expected.consumer.readDefinition ||
          definition.meaning.digest !== expected.consumer.meaningDigest
        )
          throw new BindingError('binding_mismatch');

        const keys = [...publicFilterCoverageKeys(definition.dependencyKeys, true)].sort((a, b) =>
          Buffer.compare(Buffer.from(a), Buffer.from(b)),
        );
        const funding = coldEnrollmentFunding(request, keys);
        if (cost.inputKeys + funding.inputs > inputLimit || cost.bytes + funding.bytes > request.byteLimit)
          throw new BindingError('owner_unavailable');

        const baseline = {
          bootstrap: row.bootstrap,
          registration: expected.registration,
          definition: definition.readDefinition,
          consumer: ports.search.encodeConsumer(bootstrap.consumer),
          originalConsumer: bootstrap.consumer,
          sourceConsumer: row.consumer,
          accounts: false,
          generation: row.coverage_generation,
          source: definition.source,
          job: request.job,
          keys,
        };
        const adopt = async (ranges: readonly PreparedEnrollmentRange[], frontier?: number) => {
          const state = await adoptColdEnrollment(db, baseline, ranges, context.deadline, frontier);
          return { status: state === 'adopted' ? ('range-adopted' as const) : ('range-pending' as const), cost };
        };
        if (request.action === 'adopt') return adopt(request.ranges);
        const prepared = await prepareColdEnrollment(db, baseline, request.ranges, async (range) => {
          const grouped = ports.access.newAccountEnrollment;
          const enrollment = {
            bootstrap: row.bootstrap,
            registration: baseline.registration,
            readDefinition: baseline.definition,
            keys,
            keyLimit: Math.max(1, keys.length),
            accounts: false,
          };
          const size = grouped?.groupSize ?? 1;
          for (let start = range.start; start < range.end; start += size) {
            const partitions = Array.from({ length: Math.min(size, range.end - start) }, (_, i) => start + i);
            if (grouped && partitions.length > 1 && (await grouped.enroll(db, { ...enrollment, partitions }, context)))
              continue;
            for (const partition of partitions)
              await ports.access.enrollAccountHome(db, { ...enrollment, partition }, context);
          }
        });
        if (request.action === 'prepare-and-adopt') return adopt(prepared.ranges, prepared.frontier);
        return { status: 'ranges-prepared' as const, ranges: prepared.ranges, cost };
      });
    }
    const retained = await run(context, async (cost, db) => {
      // Finish the original Source read before Search registration or Access enrollment takes a checkout.
      const expected = input.subjectEnrollment;
      const read = async (client: CommandTransaction) => {
        const cut = await loadBootstrap(input.bootstrap, client);
        const { row, definition, bootstrap } = cut;
        if (row.state !== 'capturing' && row.state !== 'begun') throw new BindingError('observation_lost');
        if (
          expected &&
          ((expected.capturingOnly && (row.queried !== null || row.publication_job !== null)) ||
            row.coverage_publication !== null ||
            bootstrap.snapshot !== 'prepared' ||
            !('catalogueCoverage' in definition.capture) ||
            definition.capture.catalogueCoverage !== true ||
            'representation' in definition.capture ||
            !isDeepStrictEqual(definition.source, expected.source) ||
            encode(bootstrap.consumer) !== encode(expected.consumer))
        )
          throw new BindingError('binding_mismatch');
        if (!expected?.capturingOnly || row.state === 'capturing') return { status: 'retained' as const, cut, cost };
        if (
          definition.readDefinition !== expected.consumer.readDefinition ||
          definition.meaning.digest !== expected.consumer.meaningDigest
        )
          throw new BindingError('binding_mismatch');
        requirePopulationBaseline(row);
        const { rowCount } = await client.query(
          `/* semantic.native-keyed:5:5 */
           SELECT 1 FROM search.public_filter_registration r
           JOIN search.public_filter_target t USING (partition_no,physical_target)
           JOIN search.public_filter_coverage_preparation c
             ON (c.partition_no,c.registration,c.bootstrap)=(r.partition_no,r.id,$3::uuid)
           WHERE (r.partition_no,r.id)=($1,$2) AND r.state='active'
             AND r.consumer_bootstrap=$4 AND r.consumer_work IS NOT NULL
             AND r.consumer=$5 AND r.physical_target=$6 AND t.incarnation=$7
             AND c.consumer=r.consumer AND c.definition=$8 AND c.generation=$9 AND c.root=$10
             AND c.population_protocol=1 AND c.after_home=4096
             AND NOT EXISTS (SELECT FROM search.public_filter_observation o
               WHERE (o.partition_no,o.registration)=(r.partition_no,r.id) AND o.state<>'closed')
             AND NOT EXISTS (SELECT FROM search.identity_writer_gate g
               WHERE (g.partition_no,g.physical_target)=(r.partition_no,r.physical_target)
                 AND g.publication_fence IS NOT NULL)`,
          [
            expected.registration.partition,
            expected.registration.id,
            row.bootstrap,
            bootstrap.id,
            ports.search.encodeConsumer(expected.consumer),
            expected.consumer.physicalTarget,
            expected.consumer.incarnation,
            definition.readDefinition,
            row.coverage_generation,
            row.coverage_root,
          ],
        );
        if (rowCount !== 1) throw new BindingError('binding_mismatch');
        return { status: 'enrollment-sealed' as const, cost };
      };
      return expected ? await withReadTransaction(db, read, context.deadline) : await read(db);
    });
    if (retained.status !== 'retained') return retained;
    if (retained.cut.row.state === 'begun') {
      if (retained.cut.row.coverage_publication) {
        return run(context, async (cost, db) => {
          addCost(cost, retained.cost);
          await requireServingCoverage(retained.cut, db);
          return { status: 'begun' as const, bootstrap: retained.cut.bootstrap, cost };
        });
      }
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
      input.subjectEnrollment
        ? {
            ...retained.cut,
            enrollmentRegistration: input.subjectEnrollment.registration,
            ...(input.subjectEnrollment.capturingOnly ? { receiptPageOnly: true } : {}),
          }
        : retained.cut,
      (input.inputLimit ?? preparationInputLimit) - retained.cost.inputKeys,
    );
    addCost(retained.cost, result.cost);
    if ('bootstrap' in result && result.bootstrap.id !== input.bootstrap)
      return fail('observation_lost', retained.cost);
    if (input.subjectEnrollment && result.status === 'begun')
      return { ...result, enrollmentAdvanced: true, cost: retained.cost };
    return { ...result, cost: retained.cost };
  });
  nativePublicationCompletions.set(bootstrapBinding, async (request, context, spent) => {
    if (
      spent &&
      (!Number.isSafeInteger(spent.inputKeys) ||
        spent.inputKeys < 0 ||
        spent.inputKeys >= preparationInputLimit ||
        !Number.isSafeInteger(spent.bytes) ||
        spent.bytes < 0 ||
        spent.bytes >= 4 * 1024 * 1024)
    )
      return fail('owner_unavailable');
    const input = structuredClone(request),
      deadline = context.deadline;
    return run({ deadline }, async (cost, db) => {
      // Pin the original operands before any dispatch/adoption uncertainty. Search owns the
      // generation record; Source stores only its locator and its own original binding operands.
      if ('bootstrap' in input) {
        const joined = await joinNative({ queried: input.queried, execution: input.execution }, { deadline }, 'repair');
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
      if (cut.row.state !== 'adopted' || cut.row.queried !== publication.queried.snapshot.observation) {
        const adopted = await bootstrapBinding.adopt({ bootstrap, queried: publication.queried }, { deadline });
        addCost(cost, adopted.cost);
        if (adopted.status !== 'adopted')
          return { status: 'pending' as const, publication, reason: adopted.reason, cost };
      }
      if (cut.row.ack_protocol === 1) {
        if (!boundSubjectPublication(cut, publication)) throw new BindingError('binding_mismatch');
        const points = Math.min(160 + 20 * 32, preparationInputLimit - cost.inputKeys - (spent?.inputKeys ?? 0));
        // Leave room for this statement, its three arguments and its four scalar results.
        const bytes = Math.min((64 + 24 * 32) * 1024, 4 * 1024 * 1024 - cost.bytes - (spent?.bytes ?? 0) - 1024);
        if (points >= 180 && bytes >= 88 * 1024) {
          // A lost reply can include the home markers, their clock and one range.
          const homes = Math.min(32, Math.floor((points - 160) / 20), Math.floor((bytes - 64 * 1024) / (24 * 1024)));
          const writes = homes + 2;
          cost.frontierWrites++;
          cost.bytes += bytes;
          const prepared = await db.query<{
            points: number;
            proof_bytes: number;
            range_writes: number;
            result_writes: number;
          }>(
            `/* semantic.native-keyed:${points}:${points}:${writes} */
             SELECT * FROM search.prepare_public_filter_ack_batch($1,$2,$3)`,
            [publication.job, points, bytes],
          );
          const batch = prepared.rows[0]!;
          const unused = points - batch.points;
          cost.inputKeys -= unused;
          cost.rows -= unused;
          cost.dependencyPoints -= unused;
          cost.bytes -= bytes - batch.proof_bytes;
          cost.frontierWrites -= 1 - batch.range_writes;
          cost.resultWrites -= writes - batch.result_writes;
          if (batch.range_writes > 0) {
            return {
              status: 'pending' as const,
              publication,
              reason: 'owner_unavailable' as const,
              advanced: true as const,
              cost,
            };
          }
        }
      }
      // Until the verified chain closes, the exact original execution still
      // needs repair. The terminal settlement always verifies the full seal.
      const terminal = await db.query(
        `/* semantic.native-keyed:1:2 */
         SELECT 1 FROM semantic.public_filter_repair_step
         WHERE (partition_no,bootstrap,execution)=(0,$1,$2)
           AND verified_root IS NOT NULL AND verified_next IS NULL AND complete`,
        [retained.bootstrap, retained.execution],
      );
      if (terminal.rowCount === 0)
        return { status: 'pending' as const, publication, reason: 'owner_unavailable' as const, cost };
      // Prior Search reads consume the same allowance. They fund no additional
      // Source work and must not be charged again in the returned Source cost.
      const settlementSpent = {
        ...cost,
        inputKeys: cost.inputKeys + (spent?.inputKeys ?? 0),
        bytes: cost.bytes + (spent?.bytes ?? 0),
      };
      const settled = await settleNative(publication, { deadline }, settlementSpent);
      addCost(cost, settled.cost);
      if (settled.status !== 'joined')
        return {
          status: 'pending' as const,
          publication,
          reason: settled.reason,
          ...('advanced' in settled && settled.advanced === true ? { advanced: true as const } : {}),
          ...('ackAttempted' in settled ? { ackAttempted: true as const } : {}),
          cost,
        };
      // Clean current population alone cannot replace the independently verified original
      // chain and Search's dispatch/winner/copy/writer/physical-target completion above.
      const observation = await readPublicFilterPopulation(
        db,
        nativeRouting,
        {
          kind: 'population',
          queried: native.queried,
          start: settled.execution!.start,
          execution: retained.execution,
          context: { deadline },
        },
        ports.search,
        ports.access,
        settled.execution!.start.observation === publication.bootstrap
          ? { job: publication.job, bootstrap: retained.bootstrap, terminal: settled.terminal }
          : undefined,
      );
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
