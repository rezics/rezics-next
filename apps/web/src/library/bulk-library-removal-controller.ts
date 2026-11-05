import { useEffect, useRef, useState } from 'react';
import { csrfHeaders } from '../threads/composer';
import { displayLibraryTitle } from './title';
import type { ShelfMutationLease, ShelfRow } from './shelf-rows';
import type { ShelfRemovalIdentity } from './shelf-selection';
import {
  bulkLibraryRemovalReviewMatches,
  captureBulkLibraryRemovalPreview,
  createBulkLibraryRemovalManifest,
  landedBulkLibraryRemovalEntries,
  outcomesForBulkLibraryRemovalTargets,
  readCapturedBulkLibraryRemoval,
  sendCapturedBulkLibraryRemovalConfirmation,
  type BulkLibraryRemovalManifest,
  type BulkLibraryRemovalOperation,
  type BulkLibraryRemovalTargetOutcome,
} from './bulk-library-removal';

export type BulkLibraryRemovalPhase =
  | 'previewing'
  | 'preview-uncertain'
  | 'ready'
  | 'confirming'
  | 'uncertain'
  | 'recovering'
  | 'complete';

export type BulkLibraryRemovalReview = Readonly<{
  manifest: BulkLibraryRemovalManifest;
  signature: string;
  locale: string;
  targets: readonly (ShelfRemovalIdentity & Readonly<{ title: string }>)[];
  operationId?: string;
  operation?: BulkLibraryRemovalOperation;
  outcomes: readonly BulkLibraryRemovalTargetOutcome[];
  phase: BulkLibraryRemovalPhase;
  readError?: boolean;
}>;

export type BulkLibraryRemovalControllerOptions = Readonly<{
  rows: readonly ShelfRow[];
  selected: readonly string[];
  locale: string;
  isCurrent: () => boolean;
  selectionBlocked: boolean;
  writeAdmitted: boolean;
  readAdmitted: boolean;
  pending: boolean;
  mutationLease: ShelfMutationLease;
  onLanded: (targets: readonly ShelfRemovalIdentity[]) => void;
}>;

export type BulkLibraryRemovalController = Readonly<{
  review: BulkLibraryRemovalReview | null;
  changed: boolean;
  error: 'selection_too_large' | 'preview' | null;
  busy: boolean;
  showAction: boolean;
  canPreview: boolean;
  canRetryPreview: boolean;
  canConfirm: boolean;
  canRecover: boolean;
  preview: () => Promise<void>;
  retryPreview: () => Promise<void>;
  confirm: () => Promise<void>;
  recover: () => Promise<void>;
}>;

const pageOwned = (phase: BulkLibraryRemovalPhase) =>
  phase === 'previewing' || phase === 'preview-uncertain' || phase === 'ready';

function selectedRows(options: BulkLibraryRemovalControllerOptions): ShelfRow[] {
  const selected = new Set(options.selected);
  return options.rows.filter(({ entry }) => selected.has(entry.subjectId));
}

