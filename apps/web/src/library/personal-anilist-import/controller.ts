import {
  ANILIST_UPLOAD_BYTES,
  boundedHeader,
  chunkConfirmations,
  encodedBytes,
  newCommandKey,
  type AniListLabelSelection,
  type AniListLabelReview,
  type AniListCommand,
  type AniListCompleteness,
  type AniListConfirmation,
  type AniListFailure,
  type AniListHeader,
  type AniListImportPort,
  type AniListQuestion,
  type AniListQuestionResult,
  type AniListOutcome,
  type AniListPage,
  type AniListRow,
  type AniListRowMeta,
  type AniListScoreFormat,
  type AniListUnknown,
} from './contract';
import { AniListCostLedger, type AniListCostSnapshot } from './cost';
import { aniListGroupLabel, aniListIsRepeating, aniListMediaType, aniListStatusOf, aniListTitle } from './meaning';
import { sourceAdmissionBlock, sourceAdmissionBody } from '../rich-private-entry/admission';
import { aniListSourcePreview } from './source';
import type { AniListVisit } from './visit';

export type AniListStage = 'upload' | 'review' | 'confirm' | 'applying' | 'results' | 'cancelled' | 'removed';

export type AniListNotice =
  | AniListFailure
  | AniListUnknown
  | { kind: 'too-large' }
  | { kind: 'empty' }
  | { kind: 'started-locked' }
  | null;

export type AniListJourneySnapshot = {
  stage: AniListStage;
  busy: boolean;
  notice: AniListNotice;
  importId: string | null;
  count: number;
  after: number;
  next: number | null;
  cancelled: boolean;
  scoreFormat: AniListScoreFormat | null;
  completeness: AniListCompleteness | null;
  page: AniListRow[];
  meta: AniListRowMeta[];
  outcomes: AniListOutcome[];
  remaining: number[];
  applying: number;
  applied: number;
  confirmPrivacy: boolean;
  confirmTimestamps: boolean;
  question: AniListQuestion | null;
  questionPending: boolean;
  questionNotice: AniListFailure | null;
  owner: string;
  cost: AniListCostSnapshot;
};

const untitled = 'AniList';

function emptyCompleteness(): AniListCompleteness {
  return { wrapper: 'unknown', hasNextChunk: false, listedGroups: 0 };
}

