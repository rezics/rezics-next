import type { RecoveryFailureKind } from './contract';
import { RECOVERY_PREVIOUS_CURSORS, type RecoveryCursor } from './window';

export type ReceivingReadAddress = { collectionId: string; cursor: RecoveryCursor };
export type ReceivingReadTarget = ReceivingReadAddress & { direction: 'first' | 'next' | 'previous' };

/** Coordinates only: previous page bodies are never retained. */
export type ReceivingReadWindow = {
  displayed: ReceivingReadAddress | null;
  previous: RecoveryCursor[];
  requested: ReceivingReadTarget | null;
  loading: boolean;
  failure: RecoveryFailureKind | null;
  revision: number;
  lifetime: number;
  request: number;
};

export function emptyReceivingReadWindow(lifetime = 0): ReceivingReadWindow {
  return {
    displayed: null,
    previous: [],
    requested: null,
    loading: false,
    failure: null,
    revision: 0,
    lifetime,
    request: 0,
  };
}

export function receivingReadTarget(
  window: ReceivingReadWindow,
  collectionId: string,
  direction: 'first' | 'next' | 'previous' | 'retry',
  cursor?: string,
): ReceivingReadTarget | null {
  if (direction === 'retry') return window.failure ? window.requested : null;
  if (direction === 'previous') {
    if (!window.previous.length) return null;
    return { collectionId, cursor: window.previous.at(-1)!, direction };
  }
  if (direction === 'next') {
    if (cursor === undefined) return null;
    return { collectionId, cursor, direction };
  }
  return { collectionId, cursor: null, direction };
}

export function commitReceivingRead(window: ReceivingReadWindow, target: ReceivingReadTarget): ReceivingReadWindow {
  const previous =
    target.direction === 'next' && window.displayed
      ? [...window.previous, window.displayed.cursor].slice(-RECOVERY_PREVIOUS_CURSORS)
      : target.direction === 'previous'
        ? window.previous.slice(0, -1)
        : [];
  return {
    displayed: { collectionId: target.collectionId, cursor: target.cursor },
    previous,
    requested: null,
    loading: false,
    failure: null,
    revision: window.revision + 1,
    lifetime: window.lifetime,
    request: window.request,
  };
}
