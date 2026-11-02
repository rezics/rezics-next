import { useEffect, useRef } from 'react';

export type FilterSurface = 'desktop' | 'mobile';

type Request = {
  id: number;
  owner: string;
  kind: 'open' | 'close';
  surface?: FilterSurface;
  source: HTMLElement | null;
  destination: HTMLElement | null;
  resolveDestination?: () => HTMLElement | null;
  document: Document;
  moved: boolean;
  frame?: number;
  onFocusIn: (event: FocusEvent) => void;
};

function destinationOf(request: Request) {
  return request.destination ?? request.resolveDestination?.() ?? null;
}

function isDocumentRoot(document: Document, node: EventTarget | null) {
  return node === document.body || node === document.documentElement;
}

function occupies(destination: HTMLElement, node: EventTarget | null) {
  return node === destination || (node instanceof Node && destination.contains(node));
}

/** One current Filters open/close may restore a captured, still-connected destination. */
export function createFilterSurfaceFocus() {
  let nextId = 0;
  let lastOpener: HTMLElement | null = null;
  let pending: Request | null = null;

  function unlisten() {
    if (!pending) return;
    pending.document.removeEventListener('focusin', pending.onFocusIn, true);
    if (pending.frame !== undefined) cancelAnimationFrame(pending.frame);
  }

  function retire() {
    unlisten();
    pending = null;
  }

  function begin(input: {
    owner: string;
    kind: 'open' | 'close';
    surface?: FilterSurface;
    opener?: HTMLElement | null;
    document: Document;
    resolveDestination?: () => HTMLElement | null;
    surfaceRoot?: HTMLElement | null;
  }) {
    if (input.kind === 'open') lastOpener = input.opener ?? null;
    retire();
    const active = input.document.activeElement instanceof HTMLElement ? input.document.activeElement : null;
    const source = input.kind === 'open' ? (input.opener ?? null) : active;
    const inSurface = Boolean(input.surfaceRoot && active && occupies(input.surfaceRoot, active));
    const alreadyMoved =
      input.kind === 'close' &&
      Boolean(
        lastOpener &&
          active &&
          !occupies(lastOpener, active) &&
          !isDocumentRoot(input.document, active) &&
          !inSurface,
      );
    const request: Request = {
      id: ++nextId,
      owner: input.owner,
      kind: input.kind,
      source,
      destination: input.kind === 'close' ? lastOpener : null,
      document: input.document,
      moved: alreadyMoved,
      onFocusIn(event) {
        const destination = destinationOf(request);
        if (event.target === request.source) return;
        if (destination && occupies(destination, event.target)) return;
        if (isDocumentRoot(request.document, event.target)) return;
        request.moved = true;
      },
      ...(input.surface ? { surface: input.surface } : {}),
      ...(input.kind === 'open' && input.resolveDestination
        ? { resolveDestination: input.resolveDestination }
        : {}),
    };
    request.document.addEventListener('focusin', request.onFocusIn, true);
    pending = request;
    return request.id;
  }

  function restore(id: number, owner: string) {
    const request = pending;
    if (!request || request.id !== id || request.owner !== owner) return false;
    const destination = destinationOf(request);
    if (!destination?.isConnected) return false;
    const active = request.document.activeElement;
    if (
      request.moved ||
      (active !== null &&
        !occupies(destination, active) &&
        !isDocumentRoot(request.document, active) &&
        active !== request.source)
    ) {
      retire();
      return false;
    }
    retire();
    if (!occupies(destination, active)) destination.focus();
    return true;
  }

  function schedule(id: number, owner: string) {
    const request = pending;
    if (!request || request.id !== id) return;
    request.frame = requestAnimationFrame(() => restore(id, owner));
  }

  function restoreOpen(owner: string, surface: FilterSurface) {
    const request = pending;
    if (request?.kind === 'open' && request.surface === surface && request.owner === owner)
      return restore(request.id, owner);
    return false;
  }

  function retireOwner(owner: string) {
    if (pending && pending.owner !== owner) retire();
  }

  return { begin, restore, schedule, restoreOpen, retire, retireOwner };
}

export function useFilterSurfaceFocus(owner: string) {
  const focus = useRef(createFilterSurfaceFocus()).current;
  useEffect(() => () => focus.retire(), [focus]);
  useEffect(() => focus.retireOwner(owner), [focus, owner]);
  return focus;
}
