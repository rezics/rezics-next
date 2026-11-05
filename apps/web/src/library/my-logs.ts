import { BookOpenText } from 'lucide-react';
import { m } from '../paraglide/messages.js';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { createNavigation } from '../shell/navigation';
import type { PublishedLogPage } from './logs-read';

export class PublishedLogListError extends Error {
  constructor(readonly state: 'denied' | 'preparing' | 'unavailable') {
    super(`Published logs ${state}`);
  }
}

export type MyLogsPage =
  | { state: 'loaded'; logs: PublishedLogPage['logs']; next: string | null; restarted: boolean }
  | { state: 'signed-out' | 'denied' | 'preparing' | 'unavailable' | 'invalid-position' };

/** The cursor is opaque; only the native reader interprets its keyset and epoch. */
export function myLogsSearch(input: Record<string, unknown>): { cursor?: string; invalidPosition?: true } {
  if (input.cursor === undefined) return {};
  if (typeof input.cursor !== 'string' || input.cursor.length === 0 || input.cursor.length > 4096)
    return { invalidPosition: true };
  return { cursor: input.cursor };
}

/** Server and native-reader inputs use the same bounded admission as the route. */
export function requireMyLogsSearch(input: unknown): { cursor?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid published log cursor');
  const search = myLogsSearch(input as Record<string, unknown>);
  if (search.invalidPosition) throw new Error('Invalid published log cursor');
  return search.cursor === undefined ? {} : { cursor: search.cursor };
}

/** Keep unsuccessful reads distinct from a successful empty owner page. */
export async function myLogsResult(read: () => Promise<PublishedLogPage>): Promise<MyLogsPage> {
  try {
    const page = await read();
    return page.signedIn
      ? { state: 'loaded', logs: page.logs, next: page.next, restarted: page.restarted === true }
      : { state: 'signed-out' };
  } catch (error) {
    return {
      state:
        error instanceof PublishedLogListError ? error.state : isPlatformClosedError(error) ? 'denied' : 'unavailable',
    };
  }
}

export const myLogsNavigation = createNavigation([
  {
    id: 'library.published-logs',
    kind: 'navigation',
    group: 'personal',
    order: 14,
    label: ({ locale }) => m.library_my_logs_heading({}, { locale }),
    href: '/library/logs',
    match: 'exact',
    signedIn: true,
    operation: 'published_log.list',
    icon: BookOpenText,
  },
]);
