import {
  ANILIST_UPLOAD_BYTES,
  boundedHeader,
  chunkConfirmations,
  encodedBytes,
  newCommandKey,
  type AniListCommand,
  type AniListCompleteness,
  type AniListConfirmation,
  type AniListFailure,
  type AniListHeader,
  type AniListImportPort,
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

function metaFromRow(row: AniListRow, previous?: AniListRowMeta): AniListRowMeta {
  const review = row.review;
  const observation = review?.observation ?? row.proposal;
  const match = review?.match.state ?? row.match.state;
  const status = aniListStatusOf(row.source.evidence);
  return {
    ordinal: row.ordinal,
    title: aniListTitle(row.source.evidence, untitled),
    mediaType: aniListMediaType(row.source.evidence),
    status,
    match,
    target: review?.input.subjectId ?? observation?.subjectId ?? previous?.target ?? null,
    proposedState: observation?.proposedState ?? previous?.proposedState ?? null,
    current: observation?.current ?? previous?.current ?? null,
    reviewId: review?.id ?? previous?.reviewId ?? null,
    skip: previous?.skip ?? review?.input.skip ?? false,
    replace: previous?.replace ?? review?.input.replace ?? false,
    applyStatus: previous?.applyStatus ?? review?.input.fields.includes('status') ?? true,
    started: row.started || previous?.started === true,
    outcome: row.outcome ?? previous?.outcome ?? null,
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
      response.kind === 'cancelled'
    ) {
      notice = null;
      return response as T;
    }
    notice = response as AniListFailure;
    retain();
    return;
  }

  async function loadPage(id: string, cursor: number, retry = false): Promise<AniListJourneySnapshot> {
    const command: Extract<AniListCommand, { kind: 'page' }> = { kind: 'page', importId: id, after: cursor };
    const response = await run(command, () => port.page(command), retry);
    if (!response || response.kind !== 'page' || !live()) return snapshot();
    const current = response.page;
    page = current.rows;
    after = cursor;
    next = current.next;
    cancelled = current.header.cancelled;
    scoreFormat = current.header.scoreFormat;
    completeness = current.completeness;
    count = current.header.count || count;
    for (const row of current.rows) meta.set(row.ordinal, metaFromRow(row, meta.get(row.ordinal)));
    cost.recordPage(current);
    stage = cancelled ? 'cancelled' : 'review';
    retain();
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
    if (!id || !live()) return snapshot();
    if (stage === 'applying') return snapshot();
    if (current?.started) {
      notice = { kind: 'started-locked' };
      return snapshot();
    }
    const skip = current?.skip ?? false;
    const replace = current?.replace ?? false;
    const applyStatus = current?.applyStatus ?? true;
    const command: Extract<AniListCommand, { kind: 'review' }> = {
      kind: 'review',
      key: newCommandKey(),
      importId: id,
      ordinal,
      fields: skip || !applyStatus ? [] : ['status'],
      replace,
      ...(skip ? { skip: true } : {}),
      ...(target ? { subjectId: target } : {}),
    };
    const response = await run(command, () => port.review(command));
    if (!response || response.kind !== 'reviewed' || !live()) return snapshot();
    cost.recordReview();
    const row = page.find((item) => item.ordinal === ordinal);
    if (row) row.review = response.review;
    meta.set(ordinal, {
      ...(current ??
        metaFromRow(
          row ?? {
            ordinal,
            source: { evidence: {}, group: null, identifiers: [], fields: [] },
            match: { state: 'unmatched', candidates: [], fingerprint: '' },
            proposal: null,
            review: response.review,
            started: false,
            outcome: null,
          },
        )),
      match: response.review.match.state,
      target: response.review.input.subjectId ?? response.review.observation?.subjectId ?? target ?? null,
      proposedState: response.review.observation?.proposedState ?? null,
      current: response.review.observation?.current ?? null,
      reviewId: response.review.id,
      skip: response.review.input.skip === true,
      replace: response.review.input.replace === true,
      applyStatus: response.review.input.fields.includes('status'),
      outcome: null,
    });
    retain();
    return snapshot();
  }

  function choose(
    ordinal: number,
    choice: { skip?: boolean; replace?: boolean; applyStatus?: boolean },
  ): AniListJourneySnapshot {
    const current = meta.get(ordinal);
    if (!current || stage === 'applying' || current.started) return snapshot();
    current.skip = choice.skip ?? current.skip;
    current.replace = current.skip ? false : (choice.replace ?? current.replace);
    current.applyStatus = current.skip ? false : (choice.applyStatus ?? current.applyStatus);
    retain();
    return snapshot();
  }

  function reviewedConfirmations(): AniListConfirmation[] {
    return [...meta.values()]
      .filter((row) => row.reviewId)
      .map((row) => ({ ordinal: row.ordinal, reviewId: row.reviewId! }));
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
          reason: row.target ? (blocked ?? 'This provider record has no stable identity.') : 'This row has no canonical Subject.',
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
    if (!importId || cancelled || !live()) return snapshot();
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
    if (!live()) return snapshot();
    stage = cancelled ? 'cancelled' : 'results';
    retain();
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
      if (done || outcomes.length) stage = 'results';
      return snapshot();
    }
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
    if (!command || !live()) return snapshot();
    const failed = command.body.confirmations.filter((row) => meta.get(row.ordinal)?.outcome?.status === 'failed');
    if (!failed.length) return snapshot();
    await applyBatch(failed, true);
    if (!heldUnknown()) {
      queueSourceAdmissions();
      await admitQueued();
    }
    stage = 'results';
    return snapshot();
  }

  async function cancelAdmission(): Promise<AniListJourneySnapshot> {
    const id = importId;
    if (!id || !live()) return snapshot();
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

  function openConfirm(): AniListJourneySnapshot {
    if (!reviewedConfirmations().length || cancelled) return snapshot();
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
    if (stage === 'applying') return snapshot();
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
    openConfirm,
    backToReview,
    retryUnknown,
    retryFailed,
    cancelAdmission,
    discard,
    nextPage: () => (importId && next !== null ? loadPage(importId, next) : Promise.resolve(snapshot())),
    refresh: () => (importId ? loadPage(importId, after) : Promise.resolve(snapshot())),
    cost: () => snapshot().cost,
    live,
  };
}

export type AniListJourney = ReturnType<typeof createAniListJourney>;
