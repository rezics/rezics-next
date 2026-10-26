import type { KernelClient } from '@rezics/client';
import type { RoutePageLoad } from '../features/pages/route';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { readEntryPage } from './entries-read';

/** The Continue row shows at most this many subjects. */
export const CONTINUE_LIMIT = 6;

export type ContinueEntry = { subjectId: string; label: string };

/**
 * The viewer's subjects in progress, most recently updated first: one library read for a signed-in visitor, none
 * otherwise. Any failure leaves the row out instead of failing the page.
 */
export async function loadContinue(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
): Promise<ContinueEntry[]> {
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (!authorization) return [];
    const page = await readEntryPage(client, authorization, undefined, 'in_progress', CONTINUE_LIMIT);
    return page.libraryEntries.flatMap((entry) =>
      entry.subject ? [{ subjectId: entry.subjectId, label: entry.subject.label }] : [],
    );
  } catch {
    return [];
  }
}

/** The home page read and the library read start together. */
export async function loadHome(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  readPage: () => Promise<RoutePageLoad>,
): Promise<{ page: RoutePageLoad; continue: ContinueEntry[] }> {
  const [page, resume] = await Promise.all([readPage(), loadContinue(client, request, sessionEnv)]);
  return { page, continue: resume };
}
