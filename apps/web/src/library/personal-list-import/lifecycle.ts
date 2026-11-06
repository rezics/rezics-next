import recordedLibrary from '../../kernel/recorded/library-entries.json';
import { createVndbJourney, type VndbJourneySnapshot } from './controller';
import type { VndbPage, VndbPort, VndbPreview, VndbRow } from './contract';
import type { ImportLibraryPage } from '../showcase-import-return/read';
import type { ImportLibrarySnapshot } from '../showcase-import-return/browser';
import type { VndbVisit } from './visit';

/** Recorded Library identities stay independent of this private import acknowledgement. */
export const VNDB_LIFECYCLE_UPLOAD = '00000000-0000-4000-8000-000000000001';
export const VNDB_LIFECYCLE_TARGET = '00000000-0000-4000-8000-000000000002';
export const VNDB_LIFECYCLE_REVIEW = '00000000-0000-4000-8000-000000000003';
export const VNDB_LIFECYCLE_SCORE_REVIEW = '00000000-0000-4000-8000-000000000004';
export const VNDB_LIFECYCLE_QUESTION = {
  id: '00000000-0000-7000-8000-000000000001',
  revision: 1,
  meaning: 'enjoyment',
  label: 'Enjoyment',
  grain: 'work' as const,
  scale: { min: 0, max: 20, step: 1 },
  aggregateEffect: 'public-standard-aggregate' as const,
};

export const VNDB_LIFECYCLE_LIMITS: VndbPreview['limits'] = {
  bytes: 2097152,
  wireBytes: 12582976,
  depth: 32,
  rows: 5000,
  evidenceBytes: 16777216,
  page: 8,
  uploads: 4,
  lifetimeMs: 86400000,
  applyMs: 5000,
};

export const VNDB_LIFECYCLE_PREVIEW: VndbPreview = {
  uploadId: VNDB_LIFECYCLE_UPLOAD,
  rows: 2,
  limits: VNDB_LIFECYCLE_LIMITS,
};

const playing = {
  id: 'playing',
  labels: { en: 'Playing', ja: 'プレイ中', 'zh-Hant': '遊玩中' },
};

const nativeScore = {
  question: VNDB_LIFECYCLE_QUESTION,
  currentVote: { state: 'absent' as const },
  sourceReason: 'VNDB 7.0 has an exact native-unit candidate of 14; explicitly choose it before adoption.',
  exactUnits: 14,
  admission: { status: 'conditional' as const, reason: null },
};

/** Native-shaped owner preview: one matched VN and one unmatched row, with private source evidence. */
export function vndbLifecyclePreviewRow(overrides: Partial<VndbRow> = {}): VndbRow {
  return {
    ordinal: 0,
    kind: 'vn',
    title: 'とても長い原題 — 繁體中文與日本語を含む物語のタイトル',
    identifier: { provider: 'vndb', kind: 'vn', value: 'v123' },
    labels: ['Playing'],
    suggestedRole: 'active',
    fields: {
      score: { kind: 'value', raw: '07.0', value: 7, scale: { min: 1, max: 10, step: 0.1 } },
      notes: { kind: 'value', raw: 'Private source note', value: 'Private source note' },
    },
    retainedReason: '',
    evidence: { releases: [{ id: 'r456' }] },
    match: { status: 'matched', candidates: [VNDB_LIFECYCLE_TARGET] },
    target: {
      targetId: VNDB_LIFECYCLE_TARGET,
      states: [playing],
      baseline: null,
    },
    decision: null,
    scoreDecision: null,
    consumptionDateReview: null,
    consumptionDateOutcome: null,
    nativeScore,
    fieldsTreatment: { state: 'review', score: 'private source', other: 'retain' },
    ...overrides,
  };
}

export function vndbLifecycleUnmatchedRow(): VndbRow {
  return vndbLifecyclePreviewRow({
    ordinal: 1,
    title: 'Unmatched private title',
    identifier: { provider: 'vndb', kind: 'vn', value: 'v999' },
    labels: [],
    suggestedRole: null,
    fields: { score: { kind: 'missing', raw: null } },
    match: { status: 'unmatched', candidates: [] },
    target: null,
    nativeScore: {
      question: VNDB_LIFECYCLE_QUESTION,
      currentVote: { state: 'unavailable' },
      sourceReason: 'No source score was supplied; absence never clears a native vote.',
      exactUnits: null,
      admission: { status: 'conditional', reason: null },
    },
  });
}