function emptyHeader(): AniListHeader {
  return { document: null, rawUpload: '', scoreFormat: null, count: 0, cancelled: false };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function scoreReviewMeta(row: AniListRow): AniListRowMeta['scoreReview'] {
  const review = row.review;
  const raw = review?.score;
  if (!review || !record(raw) || (raw.action !== 'vote' && raw.action !== 'clear')) return null;
  const native = record(raw.native) ? raw.native : {};
  const question = record(native.question) ? native.question : {};
  const target = record(native.target) ? native.target : {};
  const current = record(native.currentVote) ? native.currentVote : {};
  const vote = current.status === 'current' && record(current.vote) ? current.vote : null;
  const reason = typeof current.reason === 'string' ? current.reason : null;
  const unavailable = native.availability !== 'available' ? 'unavailable' : 'available';
  return {
    reviewId: review.id,
    commandKey: typeof native.commandKey === 'string' ? native.commandKey : null,
    consentKey: typeof native.consentKey === 'string' ? native.consentKey : null,
    action: raw.action,
    units: finiteInteger(raw.units),
    questionId: typeof question.id === 'string' ? question.id : null,
    questionRevision: finiteInteger(question.revision),
    questionLabel: typeof question.label === 'string' ? question.label : null,
    questionMeaning: typeof question.meaning === 'string' ? question.meaning : null,
    questionGrain: typeof question.grain === 'string' ? question.grain : null,
    minimumUnits: finiteInteger(question.minimumUnits),
    maximumUnits: finiteInteger(question.maximumUnits),
    stepUnits: finiteInteger(question.stepUnits),
    questionLifecycleState: typeof question.lifecycleState === 'string' ? question.lifecycleState : null,
    questionLifecycleRevision: finiteInteger(question.lifecycleRevision),
    targetId: typeof target.subjectId === 'string' ? target.subjectId : null,
    identityEpoch: typeof target.identityEpoch === 'string' ? target.identityEpoch : null,
    matchFingerprint: typeof target.matchFingerprint === 'string' ? target.matchFingerprint : null,
    currentVoteUnits: vote ? finiteInteger(vote.units) : null,
    currentVote:
      current.status === 'unavailable' || unavailable === 'unavailable' ? 'unavailable' : vote ? 'present' : 'absent',
    currentVoteReason: reason,
    availability: unavailable,
    availabilityReason: typeof native.reason === 'string' ? native.reason : null,
    guard: native.guard ?? null,
    nativeEvidence: raw,
  };
}

function scoreSourceMeta(row: AniListRow, scoreFormat: AniListScoreFormat | null): AniListRowMeta['scoreSource'] {
  if (!Object.hasOwn(row.source.evidence, 'score')) return null;
  const field = row.source.fields.find((candidate) => candidate.field === 'score');
  return {
    value: row.source.evidence.score!,
    lexeme:
      typeof row.scoreLexeme === 'string'
        ? row.scoreLexeme
        : typeof row.source.scoreLexeme === 'string'
          ? row.source.scoreLexeme
          : null,
    scale: scoreFormat,
    validity: field?.validity ?? 'unknown',
    reason: field?.reason ?? 'The source score was retained without a field mapping.',
  };
}

function metaFromRow(
  row: AniListRow,
  previous?: AniListRowMeta,
  scoreFormat: AniListScoreFormat | null = null,
): AniListRowMeta {
  const review = previous?.reviewInvalidated ? null : row.review;
  const observation = review?.observation ?? row.proposal;
  const match = review?.match.state ?? row.match.state;
  const status = aniListStatusOf(row.source.evidence);
  return {
    ordinal: row.ordinal,
    ...(row.labelEvidence
      ? {
          labels: {
            subjectId:
              previous?.labels?.subjectId ??
              row.labelReview?.subjectId ??
              observation?.subjectId ??
              (row.match.state === 'matched' ? (row.match.candidates[0] ?? null) : null),
            selections:
              previous?.labels?.selections ??
              row.labelReview?.items.map((item) => ({
                key: item.key,
                target: 'label' in item.target ? { labelId: item.target.label.id } : { name: item.target.name },
              })) ??
              [],
            review: previous?.labels?.invalidated ? null : (row.labelReview ?? null),
            invalidated: previous?.labels?.invalidated ?? false,
            outcomes: previous?.labels?.outcomes?.reviewId === row.labelReview?.id ? previous.labels.outcomes : null,
          },
        }
      : {}),
    title: aniListTitle(row.source.evidence, untitled),
    mediaType: aniListMediaType(row.source.evidence),
    status,
    match,
    target: review?.input.subjectId ?? observation?.subjectId ?? previous?.target ?? null,
    proposedState: observation?.proposedState ?? previous?.proposedState ?? null,
    current: observation?.current ?? previous?.current ?? null,
    reviewId: previous?.reviewInvalidated ? null : (review?.id ?? previous?.reviewId ?? null),
    skip: previous?.skip ?? review?.input.skip ?? false,
    replace: previous?.replace ?? review?.input.replace ?? false,
    applyStatus: previous?.applyStatus ?? review?.input.fields.includes('status') ?? true,
    started: row.started || previous?.started === true,
    outcome: row.outcome ?? previous?.outcome ?? null,
    currentScore: Object.hasOwn(row, 'currentScore') ? row.currentScore : (previous?.currentScore ?? null),
    reviewInvalidated: previous?.reviewInvalidated ?? false,
    scoreSource: scoreSourceMeta(row, scoreFormat) ?? previous?.scoreSource ?? null,
    scoreAction: previous?.reviewInvalidated
      ? (previous.scoreAction ?? 'keep')
      : (scoreReviewMeta(row)?.action ?? previous?.scoreAction ?? 'keep'),
    scoreUnits: previous?.reviewInvalidated
      ? (previous.scoreUnits ?? null)
      : (scoreReviewMeta(row)?.units ?? previous?.scoreUnits ?? null),
    scoreReview: previous?.reviewInvalidated ? null : (scoreReviewMeta(row) ?? previous?.scoreReview ?? null),
    nativeVoteConsent:
      !previous?.reviewInvalidated &&
      previous?.nativeVoteConsent &&
      scoreReviewMeta(row)?.reviewId === previous.nativeVoteConsent.reviewId &&
      scoreReviewMeta(row)?.consentKey === previous.nativeVoteConsent.consentKey
        ? previous.nativeVoteConsent
        : null,
    identifiers: row.source.identifiers,
    groupLabel: aniListGroupLabel(row.source.group),
    repeating: aniListIsRepeating(status),
    sourcePreview: previous?.sourcePreview ?? aniListSourcePreview(row),
    sourceAdmission: previous?.sourceAdmission ?? null,
  };
}

function pageForRetain(page: AniListPage | null): AniListPage | null {
  if (!page) return null;
  return { ...page, header: boundedHeader(page.header) };
}

export function createAniListJourney(input: { port: AniListImportPort; visit: AniListVisit }) {
  const { port, visit } = input;
  const sender = { subject: visit.subject, csrfToken: visit.csrfToken };
  const cost = new AniListCostLedger();
  const meta = new Map<number, AniListRowMeta>();
  let stage: AniListStage = 'upload';
  let busy = false;
  let notice: AniListNotice = null;
  let importId: string | null = null;
  let count = 0;
  let after = -1;
  let next: number | null = null;
  let cancelled = false;
  let scoreFormat: AniListScoreFormat | null = null;
  let completeness: AniListCompleteness | null = null;
  let page: AniListRow[] = [];
  let outcomes: AniListOutcome[] = [];
  let remaining: number[] = [];
  let applying = 0;
  let applied = 0;
  let uploadText: string | null = null;
  let unknown: AniListCommand | null = null;
  let applyCommand: Extract<AniListCommand, { kind: 'apply' }> | null = null;
  let applyQueue: AniListConfirmation[][] = [];
  let admitQueue: Extract<AniListCommand, { kind: 'admit-source' }>[] = [];
  let stopApply = false;
  let confirmPrivacy = false;
  let confirmTimestamps = false;
  let generation = 0;
  let questionGeneration = 0;
  let question: AniListQuestion | null = null;
  let questionPending = false;
  let questionNotice: AniListFailure | null = null;

  function live(): boolean {
    return (
      visit.current() &&
      sender.subject === visit.subject &&
      sender.csrfToken === visit.csrfToken &&
      !visit.controller.signal.aborted
    );
  }

  function retain(): void {
    cost.retain({
      upload: uploadText,
      page: page.length
        ? pageForRetain({
            importId: importId ?? '',
            header: {
              ...emptyHeader(),
              scoreFormat,
              count,
              cancelled,
            },
            completeness: completeness ?? emptyCompleteness(),
            rows: page,
            next,
          })
        : null,
      meta: meta.values(),
      command: unknown,
    });
    cost.recordRender(page.length);
  }

  function heldUnknown(): boolean {
    return notice !== null && notice.kind === 'unknown';
  }

  function snapshot(): AniListJourneySnapshot {
    retain();
    return {
      stage,
      busy,
      notice,
      importId,
      count,
      after,
      next,
      cancelled,
      scoreFormat,
      completeness,
      page,
      meta: [...meta.values()].sort((left, right) => left.ordinal - right.ordinal),
      outcomes,
      remaining,
      applying,
      applied,
      confirmPrivacy,
      confirmTimestamps,
      question,
      questionPending,
      questionNotice,
      owner: sender.subject,
      cost: { ...cost.snapshot, calls: { ...cost.snapshot.calls } },
    };
  }

  function clearPrivate(resetStage: AniListStage = 'upload'): void {
    generation += 1;
    unknown = null;
    applyCommand = null;
    applyQueue = [];
    admitQueue = [];
    stopApply = false;
    confirmPrivacy = false;
    confirmTimestamps = false;
    questionGeneration += 1;
    question = null;
    questionPending = false;
    questionNotice = null;
    uploadText = null;
    importId = null;
    count = 0;
    after = -1;
    next = null;
    cancelled = false;
    scoreFormat = null;
    completeness = null;
    page = [];
    outcomes = [];
    remaining = [];
    applying = 0;
    applied = 0;
    meta.clear();
    stage = resetStage;
    notice = null;
    busy = false;
  }

  async function run<T extends { kind: string }>(
    command: AniListCommand,
    send: () => Promise<T | AniListFailure | AniListUnknown>,
    retry = false,
  ): Promise<T | undefined> {
    if (!live() || busy) return;
    busy = true;
    const response = await send();
    if (!live()) return;
    busy = false;
    if (command.kind !== 'admit-source') cost.recordCall(command.kind, retry);
    if (response.kind === 'unknown') {
      unknown = (response as AniListUnknown).command;
      notice = response as AniListUnknown;
      if (command.kind !== 'preview') uploadText = null;
      retain();
      return;
    }
    unknown = null;
    if (command.kind === 'preview') uploadText = null;
    if (
      response.kind === 'previewed' ||
      response.kind === 'page' ||
      response.kind === 'reviewed' ||
      response.kind === 'applied' ||
      response.kind === 'labels-reviewed' ||
      response.kind === 'labels-applied' ||
      response.kind === 'labels-read' ||
      response.kind === 'cancelled'
    ) {
      notice = null;
      return response as T;
    }
    notice = response as AniListFailure;
    retain();
    return;
  }

  async function loadPage(
    id: string,
    cursor: number,
    retry = false,
    loadedStage: 'review' | 'results' = 'review',
  ): Promise<AniListJourneySnapshot> {
    const command: Extract<AniListCommand, { kind: 'page' }> = { kind: 'page', importId: id, after: cursor };
    const response = await run(command, () => port.page(command), retry);
    if (!response || response.kind !== 'page' || !live()) return snapshot();
    const current = response.page;
    importId = id;
    page = current.rows;
    after = cursor;
    next = current.next;
    cancelled = current.header.cancelled;
    scoreFormat = current.header.scoreFormat;
    completeness = current.completeness;
    count = current.header.count || count;
    for (const row of current.rows) meta.set(row.ordinal, metaFromRow(row, meta.get(row.ordinal), scoreFormat));
    cost.recordPage(current);
    stage = cancelled ? 'cancelled' : loadedStage;
    retain();
    return snapshot();
  }

  async function readQuestion(): Promise<AniListJourneySnapshot> {
    if (!live() || busy) return snapshot();
    const token = ++questionGeneration;
    questionPending = true;
    questionNotice = null;
    cost.recordCall('question');
    const response: AniListQuestionResult = await port.question();
    if (!live() || token !== questionGeneration) return snapshot();
    questionPending = false;
    if (response.kind === 'question') {
      question = response.question;
      questionNotice = null;
    } else {
      question = null;
      questionNotice = response;
    }
    return snapshot();
  }

  async function preview(upload: string, format?: AniListScoreFormat | null): Promise<AniListJourneySnapshot> {
    if (!live()) return snapshot();
    if (!upload) {
      notice = { kind: 'empty' };
      return snapshot();
    }
    if (encodedBytes(upload) > ANILIST_UPLOAD_BYTES) {
      notice = { kind: 'too-large' };
      return snapshot();
    }
    const previous = importId;
    if (previous) {
      const remove: Extract<AniListCommand, { kind: 'cancel' }> = {
        kind: 'cancel',
        importId: previous,
        key: newCommandKey(),
        remove: true,
      };
      await port.cancel(remove);
      cost.recordCall('cancel');
      if (!live()) return snapshot();
      clearPrivate();
    }
    uploadText = upload;
    const command: Extract<AniListCommand, { kind: 'preview' }> = {
      kind: 'preview',
      key: newCommandKey(),
      upload,
      ...(format ? { scoreFormat: format } : {}),
    };
    const response = await run(command, () => port.preview(command));
    if (!response || response.kind !== 'previewed' || !live()) return snapshot();
    importId = response.importId;
    count = response.count;
    uploadText = null;
    return loadPage(response.importId, -1);
  }

  async function review(ordinal: number, target?: string | null): Promise<AniListJourneySnapshot> {
    const id = importId;
    const current = meta.get(ordinal);
    if (!id || !live() || heldUnknown() || busy) return snapshot();
    if (stage === 'applying') return snapshot();
    if (current?.started) {
      notice = { kind: 'started-locked' };
      return snapshot();
    }
    const skip = current?.skip ?? false;
    const replace = current?.replace ?? false;
    const applyStatus = current?.applyStatus ?? true;
    const scoreAction = skip ? 'keep' : (current?.scoreAction ?? 'keep');
    let score:
      | Extract<NonNullable<Extract<AniListCommand, { kind: 'review' }>['score']>, { action: 'vote' | 'clear' }>
      | undefined;
    if (scoreAction !== 'keep') {
      busy = true;
      let questionResult: AniListQuestionResult;
      try {
        questionResult = await port.question();
      } finally {
        busy = false;
      }
      cost.recordCall('question');
      if (!live()) return snapshot();
      if (questionResult.kind !== 'question') {
        question = null;
        questionNotice = questionResult;
        questionPending = false;
        return snapshot();
      }
      const latest = questionResult.question;
      question = latest;
      questionNotice = null;
      questionPending = false;
      const units = current?.scoreUnits;
      if (
        scoreAction === 'vote' &&
        (units === null ||
          units === undefined ||
          !Number.isSafeInteger(units) ||
          units < latest.scale.min ||
          units > latest.scale.max ||
          (units - latest.scale.min) % latest.scale.displayStep !== 0)
      ) {
        questionNotice = { kind: 'conflict' };
        return snapshot();
      }
      score =
        scoreAction === 'vote'
          ? { action: 'vote', questionId: latest.id, questionRevision: latest.revision, units: units! }
          : { action: 'clear', questionId: latest.id, questionRevision: latest.revision };
    }
    if (current) {
      current.reviewId = null;
      current.scoreReview = null;
      current.nativeVoteConsent = null;
      current.reviewInvalidated = true;
    }
    const currentPageRow = page.find((item) => item.ordinal === ordinal);
    if (currentPageRow) currentPageRow.review = null;
    const command: Extract<AniListCommand, { kind: 'review' }> = {
      kind: 'review',
      key: newCommandKey(),
      importId: id,
      ordinal,
      fields: skip || !applyStatus ? [] : ['status'],
      replace,
      ...(score === undefined ? {} : { score }),
      ...(skip ? { skip: true } : {}),
      ...(target ? { subjectId: target } : {}),
    };
    const response = await run(command, () => port.review(command));
    if (!response || response.kind !== 'reviewed' || !live()) return snapshot();
    cost.recordReview();
    const row = page.find((item) => item.ordinal === ordinal)!;
    row.review = response.review;
    meta.set(ordinal, {
      ...(current ?? metaFromRow(row, undefined, scoreFormat)),
      match: response.review.match.state,
      target: response.review.input.subjectId ?? response.review.observation?.subjectId ?? target ?? null,
      proposedState: response.review.observation?.proposedState ?? null,
      current: response.review.observation?.current ?? null,
      reviewId: response.review.id,
      skip: response.review.input.skip === true,
      replace: response.review.input.replace === true,
      applyStatus: response.review.input.fields.includes('status'),
      reviewInvalidated: false,
      scoreSource: scoreSourceMeta(row, scoreFormat) ?? current?.scoreSource ?? null,
      scoreAction: response.review.input.score?.action ?? 'keep',
      scoreUnits: response.review.input.score?.action === 'vote' ? response.review.input.score.units : null,
      scoreReview: scoreReviewMeta(row),
      currentScore: Object.hasOwn(row, 'currentScore') ? row.currentScore : (current?.currentScore ?? null),
      nativeVoteConsent: null,
      outcome: null,
    });
    retain();
    return snapshot();
  }

  function choose(
    ordinal: number,
    choice: {
      skip?: boolean;
      replace?: boolean;
      applyStatus?: boolean;
      scoreAction?: 'keep' | 'vote' | 'clear';
      scoreUnits?: number | null;
    },
  ): AniListJourneySnapshot {
    const current = meta.get(ordinal);
    if (!current || stage === 'applying' || current.started || heldUnknown()) return snapshot();
    const before = [current.skip, current.replace, current.applyStatus, current.scoreAction, current.scoreUnits];
    current.skip = choice.skip ?? current.skip;
    current.replace = current.skip ? false : (choice.replace ?? current.replace);
    current.applyStatus = current.skip ? false : (choice.applyStatus ?? current.applyStatus);
    current.scoreAction = current.skip ? 'keep' : (choice.scoreAction ?? current.scoreAction);
    current.scoreUnits =
      current.scoreAction === 'vote'
        ? choice.scoreUnits === undefined
          ? current.scoreUnits
          : choice.scoreUnits
        : null;
    const after = [current.skip, current.replace, current.applyStatus, current.scoreAction, current.scoreUnits];
    if (before.some((value, index) => value !== after[index])) {
      current.reviewId = null;
      current.scoreReview = null;
      current.nativeVoteConsent = null;
      current.reviewInvalidated = true;
      const row = page.find((item) => item.ordinal === ordinal);
      if (row) row.review = null;
    }
    retain();
    return snapshot();
  }

  function confirmVoteEffect(ordinal: number, consent: boolean): AniListJourneySnapshot {
    const row = meta.get(ordinal);
    const score = row?.scoreReview;
    if (!row || stage !== 'confirm' || heldUnknown() || !score?.consentKey || !score.reviewId) return snapshot();
    row.nativeVoteConsent = consent ? { reviewId: score.reviewId, consentKey: score.consentKey } : null;
    retain();
    return snapshot();
  }

  function reviewedConfirmations(): AniListConfirmation[] {
    return [...meta.values()]
      .filter((row) => row.reviewId)
      .map((row) => {
        const score = row.scoreReview;
        const consent = row.nativeVoteConsent;
        return {
          ordinal: row.ordinal,
          reviewId: row.reviewId!,
          ...(score &&
          consent?.reviewId === score.reviewId &&
          consent.consentKey === score.consentKey &&
          score.consentKey
            ? { confirmNativeVoteEffects: true as const }
            : {}),
        };
      });
  }

  async function applyBatch(batch: AniListConfirmation[], retry = false): Promise<boolean> {
    const id = importId;
    if (!id || !live() || stopApply) return false;
    const command: Extract<AniListCommand, { kind: 'apply' }> = {
      kind: 'apply',
      importId: id,
      body: { confirmations: batch },
    };
    applyCommand = command;
    applying = batch.length;
    const response = await run(command, () => port.apply(command), retry);
    if (!response || response.kind !== 'applied' || !live()) return false;
    cost.recordApply(batch.length);
    applied += response.result.outcomes.length;
    const acknowledged = new Set<number>();
    for (const outcome of response.result.outcomes) {
      acknowledged.add(outcome.ordinal);
      const current = meta.get(outcome.ordinal);
      if (current) current.outcome = outcome;
      const row = page.find((item) => item.ordinal === outcome.ordinal);
      if (row) row.outcome = outcome;
      const existing = outcomes.findIndex((item) => item.ordinal === outcome.ordinal);
      if (existing >= 0) outcomes[existing] = outcome;
      else outcomes.push(outcome);
    }
    remaining = batch.filter((item) => !acknowledged.has(item.ordinal)).map((item) => item.ordinal);
    applying = 0;
    retain();
    return response.result.complete && remaining.length === 0;
  }

  function queueSourceAdmissions(): void {
    if (!confirmPrivacy || !confirmTimestamps) return;
    for (const row of meta.values()) {
      if (row.skip || row.outcome?.status !== 'applied' || row.sourceAdmission) continue;
      const preview = row.sourcePreview;
      const body = preview ? sourceAdmissionBody(preview) : null;
      const blocked = preview ? sourceAdmissionBlock(preview) : 'This provider record has no stable identity.';
      if (!body || !row.target) {
        row.sourceAdmission = {
          status: 'unsupported',
          reason: row.target
            ? (blocked ?? 'This provider record has no stable identity.')
            : 'This row has no canonical Subject.',
        };
        continue;
      }
      admitQueue.push({
        kind: 'admit-source',
        key: newCommandKey(),
        subjectId: row.target,
        ordinal: row.ordinal,
        body,
      });
    }
  }

  async function admitQueued(): Promise<boolean> {
    while (admitQueue.length) {
      if (!live() || stopApply) return false;
      const command = admitQueue[0]!;
      if (busy) return false;
      busy = true;
      const response = await port.admitSource(command);
      if (!live()) return false;
      busy = false;
      if (response.kind === 'unknown') {
        unknown = response.command;
        notice = response;
        retain();
        return false;
      }
      unknown = null;
      const row = meta.get(command.ordinal);
      if (response.kind === 'admitted' || response.kind === 'conflict') {
        if (row) row.sourceAdmission = { status: response.kind === 'admitted' ? 'admitted' : 'conflict' };
        notice = null;
        admitQueue.shift();
        retain();
        continue;
      }
      if (row) row.sourceAdmission = { status: 'failed' };
      notice = response;
      retain();
      return false;
    }
    return true;
  }

  async function confirm(): Promise<AniListJourneySnapshot> {
    if (!importId || cancelled || !live() || heldUnknown()) return snapshot();
    const rows = reviewedConfirmations();
    if (!rows.length) return snapshot();
    stage = 'applying';
    stopApply = false;
    applyQueue = chunkConfirmations(rows);
    const token = generation;
    while (applyQueue.length) {
      if (token !== generation || !live() || stopApply) break;
      const batch = applyQueue[0]!;
      const done = await applyBatch(batch);
      if (heldUnknown()) return snapshot();
      applyQueue.shift();
      if (!done && remaining.length) break;
    }
    if (!live() || heldUnknown()) return snapshot();
    queueSourceAdmissions();
    await admitQueued();
    if (!live() || heldUnknown()) return snapshot();
    stage = cancelled ? 'cancelled' : 'results';
    retain();
    if (importId && stage === 'results') {
      const id = importId;
      await loadPage(id, after, false, 'results');
      if (!live()) return snapshot();
      stage = cancelled ? 'cancelled' : 'results';
      retain();
    }
    return snapshot();
  }

  async function retryUnknown(): Promise<AniListJourneySnapshot> {
    const command = unknown;
    if (!command || !live()) return snapshot();
    if (command.kind === 'preview') return preview(command.upload, command.scoreFormat);
    if (command.kind === 'page') return loadPage(command.importId, command.after, true);
    if (command.kind === 'review') {
      const response = await run(command, () => port.review(command), true);
      if (response?.kind === 'reviewed' && importId) return loadPage(importId, after);
      return snapshot();
    }
    if (command.kind === 'apply') {
      const done = await applyBatch(command.body.confirmations, true);
      if (heldUnknown()) return snapshot();
      applyQueue.shift();
      const token = generation;
      while (applyQueue.length && token === generation && live() && !stopApply) {
        const batch = applyQueue[0]!;
        const nextDone = await applyBatch(batch);
        if (heldUnknown()) return snapshot();
        applyQueue.shift();
        if (!nextDone && remaining.length) break;
      }
      if (!heldUnknown()) {
        queueSourceAdmissions();
        await admitQueued();
      }
      if (!heldUnknown() && importId && !cancelled) {
        const id = importId;
        await loadPage(id, after, false, 'results');
      }
      if (done || outcomes.length) stage = 'results';
      retain();
      return snapshot();
    }
    if (command.kind === 'review-labels') {
      const response = await run(command, () => port.reviewLabels(command), true);
      if (response?.kind === 'labels-reviewed') acceptLabelReview(response.ordinal, response.review);
      return snapshot();
    }
    if (command.kind === 'apply-labels') return applyLabelCommand(command, true);
    if (command.kind === 'read-labels') return readLabels(command.ordinal);
    if (command.kind === 'admit-source') {
      await admitQueued();
      if (!heldUnknown()) stage = 'results';
      return snapshot();
    }
    await run(command, () => port.cancel(command), true);
    if (!notice) {
      cancelled = true;
      stage = command.remove ? 'removed' : outcomes.length ? 'results' : 'cancelled';
      if (command.remove) clearPrivate('removed');
    }
    return snapshot();
  }

  async function retryFailed(): Promise<AniListJourneySnapshot> {
    const command = applyCommand;
    if (!command || !live() || heldUnknown()) return snapshot();
    const failed = command.body.confirmations.filter((row) => meta.get(row.ordinal)?.outcome?.status === 'failed');
    if (!failed.length) return snapshot();
    await applyBatch(failed, true);
    if (!heldUnknown()) {
      queueSourceAdmissions();
      await admitQueued();
    }
    stage = 'results';
    if (importId && !heldUnknown()) await loadPage(importId, after, false, 'results');
    stage = cancelled ? 'cancelled' : 'results';
    return snapshot();
  }

  async function cancelAdmission(): Promise<AniListJourneySnapshot> {
    const id = importId;
    if (!id || !live() || heldUnknown()) return snapshot();
    stopApply = true;
    const command: Extract<AniListCommand, { kind: 'cancel' }> = {
      kind: 'cancel',
      importId: id,
      key: newCommandKey(),
      remove: false,
    };
    const response = await run(command, () => port.cancel(command));
    if (!response || response.kind !== 'cancelled' || !live()) return snapshot();
    cancelled = true;
    stage = outcomes.length ? 'results' : 'cancelled';
    retain();
    return snapshot();
  }

  async function discard(): Promise<AniListJourneySnapshot> {
    if (heldUnknown()) return snapshot();
    const id = importId;
    if (id) {
      const command: Extract<AniListCommand, { kind: 'cancel' }> = {
        kind: 'cancel',
        importId: id,
        key: newCommandKey(),
        remove: true,
      };
      await run(command, () => port.cancel(command));
    }
    if (live()) clearPrivate(id ? 'removed' : 'upload');
    retain();
    return snapshot();
  }

  function chooseLabels(
    ordinal: number,
    subjectId: string | null,
    selections: AniListLabelSelection[],
  ): AniListJourneySnapshot {
    if (!live() || busy || heldUnknown()) return snapshot();
    const row = meta.get(ordinal)!;
    const pending = page.find((item) => item.ordinal === ordinal)?.labelWork;
    if (Object.values(pending ?? {}).some((work) => (work.createStarted || work.assignStarted) && !work.outcome))
      return snapshot();
    row.labels = { subjectId, selections, review: null, invalidated: true, outcomes: null };
    const visible = page.find((item) => item.ordinal === ordinal);
    if (visible) delete visible.currentLabels;
    return snapshot();
  }

  function acceptLabelReview(ordinal: number, review: AniListLabelReview): void {
    const row = meta.get(ordinal)!;
    row.labels = {
      subjectId: review.subjectId,
      selections: review.items.map((item) => ({
        key: item.key,
        target: 'label' in item.target ? { labelId: item.target.label.id } : { name: item.target.name },
      })),
      review,
      invalidated: false,
      outcomes: null,
    };
    const visible = page.find((item) => item.ordinal === ordinal);
    if (visible) {
      visible.labelReview = review;
      delete visible.labelWork;
      delete visible.currentLabels;
    }
  }

  async function reviewLabels(ordinal: number): Promise<AniListJourneySnapshot> {
    if (!importId || !live() || busy || heldUnknown() || cancelled) return snapshot();
    const labels = meta.get(ordinal)!.labels!;
    const command: Extract<AniListCommand, { kind: 'review-labels' }> = {
      kind: 'review-labels',
      importId,
      key: newCommandKey(),
      body: { ordinal, subjectId: labels.subjectId!, selections: labels.selections },
      custody: { expectedReader: visit.subject, expectedCredential: visit.csrfToken },
    };
    const response = await run(command, () => port.reviewLabels(command));
    if (response?.kind === 'labels-reviewed') acceptLabelReview(response.ordinal, response.review);
    return snapshot();
  }

  async function readLabels(ordinal: number): Promise<AniListJourneySnapshot> {
    const review = meta.get(ordinal)?.labels?.review;
    if (!importId || !review || !live() || busy || heldUnknown()) return snapshot();
    const command: Extract<AniListCommand, { kind: 'read-labels' }> = {
      kind: 'read-labels',
      importId,
      ordinal,
      subjectId: review.subjectId,
    };
    const response = await run(command, () => port.readLabels(command));
    const visible = page.find((item) => item.ordinal === ordinal);
    if (response?.kind === 'labels-read' && visible) visible.currentLabels = response.labels;
    return snapshot();
  }

  async function applyLabelCommand(
    command: Extract<AniListCommand, { kind: 'apply-labels' }>,
    retry = false,
  ): Promise<AniListJourneySnapshot> {
    const response = await run(command, () => port.applyLabels(command), retry);
    if (response?.kind !== 'labels-applied') return snapshot();
    for (const outcome of response.result.outcomes) {
      const labels = meta.get(outcome.ordinal)!.labels!;
      labels.outcomes = outcome;
      const visible = page.find((row) => row.ordinal === outcome.ordinal);
      if (visible) {
        visible.labelWork = { ...visible.labelWork };
        labels.review!.items.forEach((item, index) => {
          const result = outcome.items.find((value) => value.key === item.key);
          if (result)
            visible.labelWork![index] = {
              ...visible.labelWork![index],
              ...(result.label ? { label: result.label } : {}),
              ...(result.status === 'applied' || result.status === 'unchanged'
                ? { assignStarted: true, outcome: result }
                : {}),
              ...(result.status === 'pending' ? { createStarted: true } : {}),
            };
        });
      }
    }
    // A current read is an observation, never acknowledgement of an unresolved command.
    for (const confirmation of command.body.confirmations) await readLabels(confirmation.ordinal);
    return snapshot();
  }

  async function confirmLabels(ordinal: number): Promise<AniListJourneySnapshot> {
    const labels = meta.get(ordinal)?.labels;
    if (!importId || !labels?.review || labels.invalidated || !live() || busy || heldUnknown()) return snapshot();
    return applyLabelCommand({
      kind: 'apply-labels',
      importId,
      body: { confirmations: [{ ordinal, reviewId: labels.review.id }] },
      custody: { expectedReader: visit.subject, expectedCredential: visit.csrfToken },
    });
  }

  async function labelTargets(query: string, cursor?: string) {
    cost.recordCall('label-targets');
    return port.labelTargets(query, cursor);
  }

  function openConfirm(): AniListJourneySnapshot {
    if (!reviewedConfirmations().length || cancelled || heldUnknown()) return snapshot();
    confirmPrivacy = false;
    confirmTimestamps = false;
    stage = 'confirm';
    return snapshot();
  }

  function confirmSource(choice: { privacy?: boolean; timestamps?: boolean }): AniListJourneySnapshot {
    if (stage !== 'confirm') return snapshot();
    if (choice.privacy !== undefined) confirmPrivacy = choice.privacy;
    if (choice.timestamps !== undefined) confirmTimestamps = choice.timestamps;
    return snapshot();
  }

  function backToReview(): AniListJourneySnapshot {
    if (stage === 'applying' || heldUnknown()) return snapshot();
    stage = cancelled ? 'cancelled' : 'review';
    return snapshot();
  }

  return {
    snapshot,
    chooseLabels,
    reviewLabels,
    confirmLabels,
    readLabels,
    labelTargets,
    preview,
    loadPage,
    review,
    readQuestion,
    confirmVoteEffect,
    choose,
    confirm,
    confirmSource,
    openConfirm,
    backToReview,
    retryUnknown,
    retryFailed,
    cancelAdmission,
    discard,
    nextPage: () => (importId && next !== null ? loadPage(importId, next) : Promise.resolve(snapshot())),
    refresh: async () => {
      if (heldUnknown()) return snapshot();
      for (const row of page) {
        const labels = meta.get(row.ordinal)?.labels;
        if (labels && !Object.values(row.labelWork ?? {}).some((work) => work.createStarted || work.assignStarted)) {
          labels.invalidated = true;
          labels.review = null;
        }
      }
      const readStage = stage === 'results' ? 'results' : 'review';
      await readQuestion();
      return importId ? loadPage(importId, after, false, readStage) : snapshot();
    },
    cost: () => snapshot().cost,
    live,
  };
}

export type AniListJourney = ReturnType<typeof createAniListJourney>;
