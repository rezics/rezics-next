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
import { tupleRoute } from '../../src/content/imported-contract.ts';
import stepSql from '../../src/search/identity-epoch-participant-step.sql';
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
import type { IdentityFrontier } from '../../src/semantic/identity-epoch-contract.ts';
import {
  createSearchIdentityEpochParticipant,
  searchIdentityReceivingComposition,
} from '../../src/search/identity-epoch-participant.ts';
import {
  readSearchIdentityDirectorySql,
  readSearchIdentityCommonPlanSql,
  advanceSearchIdentityOriginalSql,
  readSearchIdentityMaterializedOriginalSql,
  readSearchIdentityOriginalPlanSql,
  searchIdentityOriginalPlanPresentSql,
  readSearchIdentityWriterAdmissionSql,
  readSearchIdentityWriterSupportSql,
} from '../../src/search/identity-search-receiving-directory-sql.ts';
import { installIdentityAdapterRuntime } from '../../src/semantic/identity-adapter-runtime.ts';
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

const directoryScope = 'd'.repeat(64);
const jobHome = 0x842;
const writerHome = 0x841;
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
  { label: 'resumes a visible terminal projection', intent: 'merge', resumed: false, mode: 'visible' },
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
])('installed Search directory $label', async ({ intent, resumed, mode }) => {
  const [previous, first, second] = Array.from({ length: 3 }, () => newId(writerHome << 4)).sort() as [
    string,
    string,
    string,
  ];
  const jobId = newId(jobHome << 4);
  const job = { jobId, epoch: 1n };
  const savedJob = { jobId, epoch: '1' };
  const adoptedRelation = mode === 'canonical-relation';
  const canonicalTerms = mode === 'canonical-terms' || mode === 'canonical-merge' || adoptedRelation;
  const priorVisible = mode === 'handoff' || mode === 'canonical-terms';
  const visible = canonicalTerms || ['visible', 'changed-proof', 'retire', 'superseded'].includes(mode);
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
  const nameSlot = crypto.randomUUID();
  const nameCandidate = crypto.randomUUID();
  const relationTarget = newId(otherControlHome << 4);
  const relationTerminal = newId(jobHome << 4);
  let targetRedirect: string | null = null;
  const subjectType = adoptedRelation ? 'schema:Recipe' : 'schema:Person';
  const selectedProperty = adoptedRelation ? 'schema:suitableForDiet' : 'schema:name';
  const relationRoster = ['schema:author', 'schema:keywords', 'schema:suitableForDiet'];
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
  const canonicalDocument = {
    id: second,
    partition: writerHome,
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
    credit_search_complete: false,
    credited_names: [],
    ...(adoptedRelation && { relation_facet_overflow: relationRoster }),
  };
  const oldBuild = crypto.randomUUID();
  const oldHeads = mode === 'retire' ? [0, writerHome] : [];
  let oldMeaning = bundledDigest;
  let oldGeneration = '4';
  const newGeneration = mode === 'retire' ? '6' : '1';
  const after = resumed ? previous : null;
  const frontier = resumed ? { after: ['search-directory', previous, 9], segment: 0 } : null;
  const leftGeneration = newId(jobHome << 4);
  const rightGeneration = newId(jobHome << 4);
  const selected = mode === 'materialized' ? first : intent === 'unmerge' || canonicalTerms ? second : first;
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
  const projectedSubjects: string[] = [];
  const projectionHeadCursors: string[] = [];
  let retainedBuild: string | undefined;
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
  const previousPlan = crypto.randomUUID();
  const previousJob = newId(jobHome << 4);
  const previousClose = crypto.randomUUID();
  type NativeWriter = Record<string, string | number | boolean | null>;
  let retainedAction: string | undefined;
  let preparedWriter: NativeWriter | undefined;
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
  let commonPlan: { binding: unknown; binding_digest: string; transaction_id: string } | undefined;
  let acceptedNativeHold: unknown;
  let acceptedRecorded = false;
  let accepting = false;
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
  const applicationPosition = 34;
  let appliedPosition = applicationPosition;
  let retiredScope = false;
  let copyLocator: unknown;
  let copySettlement: { partition: number; transactionId: string; epoch: number; position: string } | undefined;
  let reconciledCopy: string | undefined;
  const nativePosition = () =>
    dispatchRequest?.frontier.after[3] === SEARCH_IDENTITY_WRITER_DISPATCH
      ? committedOperation?.state === 'applied'
        ? String(appliedPosition)
        : committedOperation?.state === 'visible'
          ? '33'
          : committedOperation
            ? retainedBulk
              ? '32'
              : '31'
            : '30'
      : accepting
        ? '21'
        : '20';
  const publicationWrites: string[] = [];

  type Step = { transactionId: string; frontier: IdentityFrontier; engineRequests: number };
  let writing: Step | undefined;
  const committed: Step[] = [];
  const client = {
    async query(input: string | QueryConfig, positional: unknown[] = []) {
      const sql = typeof input === 'string' ? input : input.text;
      const values = typeof input === 'string' ? positional : (input.values ?? []);
      let rows: readonly unknown[];
      if (sql === partitionRead.sql)
        rows = [
          [
            String(values[0]),
            'b',
            relationOwnerMoved && values[0] === String(otherControlHome) ? 'moved' : 'active',
            relationOwnerMoved && values[0] === String(otherControlHome) ? 'other' : null,
            '1',
            (canonicalTerms || engineReads > 1) && values[0] === String(writerHome) ? nativePosition() : '0',
          ],
        ];
      else if (sql === jobRead.sql)
        rows = [
          {
            state: 'pending',
            intent: {
              kind: intent,
              original: second,
              redirected: first,
              survivor: second,
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
        ];
      else if (sql === readSearchIdentityDirectorySql) {
        expect(values).toEqual([jobHome, jobId, '1']);
        directoryReads++;
        const saved = retiredScope
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
            native_position: dispatchRequest ? dispatchRequestPosition : '1',
            frontier: saved?.frontier ?? frontier,
            proven: mode !== 'stale',
          },
        ];
      } else if (sql === identityChangeTransformSQL)
        rows = [{ kind: intent, original: second, survivor: second, remainder_terminal: first }];
      else if (sql === identityChangeFirstInputsSQL) {
        rows = [{ generation: rightGeneration, terminal: second, control_partition: jobHome, owner_current: true }];
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
        const original = values[0] === leftGeneration && mode !== 'materialized' ? first : second;
        const isLeft = values[0] === leftGeneration;
        expect(values).toEqual([values[0], after, 1, isLeft ? first : second, isLeft ? otherControlHome : jobHome]);
        rows =
          mode === 'empty' ||
          mode === 'changed' ||
          ((mode === 'materialized' || canonicalTerms) && values[0] === leftGeneration)
            ? []
            : [{ original, terminal: original }];
      } else if (sql === readSearchIdentityMaterializedOriginalSql) {
        expect(values).toEqual([jobHome, jobId, after]);
        rows = mode === 'materialized' ? [{ original: first, previous_terminal: first, terminal: second }] : [];
      } else if (sql === searchIdentityOriginalPlanPresentSql) {
        rows = retainedPlan ? [{}] : [];
      } else if (sql === readSearchIdentityOriginalPlanSql) {
        expect(values).toEqual([
          writerHome,
          jobId,
          '1',
          ['OLD', 'NEW', 'first-apply', 'handoff'].map(
            (disposition) => `search_directory_probe_subjects_g1:${selected}:${disposition}`,
          ),
          selected,
          index,
        ]);
        planReads++;
        rows = retainedPlan ? [retainedPlan] : [];
      } else if (sql === readSearchIdentityWriterAdmissionSql) {
        expect(values).toEqual([writerHome, jobId, '1', committed[0]?.transactionId, directoryScope, selected]);
        const step = committed.find((step) => step.frontier.after[0] === 'search-writer-admitted');
        rows = step ? [{ transaction_id: step.transactionId, frontier: step.frontier, proven: true }] : [];
      } else if (sql === readSearchIdentityWriterSupportSql) {
        expect(values.slice(0, 4)).toEqual([writerHome, jobId, '1', committed[0]?.transactionId]);
        const step = committed.findLast(
          (step) => step.frontier.after[0] === 'search-writer-support' && step.frontier.after[2] === values[4],
        );
        rows = step ? [{ transaction_id: step.transactionId, frontier: step.frontier, proven: true }] : [];
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
      } else if (sql === visibilityRead.sql || sql === visibilityRead['~standard'].query.text) {
        projectedSubjects.push(String(values[1]));
        rows = [[visible && values[1] === second ? 'visible' : 'hidden', '1', subjectType]];
      } else if (visible && sql === mappingOwners.sql)
        rows = (values[0] as number[]).map((partition_no) => ({
          partition_no,
          epoch: 1,
          position: '0',
          write_state: 'active',
        }));
      else if (visible && sql === mappingSources.sql) {
        expect(values[0]).toEqual([second]);
        rows = [
          {
            subject_id: second,
            original: second,
            control_partition: jobHome,
            control_group: second,
            terminal: second,
            current_target: null,
            epoch: '1',
            owner_epoch: 1,
            dirty_revision: '0',
            captured_revision: '0',
            closure_state: 'legacy',
          },
        ];
      } else if (visible && sql === mappingPending.sql)
        rows = [{ partition_no: jobHome, terminal: second, pending_job: jobId, pending_epoch: '1' }];
      else if (visible && sql === mappingCurrent.sql)
        rows = [
          {
            partition_no: jobHome,
            terminal: second,
            requested_original: second,
            owner_epoch: 1,
            closure_state: 'open',
            redirected: false,
          },
        ];
      else if (sql === verifyCompletedPublicFilterProjectionSql) {
        expect(values).toEqual([
          writerHome,
          writerHome << 4,
          second,
          retainedBuild,
          newGeneration,
          1,
          bundledDigest,
          second,
          dependencyHomes.at(-1),
        ]);
        rows = mode === 'changed-proof' || !canonicalBuildCurrent ? [] : [{}];
      } else if (canonicalTerms && sql === readIdentitySearchIndexTermSlotSql) {
        const prior = committed.findLast((step) => step.frontier.after[2] === 'terms')?.frontier.after[6] ?? null;
        expect(values).toEqual([writerHome << 4, second, prior]);
        termReads.push(prior);
        const next = termSlots[termReads.length - 1];
        rows = [{ prior_current: true, slot_id: null, ...next, fact_count: next?.terms.length ?? 0 }];
      } else if (canonicalTerms && sql === readIdentitySearchIndexTermsSql) {
        expect(values).toEqual([writerHome << 4, second, 8]);
        rows = [
          ...termSlots.map((slot) => ({
            ...slot,
            ...(changedTermReplay && slot.kind === 'label' && { terms: ['Changed canonical name'] }),
            language: 'en',
            state: 'progress',
          })),
          { state: 'complete', remaining: 0 },
        ];
      } else if (canonicalTerms && sql === readCanonicalStatementPresenceSql) {
        expect(values).toEqual([writerHome << 4, second]);
        rows = adoptedName || adoptedRelation || selectionOverflow ? [{}] : [];
      } else if (canonicalTerms && sql === readCanonicalStatementCountSql) {
        expect(values).toEqual([writerHome << 4, second]);
        rows = [
          { count: selectionOverflow ? SEARCH_INDEX_STATEMENT_KEYS + 1 : Number(adoptedName || adoptedRelation) },
        ];
      } else if ((adoptedName || adoptedRelation) && sql === readCanonicalStatementsSql) {
        expect(values).toEqual([writerHome << 4, second, 1, adoptedRelation ? relationRoster : []]);
        rows = [
          {
            route: writerHome << 4,
            subject_id: second,
            slot_id: nameSlot,
            candidate_id: nameCandidate,
            property: selectedProperty,
            rank: 'preferred',
            ordinal: 1,
            release: bundledDigest,
            relation: adoptedRelation,
            eligible: adoptedRelation,
            source: null,
            oversized_source: false,
            concealed: !nameDisclosed,
            body: nameDisclosed ? selectedBody : null,
          },
        ];
      } else if (adoptedName && sql === candidateProvenance.sql) {
        const args = {
          routes: [writerHome << 4],
          subjects: [second],
          candidates: [nameCandidate],
          slots: [nameSlot],
          max_bytes: SEARCH_INDEX_PROVENANCE_BYTES,
        };
        expect(values).toEqual(candidateProvenance.params.map((key) => args[key as keyof typeof args]));
        rows = [
          {
            subject_id: second,
            id: nameCandidate,
            source: importedName,
            source_bytes: Buffer.byteLength(JSON.stringify(importedName)),
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
            second,
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
        rows = [[second, activeCollectionCount]];
      } else if (visible && sql === projectionRelease.sql) rows = [[bundledDigest, JSON.stringify(bundledRelease)]];
      else if (visible && sql === projectionSubjects.sql) {
        if (adoptedRelation && String(values[2]).includes(relationTarget))
          rows = [
            [
              String(otherControlHome << 4),
              relationTarget,
              'skos:Concept',
              relationHidden ? 'hidden' : 'visible',
              '1',
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
        else rows = [[String(writerHome << 4), second, subjectType, 'visible', '1', bundledDigest, null, 't', '1']];
      } else if (visible && sql === projectionPrivacy.sql) rows = [['0']];
      else if (visible && sql === projectionPage.sql) {
        rows =
          adoptedRelation && values[projectionPage.params.indexOf('after_property')] === ''
            ? [
                [
                  String(writerHome << 4),
                  second,
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
        rows = mode === 'retire' ? [{ build_id: oldBuild, generation: oldGeneration, meaning_digest: oldMeaning }] : [];
      else if (visible && sql === retireProjectionHeadSql) {
        expect(values).toEqual([oldBuild]);
        const partition = oldHeads.shift();
        rows = partition === undefined ? [] : [{ partition_no: partition }];
      } else if (visible && sql === invalidateProjectionBuildSql) {
        expect(values).toEqual([oldBuild, '4', retiredProjectionMeaning]);
        oldGeneration = '5';
        oldMeaning = retiredProjectionMeaning;
        rows = [{ generation: oldGeneration }];
      } else if (visible && sql === lockProjectionBuildForHeadsSql) {
        expect(values).toEqual([retainedBuild, newGeneration, retiredProjectionMeaning]);
        rows = [{}];
      } else if (visible && sql === projectionStart.sql) {
        retainedBuild = String(values[4]);
        rows = [[retainedBuild, newGeneration, String(writerHome << 4)]];
      } else if (visible && sql === projectionBuild.sql) {
        readBuilds++;
        rows =
          mode === 'superseded' && readBuilds === 3
            ? []
            : [[retainedBuild, newGeneration, String(writerHome << 4), '1', '0', '0', second, '1', '1', bundledDigest]];
      } else if (visible && sql === projectionHeads.sql) {
        const heads = JSON.parse(String(values[projectionHeads.params.indexOf('heads')])) as { partition_no: number }[];
        rows = heads.map(({ partition_no }) => [String(partition_no)]);
      } else if (visible && sql === projectionHeadPage.sql) {
        expect(values[2]).toBe('1');
        projectionHeadCursors.push(String(values[1]));
        const next = dependencyHomes.find((home) => Number(values[1]) < home);
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
              ? [
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
        rows = [{ plan_id: previousPlan }];
      } else if (sql === prepareSearchIdentityOriginalSql) {
        expect(values.slice(0, 9)).toEqual([
          writerHome,
          index,
          selected,
          'allocation',
          1,
          jobId,
          '1',
          expect.any(String),
          '21',
        ]);
        expect(values[11]).toBe(priorVisible ? previousClose : null);
        retainedAction = String(values[10]);
        expect(JSON.parse(retainedAction)).toEqual({
          op: canonicalTerms ? 'index' : 'delete',
          id: selected,
          version: { nativeBigint: '21' },
          ...(canonicalTerms && { document: expect.objectContaining(canonicalDocument) }),
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
          closed_epoch: '1',
          closed_transaction_id: String(values[7]),
          closed_position: '21',
        };
        rows = [{ original_id: selected }];
      } else if (sql === readSearchIdentityDispatchBasisSql) {
        expect(values).toEqual([
          writerHome,
          retainedPlan?.source.locator.planId,
          jobId,
          '1',
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
            job_epoch: '1',
            effect_key: plan.effect_key,
            transaction_id: plan.source.plan.transactionId,
            initial_copy_count: 0,
            native_epoch: 1,
            native_position: '21',
          },
        ];
      } else if (sql === planSql.hold.sql || sql === planSql.peekHold.sql) rows = hold ? [{ ...hold }] : [];
      else if (sql === planSql.accepted.sql) {
        expect(values[6]).toBe(hold?.accepted_transaction_id);
        expect(acceptedRecorded).toBe(true);
        rows = [{ epoch: 1, position: '22' }];
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
          dispatch_position: '31',
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
          '31',
          [selected],
        ]);
        expect(values[10]).toBe('21');
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
          position: '33',
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
          String(applicationPosition),
          committedOperation?.applied_transaction_id,
        ]);
        controlApplied = values;
        rows = [{}];
      } else if (sql === receivingStatements.controlCustody || sql === planSql.control.sql)
        rows = controlCustody ? [controlCustody] : [];
      else if (sql === receivingStatements.insertCustody) {
        writingCustody = {
          epoch: 1,
          position: String(Number(nativePosition()) + 1),
          transaction_id: String(values[3]),
        };
        rows = [{}];
      } else if (sql === searchNativeReleaseAppliedSql()) {
        expect(values.slice(-2)).toEqual([committedOperation?.applied_transaction_id, hold?.hold_id]);
        rows = [{ epoch: 1, position: String(applicationPosition) }];
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
        expect(values.slice(6, 10)).toEqual([
          writerHome,
          1,
          String(applicationPosition),
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
            plan: { partition: jobHome, transactionId: commonPlan?.transaction_id, epoch: 1, position: '22' },
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
      else if (sql === receivingStatements.lookupGate) rows = [{ pending_job: jobId, pending_epoch: '1' }];
      else if (
        sql === receivingStatements.insertApplied ||
        sql === receivingStatements.sameCommandApplied ||
        sql === planSql.applied.sql
      )
        rows = [{}];
      else if (sql === planSql.apply.sql) {
        expect(values[2]).toBe(committedOperation?.operation_id);
        writingOperation = {
          ...committedOperation!,
          state: 'applied',
          applied_transaction_id: String(values[3]),
          frontier: JSON.parse(String(values[4])),
          applied_position: String(applicationPosition),
        };
        rows = [{ operation_id: writingOperation.operation_id }];
      } else if (sql === receivingJob.sql) rows = [{ state: 'pending', scope_digest: directoryScope }];
      else if (sql === receivingStatements.inputBasis)
        rows = [
          { control_partition: otherControlHome, terminal: selected, generation: leftGeneration, owner_epoch: 1 },
        ];
      else if (
        sql === receivingStatements.originalMembership ||
        sql === readSearchIdentityPlanComponentSql ||
        sql === revalidateSearchIdentityPlanFenceSql ||
        sql === receivingStatements.retainGate ||
        sql === receivingStatements.expectEffect ||
        sql === receivingProgress.sql
      )
        rows = [{}];
      else if (sql === receivingStatements.insertPlan) {
        commonPlan = {
          binding: JSON.parse(String(values[4])),
          binding_digest: String(values[5]),
          transaction_id: String(values[6]),
        };
        rows = [{}];
      } else if (sql === receivingPlan.sql)
        rows = commonPlan ? [{ ...commonPlan, native_epoch: 1, native_position: '22' }] : [];
      else if (sql === readSearchIdentityCommonPlanSql)
        rows = [{ ...commonPlan, plan_transaction_id: commonPlan?.transaction_id, scope_digest: directoryScope }];
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
        acceptedNativeHold = JSON.parse(String(values[11]));
        expect(JSON.parse(String(values[11])).holdId).toBe(hold?.hold_id);
        acceptedRecorded = true;
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
                  visible: expect.objectContaining({ partition: writerHome, epoch: 1, position: '10' }),
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
        if (sql === structuralGate.sql) rows = [{ pending_job: jobId, pending_epoch: '1' }];
        else if (sql === readWriterPublicationWitness && (mode === 'existing' || mode === 'fenced' || engineReads > 1))
          rows = [{}];
        else if (sql === readPublicationFence && mode === 'fenced') rows = [{ publication_fence: crypto.randomUUID() }];
        else if (sql === writerSql.insertGate || (sql === writerSql.gate && (mode === 'existing' || engineReads > 1)))
          rows = [{ enrollment_generation: '0', fence_generation: '0', closed_token: null }];
        else if (sql === writerSql.original && priorVisible) {
          rows = [{ incarnation: 'allocation', owner_epoch: 1, closed_transaction_id: previousClose }];
        } else rows = [];
      } else if (sql === stepSql.sql) {
        const work = JSON.parse(String(values[6]));
        writing = {
          transactionId: String(values[1]),
          frontier: JSON.parse(String(values[5])),
          engineRequests: work.engineRequests,
        };
        rows = [{ transaction_id: writing.transactionId }];
      } else if (sql === 'COMMIT') {
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
      } else if (sql === nativeCommit.sql) rows = [{}];
      else if (sql === commandNoEffect['~standard'].query.text) rows = [['1', nativePosition()]];
      else if (sql === commandFence['~standard'].query.text)
        rows = [['1', engineReads > 1 ? String(Number(nativePosition()) + 1) : '1']];
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
    release() {
      checkedOut = false;
    },
  };
  pool.connect = (async () => {
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
      const target = { _index: alias, _id: selected, version: 21, version_type: 'external' };
      expect(lines).toEqual(
        canonicalTerms ? [{ index: target }, expect.objectContaining(canonicalDocument)] : [{ delete: target }],
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
              _version: 21,
              _shards: { total: 1, successful: 1, failed: 0 },
              _seq_no: 1,
              _primary_term: 1,
              status: canonicalTerms ? 201 : mode === 'visible' ? 404 : 200,
              result: canonicalTerms ? 'created' : mode === 'visible' ? 'not_found' : 'deleted',
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
    access: {
      authorize: visible ? async () => true : forbidden,
      authenticate: forbidden,
    } as never,
    clock: () => new Date(),
    identitySourceSupportReaderFactory: composeSearchNativePorts().createIdentitySourceSupportReader,
    work: searchReceivingProductionDeclaration(),
  });
  const step = createSearchIdentityEpochParticipant({ search, prefix, routeKey, receiving });
  const result = withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline: Date.now() + 5000 }, () =>
    step(pool, job),
  );
  const requestsWriter = [
    'input',
    'dispatch',
    'lost',
    'materialized',
    'existing',
    'fenced',
    'visible',
    'canonical-terms',
    'canonical-merge',
    'canonical-relation',
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
    expect(directoryReads).toBe(mode === 'changed' ? 2 : 1);
    expect(originalReads).toBe(mode === 'stale' || mode === 'moved' ? 0 : 2);
    expect(planReads).toBe(0);
    expect(committed).toEqual([]);
  } else {
    const progress = await result;
    expect(progress.state).toBe('more');
    expect(identityEpochReceiptLocator(job, 'search-canonical-index', progress).ok).toBe(true);
    expect(progress.frontier.after.slice(3, 5)).toEqual([SEARCH_IDENTITY_WRITER_REQUEST, selected]);
    expect(progress.work.engineRequests).toBe(0);
    expect(committed.map((step) => step.engineRequests)).toEqual([0]);
    expect(directoryReads).toBe(2);
    expect(originalReads).toBe(intent === 'merge' ? 4 : 2);
    expect(planReads).toBe(1);
    if (!resumed) {
      const prepare = createSearchIdentityWriterPreparation(receiving, {});
      await expect(
        withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline: Date.now() + 5000 }, () =>
          prepare(pool, progress.receipt),
        ),
      ).rejects.toThrow('requires the separate owner turn');
      const replay = await withIdentitySourceConsumerMaintenance(
        { pool, env: {} },
        { deadline: Date.now() + 5000 },
        () => step(pool, job),
      );
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
        transactionId: committed[1]?.transactionId,
      });
      expect(committed[1]?.frontier.after).toEqual([
        'search-writer-admitted',
        progress.receipt.native.transactionId,
        selected,
        'allocation',
        alias,
        '0',
        '0',
        priorVisible ? previousClose : null,
      ]);
      expect(committed.map((step) => step.engineRequests)).toEqual([0, 1]);
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
        transactionId: committed[2]?.transactionId,
      });
      expect(committed[2]?.frontier.after).toEqual([
        'search-writer-support',
        progress.receipt.native.transactionId,
        'definition',
        definitionId,
        bundledDigest,
      ]);
      expect(await prepare(pool, progress.receipt)).toEqual({
        state: 'progress',
        transactionId: committed[3]?.transactionId,
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
        expect(committed[3]?.frontier.after.slice(2, 4)).toEqual(['original', 'progress']);
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
      } else {
        if (mode === 'retire') {
          await nextSupport(['terminal', 'retiring', oldBuild, '5', 0]);
          await nextSupport(['terminal', 'retiring', oldBuild, '5', writerHome]);
          expect(oldHeads).toEqual([]);
        }
        if (visible) {
          await nextSupport(['terminal', 'progress']);
          expect(projectionHeadCursors).toEqual([]);
          await nextSupport(['terminal', 'progress', retainedBuild, newGeneration]);
          if (mode === 'superseded') {
            await nextSupport(['terminal', 'restart']);
            expect(engineReads).toBe(1);
            expect(readBuilds).toBe(3);
            return;
          }
          await nextSupport(['terminal', 'complete', retainedBuild, newGeneration]);
          expect(projectionHeadCursors).toEqual(['-1', String(writerHome)]);
        } else if (intent === 'merge') await nextSupport(['terminal', 'withheld']);
        expect(committed[3]?.frontier.after.slice(2)).toEqual(['original', 'withheld']);
        expect(projectedSubjects).toEqual(
          intent === 'unmerge' ? [second] : [first, ...Array(mode === 'retire' ? 5 : visible ? 3 : 1).fill(second)],
        );
      }
      if (mode === 'uncertain') {
        await expect(prepare(pool, progress.receipt)).rejects.toThrow('requires settlement of its outstanding writer');
        expect(retainedPlan).toBeUndefined();
        expect(retainedAction).toBeUndefined();
        expect(engineReads).toBe(2);
        return;
      }
      expect(await prepare(pool, progress.receipt)).toEqual({ state: 'prepared' });
      expect(retainedPlan?.source).toMatchObject({
        original: selected,
        documentId: selected,
        disposition: priorVisible ? 'NEW' : mode === 'first' || canonicalTerms ? 'first-apply' : 'OLD',
        barrier: { kind: 'original', partition: writerHome },
        originalFence: { position: '21', epoch: 1, partition: writerHome },
      });
      expect(retainedPlan?.references).toMatchObject({
        definition: definitionId,
        release: bundledDigest,
        originalSupport: canonicalTerms ? { build: retainedBuild, generation: newGeneration } : null,
        terminalSupport: visible ? { build: retainedBuild, generation: newGeneration } : null,
        predecessor: priorVisible ? { planId: previousPlan } : null,
      });
      expect(predecessorReads).toBe(priorVisible ? 1 : 0);
      expect(publicationWrites).toEqual([lockPublicationFence, advanceWriterPublicationAdmissionSql]);
      expect(await prepare(pool, progress.receipt)).toEqual({ state: 'prepared' });
      expect(engineReads).toBe(2);
      expect(normalizationCalls).toBe(Number(canonicalTerms));
      expect(committed.map((step) => step.engineRequests)).toEqual([0, 1, ...Array(committed.length - 2).fill(0)]);
      if (canonicalTerms || ['dispatch', 'lost', 'handoff', 'visible', 'changed-proof'].includes(mode)) {
        accepting = true;
        const acceptance = await withIdentitySourceConsumerMaintenance(
          { pool, env: {} },
          { deadline: Date.now() + 5000 },
          () => step(pool, job),
        );
        expect(acceptance.frontier.after.slice(3)).toEqual([
          SEARCH_IDENTITY_WRITER_ACCEPT,
          selected,
          second,
          retainedPlan!.source.locator.planId,
        ]);
        dispatchRequest = {
          transactionId: acceptance.receipt.native.transactionId,
          engineRequests: 0,
          frontier: acceptance.frontier,
        };
        dispatchRequestPosition = String(acceptance.receipt.native.position);
        if (mode === 'changed-proof') {
          await expect(prepare(pool, acceptance.receipt)).rejects.toThrow('Native Search resolvePlanned: changed');
          expect(commonPlan).toBeUndefined();
          expect(hold).toBeUndefined();
          expect(engineReads).toBe(2);
          expect(bulkCalls).toBe(0);
          return;
        }
        expect(await prepare(pool, acceptance.receipt)).toEqual({
          state: 'progress',
          transactionId: commonPlan?.transaction_id,
        });
        expect(await prepare(pool, acceptance.receipt)).toEqual({ state: 'prepared' });
        expect(engineReads).toBe(2);
        const staged = await withIdentitySourceConsumerMaintenance(
          { pool, env: {} },
          { deadline: Date.now() + 5000 },
          () => step(pool, job),
        );
        expect(staged.state).toBe('more');
        const keep = progress.frontier.after;
        expect(staged.frontier.after).toEqual([
          'search-directory',
          keep[1],
          keep[2],
          SEARCH_IDENTITY_WRITER_DISPATCH,
          selected,
          second,
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
                  _version: 21,
                  _seq_no: 1,
                  _primary_term: 1,
                  _shards: { total: 1, successful: 1, failed: 0 },
                }),
              }),
            ],
          });
          const resumed = await withIdentitySourceConsumerMaintenance(
            { pool, env: {} },
            { deadline: Date.now() + 5000 },
            () => step(pool, job),
          );
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
          expect(await prepare(pool, request)).toEqual({ state: 'prepared' });
          expect(committedOperation?.state).toBe('visible');
          expect(receiptText).toContain('"kind":"bulk"');
          expect(await prepare(pool, request)).toEqual({ state: 'prepared' });
          const expectedAllocationReads =
            5 +
            2 * Number(canonicalTerms) +
            2 * Number(adoptedName) +
            3 * Number(adoptedRelation) +
            Number(mode === 'dispatch');
          expect(engineReads).toBe(expectedAllocationReads);
          const applied = await withIdentitySourceConsumerMaintenance(
            { pool, env: {} },
            { deadline: Date.now() + 5000 },
            () => step(pool, job),
          );
          expect(applied.state).toBe('more');
          expect(applied.frontier.after).toEqual([selected, retainedPlan?.effect_key]);
          expect(applied.receipt.native.position).toBe(BigInt(applicationPosition));
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
          expect(await prepare(pool, request)).toEqual({ state: 'prepared' });
          expect(receivingContinuation.state).toBe('released');
          expect(hold?.released_transaction_id).toBe(receivingContinuation.released_transaction_id);
          const retired = await withIdentitySourceConsumerMaintenance(
            { pool, env: {} },
            { deadline: Date.now() + 5000 },
            () => step(pool, job),
          );
          expect(retired.frontier.after).toEqual(['search-directory', selected, 1]);
          expect(retiredScope).toBe(true);
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
});
