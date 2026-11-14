import { ImportPageCoordinates, type ImportPagePosition } from '../personal-list-import/page-navigation';
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

export type BangumiStage =
  | 'upload'
  | 'cleanup'
  | 'review'
  | 'confirm'
  | 'applying'
  | 'results'
  | 'cancelled'
  | 'removed';

/** Label commands run in the labels panel, outside the journey's retry and cost ledger. */
type JourneyCommand = Exclude<BangumiCommand, { kind: 'tags' | 'review-labels' | 'apply-labels' }>;

export type BangumiNotice = BangumiFailure | BangumiUnknown | { kind: 'too-large' } | { kind: 'empty' } | null;

export type BangumiJourneySnapshot = {
  stage: BangumiStage;
  busy: boolean;
  notice: BangumiNotice;
  cleanupPending: boolean;
  replacementPending: boolean;
  cleanupReceipts: BangumiOutcome[];
  uploadId: string | null;
  count: number;
  after: number;
  next: number | null;
  position: ImportPagePosition;
  pageReadFailed: boolean;
  pageRevision: number;
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
  const reviewReplaced = review?.token !== previous?.reviewToken;
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
    reviewToken: review?.token ?? null,
    choice: previous?.choice ?? defaultChoice(),
    scoreReview: review?.score ?? null,
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
  const retiredReviews = new Map<number, string>();
  let stage: BangumiStage = 'upload';
  let busy = false;
  let notice: BangumiNotice = null;
  let uploadId: string | null = null;
  let count = 0;
  let after = -1;
  let next: number | null = null;
  let pageRevision = 0;
  let cancelled = false;
  let page: BangumiRow[] = [];
  let outcomes: BangumiOutcome[] = [];
  let remaining: number[] = [];
  let applying = 0;
  let applied = 0;
  let uploadText: string | null = null;
  let unknown: BangumiCommand | null = null;
  let cleanupCommand: Extract<BangumiCommand, { kind: 'delete' }> | null = null;
  let replacement: Extract<BangumiCommand, { kind: 'preview' }> | null = null;
  let cleanupReceipts: BangumiOutcome[] = [];
  let cleanupDestination: 'upload' | 'removed' = 'removed';
  let sourceRetired = false;
  let retired = false;
  let applyCommand: Extract<BangumiCommand, { kind: 'apply' }> | null = null;
  let applyQueue: BangumiChoice[][] = [];
  let admitQueue: Extract<BangumiCommand, { kind: 'admit-source' }>[] = [];
  let stopApply = false;
  let confirmPrivacy = false;
  let confirmTimestamps = false;
  const coordinates = new ImportPageCoordinates(-1);
  let pageRequest: { command: Extract<BangumiCommand, { kind: 'page' }>; loadedStage: 'review' | 'results' } | null =
    null;
  let generation = 0;

  function live(): boolean {
    if (
      !retired &&
      (!visit.current() ||
        sender.subject !== visit.subject ||
        sender.csrfToken !== visit.csrfToken ||
        visit.controller.signal.aborted)
    ) {
      retired = true;
      clearPrivate();
      cleanupReceipts = [];
    }
    return !retired;
  }

  function retain(): void {
    cost.retain({
      upload: replacement?.upload ?? uploadText,
      page: page.length ? { uploadId: uploadId ?? '', cancelled, rows: page, next } : null,
      meta: meta.values(),
      command: cleanupCommand ?? unknown,
    });
    cost.recordRender(page.length);
  }

  function heldUnknown(): boolean {
    const current = notice;
    return current !== null && current.kind === 'unknown';
  }

  function snapshot(): BangumiJourneySnapshot {
    if (!live()) {
      coordinates.retire();
      pageRequest = null;
    }
    retain();
    return {
      stage,
      busy,
      notice,
      cleanupPending: cleanupCommand !== null,
      replacementPending: replacement !== null,
      cleanupReceipts,
      uploadId,
      count,
      after,
      next,
      pageRevision,
      position: coordinates.position(),
      pageReadFailed: pageRequest !== null && !busy && unknown === null,
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
    coordinates.retire();
    pageRequest = null;
    unknown = null;
    cleanupCommand = null;
    replacement = null;
    sourceRetired = false;
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
    pageRevision = 0;
    cancelled = false;
    page = [];
    outcomes = [];
    remaining = [];
    applying = 0;
    applied = 0;
    meta.clear();
    retiredReviews.clear();
    stage = resetStage;
    notice = null;
    busy = false;
  }

  async function run<T extends { kind: string }>(
    command: JourneyCommand,
    send: () => Promise<T | BangumiFailure | BangumiUnknown>,
    retry = false,
  ): Promise<T | undefined> {
    if (!live() || sourceRetired || busy || (unknown !== null && !retry)) return;
    const token = generation;
    busy = true;
    if (command.kind !== 'admit-source') cost.recordCall(command.kind, retry);
    let response: T | BangumiFailure | BangumiUnknown;
    try {
      response = await send();
    } finally {
      if (token === generation) busy = false;
    }
    if (!live() || token !== generation) return;
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

  function retireReview(ordinal: number): void {
    const current = meta.get(ordinal);
    const row = page.find((item) => item.ordinal === ordinal);
    const token = current?.reviewToken ?? row?.review?.token;
    if (token) retiredReviews.set(ordinal, token);
    if (row) row.review = null;
    if (current) {
      current.reviewToken = null;
      current.scoreReview = null;
      current.scoreConsent = false;
      current.entryReadback = null;
      current.voteReadback = null;
    }
  }

  async function loadPage(
    id: string,
    cursor: number,
    retry = false,
    loadedStage: 'review' | 'results' = 'review',
  ): Promise<BangumiJourneySnapshot> {
    if (!live() || sourceRetired || busy || (unknown !== null && !retry)) return snapshot();
    const token = generation;
    const command: Extract<BangumiCommand, { kind: 'page' }> = { kind: 'page', uploadId: id, after: cursor };
    pageRequest = { command, loadedStage };
    const response = await run(command, () => port.page(command), retry);
    if (!response || response.kind !== 'page' || !live() || token !== generation) return snapshot();
    const current = response.page;
    pageRevision += 1;
    uploadId = current.uploadId;
    page = current.rows;
    after = cursor;
    next = current.next;
    cancelled = current.cancelled;
    for (const row of current.rows) {
      if (row.review?.token === retiredReviews.get(row.ordinal)) row.review = null;
      meta.set(row.ordinal, metaFromRow(row, meta.get(row.ordinal)));
    }
    pageRequest = null;
    if (cancelled) coordinates.retire();
    else coordinates.observe(cursor);
    cost.recordPage(current);
    stage = cancelled ? 'cancelled' : loadedStage;
    retain();
    return snapshot();
  }

  function retryPage(): Promise<BangumiJourneySnapshot> {
    const request = pageRequest;
    return request && !unknown
      ? loadPage(request.command.uploadId, request.command.after, true, request.loadedStage)
      : Promise.resolve(snapshot());
  }

  function movePage(cursor: number | null): Promise<BangumiJourneySnapshot> {
    return uploadId && cursor !== null && stage === 'review' && !cancelled && !unknown && !busy
      ? loadPage(uploadId, cursor)
      : Promise.resolve(snapshot());
  }

  function retireForCleanup(): void {
    const id = uploadId;
    const receipts = outcomes;
    clearPrivate();
    outcomes = receipts;
    uploadId = id;
    cleanupReceipts = receipts.length ? receipts : cleanupReceipts;
    sourceRetired = true;
  }

  function editReplacement(): BangumiJourneySnapshot {
    if (!live()) return snapshot();
    // File or format editing withdraws auto-continuation, never the original cleanup request.
    replacement = null;
    retain();
    return snapshot();
  }

  function replaceSource(): BangumiJourneySnapshot {
    if (!live() || busy || unknown || cleanupCommand || stage === 'applying') return snapshot();
    retireForCleanup();
    return snapshot();
  }

  async function sendPreview(command: Extract<BangumiCommand, { kind: 'preview' }>, retry = false) {
    uploadText = command.upload;
    const response = await run(command, () => port.preview(command), retry);
    if (!response || response.kind !== 'previewed' || !live()) return snapshot();
    uploadId = response.uploadId;
    count = response.count;
    uploadText = null;
    return loadPage(response.uploadId, -1);
  }

  async function cleanup(retry = false): Promise<BangumiJourneySnapshot> {
    const command = cleanupCommand;
    if (!command || !live() || busy) return snapshot();
    const token = generation;
    busy = true;
    cost.recordCall('delete', retry);
    let response;
    try {
      response = await port.delete(command);
    } finally {
      if (token === generation) busy = false;
    }
    if (!live() || token !== generation) return snapshot();
    if (response.kind !== 'deleted') {
      notice = response.kind === 'unknown' || response.kind === 'cancelled' ? { kind: 'unknown', command } : response;
      retain();
      return snapshot();
    }
    const nextPreview = replacement;
    clearPrivate(cleanupDestination);
    if (nextPreview) return sendPreview(nextPreview);
    outcomes = cleanupReceipts;
    return snapshot();
  }

  async function preview(upload: string): Promise<BangumiJourneySnapshot> {
    if (!live() || (busy && !cleanupCommand) || (unknown && !cleanupCommand) || stage === 'applying') return snapshot();
    if (!upload || encodedBytes(upload) > BANGUMI_UPLOAD_BYTES) {
      replacement = null;
      // Keep an uncertain cleanup notice visible when a replacement file fails admission.
      if (!cleanupCommand) notice = { kind: upload ? 'too-large' : 'empty' };
      return snapshot();
    }
    const command: Extract<BangumiCommand, { kind: 'preview' }> = {
      kind: 'preview',
      key: newCommandKey(),
      upload,
    };
    if (cleanupCommand) {
      replacement = command;
      cleanupDestination = 'upload';
      return snapshot();
    }
    const id = uploadId;
    if (id) {
      retireForCleanup();
      replacement = command;
      cleanupDestination = 'upload';
      cleanupCommand = Object.freeze({ kind: 'delete', uploadId: id, key: newCommandKey() });
      stage = 'cleanup';
      return cleanup();
    }
    sourceRetired = false;
    return sendPreview(command);
  }

  async function review(
    ordinal: number,
    target?: string | null,
    score?: BangumiScoreSelection,
  ): Promise<BangumiJourneySnapshot> {
    const id = uploadId;
    if (!id || !live() || sourceRetired || unknown || busy) return snapshot();
    if (stage === 'applying') return snapshot();
    const command: Extract<BangumiCommand, { kind: 'review' }> = {
      kind: 'review',
      key: newCommandKey(),
      uploadId: id,
      ordinal,
      ...(target ? { target } : {}),
      score: score ?? meta.get(ordinal)?.scoreReview?.native.selection ?? { action: 'preserve' },
    };
    retireReview(ordinal);
    retain();
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
      retireReview(ordinal);
      current.target = target;
      current.match = null;
      current.proposedState = null;
      current.current = null;
      current.conflict = false;
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
    if (cleanupCommand) return cleanup(true);
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
    if (command.kind === 'page')
      return loadPage(command.uploadId, command.after, true, pageRequest?.loadedStage ?? 'review');
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
        coordinates.retire();
        pageRequest = null;
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
    if (!id || !live() || sourceRetired || unknown) return snapshot();
    stopApply = true;
    const command: Extract<BangumiCommand, { kind: 'cancel' }> = { kind: 'cancel', uploadId: id, key: newCommandKey() };
    const response = await run(command, () => port.cancel(command));
    if (!response || response.kind !== 'cancelled' || !live()) return snapshot();
    coordinates.retire();
    pageRequest = null;
    cancelled = true;
    stage = outcomes.length ? 'results' : 'cancelled';
    retain();
    return snapshot();
  }

  async function discard(): Promise<BangumiJourneySnapshot> {
    if (!live()) return snapshot();
    if (cleanupCommand) {
      cleanupDestination = 'removed';
      return editReplacement();
    }
    if (busy || unknown || stage === 'applying') return snapshot();
    const id = uploadId;
    retireForCleanup();
    if (!id) {
      clearPrivate('removed');
      return snapshot();
    }
    cleanupCommand = Object.freeze({ kind: 'delete', uploadId: id, key: newCommandKey() });
    cleanupDestination = 'removed';
    stage = 'cleanup';
    return cleanup();
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
    if (sourceRetired) return snapshot();
    const token = generation;
    const row = meta.get(ordinal);
    const outcome = outcomes.find((item) => item.ordinal === ordinal);
    const acknowledged = outcome?.status === 'applied' || outcome?.score?.status === 'applied';
    if (stage !== 'results' || busy || unknown || !live() || !row?.target || !acknowledged) return snapshot();
    const question = row.scoreReview?.native.question;
    const questionId = question ? question.id : null;
    const command = { subjectId: row.target, questionId };
    busy = true;
    cost.recordCall('entry-read');
    if (questionId) cost.recordCall('vote-read');
    let result: Awaited<ReturnType<BangumiImportPort['inspect']>>;
    try {
      result = await port.inspect(command);
    } finally {
      busy = false;
    }
    if (!live() || token !== generation) return snapshot();
    row.entryReadback = result.entry;
    row.voteReadback = result.vote ?? {
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
    if (sourceRetired || stage === 'applying' || unknown) return snapshot();
    stage = cancelled ? 'cancelled' : 'review';
    return snapshot();
  }

  return {
    snapshot,
    replaceSource,
    editReplacement,
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
    nextPage: () => movePage(next),
    previousPage: () => movePage(coordinates.position().previous),
    firstPage: () => movePage(coordinates.position().canFirst ? coordinates.first : null),
    retryPage,
    refresh: () => (uploadId ? loadPage(uploadId, after) : Promise.resolve(snapshot())),
    inspectCurrent,
    cost: () => snapshot().cost,
    live,
  };
}

export type BangumiJourney = ReturnType<typeof createBangumiJourney>;
