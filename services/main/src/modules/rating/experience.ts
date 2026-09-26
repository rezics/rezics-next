import { GRAPHS, RV, hash, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { readComponentState } from '../work/history.ts';
import { RatingObservationUnavailable } from './observation.ts';

export const EXPERIENCE_CONTEXT_ID = 'realm-experience-rating-context-v1';
export const EXPERIENCE_OBSERVATION_ID = 'realm-experience-rating-observation-v1';
export const EXPERIENCE_CONTEXT_PROFILE = `https://rezics.com/definition/${EXPERIENCE_CONTEXT_ID}`;
export const EXPERIENCE_OBSERVATION_PROFILE = `https://rezics.com/definition/${EXPERIENCE_OBSERVATION_ID}`;
export const EXPERIENCE_CADENCE = 'https://rezics.com/definition/rating-experience-v1';
export const OCCASION_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
export const validOccasion = (value: unknown): value is string =>
  typeof value === 'string' && new RegExp(OCCASION_PATTERN).test(value);

export function experienceRatingIdentity(principalId: string, context: string,
  mainVersion: string, occasion: string): { slot: string; occasionKey: string } {
  if (!/^[0-9a-f-]{36}$/.test(principalId) || !validOccasion(occasion)
    || ![context, mainVersion].every(value => /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(value))) {
    throw new RatingObservationUnavailable('invalid experience identity');
  }
  const digest = hash(JSON.stringify({ principalId, context, mainVersion,
    cadence: EXPERIENCE_CADENCE, occasion }));
  return { slot: `urn:rezics:rating-slot:${digest}`,
    occasionKey: `urn:rezics:rating-occasion:${digest}` };
}

/** Exact indexed keys only. Callers still bind the returned marker to their active principal. */
export async function readExperienceRevision(env: WorkActivationEnvironment,
  observation: string, revision: string): Promise<{ occasion: string; occasionKey: string }> {
  const found = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest ?occasion ?slot WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(observation)} a rv:ExperienceRatingObservation ;
      rv:ratingOccasion ?occasion ; rv:ratingSlot ?slot . }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:ExperienceRatingObservationRevision ;
      rv:component ${iri(observation)} ; rv:observation ${iri(observation)} ;
      rv:modelRevision ${iri(EXPERIENCE_OBSERVATION_PROFILE)} ; rv:manifest ?manifest ;
      rv:ratingOccasion ?occasion . }
  } LIMIT 2`);
  const rows = found.results?.bindings ?? [], row = rows[0];
  if (rows.length !== 1 || !row?.manifest || !row.occasion || !row.slot) {
    throw new RatingObservationUnavailable('experience revision is unavailable');
  }
  const state = readComponentState(env.objectDirectory, row.manifest.value,
    observation, EXPERIENCE_OBSERVATION_PROFILE);
  if (state.observation !== observation || state.revision !== revision
    || state.slot !== row.slot.value || state.occasionKey !== row.occasion.value
    || !validOccasion(state.occasion)) {
    throw new RatingObservationUnavailable('experience revision identity differs');
  }
  return { occasion: state.occasion, occasionKey: row.occasion.value };
}