export function vndbLifecycleZeroClearRow(): VndbRow {
  return vndbLifecyclePreviewRow({
    ordinal: 1,
    title: 'Source zero stays invalid',
    identifier: { provider: 'vndb', kind: 'vn', value: 'v124' },
    fields: { score: { kind: 'invalid', raw: '0' } },
    nativeScore: {
      question: VNDB_LIFECYCLE_QUESTION,
      currentVote: { state: 'set', units: 0, revision: 4, at: '2026-11-04T00:01:00Z' },
      sourceReason: 'Zero is invalid on VNDB’s 1–10 source scale.',
      exactUnits: null,
      admission: { status: 'conditional', reason: null },
    },
  });
}

export function vndbLifecycleReviewedRow(): VndbRow {
  return vndbLifecyclePreviewRow({
    decision: {
      reviewId: VNDB_LIFECYCLE_REVIEW,
      status: 'reviewed',
      targetId: VNDB_LIFECYCLE_TARGET,
      state: 'playing',
      baseline: null,
      replace: false,
      action: 'state',
      progress: null,
    },
    scoreDecision: {
      reviewId: VNDB_LIFECYCLE_SCORE_REVIEW,
      status: 'reviewed',
      targetId: VNDB_LIFECYCLE_TARGET,
      action: 'vote',
      units: 14,
      question: VNDB_LIFECYCLE_QUESTION,
      currentVote: { state: 'absent' },
      consent: 'adopt-native-vote',
      sourceReason: nativeScore.sourceReason,
      nativeAdmission: 'conditional',
    },
  });
}

export function vndbLifecycleAppliedRow(): VndbRow {
  const reviewed = vndbLifecycleReviewedRow();
  return {
    ...reviewed,
    decision: reviewed.decision && { ...reviewed.decision, status: 'applied' },
    scoreDecision:
      reviewed.scoreDecision && 'action' in reviewed.scoreDecision
        ? { ...reviewed.scoreDecision, status: 'applied' }
        : reviewed.scoreDecision,
  };
}

export function vndbLifecycleChangedRow(): VndbRow {
  return vndbLifecyclePreviewRow({
    title: 'Changed export title',
    fields: {
      score: { kind: 'value', raw: '8.2', value: 8.2, scale: { min: 1, max: 10, step: 0.1 } },
      notes: { kind: 'value', raw: 'Replacement private note', value: 'Replacement private note' },
    },
    nativeScore: {
      ...nativeScore,
      currentVote: { state: 'set', units: 14, revision: 2, at: '2026-11-06T00:00:00Z' },
      sourceReason: 'VNDB 8.2 has no exact standard half-point value; choose native units deliberately.',
      exactUnits: null,
    },
  });
}

export function vndbLifecyclePage(rows: VndbRow[], next: number | null = null): VndbPage {
  return {
    uploadId: VNDB_LIFECYCLE_UPLOAD,
    state: 'active',
    expiresAt: '2099-01-01T00:00:00Z',
    total: rows.length,
    next,
    rows,
  };
}

export const VNDB_LIFECYCLE_XML =
  '<vndb-export version="1.0"><vns><vn id="v123"><title>とても長い原題</title><vote>7.0</vote><notes>Private source note</notes></vn></vns></vndb-export>';

export const VNDB_LIFECYCLE_CHANGED_XML =
  '<vndb-export version="1.0"><vns><vn id="v123"><title>Changed export title</title><vote>8.2</vote></vn></vns></vndb-export>';

function visit(): VndbVisit {
  const controller = new AbortController();
  return {
    subject: VNDB_LIFECYCLE_TARGET,
    csrfToken: 'recorded-csrf',
    controller,
    current: () => !controller.signal.aborted,
    retire: () => controller.abort(),
  };
}

const unavailable = async () => ({ kind: 'unavailable' as const, status: 503 });