export function useBulkLibraryRemoval(options: BulkLibraryRemovalControllerOptions): BulkLibraryRemovalController {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [reviewState, setReviewState] = useState<BulkLibraryRemovalReview | null>(null);
  const reviewRef = useRef(reviewState);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<BulkLibraryRemovalController['error']>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const releaseRef = useRef<(() => void) | null>(null);

  const updateReview = (next: BulkLibraryRemovalReview | null) => {
    reviewRef.current = next;
    setReviewState(next);
    if (next) {
      setChanged(false);
      setError(null);
    }
  };
  const invalidate = (announce = true) => {
    const hadReview = reviewRef.current !== null;
    reviewRef.current = null;
    setReviewState(null);
    setChanged(announce && hadReview);
    setError(null);
  };
  const currentEntries = () => selectedRows(optionsRef.current).map(({ entry }) => entry);
  const currentSignature = () => {
    const capture = captureBulkLibraryRemovalPreview(currentEntries());
    return capture.ok ? capture.signature : null;
  };
  const reviewCurrent = (review: BulkLibraryRemovalReview, requireSelection: boolean) => {
    const current = optionsRef.current;
    const selectionCurrent =
      !requireSelection ||
      bulkLibraryRemovalReviewMatches(
        review.signature,
        currentEntries(),
        review.locale,
        current.locale,
        current.isCurrent(),
      );
    return (
      reviewRef.current?.manifest === review.manifest &&
      review.locale === current.locale &&
      current.isCurrent() &&
      selectionCurrent
    );
  };
  const writeCurrent = () => {
    const current = optionsRef.current;
    return current.isCurrent() && current.writeAdmitted;
  };
  const readCurrent = () => {
    const current = optionsRef.current;
    return current.isCurrent() && current.readAdmitted;
  };
  const acquire = (allowed: () => boolean) => {
    const lease = optionsRef.current.mutationLease;
    if (!allowed() || lease.current) return undefined;
    const owner = Symbol();
    lease.owner = owner;
    lease.current = true;
    lease.listeners.forEach((listener) => listener());
    const release = () => {
      if (lease.owner !== owner) return;
      delete lease.owner;
      lease.current = false;
      lease.listeners.forEach((listener) => listener());
      releaseRef.current = null;
      if (mounted.current) setBusy(false);
    };
    releaseRef.current = release;
    setBusy(true);
    return release;
  };

  useEffect(() => {
    const current = optionsRef.current;
    const review = reviewRef.current;
    if (!current.isCurrent()) {
      invalidate(false);
      releaseRef.current?.();
      return;
    }
    if (review && review.locale !== current.locale) {
      invalidate(false);
      return;
    }
    if (review && pageOwned(review.phase) && currentSignature() !== review.signature) invalidate(true);
  }, [options.rows, options.selected, options.locale, options.isCurrent]);

  useEffect(
    () => () => {
      mounted.current = false;
      releaseRef.current?.();
    },
    [],
  );

  const preview = async () => {
    const current = optionsRef.current;
    if (
      !current.isCurrent() ||
      !current.writeAdmitted ||
      current.pending ||
      current.selectionBlocked ||
      !current.selected.length ||
      (reviewRef.current !== null && reviewRef.current.phase !== 'complete')
    )
      return;
    const entries = currentEntries();
    const captured = captureBulkLibraryRemovalPreview(entries);
    if (!captured.ok) {
      setError('selection_too_large');
      return;
    }
    const headers = new Headers(csrfHeaders());
    if (!headers.get('x-csrf-token')) {
      setError('preview');
      return;
    }
    const release = acquire(writeCurrent);
    if (!release) return;
    const manifest = createBulkLibraryRemovalManifest(captured, Object.fromEntries(headers.entries()));
    const review: BulkLibraryRemovalReview = {
      manifest,
      signature: captured.signature,
      locale: current.locale,
      targets: entries.map((entry) => ({
        subjectId: entry.subjectId,
        revision: entry.revision,
        ...(entry.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId }),
        removeKey: entry.removeKey,
        title: entry.subject ? displayLibraryTitle(entry.subject.label, current.locale).text : entry.subjectId,
      })),
      outcomes: [],
      phase: 'previewing',
    };
    updateReview(review);
    try {
      const operation = await manifest.sender.preview(manifest.preview);
      if (!reviewCurrent(review, true) || !writeCurrent()) return;
      updateReview({
        ...review,
        operation,
        operationId: operation.id,
        phase: operation.phase === 'preview' ? 'ready' : 'complete',
      });
    } catch {
      if (reviewCurrent(review, true) && writeCurrent()) {
        updateReview({ ...review, phase: 'preview-uncertain' });
        setError('preview');
      }
    } finally {
      release();
    }
  };

  const retryPreview = async () => {
    const review = reviewRef.current;
    if (!review || review.phase !== 'preview-uncertain' || !reviewCurrent(review, true) || !writeCurrent()) return;
    const release = acquire(writeCurrent);
    if (!release) return;
    updateReview({ ...review, phase: 'previewing' });
    try {
      const operation = await review.manifest.sender.preview(review.manifest.preview);
      if (!reviewCurrent(review, true) || !writeCurrent()) return;
      updateReview({
        ...review,
        operation,
        operationId: operation.id,
        phase: operation.phase === 'preview' ? 'ready' : 'complete',
      });
    } catch {
      if (reviewCurrent(review, true) && writeCurrent()) {
        updateReview({ ...review, phase: 'preview-uncertain' });
        setError('preview');
      }
    } finally {
      release();
    }
  };

  const readOperation = async (review: BulkLibraryRemovalReview, returnPhase: BulkLibraryRemovalPhase) => {
    if (!review.operationId || !reviewCurrent(review, false) || !readCurrent()) return;
    updateReview({ ...review, phase: 'recovering', readError: false });
    try {
      const result = await readCapturedBulkLibraryRemoval(
        review.manifest,
        review.operationId,
        () => reviewCurrent(review, false) && readCurrent(),
      );
      if (!result || !reviewCurrent(review, false) || !readCurrent()) return;
      if (result.operation.action !== 'remove_from_library' || result.operation.selectionKind !== 'explicit')
        throw new Error('The native library removal operation changed identity.');
      const outcomes = outcomesForBulkLibraryRemovalTargets(review.targets, result.outcomes);
      updateReview({
        ...review,
        operation: result.operation,
        outcomes,
        phase: result.operation.phase === 'preview' ? 'ready' : 'complete',
        readError: false,
      });
      const landed = landedBulkLibraryRemovalEntries(review.targets, outcomes);
      if (landed.length && reviewCurrent({ ...review, phase: 'complete' }, false)) optionsRef.current.onLanded(landed);
    } catch {
      if (reviewCurrent(review, false) && readCurrent()) {
        updateReview({ ...review, phase: returnPhase, readError: true });
        setError(null);
      }
    }
  };

  const confirm = async () => {
    const review = reviewRef.current;
    if (
      !review ||
      !review.operationId ||
      (review.phase !== 'ready' && review.phase !== 'uncertain') ||
      !reviewCurrent(review, true)
    ) {
      if (review && pageOwned(review.phase) && !reviewCurrent(review, true)) invalidate(true);
      return;
    }
    if (!writeCurrent()) return;
    const release = acquire(writeCurrent);
    if (!release) return;
    updateReview({ ...review, phase: 'confirming', readError: false });
    try {
      const operation = await sendCapturedBulkLibraryRemovalConfirmation(
        review.manifest,
        review.operationId,
        () => reviewCurrent(review, true) && writeCurrent(),
      );
      if (!operation || !reviewCurrent(review, false)) return;
      const confirmed = { ...review, operation, phase: 'complete' as const };
      updateReview(confirmed);
      await readOperation(confirmed, 'complete');
    } catch {
      if (reviewCurrent(review, false)) updateReview({ ...review, phase: 'uncertain' });
    } finally {
      release();
    }
  };

  const recover = async () => {
    const review = reviewRef.current;
    if (!review?.operationId || !reviewCurrent(review, false) || !readCurrent()) return;
    const release = acquire(readCurrent);
    if (!release) return;
    await readOperation(review, review.phase);
    release();
  };

  const activeReview =
    reviewState?.locale === options.locale && options.isCurrent() && (options.writeAdmitted || options.readAdmitted)
      ? reviewState
      : null;
  const selectionMatches = activeReview ? reviewCurrent(activeReview, true) : false;
  return {
    review: activeReview,
    changed,
    error,
    busy,
    showAction: options.selected.length > 0 && options.writeAdmitted && options.isCurrent(),
    canPreview:
      options.selected.length > 0 &&
      options.writeAdmitted &&
      options.isCurrent() &&
      !options.pending &&
      !options.selectionBlocked &&
      !busy &&
      (!activeReview || activeReview.phase === 'complete'),
    canRetryPreview:
      activeReview?.phase === 'preview-uncertain' &&
      selectionMatches &&
      options.writeAdmitted &&
      !options.pending &&
      !busy,
    canConfirm:
      !!activeReview?.operationId &&
      (activeReview.phase === 'ready' || activeReview.phase === 'uncertain') &&
      selectionMatches &&
      options.writeAdmitted &&
      !options.pending &&
      !busy,
    canRecover: !!activeReview?.operationId && options.readAdmitted && options.isCurrent() && !options.pending && !busy,
    preview,
    retryPreview,
    confirm,
    recover,
  };
}
