import { isPlatformClosedError } from '../kernel/platform-closed';
import {
  createRealmDiscoveryWindow,
  reduceRealmDiscovery,
  requireRealmDiscoveryRestart,
  type RealmDiscoveryPage,
  type RealmDiscoveryWindow,
} from './realm-discovery-loader';

/** Content accepts Realm cursors up to 4096 characters; progress state keeps at most one such cursor. */
export const REALM_DISCOVERY_CURSOR_MAX_LENGTH = 4096;

export type RealmPageProgress = Readonly<{
  cursor?: string;
  anchor?: string;
  power: number;
  distance: number;
  started: boolean;
}>;

export function initialRealmPageProgress(): RealmPageProgress {
  return { power: 1, distance: 0, started: false };
}

/** Brent's constant-space cycle check over opaque continuation cursors. */
export function advanceRealmPageProgress(
  previous: RealmPageProgress,
  requestedCursor: string | undefined,
  nextCursor: string | null,
): RealmPageProgress | null {
  if (previous.cursor !== requestedCursor) return null;
  if (
    nextCursor !== null &&
    (typeof nextCursor !== 'string' || nextCursor.length === 0 || nextCursor.length > REALM_DISCOVERY_CURSOR_MAX_LENGTH)
  )
    return null;
  if (nextCursor === null)
    return {
      ...(previous.anchor !== undefined ? { anchor: previous.anchor } : {}),
      power: previous.power,
      distance: previous.distance,
      started: true,
    };
  if (!previous.started) return { cursor: nextCursor, anchor: nextCursor, power: 1, distance: 0, started: true };
  if (nextCursor === previous.anchor) return null;

  const distance = previous.distance + 1;
  if (!Number.isSafeInteger(distance)) return null;
  if (distance === previous.power) {
    const power = previous.power * 2;
    if (!Number.isSafeInteger(power)) return null;
    return { cursor: nextCursor, anchor: nextCursor, power, distance: 0, started: true };
  }
  return { ...previous, cursor: nextCursor, distance };
}

export type RealmPageReader = (
  input: Readonly<{ cursor?: string; signal: AbortSignal }>,
) => Promise<RealmDiscoveryPage>;

/** Shared explicit-page controller for Search and header Realm browsing. */
export function createRealmPageProgress(input: {
  initial?: RealmDiscoveryPage;
  read: RealmPageReader;
  publish: (window: RealmDiscoveryWindow) => void;
}) {
  let window = input.initial
    ? createRealmDiscoveryWindow(input.initial)
    : createRealmDiscoveryWindow({ kind: 'loading' });
  let progress = initialRealmPageProgress();
  if (input.initial?.kind === 'ready') {
    const next = advanceRealmPageProgress(progress, undefined, input.initial.next);
    if (next) progress = next;
    else window = requireRealmDiscoveryRestart(window);
  }

  let active: AbortController | undefined;
  let disposed = false;
  let started = false;

  const update = (page: RealmDiscoveryPage | { kind: 'loading' }) => {
    window = reduceRealmDiscovery(window, page);
    input.publish(window);
  };

  const request = async (restart = false) => {
    if (disposed || active || window.state.kind === 'closed') return;
    if (!restart && window.state.kind === 'ready' && window.state.next === null) return;
    if (restart) progress = initialRealmPageProgress();
    const cursor = progress.cursor;
    const controller = new AbortController();
    active = controller;
    update({ kind: 'loading' });
    try {
      const page = await input.read({ ...(cursor !== undefined ? { cursor } : {}), signal: controller.signal });
      if (disposed || controller.signal.aborted) return;
      if (page.kind === 'ready') {
        const next = advanceRealmPageProgress(progress, cursor, page.next);
        if (!next) {
          window = requireRealmDiscoveryRestart(window);
          input.publish(window);
          return;
        }
        progress = next;
      }
      update(page);
    } catch (error) {
      if (!disposed && !controller.signal.aborted)
        update({ kind: isPlatformClosedError(error) ? 'closed' : 'unavailable' });
    } finally {
      if (active === controller) active = undefined;
    }
  };

  return {
    snapshot: () => window,
    start() {
      if (started || disposed) return;
      started = true;
      if (!input.initial) return request();
    },
    next() {
      if (
        window.retry ||
        window.state.kind !== 'ready' ||
        window.state.next === null ||
        window.state.next !== progress.cursor
      ) {
        if (window.state.kind === 'ready' && window.state.next !== null && window.state.next !== progress.cursor) {
          window = requireRealmDiscoveryRestart(window);
          input.publish(window);
        }
        return;
      }
      return request();
    },
    retry() {
      if (!window.retry || window.pending) return;
      return request(window.restart);
    },
    dispose() {
      disposed = true;
      active?.abort();
    },
  };
}