function vndbLifecycleReviewed(command: { body: { action?: string } }): Extract<
  Awaited<ReturnType<VndbPort['review']>>,
  { kind: 'reviewed' }
> {
  return command.body.action === 'score'
    ? {
        kind: 'reviewed',
        value: {
          reviewId: VNDB_LIFECYCLE_SCORE_REVIEW,
          status: 'reviewed',
          targetId: VNDB_LIFECYCLE_TARGET,
          action: 'vote',
          units: 14,
          question: VNDB_LIFECYCLE_QUESTION,
          currentVote: { state: 'absent' },
          consent: 'adopt-native-vote',
          sourceReason: nativeScore.sourceReason,
          nativeAdmission: 'conditional',
        },
      }
    : {
        kind: 'reviewed',
        value: {
          reviewId: VNDB_LIFECYCLE_REVIEW,
          status: 'reviewed',
          targetId: VNDB_LIFECYCLE_TARGET,
          state: 'playing',
          baseline: null,
          replace: false,
          action: 'state',
          progress: null,
        },
      };
}

export function vndbLifecyclePort(page: VndbPage, overrides: Partial<VndbPort> = {}): VndbPort {
  return {
    preview: async () => ({ kind: 'previewed', value: { ...VNDB_LIFECYCLE_PREVIEW, rows: page.total } }),
    page: async () => ({ kind: 'page', value: page }),
    source: async () => ({ kind: 'source', xml: VNDB_LIFECYCLE_XML }),
    review: async (command) => vndbLifecycleReviewed(command),
    apply: async (command) => ({
      kind: 'applied',
      value: {
        uploadId: VNDB_LIFECYCLE_UPLOAD,
        outcomes: command.body.rows.map((row) =>
          row.scoreReviewId
            ? { ordinal: row.ordinal, scoreReviewId: row.scoreReviewId, status: 'unavailable' as const }
            : { ordinal: row.ordinal, reviewId: row.reviewId!, status: 'applied' as const },
        ),
        stopped: null,
      },
    }),
    cancel: unavailable,
    delete: unavailable,
    ...overrides,
  };
}

export async function vndbLifecyclePreviewSnapshot(): Promise<VndbJourneySnapshot> {
  const journey = createVndbJourney({
    visit: visit(),
    port: vndbLifecyclePort(vndbLifecyclePage([vndbLifecyclePreviewRow(), vndbLifecycleUnmatchedRow()])),
  });
  await journey.preview(VNDB_LIFECYCLE_XML);
  await journey.source();
  return journey.snapshot();
}

export async function vndbLifecycleScoreReviewSnapshot(): Promise<VndbJourneySnapshot> {
  const row = vndbLifecycleReviewedRow();
  const journey = createVndbJourney({
    visit: visit(),
    port: vndbLifecyclePort(vndbLifecyclePage([row, vndbLifecycleZeroClearRow()])),
  });
  await journey.preview(VNDB_LIFECYCLE_XML);
  return journey.snapshot();
}

export async function vndbLifecyclePartialResultSnapshot(): Promise<VndbJourneySnapshot> {
  const row = vndbLifecycleReviewedRow();
  const journey = createVndbJourney({
    visit: visit(),
    port: vndbLifecyclePort(vndbLifecyclePage([row])),
  });
  await journey.preview(VNDB_LIFECYCLE_XML);
  await journey.review({
    ordinal: 0,
    action: 'score',
    targetId: VNDB_LIFECYCLE_TARGET,
    questionId: VNDB_LIFECYCLE_QUESTION.id,
    questionRevision: VNDB_LIFECYCLE_QUESTION.revision,
    selection: { kind: 'vote', units: 14 },
    consent: 'adopt-native-vote',
  });
  await journey.review({
    ordinal: 0,
    action: 'state',
    targetId: VNDB_LIFECYCLE_TARGET,
    state: 'playing',
    replace: false,
  });
  journey.openConfirm();
  return journey.confirm();
}

