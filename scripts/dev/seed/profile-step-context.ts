import { profileSteps } from './profiles.ts';
import type { SeedState } from './state.ts';

/** The four ordered profile phases share the same resolved public Work ids. */
export function profileOperations(state: SeedState) {
  return profileSteps(state.api, state.sessions[0]!, state.sessions, state.penAgents,
    new Map([...state.created].map(([id, receipt]) => [id, receipt.work])));
}
