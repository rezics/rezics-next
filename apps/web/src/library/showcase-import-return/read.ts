import type { KernelClient } from '@rezics/client';
import { readEntryPage } from '../entries-read';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import type { SessionEnv } from '../../session/client';
import { prepareExpectedReader, type ExpectedReader } from '../../session/expected-reader';

export type ImportLibraryPage = Awaited<ReturnType<typeof readEntryPage>>;
export type ImportLibraryRead =
  | { state: 'current'; page: ImportLibraryPage }
  | { state: 'denied' | 'closed' | 'unavailable' };

/** One freshly authorized FULL page, never one Subject or Entry request per imported row. */
export async function loadImportLibrary(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  expected: ExpectedReader,
): Promise<ImportLibraryRead> {
  try {
    const authorization = await prepareExpectedReader(request, env, expected);
    if (!authorization) return { state: 'denied' };
    const page = await readEntryPage(client, authorization, undefined, undefined, 8, {
      orderBy: 'lastActivity',
      direction: 'desc',
    });
    if (page.libraryEntries.length > 8) return { state: 'unavailable' };
    return { state: 'current', page };
  } catch (error) {
    return {
      state: isPlatformClosedError(error)
        ? 'closed'
        : error instanceof Error && 'state' in error && error.state === 'denied'
          ? 'denied'
          : 'unavailable',
    };
  }
}