export async function vndbLifecycleReopenSnapshot(): Promise<VndbJourneySnapshot> {
  const row = vndbLifecycleAppliedRow();
  const journey = createVndbJourney({
    visit: visit(),
    port: vndbLifecyclePort(vndbLifecyclePage([row])),
  });
  return journey.reopen({ uploadId: VNDB_LIFECYCLE_UPLOAD, offset: 0 });
}

export async function vndbLifecycleChangedReimportSnapshot(): Promise<VndbJourneySnapshot> {
  let page = vndbLifecyclePage([vndbLifecyclePreviewRow()]);
  const journey = createVndbJourney({
    visit: visit(),
    port: vndbLifecyclePort(page, {
      preview: async (command) => ({
        kind: 'previewed',
        value: {
          ...VNDB_LIFECYCLE_PREVIEW,
          uploadId: command.xml === VNDB_LIFECYCLE_CHANGED_XML ? '00000000-0000-4000-8000-000000000009' : VNDB_LIFECYCLE_UPLOAD,
          rows: 1,
        },
      }),
      page: async () => ({ kind: 'page', value: page }),
      delete: async () => ({ kind: 'deleted' as const }),
    }),
  });
  await journey.preview(VNDB_LIFECYCLE_XML);
  page = vndbLifecyclePage([vndbLifecycleChangedRow()]);
  await journey.preview(VNDB_LIFECYCLE_CHANGED_XML);
  return journey.snapshot();
}

export function vndbLifecycleLibraryPage(): ImportLibraryPage {
  const entries = recordedLibrary.libraryEntries.slice(0, 3);
  return {
    libraryEntries: entries,
    next: null,
    viewerFacts: {
      state: 'current',
      question: {
        id: VNDB_LIFECYCLE_QUESTION.id,
        revision: VNDB_LIFECYCLE_QUESTION.revision,
        grain: VNDB_LIFECYCLE_QUESTION.grain,
        meaning: VNDB_LIFECYCLE_QUESTION.meaning,
        scale: { min: 0, max: 20, displayStep: 1 },
      },
      rows: [
        {
          rowKey: '0',
          subjectId: entries[0]!.subjectId,
          entry: { state: 'present', incarnationId: null, entryState: entries[0]!.state, revision: entries[0]!.revision },
          vote: { state: 'present', questionId: VNDB_LIFECYCLE_QUESTION.id, questionRevision: 1, units: 0, revision: 4 },
        },
        {
          rowKey: '1',
          subjectId: entries[1]!.subjectId,
          entry: { state: 'present', incarnationId: null, entryState: entries[1]!.state, revision: entries[1]!.revision },
          vote: { state: 'absent', questionId: VNDB_LIFECYCLE_QUESTION.id, questionRevision: 1 },
        },
        {
          rowKey: '2',
          subjectId: entries[2]!.subjectId,
          entry: { state: 'present', incarnationId: null, entryState: entries[2]!.state, revision: entries[2]!.revision },
          vote: { state: 'unavailable', reason: 'scope' },
        },
      ],
    },
  };
}

export function vndbLifecycleLibrarySnapshot(): ImportLibrarySnapshot {
  return {
    visible: { state: 'current', page: vndbLifecycleLibraryPage() },
    cursor: null,
    pending: null,
    failed: null,
    revision: 1,
    retired: false,
  };
}

/** Another viewer receives only independently authorized current facts, never private source XML. */
export function vndbLifecycleOtherViewerPage(): ImportLibraryPage {
  const entries = recordedLibrary.libraryEntries.slice(0, 2);
  return {
    libraryEntries: entries,
    next: null,
    viewerFacts: { state: 'unavailable', reason: 'identity', retryable: false },
  };
}

export function vndbLifecycleOtherViewerSnapshot(): ImportLibrarySnapshot {
  return {
    visible: { state: 'current', page: vndbLifecycleOtherViewerPage() },
    cursor: null,
    pending: null,
    failed: null,
    revision: 1,
    retired: false,
  };
}

export function vndbLifecycleUnavailableFactsPage(): ImportLibraryPage {
  return {
    libraryEntries: recordedLibrary.libraryEntries.slice(0, 2),
    next: null,
    viewerFacts: { state: 'unavailable', reason: 'currentness', retryable: true },
  };
}
