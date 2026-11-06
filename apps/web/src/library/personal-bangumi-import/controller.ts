import {
  BANGUMI_UPLOAD_BYTES,
  chunkChoices,
  encodedBytes,
  newCommandKey,
  type BangumiApplyState,
  type BangumiChoice,
  type BangumiCommand,
  type BangumiFailure,
  type BangumiImportPort,
  type BangumiOutcome,
  type BangumiPage,
  type BangumiRow,
  type BangumiRowMeta,
  type BangumiScoreSelection,
  type BangumiUnknown,
} from './contract';
import { sourceAdmissionBlock, sourceAdmissionBody } from '../rich-private-entry/admission';
import { BangumiCostLedger, type BangumiCostSnapshot } from './cost';
import { bangumiTitle } from './meaning';
import { bangumiSourcePreview } from './source';
import type { BangumiVisit } from './visit';

export type BangumiStage = 'upload' | 'review' | 'confirm' | 'applying' | 'results' | 'cancelled' | 'removed';

/** Label commands run in the labels panel, outside the journey's retry and cost ledger. */
type JourneyCommand = Exclude<BangumiCommand, { kind: 'tags' | 'review-labels' | 'apply-labels' }>;

export type BangumiNotice = BangumiFailure | BangumiUnknown | { kind: 'too-large' } | { kind: 'empty' } | null;

export type BangumiJourneySnapshot = {
  stage: BangumiStage;
  busy: boolean;
  notice: BangumiNotice;
  uploadId: string | null;
  count: number;
  after: number;
  next: number | null;
  cancelled: boolean;
  page: BangumiRow[];
  meta: BangumiRowMeta[];
  outcomes: BangumiOutcome[];
  remaining: number[];
  applying: number;
  applied: number;
  confirmPrivacy: boolean;
  confirmTimestamps: boolean;
  cost: BangumiCostSnapshot;
};

const untitled = 'Bangumi';

function defaultChoice(): { state: BangumiApplyState; skip: boolean } {
  return { state: 'preserve', skip: false };
}

function metaFromRow(row: BangumiRow, previous?: BangumiRowMeta): BangumiRowMeta {
  const review = row.review;
  const reviewReplaced = !!review && review.token !== previous?.reviewToken;
  return {
    ordinal: row.ordinal,
    title: bangumiTitle(row.evidence.source, untitled),
    medium: row.evidence.medium,
    stateRole: row.evidence.stateRole,
    match: review?.match ?? previous?.match ?? null,
    target: review?.target ?? previous?.target ?? null,
    proposedState: review?.proposedState ?? previous?.proposedState ?? null,
    current: review?.current ?? previous?.current ?? null,
    conflict: review?.conflict ?? previous?.conflict ?? false,
    reviewToken: review?.token ?? previous?.reviewToken ?? null,
    choice: previous?.choice ?? defaultChoice(),
    scoreReview: review?.score ?? previous?.scoreReview ?? null,
    scoreConsent: reviewReplaced ? false : (previous?.scoreConsent ?? false),
    outcome: row.outcome ?? previous?.outcome ?? null,
    entryReadback: reviewReplaced ? null : (previous?.entryReadback ?? null),
    voteReadback: reviewReplaced ? null : (previous?.voteReadback ?? null),
    sourcePreview: previous?.sourcePreview ?? bangumiSourcePreview(row),
    sourceAdmission: previous?.sourceAdmission ?? null,
  };
}

