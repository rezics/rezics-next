import type { KernelClient } from '@rezics/client';
import { readEntryPage } from '../entries-read';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import type { SessionEnv } from '../../session/client';
import { prepareExpectedReader, type ExpectedReader } from '../../session/expected-reader';
import { sessionSubject } from '../../session/request';
import { shelfCursor } from '../shelf-params';
import { StaleCursorError } from '../reads';
import type { ImportLibraryLabels } from './presentation';

export type ImportLibraryPage = Awaited<ReturnType<typeof readEntryPage>>;
export type ImportLibraryRead =
  | { state: 'current'; page: ImportLibraryPage; labels?: ImportLibraryLabels[] }
  | { state: 'denied' | 'closed' | 'unavailable' | 'signed-out' | 'expired' };

export type ImportLibraryRequest = ExpectedReader & { cursor?: string };

/** A native cursor is an opaque address, never an import offset or a Subject identity. */
export function validImportLibraryCursor(value: unknown): value is string | undefined {
  return value === undefined || shelfCursor(value) !== undefined;
}

/** One freshly authorized FULL page, never one Subject or Entry request per imported row. */
export async function loadImportLibrary(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  expected: ExpectedReader,
  cursor?: string,
): Promise<ImportLibraryRead> {
  if (!validImportLibraryCursor(cursor)) return { state: 'unavailable' };
  try {
    const authorization = await prepareExpectedReader(request, env, expected);
    if (!authorization) return { state: sessionSubject(request) ? 'denied' : 'signed-out' };
    const page = await readEntryPage(client, authorization, cursor, undefined, 8, {
      orderBy: 'lastActivity',
      direction: 'desc',
    });
    if (page.libraryEntries.length > 8 || (page.next !== null && !shelfCursor(page.next)))
      return { state: 'unavailable' };
    return { state: 'current', page };
  } catch (error) {
    return {
      state: error instanceof StaleCursorError
        ? 'expired'
        : isPlatformClosedError(error)
        ? 'closed'
        : error instanceof Error && 'state' in error && error.state === 'denied'
          ? 'denied'
          : 'unavailable',
    };
  }
}
