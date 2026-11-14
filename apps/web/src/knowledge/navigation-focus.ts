import { useLayoutEffect, useRef, useState, type MouseEvent } from 'react';

/** One deliberate keyboard action owns orientation until the reader does something else. */
export class KnowledgeNavigationFocus {
  private pending: { origin: HTMLElement; stop: () => void } | undefined;

  request(origin: HTMLElement, keyboard: boolean) {
    this.cancel();
    const document = origin.ownerDocument;
    if (!keyboard || document.activeElement !== origin) return false;
    const cancel = () => this.cancel();
    const moved = (event: FocusEvent) => {
      if (event.target !== origin) this.cancel();
    };
    document.addEventListener('focusin', moved, true);
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', cancel, true);
    document.defaultView?.addEventListener('blur', cancel);
    this.pending = {
      origin,
      stop: () => {
        document.removeEventListener('focusin', moved, true);
        document.removeEventListener('pointerdown', cancel, true);
        document.removeEventListener('keydown', cancel, true);
        document.defaultView?.removeEventListener('blur', cancel);
      },
    };
    return true;
  }

  arrive(target: HTMLElement | null) {
    const pending = this.pending;
    this.cancel();
    if (!pending || !target?.isConnected) return;
    const document = pending.origin.ownerDocument;
    if (target.ownerDocument !== document) return;
    // Removing the initiating control during a replacing read leaves focus on the body.
    if (document.activeElement === pending.origin || document.activeElement === document.body)
      target.focus({ preventScroll: true });
  }

  cancel() {
    this.pending?.stop();
    this.pending = undefined;
  }
}

export type KnowledgeNavigationFocusReturn = Readonly<{
  orientation?: KnowledgeNavigationFocus;
  documentId?: string;
  placementId?: string;
}>;

type ReadingSnapshot = Readonly<{ state: string; frontier: Readonly<{ request: object }> }>;

/** Share focus ownership between the inventory, plain outline and organization-enabled outline. */
export function useKnowledgeNavigationOrientation<Snapshot extends ReadingSnapshot>(
  snapshot: Snapshot,
  getSnapshot: () => Snapshot,
  {
    embedded = false,
    restored,
    selectedDocumentId,
  }: {
    embedded?: boolean | undefined;
    restored?: KnowledgeNavigationFocusReturn | undefined;
    selectedDocumentId?: string | undefined;
  } = {},
) {
  const boundary = useRef<HTMLElement>(null);
  const selected = useRef<HTMLAnchorElement>(null);
  const [orientation] = useState(() => restored?.orientation ?? new KnowledgeNavigationFocus());
  const requested = useRef<{ snapshot: Snapshot; returning: boolean } | undefined>(
    restored?.orientation ? { snapshot, returning: true } : undefined,
  );
  const owner = useRef({ getSnapshot, embedded, selectedDocumentId });
  const generation = useRef(0);
  useLayoutEffect(() => {
    const lifetime = ++generation.current;
    return () => {
      // StrictMode immediately reattaches the same owner; a real departure cancels the transferred request.
      queueMicrotask(() => {
        if (generation.current === lifetime) orientation.cancel();
      });
    };
  }, [orientation]);
  useLayoutEffect(() => {
    const previous = owner.current;
    owner.current = { getSnapshot, embedded, selectedDocumentId };
    if (
      previous.getSnapshot !== getSnapshot ||
      previous.embedded !== embedded ||
      previous.selectedDocumentId !== selectedDocumentId
    ) {
      requested.current = undefined;
      orientation.cancel();
    }
    const pending = requested.current;
    if (!pending) return;
    if (embedded || snapshot.state === 'retired' || snapshot !== getSnapshot()) {
      requested.current = undefined;
      orientation.cancel();
      return;
    }
    if (
      snapshot.state === 'preparing' &&
      (snapshot === pending.snapshot ||
        (pending.returning && snapshot.frontier.request === pending.snapshot.frontier.request))
    ) {
      pending.snapshot = snapshot;
      return;
    }
    requested.current = undefined;
    if (snapshot.state === 'preparing' || snapshot.frontier.request !== pending.snapshot.frontier.request) {
      orientation.cancel();
      return;
    }
    orientation.arrive(
      pending.returning && snapshot.state === 'ready' ? (selected.current ?? boundary.current) : boundary.current,
    );
  }, [snapshot, getSnapshot, embedded, selectedDocumentId, orientation]);

  const activate = (event: MouseEvent<HTMLElement>, action: () => void) => {
    requested.current = undefined;
    orientation.cancel();
    if (snapshot !== getSnapshot()) return;
    const orient = orientation.request(event.currentTarget, !embedded && event.detail === 0);
    action();
    const started = getSnapshot();
    if (orient && started !== snapshot && started.state === 'preparing')
      requested.current = { snapshot: started, returning: false };
    else orientation.cancel();
  };
  return { boundary, selected, activate };
}
