import { useState } from 'react';
import { ContinueSection } from '../../library/continue';
import { continueProgress } from '../../library/continue-read';
import type { ContinueEntry, ContinueView } from '../../library/continue-source';
import { LibraryNavigation } from '../../library/library-nav';
import { getLocale } from '../../paraglide/runtime.js';
import { recordedContinueSessions } from '../../kernel/fake/library-continue';

/** Recorded presentation examples; these do not stand in for the absent production caller. */
export const continueExamples: ContinueEntry[] = recordedContinueSessions('en')
  .slice(0, 2)
  .map((session) => ({
    subjectId: session.subjectId,
    label: session.subject.label.value,
    language: session.subject.label.language,
    summary: session.subject,
    progress: continueProgress(session),
  }));

export function ContinueExample({ state, navigation = false }: { state: ContinueView; navigation?: boolean }) {
  const [current, setCurrent] = useState(state);
  const locale = getLocale();
  const sessions = recordedContinueSessions(locale);
  const localized =
    current.state === 'loaded'
      ? {
          ...current,
          entries: current.entries.map((entry) => {
            const progress = entry.progress;
            const session = sessions.find(
              (session) =>
                session.id === progress?.sessionId && session.mode === progress.mode && session.unit === progress.unit,
            );
            if (!session || !progress) return entry;
            return {
              ...entry,
              progress: continueProgress({
                ...progress,
                id: progress.sessionId,
                ...(session.unitLabel === undefined ? {} : { unitLabel: session.unitLabel }),
                ...(session.unitLabelLanguage === undefined ? {} : { unitLabelLanguage: session.unitLabelLanguage }),
                ...(session.unitCountForms === undefined ? {} : { unitCountForms: session.unitCountForms }),
                ...(session.dimension === undefined ? {} : { dimension: session.dimension }),
              }),
            };
          }),
        }
      : current;
  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-8">
      {navigation ? (
        <LibraryNavigation current="continue" pins={{ state: 'closed' }} collections={[]} locale={locale} />
      ) : null}
      <ContinueSection
        state={localized}
        locale={locale}
        onRetry={() => setCurrent({ state: 'loaded', entries: continueExamples, next: null })}
      />
    </div>
  );
}
