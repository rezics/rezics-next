import type { StatusState } from '../library/status.ts';
import type { SessionState } from '../session/contract.ts';
import { seriesProgress, type CoveragePin } from '../session/series-policy.ts';
import type { WorkStanding } from '../progress/work-standing.ts';

/** A Work without composition is one unit. Keep the finish rule: explicit
 * finishes and Library read count across languages, never Rewrite. A whole-Work
 * mark counts the same way. An unfinished page of attempts stays unknown,
 * except a finish already in hand. Dropped is only the mark, and only when
 * nothing already says this Work is being read or is finished. */
export function workProgress(resource: string, sessions: SessionState[], coverage: CoveragePin[],
  partial: boolean, library: StatusState[], standing: WorkStanding | null = null) {
  const summary = seriesProgress([{ occurrence: resource, work: resource, displayLabel: '',
    inclusion: 'required', available: true }], sessions, coverage, 'und', 'unknown', partial, library);
  const pins = new Map(coverage.map(pin => [`${pin.resource}|${pin.revision}`, pin]));
  const reading = standing === 'started'
    || library.some(item => item.work === resource && item.status === 'reading')
    || sessions.some(attempt => ['active', 'paused'].includes(attempt.state)
      && attempt.selections.some(({ target }) => target.base === 'work' || target.base === 'occurrence'
        ? target.work === resource
        : pins.get(`${target.resource}|${target.revision}`)?.entries.some(entry => entry.work === resource)));
  const finished = summary.counts.completed > 0 || standing === 'completed';
  return { policy: summary.policy,
    status: finished ? 'finished' as const : partial ? null
      : reading ? 'reading' as const : standing === 'dropped' ? 'dropped' as const : 'not-started' as const,
    counts: { completed: finished ? 1 : 0, required: 1 as const, completedRequired: finished ? 1 : 0 },
    partial,
    states: { correspondenceUnresolved: summary.states.correspondenceUnresolved } };
}
