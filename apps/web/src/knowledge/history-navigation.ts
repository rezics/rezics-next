/** Coordinates only. Admitted metadata and comparison bodies stay in the mounted panel. */
export type KnowledgeHistoryNavigation = Readonly<{
  cursor: string | null;
  previous: readonly (string | null)[];
  truncated: boolean;
}>;

const CURSOR_WINDOW = 20;

export function firstKnowledgeHistoryPage(): KnowledgeHistoryNavigation {
  return { cursor: null, previous: [], truncated: false };
}

export function nextKnowledgeHistoryPage(
  navigation: KnowledgeHistoryNavigation,
  cursor: string,
): KnowledgeHistoryNavigation {
  const previous = [...navigation.previous, navigation.cursor];
  return {
    cursor,
    previous: previous.slice(-CURSOR_WINDOW),
    truncated: navigation.truncated || previous.length > CURSOR_WINDOW,
  };
}

/** The caller offers Previous only for a successfully admitted page with a retained predecessor. */
export function previousKnowledgeHistoryPage(navigation: KnowledgeHistoryNavigation): KnowledgeHistoryNavigation {
  return {
    cursor: navigation.previous[navigation.previous.length - 1]!,
    previous: navigation.previous.slice(0, -1),
    truncated: navigation.truncated,
  };
}

/** Commit only after a successful read; reserve space for the current request and native continuation. */
export function retainKnowledgeHistoryNavigation(
  request: KnowledgeHistoryNavigation,
  next: string | null,
): KnowledgeHistoryNavigation {
  let remaining = CURSOR_WINDOW - Number(request.cursor !== null) - Number(next !== null);
  let start = request.previous.length;
  while (start > 0 && request.previous.length - start < CURSOR_WINDOW) {
    const cursor = request.previous[start - 1];
    if (cursor !== null && !remaining) break;
    if (cursor !== null) remaining--;
    start--;
  }
  return {
    cursor: request.cursor,
    previous: request.previous.slice(start),
    truncated: request.truncated || start > 0,
  };
}

/** One keyboard action's focus request; it holds no reading data and starts no scheduled work. */
export function createKnowledgeHistoryFocus() {
  let pending: { source: HTMLElement; current: () => boolean; cleanup: () => void } | null = null;
  function cancel() {
    pending?.cleanup();
    pending = null;
  }
  function lostSource(source: HTMLElement) {
    return !source.isConnected || source.matches(':disabled') || source.closest('[hidden]') !== null;
  }
  return {
    cancel,
    request(source: HTMLElement, keyboard: boolean, current: () => boolean) {
      cancel();
      const document = source.ownerDocument;
      if (!keyboard || !current() || document.activeElement !== source) return;
      const moved = (event: FocusEvent) => {
        if (event.target === source || (event.target === document.body && lostSource(source))) return;
        cancel();
      };
      const hidden = () => {
        if (document.hidden) cancel();
      };
      document.addEventListener('focusin', moved, true);
      document.addEventListener('pointerdown', cancel, true);
      document.addEventListener('pointermove', cancel, true);
      document.addEventListener('keydown', cancel, true);
      document.addEventListener('wheel', cancel, true);
      document.addEventListener('visibilitychange', hidden);
      document.defaultView?.addEventListener('blur', cancel);
      document.defaultView?.addEventListener('pagehide', cancel);
      pending = {
        source,
        current,
        cleanup() {
          document.removeEventListener('focusin', moved, true);
          document.removeEventListener('pointerdown', cancel, true);
          document.removeEventListener('pointermove', cancel, true);
          document.removeEventListener('keydown', cancel, true);
          document.removeEventListener('wheel', cancel, true);
          document.removeEventListener('visibilitychange', hidden);
          document.defaultView?.removeEventListener('blur', cancel);
          document.defaultView?.removeEventListener('pagehide', cancel);
        },
      };
    },
    arrive(target: HTMLElement | null) {
      const request = pending;
      if (!request) return;
      const document = request.source.ownerDocument;
      const active = document.activeElement;
      const stayed = active === request.source || (active === document.body && lostSource(request.source));
      cancel();
      if (request.current() && stayed && target?.isConnected && !target.closest('[hidden]')) target.focus();
    },
  };
}
