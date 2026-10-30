import { useState } from 'react';
import { ContinueSection } from '../../library/continue';
import { continueProgress } from '../../library/continue-read';
import type { ContinueEntry, ContinueView } from '../../library/continue-source';
import { LibraryNavigation } from '../../library/library-nav';
import { getLocale } from '../../paraglide/runtime.js';
import sessions from '../../kernel/recorded/library-continue-progress-sessions.json';

/** Recorded presentation examples; these do not stand in for the absent production caller. */
export const continueExamples: ContinueEntry[] = sessions.progressSessions.slice(0, 2).map((session) => ({
  subjectId: session.subjectId,
  label: session.subject.label.value,
  language: session.subject.label.language,
  summary: session.subject,
  progress: (() => {
    const mode = session.mode;
    if (mode !== 'scalar_amount' && mode !== 'cursor_position' && mode !== 'completed_units') throw new Error('Unrecognized recorded progress mode');
    return continueProgress({ ...session, mode });
  })(),
}));

export function ContinueExample({ state, navigation = false }: { state: ContinueView; navigation?: boolean }) {
  const [current, setCurrent] = useState(state);
  const locale = getLocale();
  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-8">
      {navigation ? <LibraryNavigation current="continue" pins={{ state: 'closed' }} collections={[]} locale={locale} /> : null}
      <ContinueSection
        state={current}
        locale={locale}
        onRetry={() => setCurrent({ state: 'loaded', entries: continueExamples, next: null })}
      />
    </div>
  );
}
