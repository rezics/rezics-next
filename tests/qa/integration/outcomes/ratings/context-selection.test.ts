import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { retainStoppedOwnerBackup, restoreCatalogueBackup } from '../../../../../scripts/load/catalogue-backup.ts';
import { root, stream, dockerEnvironment } from '../../../../../scripts/fixture/stack.ts';
import { readEnv } from '../../../../../scripts/dev/config.ts';
import { runQaStartupChildAsync } from '../../../../../scripts/qa/stack-startup.ts';
import { stopCorpusSourcePostgres } from '../../../../../scripts/load/corpus-backup-driver.ts';
import { migrateOwnerData, assertOwnerMigrationsComplete } from '../../../../../scripts/fixture/migrate.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../../../services/main/src/modules/rating/global.ts';
import { questionPresentationScope, QUESTION_PRESENTATION_ACTIONS } from '../../../../../services/main/src/modules/rating/question-presentation-schema.ts';
import { grantPersonaFixtureAuthority } from '../../../support/persona-fixture-authority.ts';
import { personaNames, personaSessions, retainPersonaRealm, restorePersonaRealms,
  type PersonaSession, type PersonaSessions, type RetainedPersonaRealm } from '../../../support/personas.ts';

type Position = { dataEpoch: string; sequence: string };
type Scale = { min: number; max: number; step: number };
type Context = { context: string; contextRevision: string; question: string; scale: Scale; realm?: string };
type Item = { context: string; revision?: string; question: string; scale: Scale;
  displayQuestion: { value: string; language: string; presentation: { component: string; revision: string } | null } };
type Page<T> = { items: T[]; nextCursor: string | null; sourcePosition: Position };
type Summary = { context: string; status: string; count: number; mainVersion: string; scale: Scale;
  sourcePosition: Position; aggregationScope: { grain: string; population: string; countedTarget: string } };
type Source = { realms: RetainedPersonaRealm[]; communities: { space: string; realm: string; contexts: Context[] }[];
  work: string; mainVersion: string; other: string; global: Context; privateContext: Context; incompatible: Context };
