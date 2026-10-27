import type { PublishedLogPage } from './logs-read';
import type { ProgressIndex, ProgressSessionPage } from './progress-reads';
import type { LibrarySubject } from './reads';

/** Reuse summaries already on this page, preferring the session's summary when both reads carry a cover. */
export function progressSubjects(
  progress: ProgressSessionPage,
  logs: PublishedLogPage,
): { progress: ProgressSessionPage; logs: PublishedLogPage } {
  if (!progress.signedIn) return { progress, logs };
  const subjects = [progress.session.subject, progress.session.versionSubject, ...logs.logs.map((log) => log.subject)];
  const resolve = coverResolver(subjects);
  return {
    progress: {
      ...progress,
      session: {
        ...progress.session,
        subject: resolve(progress.session.subject, progress.session.subjectId),
        versionSubject: resolve(progress.session.versionSubject, progress.session.versionSubjectId),
      },
    },
    logs: { ...logs, logs: logs.logs.map((log) => ({ ...log, subject: resolve(log.subject) })) },
  };
}

/** One summary per subject across a page, preferring the first read that carries a cover. */
function coverResolver(subjects: readonly (LibrarySubject | null)[]) {
  const summaries = new Map<string, LibrarySubject>();
  for (const subject of subjects)
    if (subject && (!summaries.has(subject.id) || (!summaries.get(subject.id)?.cover && subject.cover)))
      summaries.set(subject.id, subject);
  return (subject: LibrarySubject | null, id?: string | null) => {
    const summary = summaries.get(subject?.id ?? id ?? '');
    if (!subject) return summary ?? null;
    const typeLabel = subject?.typeLabel ?? summary?.typeLabel;
    return summary
      ? { ...subject, cover: summary.cover, types: summary.types, ...(typeLabel ? { typeLabel } : {}) }
      : subject;
  };
}

export function progressIndexSubjects(sessions: ProgressIndex['sessions']): ProgressIndex['sessions'] {
  const resolve = coverResolver(sessions.flatMap((session) => [session.subject, session.versionSubject]));
  return sessions.map((session) => ({
    ...session,
    subject: resolve(session.subject, session.subjectId),
    versionSubject: resolve(session.versionSubject, session.versionSubjectId),
  }));
}
