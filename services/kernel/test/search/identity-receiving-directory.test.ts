import { beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Pool, type QueryConfig } from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { withCompiledCommandControls } from '../../src/command/command.ts';
import time from '../../src/command/time.sql';
import commandFence from '../../src/command/fence.sql';
import commandNoEffect from '../../src/command/no-effect-fence.sql';
import { installNativeHistoryPreload } from '../../src/composition/preload.ts';
import { composeSearchNativePorts } from '../../src/composition/search-native.ts';
import partitionRead from '../../src/partition/read.sql';
import { newId, partitionOf } from '../../src/route/route.ts';
import { anonymousSubjectFormulaBound, createAccess } from '../../src/access/permission.ts';
import permissionTime from '../../src/access/permission-time.sql';
import permissionFormula from '../../src/access/permission-check.sql';
import subjectEligibility from '../../src/semantic/scope-leaf-evidence-eligibility.sql';
import relatedVisibility from '../../src/semantic/read-subject-related-states.sql';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import stepSql from '../../src/search/identity-epoch-participant-step.sql';
import completeSql from '../../src/search/identity-epoch-participant-complete.sql';
import replaySql from '../../src/search/identity-epoch-participant-replay.sql';
import {
  dispatchSearchIdentityOriginalSql,
  readBoundedSearchIdentityActionSql,
  readBoundedSearchIdentityReceiptSql,
  readSearchIdentityBulkResponseSql,
  readSearchIdentityDispatchBasisSql,
  readSearchIdentityPlanBodySizeSql,
  retainSearchIdentityWriterReceiptSql,
  retainSearchIdentityBulkResponseSql,
} from '../../src/search/identity-search-writer-dispatch-sql.ts';
import nativeDefinition from '../../src/search/identity-receiving-native-definition.sql';
import {
  readSearchIdentityPlanComponentSql,
  revalidateSearchIdentityPlanFenceSql,
} from '../../src/search/identity-search-writer-plan-sql.ts';
import { searchNativeReceivingStatements } from '../../src/search/identity-receiving-native-store.ts';
import {
  searchNativeOriginalOperationSql,
  searchNativeReleaseAppliedSql,
  sizedSearchIdentityPlanSql,
} from '../../src/search/identity-receiving-native-work.ts';
import type {
  OperationRow,
  StoredReferences,
  StoredSource,
} from '../../src/search/identity-receiving-native-internal.ts';
import {
  lockSearchIdentityOriginalSql,
  prepareSearchIdentityOriginalSql,
  readSearchIdentityPredecessorSql,
  readSearchIdentityHomePendingSql,
} from '../../src/search/identity-search-writer-plan-sql.ts';
import { createSearchIdentityWriterPreparation } from '../../src/search/identity-search-writer-preparation.ts';
import {
  advanceWriterPublicationAdmissionSql,
  insertWriterPublicationWitness,
  lockPublicationAdmission,
  lockPublicationFence,
  readPublicationFence,
  readWriterPublicationWitness,
} from '../../src/search/publication-admission.ts';
import {
  createSearchWriterGuard,
  searchIdentityWriterAdmissionSql,
  searchIdentityWriterSettlementSql,
} from '../../src/search/writer-guard.ts';
import {
  SEARCH_IDENTITY_WRITER_ACCEPT,
  SEARCH_IDENTITY_WRITER_DISPATCH,
  SEARCH_IDENTITY_WRITER_REQUEST,
} from '../../src/semantic/contract/identity-epoch-ports.ts';
import { identityEpochReceiptLocator } from '../../src/semantic/core/identity-epoch-sequence.ts';
import nativeCommit from '../../src/semantic/identity-epoch-store-insert-native-commit.sql';
import releaseExists from '../../src/semantic/definitions-exists.sql';
import releaseRead from '../../src/semantic/definitions-read.sql';
import sourceDefine from '../../src/semantic/public-filter-source-binding-define.sql';
import definitionRead from '../../src/semantic/public-filter-source-binding-definition.sql';
import sourceRegister from '../../src/semantic/public-filter-source-binding-register.sql';
import visibilityRead from '../../src/semantic/read-visibility.sql';
import mappingOwners from '../../src/semantic/identity-epoch-read-owners.sql';
import mappingSources from '../../src/semantic/identity-epoch-read-sources.sql';
import mappingPending from '../../src/semantic/identity-epoch-read-pending.sql';
import mappingCurrent from '../../src/semantic/identity-terminal-closure-current.sql';
import {
  EMPTY_IDENTITY_SEARCH_TERMS_DIGEST,
  readIdentitySearchIndexTermSlotSql,
  readIdentitySearchIndexTermSlotShapeSql,
  readIdentitySearchIndexTermsSql,
} from '../../src/semantic/identity-search-index-terms.ts';
import {
  readCanonicalStatementCountSql,
  readCanonicalStatementPresenceSql,
  readCanonicalStatementsSql,
  SEARCH_INDEX_PROVENANCE_BYTES,
  SEARCH_INDEX_STATEMENT_KEYS,
} from '../../src/semantic/identity-search-index-statements.ts';
import candidateProvenance from '../../src/semantic/scope-leaf-selection-provenance.sql';
import sourceFences from '../../src/content/read-source-fences.sql';
import { readCreatorTermBudgetSql } from '../../src/semantic/credit-search-creators.ts';
import activeDefinition from '../../src/semantic/definitions-active.sql';
import publicFigures from '../../src/rating/public-figures-read.sql';
import { STANDARD_QUESTION_ID } from '../../src/rating/standard-question.ts';
import { GLOBAL_CONTEXT_RESOURCE } from '../../src/semantic/contract/global-context.ts';
import listingCounts from '../../src/library/listing-counts.sql';
import projectionRelease from '../../src/semantic/search-source-releases.sql';
import projectionSubjects from '../../src/semantic/search-source-subjects.sql';
import projectionPrivacy from '../../src/semantic/public-filter-projection-head-read.sql';
import projectionPage from '../../src/semantic/public-filter-projection-page.sql';
import projectionStart from '../../src/semantic/public-filter-projection-build-start.sql';
import projectionBuild from '../../src/semantic/public-filter-projection-build-read.sql';
import {
  invalidateProjectionBuildSql,
  lockProjectionBuildForHeadsSql,
  lockProjectionBuildForRetirementSql,
  retireProjectionHeadSql,
  retiredProjectionMeaning,
  verifyCompletedPublicFilterProjectionSql,
} from '../../src/semantic/public-filter-projection-build-control.ts';
import projectionHeads from '../../src/semantic/public-filter-projection-head-upsert.sql';
import projectionHeadPage from '../../src/semantic/public-filter-projection-head-page.sql';
import projectionCurrentHead from '../../src/semantic/public-filter-projection-head-current.sql';
import structuralGate from '../../src/semantic/identity-epoch-store-select-home-gate.sql';
import type { IdentityFrontier, IdentityStepProgress, IdentityStepReceipt } from '../../src/semantic/identity-epoch-contract.ts';
import {
  createSearchIdentityEpochParticipant,
  searchIdentityReceivingComposition,
} from '../../src/search/identity-epoch-participant.ts';
import {
  readSearchIdentityDirectorySql,
  advanceSearchIdentityOriginalSql,
  readSearchIdentityMaterializedOriginalSql,
  readSearchIdentityOriginalPlanSql,
  locateSearchIdentityOriginalPlanSql,
  searchIdentityOriginalPlanPresentSql,
  readSearchIdentityWriterAdmissionSql,
  recheckSearchIdentityWriterAdmissionSql,
  readSearchIdentityWriterSupportSql,
} from '../../src/search/identity-search-receiving-directory-sql.ts';
import { installIdentityAdapterRuntime } from '../../src/semantic/identity-adapter-runtime.ts';
import { identityEpochStore } from '../../src/semantic/identity-adapters/index.ts';
import stepRead from '../../src/semantic/identity-epoch-store-select-step.sql';
import ackJob from '../../src/semantic/identity-epoch-store-select-job-5.sql';
import missingEffect from '../../src/semantic/identity-epoch-store-select-effect-receipt.sql';
import ackReplay from '../../src/semantic/identity-epoch-store-select-ack-2.sql';
import ackInsert from '../../src/semantic/identity-epoch-store-insert-ack.sql';
import {
  identityChangeFirstInputsSQL,
  identityChangeTransformSQL,
} from '../../src/semantic/identity-epoch-store-change-transform.ts';
import ackRead from '../../src/semantic/identity-epoch-store-select-ack.sql';
import jobRead from '../../src/semantic/identity-epoch-store-select-job.sql';
import originals from '../../src/semantic/identity-epoch-store-select-original.sql';
import { searchReceivingCaptureStatements } from '../../src/semantic/identity-search-receiving-capture.ts';
import {
  receivingStatements,
  searchReceivingProductionDeclaration,
} from '../../src/semantic/identity-search-receiving-statements.ts';
import receivingSelection from '../../src/semantic/identity-receiving-selection-read.sql';
import receivingJob from '../../src/semantic/identity-epoch-store-receiving-job.sql';
import receivingLookup from '../../src/semantic/identity-epoch-store-receiving-lookup.sql';
import receivingPlan from '../../src/semantic/identity-epoch-store-receiving-plan.sql';
import receivingProgress from '../../src/semantic/identity-search-receiving-progress-insert.sql';
import receivingProgressRead from '../../src/semantic/identity-search-receiving-progress-read.sql';
import receivingProgressAdvance from '../../src/semantic/identity-search-receiving-progress-advance.sql';
import receivingProgressRelease from '../../src/semantic/identity-search-receiving-progress-release.sql';
import {
  activeIdentitySourceConsumerMaintenance,
  withIdentitySourceConsumerMaintenance,
} from '../../src/semantic/identity-source-consumer-maintenance.ts';

beforeAll(() => {
  installNativeHistoryPreload();
  installIdentityAdapterRuntime();
});

const foreignJobHome = 0x842;
const firstHome = 0x841;
const otherControlHome = 0x843;
const prefix = 'directory-probe-';
const index = prefix + 'subjects-g1';
const alias = `${index}-writer-${'a'.repeat(32)}`;

