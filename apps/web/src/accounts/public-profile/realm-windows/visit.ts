import type { AnyRouter } from '@tanstack/react-router';

export type Coordinate = string | undefined;
export type Movement = 'next' | 'previous' | 'first';
type Pending = {
  target: Coordinate;
  movement: Movement;
  href: string;
  loading: boolean;
  focus?: { eligible: () => boolean; release: () => void };
};

/** A router's single live public Realms visit owns coordinates, never native page bodies. */
export class RealmsVisit {
  binding: string | undefined;
  source: WeakRef<object> | undefined;
  coordinates: Coordinate[] = [];
  pending: Pending | undefined;
  active = true;
  mounts = 0;
  revision = 0;
  private release: () => void;

  constructor(router: AnyRouter) {
    const leave = router.subscribe('onBeforeLoad', ({ toLocation }) => {
      const pending = this.pending;
      // A deliberate movement authorizes exactly one route load, including cursor-free Retry.
      if (pending && !pending.loading && toLocation.publicHref === pending.href) {
        pending.loading = true;
      } else this.retire();
    });
    const resolved = router.subscribe('onResolved', () => {
      queueMicrotask(() => {
        if (!this.mounts) this.retire();
      });
    });
    this.release = () => {
      leave();
      resolved();
    };
  }

  retire() {
    this.active = false;
    this.coordinates = [];
    this.pending?.focus?.release();
    this.pending = undefined;
    this.source = undefined;
    this.release();
  }

  accept(source: object, binding: string | undefined, coordinate: Coordinate, ready: boolean) {
    if (this.source?.deref() === source) return false;
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
        this.pending.focus = undefined;
        this.pending.loading = false;
      }
      return false;
    }
    if (this.pending && this.pending.target === coordinate) {
      const { movement } = this.pending;
      if (movement === 'first') this.coordinates = [undefined];
      else if (movement === 'previous') this.coordinates = this.coordinates.slice(0, -1);
      else this.coordinates = [...this.coordinates, coordinate].slice(-9);
      const focus = this.pending.focus;
      const transfer = focus?.eligible() ?? false;
      focus?.release();
      this.pending = undefined;
      return transfer;
    }
    // Direct entries and replacements never invent a predecessor.
    this.pending?.focus?.release();
    this.pending = undefined;
    this.coordinates = [coordinate];
    return false;
  }

  start(target: Coordinate, movement: Movement, href: string, action?: HTMLElement) {
    this.pending?.focus?.release();
    let eligible = action !== undefined && document.activeElement === action;
    const moved = (event: FocusEvent) => {
      if (event.target !== action) eligible = false;
    };
    document.addEventListener('focusin', moved);
    this.pending = {
      target,
      movement,
      href,
      loading: false,
      focus: {
        eligible: () =>
          eligible &&
          (document.activeElement === action || (!action?.isConnected && document.activeElement === document.body)),
        release: () => document.removeEventListener('focusin', moved),
      },
    };
  }
}

const visits = new WeakMap<AnyRouter, RealmsVisit>();
export function realmsVisit(router: AnyRouter) {
  let visit = visits.get(router);
  if (!visit?.active) {
    visit = new RealmsVisit(router);
    visits.set(router, visit);
  }
  return visit;
}
