import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import {
  RECOVERY_PAGE_ROWS,
  newRecoveryCommandKey,
  type RecoveryCollection,
  type RecoveryCollectionsPage,
  type RecoveryEffectCommand,
  type RecoveryFailure,
  type RecoveryOccurrence,
  type RecoveryOccurrencesPage,
  type RecoveryOutcome,
  type RecoveryOutcomesPage,
  type RecoveryPageQuery,
  type RecoveryPort,
  type RecoveryReview,
  type RecoveryStatus,
  type RecoveryUnknown,
} from './contract';
import { RecoveryCostLedger, type RecoveryCost } from './cost';
import type { ReceivingCollectionReadback } from './readback';
import { makeReviewBody, type OccurrenceSelection } from './selection';
import type { RecoveryVisit } from './visit';
import {
  commitRecoveryRead,
  emptyRecoveryReadWindow,
  recoveryReadTarget,
  sameRecoveryReadAdmission,
  type RecoveryReadAdmission,
  type RecoveryReadTarget,
  type RecoveryReadWindow,
  type RecoveryReader,
} from './window';

export type RecoveryStage =
  | 'upload'
  | 'collections'
  | 'occurrences'
  | 'review'
  | 'results'
  | 'conflict'
  | 'expired'
  | 'denied'
  | 'unavailable';

export type RecoveryNotice = RecoveryFailure | RecoveryUnknown | null;

export type RecoveryWindowSnapshot = { canPrevious: boolean; revision: number };

export type RecoverySnapshot = {
  stage: RecoveryStage;
  busy: boolean;
  notice: RecoveryNotice;
  uploadId: string | null;
  expiresAt: string | null;
  status: RecoveryStatus | null;
  collectionsPage: RecoveryCollectionsPage | null;
  selectedCollection: RecoveryCollection | null;
  occurrencesPage: RecoveryOccurrencesPage | null;
  selected: OccurrenceSelection;
  targets: ReadonlyMap<string, EntityPickerSubject>;
  review: RecoveryReview | null;
  outcomesPage: RecoveryOutcomesPage | null;
  collectionsWindow: RecoveryWindowSnapshot;
  occurrencesWindow: RecoveryWindowSnapshot;
  outcomesWindow: RecoveryWindowSnapshot;
  readRetry: RecoveryReader | null;
  receiving: ReceivingCollectionReadback | null;
  hasOriginalArchive: boolean;
  cost: RecoveryCost;
};

export type ArchiveCollectionRecoveryJourney = {
  snapshot: () => RecoverySnapshot;
  subscribe: (listener: () => void) => () => void;
  upload: (archiveBase64: string) => Promise<void>;
  loadCollections: (cursor?: string) => Promise<void>;
  previousCollections: () => Promise<void>;
  chooseCollection: (collection: RecoveryCollection) => Promise<void>;
  loadOccurrences: (cursor?: string) => Promise<void>;
  previousOccurrences: () => Promise<void>;
  setSelection: (selection: OccurrenceSelection) => void;
  prepareReview: () => void;
  setTarget: (sourceSubjectId: string, target: EntityPickerSubject | null) => void;
  editSelection: () => void;
  reviewSelection: () => Promise<void>;
  apply: () => Promise<void>;
  continueApply: () => Promise<void>;
  readStatus: () => Promise<void>;
  refreshConflict: () => Promise<void>;
  loadOutcomes: (cursor?: string) => Promise<void>;
  previousOutcomes: () => Promise<void>;
  retryRead: () => Promise<void>;
  cancel: () => Promise<void>;
  retryUnknown: () => Promise<void>;
  restart: () => void;
  adoptOriginalArchive: () => Promise<void>;
  readReceivingCollection: (cursor?: string) => Promise<void>;
  expire: () => void;
  retire: () => void;
};

