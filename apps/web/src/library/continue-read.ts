import type { KernelClient } from '@rezics/client';
import type { RoutePageLoad } from '../features/pages/route';
import type { SubjectSummary } from '../media/summary';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { readEntryPage } from './entries-read';
import type { ProgressLabelInput } from './progress-label';
import { libraryLabel } from './reads';

/** The Continue row shows at most this many subjects. */
export const CONTINUE_LIMIT = 6;

/** The progress read of one subject's active session: what unit it counts and how far it has come. */
export type ContinueProgress = ProgressLabelInput & {
  sessionId: string;
};

export type ContinueEntry = {
  subjectId: string;
  label: string;
  /** The language of the label when the kernel names it, so a fallback text can carry its own `lang`. */
  language?: string;
  /** The embedded subject, which carries the cover and the types that choose its frame. */
  summary: SubjectSummary;
  progress: ContinueProgress | null;
};

type RawSubject = {
  id: string;
  type: string;
  types?: string[];
  label: Parameters<typeof libraryLabel>[0];
  cover?: NonNullable<SubjectSummary>['cover'];
};

function summaryOf(subject: RawSubject): SubjectSummary {
  return {
    id: subject.id,
    type: subject.type,
    ...(subject.types ? { types: subject.types } : {}),
    label: typeof subject.label === 'object' ? subject.label : null,
    cover: subject.cover ?? null,
  };
}

/** The active session of the subject itself, or null when the read fails or the subject has none. */
export async function readProgress(
  client: KernelClient,
  subjectId: string,
  authorization: string,
): Promise<ContinueProgress | null> {
  try {
    const result = await client.progressSessions.get({
      query: { subjectId, limit: 5 },
      headers: { authorization },
    });
    const session = result.data?.progressSessions.find(
      (item) => item.state === 'active' && item.subjectId === subjectId,
    );
    if (!session) return null;
    return {
      sessionId: session.id,
      mode: session.mode,
      unit: session.unit,
      amount: session.amount,
      total: session.total,
      completedUnitCount: session.completedUnitCount,
      locator: session.locator,
    };
  } catch {
    return null;
  }
}

/**
 * The viewer's subjects in progress, most recently updated first: one library read for a signed-in visitor, none
 * otherwise, then one progress read per subject shown (at most six, whatever the size of the library). A failed
 * library read leaves the row out instead of failing the page; a failed progress read leaves that card without a
 * progress line.
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
    return await Promise.all(
      page.libraryEntries.flatMap((entry) => {
        const subject = entry.subject as RawSubject | null | undefined;
        if (!subject) return [];
        const language = typeof subject.label === 'object' && subject.label ? subject.label.language : undefined;
        return [
          readProgress(client, entry.subjectId, authorization).then((progress): ContinueEntry => ({
            subjectId: entry.subjectId,
            label: libraryLabel(subject.label, entry.subjectId),
            ...(language ? { language } : {}),
            summary: summaryOf(subject),
            progress,
          })),
        ];
      }),
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
