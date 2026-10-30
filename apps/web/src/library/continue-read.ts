import { queryOptions } from '@tanstack/react-query';
import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import type { KernelClient } from '@rezics/client';
import { personalRead } from '../kernel/query';
import type { SubjectSummary } from '../media/summary';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import type { ProgressLabelInput } from './progress-label';
import { libraryLabel } from './reads';
import { libraryStateLabel } from './profiles';
import type { Release } from '../subject/definitions';

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

function stateText(
  release: Release | undefined,
  type: string,
  state: string | null,
  locale: string,
): string | undefined {
  if (!release || state === null) return undefined;
  return libraryStateLabel(release, type, state, locale)?.text;
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

const readLibraryContinuePage = createServerFn({ method: 'GET' }).handler(async () => {
  const { env } = await import('cloudflare:workers');
  const { kernelClient } = await import('../kernel/client');
  setResponseHeader('Cache-Control', 'private, no-store');
  return loadContinue(kernelClient(), getRequest(), env as Partial<SessionEnv>);
});

/** The Library's Continue row reads the same bounded, private API page as Home. */
export const readContinueEntries = readLibraryContinuePage;

/** Continue is one bounded, private read, started only after the browser confirms operation exposure. */
export function libraryContinueQuery(locale: string) {
  return queryOptions({
    ...personalRead,
    enabled: personalRead.enabled,
    queryKey: ['library-continue', locale],
    queryFn: () => readLibraryContinuePage(),
    retry: false,
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

/** Continue preview: one private list read and one batched subject-header read, with no reads when signed out. */
export async function loadContinue(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
): Promise<ContinueEntry[]> {
  try {
    await prepareSession(request, sessionEnv, { refresh: false });
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
      const label = stateText(release, subject.type, item.state, locale);
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

const progressProfiles = createServerOnlyFn(async (request: Request) => {
  const release = await import('../subject/definitions')
    .then(({ readRelease }) => readRelease())
    .catch(() => undefined);
  const locale = (await import('../kernel/client')).requestLocale(request) ?? 'en';
  const { progressSessionProfile } = await import('./progress-profile');
  return { release, locale, progressSessionProfile };
});
