import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import declaration from '../../../../../scripts/qa/cases/outcomes/games/play-duration-estimates.ts';
import type { DurationCohort, SetSessionDurationRequest, SetSessionDurationResponse,
  SessionDurationObservation } from '../../../../../services/main/src/modules/session/duration-contract.ts';
import type { ActivityDurationEstimatesRequest, ActivityDurationEstimatesResponse }
  from '../../../../../services/main/src/modules/rating/duration-contract.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions }
  from '../../../support/personas.ts';

setDefaultTimeout(120_000);
const unit = 'http://qudt.org/vocab/unit/SEC' as const;
const metric = 'https://rezics.com/definition/activity-elapsed-v1';
const main = 'https://rezics.com/definition/active-main-story-v1';
const extras = 'https://rezics.com/definition/active-completionist-v1';
const pc = 'https://example.org/platform/desktop';
const consolePlatform = 'https://example.org/platform/console';
const short = (id: string) => id.slice(-36);
let people: PersonaSessions;
let cohorts: DurationCohort[];
type Run = { id: string; version: number };
type Seed = { run: Run; input: SetSessionDurationRequest; status: number; body: string };
const seeds: Seed[] = [];

// Ordinary fixture failures throw outside test.failing, so they cannot masquerade
// as the deliberately unsupported duration outcome.
async function fixture<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  if (response.status !== status) throw new Error(`Duration fixture HTTP ${response.status}: ${raw}`);
  return JSON.parse(raw) as T;
}
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  if (response.status !== status) console.info(`B03 outcome failure: expected HTTP ${status}, received ${response.status}: ${raw}`);
  expect(response.status, `B03 public API HTTP ${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
const durationPath = (run: Run) => `/v1/me/sessions/${short(run.id)}/duration-observation`;
const ownerQuery = () => new URLSearchParams({ actingSubject: people.owner.actingSubject! });

async function release(work: string, title: string) {
  const id = `https://rezics.com/id/${randomUUID()}`;
  await fixture(people.owner.main('PUT', `/v1/works/${short(work)}/releases/${short(id)}`, {
    profile: 'release-v1', expectedHead: null, id,
    actingSubject: people.owner.actingSubject, kind: 'formal', status: 'official',
    contentLanguages: ['en'], isTranslation: false, originalLanguages: [],
    titleLanguage: 'en', tracklistLanguage: null, title: { value: title, language: 'en' },
    editionStatement: title, publisher: null, publicationYear: null, isbn13: null,
    originalUrl: null, fixedRelease: null, coverage: null, evidence: null,
  }));
  return id;
}

async function seed(cohort: DurationCohort, value: string | null,
  state: 'finished' | 'active' = 'finished', contribution: 'private' | 'public-aggregate' = 'public-aggregate') {
  const run = await fixture<Run>(people.owner.main('POST', '/v1/me/sessions', {
    target: cohort.target, actingSubject: people.owner.actingSubject, expectedVersion: 0, state,
  }), 201);
  const input: SetSessionDurationRequest = {
    ...cohort, profile: 'session-duration-observation-v1', actingSubject: people.owner.actingSubject!,
    expectedSessionVersion: run.version, expectedRevisionHead: null,
    result: value === null ? { status: 'unknown', value: null, unit } : { status: 'known', value, unit },
    contribution,
  };
  // Retain unsupported answers for each persona to inspect after its own query.
  // Assert nothing here: missing capability must fail a persona, not setup.
  const response = await people.owner.main('PUT', durationPath(run), input);
  seeds.push({ run, input, status: response.status, body: await response.text() });
}

