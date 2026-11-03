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
  type RecoveryPort,
  type RecoveryReview,
  type RecoveryStatus,
  type RecoveryUnknown,
} from './contract';
import { RecoveryCostLedger, type RecoveryCost } from './cost';
import { makeReviewBody, type OccurrenceSelection } from './selection';
import type { RecoveryVisit } from './visit';

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
  cost: RecoveryCost;
};

export type ArchiveCollectionRecoveryJourney = {
  snapshot: () => RecoverySnapshot;
  subscribe: (listener: () => void) => () => void;
  upload: (archiveBase64: string) => Promise<void>;
  loadCollections: (cursor?: string) => Promise<void>;
  chooseCollection: (collection: RecoveryCollection) => Promise<void>;
  loadOccurrences: (cursor?: string) => Promise<void>;
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
  cancel: () => Promise<void>;
  retryUnknown: () => Promise<void>;
  restart: () => void;
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
    unknown = null;
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
    status = value;
    uploadId = value.uploadId;
    setExpiry(value.expiresAt);
    if (value.state === 'expired') {
      expire();
      return;
    }
    if (value.state === 'cancelled' || value.state === 'complete' || value.state === 'partial') stage = 'results';
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
    kind: 'status' | 'collections' | 'occurrences' | 'outcomes';
    send: () => Promise<{ kind: 'ok'; value: T } | RecoveryFailure | RecoveryUnknown>;
    rows?: (value: T) => number;
    onValue: (value: T) => void | Promise<void>;
  }): Promise<void> {
    if (!live() || busy || unknown) return;
    const ticket = generation;
    busy = true;
    notice = null;
    if (!['collections', 'occurrences', 'outcomes'].includes(inputRead.kind)) ledger.call(inputRead.kind);
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
    if (inputRead.rows) {
      const rows = inputRead.rows(result.value);
      ledger.page(inputRead.kind as 'collections' | 'occurrences' | 'outcomes', rows);
    }
    notice = null;
    try {
      await inputRead.onValue(result.value);
    } catch {
      notice = { kind: 'unavailable' };
    }
    if (ticket === generation && live()) publish();
  }

  async function loadOutcomePage(cursor?: string) {
    if (!uploadId) return;
    await read({
      kind: 'outcomes',
      send: () => port.outcomes(uploadId!, { limit: RECOVERY_PAGE_ROWS, ...(cursor ? { cursor } : {}) }),
      rows: (page) => page.outcomes.length,
      onValue: (page) => {
        acceptStatus(page);
        if (stage !== 'expired') {
          outcomePageData = page;
          stage = 'results';
        }
      },
    });
  }

  async function loadCollectionPage(cursor?: string) {
    if (!uploadId) return;
    await read({
      kind: 'collections',
      send: () => port.collections(uploadId!, { limit: RECOVERY_PAGE_ROWS, ...(cursor ? { cursor } : {}) }),
      rows: (page) => page.collections.length,
      onValue: (page) => {
        acceptStatus(page);
        if (stage !== 'expired') {
          collectionPageData = page;
          if (stage !== 'results') stage = 'collections';
        }
      },
    });
  }

  async function loadOccurrencePage(cursor?: string) {
    if (!uploadId || !selectedCollection) return;
    await read({
      kind: 'occurrences',
      send: () =>
        port.occurrences(uploadId!, selectedCollection!.id, {
          limit: RECOVERY_PAGE_ROWS,
          ...(cursor ? { cursor } : {}),
        }),
      rows: (page) => page.occurrences.length,
      onValue: (page) => {
        acceptStatus(page);
        if (stage !== 'expired') {
          occurrencePageData = page;
          if (stage !== 'results') stage = 'occurrences';
        }
      },
    });
  }

  async function acceptedMutationStatus(value: RecoveryStatus) {
    acceptStatus(value);
    if (stage !== 'expired' && stage !== 'denied') {
      stage = 'results';
      await loadOutcomePage();
    }
  }

  async function dispatch(command: RecoveryEffectCommand, retry = false) {
    switch (command.kind) {
      case 'upload':
        await mutation(command, () => port.upload(command), async (value) => {
          acceptStatus(value);
          await loadCollectionPage();
        }, retry);
        break;
      case 'review':
        await mutation(command, () => port.review(command), (value) => {
          review = value;
          acceptStatus(value);
          stage = 'review';
        }, retry);
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
      const command: Extract<RecoveryEffectCommand, { kind: 'upload' }> = {
        kind: 'upload',
        key: newRecoveryCommandKey(),
        body: { archiveBase64 },
      };
      return dispatch(command);
    },
    loadCollections(cursor?: string) {
      return loadCollectionPage(cursor);
    },
    async chooseCollection(collection: RecoveryCollection) {
      if (!live() || busy || unknown || !collection.eligible) return;
      selectedCollection = structuredClone(collection);
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
    setSelection(value: OccurrenceSelection) {
      if (!live() || busy || unknown) return;
      selected = new Map(value);
      review = null;
      if (stage === 'review') stage = 'occurrences';
      publish();
    },
    prepareReview() {
      if (!live() || busy || unknown || !selected.size) return;
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
        onValue: async (value) => {
          acceptStatus(value);
          if (value.state === 'preview') {
            review = null;
            if (selectedCollection) {
              stage = 'occurrences';
              await loadOccurrencePage();
            } else {
              await loadCollectionPage();
            }
          }
        },
      });
    },
    loadOutcomes(cursor?: string) {
      return loadOutcomePage(cursor);
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
      clearPrivateEvidence();
      uploadId = null;
      status = null;
      notice = null;
      setExpiry(null);
      stage = 'upload';
      publish();
    },
    expire,
    retire,
  } satisfies ArchiveCollectionRecoveryJourney;
}
