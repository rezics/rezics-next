import type { QueryClient } from '@tanstack/react-query';
import { localizeHref, type Locale } from '../paraglide/runtime.js';
import { myLogsSearch } from './my-logs';

export type MyLogsCoordinate = string | null;
export type MyLogsWindowAction = 'next' | 'previous' | 'newest';

export type MyLogsWindowMovement = {
  action: MyLogsWindowAction;
  source: MyLogsCoordinate;
  target: MyLogsCoordinate;
  failed: boolean;
};

export type MyLogsWindowSnapshot = {
  /** At most eight predecessors plus the current coordinate. */
  coordinates: readonly MyLogsCoordinate[];
  current: MyLogsCoordinate | null;
  movement: MyLogsWindowMovement | null;
  focusReady: boolean;
  revision: number;
};

export type MyLogsWindowHrefs = { route: string; link: string };

const visitKey = ['named-route-visit', '/library/logs'] as const;
const emptySnapshot: MyLogsWindowSnapshot = {
  coordinates: [],
  current: null,
  movement: null,
  focusReady: false,
  revision: 0,
};

/** Replace only the opaque cursor bytes; keep every other query and fragment byte in place. */
export function myLogsWindowHrefs(currentHref: string, cursor: MyLogsCoordinate, locale: Locale): MyLogsWindowHrefs {
  const fragmentAt = currentHref.indexOf('#');
  const fragment = fragmentAt < 0 ? '' : currentHref.slice(fragmentAt);
  const address = fragmentAt < 0 ? currentHref : currentHref.slice(0, fragmentAt);
  const queryAt = address.indexOf('?');
  const rawQuery = queryAt < 0 ? undefined : address.slice(queryAt + 1);
  const retained = (rawQuery === undefined ? [] : rawQuery.split('&')).filter(
    (part) => new URLSearchParams(part).keys().next().value !== 'cursor',
  );
  if (cursor !== null) retained.push(`cursor=${encodeURIComponent(cursor)}`);
  const suffix = `${retained.length ? `?${retained.join('&')}` : ''}${fragment}`;
  return { route: `/library/logs${suffix}`, link: `${localizeHref('/library/logs', { locale })}${suffix}` };
}

function admittedCoordinate(value: MyLogsCoordinate): boolean {
  return value === null || myLogsSearch({ cursor: value }).cursor === value;
}

/** Cursor-only state for one named route visit. No page payloads enter this object. */
export class MyLogsWindowNavigation {
  private snapshot = emptySnapshot;
  private readonly listeners = new Set<() => void>();
  private authorityKey: string | null = null;
  private observedCursor: MyLogsCoordinate | undefined;
  private focusSource: HTMLElement | undefined;
  private focusListener: ((event: FocusEvent) => void) | undefined;
  private mounts = 0;
  private disposalGeneration = 0;
  private disposed = false;

  constructor(private readonly onDispose?: () => void) {}

  getSnapshot = () => this.snapshot;

  get isDisposed() {
    return this.disposed;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Keep a named route visit across an ordinary leaf remount, including Strict Mode replay. */
  attach = (routeIsCurrent?: () => boolean) => {
    if (this.disposed) return () => {};
    this.mounts++;
    this.disposalGeneration++;
    return () => {
      this.mounts--;
      const generation = ++this.disposalGeneration;
      queueMicrotask(() => {
        if (this.mounts === 0 && this.disposalGeneration === generation && !routeIsCurrent?.()) this.dispose();
      });
    };
  };

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.authorityKey = null;
    this.cancelFocus();
    this.snapshot = { ...emptySnapshot, revision: this.snapshot.revision + 1 };
    this.listeners.clear();
    this.onDispose?.();
  }

  /** A new address, viewer observation or operation admission starts with no predecessor. */
  observe(authorityKey: string | null, cursor: MyLogsCoordinate) {
    if (this.disposed) return;
    if (!authorityKey) {
      this.authorityKey = null;
      this.observedCursor = cursor;
      if (this.snapshot.coordinates.length || this.snapshot.movement || this.snapshot.focusReady) this.reset();
      return;
    }
    if (this.authorityKey !== authorityKey) {
      this.authorityKey = authorityKey;
      this.observedCursor = cursor;
      this.reset();
      return;
    }
    const expectedMovement = this.snapshot.movement?.target === cursor;
    if (this.observedCursor !== undefined && this.observedCursor !== cursor && !expectedMovement) this.reset();
    this.observedCursor = cursor;
  }

  beginMovement(
    authorityKey: string,
    action: MyLogsWindowAction,
    source: MyLogsCoordinate,
    target: MyLogsCoordinate,
    focusSource?: HTMLElement,
    keyboard = false,
  ): boolean {
    if (
      this.disposed ||
      this.authorityKey !== authorityKey ||
      this.snapshot.movement ||
      this.snapshot.current !== source ||
      this.snapshot.coordinates.at(-1) !== source ||
      !admittedCoordinate(target)
    )
      return false;
    if (action === 'next' && (typeof target !== 'string' || target === source)) return false;
    if (action === 'previous' && (this.snapshot.coordinates.length < 2 || this.snapshot.coordinates.at(-2) !== target))
      return false;
    if (action === 'newest' && (source === null || target !== null)) return false;
    this.armFocus(keyboard ? focusSource : undefined);
    this.replace({ ...this.snapshot, movement: { action, source, target, failed: false }, focusReady: false });
    return true;
  }

