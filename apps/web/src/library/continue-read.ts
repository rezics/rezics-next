import { queryOptions } from '@tanstack/react-query';
import { createServerOnlyFn } from '@tanstack/react-start';
import type { KernelClient } from '@rezics/client';
import { personalRead } from '../kernel/query';
import type { SubjectSummary } from '../media/summary';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import type { ProgressLabelInput } from './progress-label';
import { libraryLabel } from './reads';
import { libraryEntryStateLabel, readEntryPage } from './entries-read';

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
  stateLabel?: string;
};

type ContinueSubject = {
  subjectId: string;
  state: string | null;
  activeProgressSession: (ProgressLabelInput & { id: string }) | null;
};

type ContinueKernelClient = KernelClient & {
  libraryContinue: {
    get(args: { query: { limit: number }; headers: { authorization: string } }): Promise<{
      data?: { subjects: ContinueSubject[]; next: string | null } | null;
    }>;
  };
  pages: {
    $read: {
      post(args: {
        reads: Record<string, { kind: 'subject'; id: string }>;
        headers: { authorization: string };
      }): Promise<{
        data?: { reads: Record<string, { status: number; body?: { subject?: RawSubject } }> } | null;
      }>;
    };
  };
};

const knownStates = new Set(['planned', 'in_progress', 'completed', 'paused', 'dropped']);

function stateText(state: string | null): string | undefined {
  return state !== null && knownStates.has(state) ? libraryEntryStateLabel(state) : undefined;
}

export function continueProgress(session: (ProgressLabelInput & { id: string }) | null): ContinueProgress | null {
  return session
    ? {
        sessionId: session.id,
        mode: session.mode,
        unit: session.unit,
        amount: session.amount,
        total: session.total,
        completedUnitCount: session.completedUnitCount,
        locator: session.locator,
        ...(session.position === undefined ? {} : { position: session.position }),
      }
    : null;
}

export function homeContinueQuery(locale: string, read: () => Promise<ContinueEntry[]>) {
  return queryOptions({
    ...personalRead,
    enabled: personalRead.enabled,
    queryKey: ['home-continue', locale],
    queryFn: read,
  });
}

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
      position: session.position,
    };
  } catch {
    return null;
  }
}

/** Continue preview: one private list read and one batched subject-header read, with no reads when signed out. */
export async function loadContinue(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
): Promise<ContinueEntry[]> {
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (!authorization) return [];
    const reader = client as ContinueKernelClient;
    const result = await reader.libraryContinue.get({
      query: { limit: CONTINUE_LIMIT },
      headers: { authorization },
    });
    const subjects = (result.data?.subjects ?? []).slice(0, CONTINUE_LIMIT);
    if (subjects.length === 0) return [];
    const reads = Object.fromEntries(
      subjects.map(({ subjectId }) => [`subject:${subjectId}`, { kind: 'subject' as const, id: subjectId }]),
    );
    const page = await reader.pages.$read.post({ reads, headers: { authorization } });
    const results = page.data?.reads ?? {};
    const { release, locale, progressSessionProfile } = await progressProfiles(request);
    return subjects.flatMap((item) => {
      const header = results[`subject:${item.subjectId}`];
      const subject = header?.status === 200 ? header.body?.subject : undefined;
      if (!subject) return [];
      const title = libraryLabel(subject.label, item.subjectId);
      const language = typeof title === 'object' ? title.language : undefined;
      const progress = continueProgress(item.activeProgressSession);
      const label = stateText(item.state);
      return [
        {
          subjectId: item.subjectId,
          label: typeof title === 'string' ? title : title.value,
          ...(language ? { language } : {}),
          summary: summaryOf(subject),
          progress:
            progress && release
              ? { ...progress, ...progressSessionProfile(release, subject.type, progress.mode, progress.unit, locale) }
              : progress,
          ...(label ? { stateLabel: label } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

/** The compatibility path for kernels that have not exposed the Continue operation yet. */
export async function loadLegacyContinue(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
): Promise<ContinueEntry[]> {
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (!authorization) return [];
    const page = await readEntryPage(client, authorization, undefined, 'in_progress', CONTINUE_LIMIT);
    const { release, locale, progressSessionProfile } = await progressProfiles(request);
    return await Promise.all(
      page.libraryEntries.flatMap((entry) => {
        const subject = entry.subject as RawSubject | null | undefined;
        if (!subject) return [];
        const label = libraryLabel(subject.label, entry.subjectId);
        const language = typeof label === 'object' ? label.language : undefined;
        const stateLabel = stateText(entry.state);
        return [
          readProgress(client, entry.subjectId, authorization).then((progress): ContinueEntry => ({
            subjectId: entry.subjectId,
            label: typeof label === 'string' ? label : label.value,
            ...(language ? { language } : {}),
            summary: summaryOf(subject),
            progress:
              progress && release
                ? {
                    ...progress,
                    ...progressSessionProfile(release, subject.type, progress.mode, progress.unit, locale),
                  }
                : progress,
            ...(stateLabel ? { stateLabel } : {}),
          })),
        ];
      }),
    );
  } catch {
    return [];
  }
}

const progressProfiles = createServerOnlyFn(async (request: Request) => {
  const release = await import('../subject/definitions')
    .then(({ readRelease }) => readRelease())
    .catch(() => undefined);
  const locale = (await import('../kernel/client')).requestLocale(request) ?? 'en';
  const { progressSessionProfile } = await import('./progress-profile');
  return { release, locale, progressSessionProfile };
});
