import type { ReporterHistoryQuery } from './model';

const operandsKey = (query: ReporterHistoryQuery) => JSON.stringify([query.cursor ?? null, query.reportId ?? null]);

/** A single keyboard activation survives a replacing route; it retains no report payload or authority. */
export function createReporterHistoryFocus() {
  let request:
    | {
        source: HTMLElement;
        current: () => boolean;
        operands?: string;
        cleanup: () => void;
      }
    | undefined;
  const cancel = () => {
    request?.cleanup();
    request = undefined;
  };
  return {
    cancel,
    pending: () => request !== undefined,
    activate(source: HTMLElement, current: () => boolean) {
      cancel();
      const document = source.ownerDocument;
      if (document.activeElement !== source || !current()) return;
      const focusMoved = (event: FocusEvent) => {
        if (event.target === source || (event.target === document.body && !source.isConnected)) return;
        cancel();
      };
      const tabbed = (event: KeyboardEvent) => {
        if (event.key === 'Tab' || event.key === 'Escape') cancel();
      };
      const hidden = () => {
        if (document.hidden) cancel();
      };
      document.addEventListener('focusin', focusMoved, true);
      document.addEventListener('pointerdown', cancel, true);
      document.addEventListener('keydown', tabbed, true);
      document.addEventListener('visibilitychange', hidden);
      document.defaultView?.addEventListener('blur', cancel);
      request = {
        source,
        current,
        cleanup() {
          document.removeEventListener('focusin', focusMoved, true);
          document.removeEventListener('pointerdown', cancel, true);
          document.removeEventListener('keydown', tabbed, true);
          document.removeEventListener('visibilitychange', hidden);
          document.defaultView?.removeEventListener('blur', cancel);
        },
      };
    },
    request(query: ReporterHistoryQuery) {
      if (request) request.operands = `history:${operandsKey(query)}`;
    },
    requestStatus(reportId: string) {
      if (request) request.operands = `status:${reportId}`;
    },
    navigatingStatus(reportId: string) {
      if (request && request.operands !== `status:${reportId}`) cancel();
    },
    arriveStatus(root: HTMLElement, reportId: string, current: () => boolean) {
      const activation = request;
      if (!activation) return;
      // A retiring status render must leave the ticket for its history destination alone.
      if (activation.operands !== `status:${reportId}`) return;
      if (!activation.current() || !current()) return cancel();
      const document = root.ownerDocument;
      if (document.activeElement !== activation.source && document.activeElement !== document.body) return cancel();
      cancel();
      root.querySelector<HTMLElement>('#reporter-status-heading')?.focus();
    },
    navigating(query: ReporterHistoryQuery | null) {
      if (request && (!query || request.operands !== `history:${operandsKey(query)}`)) cancel();
    },
    arrive(root: HTMLElement, query: ReporterHistoryQuery, current: () => boolean) {
      const activation = request;
      if (!activation) return;
      if (activation.operands !== `history:${operandsKey(query)}`) return;
      if (!activation.current() || !current()) return cancel();
      const document = root.ownerDocument;
      if (document.activeElement !== activation.source && document.activeElement !== document.body) return cancel();
      // Exact native selection may accompany a bounded page. Only its actual selected control receives focus.
      const selected = query.reportId
        ? [...root.querySelectorAll<HTMLButtonElement>('button[data-report-id][aria-pressed="true"]')].find(
            (button) => button.dataset.reportId === query.reportId,
          )
        : undefined;
      const target = selected ?? root.querySelector<HTMLElement>('#reporter-history-heading');
      cancel();
      target?.focus();
    },
  };
}
export type ReporterHistoryFocus = ReturnType<typeof createReporterHistoryFocus>;

// This is only the current navigation's focus ticket; private data stays with each route reader.
const visits = new WeakMap<object, ReporterHistoryFocus>();
export function reporterHistoryFocusFor(router: object): ReporterHistoryFocus {
  let focus = visits.get(router);
  if (!focus) {
    focus = createReporterHistoryFocus();
    visits.set(router, focus);
  }
  return focus;
}
