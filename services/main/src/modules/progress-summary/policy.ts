import type { StatusState } from '../library/status.ts';
import type { SessionState } from '../session/contract.ts';
import { seriesProgress, type CoveragePin } from '../session/series-policy.ts';

/** A Work without composition is one unit. Keep G-835's finish semantics:
 * explicit finishes and Library read count across languages, never Rewrite. */
export function workProgress(resource: string, sessions: SessionState[], coverage: CoveragePin[],
  partial: boolean, library: StatusState[]) {
  const summary = seriesProgress([{ occurrence: resource, work: resource, displayLabel: '',
    inclusion: 'required', available: true }], sessions, coverage, 'und', 'unknown', partial, library);
  const pins = new Map(coverage.map(pin => [`${pin.resource}|${pin.revision}`, pin]));
  const reading = library.some(item => item.work === resource && item.status === 'reading')
    || sessions.some(attempt => ['active', 'paused'].includes(attempt.state)
      && attempt.selections.some(({ target }) => target.base === 'work' || target.base === 'occurrence'
        ? target.work === resource
        : pins.get(`${target.resource}|${target.revision}`)?.entries.some(entry => entry.work === resource)));
  return { policy: summary.policy,
    status: summary.counts.completed ? 'finished' as const : partial ? null
      : reading ? 'reading' as const : 'not-started' as const,
    counts: summary.counts, partial,
    states: { correspondenceUnresolved: summary.states.correspondenceUnresolved } };
}