const directory = resolve(Bun.env.REZICS_RATING_CONTEXT_SOURCE ?? '.temp/rating-context-source');
const evidencePath = resolve('.temp/rating-context-results.json');
const short = (id: string) => id.slice(-36);
const own = (person: PersonaSession) => ({ actingSubject: person.actingSubject! });
const qs = (values: Record<string, string>) => new URLSearchParams(values).toString();
let people: PersonaSessions, privatePeople: PersonaSessions, source: Source;
let copy: Awaited<ReturnType<typeof restoreCatalogueBackup>> | undefined;
const evidence: { setup: object; personas: Record<string, object>; requests: object[] } = { setup: {}, personas: {}, requests: [] };
async function json<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending, raw = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${raw}`);
  return JSON.parse(raw) as T;
}
const grant = (person: PersonaSession, scope: string, action: string) => grantPersonaFixtureAuthority(person, [{ scope, action }]);
async function presentation(context: string, prior?: { component: string; revision: string }) {
  return json<{ component: string; revision: string }>(people.owner.main('POST', '/v1/rating-question-presentations', {
    profile: 'rating-question-presentation-v1', ...(prior ? { target: prior.component } : {}),
    expectedHead: prior?.revision ?? null, actingSubject: people.owner.actingSubject,
    state: { context, language: 'fr', question: prior ? 'Qualité révisée ?' : 'Quelle qualité ?',
      source: context, licence: 'https://creativecommons.org/publicdomain/zero/1.0/', reviewStatus: 'reviewed' },
  }), prior ? 200 : 201);
}
async function prepare(): Promise<Source> {
  people = await personaSessions('public', { moderatorLifetimeMs: 86_400_000 });
  privatePeople = await personaSessions('public', { moderatorLifetimeMs: 86_400_000 });
  const work = await json<{ work: string; mainVersion: string }>(people.owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', authoring: 'own-work', title: 'Original context-selection acceptance work',
    language: 'en', semanticTypes: ['https://schema.org/Book'], ...own(people.owner) }), 201);
  const other = await json<{ work: string }>(people.owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', authoring: 'own-work', title: 'Separate native rating target',
    language: 'en', semanticTypes: ['https://schema.org/Book'], ...own(people.owner) }), 201);
  await grant(people.owner, GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
  const global = await json<Context>(people.owner.main('POST', '/v1/global-rating-contexts', {
    profile: 'global-rating-standing-context-v1', question: 'Overall quality?', scale: { min: 1, max: 10, step: 1 }, ...own(people.owner) }), 201);
  const communities: Source['communities'] = [];
  for (let n = 0; n < 10; n++) {
    // Persona owners already created a Realm Space and a Zone Space (quota: three/month).
    const creator = n < 2 ? people.owner : n < 5 ? people.stranger : n < 8 ? privatePeople.stranger : n === 8 ? privatePeople.owner : people.member;
    evidence.setup = { stage: `community-${n}` };
    const community = n === 0 ? { space: people.space, realm: people.realm } : await json<{ space: string; realm: string }>(
      creator.main('POST', '/v1/spaces', { profile: 'space-realm-v2', name: `Context community ${n}`,
        handle: `context-${randomUUID().slice(0, 12)}`, language: 'en', capabilities: ['realm'], ...own(creator),
        initialSettings: { visibility: 'public', reviewRequired: false, reviewMode: 'open', whoMaySubmit: 'members', selfJoin: true, rules: [] } }), 201);
    await grant(people.owner, `rating:context:${community.realm}`, 'rating.context.create');
    const contexts: Context[] = [];
    for (const scale of n === 0 ? [{ min: 1, max: 10, step: 1 }, { min: 1, max: 5, step: 1 }, { min: 0.25, max: 5, step: 0.25 }] : [{ min: 1, max: 10, step: 1 }]) {
      const context = await json<Context>(people.owner.main('POST', '/v1/rating-contexts', {
        profile: 'realm-standing-rating-context-v1', realm: community.realm, question: 'Overall quality?', scale, ...own(people.owner) }), 201);
      contexts.push(context);
      if (n === 0) {
        for (const action of QUESTION_PRESENTATION_ACTIONS) await grant(people.owner, questionPresentationScope(context.context), action);
        await presentation(context.context);
      }
    }
    communities.push({ ...community, contexts: contexts.sort((a, b) => a.context.localeCompare(b.context)) });
  }
  // One real Account rates two overlapping populations; the tenth has no votes.
  evidence.setup = { stage: 'native-observations' };
  for (const community of communities.slice(0, 2)) {
    const context = community.contexts[0]!;
    await grant(people.owner, `rating:observe:${context.context}`, 'rating.observation.set');
    await json(people.owner.main('POST', '/v1/rating-observations', { profile: 'realm-standing-rating-observation-v1',
      context: context.context, work: work.work, mainVersion: work.mainVersion, value: context.scale.max, expectedRevisionHead: null, ...own(people.owner) }), 201);
  }
  evidence.setup = { stage: 'follows-and-revocation' };
  for (const [person, count] of [[people.owner, 1], [people.moderator, 3], [people.member, 10]] as const)
    await json(person.main('POST', '/v1/me/follows/batch', { profile: 'follow-batch-v1', ...own(person),
      targets: communities.slice(0, count).map(item => ({ target: item.space })) }));
  await grant(privatePeople.owner, `rating:context:${privatePeople.realm}`, 'rating.context.create');
  const privateContext = await json<Context>(privatePeople.owner.main('POST', '/v1/rating-contexts', {
    profile: 'realm-standing-rating-context-v1', realm: privatePeople.realm, question: 'Confidential quality?', ...own(privatePeople.owner) }), 201);
  const settingsPath = `/v1/spaces/${short(privatePeople.space)}/settings`;
  const basis = await json<{ generation: string }>(privatePeople.owner.main('GET', `${settingsPath}?${qs(own(privatePeople.owner))}`));
  await json(privatePeople.owner.main('PUT', settingsPath, { ...own(privatePeople.owner), expectedGeneration: basis.generation,
    reason: 'Make the originally public context unreadable',
    settings: { visibility: 'private', listing: 'listed', history: 'everything', admission: 'invitation' } }), 201);
  privatePeople.visibility = 'private';
  const incompatible = await json<Context>(people.owner.main('POST', '/v1/rating-contexts', {
    profile: 'realm-target-rating-context-v3', realm: people.realm, question: 'Character quality?', language: 'en', targetGrain: 'resource', ...own(people.owner) }), 201);
  const root = `/v1/realms/${short(privatePeople.realm)}`;
  const members = await json<{ generation: string; items: { member: string; membershipGeneration: string }[] }>(
    privatePeople.owner.main('GET', `${root}/members?${qs(own(privatePeople.owner))}`));
  const member = members.items.find(item => item.member === privatePeople.member.actingSubject)!;
  await json(privatePeople.owner.main('POST', `${root}/members`, { ...own(privatePeople.owner), member: member.member,
    expectedGeneration: members.generation, expectedMembershipGeneration: member.membershipGeneration,
    reason: 'Revoke the synthetic selection fixture membership', action: 'remove', consent: null, durationSeconds: null }), 201);
  return { realms: [retainPersonaRealm(people), retainPersonaRealm(privatePeople)], communities, ...work,
    other: other.work, global, privateContext, incompatible };
}
// Preserve the harness-selected raw-update mode across backup lifecycle commands.
async function stackTask(args: string[]) {
  const runId = args[args.indexOf('--run-id') + 1]!;
  const compose = readEnv(resolve(root, '.temp/stack', `rezics-qa-${runId}`, 'compose.env'));
  const command = [...args, ...(compose.REZICS_STACK_RAW_UPDATE === '1' ? ['--raw-update'] : [])];
  if (args[0] !== 'stack:up') return stream('task', command, dockerEnvironment(), undefined, 120_000);
  const result = await runQaStartupChildAsync(root, command.filter(arg => arg !== '--'), 180_000, dockerEnvironment());
  if (!result.ok) throw new Error(`Context fixture startup failed: ${result.output.slice(-2000)}`);
  return result.output;
}
beforeAll(async () => {
  const started = Date.now();
  try {
    if (!existsSync(resolve(directory, 'source.json'))) {
      if (existsSync(directory)) throw new Error('Incomplete context source; inspect the failed preparation before retrying');
      source = await prepare();
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(resolve(directory, 'source.json'), JSON.stringify(source), { mode: 0o600 });
      await people.close();
      await retainStoppedOwnerBackup(Bun.env.REZICS_QA_RUN_ID!, 'rating-context-selection', resolve(directory, 'owners'), started, {
        resumeSource: false, purpose: 'corpus', signal: AbortSignal.timeout(Math.max(1, 600_000 - (Date.now() - started))),
        stopSourcePostgres: () => stopCorpusSourcePostgres(Bun.env.REZICS_QA_RUN_ID!, AbortSignal.timeout(120_000)),
      }, { task: stackTask });
    } else source = JSON.parse(readFileSync(resolve(directory, 'source.json'), 'utf8')) as Source;
    const restoreStarted = Date.now();
    const restoreRunId = `ratings-${randomUUID().slice(0, 18)}`;
    copy = await restoreCatalogueBackup(resolve(directory, 'owners/backup.json'), restoreRunId, { resourceClass: 'ordinary', task: stackTask });
    Object.assign(Bun.env, copy.apps, { REZICS_QA_RUN_ID: restoreRunId });
    assertOwnerMigrationsComplete(await migrateOwnerData(copy.apps));
    [people, privatePeople] = await restorePersonaRealms(source.realms) as [PersonaSessions, PersonaSessions];
    await json(people.visitor.main('GET', `/v1/global-rating-contexts/${short(source.global.context)}`));
    const restoreMs = Date.now() - restoreStarted - copy.admissionWaitMs;
    if (restoreMs >= 600_000) throw new Error(`Restore/startup/migrations/readiness/smoke exceeded 600s: ${restoreMs}ms`);
    evidence.setup = { reached: true, source: directory, restoreMs, totalMs: Date.now() - started, preparation: copy.preparation };
  } catch (error) {
    evidence.setup = { ...evidence.setup, reached: false, assertionReached: false, elapsedMs: Date.now() - started, failure: String(error) };
    throw error;
  }
}, 600_000);
afterAll(async () => {
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  try { await people?.close(); } finally { await copy?.stop(); }
});

for (const name of personaNames) test(`O-RATING-INVENTORY/O-RATING-SELECTION ${name}: exact permitted context composition`, async () => {
  const person = people[name], failures: string[] = [], reached: string[] = [], checks: object[] = [];
  let requests = 0;
  const request = async (path: string, as = person) => {
    requests++;
    const response = await as.main('GET', path);
    evidence.requests.push({ persona: name, path, status: response.status, body: await response.clone().json() });
    return response;
  };
  const check = async (label: string, body: () => Promise<void>) => {
    reached.push(label); const before = requests;
    try { await body(); checks.push({ label, requests: requests - before, passed: true }); }
    catch (error) { failures.push(`${label}: ${String(error)}`); checks.push({ label, requests: requests - before, passed: false }); }
  };
  const realm = source.communities[0]!, selected = realm.contexts[1]!;
  const scope = (id: string) => qs({ scope: 'realm', realm: id });
  const rating = (id: string, context: string, target = source.work) => `/v1/resources/${short(target)}/ratings?${scope(id)}&${qs({ context })}`;
  const pages = async (path: string) => {
    const items: Item[] = [];
    let cursor: string | null = null;
    do {
      expect(items.length).toBeLessThan(24);
      const page: Page<Item> = await json(request(`${path}${cursor ? `&${qs({ cursor })}` : ''}`));
      expect(page.sourcePosition.dataEpoch).toBeString();
      expect(page.items.length).toBeLessThanOrEqual(20);
      items.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(items.map(item => item.context)).size).toBe(items.length);
    return items;
  };
  await check('complete-inventory-native-metadata', async () => {
    const listed = await pages(`/v1/rating-contexts?${scope(realm.realm)}&limit=1&languages=fr`);
    expect(listed.map(item => item.context)).toEqual(realm.contexts.map(item => item.context));
    for (const expected of realm.contexts) {
      const item = listed.find(item => item.context === expected.context)!;
      expect(item).toMatchObject({ revision: expected.contextRevision, question: expected.question, scale: expected.scale,
        targetGrain: 'main-version', cadence: 'standing', displayQuestion: { language: 'fr' } });
    }
  });
  await check('page-two-selection-locale-identity', async () => {
    for (const as of [person, people.visitor]) for (const language of ['en', 'fr']) {
      const detail = await json<Context>(request(`/v1/rating-contexts/${short(selected.context)}?languages=${language}`, as));
      expect(detail).toMatchObject({ context: selected.context, contextRevision: selected.contextRevision, scale: selected.scale });
      const summary = await json<Summary>(request(rating(realm.realm, selected.context), as));
      expect(summary).toMatchObject({ context: selected.context, mainVersion: source.mainVersion, status: 'available', scale: selected.scale,
        aggregationScope: { grain: 'main-version', countedTarget: source.mainVersion } });
      expect(summary.sourcePosition.dataEpoch).toBeString();
    }
  });
  await check('invalid-incompatible-private-revoked-selection', async () => {
    const absent = `https://rezics.com/id/00000000-0000-4000-8000-000000000099`;
    for (const context of [absent, source.incompatible.context]) {
      const response = await request(rating(realm.realm, context));
      expect([400, 404, 409, 422]).toContain(response.status);
    }
    for (const as of [person, privatePeople.member]) {
      const results = [];
      for (const context of [source.privateContext.context, absent]) {
        const response = await request(`/v1/rating-contexts/${short(context)}`, as);
        results.push([response.status, await response.json()]);
      }
      expect(results[0]).toEqual(results[1]); expect(results[0]![0]).toBe(404);
    }
  });
  const cardinality = name === 'owner' ? 1 : name === 'moderator' ? 3 : name === 'member' ? 10 : 0;
  if (cardinality) await check(`bounded-composition-${cardinality}`, async () => {
    const before = requests;
    const follows = await json<Page<{ id: string; realm: string; available: boolean }>>(request(`/v1/me/follows?${qs({ ...own(person), kind: 'space', limit: '20' })}`));
    expect(follows.nextCursor).toBeNull(); expect(follows.items).toHaveLength(cardinality);
    const global = await pages('/v1/rating-contexts?scope=global&limit=20');
    expect(global.map(item => item.context)).toContain(source.global.context);
    const counts: { context: string; count: number }[] = [], errors: string[] = [];
    for (const follow of follows.items) {
      expect(follow.available).toBe(true);
      const expected = source.communities.find(item => item.space === follow.id)!;
      expect(follow.realm).toBe(expected.realm);
      const items = await pages(`/v1/rating-contexts?${scope(follow.realm)}&limit=20`);
      expect(items.map(item => item.context)).toEqual(expected.contexts.map(item => item.context));
      for (const context of expected.contexts) {
        try { expect(await json(request(`/v1/rating-contexts/${short(context.context)}`))).toMatchObject({ context: context.context, contextRevision: context.contextRevision,
          population: 'account-principal', cadence: 'standing', targetGrain: 'mainVersion', scale: context.scale }); }
        catch (error) { errors.push(String(error)); }
        try { const summary = await json<Summary>(request(rating(expected.realm, context.context)));
          expect(summary).toMatchObject({ context: context.context, status: 'available', scale: context.scale });
          counts.push({ context: context.context, count: summary.count }); }
        catch (error) { errors.push(String(error)); }
      }
    }
    evidence.personas[`${name}-composition`] = { cardinality, requests: requests - before, counts, errors };
    expect(requests - before).toBeLessThanOrEqual(3 * cardinality + 8);
    expect(errors).toEqual([]);
    expect(counts).toContainEqual({ context: realm.contexts[0]!.context, count: 1 });
    if (cardinality >= 3) expect(counts).toContainEqual({ context: source.communities[1]!.contexts[0]!.context, count: 1 });
    if (cardinality === 10) {
      expect(counts).toContainEqual({ context: source.communities[9]!.contexts[0]!.context, count: 0 });
      const populations = await json<Page<{ id: string }>>(request(`/v1/rating-populations?${qs({ target: source.work, limit: '20' })}`));
      expect(populations.items.map(item => item.id)).not.toContain(source.communities[9]!.realm);
    }
  });
  await check('separate-target-has-no-borrowed-population', async () => {
    expect(await json(request(rating(realm.realm, realm.contexts[0]!.context, source.other))))
      .toMatchObject({ context: realm.contexts[0]!.context, count: 0, status: 'available' });
  });
  if (name === 'owner') await check('presentation-revision-keeps-selected-context', async () => {
    const before = await json<Item>(request(`/v1/rating-contexts/${short(selected.context)}?languages=fr`));
    const changed = await presentation(selected.context, before.displayQuestion.presentation!);
    const after = await json<Item>(request(`/v1/rating-contexts/${short(selected.context)}?languages=fr`));
    expect(after).toMatchObject({ context: selected.context, contextRevision: selected.contextRevision,
      displayQuestion: { value: 'Qualité révisée ?', presentation: changed } });
    expect(changed.revision).not.toBe(before.displayQuestion.presentation!.revision);
  });
  evidence.personas[name] = { reached, requests, checks, failures };
  console.log(JSON.stringify({ persona: name, reached, requests, failures }));
  expect(failures).toEqual([]);
}, 120_000);
