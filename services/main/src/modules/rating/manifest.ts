import { readComponentState, RevisionCorrupt } from '../work/history.ts';
import { DAILY_CONTEXT_PROFILE, DAILY_OBSERVATION_PROFILE } from './calendar.ts';

/** Profiles are explicit and finite; never accept an arbitrary retained model. */
export function readRatingManifest(directory: string, manifest: string, component: string,
  kind: 'context' | 'observation'): { daily: boolean; state: Record<string, unknown> } {
  try {
    return { daily: false, state: readComponentState(directory, manifest, component,
      `https://rezics.com/definition/realm-standing-rating-${kind}-v1`) };
  } catch (error) {
    if (!(error instanceof RevisionCorrupt)) throw error;
    return { daily: true, state: readComponentState(directory, manifest, component,
      kind === 'context' ? DAILY_CONTEXT_PROFILE : DAILY_OBSERVATION_PROFILE) };
  }
}