beforeAll(async () => {
  people = await personaSessions('public');
  const game = await fixture<{ work: string }>(people.owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title: 'Original duration garden', language: 'en',
    semanticTypes: ['https://schema.org/VideoGame'], authoring: 'own-work',
    actingSubject: people.owner.actingSubject,
  }), 201);
  const first = await release(game.work, 'Original garden version one');
  const second = await release(game.work, 'Original garden version two');
  // Four cross-product cells on the SAME release prevent platform from being
  // accidentally encoded by release. The fifth cell also proves release grain.
  cohorts = [
    { target: first, metric, procedure: main, platform: pc },
    { target: first, metric, procedure: main, platform: consolePlatform },
    { target: first, metric, procedure: extras, platform: pc },
    { target: first, metric, procedure: extras, platform: consolePlatform },
    { target: second, metric, procedure: main, platform: pc },
  ];
  await seed(cohorts[0]!, '3600');
  await seed(cohorts[0]!, '7200');
  await seed(cohorts[1]!, '10800');
  await seed(cohorts[2]!, '14400');
  await seed(cohorts[3]!, '18000');
  await seed(cohorts[4]!, '21600');
  await seed(cohorts[0]!, '500', 'active');
  await seed(cohorts[0]!, null);
  await seed(cohorts[0]!, '90000', 'finished', 'private');
}, 180_000);
afterAll(async () => { await people?.close(); });

async function estimates(person: PersonaSession, selected = cohorts) {
  const input: ActivityDurationEstimatesRequest = {
    profile: 'activity-duration-estimates-v1', cohorts: selected, sources: [],
    ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}),
  };
  const result = await answer<ActivityDurationEstimatesResponse>(
    person.main('POST', '/v1/activity-duration-estimates', input));
  // Every pending persona must observe the absent public query on this branch.
  // Once it exists, an absent capture remains a separate, explicit failure.
  for (const seeded of seeds) expect(seeded.status, `B03 duration capture: ${seeded.body}`).toBe(200);
  expect(result.profile).toBe(input.profile);
  expect(result.cohorts.map(item => item.cohort)).toEqual(selected);
  return result;
}
function value(result: ActivityDurationEstimatesResponse, index: number) {
  const estimate = result.cohorts[index]!.native.estimate;
  expect(estimate.status).toBe('available');
  if (estimate.status !== 'available') throw new Error('Expected a disclosed duration estimate');
  return Number(estimate.value.numerator) / Number(estimate.value.denominator);
}
async function compare(person: PersonaSession) {
  const result = await estimates(person);
  // Owner correction runs after all other personas; they all see the same cut.
  expect(result.cohorts.map((_, index) => value(result, index))).toEqual([5400, 10800, 14400, 18000, 21600]);
  expect(result.cohorts[0]!.native).toMatchObject({
    population: 'public-opt-in-session-runs', countingRule: 'latest-observation-per-session',
    sampleCount: 2, eligibleCount: 4, incompleteCount: 1, unknownDurationCount: 1,
    sumSeconds: '10800', estimator: 'arithmetic-mean-finished-known-v1', unit,
  });
  for (const item of result.cohorts) {
    expect(item.sources).toEqual([]);
    expect(item.native.evidence.generation.length).toBeGreaterThan(0);
    expect(item.native.evidence.revision.length).toBeGreaterThan(0);
  }
  const publicJson = JSON.stringify(result);
  for (const seeded of seeds) expect(publicJson).not.toContain(seeded.run.id);
  expect(publicJson).not.toContain(people.owner.actingSubject!);
  const empty = await estimates(person, [{ ...cohorts[0]!, platform: null }]);
  expect(empty.cohorts[0]!.native).toMatchObject({
    sampleCount: 0, eligibleCount: 0, incompleteCount: 0, unknownDurationCount: 0,
    sumSeconds: '0', estimate: { status: 'no-data', value: null },
  });
  return result;
}
async function privateBoundary(name: Exclude<PersonaName, 'owner' | 'visitor'>) {
  const person = people[name];
  const before = await compare(person);
  const secret = seeds[8]!;
  await answer(person.main('GET', `${durationPath(secret.run)}?${ownerQuery()}`), 403);
  await answer(person.main('GET', `/v1/me/sessions?${ownerQuery()}`), 403);
  await answer(person.main('GET', `/v1/me/library-export?${ownerQuery()}`), 403);
  await answer(person.main('PUT', durationPath(secret.run), secret.input), 403);
  // Supplying one's own authority cannot disclose a session located by ID.
  await answer(person.main('GET', `${durationPath(secret.run)}?${new URLSearchParams({
    actingSubject: person.actingSubject!,
  })}`), 404);
  expect(await estimates(person)).toEqual(before);
}