  /** Retry keeps the same staged raw target and does not restore a failed focus handoff. */
  retryMovement(authorityKey: string, cursor: MyLogsCoordinate): boolean {
    const movement = this.snapshot.movement;
    if (this.disposed || this.authorityKey !== authorityKey || !movement?.failed || movement.target !== cursor)
      return false;
    this.cancelFocus();
    this.replace({ ...this.snapshot, movement: { ...movement, failed: false }, focusReady: false });
    return true;
  }

  failMovement(authorityKey: string, cursor: MyLogsCoordinate) {
    const movement = this.snapshot.movement;
    if (
      this.disposed ||
      this.authorityKey !== authorityKey ||
      !movement ||
      movement.target !== cursor ||
      movement.failed
    )
      return;
    this.cancelFocus();
    this.replace({ ...this.snapshot, movement: { ...movement, failed: true }, focusReady: false });
  }

  cancelMovementFocus(authorityKey: string) {
    if (this.disposed || this.authorityKey !== authorityKey || (!this.focusListener && !this.snapshot.focusReady))
      return;
    this.cancelFocus();
    this.replace({ ...this.snapshot, focusReady: false });
  }

  /** Called after the matching current owner read succeeds. */
  accept(authorityKey: string, requested: MyLogsCoordinate, restarted = false) {
    if (this.disposed || this.authorityKey !== authorityKey) return;
    const movement = this.snapshot.movement;
    if (restarted) {
      const focusReady = movement?.target === requested && !!this.focusListener;
      if (!focusReady) this.cancelFocus();
      this.replace({
        ...this.snapshot,
        coordinates: [null],
        current: null,
        movement: null,
        focusReady,
      });
      return;
    }

    if (movement?.target === requested) {
      const coordinates =
        movement.action === 'next'
          ? [...this.snapshot.coordinates, requested].slice(-9)
          : movement.action === 'previous'
            ? this.snapshot.coordinates.slice(0, -1)
            : [null];
      this.replace({
        ...this.snapshot,
        coordinates,
        current: requested,
        movement: null,
        focusReady: !!this.focusListener,
      });
      return;
    }

    if (!this.snapshot.coordinates.length || this.snapshot.current !== requested) {
      this.cancelFocus();
      this.replace({
        ...this.snapshot,
        coordinates: [requested],
        current: requested,
        movement: null,
        focusReady: false,
      });
      return;
    }
    if (movement) {
      this.cancelFocus();
      this.replace({ ...this.snapshot, movement: null, focusReady: false });
    }
  }

  consumeFocus(authorityKey: string): boolean {
    if (this.disposed || this.authorityKey !== authorityKey || !this.snapshot.focusReady) return false;
    this.cancelFocus();
    this.replace({ ...this.snapshot, focusReady: false });
    return true;
  }

  private reset() {
    this.cancelFocus();
    this.replace({ ...emptySnapshot, revision: this.snapshot.revision });
  }

  private armFocus(source?: HTMLElement) {
    this.cancelFocus();
    if (typeof document === 'undefined' || !source || document.activeElement !== source) return;
    this.focusSource = source;
    this.focusListener = (event) => {
      if (
        event.target === this.focusSource ||
        event.target === document.body ||
        event.target === document.documentElement
      )
        return;
      this.cancelFocus();
      this.replace({ ...this.snapshot, focusReady: false });
    };
    document.addEventListener('focusin', this.focusListener, true);
  }

  private cancelFocus() {
    if (this.focusListener && typeof document !== 'undefined')
      document.removeEventListener('focusin', this.focusListener, true);
    this.focusListener = undefined;
    this.focusSource = undefined;
  }

  private replace(next: Omit<MyLogsWindowSnapshot, 'revision'> & { revision?: number }) {
    this.snapshot = { ...next, revision: this.snapshot.revision + 1 };
    for (const listener of [...this.listeners]) listener();
  }
}

/** One bounded named-route visit per QueryClient, removed when the reader leaves. */
export function myLogsWindowNavigation(client: QueryClient): MyLogsWindowNavigation {
  client.setQueryDefaults(visitKey, { gcTime: Infinity });
  const existing = client.getQueryData<MyLogsWindowNavigation>(visitKey);
  if (existing && !existing.isDisposed) return existing;
  let visit: MyLogsWindowNavigation;
  visit = new MyLogsWindowNavigation(() => {
    if (client.getQueryData(visitKey) === visit) client.removeQueries({ queryKey: visitKey, exact: true });
  });
  client.setQueryData(visitKey, visit);
  return visit;
}
