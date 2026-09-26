import { readComponentState, RevisionCorrupt } from '../work/history.ts';
import { DAILY_CONTEXT_PROFILE, DAILY_OBSERVATION_PROFILE } from './calendar.ts';
import { EXPERIENCE_CONTEXT_PROFILE, EXPERIENCE_OBSERVATION_PROFILE } from './experience.ts';

/** Profiles are explicit and finite; never accept an arbitrary retained model. */
export function readRatingManifest(directory: string, manifest: string, component: string,
  kind: 'context' | 'observation'): { daily: boolean; experience: boolean; state: Record<string, unknown> } {
  try {
    return { daily: false, experience: false, state: readComponentState(directory, manifest, component,
      `https://rezics.com/definition/realm-standing-rating-${kind}-v1`) };
  } catch (error) {
    if (!(error instanceof RevisionCorrupt)) throw error;
    try {
      return { daily: true, experience: false, state: readComponentState(directory, manifest, component,
        kind === 'context' ? DAILY_CONTEXT_PROFILE : DAILY_OBSERVATION_PROFILE) };
    } catch (dailyError) {
      if (!(dailyError instanceof RevisionCorrupt)) throw dailyError;
      return { daily: false, experience: true, state: readComponentState(directory, manifest, component,
        kind === 'context' ? EXPERIENCE_CONTEXT_PROFILE : EXPERIENCE_OBSERVATION_PROFILE) };
    }
  }
}
