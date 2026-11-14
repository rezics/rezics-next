export type StageFocusHandoff = {
  from: string;
  to: string;
  opener: HTMLElement | null;
  activeAtCapture: Element | null;
  interaction: number;
  restoreOpener: boolean;
};

export type StageFocusTracker = {
  interaction: number;
  handoff: StageFocusHandoff | null;
};

export function createStageFocusTracker(): StageFocusTracker {
  return { interaction: 0, handoff: null };
}

export function watchStageFocusMovement(tracker: StageFocusTracker): () => void {
  const moved = (event: Event) => {
    const handoff = tracker.handoff;
    if (!handoff) return;
    if (event.type === 'focusin') {
      if (handoff.opener && event.target instanceof Node && handoff.opener.contains(event.target)) return;
      if (
        !canFocus(handoff.opener) &&
        (event.target === document.body || event.target === document.documentElement)
      ) {
        return;
      }
    }
    tracker.interaction += 1;
  };
  document.addEventListener('focusin', moved, true);
  document.addEventListener('pointerdown', moved, true);
  document.addEventListener('keydown', moved, true);
  document.addEventListener('visibilitychange', moved, true);
  window.addEventListener('blur', moved, true);
  return () => {
    document.removeEventListener('focusin', moved, true);
    document.removeEventListener('pointerdown', moved, true);
    document.removeEventListener('keydown', moved, true);
    document.removeEventListener('visibilitychange', moved, true);
    window.removeEventListener('blur', moved, true);
  };
}

export function captureStageFocusHandoff(
  tracker: StageFocusTracker,
  from: string,
  to: string,
  opener: HTMLElement | null,
  restoreOpener = true,
): void {
  tracker.handoff = {
    from,
    to,
    opener,
    activeAtCapture: document.activeElement,
    interaction: tracker.interaction,
    restoreOpener,
  };
}

function canFocus(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected || element.closest('[hidden], [aria-hidden="true"]')) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

export function consumeStageFocusHandoff(
  tracker: StageFocusTracker,
  stage: string,
  target: HTMLElement | null,
  current: () => boolean,
): void {
  const handoff = tracker.handoff;
  if (!handoff || handoff.to !== stage) return;
  tracker.handoff = null;
  if (!current() || handoff.interaction !== tracker.interaction || !canFocus(target)) return;

  const active = document.activeElement;
  const openerUnavailable = !canFocus(handoff.opener) && active === document.body;
  const focusStayedWithAction =
    active === handoff.opener || active === handoff.activeAtCapture || openerUnavailable;
  if (!focusStayedWithAction) return;

  const focusTarget = handoff.restoreOpener && canFocus(handoff.opener) ? handoff.opener : target;
  focusTarget.focus();
}