outcomeTest(declaration, 'visitor', async () => {
  await compare(people.visitor);
  await answer(people.visitor.main('PUT', durationPath(seeds[0]!.run), seeds[0]!.input), 401);
  await answer(people.visitor.main('GET', `${durationPath(seeds[8]!.run)}?${ownerQuery()}`), 401);
});
outcomeTest(declaration, 'stranger', () => privateBoundary('stranger'));
outcomeTest(declaration, 'member', () => privateBoundary('member'));
outcomeTest(declaration, 'moderator', () => privateBoundary('moderator'));
outcomeTest(declaration, 'operator', () => privateBoundary('operator'));
outcomeTest(declaration, 'owner', async () => {
  const before = await compare(people.owner);
  const first = seeds[0]!;
  const original = await answer<{ observation: SessionDurationObservation }>(
    people.owner.main('GET', `${durationPath(first.run)}?${ownerQuery()}`));
  const changed: SetSessionDurationRequest = { ...first.input,
    expectedRevisionHead: original.observation.observationRevision,
    result: { status: 'known', value: '10800', unit },
  };
  const key = randomUUID();
  const receipt = await answer<SetSessionDurationResponse>(
    people.owner.main('PUT', durationPath(first.run), changed, key));
  const replay = await answer<SetSessionDurationResponse>(
    people.owner.main('PUT', durationPath(first.run), changed, key));
  expect(replay).toEqual({ ...receipt, replayed: true });
  expect(receipt.observation.predecessor).toBe(original.observation.observationRevision);
  const after = await estimates(people.owner);
  expect(value(after, 0)).toBe(9000);
  expect(after.cohorts[0]!.native.sampleCount).toBe(2);
  expect(after.cohorts[0]!.native.evidence).not.toEqual(before.cohorts[0]!.native.evidence);
  expect(after.cohorts.slice(1)).toEqual(before.cohorts.slice(1));
  const secret = await answer<{ observation: SessionDurationObservation }>(
    people.owner.main('GET', `${durationPath(seeds[8]!.run)}?${ownerQuery()}`));
  expect(secret.observation).toMatchObject({ contribution: 'private', result: { value: '90000', unit } });
  type Page = { rows: { session: { durationObservation?: SessionDurationObservation | null } | null }[];
    snapshot: string; nextCursor: string | null };
  const observations: SessionDurationObservation[] = [];
  let cursor: string | null = null;
  let snapshot: string | undefined;
  const visited = new Set<string>();
  do {
    const query = ownerQuery();
    query.set('limit', '2');
    if (snapshot) query.set('snapshot', snapshot);
    if (cursor) query.set('cursor', cursor);
    const page = await answer<Page>(people.owner.main('GET', `/v1/me/library-export?${query}`));
    snapshot ??= page.snapshot;
    expect(page.snapshot).toBe(snapshot);
    for (const row of page.rows) if (row.session?.durationObservation) observations.push(row.session.durationObservation);
    cursor = page.nextCursor;
    if (cursor) { expect(visited.has(cursor)).toBe(false); visited.add(cursor); }
  } while (cursor);
  expect(observations).toHaveLength(seeds.length);
  expect(observations).toContainEqual(receipt.observation);
  expect(observations).toContainEqual(secret.observation);
  expect(observations.find(observation => observation.session === seeds[7]!.run.id)?.result)
    .toEqual({ status: 'unknown', value: null, unit });
  for (const observation of observations) {
    const input = seeds.find(seeded => seeded.run.id === observation.session)!.input;
    expect(observation.procedure).toBe(input.procedure);
    expect(observation.metric).toBe(metric);
    expect(observation.result.unit).toBe(unit);
  }
});
