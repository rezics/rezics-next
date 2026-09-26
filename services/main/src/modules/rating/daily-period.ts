import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { readComponentState } from '../work/history.ts';
import { DAILY_CADENCE, DAILY_CONTEXT_PROFILE, DAILY_OBSERVATION_PROFILE, ISO_CALENDAR,
  ratingDayPeriod, retainedRatingPeriod, type RatingPeriod } from './calendar.ts';
import { sameRatingInstant, RatingObservationUnavailable } from './observation.ts';

export async function readDailyRevisionPeriod(env: WorkActivationEnvironment,
  observation: string, revision: string): Promise<RatingPeriod> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?manifest ?day ?timeZone ?periodStart ?periodEnd WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)}
        a rv:DailyRatingObservationRevision ; rv:component ${iri(observation)} ;
        rv:modelRevision ${iri(DAILY_OBSERVATION_PROFILE)} ; rv:manifest ?manifest ;
        rv:ratingDay ?day ; rv:ratingTimeZone ?timeZone ; rv:ratingCalendar ${iri(ISO_CALENDAR)} ;
        rv:periodStart ?periodStart ; rv:periodEnd ?periodEnd . }
      GRAPH ${iri(GRAPHS.current)} { ${iri(observation)} a rv:DailyRatingObservation ;
        rv:ratingDay ?day ; rv:ratingTimeZone ?timeZone ; rv:ratingCalendar ${iri(ISO_CALENDAR)} ;
        rv:periodStart ?periodStart ; rv:periodEnd ?periodEnd . }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.manifest) {
    throw new RatingObservationUnavailable('daily revision period is unavailable');
  }
  const row = rows[0];
  const state = readComponentState(env.objectDirectory, row.manifest!.value,
    observation, DAILY_OBSERVATION_PROFILE);
  const period = retainedRatingPeriod(state);
  if (state.observation !== observation || state.revision !== revision
    || period.day !== row.day?.value || period.timeZone !== row.timeZone?.value
    || !sameRatingInstant(period.periodStart, row.periodStart?.value)
    || !sameRatingInstant(period.periodEnd, row.periodEnd?.value)) {
    throw new RatingObservationUnavailable('daily revision period differs');
  }
  return period;
}

/** Exact context and predecessor keys only; no scan over voters or historic days. */
export async function resolveDailyPeriod(env: WorkActivationEnvironment,
  context: string, mainVersion: string, predecessor: string | null,
  registeredAt: string): Promise<RatingPeriod> {
  const found = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest ?timeZone WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(context)} a rv:RatingContext, rv:DailyRatingContext ;
      rv:contextState rv:Active ; rv:ratingCadence ${iri(DAILY_CADENCE)} ;
      rv:ratingTimeZone ?timeZone ; rv:head ?head . }
    GRAPH ${iri(GRAPHS.revisions)} { ?head rv:component ${iri(context)} ;
      rv:modelRevision ${iri(DAILY_CONTEXT_PROFILE)} ; rv:manifest ?manifest . }
  }`);
  const rows = found.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.manifest || !rows[0].timeZone) {
    throw new Error('daily Context is unavailable');
  }
  const state = readComponentState(env.objectDirectory, rows[0].manifest.value,
    context, DAILY_CONTEXT_PROFILE);
  if (state.context !== context || state.timeZone !== rows[0].timeZone.value
    || state.cadence !== DAILY_CADENCE || state.calendar !== 'iso8601') {
    throw new Error('daily Context manifest differs');
  }
  const timeZone = rows[0].timeZone.value;
  if (!predecessor) return ratingDayPeriod(timeZone, registeredAt);
  const prior = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest ?observation WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(predecessor)}
      a rv:RatingObservationRevision, rv:DailyRatingObservationRevision ;
      rv:component ?observation ; rv:modelRevision ${iri(DAILY_OBSERVATION_PROFILE)} ;
      rv:manifest ?manifest . }
    GRAPH ${iri(GRAPHS.current)} { ?observation rv:ratingContext ${iri(context)} ;
      rv:targetMainVersion ${iri(mainVersion)} . }
  }`);
  const saved = prior.results?.bindings ?? [];
  if (saved.length !== 1 || !saved[0]?.manifest || !saved[0].observation) {
    throw new Error('daily predecessor is unavailable');
  }
  const previous = readComponentState(env.objectDirectory, saved[0].manifest.value,
    saved[0].observation.value, DAILY_OBSERVATION_PROFILE);
  if (previous.revision !== predecessor || previous.context !== context
    || previous.mainVersion !== mainVersion || previous.timeZone !== timeZone) {
    throw new Error('daily predecessor manifest differs');
  }
  return retainedRatingPeriod(previous);
}