test.each([
  { label: 'selects the initial merge key', intent: 'merge', resumed: false, mode: 'input' },
  { label: 'dispatches and settles the exact accepted removal', intent: 'merge', resumed: false, mode: 'dispatch' },
  { label: 'retains a lost response as uncertain without resubmission', intent: 'merge', resumed: false, mode: 'lost' },
  { label: 'proves an original first absence under its own close', intent: 'unmerge', resumed: false, mode: 'first' },
  { label: 'hands off a released original during unmerge', intent: 'unmerge', resumed: false, mode: 'handoff' },
  { label: 'keeps an outstanding original writer pending', intent: 'merge', resumed: false, mode: 'uncertain' },
  { label: 'reconciles Access for both visible merge roots', intent: 'merge', resumed: false, mode: 'visible' },
  {
    label: 'reconciles visible merge roots in separate homes',
    intent: 'merge',
    resumed: false,
    mode: 'visible-cross-home',
  },
  {
    label: 'captures the actual foreign writer step and its bound actor',
    intent: 'merge',
    resumed: false,
    mode: 'foreign-step-capture',
  },
  {
    label: 'seals a merge and restores its original from the retained writer custody',
    intent: 'merge',
    resumed: false,
    mode: 'complete-merge',
  },
  {
    label: 'records a visible merge removal in its actor admission home',
    intent: 'merge',
    resumed: false,
    mode: 'same-home-merge',
  },
  {
    label: 'reindexes and retires a visible canonical unmerge original',
    intent: 'unmerge',
    resumed: false,
    mode: 'canonical-terms',
  },
  {
    label: 'indexes and retires a visible canonical merge survivor with an adopted name',
    intent: 'merge',
    resumed: false,
    mode: 'canonical-merge',
  },
  {
    label: 'indexes a visible canonical original with an outgoing relation',
    intent: 'merge',
    resumed: false,
    mode: 'canonical-relation',
  },
  {
    label: 'indexes a visible canonical original with a credited creator',
    intent: 'merge',
    resumed: false,
    mode: 'canonical-credit',
  },
  {
    label: 'refuses a changed completed build before acceptance',
    intent: 'merge',
    resumed: false,
    mode: 'changed-proof',
  },
  {
    label: 'restarts a terminal projection whose build changes during completion',
    intent: 'merge',
    resumed: false,
    mode: 'superseded',
  },
  {
    label: 'reclaims a superseded terminal build one dependency at a time',
    intent: 'merge',
    resumed: false,
    mode: 'retire',
  },
  { label: 'uses the existing writer admission witness and gate', intent: 'merge', resumed: false, mode: 'existing' },
  { label: 'preserves an active publication fence', intent: 'merge', resumed: false, mode: 'fenced' },
  { label: 'resumes unmerge from the checkpoint', intent: 'unmerge', resumed: true, mode: 'input' },
  { label: 'includes an older materialized key', intent: 'merge', resumed: true, mode: 'materialized' },
  { label: 'refuses a stale checkpoint', intent: 'merge', resumed: true, mode: 'stale' },
  { label: 'refuses a moved input control home', intent: 'merge', resumed: true, mode: 'moved' },
  { label: 'refuses an unproved empty directory', intent: 'merge', resumed: false, mode: 'empty' },
  { label: 'refuses replacement of the checkpoint during sealing', intent: 'merge', resumed: true, mode: 'changed' },
])('installed Search directory $label', async ({ intent: initialIntent, resumed, mode }) => {
  let intent = initialIntent;
  let directoryScope = 'd'.repeat(64);
  const sameHomeMerge = mode === 'same-home-merge';
  const jobHome = sameHomeMerge ? firstHome : foreignJobHome;
  let writerHome = firstHome;
  const [previous, first, localTerminal] = Array.from({ length: 3 }, () => newId(writerHome << 4)).sort() as [
    string,
    string,
    string,
  ];
  const completeMerge = mode === 'complete-merge' || sameHomeMerge;
  const foreignCapture =
    completeMerge || mode === 'foreign-step-capture' || mode === 'canonical-terms' || mode === 'canonical-merge';
  const crossHome = completeMerge || mode === 'visible-cross-home' || mode === 'foreign-step-capture';
  let terminalHome = crossHome ? otherControlHome : writerHome;
  const second = crossHome ? newId(terminalHome << 4) : localTerminal;
  let terminal = second;
  const visibleSubjects = () => (terminal === first ? [first] : [first, terminal]);
  let jobId = newId(jobHome << 4);
  let job = { jobId, epoch: 1n };
  const mergeJob = job;
  const mergedGeneration = crypto.randomUUID();
  let savedJob = { jobId, epoch: '1' };
  let restoring = false;
  let originOffset = 0;
  const originPosition = (position: number) => String(originOffset + position);
  const creditedCreator = mode === 'canonical-credit';
  const bothVisible = mode === 'visible' || crossHome;
  const nativePermission = mode === 'canonical-terms' || mode === 'canonical-merge' || bothVisible;
  let permissionTimes = 0;
  let permissionFormulas = 0;
  let permissionBatches = 0;
  let visibilityFloorReads = 0;
  let terminalBuildCurrent = true;
  const actorId = creditedCreator || nativePermission ? newId(jobHome << 4) : null;
  const adoptedRelation = mode === 'canonical-relation' || creditedCreator;
  let canonicalTerms = mode === 'canonical-terms' || mode === 'canonical-merge' || adoptedRelation;
  let priorVisible = mode === 'handoff' || mode === 'canonical-terms';
  const visible = canonicalTerms || bothVisible || ['changed-proof', 'retire', 'superseded'].includes(mode);
  const languageDigest = createHash('sha256').update('en').digest('hex');
  const termSlots = [
    {
      slot_id: crypto.randomUUID(),
      kind: 'alias',
      language_digest: languageDigest,
      terms: ['Native alias', 'Alternate alias'],
    },
    { slot_id: crypto.randomUUID(), kind: 'label', language_digest: languageDigest, terms: ['Canonical name'] },
  ];
  const termReads: unknown[] = [];
  let canonicalBuildCurrent = true;
  let changedTermReplay = false;
  const adoptedName = mode === 'canonical-merge';
  let selectionOverflow = false;
  let nameDisclosed = true;
  let nameFenced = false;
  let relationHidden = false;
  let relationOwnerMoved = false;
  let creatorRenamed = false;
  let creatorNamesOpen = false;
  const nameSlot = crypto.randomUUID();
  const nameCandidate = crypto.randomUUID();
  const relationTarget = newId(otherControlHome << 4);
  const relationTerminal = newId(jobHome << 4);
  const creatorNameSlot = crypto.randomUUID();
  let targetRedirect: string | null = null;
  const subjectType = creditedCreator ? 'schema:Movie' : adoptedRelation ? 'schema:Recipe' : 'schema:Person';
  const selectedProperty = creditedCreator
    ? 'schema:director'
    : adoptedRelation
      ? 'schema:suitableForDiet'
      : 'schema:name';
  const relationRoster = creditedCreator
    ? [
        'wdt:P7937',
        'schema:genre',
        'schema:keywords',
        'schema:author',
        'schema:illustrator',
        'schema:director',
        'schema:musicBy',
        'schema:producer',
        'schema:productionCompany',
        'wdt:P58',
        'wdt:P178',
        'wdt:P725',
        'schema:contributor',
        'schema:character',
        'wdt:P179',
      ]
    : ['schema:author', 'schema:keywords', 'schema:suitableForDiet'];
  const dependencyHomes = adoptedRelation ? [writerHome, otherControlHome] : [writerHome];
  const selectedBody = {
    value: {
      type: 'value',
      content: adoptedRelation ? relationTarget : { language: 'en', text: 'Adopted public name' },
    },
    rank: 'normal',
    qualifiers: [],
    references: [],
  };
  let activeCollectionCount = '2';
  let normalizationCalls = 0;
  let unavailableAllocation = false;
  let corruptReceipt = false;
  let releaseOwnerAdvanced = false;
  let lateReleaseCheck = false;
  const canonicalDocument = () => ({
    id: terminal,
    partition: completeMerge ? terminalHome : writerHome,
    type: subjectType,
    security_revision: 1,
    names: ['Canonical name', 'Native alias', 'Alternate alias', ...(adoptedName ? ['Adopted public name'] : [])],
    descriptions: [],
    name_sort: 'canonical name',
    statements: adoptedName
      ? ['schema:name=Adopted public name']
      : adoptedRelation
        ? [`${selectedProperty}=${relationTarget}`]
        : [],
    facts: adoptedRelation ? [{ property: selectedProperty, value: relationTarget, qualifiers: [] }] : [],
    public_collection_count: 2,
    rating_score: 0.7,
    rating_prior_epoch: 3,
    credit_search_complete: creditedCreator,
    credited_names: creditedCreator
      ? [
          expect.objectContaining({
            workId: second,
            statementId: nameCandidate,
            revision: 1,
            release: bundledDigest,
            property: selectedProperty,
            targetId: relationTarget,
            direction: 'outgoing',
            nameRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
            qualifiers: [],
            name: { language: 'en', value: 'Public credited director' },
          }),
        ]
      : [],
    ...(adoptedRelation && { relation_facet_overflow: relationRoster }),
  });
  let oldBuild = crypto.randomUUID();
  const oldHeads = mode === 'retire' ? [0, writerHome] : [];
  let oldMeaning = bundledDigest;
  let oldGeneration = '4';
  let newGeneration = mode === 'retire' ? '6' : '1';
  let after = resumed ? previous : null;
  const frontier = resumed ? { after: ['search-directory', previous, 9], segment: 0 } : null;
  const leftGeneration = newId(jobHome << 4);
  const rightGeneration = newId(jobHome << 4);
  let selected = mode === 'materialized' ? first : intent === 'unmerge' || canonicalTerms ? second : first;
  const pool = new Pool();
  const routeKey = new Uint8Array(32);
  const importedName = {
    source: 'catalogue',
    external_id: 'adopted-name',
    field_group: 'facts',
    record_revision: '1',
    converter_revision: '1',
    digest: 'a'.repeat(64),
  };
  const nameTuple = {
    route: tupleRoute(routeKey, importedName.source, importedName.external_id),
    source: importedName.source,
    external_id: importedName.external_id,
    field_group: importedName.field_group,
  };
  const routeDigest = createHash('sha256').update(routeKey).digest('hex');
  const sourceId = crypto.randomUUID();
  const sourceConfig = crypto.randomUUID();
  const definitionId = crypto.randomUUID();
  let capture: string | undefined;
  let dependencies: string | undefined;
  const projectionHeadCursors: string[] = [];
  let retainedBuild: string | undefined;
  let retainedOriginalBuild: string | undefined;
  const projectionDependencyHomes = new Map<string, number[]>();
  let readBuilds = 0;
  const forbidden = () => {
    throw new Error('Unexpected Access or Pool call');
  };
  pool.query = (async (query: string | QueryConfig, positional: unknown[]) => {
    const connection = await pool.connect();
    try {
      return await connection.query(query, positional);
    } finally {
      connection.release();
    }
  }) as Pool['query'];
  const checkpoint = crypto.randomUUID();
  const replacement = crypto.randomUUID();
  let directoryReads = 0;
  let originalReads = 0;
  let planReads = 0;
  let engineReads = 0;
  let checkedOut = false;
  const writerSql = searchIdentityWriterAdmissionSql();
  const locks = [
    structuralGate.sql,
    lockPublicationAdmission,
    readWriterPublicationWitness,
    insertWriterPublicationWitness,
    readPublicationFence,
    writerSql.gate,
    writerSql.insertGate,
    writerSql.original,
  ];
  const observedLocks: string[] = [];
  const planSql = searchNativeReceivingStatements();
  let previousPlan = crypto.randomUUID();
  let previousJob = newId(jobHome << 4);
  let previousClose = crypto.randomUUID();
  type NativeWriter = Record<string, string | number | boolean | null>;
  let retainedAction: string | undefined;
  let preparedWriter: NativeWriter | undefined;
  let predecessorWriter: NativeWriter | undefined;
  type DriverPlan = { effect_key: string; source: StoredSource; references: StoredReferences; proven: true };
  let stagingPlan: DriverPlan | undefined;
  let retainedPlan: DriverPlan | undefined;
  let predecessorReads = 0;
  let dispatchRequest: Step | undefined;
  let writingOperation: OperationRow | undefined;
  let committedOperation: OperationRow | undefined;
  let receiptText: string | undefined;
  let writingBulk: { kind: string; transaction: string; bulk: unknown } | undefined;
  let retainedBulk: typeof writingBulk;
  let bulkCalls = 0;
  let hold: HoldRow | undefined;
  let commonPlan: { binding: unknown; binding_digest: string; transaction_id: string; native_position: string } | undefined;
  let acceptedNativeHold: unknown;
  let acceptedRecorded = false;
  let acceptedRecordPosition: string | undefined;
  let accepting = false;
  let changedBindingProof = false;
  let admissionTransaction = crypto.randomUUID();
  let dispatchRequestPosition = '1';
  type Progress = {
    revision: string;
    after_key: string | null;
    state: 'progress' | 'settled' | 'released';
    applied_transaction_id: string | null;
    released_transaction_id?: string;
  };
  let receivingContinuation: Progress = {
    revision: '0',
    after_key: null,
    state: 'progress',
    applied_transaction_id: null,
  };
  let writingContinuation: Progress | undefined;
  let controlCustody: { epoch: number; position: string; transaction_id: string } | undefined;
  let writingCustody: typeof controlCustody;
  let controlApplied: unknown[] | undefined;
  let writingHoldRelease: string | undefined;
  let releasePosition: string | undefined;
  const applicationPosition = () => originOffset + 34;
  let appliedPosition = applicationPosition();
  let retiredScope = false;
  let copyLocator: unknown;
  let copySettlement: { partition: number; transactionId: string; epoch: number; position: string } | undefined;
  let reconciledCopy: string | undefined;
  let controlPosition = 0;
  const nativePosition = () => {
    if (writerHome === jobHome) return String(controlPosition);
    return dispatchRequest?.frontier.after[3] === SEARCH_IDENTITY_WRITER_DISPATCH
      ? committedOperation?.state === 'applied'
        ? String(appliedPosition)
        : committedOperation?.state === 'visible'
          ? originPosition(33)
          : committedOperation
            ? retainedBulk
              ? originPosition(32)
              : originPosition(31)
            : originPosition(30)
      : accepting
        ? originPosition(21)
        : originPosition(20);
  };
  const writerClosePosition = () => String(preparedWriter!.closed_position);
  const publicationWrites: string[] = [];

  type Step = {
    transactionId: string;
    frontier: IdentityFrontier;
    engineRequests: number;
    position?: string;
    work?: IdentityStepProgress['work'];
    jobId?: string;
  };
  let writing: Step | undefined;
  const committed: Step[] = [];
  let scopeStart = 0;
  const scopeSteps = () => committed.slice(scopeStart);
  const retiredOriginals: {
    jobId: string;
    original: string;
    planId: string;
    application: string;
    release: string;
    writer: NativeWriter;
    build: NonNullable<StoredReferences['originalSupport']> | null;
  }[] = [];
  let publishedMerge = false;
  const submitted: { id: string; operation: string }[] = [];
  let firstMergeRequest: IdentityStepReceipt | undefined;
  let writingSearchAck: unknown;
  const searchAcks = new Map<string, unknown>();
  let searchAckWrites = 0;
  type Capture = {
    store:
      | 'identity_epoch_step'
      | 'identity_epoch_receiving_effect'
      | 'identity_epoch_effect_receipt'
      | 'identity_epoch_receiving_plan'
      | 'identity_epoch_receiving_record'
      | 'identity_epoch_receiving_custody';
    partition: number;
    transactionId: string;
    armed: boolean;
  };
  const captureQueue: Capture[] = [];
  let captureRole: { account_id: string; role: string } | undefined;
  let captureNativeTransaction: string | null = null;
  const capturedEvents: Capture[] = [];
  let interruptApplicationCapture = false;
  let discardedClients = 0;
  let replaceClient = false;
  let readOnly = false;
  const driver = {
    async query(input: string | QueryConfig, positional: unknown[] = []) {
      const sql = typeof input === 'string' ? input : input.text;
      const values = typeof input === 'string' ? positional : (input.values ?? []);
      if (sql.startsWith('BEGIN')) readOnly = sql.endsWith('READ ONLY');
      let rows: readonly unknown[];
      if (sql === partitionRead.sql)
        rows = [
          [
            String(values[0]),
            'b',
            relationOwnerMoved && values[0] === String(otherControlHome) ? 'moved' : 'active',
            relationOwnerMoved && values[0] === String(otherControlHome) ? 'other' : null,
            '1',
            completeMerge && Number(values[0]) === jobHome
              ? String(controlPosition)
              : (canonicalTerms || engineReads > 1) && values[0] === String(writerHome) ? nativePosition() : '0',
          ],
        ];
      else if (sql === jobRead.sql)
        rows = [
          {
            state: 'pending',
            intent: restoring
              ? {
                  kind: 'unmerge',
                  original: first,
                  undoJob: { jobId: mergeJob.jobId, epoch: String(mergeJob.epoch) },
                  verificationReceipt: null,
                  release: bundledDigest,
                }
              : {
                  kind: intent,
                  original: terminal,
                  redirected: first,
                  survivor: terminal,
                  undoJob: savedJob,
                  release: bundledDigest,
                },
            receipt: { kind: 'subject.merge', command: { digest: 'AA==' } },
          },
        ];
      else if (sql === ackRead.sql)
        rows = [
          {
            step: 'mapping',
            progress: { state: 'complete', job: savedJob, receipt: { job: savedJob, native: { position: '1' } } },
          },
          ...(searchAcks.has(jobId) ? [{ step: 'search-canonical-index', progress: searchAcks.get(jobId) }] : []),
        ];
      else if (completeMerge && (sql === stepRead.sql || sql === replaySql.sql)) {
        const saved = committed.find((item) => item.transactionId === values[1]);
        expect(saved?.frontier.after).toEqual(['directory', 2]);
        expect(values.slice(0, 6)).toEqual([jobHome, saved?.transactionId, 1, saved?.position, jobId, savedJob.epoch]);
        rows = [{ scope_digest: directoryScope, state: 'complete', frontier: saved!.frontier, work: saved!.work }];
      } else if (completeMerge && sql === ackJob.sql) {
        expect(values).toEqual([jobId, savedJob.epoch, jobHome]);
        rows = [{ scope_digest: directoryScope }];
      } else if (completeMerge && sql === missingEffect.sql) {
        expect(values).toEqual([jobId, 'search-canonical-index', jobHome]);
        expect(retiredOriginals.filter((item) => item.jobId === jobId).map(({ original }) => original)).toEqual(
          [first, second],
        );
        rows = [];
      } else if (completeMerge && sql === ackReplay.sql) {
        expect(values).toEqual([jobId, 'search-canonical-index', jobHome]);
        rows = searchAcks.has(jobId) ? [{ progress: searchAcks.get(jobId) }] : [];
      } else if (completeMerge && sql === ackInsert.sql) {
        const sealed = committed.at(-1);
        expect(values.slice(0, 4)).toEqual([jobHome, jobId, 'search-canonical-index', directoryScope]);
        expect(values.slice(5)).toEqual([jobHome, 1, sealed?.position, sealed?.transactionId]);
        writingSearchAck = JSON.parse(String(values[4]));
        rows = [{}];
      } else if (sql === readSearchIdentityDirectorySql) {
        expect(values).toEqual([jobHome, jobId, savedJob.epoch]);
        directoryReads++;
        const saved = completeMerge
          ? committed.findLast((step) => step.jobId === jobId && step.frontier.after[0] === 'search-directory')
          : retiredScope
            ? committed.at(-1)
            : (dispatchRequest ?? committed.find((step) => step.frontier.after[0] === 'search-directory'));
        rows = [
          {
            scope_digest: directoryScope,
            release: bundledDigest,
            transaction_id:
              saved?.transactionId ??
              (!resumed ? null : mode === 'changed' && directoryReads > 1 ? replacement : checkpoint),
            native_epoch: 1,
            native_position: saved?.position ?? (dispatchRequest ? dispatchRequestPosition : '1'),
            frontier: saved?.frontier ?? frontier,
            proven: mode !== 'stale',
          },
        ];
      } else if (sql === identityChangeTransformSQL)
        rows = restoring
          ? [{ kind: 'unmerge', original: first, survivor: null, remainder_terminal: second }]
          : [{ kind: intent, original: terminal, survivor: terminal, remainder_terminal: first }];
      else if (sql === identityChangeFirstInputsSQL) {
        rows = [{
          generation: restoring ? mergedGeneration : rightGeneration,
          terminal: restoring ? second : terminal,
          control_partition: jobHome,
          owner_current: true,
        }];
        if (intent === 'merge')
          rows = [
            {
              generation: leftGeneration,
              terminal: first,
              control_partition: otherControlHome,
              owner_current: mode !== 'moved',
            },
            ...rows,
          ];
      } else if (sql === originals.sql) {
        originalReads++;
        const cursor = retiredScope ? selected : after;
        if (restoring) {
          expect(values).toEqual([mergedGeneration, cursor, 1, second, jobHome]);
          const next = [first, second].find((id) => cursor === null || id > cursor);
          rows = next ? [{ original: next, terminal: second }] : [];
        } else {
          const isLeft = values[0] === leftGeneration;
          const original = isLeft && mode !== 'materialized' ? first : terminal;
          expect(values).toEqual([values[0], cursor, 1, isLeft ? first : terminal, isLeft ? otherControlHome : jobHome]);
          rows =
            mode === 'empty' ||
            mode === 'changed' ||
            (cursor !== null && original <= cursor) ||
            ((mode === 'materialized' || (canonicalTerms && !completeMerge)) && isLeft)
              ? []
              : [{ original, terminal: original }];
        }
      } else if (sql === readSearchIdentityMaterializedOriginalSql) {
        expect(values).toEqual([jobHome, jobId, retiredScope ? selected : after]);
        rows = mode === 'materialized' ? [{ original: first, previous_terminal: first, terminal: terminal }] : [];
      } else if (sql === searchIdentityOriginalPlanPresentSql) {
        rows = retainedPlan ? [{}] : [];
      } else if (sql === locateSearchIdentityOriginalPlanSql) {
        rows = retainedPlan ? [{ plan_id: retainedPlan.source.locator.planId, original_barrier: true }] : [];
      } else if (sql === readSearchIdentityOriginalPlanSql) {
        expect(values).toEqual([
          writerHome,
          jobId,
          savedJob.epoch,
          ['OLD', 'NEW', 'first-apply', 'handoff'].map(
            (disposition) => `search_directory_probe_subjects_g1:${selected}:${disposition}`,
          ),
          selected,
          index,
        ]);
        planReads++;
        rows = retainedPlan ? [retainedPlan] : [];
      } else if (sql === readSearchIdentityWriterAdmissionSql) {
        expect(values).toEqual([
          writerHome, jobId, savedJob.epoch, scopeSteps()[0]?.transactionId, directoryScope, selected,
        ]);
        const step = scopeSteps().find((step) => step.frontier.after[0] === 'search-writer-admitted');
        rows = step ? [{ transaction_id: step.transactionId, frontier: step.frontier, proven: true }] : [];
      } else if (sql === recheckSearchIdentityWriterAdmissionSql) {
        const step = scopeSteps().find((item) => item.frontier.after[0] === 'search-writer-admitted');
        expect(values).toEqual([
          writerHome,
          step?.transactionId,
          jobId,
          savedJob.epoch,
          directoryScope,
          JSON.stringify(step?.frontier.after),
        ]);
        rows = step ? [{}] : [];
      } else if (sql === readSearchIdentityWriterSupportSql) {
        const requestId = values[4] === 'binding' ? dispatchRequest?.transactionId : scopeSteps()[0]?.transactionId;
        expect(values.slice(0, 4)).toEqual([writerHome, jobId, savedJob.epoch, requestId]);
        const step = committed.findLast(
          (step) => step.frontier.after[0] === 'search-writer-support' && step.frontier.after[1] === requestId && step.frontier.after[2] === values[4],
        );
        const frontier = changedBindingProof && values[4] === 'binding'
          ? { ...step!.frontier, after: [...step!.frontier.after.slice(0, 4), '0'.repeat(64)] }
          : step?.frontier;
        rows = step ? [{ transaction_id: step.transactionId, frontier, proven: true }] : [];
      } else if (sql === releaseRead.sql || sql === releaseExists.sql) {
        expect(values).toEqual(['0', bundledDigest]);
        rows = [[sql === releaseRead.sql ? JSON.stringify(bundledRelease) : bundledDigest]];
      } else if (sql === sourceRegister.sql) {
        expect(values).toEqual([routeDigest]);
        rows = [[sourceId, sourceConfig, '1']];
      } else if (sql === sourceDefine.sql) {
        capture = values.find((value): value is string => typeof value === 'string' && value.startsWith('["object"'));
        dependencies =
          values.find((value): value is string => typeof value === 'string' && value.startsWith('[{"kind"')) ?? '[]';
        expect(capture).toBeDefined();
        rows = [[definitionId]];
      } else if (sql === definitionRead.sql) {
        expect(values[0]).toBe(definitionId);
        const captureBytes = Buffer.byteLength(capture!) + Buffer.byteLength(dependencies!);
        rows = [
          [sourceId, sourceConfig, '1', routeDigest, bundledDigest, capture!, dependencies!, String(captureBytes)],
        ];
      } else if (nativePermission && sql === permissionTime['~standard'].query.text) {
        permissionTimes++;
        const at = new Date().toISOString();
        rows = typeof input !== 'string' && input.rowMode === 'array' ? [[at, at]] : [{ at, databaseAt: at }];
      } else if (nativePermission && sql === subjectEligibility.sql) {
        expect(values[0]).toBe((values[1] === first ? writerHome : terminalHome) << 4);
        expect([first, terminal]).toContain(values[1]);
        rows = [{ visibility: values[1] === terminal || bothVisible ? 'visible' : 'hidden', security_revision: '1' }];
      } else if (nativePermission && sql === relatedVisibility.sql) {
        expect(bothVisible).toBe(true);
        visibilityFloorReads++;
        const ids = [first, terminal].filter((id) => String(values[2]).includes(id));
        const home = Number(values[0]);
        expect(ids).toEqual([first, terminal].filter((id) => (id === first ? writerHome : terminalHome) === home));
        expect(ids.length).toBeGreaterThan(0);
        rows = ids.map((id) => [id, 'visible']);
      } else if (nativePermission && sql === permissionFormula['~standard'].query.text) {
        permissionFormulas++;
        const ids = String(values[permissionFormula.params.indexOf('resource_ids')]);
        const resources = visibleSubjects().filter((id) => ids.includes(id));
        expect(resources.length).toBeGreaterThan(0);
        if (permissionFormulas === 1) {
          expect(anonymousSubjectFormulaBound(values)?.points).toBe(1);
          for (const [name, argument] of [
            ['include_global', 't'],
            ['actor_id', terminal],
            ['assignment_request_id', terminal],
            ['roles', '[{}]'],
          ] as const) {
            const wider = [...values];
            wider[permissionFormula.params.indexOf(name)] = argument;
            expect(anonymousSubjectFormulaBound(wider)).toBeNull();
          }
        }
        const at = new Date().toISOString();
        const batch = values[permissionFormula.params.indexOf('batch')] === 't';
        if (batch) {
          permissionBatches++;
          expect(resources).toEqual([first, terminal]);
          expect(anonymousSubjectFormulaBound(values)?.points).toBe(1);
        }
        const decisions = resources.map((resourceId) => ({
          resourceId,
          allowed: !batch,
          governanceReach: false,
          explicit: false,
          publicAllowed: true,
          assignmentValid: true,
          deadlineLive: true,
          localDenied: false,
          actorActionGrant: false,
          actorResourceRoleGrant: false,
          actorOwnAccountGrant: false,
          actorAuthenticatedBenefitGrant: false,
          principalActionGrant: false,
          principalResourceRoleGrant: false,
          principalOwnAccountGrant: false,
          principalAuthenticatedBenefitGrant: false,
          globalDenied: null,
          globalActorActionGrant: null,
          globalActorResourceRoleGrant: null,
          globalActorOwnAccountGrant: null,
          globalActorAuthenticatedBenefitGrant: null,
          globalPrincipalActionGrant: null,
          globalPrincipalResourceRoleGrant: null,
          globalPrincipalOwnAccountGrant: null,
          globalPrincipalAuthenticatedBenefitGrant: null,
          explicitLocalDenied: null,
          explicitActorActionGrant: null,
          explicitActorResourceRoleGrant: null,
          explicitActorOwnAccountGrant: null,
          explicitActorAuthenticatedBenefitGrant: null,
          explicitPrincipalActionGrant: null,
          explicitPrincipalResourceRoleGrant: null,
          explicitPrincipalOwnAccountGrant: null,
          explicitPrincipalAuthenticatedBenefitGrant: null,
          explicitGlobalDenied: null,
          explicitGlobalActorActionGrant: null,
          explicitGlobalActorResourceRoleGrant: null,
          explicitGlobalActorOwnAccountGrant: null,
          explicitGlobalActorAuthenticatedBenefitGrant: null,
          explicitGlobalPrincipalActionGrant: null,
          explicitGlobalPrincipalResourceRoleGrant: null,
          explicitGlobalPrincipalOwnAccountGrant: null,
          explicitGlobalPrincipalAuthenticatedBenefitGrant: null,
          at,
          live: true,
        }));
        rows =
          typeof input !== 'string' && input.rowMode === 'array'
            ? decisions.map((decision) =>
                Object.values(decision).map((value) => (typeof value === 'boolean' ? (value ? 't' : 'f') : value)),
              )
            : decisions;
      } else if (sql === visibilityRead.sql || sql === visibilityRead['~standard'].query.text) {
        rows = [[visible && (values[1] === terminal || bothVisible) ? 'visible' : 'hidden', '1', subjectType]];
      } else if (visible && sql === mappingOwners.sql)
        rows = (values[0] as number[]).map((partition_no) => ({
          partition_no,
          epoch: 1,
          position: '0',
          write_state: 'active',
        }));
      else if (visible && sql === mappingSources.sql) {
        rows = (values[0] as string[]).map((id) => {
          const creator = creditedCreator && id === relationTarget;
          expect(creator || id === terminal || (bothVisible && id === first)).toBe(true);
          return {
            subject_id: id,
            original: id,
            control_partition: creator ? otherControlHome : jobHome,
            control_group: creator ? relationTarget : terminal,
            terminal: creator ? relationTarget : terminal,
            current_target: id === first && !restoring ? terminal : null,
            epoch: savedJob.epoch,
            owner_epoch: 1,
            dirty_revision: '0',
            captured_revision: '0',
            closure_state: 'legacy',
          };
        });
      } else if (visible && sql === mappingPending.sql)
        rows =
          creditedCreator && (values[1] as string[])[0] === relationTarget
            ? []
            : [{ partition_no: jobHome, terminal, pending_job: jobId, pending_epoch: savedJob.epoch }];
      else if (visible && sql === mappingCurrent.sql)
        rows =
          creditedCreator && (values[1] as string[])[0] === relationTarget
            ? [
                {
                  partition_no: otherControlHome,
                  terminal: relationTarget,
                  requested_original: relationTarget,
                  owner_epoch: 1,
                  closure_state: 'open',
                  redirected: false,
                  published_epoch: '1',
                },
              ]
            : (values[2] as string[]).map((original) => ({
                partition_no: jobHome,
                terminal,
                requested_original: original,
                owner_epoch: 1,
                closure_state: 'open',
                redirected: false,
              }));
      else if (sql === verifyCompletedPublicFilterProjectionSql) {
        const original = values[2] === first && bothVisible && !restoring;
        const home = original ? writerHome : terminalHome;
        const build = original ? retainedOriginalBuild : retainedBuild;
        expect(values).toEqual([
          home,
          home << 4,
          original ? first : terminal,
          build,
          newGeneration,
          1,
          bundledDigest,
          terminal,
          (crossHome ? projectionDependencyHomes.get(build!) : dependencyHomes)?.at(-1),
        ]);
        rows = mode === 'changed-proof' || !canonicalBuildCurrent || (!original && !terminalBuildCurrent) ? [] : [{}];
      } else if (canonicalTerms && sql === readIdentitySearchIndexTermSlotShapeSql) {
        const prior = scopeSteps().findLast((step) => step.frontier.after[2] === 'terms')?.frontier.after[6] ?? null;
        expect(values).toEqual([writerHome << 4, terminal, prior]);
        termReads.push(prior);
        const next = termSlots[termReads.length - 1];
        rows = [{ prior_current: true, slot_id: next?.slot_id ?? null, fact_limit: next?.terms.length ?? 0 }];
      } else if (canonicalTerms && sql === readIdentitySearchIndexTermSlotSql) {
        const next = termSlots[termReads.length - 1];
        expect(values).toEqual([writerHome << 4, terminal, termReads.at(-1), next?.terms.length]);
        rows = [{ prior_current: true, slot_id: null, ...next, fact_count: next?.terms.length ?? 0 }];
      } else if (canonicalTerms && sql === readIdentitySearchIndexTermsSql) {
        const creator = creditedCreator && values[1] === relationTarget;
        expect(values).toEqual(creator ? [otherControlHome << 4, relationTarget, 4] : [writerHome << 4, terminal, 8]);
        rows = creator
          ? creatorNamesOpen
            ? [{ state: 'pending', remaining: 0 }]
            : [
                {
                  kind: 'label',
                  slot_id: creatorNameSlot,
                  language: 'en',
                  state: 'progress',
                  terms: [creatorRenamed ? 'Renamed director' : 'Public credited director'],
                },
                { state: 'complete', remaining: 0 },
              ]
          : [
              ...termSlots.map((slot) => ({
                ...slot,
                ...(changedTermReplay && slot.kind === 'label' && { terms: ['Changed canonical name'] }),
                language: 'en',
                state: 'progress',
              })),
              { state: 'complete', remaining: 0 },
            ];
      } else if (creditedCreator && sql === readCreatorTermBudgetSql) {
        expect(values).toEqual([otherControlHome << 4, relationTarget]);
        rows = [{ current_facts: 1 }];
      } else if (canonicalTerms && sql === readCanonicalStatementPresenceSql) {
        expect(values).toEqual([writerHome << 4, terminal]);
        rows = adoptedName || adoptedRelation || selectionOverflow ? [{}] : [];
      } else if (canonicalTerms && sql === readCanonicalStatementCountSql) {
        expect(values).toEqual([writerHome << 4, terminal]);
        rows = [
          { count: selectionOverflow ? SEARCH_INDEX_STATEMENT_KEYS + 1 : Number(adoptedName || adoptedRelation) },
        ];
      } else if ((adoptedName || adoptedRelation) && sql === readCanonicalStatementsSql) {
        expect(values).toEqual([writerHome << 4, terminal, 1, adoptedRelation ? relationRoster : []]);
        rows = [
          {
            route: writerHome << 4,
            subject_id: terminal,
            slot_id: nameSlot,
            candidate_id: nameCandidate,
            property: selectedProperty,
            rank: 'preferred',
            ordinal: 1,
            revision: 1,
            compact: true,
            release: bundledDigest,
            relation: adoptedRelation,
            eligible: adoptedRelation,
            source: null,
            oversized_source: false,
            concealed: !nameDisclosed,
            body: nameDisclosed ? selectedBody : null,
          },
        ];
      } else if ((adoptedName || creditedCreator) && sql === candidateProvenance.sql) {
        const args = {
          routes: [writerHome << 4],
          subjects: [terminal],
          candidates: [nameCandidate],
          slots: [nameSlot],
          max_bytes: SEARCH_INDEX_PROVENANCE_BYTES,
        };
        expect(values).toEqual(candidateProvenance.params.map((key) => args[key as keyof typeof args]));
        rows = [
          {
            subject_id: terminal,
            id: nameCandidate,
            source: creditedCreator ? null : importedName,
            source_bytes: creditedCreator ? 0 : Buffer.byteLength(JSON.stringify(importedName)),
          },
        ];
      } else if (adoptedName && sql === sourceFences.sql) {
        expect(values).toEqual(
          sourceFences.params.map((key) =>
            key === 'partition' ? partitionOf(nameTuple.route) : JSON.stringify([nameTuple]),
          ),
        );
        rows = nameFenced ? [{ ...nameTuple, takenDown: true, securityRevision: '1' }] : [];
      } else if (canonicalTerms && sql === activeDefinition.sql) {
        expect(values).toEqual(['0']);
        rows = [[bundledDigest, '1']];
      } else if (canonicalTerms && sql === publicFigures.sql) {
        expect(values).toContain(String(writerHome));
        rows = [
          [
            STANDARD_QUESTION_ID,
            GLOBAL_CONTEXT_RESOURCE.id,
            terminal,
            '5',
            '0.8',
            '0.7',
            '0.4',
            '8',
            '3',
            '2',
            '2026-01-01T00:00:00Z',
            '19',
          ],
        ];
      } else if (canonicalTerms && sql === listingCounts.sql) {
        expect(values[0]).toBe(String(writerHome));
        rows = [[terminal, activeCollectionCount]];
      } else if (visible && sql === projectionRelease.sql) rows = [[bundledDigest, JSON.stringify(bundledRelease)]];
      else if (sql === projectionSubjects.sql) {
        if (adoptedRelation && String(values[2]).includes(relationTarget))
          rows = [
            [
              String(otherControlHome << 4),
              relationTarget,
              creditedCreator ? 'schema:Person' : 'skos:Concept',
              relationHidden ? 'hidden' : 'visible',
              creatorRenamed ? '2' : '1',
              bundledDigest,
              targetRedirect,
              't',
              '1',
            ],
          ];
        else if (adoptedRelation && String(values[2]).includes(relationTerminal))
          rows = [
            [String(jobHome << 4), relationTerminal, 'skos:Concept', 'hidden', '1', bundledDigest, null, 't', '1'],
          ];
        else if (!restoring && String(values[2]).includes(first)) {
          const visibility = bothVisible ? 'visible' : 'hidden';
          rows = [[String(writerHome << 4), first, subjectType, visibility, '1', bundledDigest, terminal, 't', '1']];
        } else {
          const visibility = visible ? 'visible' : 'hidden';
          rows = [[String(terminalHome << 4), terminal, subjectType, visibility, '1', bundledDigest, null, 't', '1']];
        }
      } else if (visible && sql === projectionPrivacy.sql) rows = [['0']];
      else if (visible && sql === projectionPage.sql) {
        rows =
          adoptedRelation && values[projectionPage.params.indexOf('after_property')] === ''
            ? [
                [
                  String(writerHome << 4),
                  terminal,
                  nameSlot,
                  nameCandidate,
                  selectedProperty,
                  'normal',
                  '1',
                  '1',
                  JSON.stringify(selectedBody),
                  bundledDigest,
                  null,
                  't',
                  null,
                  't',
                ],
              ]
            : [];
      } else if (visible && sql === lockProjectionBuildForRetirementSql)
        rows = mode === 'retire' || (completeMerge && canonicalTerms && values[1] === terminal && oldHeads.length)
          ? [{ build_id: oldBuild, generation: oldGeneration, meaning_digest: oldMeaning }] : [];
      else if (visible && sql === retireProjectionHeadSql) {
        expect(values).toEqual([oldBuild]);
        const partition = oldHeads.shift();
        rows = partition === undefined ? [] : [{ partition_no: partition }];
      } else if (visible && sql === invalidateProjectionBuildSql) {
        expect(values).toEqual([oldBuild, oldGeneration, retiredProjectionMeaning]);
        oldGeneration = String(Number(oldGeneration) + 1);
        oldMeaning = retiredProjectionMeaning;
        rows = [{ generation: oldGeneration }];
      } else if (visible && sql === lockProjectionBuildForHeadsSql) {
        expect([retainedBuild, retainedOriginalBuild]).toContain(values[0]);
        expect(values.slice(1)).toEqual([newGeneration, retiredProjectionMeaning]);
        rows = [{}];
      } else if (visible && sql === projectionStart.sql) {
        const build = String(values[4]);
        const original = bothVisible && !restoring && values[projectionStart.params.indexOf('subject_id')] === first;
        if (original) retainedOriginalBuild = build;
        else retainedBuild = build;
        rows = [[build, newGeneration, String((original ? writerHome : terminalHome) << 4)]];
      } else if (visible && sql === projectionBuild.sql) {
        readBuilds++;
        const original = bothVisible && !restoring && values[projectionBuild.params.indexOf('subject_id')] === first;
        const build = original ? retainedOriginalBuild : retainedBuild;
        const route = String((original ? writerHome : terminalHome) << 4);
        rows =
          mode === 'superseded' && readBuilds === 3
            ? []
            : [[build, newGeneration, route, '1', '0', '0', terminal, '1', '1', bundledDigest]];
      } else if (visible && sql === projectionHeads.sql) {
        const heads = JSON.parse(String(values[projectionHeads.params.indexOf('heads')])) as { partition_no: number }[];
        if (crossHome) {
          const build = String(values[projectionHeads.params.indexOf('build_id')]);
          const saved = projectionDependencyHomes.get(build) ?? [];
          const homes = [...saved, ...heads.map(({ partition_no }) => partition_no)];
          projectionDependencyHomes.set(build, [...new Set(homes)].sort((a, b) => a - b));
        }
        rows = heads.map(({ partition_no }) => [String(partition_no)]);
      } else if (visible && sql === projectionHeadPage.sql) {
        expect(values[2]).toBe('1');
        projectionHeadCursors.push(String(values[1]));
        const homes = crossHome ? projectionDependencyHomes.get(String(values[0]))! : dependencyHomes;
        const next = homes.find((home) => Number(values[1]) < home);
        rows = next ? [[String(next), '1', '0']] : [];
      } else if (visible && sql === projectionCurrentHead.sql) rows = [['0', '1', 'active']];
      else if (sql === readSearchIdentityHomePendingSql) {
        expect(values).toEqual([writerHome, index]);
        rows = retainedPlan ? [{}] : [];
      } else if (sql === lockPublicationFence || sql === advanceWriterPublicationAdmissionSql) {
        expect(values).toEqual([index]);
        publicationWrites.push(sql);
        rows = [{}];
      } else if (sql === lockSearchIdentityOriginalSql) {
        expect(values).toEqual([writerHome, index, selected]);
        rows =
          mode === 'uncertain'
            ? [
                {
                  incarnation: 'allocation',
                  owner_epoch: 1,
                  writer_token: crypto.randomUUID(),
                  dispatch_state: 'dispatched',
                  closed_transaction_id: null,
                },
              ]
            : priorVisible
              ? restoring ? [predecessorWriter!] : [
                  {
                    incarnation: 'allocation',
                    owner_epoch: 1,
                    writer_token: null,
                    dispatch_state: 'settled',
                    source_position: '9',
                    visible_transaction_id: crypto.randomUUID(),
                    visible_position: '10',
                    closed_job: previousJob,
                    closed_epoch: '1',
                    closed_transaction_id: previousClose,
                    repair_locator: previousPlan,
                  },
                ]
              : [];
      } else if (sql === readSearchIdentityPredecessorSql) {
        expect(values).toEqual([
          writerHome,
          index,
          selected,
          previousPlan,
          previousJob,
          '1',
          previousClose,
          jobHome,
          1,
        ]);
        predecessorReads++;
        if (restoring) {
          const prior = retiredOriginals.find(({ original, planId, writer }) =>
            original === values[2] && planId === values[3] &&
            writer.closed_job === values[4] && writer.closed_epoch === values[5] &&
            writer.closed_transaction_id === values[6],
          );
          expect(prior?.release).toEqual(expect.any(String));
          expect(prior?.application).toEqual(expect.any(String));
          rows = publishedMerge && prior ? [{ plan_id: prior.planId }] : [];
        } else rows = [{ plan_id: previousPlan }];
      } else if (sql === prepareSearchIdentityOriginalSql) {
        const closePosition = writerHome === jobHome ? String(controlPosition + 1) : originPosition(21);
        expect(values.slice(0, 9)).toEqual([
          writerHome,
          index,
          selected,
          'allocation',
          1,
          jobId,
          savedJob.epoch,
          expect.any(String),
          closePosition,
        ]);
        expect(values[11]).toBe(priorVisible ? previousClose : null);
        retainedAction = String(values[10]);
        expect(JSON.parse(retainedAction)).toEqual({
          op: canonicalTerms ? 'index' : 'delete',
          id: selected,
          version: { nativeBigint: closePosition },
          ...(canonicalTerms && { document: expect.objectContaining(canonicalDocument()) }),
        });
        preparedWriter = {
          consumer: 'search_directory_probe_subjects_g1',
          incarnation: 'allocation',
          owner_epoch: 1,
          write_alias: alias,
          enrollment_generation: '0',
          fence_generation: '0',
          closed_token: null,
          writer_token: null,
          closed_job: jobId,
          closed_epoch: savedJob.epoch,
          closed_transaction_id: String(values[7]),
          closed_position: closePosition,
          repair_locator: String(values[9]),
        };
        rows = [{ original_id: selected }];
      } else if (sql === readSearchIdentityDispatchBasisSql) {
        expect(values).toEqual([
          writerHome,
          retainedPlan?.source.locator.planId,
          jobId,
          savedJob.epoch,
          index,
          selected,
          directoryScope,
        ]);
        rows =
          retainedPlan && hold
            ? [
                {
                  hold_id: hold!.hold_id,
                  source: retainedPlan.source,
                  obligations: retainedPlan.references,
                  effect_key: retainedPlan.effect_key,
                  action_digest: createHash('sha256').update(retainedAction!).digest('hex'),
                  action_bytes: Buffer.byteLength(retainedAction!),
                  accepted_epoch: hold!.accepted_epoch,
                  accepted_position: hold!.accepted_position,
                  accepted_transaction_id: hold!.accepted_transaction_id,
                  applied_transaction_id: committedOperation?.applied_transaction_id ?? null,
                  applied_position: committedOperation?.applied_position ?? null,
                  state: committedOperation?.state ?? null,
                  visible: committedOperation?.state === 'visible' || committedOperation?.state === 'applied',
                  released: receivingContinuation.state === 'released',
                },
              ]
            : [];
      } else if (sql === readBoundedSearchIdentityActionSql || sql === readBoundedSearchIdentityReceiptSql) {
        const body = sql === readBoundedSearchIdentityActionSql ? retainedAction : receiptText;
        expect(values).toEqual([writerHome, index, selected, Buffer.byteLength(body!)]);
        rows = [{ value: body, repair_locator: retainedPlan?.source.locator.planId }];
      } else if (sql === dispatchSearchIdentityOriginalSql) {
        expect(values.slice(0, 4)).toEqual([writerHome, index, selected, retainedPlan?.source.locator.planId]);
        Object.assign(preparedWriter!, {
          writer_token: values[4],
          writer_transaction_id: values[5],
          writer_position: values[6],
          dispatch_state: 'dispatched',
          changed_in_command: true,
        });
        rows = [{}];
      } else if (sql === readSearchIdentityPlanBodySizeSql) {
        const plan = retainedPlan!;
        rows = [
          {
            bytes: Buffer.byteLength(JSON.stringify(plan.source)) + Buffer.byteLength(JSON.stringify(plan.references)),
          },
        ];
      } else if (sql === planSql.plan.sql || sql === sizedSearchIdentityPlanSql()) {
        expect(values.slice(0, 2)).toEqual([writerHome, retainedPlan?.source.locator.planId]);
        const plan = retainedPlan!;
        rows = [
          {
            source: plan.source,
            obligations: plan.references,
            scope_digest: directoryScope,
            action_digest: createHash('sha256').update(retainedAction!).digest('hex'),
            job_id: jobId,
            job_epoch: savedJob.epoch,
            effect_key: plan.effect_key,
            transaction_id: plan.source.plan.transactionId,
            initial_copy_count: priorVisible ? 1 : 0,
            native_epoch: 1,
            native_position: writerClosePosition(),
          },
        ];
      } else if (sql === planSql.hold.sql || sql === planSql.peekHold.sql) rows = hold ? [{ ...hold }] : [];
      else if (sql === planSql.accepted.sql) {
        expect(values[6]).toBe(hold?.accepted_transaction_id);
        expect(acceptedRecorded).toBe(true);
        rows = [{ epoch: 1, position: acceptedRecordPosition }];
      } else if (sql === planSql.operation.sql || sql === searchNativeOriginalOperationSql())
        rows = committedOperation ? [committedOperation] : [];
      else if (sql === planSql.dispatch.sql) {
        expect(values[3]).toBe(hold?.hold_id);
        writingOperation = {
          operation_id: String(values[2]),
          hold_id: hold!.hold_id,
          state: 'dispatched',
          writer_token: String(values[4]),
          writer_locator: String(values[8]),
          writer_transaction_id: String(values[5]),
          writer_position: String(values[6]),
          dispatch_transaction_id: String(values[7]),
          dispatch_epoch: 1,
          dispatch_position: writerHome === jobHome ? String(controlPosition + 1) : originPosition(31),
          visible_transaction_id: null,
          visible_position: null,
          writer_evidence_digest: null,
          visibility_component: null,
          applied_transaction_id: null,
          applied_position: null,
          frontier: null,
        };
        rows = [{ operation_id: writingOperation.operation_id }];
      } else if (sql === searchIdentityWriterSettlementSql()) {
        expect(values.slice(4, 8)).toEqual([
          committedOperation?.writer_token,
          committedOperation?.dispatch_transaction_id,
          committedOperation?.dispatch_position,
          [selected],
        ]);
        expect(values[10]).toBe(writerClosePosition());
        Object.assign(preparedWriter!, {
          writer_token: null,
          dispatch_state: 'settled',
          changed_in_command: true,
          settled_transaction_id: values[8],
          settled_position: values[9],
          visible_transaction_id: values[8],
          visible_position: values[9],
          source_position: values[10],
        });
        rows = [{}];
      } else if (sql === retainSearchIdentityWriterReceiptSql) {
        receiptText = String(values[4]);
        rows = [{}];
      } else if (sql === retainSearchIdentityBulkResponseSql) {
        expect(values.slice(0, 7)).toEqual([
          writerHome,
          index,
          selected,
          retainedPlan?.source.locator.planId,
          hold?.hold_id,
          committedOperation?.operation_id,
          committedOperation?.writer_token,
        ]);
        writingBulk = JSON.parse(String(values[7]));
        expect(writingBulk?.kind).toBe('identity-original-bulk');
        rows = [{}];
      } else if (sql === readSearchIdentityBulkResponseSql) {
        expect(values).toEqual([writerHome, index, selected, retainedPlan?.source.locator.planId, hold?.hold_id]);
        const bulk = corruptReceipt
          ? { errors: false, items: [{ delete: { _index: index, _id: selected, _version: 22, status: 200 } }] }
          : retainedBulk?.bulk;
        rows = retainedBulk ? [{ ...committedOperation, bulk }] : [];
      } else if (sql === planSql.visible.sql) {
        expect(values[2]).toBe(committedOperation?.operation_id);
        expect(values[5]).toBe(createHash('sha256').update(receiptText!).digest('hex'));
        writingOperation = {
          ...committedOperation!,
          state: 'visible',
          visible_transaction_id: String(values[3]),
          visible_position: String(values[4]),
          visibility_component: String(values[4]),
          writer_evidence_digest: String(values[5]),
        };
        rows = [{ operation_id: writingOperation.operation_id }];
      } else if (
        sql === receivingSelection.sql ||
        sql === receivingStatements.existingPlan ||
        sql === receivingStatements.completedStep ||
        sql === receivingStatements.acceptedReplay
      )
        rows = [];
      else if (sql === receivingProgressRead.sql) rows = [{ ...receivingContinuation }];
      else if (sql === planSql.copies.sql || sql === planSql.copy.sql) {
        const selected = sql === planSql.copy.sql ? values[2] === 0 : Number(values[2]) < 0;
        rows =
          copyLocator && selected
            ? [
                {
                  copy_no: 0,
                  locator: copyLocator,
                  reconciled_transaction_id: reconciledCopy ?? null,
                  settlement: copySettlement ?? null,
                  proven: true,
                },
              ]
            : [];
      } else if (sql === planSql.pending.sql) rows = copyLocator && !reconciledCopy ? [{ copy_no: 0 }] : [];
      else if (sql === planSql.reconcile.sql) {
        expect(values[2]).toBe(0);
        copySettlement = JSON.parse(String(values[4]));
        expect(copySettlement).toEqual({
          partition: writerHome,
          epoch: 1,
          position: committedOperation?.visible_position,
          transactionId: committedOperation?.visible_transaction_id,
        });
        reconciledCopy = String(values[3]);
        rows = [{ copy_no: 0 }];
      } else if (sql === receivingProgressAdvance.sql) {
        expect(String(values[5])).toBe(receivingContinuation.revision);
        writingContinuation = {
          ...receivingContinuation,
          revision: String(Number(receivingContinuation.revision) + 1),
          after_key: String(values[6]),
          state: values[7] as Progress['state'],
          applied_transaction_id: String(values[8]),
        };
        rows = [{ revision: writingContinuation.revision }];
      } else if (sql === receivingStatements.expectedApplied)
        rows = [
          {
            native_partition: controlApplied?.[4] ?? null,
            native_epoch: controlApplied?.[5] ?? null,
            native_position: controlApplied?.[6] ?? null,
            native_transaction_id: controlApplied?.[7] ?? null,
          },
        ];
      else if (sql === receivingStatements.acknowledgeApplied) {
        expect(values.slice(4)).toEqual([
          writerHome,
          1,
          committedOperation?.applied_position,
          committedOperation?.applied_transaction_id,
        ]);
        if (foreignCapture) {
          expect(values[0]).toBe(jobHome);
          captureQueue.push({
            store: 'identity_epoch_effect_receipt',
            partition: jobHome,
            transactionId: admissionTransaction,
            armed: false,
          });
        }
        controlApplied = values;
        rows = [{}];
      } else if (sql === receivingStatements.controlCustody || sql === planSql.control.sql)
        rows = controlCustody ? [controlCustody] : [];
      else if (sql === receivingStatements.insertCustody) {
        if (foreignCapture) {
          expect(values[0]).toBe(jobHome);
          expect(values[3]).toBe(captureNativeTransaction);
          captureQueue.push({
            store: 'identity_epoch_receiving_custody',
            partition: jobHome,
            transactionId: String(values[3]),
            armed: false,
          });
        }
        writingCustody = {
          epoch: 1,
          position: String(Number(nativePosition()) + 1),
          transaction_id: String(values[3]),
        };
        rows = [{}];
      } else if (sql === searchNativeReleaseAppliedSql()) {
        expect(values.slice(-2)).toEqual([committedOperation?.applied_transaction_id, hold?.hold_id]);
        rows = lateReleaseCheck ? [] : [{ epoch: 1, position: committedOperation?.applied_position }];
      } else if (sql === planSql.release.sql) {
        expect(controlCustody).toBeDefined();
        expect(values[2]).toBe(hold?.hold_id);
        writingHoldRelease = String(values[3]);
        releasePosition = String(Number(nativePosition()) + 1);
        rows = [{}];
      } else if (sql === planSql.releaseProof.sql) {
        const id = values[3] ? writingHoldRelease : hold?.released_transaction_id;
        rows = id ? [{ transaction_id: id, epoch: 1, position: releasePosition }] : [];
      } else if (sql === receivingProgressRelease.sql) {
        expect(values[7]).toBe(writingHoldRelease);
        writingContinuation = {
          ...receivingContinuation,
          state: 'released',
          revision: String(Number(receivingContinuation.revision) + 1),
          released_transaction_id: String(values[7]),
        };
        rows = [{ revision: writingContinuation.revision }];
      } else if (sql === advanceSearchIdentityOriginalSql) {
        expect(receivingContinuation.state).toBe('released');
        expect(values.slice(4, 8)).toEqual([
          selected,
          'search_directory_probe_subjects_g1',
          index,
          retainedPlan?.source.locator.planId,
        ]);
        expect(values.slice(8, 12)).toEqual([
          writerHome,
          1,
          committedOperation?.applied_position,
          committedOperation?.applied_transaction_id,
        ]);
        retiredScope = true;
        rows = [{}];
      } else if (sql === receivingLookup.sql)
        rows = [
          {
            binding: commonPlan?.binding,
            binding_digest: commonPlan?.binding_digest,
            owner_id: selected,
            owner_epoch: 1,
            native_epoch: 1,
            native_position: hold?.accepted_position,
            plan: { partition: jobHome, transactionId: commonPlan?.transaction_id, epoch: 1, position: commonPlan?.native_position },
            source_hold: {
              partition: writerHome,
              transactionId: hold?.accepted_transaction_id,
              epoch: 1,
              position: hold?.accepted_position,
            },
            native_hold: acceptedNativeHold,
            effect_transaction_id: committedOperation?.applied_transaction_id ?? null,
            effect_epoch: committedOperation?.state === 'applied' ? 1 : null,
            effect_position: committedOperation?.applied_position ?? null,
            frontier: committedOperation?.frontier,
          },
        ];
      else if (sql === receivingStatements.lookupGate) rows = [{ pending_job: jobId, pending_epoch: savedJob.epoch }];
      else if (
        sql === receivingStatements.insertApplied ||
        sql === receivingStatements.sameCommandApplied ||
        sql === planSql.applied.sql
      ) {
        if (foreignCapture && sql === receivingStatements.insertApplied) {
          expect(values[0]).toBe(writerHome);
          expect(values[3]).toBe(captureNativeTransaction);
          captureQueue.push({
            store: 'identity_epoch_receiving_effect',
            partition: writerHome,
            transactionId: String(values[3]),
            armed: false,
          });
        }
        rows = [{}];
      } else if (sql === planSql.apply.sql) {
        expect(values[2]).toBe(committedOperation?.operation_id);
        writingOperation = {
          ...committedOperation!,
          state: 'applied',
          applied_transaction_id: String(values[3]),
          frontier: JSON.parse(String(values[4])),
          applied_position: writerHome === jobHome ? String(controlPosition + 1) : String(applicationPosition()),
        };
        rows = [{ operation_id: writingOperation.operation_id }];
      } else if (sql === receivingJob.sql) {
        expect(readOnly).toBe(false);
        rows = [{ state: 'pending', scope_digest: directoryScope }];
      } else if (sql === receivingStatements.pendingJobScope) {
        expect(readOnly).toBe(true);
        rows = [{ scope_digest: directoryScope }];
      }
      else if (sql === receivingStatements.inputBasis)
        rows = [
          { control_partition: otherControlHome, terminal: selected, generation: leftGeneration, owner_epoch: 1 },
        ];
      else if (sql === revalidateSearchIdentityPlanFenceSql)
        rows = [{ epoch: 1, position: releaseOwnerAdvanced ? String(Number(nativePosition()) - 1) : nativePosition() }];
      else if (sql === readSearchIdentityPlanComponentSql) {
        lateReleaseCheck = releaseOwnerAdvanced;
        rows = [{}];
      } else if (foreignCapture && sql === receivingStatements.expectEffect) {
        expect(values[0]).toBe(jobHome);
        captureQueue.push({
          store: 'identity_epoch_effect_receipt', partition: jobHome, transactionId: admissionTransaction, armed: false,
        });
        rows = [{}];
      } else if (
        sql === receivingStatements.originalMembership ||
        sql === receivingStatements.retainGate ||
        sql === receivingStatements.expectEffect ||
        sql === receivingProgress.sql
      )
        rows = [{}];
      else if (sql === receivingStatements.insertPlan) {
        if (foreignCapture) {
          expect(values[0]).toBe(jobHome);
          expect(values[6]).toBe(captureNativeTransaction);
          captureQueue.push({
            store: 'identity_epoch_receiving_plan', partition: jobHome, transactionId: String(values[6]), armed: false,
          });
        }
        commonPlan = {
          binding: JSON.parse(String(values[4])),
          binding_digest: String(values[5]),
          transaction_id: String(values[6]),
          native_position: completeMerge ? String(controlPosition + 1) : originPosition(22),
        };
        rows = [{}];
      } else if (sql === receivingPlan.sql)
        rows = commonPlan ? [{ ...commonPlan, native_epoch: 1 }] : [];
      else if (sql === nativeDefinition.sql) {
        expect(values).toEqual([definitionId]);
        rows = [{ release_digest: bundledDigest, route_digest: routeDigest }];
      } else if (sql === planSql.copyOwner.sql)
        rows = [
          {
            ...preparedWriter,
            close_proven: true,
            epoch: 1,
            position: nativePosition(),
            writer_token: null,
          },
        ];
      else if (sql === planSql.accept.sql) {
        hold = {
          hold_id: String(values[2]),
          accepted_transaction_id: String(values[3]),
          accepted_epoch: null,
          accepted_position: null,
          released_transaction_id: null,
        };
        rows = [{ hold_id: hold.hold_id }];
      } else if (sql === receivingStatements.insertAccepted) {
        if (foreignCapture) {
          expect(values[0]).toBe(writerHome);
          expect(values[10]).toBe(captureNativeTransaction);
          captureQueue.push({
            store: 'identity_epoch_receiving_record',
            partition: writerHome,
            transactionId: String(values[10]),
            armed: false,
          });
        }
        acceptedNativeHold = JSON.parse(String(values[11]));
        expect(JSON.parse(String(values[11])).holdId).toBe(hold?.hold_id);
        acceptedRecorded = true;
        acceptedRecordPosition = writerHome === jobHome ? String(controlPosition + 1) : originPosition(22);
        rows = [{}];
      } else if (sql === planSql.bindAcceptance.sql) {
        expect(acceptedRecorded).toBe(true);
        Object.assign(hold!, { accepted_epoch: values[3], accepted_position: values[4] });
        rows = [{ hold_id: hold?.hold_id }];
      } else if (sql === planSql.owner.sql) {
        expect(values).toEqual([writerHome]);
        rows = [{ epoch: 1, position: nativePosition() }];
      } else if (sql === planSql.writer.sql) {
        expect(values).toEqual([writerHome, index, selected]);
        rows = preparedWriter ? [preparedWriter] : [];
      } else if (sql === planSql.document.sql) rows = [];
      else if (sql === planSql.insertCopies.sql) {
        const copies = JSON.parse(String(values[2]));
        copyLocator = copies[0];
        expect(copies).toEqual(
          priorVisible
            ? [
                expect.objectContaining({
                  original: selected,
                  state: 'settled',
                  enrollment: null,
                  visible: expect.objectContaining({
                    partition: writerHome,
                    epoch: 1,
                    position: restoring ? predecessorWriter?.visible_position : '10',
                  }),
                }),
              ]
            : [],
        );
        rows = [];
      } else if (sql === planSql.lock.sql) rows = [{ document_id: selected }];
      else if (sql === planSql.prepare.sql) {
        expect(values[11]).toBe(createHash('sha256').update(retainedAction!).digest('hex'));
        expect(values[13]).toBe(priorVisible ? 1 : 0);
        stagingPlan = {
          effect_key: String(values[7]),
          source: JSON.parse(String(values[9])),
          references: JSON.parse(String(values[10])),
          proven: true,
        };
        rows = [{ plan_id: values[1] }];
      } else if (locks.includes(sql)) {
        observedLocks.push(sql);
        if (sql === structuralGate.sql) rows = [{ pending_job: jobId, pending_epoch: savedJob.epoch }];
        else if (sql === readWriterPublicationWitness && (mode === 'existing' || mode === 'fenced' || engineReads > 1))
          rows = [{}];
        else if (sql === readPublicationFence && mode === 'fenced') rows = [{ publication_fence: crypto.randomUUID() }];
        else if (sql === writerSql.insertGate || (sql === writerSql.gate && (mode === 'existing' || engineReads > 1)))
          rows = [{ enrollment_generation: '0', fence_generation: '0', closed_token: null }];
        else if (sql === writerSql.original && priorVisible) {
          rows = restoring ? [predecessorWriter!]
            : [{ incarnation: 'allocation', owner_epoch: 1, closed_transaction_id: previousClose }];
        } else rows = [];
      } else if (sql === stepSql.sql || sql === completeSql.sql) {
        if (sql === completeSql.sql) expect(retiredScope).toBe(true);
        const work = JSON.parse(String(values[6]));
        writing = {
          transactionId: String(values[1]),
          frontier: JSON.parse(String(values[5])),
          engineRequests: work.engineRequests,
          ...(completeMerge && values[0] === jobHome && { position: String(controlPosition + 1), work, jobId }),
        };
        if (foreignCapture) {
          const sameHomeCheckpoint =
            values[0] === writerHome &&
            writerHome === jobHome &&
            ['search-writer-admitted', 'search-writer-support'].includes(String(writing.frontier.after[0]));
          expect(captureNativeTransaction).toBe(sameHomeCheckpoint ? null : writing.transactionId);
          captureQueue.push({
            store: 'identity_epoch_step',
            partition: Number(values[0]),
            transactionId: values[0] === jobHome ? admissionTransaction : writing.transactionId,
            armed: false,
          });
        }
        rows = [{ transaction_id: writing.transactionId }];
      } else if (foreignCapture && sql.startsWith("SELECT set_config('semantic.erasure_native_transaction'")) {
        captureNativeTransaction = String(values[0]);
        rows = [];
      } else if (foreignCapture && sql.startsWith('INSERT INTO semantic.erasure_source_role')) {
        if (values[0] === writerHome || values[0] === jobHome) {
          expect(values.slice(1)).toEqual([captureNativeTransaction, [actorId], ['actor']]);
          captureRole = { account_id: actorId!, role: 'actor' };
        }
        rows = [];
      } else if (captureQueue.length && sql === searchReceivingCaptureStatements.next) {
        // The expected effect uses the admission origin. Other records use their native transactions.
        const cursor = Number(values[0]);
        const event = captureQueue[cursor];
        rows = event
          ? [{
              ordinal: String(cursor + 1),
              partition_no: event.partition,
              store: event.store,
              record_key: String(cursor + 1),
              source_transaction_id: event.transactionId,
              native_transaction_id: captureNativeTransaction,
            }]
          : [];
      } else if (captureQueue.length && sql === searchReceivingCaptureStatements.copyFirst) {
        const cursor = captureQueue.findIndex((event) => !event.armed);
        const event = captureQueue[cursor]!;
        expect(values.slice(0, 3)).toEqual([event.partition, event.store, String(cursor + 1)]);
        expect([event.transactionId, captureNativeTransaction]).toContain(values[3]);
        rows = [];
      } else if (captureQueue.length && sql === searchReceivingCaptureStatements.sourceFirst) {
        const event = captureQueue.find((event) => !event.armed)!;
        expect(values[0]).toBe(event.partition);
        expect([event.transactionId, captureNativeTransaction]).toContain(values[1]);
        rows = captureRole && values[1] === captureNativeTransaction ? [captureRole] : [];
      } else if (captureQueue.length && sql === searchReceivingCaptureStatements.sourceNext) {
        expect(values.slice(1)).toEqual([captureNativeTransaction, actorId, 'actor']);
        rows = [];
      } else if (captureQueue.length && sql === searchReceivingCaptureStatements.basis) {
        const event = captureQueue.find((event) => !event.armed)!;
        expect(values[0]).toBe(event.partition);
        expect([event.transactionId, captureNativeTransaction]).toContain(values[1]);
        rows = values[1] === admissionTransaction ? [{ actor: true, delegated: false, requested_bytes: 0 }] : [];
      } else if (captureQueue.length && sql === searchReceivingCaptureStatements.arm) {
        const cursor = captureQueue.findIndex((event) => !event.armed);
        const event = captureQueue[cursor]!;
        const ordinal = String(cursor + 1);
        const admission = event.transactionId === admissionTransaction;
        const sources = captureRole ? 1 : 0;
        expect(values.slice(0, 5)).toEqual([ordinal, event.transactionId, captureNativeTransaction, 0, sources]);
        expect(values.slice(5, 9)).toEqual([admission ? 2 : null, admission ? 0 : null, null, null]);
        const digest = createHash('sha256')
          .update(`${'0'.repeat(64)}|source|${captureNativeTransaction}|${actorId}|actor`)
          .digest('hex');
        expect(values.slice(9)).toEqual(['0'.repeat(64), sources ? digest : '0'.repeat(64)]);
        if (interruptApplicationCapture && captureQueue.length === 2 && cursor === 1)
          return { rows: [], rowCount: 0 };
        event.armed = true;
        rows = [{ ordinal }];
      } else if (sql === 'COMMIT') {
        for (const event of captureQueue) expect(event.armed).toBe(true);
        capturedEvents.push(...captureQueue.splice(0));
        captureRole = undefined;
        captureNativeTransaction = null;
        if (writingSearchAck) {
          searchAcks.set(jobId, writingSearchAck);
          searchAckWrites++;
          writingSearchAck = undefined;
        }
        if (writing) committed.push(writing);
        if (stagingPlan) retainedPlan = stagingPlan;
        if (writingOperation) committedOperation = writingOperation;
        if (writingBulk) retainedBulk = writingBulk;
        writingBulk = undefined;
        if (writingContinuation) {
          receivingContinuation = writingContinuation;
          appliedPosition++;
        }
        if (writingCustody) controlCustody = writingCustody;
        if (writingHoldRelease && hold) hold = { ...hold, released_transaction_id: writingHoldRelease };
        writingContinuation = undefined;
        writingCustody = undefined;
        writingHoldRelease = undefined;
        writingOperation = undefined;
        stagingPlan = undefined;
        writing = undefined;
        rows = [];
      } else if (sql === 'ROLLBACK' && foreignCapture) {
        captureQueue.length = 0;
        captureRole = undefined;
        captureNativeTransaction = null;
        writing = undefined;
        writingOperation = undefined;
        writingSearchAck = undefined;
        rows = [];
      } else if (sql === nativeCommit.sql) rows = [{}];
      else if (actorId && sql.startsWith('SELECT l.account_id::text,l.role FROM semantic.identity_epoch_job j'))
        rows = [{ account_id: actorId, role: 'actor' }];
      else if (sql === commandNoEffect['~standard'].query.text) rows = [['1', nativePosition()]];
      else if (sql === commandFence['~standard'].query.text) {
        const partition = Number(values[commandFence.params.indexOf('partition_no')]);
        const position =
          completeMerge && partition === jobHome
            ? String(++controlPosition)
            : engineReads > 1
              ? String(Number(nativePosition()) + 1)
              : '1';
        rows = [['1', position]];
      }
      else if (sql === time['~standard'].query.text) rows = [['2026-01-01T00:00:00.000Z']];
      else if (
        sql.startsWith('SELECT l.account_id::text,l.role FROM semantic.identity_epoch_job j') ||
        sql.startsWith('INSERT INTO semantic.erasure_source_role') ||
        sql.startsWith("SELECT set_config('semantic.erasure_native_transaction'") ||
        sql.startsWith("SELECT set_config('semantic.identity_prearm_effect_job'") ||
        sql === searchReceivingCaptureStatements.next ||
        [
          'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
          'BEGIN ISOLATION LEVEL REPEATABLE READ',
          'BEGIN',
          'BEGIN ISOLATION LEVEL SERIALIZABLE',
          'COMMIT',
          'ROLLBACK',
          "SET LOCAL lock_timeout = '200ms'",
          searchReceivingCaptureStatements.enable,
        ].includes(sql) ||
        sql.startsWith('SET LOCAL statement_timeout')
      )
        rows = [];
      else throw new Error(`Unexpected driver query ${sql}`);
      return { rows, rowCount: rows.length };
    },
    release(error?: Error) {
      checkedOut = false;
      if (error) {
        discardedClients++;
        replaceClient = true;
        captureQueue.length = 0;
        captureRole = undefined;
        captureNativeTransaction = null;
        writing = undefined;
        writingOperation = undefined;
        writingSearchAck = undefined;
      }
    },
  };
  let client = { ...driver };
  pool.connect = (async () => {
    if (replaceClient) {
      client = { ...driver };
      replaceClient = false;
    }
    checkedOut = true;
    pool.emit('acquire', client);
    return client;
  }) as Pool['connect'];
  const search = {
    async request<T>(method: string, path: string, body?: unknown) {
      expect(checkedOut).toBe(false);
      expect(activeIdentitySourceConsumerMaintenance(pool)).toBeNull();
      if (canonicalTerms && path === `/${index}/_analyze`) {
        expect(method).toBe('POST');
        expect(body).toEqual({ text: ['Canonical name'], normalizer: 'name_key' });
        normalizationCalls++;
        return {
          status: 200,
          body: { tokens: [{ token: 'canonical name', position: 0, start_offset: 0, end_offset: 14 }] } as T,
        };
      }
      expect([method, path]).toEqual(['GET', `/${index}`]);
      engineReads++;
      if (unavailableAllocation) throw new Error('Synthetic allocation lookup lost');
      return {
        status: 200,
        body: {
          [index]: {
            settings: { index: { uuid: 'allocation' } },
            aliases: { [alias]: { is_write_index: true } },
          },
        } as T,
      };
    },
    async bulk<T>(lines: readonly unknown[], options?: { query?: Record<string, unknown> }) {
      expect(checkedOut).toBe(false);
      expect(activeIdentitySourceConsumerMaintenance(pool)).toBeNull();
      expect(committedOperation?.state).toBe('dispatched');
      const op = canonicalTerms ? 'index' : 'delete';
      submitted.push({ id: selected, operation: op });
      const target = { _index: alias, _id: selected, version: Number(writerClosePosition()), version_type: 'external' };
      expect(lines).toEqual(
        canonicalTerms ? [{ index: target }, expect.objectContaining(canonicalDocument())] : [{ delete: target }],
      );
      expect(options?.query).toMatchObject({ require_alias: true, refresh: 'wait_for' });
      bulkCalls++;
      if (mode === 'lost') throw new Error('Synthetic transport response lost');
      return {
        errors: false,
        ...(mode === 'dispatch' && { diagnostics: 'extra transport data'.repeat(1000) }),
        items: [
          {
            [op]: {
              _index: index,
              _id: selected,
              _version: Number(writerClosePosition()),
              _shards: { total: 1, successful: 1, failed: 0 },
              _seq_no: 1,
              _primary_term: 1,
              status: canonicalTerms ? 201 : bothVisible ? 404 : 200,
              result: canonicalTerms ? 'created' : bothVisible ? 'not_found' : 'deleted',
            },
          },
        ],
      } as T;
    },
  };
  const receiving = searchIdentityReceivingComposition({
    pool,
    search,
    prefix,
    routeKey,
    access: nativePermission
      ? createAccess({
          actions: new Map([['subject:read', { anonymous: true }]]),
          accountEvidence: () => null,
        })
      : ({
          authorize: visible ? async () => true : forbidden,
          authenticate: forbidden,
        } as never),
    clock: () => new Date(),
    identitySourceSupportReaderFactory: composeSearchNativePorts().createIdentitySourceSupportReader,
    work: searchReceivingProductionDeclaration(),
  });
  const step = createSearchIdentityEpochParticipant({ search, prefix, routeKey, receiving });
  const directoryStep = async () => {
    const progress = await withIdentitySourceConsumerMaintenance(
      { pool, env: {} },
      { deadline: Date.now() + 5000 },
      () => step(pool, job),
    );
    if (completeMerge) expect(identityEpochReceiptLocator(job, 'search-canonical-index', progress).ok).toBe(true);
    return progress;
  };
  async function driveOriginal() {
    const captureStart = capturedEvents.length;
    const rejectsUnpublishedHandoff = restoring && !publishedMerge;
    const result = directoryStep();
    const requestsWriter = [
      'input',
      'dispatch',
      'lost',
      'materialized',
      'existing',
      'fenced',
      'visible',
      'visible-cross-home',
      'foreign-step-capture',
      'complete-merge',
      'same-home-merge',
      'canonical-terms',
      'canonical-merge',
      'canonical-relation',
      'canonical-credit',
      'changed-proof',
      'retire',
      'superseded',
      'handoff',
      'uncertain',
      'first',
    ].includes(mode);
    if (!requestsWriter) {
      await expect(result).rejects.toThrow(
        mode === 'stale' || mode === 'changed'
          ? 'checkpoint changed'
          : mode === 'empty'
            ? 'no completed original'
            : 'closure is not current',
      );
      expect(directoryReads).toBe(mode === 'stale' ? 1 : 2);
      expect(originalReads).toBe(mode === 'empty' ? 2 : 0);
      expect(planReads).toBe(0);
      expect(committed).toEqual([]);
    } else {
      const progress = await result;
      expect(progress.state).toBe('more');
      expect(identityEpochReceiptLocator(job, 'search-canonical-index', progress).ok).toBe(true);
      expect(progress.frontier.after.slice(3, 5)).toEqual([SEARCH_IDENTITY_WRITER_REQUEST, selected]);
      expect(progress.work.engineRequests).toBe(0);
      expect(scopeSteps().map((step) => step.engineRequests)).toEqual([0]);
      expect(directoryReads).toBe(2);
      expect(originalReads).toBe(intent === 'merge' ? 2 : 1);
      expect(planReads).toBe(0);
      if (foreignCapture) {
        expect(capturedEvents.slice(captureStart)).toEqual([
          { store: 'identity_epoch_step', partition: jobHome, transactionId: admissionTransaction, armed: true },
        ]);
      }
      if (!resumed) {
        const prepare = createSearchIdentityWriterPreparation(receiving, {});
        if (completeMerge && !restoring) {
          if (firstMergeRequest) {
            await expect(prepare(pool, firstMergeRequest)).rejects.toThrow('no longer the retained current step');
            expect(engineReads).toBe(0);
          } else firstMergeRequest = progress.receipt;
        }
        await expect(
          withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline: Date.now() + 5000 }, () =>
            prepare(pool, progress.receipt),
          ),
        ).rejects.toThrow('requires the separate owner turn');
        const replay = await directoryStep();
        expect(replay.receipt).toEqual(progress.receipt);
        expect(replay.frontier).toEqual(progress.frontier);
        const stale = { ...progress.receipt, native: { ...progress.receipt.native, position: 2n } };
        await expect(prepare(pool, stale)).rejects.toThrow('no longer the retained current step');
        expect(engineReads).toBe(0);
        if (mode === 'fenced') {
          await expect(prepare(pool, progress.receipt)).rejects.toThrow('fenced for native publication');
          expect(committed).toHaveLength(1);
          expect(engineReads).toBe(1);
          expect(observedLocks).toEqual([
            structuralGate.sql,
            lockPublicationAdmission,
            readWriterPublicationWitness,
            readPublicationFence,
          ]);
          return;
        }
        expect(await prepare(pool, progress.receipt)).toEqual({
          state: 'progress',
          transactionId: scopeSteps()[1]?.transactionId,
        });
        expect(scopeSteps()[1]?.frontier.after).toEqual([
          'search-writer-admitted',
          progress.receipt.native.transactionId,
          selected,
          'allocation',
          alias,
          '0',
          '0',
          priorVisible ? previousClose : null,
        ]);
        expect(scopeSteps().map((step) => step.engineRequests)).toEqual([0, 1]);
        expect(engineReads).toBe(1);
        expect(observedLocks).toEqual(
          mode === 'existing'
            ? locks.filter(
                (statement) => statement !== insertWriterPublicationWitness && statement !== writerSql.insertGate,
              )
            : locks,
        );
        expect(await prepare(pool, progress.receipt)).toEqual({
          state: 'progress',
          transactionId: scopeSteps()[2]?.transactionId,
        });
        expect(scopeSteps()[2]?.frontier.after).toEqual([
          'search-writer-support',
          progress.receipt.native.transactionId,
          'definition',
          definitionId,
          bundledDigest,
        ]);
        const retiringHomes = [...oldHeads];
        expect(await prepare(pool, progress.receipt)).toEqual({
          state: 'progress',
          transactionId: scopeSteps()[3]?.transactionId,
        });
        const nextSupport = async (expected: readonly unknown[]) => {
          const position = committed.length;
          expect(await prepare(pool, progress.receipt)).toEqual({
            state: 'progress',
            transactionId: committed[position]?.transactionId,
          });
          expect(committed[position]?.frontier.after.slice(2, 2 + expected.length)).toEqual(expected);
        };
        if (canonicalTerms) {
          if (completeMerge) {
            const retiring = ['original', 'retiring', oldBuild, String(Number(newGeneration) - 1)];
            expect(scopeSteps()[3]?.frontier.after.slice(2)).toEqual([...retiring, retiringHomes[0]]);
            for (const home of retiringHomes.slice(1)) await nextSupport([...retiring, home]);
            await nextSupport(['original', 'progress']);
            expect(retainedBuild).not.toBe(oldBuild);
            expect(committed.at(-1)?.frontier.after.slice(4, 6)).toEqual([retainedBuild, newGeneration]);
          } else {
            expect(scopeSteps()[3]?.frontier.after.slice(2, 4)).toEqual(['original', 'progress']);
          }
          await nextSupport(['original', 'progress', retainedBuild, newGeneration]);
          if (adoptedRelation) {
            await nextSupport(['original', 'progress', retainedBuild, newGeneration]);
            await nextSupport(['original', 'progress', retainedBuild, newGeneration]);
          }
          await nextSupport(['original', 'complete', retainedBuild, newGeneration]);
          let digest = EMPTY_IDENTITY_SEARCH_TERMS_DIGEST;
          for (const [i, slot] of termSlots.entries()) {
            digest = createHash('sha256')
              .update(JSON.stringify([digest, slot.slot_id, slot.kind, slot.language_digest, slot.terms]))
              .digest('hex');
            await nextSupport(['terms', 'progress', retainedBuild, newGeneration, slot.slot_id, digest]);
            if (!i) {
              const stepCount = committed.length;
              canonicalBuildCurrent = false;
              await expect(prepare(pool, progress.receipt)).rejects.toThrow('canonical terms lost their Source build');
              expect(committed).toHaveLength(stepCount);
              expect(termReads).toEqual([null]);
              canonicalBuildCurrent = true;
            }
          }
          await nextSupport(['terms', 'complete', retainedBuild, newGeneration, termSlots[1]!.slot_id, digest]);
          expect(termReads).toEqual([null, ...termSlots.map(({ slot_id }) => slot_id)]);
          expect(engineReads).toBe(1);
          expect(bulkCalls).toBe(0);
          expect(retainedPlan).toBeUndefined();
          changedTermReplay = true;
          expect(await prepare(pool, progress.receipt)).toEqual({ state: 'pending' });
          expect(normalizationCalls).toBe(0);
          changedTermReplay = false;
          selectionOverflow = true;
          expect(await prepare(pool, progress.receipt)).toEqual({ state: 'pending' });
          expect(normalizationCalls).toBe(0);
          expect(retainedPlan).toBeUndefined();
          selectionOverflow = false;
          if (creditedCreator) {
            creatorNamesOpen = true;
            expect(await prepare(pool, progress.receipt)).toEqual({ state: 'pending' });
            expect(normalizationCalls).toBe(0);
            expect(retainedPlan).toBeUndefined();
            creatorNamesOpen = false;
          }
        } else {
          if (bothVisible) {
            expect(scopeSteps()[3]?.frontier.after.slice(2, 4)).toEqual(['original', 'progress']);
            await nextSupport(['original', 'progress', retainedOriginalBuild, newGeneration]);
            if (crossHome) await nextSupport(['original', 'progress', retainedOriginalBuild, newGeneration]);
            await nextSupport(['original', 'complete', retainedOriginalBuild, newGeneration]);
          }
          if (mode === 'retire') {
            await nextSupport(['terminal', 'retiring', oldBuild, '5', 0]);
            await nextSupport(['terminal', 'retiring', oldBuild, '5', writerHome]);
            expect(oldHeads).toEqual([]);
          }
          if (visible) {
            await nextSupport(['terminal', 'progress']);
            const originalCursors = bothVisible ? ['-1', String(writerHome)] : [];
            if (crossHome) originalCursors.push(String(terminalHome));
            expect(projectionHeadCursors).toEqual(originalCursors);
            await nextSupport(['terminal', 'progress', retainedBuild, newGeneration]);
            if (mode === 'superseded') {
              await nextSupport(['terminal', 'restart']);
              expect(engineReads).toBe(1);
              expect(readBuilds).toBe(3);
              return;
            }
            await nextSupport(['terminal', 'complete', retainedBuild, newGeneration]);
            expect(projectionHeadCursors).toEqual([...originalCursors, '-1', String(terminalHome)]);
          } else if (intent === 'merge') await nextSupport(['terminal', 'withheld']);
          if (!bothVisible) expect(scopeSteps()[3]?.frontier.after.slice(2)).toEqual(['original', 'withheld']);
        }
        if (mode === 'uncertain') {
          await expect(prepare(pool, progress.receipt)).rejects.toThrow('requires settlement of its outstanding writer');
          expect(retainedPlan).toBeUndefined();
          expect(retainedAction).toBeUndefined();
          expect(engineReads).toBe(2);
          return;
        }
        if (rejectsUnpublishedHandoff) {
          await expect(prepare(pool, progress.receipt)).rejects.toThrow('no published and released writer handoff');
          expect(retainedPlan).toBeUndefined();
          expect(preparedWriter).toBeUndefined();
          publishedMerge = true;
        }
        expect(await prepare(pool, progress.receipt)).toEqual({ state: 'prepared' });
        expect(retainedPlan?.source).toMatchObject({
          original: selected,
          documentId: selected,
          disposition: priorVisible ? 'NEW' : mode === 'first' || canonicalTerms ? 'first-apply' : 'OLD',
          barrier: { kind: 'original', partition: writerHome },
          originalFence: {
            position: writerHome === jobHome ? String(controlPosition) : originPosition(21),
            epoch: 1,
            partition: writerHome,
          },
        });
        expect(retainedPlan?.references).toMatchObject({
          definition: definitionId,
          release: bundledDigest,
          originalSupport:
            canonicalTerms || bothVisible
              ? { build: canonicalTerms ? retainedBuild : retainedOriginalBuild, generation: newGeneration }
              : null,
          terminalSupport: visible ? { build: retainedBuild, generation: newGeneration } : null,
          predecessor: priorVisible ? { planId: previousPlan } : null,
        });
        expect(predecessorReads).toBe(Number(priorVisible) + Number(rejectsUnpublishedHandoff));
        const publicationAdmission = [lockPublicationFence, advanceWriterPublicationAdmissionSql];
        expect(publicationWrites).toEqual(
          rejectsUnpublishedHandoff ? [...publicationAdmission, ...publicationAdmission] : publicationAdmission,
        );
        expect(await prepare(pool, progress.receipt)).toEqual({ state: 'prepared' });
        const preparationReads = 2 + Number(rejectsUnpublishedHandoff);
        expect(engineReads).toBe(preparationReads);
        expect(normalizationCalls).toBe(Number(canonicalTerms) + Number(rejectsUnpublishedHandoff));
        expect(scopeSteps().map((step) => step.engineRequests)).toEqual([0, 1, ...Array(scopeSteps().length - 2).fill(0)]);
        if (sameHomeMerge && writerHome === jobHome) {
          expect(capturedEvents.slice(captureStart)).toEqual(
            scopeSteps().map(() => ({
              store: 'identity_epoch_step',
              partition: jobHome,
              transactionId: admissionTransaction,
              armed: true,
            })),
          );
          expect(bulkCalls).toBe(0);
        }
        if (canonicalTerms || bothVisible || ['dispatch', 'lost', 'handoff', 'changed-proof'].includes(mode)) {
          accepting = true;
          const acceptance = await directoryStep();
          expect(identityEpochReceiptLocator(job, 'search-canonical-index', acceptance).ok).toBe(true);
          expect(acceptance.frontier.after.slice(3)).toEqual([
            SEARCH_IDENTITY_WRITER_ACCEPT,
            selected,
            terminal,
            retainedPlan!.source.locator.planId,
          ]);
          dispatchRequest = {
            transactionId: acceptance.receipt.native.transactionId,
            engineRequests: 0,
            frontier: acceptance.frontier,
          };
          dispatchRequestPosition = String(acceptance.receipt.native.position);
          if (mode === 'changed-proof' || crossHome) {
            terminalBuildCurrent = false;
            await expect(prepare(pool, acceptance.receipt)).rejects.toThrow('Native Search resolvePlanned: changed');
            expect(commonPlan).toBeUndefined();
            expect(hold).toBeUndefined();
            expect(engineReads).toBe(preparationReads);
            expect(bulkCalls).toBe(0);
            if (!crossHome) return;
            terminalBuildCurrent = true;
          }
          const checked = await prepare(pool, acceptance.receipt);
          expect(checked).toEqual({ state: 'progress', transactionId: committed.at(-1)?.transactionId });
          expect(committed.at(-1)?.frontier.after.slice(2, 4)).toEqual(['binding', retainedPlan?.source.locator.planId]);
          expect(commonPlan).toBeUndefined();
          expect(hold).toBeUndefined();
          if (foreignCapture) {
            changedBindingProof = true;
            await expect(prepare(pool, acceptance.receipt)).rejects.toMatchObject({ code: 'identity_effect_stale' });
            changedBindingProof = false;
            expect(commonPlan).toBeUndefined();
            expect(hold).toBeUndefined();
          }
          expect(await prepare(pool, acceptance.receipt)).toEqual({
            state: 'progress',
            transactionId: commonPlan?.transaction_id,
          });
          expect(await prepare(pool, acceptance.receipt)).toEqual({ state: 'prepared' });
          expect(engineReads).toBe(preparationReads);
          const staged = await directoryStep();
          expect(staged.state).toBe('more');
          expect(identityEpochReceiptLocator(job, 'search-canonical-index', staged).ok).toBe(true);
          const keep = progress.frontier.after;
          expect(staged.frontier.after).toEqual([
            'search-directory',
            keep[1],
            keep[2],
            SEARCH_IDENTITY_WRITER_DISPATCH,
            selected,
            terminal,
            retainedPlan!.source.locator.planId,
            hold?.hold_id,
          ]);
          expect(hold?.accepted_epoch).toBe(1);
          expect(acceptedRecorded).toBe(true);
          const request = staged.receipt;
          dispatchRequest = { transactionId: request.native.transactionId, engineRequests: 0, frontier: staged.frontier };
          dispatchRequestPosition = String(request.native.position);
          if (mode === 'lost') {
            await expect(prepare(pool, request)).rejects.toThrow('Synthetic transport response lost');
            await expect(prepare(pool, request)).rejects.toThrow('awaits the original uncertain dispatch result');
            expect(committedOperation?.state).toBe('dispatched');
            expect(receiptText).toBeUndefined();
            expect(retainedBulk).toBeUndefined();
            expect(engineReads).toBe(3);
          } else {
            if (canonicalTerms) {
              canonicalBuildCurrent = false;
              await expect(prepare(pool, request)).rejects.toThrow('Canonical Search Source changed before dispatch');
              expect(committedOperation).toBeUndefined();
              expect(bulkCalls).toBe(0);
              canonicalBuildCurrent = true;
              activeCollectionCount = '3';
              await expect(prepare(pool, request)).rejects.toThrow('Canonical Search Source changed before dispatch');
              expect(committedOperation).toBeUndefined();
              expect(bulkCalls).toBe(0);
              activeCollectionCount = '2';
            }
            if (adoptedName) {
              nameDisclosed = false;
              await expect(prepare(pool, request)).rejects.toThrow('Canonical Search Source changed before dispatch');
              expect(committedOperation).toBeUndefined();
              expect(bulkCalls).toBe(0);
              nameDisclosed = true;
              nameFenced = true;
              await expect(prepare(pool, request)).rejects.toThrow('Canonical Search Source changed before dispatch');
              expect(committedOperation).toBeUndefined();
              expect(bulkCalls).toBe(0);
              nameFenced = false;
            }
            if (adoptedRelation) {
              relationHidden = true;
              await expect(prepare(pool, request)).rejects.toThrow('Canonical Search Source changed before dispatch');
              expect(committedOperation).toBeUndefined();
              expect(bulkCalls).toBe(0);
              relationHidden = false;
              targetRedirect = relationTerminal;
              await expect(prepare(pool, request)).rejects.toThrow('Canonical Search Source changed before dispatch');
              expect(committedOperation).toBeUndefined();
              expect(bulkCalls).toBe(0);
              targetRedirect = null;
              relationOwnerMoved = true;
              await expect(prepare(pool, request)).rejects.toThrow(`Command unavailable for partition ${writerHome}: contention`);
              expect(committedOperation).toBeUndefined();
              expect(bulkCalls).toBe(0);
              relationOwnerMoved = false;
            }
            if (creditedCreator) {
              creatorRenamed = true;
              await expect(prepare(pool, request)).rejects.toThrow('Canonical Search Source changed before dispatch');
              expect(committedOperation).toBeUndefined();
              expect(bulkCalls).toBe(0);
              creatorRenamed = false;
            }
            const captured = await prepare(pool, request);
            expect(captured).toEqual({ state: 'progress', transactionId: retainedBulk?.transaction });
            expect(committedOperation?.state).toBe('dispatched');
            expect(receiptText).toBeUndefined();
            expect(retainedBulk?.bulk).toEqual({
              errors: false,
              items: [
                expect.objectContaining({
                  [canonicalTerms ? 'index' : 'delete']: expect.objectContaining({
                    _index: index,
                    _id: selected,
                    _version: Number(writerClosePosition()),
                    _seq_no: 1,
                    _primary_term: 1,
                    _shards: { total: 1, successful: 1, failed: 0 },
                  }),
                }),
              ],
            });
            const resumed = await directoryStep();
            expect(resumed.receipt).toEqual(request);
            expect(resumed.frontier).toEqual(staged.frontier);
            if (mode === 'dispatch') {
              const guard = createSearchWriterGuard({
                ...receiving.configuration,
                source: { read: forbidden } as never,
                listing: { read: forbidden },
              });
              await expect(withCompiledCommandControls(pool, () => guard.closeGeneration(writerHome))).rejects.toThrow(
                'Pending Search identity plans still hold the generation open',
              );
              expect(committedOperation?.state).toBe('dispatched');
              corruptReceipt = true;
              const readsBeforeCorruptReceipt = engineReads;
              await expect(prepare(pool, request)).rejects.toThrow('One or more search index bulk items failed');
              expect(engineReads).toBe(readsBeforeCorruptReceipt);
              expect(committedOperation?.state).toBe('dispatched');
              expect(bulkCalls).toBe(1);
              corruptReceipt = false;
            }
            unavailableAllocation = true;
            await expect(prepare(pool, request)).rejects.toThrow('Synthetic allocation lookup lost');
            expect(bulkCalls).toBe(1);
            unavailableAllocation = false;
            expect(await prepare(pool, request)).toEqual({
              state: 'progress',
              transactionId: committedOperation?.visible_transaction_id,
            });
            expect(committedOperation?.state).toBe('visible');
            expect(receiptText).toContain('"kind":"bulk"');
            const expectedAllocationReads =
              preparationReads + 3 +
              2 * Number(canonicalTerms) +
              2 * Number(adoptedName) +
              3 * Number(adoptedRelation) +
              Number(creditedCreator) +
              Number(mode === 'dispatch');
            expect(engineReads).toBe(expectedAllocationReads);
            const applicationRequest = await directoryStep();
            expect(applicationRequest.receipt).toEqual(request);
            expect(committedOperation?.state).toBe('visible');
            if (sameHomeMerge && writerHome === jobHome) {
              expect(submitted).toEqual([{ id: selected, operation: 'delete' }]);
              expect(preparedWriter).toMatchObject({
                dispatch_state: 'settled',
                visible_transaction_id: committedOperation?.visible_transaction_id,
                visible_position: committedOperation?.visible_position,
              });
              return;
            }
            const readsBeforeApplication = originalReads;
            if (foreignCapture) {
              const before = capturedEvents.length;
              const beforeDiscard = discardedClients;
              interruptApplicationCapture = true;
              await expect(prepare(pool, applicationRequest.receipt)).rejects.toThrow(
                'capture event was already armed or changed',
              );
              interruptApplicationCapture = false;
              expect(committedOperation?.state).toBe('visible');
              expect(capturedEvents).toHaveLength(before);
              expect(discardedClients).toBe(beforeDiscard + 1);
              expect(bulkCalls).toBe(1);
            }
            const applied = await prepare(pool, applicationRequest.receipt);
            expect(applied).toEqual({ state: 'progress', transactionId: committedOperation?.applied_transaction_id });
            expect(committed.at(-1)?.frontier.after).toEqual([selected, retainedPlan?.effect_key]);
            expect(committedOperation?.applied_position).toBe(
              writerHome === jobHome ? String(controlPosition) : String(applicationPosition()),
            );
            expect(originalReads).toBe(readsBeforeApplication);
            expect(committedOperation?.state).toBe('applied');
            expect(engineReads).toBe(expectedAllocationReads);
            for (const phase of priorVisible
              ? [null, 'original', null]
              : canonicalTerms
                ? ['original', null]
                : ['original', 'terminal', null]) {
              const next = await prepare(pool, request);
              expect(next.state).toBe('progress');
              expect(JSON.parse(receivingContinuation.after_key!).phase ?? null).toBe(phase);
            }
            expect(receivingContinuation.state).toBe('settled');
            if (priorVisible) expect(copySettlement?.transactionId).toBe(committedOperation?.visible_transaction_id);
            expect(await prepare(pool, request)).toEqual({
              state: 'progress',
              transactionId: controlCustody?.transaction_id,
            });
            if (mode === 'dispatch') {
              releaseOwnerAdvanced = true;
              await expect(prepare(pool, request)).rejects.toThrow('Native Search releaseHold: changed');
              expect(lateReleaseCheck).toBe(true);
              expect(hold?.released_transaction_id).toBeNull();
              releaseOwnerAdvanced = false;
              lateReleaseCheck = false;
            }
            expect(await prepare(pool, request)).toEqual({
              state: 'progress',
              transactionId: receivingContinuation.released_transaction_id,
            });
            expect(receivingContinuation.state).toBe('released');
            expect(hold?.released_transaction_id).toBe(receivingContinuation.released_transaction_id);
            const retired = await directoryStep();
            const processed = retiredOriginals.filter((item) => item.jobId === jobId).length;
            expect(retired.frontier.after).toEqual(['search-directory', selected, processed + 1]);
            expect(identityEpochReceiptLocator(job, 'search-canonical-index', retired).ok).toBe(true);
            expect(retiredScope).toBe(true);
            retiredOriginals.push({
              jobId,
              original: selected,
              planId: retainedPlan!.source.locator.planId,
              application: committedOperation!.applied_transaction_id!,
              release: hold!.released_transaction_id!,
              writer: { ...preparedWriter! },
              build: retainedPlan!.references.originalSupport ?? null,
            });
            if (foreignCapture && intent === 'unmerge' && !restoring) {
              const complete = await directoryStep();
              expect(complete.state).toBe('complete');
              expect(complete.frontier.after).toEqual(['directory', 1]);
              expect(identityEpochReceiptLocator(job, 'search-canonical-index', complete).ok).toBe(true);
            }
            if (foreignCapture) {
              const capturedTransactions = (store: Capture['store'], partition?: number) =>
                capturedEvents.slice(captureStart)
                  .filter((event) => event.store === store && (partition === undefined || event.partition === partition))
                  .map(({ transactionId }) => transactionId);
              const foreignSteps = scopeSteps().filter(({ frontier }) =>
                ['search-writer-admitted', 'search-writer-support', selected].includes(String(frontier.after[0])),
              );
              expect(capturedTransactions('identity_epoch_step', writerHome)).toEqual(
                foreignSteps.map(({ transactionId }) => transactionId),
              );
              const controlSteps = intent === 'unmerge' && !restoring ? 5 : 4;
              expect(capturedTransactions('identity_epoch_step', jobHome)).toEqual(
                Array(controlSteps).fill(admissionTransaction),
              );
              expect(capturedTransactions('identity_epoch_receiving_effect')).toEqual([committedOperation?.applied_transaction_id]);
              expect(capturedTransactions('identity_epoch_effect_receipt')).toEqual([
                admissionTransaction,
                admissionTransaction,
              ]);
              expect(capturedTransactions('identity_epoch_receiving_plan')).toEqual([commonPlan?.transaction_id]);
              expect(capturedTransactions('identity_epoch_receiving_record')).toEqual([hold?.accepted_transaction_id]);
              expect(capturedTransactions('identity_epoch_receiving_custody')).toEqual([controlCustody?.transaction_id]);
            }
            if (nativePermission) {
              expect(permissionTimes).toBeGreaterThan(0);
              expect(permissionFormulas).toBeGreaterThan(0);
              if (bothVisible && !canonicalTerms) {
                expect(permissionBatches).toBeGreaterThan(0);
                expect(visibilityFloorReads).toBe(0);
              }
            }
            expect(engineReads).toBe(expectedAllocationReads);
          }
          expect(bulkCalls).toBe(1);
        }
        if (mode === 'input') {
          const guard = createSearchWriterGuard({
            ...receiving.configuration,
            source: { read: forbidden } as never,
            listing: { read: forbidden },
          });
          await expect(withCompiledCommandControls(pool, () => guard.closeGeneration(writerHome))).rejects.toThrow(
            'Pending Search identity plans still hold the generation open',
          );
          expect(engineReads).toBe(3);
        }

        return;
      }
    }
    expect(engineReads).toBe(0);
  }

  function resetOriginal() {
    scopeStart = committed.length;
    directoryReads = 0;
    originalReads = 0;
    planReads = 0;
    engineReads = 0;
    bulkCalls = 0;
    observedLocks.length = 0;
    publicationWrites.length = 0;
    accepting = false;
    dispatchRequest = undefined;
    dispatchRequestPosition = '1';
    retainedPlan = undefined;
    preparedWriter = undefined;
    retainedAction = undefined;
    committedOperation = undefined;
    retainedBulk = undefined;
    receiptText = undefined;
    hold = undefined;
    commonPlan = undefined;
    acceptedNativeHold = undefined;
    acceptedRecorded = false;
    acceptedRecordPosition = undefined;
    controlCustody = undefined;
    controlApplied = undefined;
    receivingContinuation = { revision: '0', after_key: null, state: 'progress', applied_transaction_id: null };
    appliedPosition = applicationPosition();
    retiredScope = false;

    predecessorReads = 0;
    termReads.length = 0;
    normalizationCalls = 0;
    copyLocator = undefined;
    copySettlement = undefined;
    reconciledCopy = undefined;
  }

  await driveOriginal();
  if (completeMerge && !sameHomeMerge) {
    const redirected = retiredOriginals[0]!;
    expect(redirected.original).toBe(first);
    expect(committed.at(-1)?.frontier.after).toEqual(['search-directory', first, 1]);

    // The next original has its own receiving home and rows. Keep the job, pool,
    // committed directory, retired scope, captured roles, and terminal build.
    after = redirected.original;
    selected = second;
    writerHome = terminalHome;
    canonicalTerms = true;
    oldBuild = retainedBuild!;
    oldGeneration = newGeneration;
    oldHeads.push(...projectionDependencyHomes.get(oldBuild)!);
    newGeneration = String(Number(oldGeneration) + 2);
    resetOriginal();

    await driveOriginal();
    const sealed = await directoryStep();
    expect(sealed.state).toBe('complete');
    expect(sealed.frontier.after).toEqual(['directory', 2]);
    expect(identityEpochReceiptLocator(job, 'search-canonical-index', sealed).ok).toBe(true);
    expect(committed.at(-1)?.transactionId).toBe(sealed.receipt.native.transactionId);
    expect(capturedEvents.at(-1)).toEqual({
      store: 'identity_epoch_step', partition: jobHome, transactionId: admissionTransaction, armed: true,
    });
    expect(retiredOriginals.map(({ original }) => original)).toEqual([first, second]);
    expect(new Set(retiredOriginals.map(({ planId }) => planId)).size).toBe(2);
    expect(new Set(retiredOriginals.map(({ application }) => application)).size).toBe(2);
    expect(new Set(retiredOriginals.map(({ release }) => release)).size).toBe(2);
    async function acknowledgeSeal(completed: IdentityStepProgress) {
      const acknowledge = () =>
        withCompiledCommandControls(pool, () => identityEpochStore().reconcileStepReceipt(pool, completed.receipt));
      const acknowledged = await acknowledge();
      expect(acknowledged.receipt).toEqual(completed.receipt);
      expect(await acknowledge()).toEqual(acknowledged);
      const replay = await directoryStep();
      expect(replay.receipt).toEqual(completed.receipt);
      expect(replay.frontier).toEqual(completed.frontier);
    }
    await acknowledgeSeal(sealed);
    expect(searchAckWrites).toBe(1);
    expect(submitted).toEqual([{ id: first, operation: 'delete' }, { id: second, operation: 'index' }]);

    // Begin the native unmerge with the same Pool and the completed merge's old writer row.
    // Search owns the acknowledged receipt; the predecessor lookup models job publication.
    restoring = true;
    intent = 'unmerge';
    after = null;
    jobId = newId(jobHome << 4);
    job = { jobId, epoch: 2n };
    savedJob = { jobId, epoch: '2' };
    directoryScope = 'e'.repeat(64);
    admissionTransaction = crypto.randomUUID();
    originOffset = 64;
    priorVisible = true;
    previousJob = mergeJob.jobId;

    const mergedOriginals = [...retiredOriginals];
    for (const previous of mergedOriginals) {
      selected = previous.original;
      terminal = selected;
      terminalHome = selected === first ? firstHome : otherControlHome;
      writerHome = terminalHome;
      predecessorWriter = previous.writer;
      previousPlan = previous.planId;
      previousClose = previous.writer.closed_transaction_id!;
      oldBuild = previous.build!.build;
      const heads = projectionDependencyHomes.get(oldBuild)!;
      expect(heads).toEqual(selected === first ? [firstHome, otherControlHome] : [otherControlHome]);
      oldHeads.push(...heads);
      oldGeneration = String(previous.build!.generation);
      oldMeaning = bundledDigest;
      newGeneration = String(Number(oldGeneration) + 2);
      resetOriginal();

      await driveOriginal();
      expect(retainedPlan?.references.predecessor).toMatchObject({
        partition: writerHome,
        planId: previous.planId,
      });
      const previousVisibility = BigInt(previous.writer.visible_position!);
      expect(BigInt(retainedPlan!.source.originalFence.position)).toBeGreaterThan(previousVisibility);
      expect(BigInt(copySettlement!.position)).toBeGreaterThan(previousVisibility);
      expect(copyLocator).toMatchObject({
        state: 'settled',
        visible: {
          partition: writerHome,
          transactionId: previous.writer.visible_transaction_id,
          position: previous.writer.visible_position,
        },
      });
      after = selected;
    }
    const restored = await directoryStep();
    expect(restored.state).toBe('complete');
    expect(restored.frontier.after).toEqual(['directory', 2]);
    await acknowledgeSeal(restored);
    expect(searchAckWrites).toBe(2);
    expect(new Set(retiredOriginals.map(({ release }) => release)).size).toBe(4);
    expect(submitted).toEqual([
      { id: first, operation: 'delete' },
      { id: second, operation: 'index' },
      { id: first, operation: 'index' },
      { id: second, operation: 'index' },
    ]);
  }
});
