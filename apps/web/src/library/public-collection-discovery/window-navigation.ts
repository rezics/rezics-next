import type { QueryClient } from '@tanstack/react-query';
import type { AnyRouter } from '@tanstack/react-router';

export type Coordinate = string | null;
export type Movement = 'next' | 'previous' | 'first';

type FocusHandoff = {
  eligible: () => boolean;
  release: () => void;
};

type PendingMovement = {
  target: Coordinate;
  movement: Movement;
  href: string;
  loading: boolean;
  focus?: FocusHandoff;
};

/** One public directory visit retains cursor coordinates only, never prior page data. */
export class PublicCollectionWindowVisit {
  active = true;
  binding: string | undefined;
  source: WeakRef<object> | undefined;
  coordinates: Coordinate[] = [];
  pending: PendingMovement | undefined;
  mounts = 0;
  revision = 0;
  private releaseRoute: () => void;

  constructor(router: AnyRouter) {
    const beforeLoad = router.subscribe('onBeforeLoad', () => {
      const pending = this.pending;
      if (pending && !pending.loading && router.history.location.href === pending.href) pending.loading = true;
      else this.retire();
    });
    const resolved = router.subscribe('onResolved', () => {
      queueMicrotask(() => {
        if (!this.mounts) this.retire();
      });
    });
    this.releaseRoute = () => {
      beforeLoad();
      resolved();
    };
  }

  get previous(): Coordinate | undefined {
    return this.coordinates.length > 1 ? this.coordinates.at(-2) : undefined;
  }

  retire() {
    if (!this.active) return;
    this.active = false;
    this.revision++;
    this.coordinates = [];
    this.source = undefined;
    this.pending?.focus?.release();
    this.pending = undefined;
    this.releaseRoute();
  }

  accept(source: object, binding: string, coordinate: Coordinate, ready: boolean) {
    if (!this.active || (this.source?.deref() === source && this.binding === binding)) return false;
    this.revision++;
    const pending = this.pending;
    if (this.binding !== undefined && this.binding !== binding) {
      this.coordinates = [];
      pending?.focus?.release();
      this.pending = undefined;
    }
    this.binding = binding;
    this.source = new WeakRef(source);
    if (!ready) {
      this.pending?.focus?.release();
      if (this.pending) {
        delete this.pending.focus;
        this.pending.loading = false;
      }
      return false;
    }
    if (this.pending && this.pending.target === coordinate) {
      const { movement } = this.pending;
      if (movement === 'first') this.coordinates = [null];
      else if (movement === 'previous') this.coordinates = this.coordinates.slice(0, -1);
      else this.coordinates = [...this.coordinates, coordinate].slice(-9);
      const focus = this.pending.focus;
      const transfer = focus?.eligible() ?? false;
      focus?.release();
      this.pending = undefined;
      return transfer;
    }
    this.pending?.focus?.release();
    this.pending = undefined;
    // A URL entered directly, including a later cursor, has no invented predecessor.
    this.coordinates = [coordinate];
    return false;
  }

  start(target: Coordinate, movement: Movement, href: string, action?: HTMLElement) {
    if (!this.active || this.pending?.loading) return false;
    this.pending?.focus?.release();
    let eligible = !!action && action.ownerDocument.activeElement === action;
    const document = action?.ownerDocument;
    const cancel = () => {
      eligible = false;
    };
    const focusIn = (event: FocusEvent) => {
      if (event.target !== action && event.target !== document?.body) cancel();
    };
    document?.addEventListener('focusin', focusIn);
    document?.addEventListener('pointerdown', cancel);
    document?.addEventListener('keydown', cancel);
    this.pending = {
      target,
      movement,
      href,
      loading: false,
      ...(document
        ? {
            focus: {
              eligible: () =>
                eligible &&
                (document.activeElement === action ||
                  (!action?.isConnected && document.activeElement === document.body)),
              release: () => {
                document.removeEventListener('focusin', focusIn);
                document.removeEventListener('pointerdown', cancel);
                document.removeEventListener('keydown', cancel);
              },
            },
          }
        : {}),
    };
    return true;
  }

  retry() {
    if (!this.active || !this.pending || this.pending.loading) return false;
    this.pending.loading = true;
    this.pending.focus?.release();
    delete this.pending.focus;
    return true;
  }
}

const visits = new WeakMap<QueryClient, PublicCollectionWindowVisit>();

export function publicCollectionWindowVisit(client: QueryClient, router: AnyRouter) {
  let visit = visits.get(client);
  if (!visit?.active) {
    visit = new PublicCollectionWindowVisit(router);
    visits.set(client, visit);
  }
  return visit;
}

/** Retain unrelated query bytes and the fragment while replacing only cursor fields. */
export function collectionWindowHref(pathname: string, search: string, hash: string, cursor: Coordinate) {
  const raw = search.replace(/^\?/, '');
  const retained = raw ? raw.split('&').filter((part) => !new URLSearchParams(part).has('cursor')) : [];
  if (cursor !== null) retained.push(`cursor=${encodeURIComponent(cursor)}`);
  const query = retained.length ? `?${retained.join('&')}` : '';
  const fragment = hash ? `#${hash.replace(/^#/, '')}` : '';
  return `${pathname}${query}${fragment}`;
}