export function createArchiveCollectionRecoveryJourney(input: {
  port: RecoveryPort;
  visit: RecoveryVisit;
  onChange?: () => void;
  now?: () => number;
}) {
  const { port, visit } = input;
  const now = input.now ?? Date.now;
  const ledger = new RecoveryCostLedger();
  const listeners = new Set<() => void>();
  let stage: RecoveryStage = 'upload';
  let busy = false;
  let notice: RecoveryNotice = null;
  let uploadId: string | null = null;
  let expiresAt: string | null = null;
  let status: RecoveryStatus | null = null;
  let collectionPageData: RecoveryCollectionsPage | null = null;
  let selectedCollection: RecoveryCollection | null = null;
  let occurrencePageData: RecoveryOccurrencesPage | null = null;
  let selected: OccurrenceSelection = new Map();
  let targets = new Map<string, EntityPickerSubject>();
  let review: RecoveryReview | null = null;
  let outcomePageData: RecoveryOutcomesPage | null = null;
  let windows = {
    collections: emptyRecoveryReadWindow(),
    occurrences: emptyRecoveryReadWindow(),
    outcomes: emptyRecoveryReadWindow(),
  };
  let readRetry: RecoveryReader | null = null;
  let receiving: ReceivingCollectionReadback | null = null;
  let originalArchiveBase64: string | null = null;
  let unknown: RecoveryEffectCommand | null = null;
  let expiredTimer: ReturnType<typeof setTimeout> | undefined;
  let retired = false;
  let generation = 0;

  function snapshot(): RecoverySnapshot {
    return {
      stage,
      busy,
      notice: notice ? structuredClone(notice) : null,
      uploadId,
      expiresAt,
      status,
      collectionsPage: collectionPageData,
      selectedCollection,
      occurrencesPage: occurrencePageData,
      selected: new Map(selected),
      targets: new Map(targets),
      review,
      outcomesPage: outcomePageData,
      collectionsWindow: {
        canPrevious: windows.collections.previous.length > 0,
        revision: windows.collections.revision,
      },
      occurrencesWindow: {
        canPrevious: windows.occurrences.previous.length > 0,
        revision: windows.occurrences.revision,
      },
      outcomesWindow: { canPrevious: windows.outcomes.previous.length > 0, revision: windows.outcomes.revision },
      readRetry,
      receiving,
      hasOriginalArchive: originalArchiveBase64 !== null,
      cost: ledger.snapshot(),
    };
  }

  function publish(): RecoverySnapshot {
    for (const listener of listeners) listener();
    input.onChange?.();
    return snapshot();
  }

  function clearPrivateEvidence() {
    collectionPageData = null;
    selectedCollection = null;
    occurrencePageData = null;
    selected = new Map();
    targets = new Map();
    review = null;
    outcomePageData = null;
    receiving = null;
    unknown = null;
    clearReadWindows();
  }

  function clearReadWindows() {
    windows = {
      collections: emptyRecoveryReadWindow(),
      occurrences: emptyRecoveryReadWindow(),
      outcomes: emptyRecoveryReadWindow(),
    };
    readRetry = null;
  }

  function clearReadWindow(kind: RecoveryReader) {
    windows[kind] = emptyRecoveryReadWindow();
    if (readRetry === kind) readRetry = null;
  }

  function clearSelectionWindows() {
    clearReadWindow('collections');
    clearReadWindow('occurrences');
  }

  function setExpiry(value: string | null) {
    if (expiredTimer) clearTimeout(expiredTimer);
    expiredTimer = undefined;
    expiresAt = value;
    if (!value) return;
    const deadline = Date.parse(value);
    if (!Number.isFinite(deadline)) return;
    const delay = Math.max(0, deadline - now());
    expiredTimer = setTimeout(() => expire(), delay);
  }

  function live(): boolean {
    if (retired || !visit.current()) return false;
    if (expiresAt && Date.parse(expiresAt) <= now()) {
      expire();
      return false;
    }
    return true;
  }

  function expire() {
    if (retired || stage === 'expired') return;
    if (expiredTimer) clearTimeout(expiredTimer);
    expiredTimer = undefined;
    clearPrivateEvidence();
    stage = 'expired';
    busy = false;
    notice = null;
    publish();
  }

  function retire() {
    if (retired) return;
    retired = true;
    generation += 1;
    if (expiredTimer) clearTimeout(expiredTimer);
    expiredTimer = undefined;
    visit.retire();
    clearPrivateEvidence();
    uploadId = null;
    expiresAt = null;
    status = null;
    collectionPageData = null;
    busy = false;
    notice = null;
  }

  function acceptStatus(value: RecoveryStatus) {
    const previousState = status?.state;
    status = value;
    uploadId = value.uploadId;
    setExpiry(value.expiresAt);
    if (value.state === 'expired') {
      expire();
      return;
    }
    if (previousState && previousState !== value.state) {
      outcomePageData = null;
      clearReadWindow('outcomes');
    }
    if (value.state === 'cancelled' || value.state === 'complete' || value.state === 'partial') {
      clearSelectionWindows();
      stage = 'results';
    }
  }

  function fail(response: RecoveryFailure) {
    notice = response;
    if (response.kind === 'denied') {
      stage = 'denied';
      clearPrivateEvidence();
    } else if (response.kind === 'conflict') {
      stage = 'conflict';
    } else if (response.kind === 'not-found') {
      expire();
    }
  }

  async function mutation<T>(
    command: RecoveryEffectCommand,
    send: () => Promise<{ kind: 'ok'; value: T } | RecoveryFailure | RecoveryUnknown>,
    onValue: (value: T) => void | Promise<void>,
    retry = false,
  ): Promise<void> {
    if (!live() || busy || unknown) return;
    const ticket = generation;
    busy = true;
    notice = null;
    ledger.call(command.kind, retry);
    publish();
    let result: { kind: 'ok'; value: T } | RecoveryFailure | RecoveryUnknown;
    try {
      result = await send();
    } catch {
      result = { kind: 'unknown', command: structuredClone(command) };
    }
    if (ticket !== generation || !live()) return;
    busy = false;
    if (result.kind === 'unknown') {
      unknown = structuredClone(command);
      notice = { kind: 'unknown', command: structuredClone(command) };
      publish();
      return;
    }
    if (result.kind !== 'ok') {
      unknown = null;
      fail(result);
      publish();
      return;
    }
    unknown = null;
    notice = null;
    try {
      await onValue(result.value);
    } catch {
      notice = { kind: 'unavailable' };
    }
    if (ticket === generation && live()) publish();
  }

  async function read<T>(inputRead: {
    kind: 'status';
    send: () => Promise<{ kind: 'ok'; value: T } | RecoveryFailure | RecoveryUnknown>;
    onValue: (value: T) => void | Promise<void>;
  }): Promise<void> {
    if (!live() || busy || unknown) return;
    const ticket = generation;
    busy = true;
    notice = null;
    ledger.call(inputRead.kind);
    publish();
    let result: { kind: 'ok'; value: T } | RecoveryFailure | RecoveryUnknown;
    try {
      result = await inputRead.send();
    } catch {
      result = { kind: 'unavailable' };
    }
    if (ticket !== generation || !live()) return;
    busy = false;
    if (result.kind !== 'ok') {
      fail(result.kind === 'unknown' ? { kind: 'unavailable' } : result);
      publish();
      return;
    }
    notice = null;
    try {
      await inputRead.onValue(result.value);
    } catch {
      notice = { kind: 'unavailable' };
    }
    if (ticket === generation && live()) publish();
  }

  function readerWindow(kind: RecoveryReader): RecoveryReadWindow {
    return windows[kind];
  }

  function readAdmission(kind: RecoveryReader, sourceStage: RecoveryStage): RecoveryReadAdmission | null {
    if (!uploadId) return null;
    if (kind === 'occurrences' && !selectedCollection) return null;
    return {
      uploadId,
      collectionId: kind === 'occurrences' ? selectedCollection!.id : null,
      phase: kind === 'outcomes' ? 'results' : 'selection',
      statusState: kind === 'outcomes' ? (status?.state ?? null) : null,
      sourceStage,
    };
  }

  function pageReadAdmitted(kind: RecoveryReader, target: RecoveryReadTarget): boolean {
    if (!live() || uploadId !== target.admission.uploadId) return false;
    if (kind === 'occurrences' && selectedCollection?.id !== target.admission.collectionId) return false;
    if (target.admission.phase === 'results') {
      return (stage === 'results' || stage === 'conflict') && status?.state === target.admission.statusState;
    }
    if (kind === 'occurrences') return stage === 'occurrences' || stage === 'conflict';
    return stage === 'collections' || stage === 'occurrences' || stage === 'conflict';
  }

  async function readPage(kind: RecoveryReader, direction: 'first' | 'next' | 'previous' | 'retry', cursor?: string) {
    if (!live() || busy || unknown || !uploadId) return;
    if (readRetry && direction !== 'retry') return;
    const sourceStage = stage;
    const admission = readAdmission(kind, sourceStage);
    if (!admission) return;
    let target =
      direction === 'retry'
        ? readerWindow(kind).staged
        : recoveryReadTarget(readerWindow(kind), direction, admission, cursor);
    if (!target) return;
    if (direction === 'retry') {
      if (
        readRetry !== kind ||
        !sameRecoveryReadAdmission(target.admission, admission) ||
        !pageReadAdmitted(kind, target)
      )
        return;
    } else if (!pageReadAdmitted(kind, target)) {
      return;
    }

    const ticket = generation;
    readerWindow(kind).staged = target;
    busy = true;
    notice = null;
    ledger.pageRequest(kind, direction === 'retry');
    publish();
    let result:
      | { kind: 'ok'; value: RecoveryCollectionsPage | RecoveryOccurrencesPage | RecoveryOutcomesPage }
      | RecoveryFailure
      | RecoveryUnknown;
    try {
      const query: RecoveryPageQuery =
        target.cursor === null ? { limit: RECOVERY_PAGE_ROWS } : { limit: RECOVERY_PAGE_ROWS, cursor: target.cursor };
      switch (kind) {
        case 'collections':
          result = await port.collections(uploadId, query);
          break;
        case 'occurrences':
          result = await port.occurrences(uploadId, selectedCollection!.id, query);
          break;
        case 'outcomes':
          result = await port.outcomes(uploadId, query);
          break;
      }
    } catch {
      result = { kind: 'unavailable' };
    }
    if (ticket !== generation || !pageReadAdmitted(kind, target)) return;
    busy = false;
    if (result.kind !== 'ok') {
      fail(result.kind === 'unknown' ? { kind: 'unavailable' } : result);
      if (readerWindow(kind).staged === target) readRetry = kind;
      publish();
      return;
    }

    const page = result.value;
    const previousState = status?.state;
    const rows =
      kind === 'collections'
        ? (page as RecoveryCollectionsPage).collections.length
        : kind === 'occurrences'
          ? (page as RecoveryOccurrencesPage).occurrences.length
          : (page as RecoveryOutcomesPage).outcomes.length;
    ledger.pageResult(rows);
    notice = null;
    acceptStatus(page);
    if (stage === 'expired' || stage === 'denied') {
      publish();
      return;
    }

    const changedOutcomeState = kind === 'outcomes' && previousState !== page.state;
    if (changedOutcomeState && target.cursor !== null) {
      outcomePageData = null;
      clearReadWindow('outcomes');
      stage = 'results';
      publish();
      return;
    }

    if (kind === 'collections') {
      collectionPageData = page as RecoveryCollectionsPage;
      if (stage !== 'results') stage = 'collections';
    } else if (kind === 'occurrences') {
      occurrencePageData = page as RecoveryOccurrencesPage;
      if (stage !== 'results') stage = 'occurrences';
    } else {
      outcomePageData = page as RecoveryOutcomesPage;
      stage = 'results';
    }

    if (changedOutcomeState) {
      const freshAdmission = readAdmission('outcomes', 'results')!;
      target = recoveryReadTarget(readerWindow('outcomes'), 'first', freshAdmission)!;
      readerWindow('outcomes').staged = target;
    }
    if (readerWindow(kind).staged === target && pageReadAdmitted(kind, target)) {
      windows[kind] = commitRecoveryRead(readerWindow(kind), target);
      readRetry = null;
    }
    if (ticket === generation && live()) publish();
  }

  async function loadOutcomePage(cursor?: string) {
    await readPage('outcomes', cursor === undefined ? 'first' : 'next', cursor);
  }

  async function loadCollectionPage(cursor?: string) {
    await readPage('collections', cursor === undefined ? 'first' : 'next', cursor);
  }

  async function loadOccurrencePage(cursor?: string) {
    await readPage('occurrences', cursor === undefined ? 'first' : 'next', cursor);
  }

  async function acceptedMutationStatus(value: RecoveryStatus) {
    acceptStatus(value);
    if (stage !== 'expired' && stage !== 'denied') {
      clearReadWindow('outcomes');
      outcomePageData = null;
      stage = 'results';
      await loadOutcomePage();
    }
  }

  async function dispatch(command: RecoveryEffectCommand, retry = false) {
    switch (command.kind) {
      case 'upload':
        await mutation(
          command,
          () => port.upload(command),
          async (value) => {
            acceptStatus(value);
            if (stage !== 'expired' && stage !== 'denied') stage = 'collections';
            await loadCollectionPage();
          },
          retry,
        );
        break;
      case 'review':
        await mutation(
          command,
          () => port.review(command),
          (value) => {
            review = value;
            acceptStatus(value);
            stage = 'review';
          },
          retry,
        );
        break;
      case 'apply':
        await mutation(command, () => port.apply(command), acceptedMutationStatus, retry);
        break;
      case 'cancel':
        await mutation(command, () => port.cancel(command), acceptedMutationStatus, retry);
        break;
    }
  }

  return {
    snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    upload(archiveBase64: string) {
      const admitted = archiveBase64;
      originalArchiveBase64 = admitted;
      const command: Extract<RecoveryEffectCommand, { kind: 'upload' }> = {
        kind: 'upload',
        key: newRecoveryCommandKey(),
        body: { archiveBase64: admitted },
      };
      return dispatch(command);
    },
    loadCollections(cursor?: string) {
      return loadCollectionPage(cursor);
    },
    previousCollections() {
      return readPage('collections', 'previous');
    },
    async chooseCollection(collection: RecoveryCollection) {
      if (!live() || busy || unknown || !collection.eligible) return;
      selectedCollection = structuredClone(collection);
      clearReadWindow('occurrences');
      clearReadWindow('outcomes');
      selected = new Map();
      targets = new Map();
      review = null;
      outcomePageData = null;
      stage = 'occurrences';
      await loadOccurrencePage();
    },
    loadOccurrences(cursor?: string) {
      return loadOccurrencePage(cursor);
    },
    previousOccurrences() {
      return readPage('occurrences', 'previous');
    },
    setSelection(value: OccurrenceSelection) {
      if (!live() || busy || unknown) return;
      selected = new Map(value);
      review = null;
      if (stage === 'review') stage = 'occurrences';
      publish();
    },
    prepareReview() {
      if (!live() || busy || unknown || readRetry || !selected.size) return;
      review = null;
      stage = 'review';
      publish();
    },
    setTarget(sourceSubjectId: string, target: EntityPickerSubject | null) {
      if (!live() || busy || unknown || review) return;
      const next = new Map(targets);
      if (target) next.set(sourceSubjectId, structuredClone(target));
      else next.delete(sourceSubjectId);
      targets = next;
      publish();
    },
    editSelection() {
      if (!live() || busy || unknown) return;
      review = null;
      stage = occurrencePageData ? 'occurrences' : 'collections';
      publish();
    },
    reviewSelection() {
      if (!live() || busy || unknown || !selectedCollection || !uploadId || !selected.size) return Promise.resolve();
      const targetIds = new Map([...targets].map(([sourceId, subject]) => [sourceId, subject.id]));
      const body = makeReviewBody({ collectionId: selectedCollection.id, selected, targets: targetIds });
      const command: Extract<RecoveryEffectCommand, { kind: 'review' }> = {
        kind: 'review',
        uploadId,
        key: newRecoveryCommandKey(),
        body: structuredClone(body),
      };
      return dispatch(command);
    },
    apply() {
      const confirmation = review?.review;
      if (!live() || busy || unknown || !uploadId || !confirmation) return Promise.resolve();
      const command: Extract<RecoveryEffectCommand, { kind: 'apply' }> = {
        kind: 'apply',
        uploadId,
        body: { reviewId: confirmation.reviewId, digest: confirmation.digest },
      };
      return dispatch(command);
    },
    continueApply() {
      if (!live() || busy || unknown || !uploadId || !review?.review) return Promise.resolve();
      const confirmation = review.review;
      const command: Extract<RecoveryEffectCommand, { kind: 'apply' }> = {
        kind: 'apply',
        uploadId,
        body: { reviewId: confirmation.reviewId, digest: confirmation.digest },
      };
      return dispatch(command);
    },
    async readStatus() {
      if (!uploadId) return;
      await read({
        kind: 'status',
        send: () => port.status(uploadId!),
        onValue: (value) => {
          acceptStatus(value);
          if (value.state === 'preview') stage = selectedCollection ? 'occurrences' : 'collections';
          if (value.state === 'reviewed' && review) stage = 'review';
        },
      });
    },
    async refreshConflict() {
      if (!uploadId) return;
      await read({
        kind: 'status',
        send: () => port.status(uploadId!),
        onValue: (value) => {
          acceptStatus(value);
          if (value.state === 'preview') {
            review = null;
            stage = selectedCollection ? 'occurrences' : 'collections';
          }
        },
      });
    },
    loadOutcomes(cursor?: string) {
      return loadOutcomePage(cursor);
    },
    previousOutcomes() {
      return readPage('outcomes', 'previous');
    },
    retryRead() {
      return readRetry ? readPage(readRetry, 'retry') : Promise.resolve();
    },
    cancel() {
      if (!live() || busy || unknown || !uploadId) return Promise.resolve();
      return dispatch({ kind: 'cancel', uploadId });
    },
    async retryUnknown() {
      const command = unknown;
      if (!command || !live() || busy) return;
      unknown = null;
      const cloned = structuredClone(command);
      await dispatch(cloned, true);
    },
    restart() {
      if (!live() || busy || unknown) return;
      const archive = originalArchiveBase64;
      clearPrivateEvidence();
      originalArchiveBase64 = archive;
      uploadId = null;
      status = null;
      notice = null;
      setExpiry(null);
      stage = 'upload';
      publish();
    },
    adoptOriginalArchive() {
      if (!live() || busy || unknown || !originalArchiveBase64) return Promise.resolve();
      return dispatch({
        kind: 'upload',
        key: newRecoveryCommandKey(),
        body: { archiveBase64: originalArchiveBase64 },
      });
    },
    async readReceivingCollection(cursor) {
      const collectionId = outcomePageData?.collection?.id ?? status?.collectionId;
      if (!collectionId || !live() || busy || unknown) return;
      const ticket = generation;
      busy = true;
      notice = null;
      ledger.call('readback');
      publish();
      let result: Awaited<ReturnType<RecoveryPort['receivingCollection']>>;
      try {
        result = await port.receivingCollection(collectionId, cursor);
      } catch {
        result = { kind: 'unavailable' };
      }
      if (ticket !== generation || !live()) return;
      busy = false;
      if (result.kind !== 'ok') {
        fail(result.kind === 'unknown' ? { kind: 'unavailable' } : result);
        publish();
        return;
      }
      receiving = result.value;
      ledger.pageResult(result.value.members.length);
      publish();
    },
    expire,
    retire,
  } satisfies ArchiveCollectionRecoveryJourney;
}
