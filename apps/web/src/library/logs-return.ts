import { myLogsSearch } from './my-logs';

/** Private My Logs frontier carried on this visit's history entry, never a public log URL. */
export type LogsReturnFrontier = {
  locale: string;
  subject: string;
  cursor: string | null;
  logId: string;
};

export const LOGS_RETURN_STATE = 'publishedLogReturn';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function logsListHref(locale: string, cursor: string | null): string | null {
  if (!locale || locale.length > 16 || /[^A-Za-z-]/u.test(locale)) return null;
  if (cursor !== null && myLogsSearch({ cursor }).cursor !== cursor) return null;
  const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return `/${locale}/library/logs${suffix}`;
}

export function logsReturnFrontier(
  locale: string,
  subject: string,
  cursor: string | null,
  logId: string,
): LogsReturnFrontier | null {
  if (!subject || subject.length > 128 || !uuid.test(logId)) return null;
  if (logsListHref(locale, cursor) === null) return null;
  return { locale, subject, cursor, logId };
}

export function logsReturnLocationState(frontier: LogsReturnFrontier) {
  return { [LOGS_RETURN_STATE]: frontier };
}

export function logsReturnFrontierFromState(
  value: unknown,
  locale: string,
  subject: string,
): LogsReturnFrontier | null {
  const raw = record(record(value)?.[LOGS_RETURN_STATE]);
  if (!raw || raw.locale !== locale || raw.subject !== subject) return null;
  if (typeof raw.logId !== 'string' || !uuid.test(raw.logId)) return null;
  if (raw.cursor !== null && raw.cursor !== undefined && typeof raw.cursor !== 'string') return null;
  const cursor = typeof raw.cursor === 'string' ? raw.cursor : null;
  if (cursor !== null && myLogsSearch({ cursor }).cursor !== cursor) return null;
  if (logsListHref(locale, cursor) === null) return null;
  return { locale, subject, cursor, logId: raw.logId };
}

/** Replace only this visit's history entry. The public log URL never receives the private cursor. */
export function captureLogsReturn(frontier: LogsReturnFrontier): LogsReturnFrontier | null {
  if (typeof window === 'undefined') return null;
  const href = logsListHref(frontier.locale, frontier.cursor);
  if (!href) return null;
  try {
    const current = new URL(window.location.href);
    const expected = new URL(href, current.origin);
    if (current.origin !== expected.origin || current.pathname !== expected.pathname) return null;
    const previous = record(window.history.state) ?? {};
    window.history.replaceState({ ...previous, ...logsReturnLocationState(frontier) }, '', current.href);
    return frontier;
  } catch {
    return null;
  }
}

export function readLogsReturn(locale: string, subject: string): LogsReturnFrontier | null {
  if (typeof window === 'undefined') return null;
  return logsReturnFrontierFromState(window.history.state, locale, subject);
}

export function clearLogsReturn(): void {
  if (typeof window === 'undefined') return;
  const previous = record(window.history.state);
  if (!previous || !(LOGS_RETURN_STATE in previous)) return;
  const next = { ...previous };
  delete next[LOGS_RETURN_STATE];
  window.history.replaceState(next, '', window.location.href);
}

export function logsReturnMatchesWindow(frontier: LogsReturnFrontier, cursor: string | null): boolean {
  return frontier.cursor === cursor;
}

type Pointer = {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault: () => void;
};

/** Ordinary left-click only. Modified clicks keep the native destination without a private frontier. */
export function logsDestinationClick(
  event: Pointer,
  admitted: () => boolean,
  frontier: LogsReturnFrontier | null,
): boolean {
  if (!admitted()) {
    event.preventDefault();
    return false;
  }
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return false;
  if (frontier) captureLogsReturn(frontier);
  return true;
}

export function logsReturnTrigger(root: HTMLElement | null, logId: string): HTMLAnchorElement | null {
  if (!root || !uuid.test(logId)) return null;
  return (root as unknown as ParentNode).querySelector(`a[data-published-log="${logId}"]`);
}
