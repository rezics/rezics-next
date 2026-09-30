import type { SessionLocator, SessionState } from './contract.ts';

/** Changing completion meaning requires a new policy version and new fixtures. */
export const SERIES_POLICY = 'composition-progress-v1' as const;
export const SERIES_COST = { parts: 100, maximumParts: 256, sessions: 256,
  releaseCandidates: 256, selectionPins: 4096, sessionSql: 1, availabilityBatches: 1,
  coverageBatches: 1, occurrenceBatches: 1, preferenceSql: 1 } as const;
export interface SeriesPart { occurrence: string; work: string; displayLabel: string;
  inclusion: 'required' | 'optional' | 'extra'; available: boolean }
export interface CoveragePin { resource: string; revision: string; entries: Array<{
  work: string; language: string | null; completeness: 'complete' | 'partial' | 'trial' | 'unknown';
  realization: string | null; revision: string | null }> }

/** Only explicit completion counts. Language/locator percentages and Library
 * ownership never imply a finish; correspondence never changes a Work identity. */
export function seriesProgress(parts: SeriesPart[], sessions: SessionState[], coverage: CoveragePin[],
  language: string, conclusion: 'concluded' | 'ongoing' | 'unknown', partial = false) {
  const pins = new Map(coverage.map(pin => [`${pin.resource}|${pin.revision}`, pin]));
  const works = new Set(parts.map(part => part.work));
  const completed = new Set<string>();
  const boundaries = new Map<string, SessionLocator>();
  let correspondenceUnresolved = false;
  for (const session of sessions) {
    for (const selection of session.selections) {
      const target = selection.target;
      let covered: CoveragePin['entries'] = [];
      if (target.base === 'work') {
        covered = [{ work: target.work!, language: selection.language, completeness: 'complete',
          realization: null, revision: target.revision }];
      } else if (target.base === 'realization' || target.base === 'release') {
        const pin = pins.get(`${target.resource}|${target.revision}`);
        if (!pin) { correspondenceUnresolved = true; continue; }
        covered = pin.entries;
      }
      const relevant = covered.filter(entry => works.has(entry.work));
      if (relevant.some(entry => entry.completeness !== 'complete')) correspondenceUnresolved = true;
      for (const entry of relevant) {
        if (session.state !== 'finished' || entry.completeness !== 'complete'
          || entry.language !== null && entry.language.toLowerCase() !== language.toLowerCase()) continue;
        completed.add(entry.work);
        // An omnibus page/time cannot locate a point inside its last volume.
        // Keep that boundary unknown unless coverage identifies exactly one Work.
        if (new Set(covered.map(item => item.work)).size !== 1) continue;
        const locator = session.locators.find(item => item.target === target.resource);
        const previous = boundaries.get(entry.work);
        if (locator && (!previous || previous.target === locator.target && previous.unit === locator.unit
          && locator.furthest > previous.furthest)) boundaries.set(entry.work, locator);
      }
    }
  }
  const distinct = parts.filter((part, index) => parts.findIndex(other => other.work === part.work) === index);
  // A required use takes precedence over an optional use of the same Work.
  const required = distinct.filter(part => parts.some(use => use.work === part.work && use.inclusion === 'required'));
  const pending = required.filter(part => !completed.has(part.work));
  const available = pending.find(part => part.available);
  const optional = distinct.find(part => part.inclusion !== 'required' && part.available && !completed.has(part.work));
  const next = available ?? pending[0] ?? optional;
  const furthest = [...distinct].reverse().find(part => completed.has(part.work));
  return { policy: SERIES_POLICY, language,
    completedParts: distinct.filter(part => completed.has(part.work)),
    counts: { completed: completed.size, required: required.length,
      completedRequired: required.filter(part => completed.has(part.work)).length },
    states: { caughtUpWithAvailableMaterial: partial ? null : !available,
      finishedPublishedParts: partial ? null : pending.length === 0,
      seriesConcluded: conclusion === 'unknown' ? null : conclusion === 'concluded',
      correspondenceUnresolved },
    next: next ? { part: next, reason: available ? 'next_available_required_part' as const
      : pending.length ? 'awaiting_chosen_language' as const : 'optional_extra' as const } : null,
    furthestCompleted: furthest ? { part: furthest, occurrence: null as { resource: string; revision: string } | null,
      locator: boundaries.get(furthest.work) ?? null } : null,
    partial };
}