export function createBangumiJourney(input: { port: BangumiImportPort; visit: BangumiVisit }) {
  const { port, visit } = input;
  const sender = { subject: visit.subject, csrfToken: visit.csrfToken };
  const cost = new BangumiCostLedger();
  const meta = new Map<number, BangumiRowMeta>();
  let stage: BangumiStage = 'upload';
  let busy = false;
  let notice: BangumiNotice = null;
  let uploadId: string | null = null;
  let count = 0;
  let after = -1;
  let next: number | null = null;
  let cancelled = false;
  let page: BangumiRow[] = [];
  let outcomes: BangumiOutcome[] = [];
  let remaining: number[] = [];
  let applying = 0;
  let applied = 0;
  let uploadText: string | null = null;
  let unknown: BangumiCommand | null = null;
  let applyCommand: Extract<BangumiCommand, { kind: 'apply' }> | null = null;
  let applyQueue: BangumiChoice[][] = [];
  let admitQueue: Extract<BangumiCommand, { kind: 'admit-source' }>[] = [];
  let stopApply = false;
  let confirmPrivacy = false;
  let confirmTimestamps = false;
  let generation = 0;

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
      page: page.length ? { uploadId: uploadId ?? '', cancelled, rows: page, next } : null,
      meta: meta.values(),
      command: unknown,
    });
    cost.recordRender(page.length);
  }

  function heldUnknown(): boolean {
    const current = notice;
    return current !== null && current.kind === 'unknown';
  }

  function snapshot(): BangumiJourneySnapshot {
    retain();
    return {
      stage,
      busy,
      notice,
      uploadId,
      count,
      after,
      next,
      cancelled,
      page,
      meta: [...meta.values()].sort((left, right) => left.ordinal - right.ordinal),
      outcomes,
      remaining,
      applying,
      applied,
      confirmPrivacy,
      confirmTimestamps,
      cost: { ...cost.snapshot, calls: { ...cost.snapshot.calls } },
    };
  }

  function clearPrivate(resetStage: BangumiStage = 'upload'): void {
    generation += 1;
    unknown = null;
    applyCommand = null;
    applyQueue = [];
    admitQueue = [];
    stopApply = false;
    confirmPrivacy = false;
    confirmTimestamps = false;
    uploadText = null;
    uploadId = null;
    count = 0;
    after = -1;
    next = null;
    cancelled = false;
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
    command: JourneyCommand,
    send: () => Promise<T | BangumiFailure | BangumiUnknown>,
    retry = false,
  ): Promise<T | undefined> {
    if (!live() || busy || (unknown !== null && !retry)) return;
    busy = true;
    let response: T | BangumiFailure | BangumiUnknown;
    try {
      response = await send();
    } finally {
      busy = false;
    }
    if (!live()) return;
    if (command.kind !== 'admit-source') cost.recordCall(command.kind, retry);
    if (response.kind === 'unknown') {
      unknown = (response as BangumiUnknown).command;
      notice = response as BangumiUnknown;
      if (command.kind !== 'preview') uploadText = null;
      retain();
      return;
    }
    unknown = null;
    if (command.kind === 'preview') uploadText = response.kind === 'previewed' ? null : null;
    if (
      response.kind === 'previewed' ||
      response.kind === 'page' ||
      response.kind === 'reviewed' ||
      response.kind === 'applied' ||
      response.kind === 'cancelled' ||
      response.kind === 'deleted'
    ) {
      notice = null;
      return response as T;
    }
    notice = response as BangumiFailure;
    retain();
    return;
  }

  async function loadPage(id: string, cursor: number, retry = false): Promise<BangumiJourneySnapshot> {
    const command: Extract<BangumiCommand, { kind: 'page' }> = { kind: 'page', uploadId: id, after: cursor };
    const response = await run(command, () => port.page(command), retry);
    if (!response || response.kind !== 'page' || !live()) {
      if (live() && uploadId === id && notice?.kind === 'not-found') clearPrivate('removed');
      return snapshot();
    }
    const current = response.page;
    page = current.rows;
    after = cursor;
    next = current.next;
    cancelled = current.cancelled;
    for (const row of current.rows) meta.set(row.ordinal, metaFromRow(row, meta.get(row.ordinal)));
    cost.recordPage(current);
    stage = cancelled ? 'cancelled' : 'review';
    retain();
    return snapshot();
  }

  async function preview(upload: string): Promise<BangumiJourneySnapshot> {
    if (!live() || busy || unknown || stage === 'applying') return snapshot();
    if (!upload) {
      notice = { kind: 'too-large' };
      return snapshot();
    }
    if (encodedBytes(upload) > BANGUMI_UPLOAD_BYTES) {
      notice = { kind: 'too-large' };
      return snapshot();
    }
    const previous = uploadId;
    if (previous) {
      const remove: Extract<BangumiCommand, { kind: 'delete' }> = {
        kind: 'delete',
        uploadId: previous,
        key: newCommandKey(),
      };
      await port.delete(remove);
      cost.recordCall('delete');
      if (!live()) return snapshot();
      clearPrivate();
    }
    uploadText = upload;
    const command: Extract<BangumiCommand, { kind: 'preview' }> = { kind: 'preview', key: newCommandKey(), upload };
    const response = await run(command, () => port.preview(command));
    if (!response || response.kind !== 'previewed' || !live()) return snapshot();
    uploadId = response.uploadId;
    count = response.count;
    uploadText = null;
    return loadPage(response.uploadId, -1);
  }

  async function review(
    ordinal: number,
    target?: string | null,
    score?: BangumiScoreSelection,
  ): Promise<BangumiJourneySnapshot> {
    const id = uploadId;
    if (!id || !live() || unknown || busy) return snapshot();
    if (stage === 'applying') return snapshot();
    const command: Extract<BangumiCommand, { kind: 'review' }> = {
      kind: 'review',
      key: newCommandKey(),
      uploadId: id,
      ordinal,
      ...(target ? { target } : {}),
      score: score ?? meta.get(ordinal)?.scoreReview?.native.selection ?? { action: 'preserve' },
    };
    const response = await run(command, () => port.review(command));
    if (!response || response.kind !== 'reviewed' || !live()) return snapshot();
    cost.recordReview();
    const current = meta.get(ordinal);
    const row = page.find((item) => item.ordinal === ordinal);
    if (row) row.review = response.review;
    meta.set(ordinal, {
      ...(current ??
        metaFromRow(
          row ?? {
            ordinal,
            evidence: { source: {}, fields: [], medium: 'unknown', stateRole: null },
            review: response.review,
            outcome: null,
          },
        )),
      match: response.review.match,
      target: response.review.target,
      proposedState: response.review.proposedState,
      current: response.review.current,
      conflict: response.review.conflict,
      reviewToken: response.review.token,
      scoreReview: response.review.score ?? null,
      scoreConsent: false,
      outcome: null,
      entryReadback: null,
      voteReadback: null,
    });
    retain();
    return snapshot();
  }

  function choose(
    ordinal: number,
    choice: { state?: BangumiApplyState; skip?: boolean; target?: string | null },
  ): BangumiJourneySnapshot {
    const current = meta.get(ordinal);
    if (!current || stage === 'applying' || unknown) return snapshot();
    const state = choice.state ?? current.choice.state;
    const skip = choice.skip ?? current.choice.skip;
    const target = 'target' in choice ? (choice.target ?? null) : current.target;
    if (target !== current.target) {
      current.target = target;
      current.match = null;
      current.proposedState = null;
      current.current = null;
      current.conflict = false;
      current.reviewToken = null;
      current.scoreReview = null;
      current.scoreConsent = false;
      current.entryReadback = null;
      current.voteReadback = null;
      const row = page.find((item) => item.ordinal === ordinal);
      if (row) row.review = null;
    }
    if (state !== current.choice.state || skip !== current.choice.skip) current.scoreConsent = false;
    current.choice = {
      state,
      skip,
    };
    if (current.choice.skip) current.choice.state = 'preserve';
    retain();
    return snapshot();
  }

  function reviewedChoices(): BangumiChoice[] | null {
    const choices: BangumiChoice[] = [];
    for (const row of meta.values()) {
      if (!row.reviewToken) continue;
      const selection = row.scoreReview?.native.selection ?? { action: 'preserve' as const };
      let score: BangumiChoice['score'];
      if (selection.action === 'preserve') score = selection;
      else if (!row.scoreConsent || !row.target || !row.scoreReview?.native.question) return null;
      else if (selection.action === 'set') score = { ...selection, consent: true };
      else score = { action: 'clear', consent: true };
      choices.push({
        ordinal: row.ordinal,
        reviewToken: row.reviewToken,
        state: row.choice.skip ? 'omit' : row.choice.state,
        skip: row.choice.skip,
        score,
      });
    }
    return choices;
  }

  async function applyBatch(batch: BangumiChoice[], retry = false): Promise<boolean> {
    const id = uploadId;
    if (!id || !live() || stopApply) return false;
    const command: Extract<BangumiCommand, { kind: 'apply' }> = { kind: 'apply', uploadId: id, body: { rows: batch } };
    applyCommand = command;
    applying = batch.length;
    const response = await run(command, () => port.apply(command), retry);
    if (!response || response.kind !== 'applied' || !live()) return false;
    cost.recordApply(batch.length);
    applied += response.result.outcomes.length;
    for (const outcome of response.result.outcomes) {
      const current = meta.get(outcome.ordinal);
      if (current) current.outcome = outcome;
      const row = page.find((item) => item.ordinal === outcome.ordinal);
      if (row) row.outcome = outcome;
      const existing = outcomes.findIndex((item) => item.ordinal === outcome.ordinal);
      if (existing >= 0) outcomes[existing] = outcome;
      else outcomes.push(outcome);
    }
    remaining = response.result.remaining;
    applying = 0;
    retain();
    return remaining.length === 0;
  }

  function queueSourceAdmissions(): void {
    if (!confirmPrivacy || !confirmTimestamps) return;
    for (const row of meta.values()) {
      if (row.choice.skip || row.outcome?.status !== 'applied' || row.sourceAdmission) continue;
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
      let response: Awaited<ReturnType<BangumiImportPort['admitSource']>>;
      try {
        response = await port.admitSource(command);
      } finally {
        busy = false;
      }
      if (!live()) return false;
      if (response.kind === 'unknown') {
        const retryCommand = response.command as Extract<BangumiCommand, { kind: 'admit-source' }>;
        admitQueue[0] = retryCommand;
        unknown = retryCommand;
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

  async function confirm(): Promise<BangumiJourneySnapshot> {
    if (!uploadId || cancelled || !live() || unknown || stage !== 'confirm') return snapshot();
    const rows = reviewedChoices();
    if (!rows?.length) return snapshot();
    stage = 'applying';
    stopApply = false;
    applyQueue = chunkChoices(rows);
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
    if (!live()) return snapshot();
    stage = cancelled ? 'cancelled' : 'results';
    retain();
    return snapshot();
  }

  async function retryUnknown(): Promise<BangumiJourneySnapshot> {
    const command = unknown;
    if (!command || !live()) return snapshot();
    if (command.kind === 'preview') {
      const response = await run(command, () => port.preview(command), true);
      if (response?.kind !== 'previewed' || !live()) return snapshot();
      uploadId = response.uploadId;
      count = response.count;
      uploadText = null;
      return loadPage(response.uploadId, -1);
    }
    if (command.kind === 'page') return loadPage(command.uploadId, command.after, true);
    if (command.kind === 'review') {
      const response = await run(command, () => port.review(command), true);
      if (response?.kind === 'reviewed' && uploadId) return loadPage(uploadId, after);
      return snapshot();
    }
    if (command.kind === 'apply') {
      const done = await applyBatch(command.body.rows, true);
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
      if (done || outcomes.length) stage = 'results';
      return snapshot();
    }
    if (command.kind === 'admit-source') {
      await admitQueued();
      if (!heldUnknown()) stage = 'results';
      return snapshot();
    }
    if (command.kind === 'cancel') {
      await run(command, () => port.cancel(command), true);
      if (!notice) {
        cancelled = true;
        stage = 'cancelled';
      }
      return snapshot();
    }
    if (command.kind !== 'delete') return snapshot();
    await run(command, () => port.delete(command), true);
    if (!notice) clearPrivate('removed');
    return snapshot();
  }

  async function retryFailed(): Promise<BangumiJourneySnapshot> {
    const command = applyCommand;
    if (!command || !live() || unknown) return snapshot();
    const failed = command.body.rows.filter((row) => meta.get(row.ordinal)?.outcome?.status === 'failed');
    if (!failed.length) return snapshot();
    await applyBatch(failed, true);
    if (!heldUnknown()) {
      queueSourceAdmissions();
      await admitQueued();
    }
    stage = 'results';
    return snapshot();
  }

  async function cancelAdmission(): Promise<BangumiJourneySnapshot> {
    const id = uploadId;
    if (!id || !live() || unknown) return snapshot();
    stopApply = true;
    const command: Extract<BangumiCommand, { kind: 'cancel' }> = { kind: 'cancel', uploadId: id, key: newCommandKey() };
    const response = await run(command, () => port.cancel(command));
    if (!response || response.kind !== 'cancelled' || !live()) return snapshot();
    cancelled = true;
    stage = outcomes.length ? 'results' : 'cancelled';
    retain();
    return snapshot();
  }

  async function discard(): Promise<BangumiJourneySnapshot> {
    const id = uploadId;
    if (!live() || busy || unknown) return snapshot();
    if (id) {
      const command: Extract<BangumiCommand, { kind: 'delete' }> = {
        kind: 'delete',
        uploadId: id,
        key: newCommandKey(),
      };
      await run(command, () => port.delete(command));
    }
    if (live()) clearPrivate(id ? 'removed' : 'upload');
    retain();
    return snapshot();
  }

  function openConfirm(): BangumiJourneySnapshot {
    if (![...meta.values()].some((row) => row.reviewToken) || cancelled || unknown || busy) return snapshot();
    confirmPrivacy = false;
    confirmTimestamps = false;
    stage = 'confirm';
    return snapshot();
  }

  function confirmSource(choice: { privacy?: boolean; timestamps?: boolean }): BangumiJourneySnapshot {
    if (stage !== 'confirm') return snapshot();
    if (choice.privacy !== undefined) confirmPrivacy = choice.privacy;
    if (choice.timestamps !== undefined) confirmTimestamps = choice.timestamps;
    return snapshot();
  }

  function confirmScore(ordinal: number, consent: boolean): BangumiJourneySnapshot {
    if (stage !== 'confirm' || unknown || busy) return snapshot();
    const row = meta.get(ordinal);
    const selection = row?.scoreReview?.native.selection;
    if (!row || !selection || selection.action === 'preserve') return snapshot();
    row.scoreConsent = consent;
    retain();
    return snapshot();
  }

  async function inspectCurrent(ordinal: number): Promise<BangumiJourneySnapshot> {
    const row = meta.get(ordinal);
    const outcome = outcomes.find((item) => item.ordinal === ordinal);
    const acknowledged = outcome?.status === 'applied' || outcome?.score?.status === 'applied';
    if (stage !== 'results' || busy || unknown || !live() || !row?.target || !acknowledged) return snapshot();
    const question = row.scoreReview?.native.question;
    const questionId = question ? question.id : null;
    const suppliedVote =
      outcome?.score?.status === 'applied' && outcome.score.action === 'set' ? outcome.score.vote : undefined;
    const command = { subjectId: row.target, questionId: suppliedVote ? null : questionId };
    busy = true;
    cost.recordCall('entry-read');
    if (questionId && !suppliedVote) cost.recordCall('vote-read');
    let result: Awaited<ReturnType<BangumiImportPort['inspect']>>;
    try {
      result = await port.inspect(command);
    } finally {
      busy = false;
    }
    if (!live()) return snapshot();
    row.entryReadback = result.entry;
    row.voteReadback = (suppliedVote
      ? { status: 'current', vote: { state: 'set', ...suppliedVote } as const }
      : result.vote) ?? {
      status: 'unavailable',
      reason:
        row.scoreReview?.native.admission.status === 'unavailable'
          ? row.scoreReview.native.admission.reason
          : 'question_unavailable',
    };
    retain();
    return snapshot();
  }

  function backToReview(): BangumiJourneySnapshot {
    if (stage === 'applying' || unknown) return snapshot();
    stage = cancelled ? 'cancelled' : 'review';
    return snapshot();
  }

  return {
    snapshot,
    preview,
    loadPage,
    review,
    choose,
    confirm,
    confirmSource,
    confirmScore,
    openConfirm,
    backToReview,
    retryUnknown,
    retryFailed,
    cancelAdmission,
    discard,
    nextPage: () => (uploadId && next !== null ? loadPage(uploadId, next) : Promise.resolve(snapshot())),
    refresh: () => (uploadId ? loadPage(uploadId, after) : Promise.resolve(snapshot())),
    inspectCurrent,
    cost: () => snapshot().cost,
    live,
  };
}

export type BangumiJourney = ReturnType<typeof createBangumiJourney>;
