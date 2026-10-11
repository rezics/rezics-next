import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import { loadScopedSubjects, type ScopedSubjectManifest } from '../../../scripts/dev/seed/scoped-subjects.ts';
import { scopedSubjectLocales, scopedSubjectQuestions } from '../../../scripts/dev/seed/scoped-subjects-questions.ts';
import { entityPage, subjectStatementPage, resourceRelationPage } from '../../../services/main/src/modules/entity-page/contract.ts';
import { WORK_READ_COST } from '../../../services/main/src/modules/work/read-contract.ts';
import { scopedSubjectsFixture } from './scoped-subjects-support.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';

const short = (ref: string) => ref.slice(-36);
type Statements = Static<typeof subjectStatementPage>;
type Relations = Static<typeof resourceRelationPage>;
interface Aggregate { count: number; sum: number; mean: number | null; histogram: number[];
  displayThreshold: number; meanDisplay: string; target: string }
interface Rollup { formula: string; value: number | null; valueWithheld: string | null;
  memberCount: number; coverage: { members: number; available: number; meetingThreshold: number };
  members: { target: string; status: string; mean?: number | null; meetsThreshold?: boolean }[];
  rank: { minimumRatings: number; prior: { mean: number; weight: number; ratings: number; targets: number };
    items: { target: string; count: number; score: number }[] } }
let h: Awaited<ReturnType<typeof scopedSubjectsFixture>>;
let data: ScopedSubjectManifest;
let readers: Awaited<ReturnType<typeof h.person>>[];
let projectionReader: Awaited<ReturnType<typeof h.person>>;
const subject = (id: string) => data.subjects[id]!;
const projection = (id: string) => data.projections[id]!;
const api = () => h.api(null);
const curator = () => h.api(h.owner);
const acting = () => `actingSubject=${encodeURIComponent(h.owner.actor)}`;
const catchStatementIndex = async () => {
  while (await h.stack.statementSeek.projectOnce()) { /* bounded outbox batches */ }
};
const statements = async (on: string, frames: string[] = []) => {
  await catchStatementIndex();
  return curator().get<Statements>(
    `/v1/resources/${short(on)}/statements?${acting()}&limit=20&position=all${frames.map(frame => `&frame=${encodeURIComponent(frame)}`).join('')}`);
};
const statementIds = (page: Statements) => page.groups.flatMap(group => group.items)
  .flatMap(item => item.kind === 'statement' ? [item.statement] : []);
const relations = (on: string, frames: string[] = []) => curator().get<Relations>(
  `/v1/resources/${short(on)}/relations?${acting()}&languages=en${frames.map(frame => `&frame=${encodeURIComponent(frame)}`).join('')}`);
const relationRecord = <T>(ref: string) => curator().get<T>(`/v1/relations/${short(ref)}?${acting()}`);
const page = async (ref: string) => {
  await catchStatementIndex();
  return curator().get<Static<typeof entityPage>>(
    `/v1/resources/${short(ref)}/page?${acting()}&position=all`);
};
const aggregate = (context: string, target: string) => api().post<Aggregate>('/v1/rating-aggregates', {
  profile: 'realm-target-latest-mean-v1', context, target,
}, randomUUID());
const contexts = (target: string, language = 'en') => api().get<{ items: { context: string;
  displayQuestion: { value: string; language: string; reviewStatus: string; presentation: object | null } }[] }>(
  `/v1/resources/${short(target)}/rating-contexts?scope=global&languages=${language}`);
const projectAgain = (on: string, frames: string[]) => h.api(h.owner).post<{ projection: { id: string; subject: string } }>(
  '/v1/projections', { subject: on, frames, actingSubject: h.owner.actor }, randomUUID());
const projectionPagePath = (ref = projection('misaka-episode'), signedIn = true) =>
  `/v1/resources/${short(ref)}/page?position=all${signedIn ? `&actingSubject=${encodeURIComponent(projectionReader.actor)}` : ''}`;
const assertProjectionPage = (read: Static<typeof entityPage>) => {
  expect(Value.Check(entityPage, read)).toBe(true);
  expect(read.target.resource).toBe(projection('misaka-episode'));
  expect(read.projection!.subject.reference).toBe(subject('misaka'));
  expect(read.projection!.frames.map(frame => frame.reference)).toEqual([data.positions['railgun-episode']!.occurrence]);
  const fact = read.projection!.statements.groups.flatMap(group => group.items)
    .find(item => item.kind === 'statement' && item.statement === data.statements['misaka-ability']);
  expect(fact).toMatchObject({ kind: 'statement', statement: data.statements['misaka-ability'],
    predicate: data.definitions.ability, value: { kind: 'literal', lexical: 'Electromaster' } });
};
const assertUnavailableProjection = async (response: Response) => {
  const body = await response.text();
  expect(response.status, body).toBe(404);
  for (const secret of [projection('misaka-episode'), subject('misaka'),
    data.positions['railgun-episode']!.occurrence, 'Misaka', 'Electromaster']) expect(body).not.toContain(secret);
  return JSON.parse(body) as { code: string; title: string; status: number; type: string };
};

beforeAll(async () => {
  h = await scopedSubjectsFixture();
  await grantRecordedPlatformUse(h.stack.accessPool, h.owner.principalId,
    ['events', 'platform-admin'], h.owner.actor);
  readers = [h.owner];
  for (let index = 1; index < 50; index++) readers.push(await h.person(`Map reader ${index + 1}`));
  data = await loadScopedSubjects({ api: h.api(h.owner), actor: h.owner.actor, namespace: `scoped-${randomUUID().slice(0, 8)}`,
    authorize: h.authorize, findDefinition: h.findDefinition,
    raters: readers.map(reader => ({ actor: reader.actor, api: h.api(reader) })) });
  projectionReader = await h.person('Scoped projection reader');
  // Match the browser journey's read grants, with the reader's own representation.
  // The seed writer's platform grants and rating permissions are not needed to read.
  const readGrants = [
    ...[...Object.values(data.subjects), ...Object.values(data.relations).map(relation => relation.occurrence),
      ...Object.values(data.definitions), data.variantKind].map(ref => ({ scope: `semantic:read:${ref}`, action: 'semantic.read' })),
    ...Object.values(data.works).map(work => ({ scope: `work:read:${work.work}`, action: 'work.read' })),
  ];
  for (const { scope, action } of readGrants) {
    await h.stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await h.stack.accessPool.query(`INSERT INTO access.representation
      (id,principal_id,subject_id,action,valid_until) VALUES ($1,$2,$3,$4,now()+interval '1 hour')`,
    [randomUUID(), projectionReader.principalId, projectionReader.actor, action]);
    await h.stack.accessPool.query(`INSERT INTO access.permission_grant
      (id,issuer_subject,recipient_subject,scope_id,action,valid_until) VALUES ($1,$2,$2,$3,$4,now()+interval '1 hour')`,
    [randomUUID(), projectionReader.actor, scope, action]);
  }
  // Statement and page reads refuse an index behind this seed's graph.
  while (await h.stack.statementSeek.projectOnce()) { /* bounded outbox batches */ }
  if (!(await h.stack.statementSeek.coverage())?.complete) await h.stack.statementSeek.rebuild();
  // Later files open these keys from the shared object directory. A miss or an
  // unreadable revision here is the same failure they would see.
  for (const key of ['variant-of', 'holds-title', 'represents', 'in-continuity', 'appearance']) {
    const found = await h.findDefinition(key);
    expect(found?.component).toBeString();
    expect(found?.revision).toBeString();
  }
}, 600_000);
afterAll(async () => { await h?.stop(); });

test('a separately granted reader completes the public projection page within the whole request graph budget', async () => {
  await catchStatementIndex();
  const before = h.stack.fuseki.queries;
  const response = await h.call(projectionReader, 'GET', projectionPagePath());
  const graphCalls = h.stack.fuseki.queries - before;
  const body = await response.text();
  expect(response.status, body).toBe(200);
  assertProjectionPage(JSON.parse(body) as Static<typeof entityPage>);
  expect(graphCalls).toBeGreaterThan(0);
  expect(graphCalls).toBeLessThanOrEqual(WORK_READ_COST.graphCalls);
});

test('anonymous projection readers see the same public subject, episode and covered fact', async () => {
  await catchStatementIndex();
  const response = await h.call(null, 'GET', projectionPagePath(undefined, false));
  const body = await response.text();
  expect(response.status, body).toBe(200);
  assertProjectionPage(JSON.parse(body) as Static<typeof entityPage>);
});

test('hidden and absent projection pages are indistinct for signed-in and anonymous readers', async () => {
  const scope = `work:read:${data.works.railgun!.work}`;
  const absent = `https://rezics.com/id/${randomUUID()}`;
  for (const person of [projectionReader, null]) {
    const missing = await assertUnavailableProjection(await h.call(person, 'GET', projectionPagePath(absent, person !== null)));
    await h.stack.accessPool.query('UPDATE access.scope_gate SET open=false WHERE id=$1', [scope]);
    try {
      const hidden = await assertUnavailableProjection(await h.call(person, 'GET', projectionPagePath(undefined, person !== null)));
      expect(hidden).toEqual(missing);
    } finally { await h.stack.accessPool.query('UPDATE access.scope_gate SET open=true WHERE id=$1', [scope]); }
  }
});

test('the projection page final target fence observes revocation after page hydration', async () => {
  await catchStatementIndex();
  const scope = `work:read:${data.works.railgun!.work}`;
  const missing = await assertUnavailableProjection(await h.call(projectionReader, 'GET',
    projectionPagePath(`https://rezics.com/id/${randomUUID()}`)));
  const fuseki = h.stack.fuseki;
  const query = fuseki.query;
  let projectionReads = 0, revoked = false;
  fuseki.query = async (sparql, maxBytes) => {
    const result = await query.call(fuseki, sparql, maxBytes);
    if (!fuseki.isBackgroundContext && sparql.includes('SELECT ?epoch ?sequence ?hold ?r ?type')
      && sparql.includes(`VALUES ?r { <${projection('misaka-episode')}> }`) && ++projectionReads === 3) {
      // Opening target, page summary, then closing target. Revoke only once the
      // complete subject/frame/statement/relation hydration has already finished.
      await h.stack.accessPool.query('UPDATE access.scope_gate SET open=false WHERE id=$1', [scope]);
      revoked = true;
    }
    return result;
  };
  try {
    const fenced = await assertUnavailableProjection(await h.call(projectionReader, 'GET', projectionPagePath()));
    expect(revoked).toBe(true);
    expect(projectionReads).toBe(3);
    expect(fenced).toEqual(missing);
  } finally {
    fuseki.query = query;
    await h.stack.accessPool.query('UPDATE access.scope_gate SET open=true WHERE id=$1', [scope]);
  }
  assertProjectionPage(await h.json<Static<typeof entityPage>>(
    await h.call(projectionReader, 'GET', projectionPagePath())));
});

test('the scoped-subject seed grants do not open Event creation to its readers', async () => {
  for (const reader of [readers[1]!, projectionReader]) {
    const response = await h.call(reader, 'POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null,
      actingSubject: reader.actor,
      state: { component: 'resource', types: ['https://schema.org/Event'],
        properties: [{ predicate: 'https://schema.org/name',
          value: { kind: 'language-string', lexical: 'Unadmitted event', language: 'en' } }] },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'platform_closed' });
  }
});

test('Misaka keeps one Character across two Works; episode ratings and covered facts belong to the projection', async () => {
  for (const id of ['misaka-index', 'misaka-railgun']) {
    const read = await relationRecord<{ participations: { role: string; participant: { ref: string } }[] }>(data.relations[id]!.occurrence);
    expect(read.participations.find(binding => binding.role === 'subject')!.participant.ref).toBe(subject('misaka'));
  }
  const position = data.positions['railgun-episode']!;
  const repeated = await projectAgain(subject('misaka'), [position.occurrence]);
  expect(repeated.projection.id).toBe(projection('misaka-episode'));
  const read = await page(projection('misaka-episode'));
  expect(Value.Check(entityPage, read)).toBe(true);
  expect(read.projection!.subject.reference).toBe(subject('misaka'));
  expect(read.projection!.frames.map(frame => frame.reference)).toEqual([position.occurrence]);
  expect(read.target.types).not.toContain('https://rezics.com/vocab/Character');
  expect(statementIds(read.projection!.statements)).toContain(data.statements['misaka-ability']!);
  expect(statementIds(await statements(subject('misaka'), [data.works.index!.work])))
    .not.toContain(data.statements['misaka-ability']!);
  const context = data.questions.character.context;
  const before = await aggregate(context, subject('misaka'));
  expect(before).toMatchObject({ count: 5, sum: 40, mean: 8, displayThreshold: 5 });
  await h.api(readers[10]!).post('/v1/rating-observations', {
    profile: 'realm-target-rating-observation-v1', context: data.questions.performance.context,
    target: projection('misaka-episode'), expectedRevisionHead: null, value: 10, actingSubject: readers[10]!.actor,
  }, randomUUID());
  const after = await aggregate(context, subject('misaka'));
  expect([after.count, after.sum, after.mean, after.histogram]).toEqual([before.count, before.sum, before.mean, before.histogram]);
  expect(await aggregate(data.questions.performance.context, projection('misaka-episode'))).toMatchObject({ count: 11, sum: 90 });
});

test('episodes are selectable reading placements and subject discovery lists only accepting frame questions', async () => {
  for (const position of Object.values(data.positions)) {
    const read = await curator().get<{ items: { occurrence: string }[] }>(
      `/v1/reading-positions/${short(position.work)}?${acting()}&position=all`);
    expect(read.items.map(item => item.occurrence)).toContain(position.occurrence);
  }
  const discover = (on: string) => curator().get<{ items: { context: string; acceptedFrameDimensions: string[] | null }[] }>(
    `/v1/resources/${short(on)}/rating-contexts?${acting()}&scope=global&forProjection=true`);
  expect((await discover(subject('misaka'))).items).toEqual(expect.arrayContaining([
    expect.objectContaining({ context: data.questions.performance.context, acceptedFrameDimensions: ['event', 'position'] }),
  ]));
  expect((await discover(subject('misaka'))).items.map(item => item.context)).not.toContain(data.questions.unit.context);
  expect((await discover(subject('swimsuit'))).items).toEqual(expect.arrayContaining([
    expect.objectContaining({ context: data.questions.unit.context, acceptedFrameDimensions: ['release'] }),
  ]));
  expect((await discover(subject('saber-title'))).items).toEqual([]);
  expect((await contexts(projection('anakin-canon'))).items).toEqual([]);
});

test('scoped predicates and appearance directions have definition labels in every UI language', async () => {
  const facts = await statements(subject('misaka'));
  expect(facts.groups.some(group => group.predicate === data.definitions.ability)).toBe(true);
  for (const language of scopedSubjectLocales) {
    const labelled = await curator().get<{ items: { renderings: { projections: { language: string; labels: { noun: string } | null }[] }[] }[] }>(
      `/v1/lexicon/presentations?definitions=${Object.values(data.definitions).slice(-6).join(',')}&languages=${language}&${acting()}`);
    for (const item of labelled.items) expect(item.renderings.flatMap(rendering => rendering.projections)
      .some(projection => projection.language === language && !!projection.labels?.noun)).toBe(true);
  }
  const appearances = (await relations(subject('misaka'))).items.filter(item =>
    item.rendering?.meaning.definition === data.definitions.appearance);
  expect(appearances).toHaveLength(2);
  for (const item of appearances) {
    expect(item.rendering!.projections.find(projection => projection.toRole === 'work')!.labels?.noun).toBe('Appears in');
    expect(item.rendering!.projections.find(projection => projection.toRole === 'role')!.labels?.noun).toBe('Role');
  }
});

test('Artoria and Saber Alter are two Characters linked by a persona star and a separate Saber title', async () => {
  expect(subject('artoria')).not.toBe(subject('alter'));
  const variant = data.relations['alter-variant']!.occurrence;
  for (const on of ['artoria', 'alter']) expect((await relations(subject(on))).items.map(item => item.relation)).toContain(variant);
  const read = await relationRecord<{ participations: { role: string; participant: { ref: string } }[] }>(variant);
  expect(read.participations.find(item => item.role === 'kind')!.participant.ref).toBe(data.variantKind);
  for (const on of ['alter', 'saber-title']) expect((await relations(subject(on))).items.map(item => item.relation))
    .toContain(data.relations['saber-title']!.occurrence);
  const appeared = await relationRecord<{ applicability: string[]; participations: { role: string; creditedName?: object }[] }>(
    data.relations['alter-route']!.occurrence);
  expect(appeared.applicability).toEqual([data.positions['heavens-feel']!.occurrence]);
  expect(appeared.participations.find(item => item.role === 'subject')!.creditedName).toEqual({ lexical: 'Saber', language: 'en' });
  const positionPage = await page(data.positions['heavens-feel']!.occurrence);
  expect(positionPage.target.base).toBe('occurrence');
});

test('Hoshino and her swimsuit unit remain separate; represents reads both ways and the unit score stays on its release', async () => {
  expect(subject('hoshino')).not.toBe(subject('swimsuit'));
  for (const on of ['hoshino', 'swimsuit']) expect((await relations(subject(on))).items.map(item => item.relation))
    .toContain(data.relations['swimsuit-unit']!.occurrence);
  expect((await projectAgain(subject('swimsuit'), [data.release])).projection.id).toBe(projection('swimsuit-version'));
  expect(await aggregate(data.questions.unit.context, projection('swimsuit-version')))
    .toMatchObject({ target: projection('swimsuit-version'), count: 10, sum: 90, mean: 9, displayThreshold: 10 });
  expect((await contexts(subject('swimsuit'))).items).toEqual([]);
  expect((await contexts(subject('hoshino'))).items.map(item => item.context)).toContain(data.questions.character.context);
});

test('Goku has one identity; ages and forms are Statements selected by Work', async () => {
  const child = statementIds(await statements(subject('goku'), [data.works['dragon-ball']!.work]));
  const adult = statementIds(await statements(subject('goku'), [data.works['dragon-ball-z']!.work]));
  expect(child).toEqual(expect.arrayContaining([data.statements['goku-child'], data.statements['goku-base']]));
  expect(child).not.toContain(data.statements['goku-adult']!);
  expect(child).not.toContain(data.statements['goku-super-saiyan']!);
  expect(adult).toEqual(expect.arrayContaining([data.statements['goku-adult'], data.statements['goku-super-saiyan']]));
  expect(adult).not.toContain(data.statements['goku-child']!);
  for (const id of ['goku-child', 'goku-adult', 'goku-base', 'goku-super-saiyan']) {
    expect(await api().get(`/v1/statements/${short(data.statements[id]!)}`)).toMatchObject({ subject: subject('goku') });
  }
});

test('Conan and Shinichi are names of one Character; the appearance retains its own credited name', async () => {
  const semantic = await h.api(h.owner).get<{ state: { properties: { predicate: string; value: { lexical?: string } }[] } }>(
    `/v1/semantic/resources/${short(subject('conan'))}?actingSubject=${encodeURIComponent(h.owner.actor)}`);
  expect(semantic.state.properties.find(item => item.predicate === 'https://schema.org/alternateName')!.value.lexical).toBe('Kudo Shinichi');
  expect(semantic.state.properties.some(item => item.predicate === 'https://rezics.com/vocab/semanticWork')).toBe(true);
  expect((await relations(subject('conan'))).items.some(item =>
    item.rendering?.meaning.definition === data.definitions['subject-work']
      && item.rendering.projections.some(projection => projection.toRole === 'work' && projection.labels?.noun === 'Work'))).toBe(true);
  const read = await relationRecord<{ participations: { role: string; participant: { ref: string }; creditedName?: object }[] }>(
    data.relations['conan-credit']!.occurrence);
  expect(read.participations.find(item => item.role === 'subject')).toMatchObject({ participant: { ref: subject('conan') },
    creditedName: { lexical: 'Kudo Shinichi', language: 'en' } });
});

test('per-map performance withholds sparse means, declares both roll-up formulas and ranks only eligible projections', async () => {
  const context = data.questions.performance.context;
  const a = projection('player-map-a'), b = projection('player-map-b');
  expect(await aggregate(context, a)).toMatchObject({ count: 50, sum: 450, mean: 9, meanDisplay: 'shown' });
  expect(await aggregate(context, b)).toMatchObject({ count: 9, sum: 54, mean: null, meanDisplay: 'withheld-below-threshold', displayThreshold: 10 });
  const rollup = (formula: string, targets = [a, b]) => api().post<Rollup>('/v1/rating-rollups', {
    profile: 'rating-rollup-v1', context, targets, formula, rank: true,
  }, randomUUID());
  const pooled = await rollup('pooled'), means = await rollup('mean-of-means');
  expect(pooled).toMatchObject({ formula: 'pooled', memberCount: 2, coverage: { members: 2, available: 2, meetingThreshold: 1 },
    value: 504 / 59, valueWithheld: null });
  expect(means).toMatchObject({ formula: 'mean-of-means', value: 9, coverage: pooled.coverage });
  expect(means.members.find(member => member.target === b)).toMatchObject({ mean: null, meetsThreshold: false });
  expect(pooled.rank.minimumRatings).toBe(50);
  expect(pooled.rank.items.map(item => item.target)).toEqual([a]);
  const prior = pooled.rank.prior;
  // Only the prior's mean and weight are published; the weight is at least the ranking minimum.
  expect(Object.keys(prior).sort()).toEqual(['mean', 'weight']);
  expect(prior.weight).toBeGreaterThanOrEqual(50);
  expect(pooled.rank.items[0]!.score).toBeCloseTo((50 / (50 + prior.weight)) * 9
    + (prior.weight / (50 + prior.weight)) * prior.mean, 10);
  expect(await rollup('pooled', [b])).toMatchObject({ value: null, valueWithheld: 'coverage-below-half' });
  expect(await statements(subject('map-a'))).toMatchObject({ resource: subject('map-a') });
  expect(await api().get(`/v1/statements/${short(data.statements['map-in-match']!)}`))
    .toMatchObject({ subject: subject('map-a'), value: { kind: 'resource', iri: subject('match') } });
  expect(await api().get(`/v1/statements/${short(data.statements['player-in-match']!)}`))
    .toMatchObject({ subject: subject('player'), value: { kind: 'resource', iri: subject('match') } });
  for (const id of ['player-map-a', 'player-map-b']) {
    expect((await page(projection(id))).projection!.subject.reference).toBe(subject('player'));
  }
});

test('Excalibur is a Resource projected into Fate/Zero episode 24, with its own item rating', async () => {
  const read = await page(projection('excalibur-episode'));
  expect(read.projection!.subject.reference).toBe(subject('excalibur'));
  expect(read.projection!.frames.map(item => item.reference)).toEqual([data.positions['fate-zero-episode']!.occurrence]);
  expect(await aggregate(data.itemQuestion, projection('excalibur-episode')))
    .toMatchObject({ count: 5, sum: 45, mean: null, displayThreshold: 10 });
  expect((await contexts(subject('excalibur'))).items).toEqual([]);
});

test('Anakin keeps one identity across Canon and Legends; Work membership selects facts and authority declares canonicity', async () => {
  for (const [selected, excluded] of [['canon', 'legends'], ['legends', 'canon']]) {
    const explicit = statementIds(await statements(subject('anakin'), [subject(selected!)]));
    const throughWork = statementIds(await statements(subject('anakin'), [data.works[selected!]!.work]));
    expect(explicit).toContain(data.statements[`${selected}-family`]!);
    expect(explicit).not.toContain(data.statements[`${excluded}-family`]!);
    expect(throughWork).toContain(data.statements[`${selected}-family`]!);
    expect(throughWork).not.toContain(data.statements[`${excluded}-family`]!);
    for (const on of [data.works[selected!]!.work, subject(selected!)]) {
      expect((await relations(on)).items.map(item => item.relation)).toContain(data.relations[`${selected}-work`]!.occurrence);
    }
    const canonicity = await api().get(`/v1/statements/${short(data.statements[`canonicity-${selected}`]!)}`);
    expect(canonicity).toMatchObject({ speaker: data.authority, subject: data.works[selected!]!.work,
      predicate: data.definitions.canonicity, applicability: [subject(selected!)] });
  }
  const read = await page(projection('anakin-canon'));
  expect(statementIds(read.projection!.statements)).toContain(data.statements['canon-family']!);
  expect(statementIds(read.projection!.statements)).not.toContain(data.statements['legends-family']!);
});

test('the three Global questions keep one English measurement and reviewed presentations in all eight UI locales', async () => {
  const targets = { character: subject('misaka'), performance: projection('player-map-a'), unit: projection('swimsuit-version') };
  for (const spec of scopedSubjectQuestions) {
    const question = data.questions[spec.key];
    expect(question.displayThreshold).toBe(spec.targetGrain === 'projection' ? 10 : 5);
    for (const language of scopedSubjectLocales) {
      const read = await api().get(`/v1/rating-contexts/${short(question.context)}?languages=${language}`);
      expect(read).toMatchObject({ context: question.context, question: spec.labels.en, language: 'en', owner: { kind: 'global' },
        displayQuestion: { value: spec.labels[language], language, reviewStatus: language === 'en' ? 'authored' : 'reviewed', fallback: null } });
      const listed = (await contexts(targets[spec.key], language)).items.find(item => item.context === question.context)!;
      expect(listed.displayQuestion.value).toBe(spec.labels[language]);
      expect(listed.displayQuestion.presentation === null).toBe(language === 'en');
    }
  }
  for (const [target, expected] of [
    [subject('misaka'), ['character']], [subject('player'), []], [subject('swimsuit'), []],
    [projection('misaka-episode'), ['performance']], [projection('player-map-a'), ['performance']],
    [projection('swimsuit-version'), ['unit']], [projection('excalibur-episode'), []], [projection('anakin-canon'), []],
  ] as const) {
    const listed = (await contexts(target)).items.map(item => item.context);
    expect(scopedSubjectQuestions.filter(spec => listed.includes(data.questions[spec.key].context)).map(spec => spec.key)).toEqual([...expected]);
  }
  const refused = await h.call(readers[0]!, 'POST', '/v1/rating-observations', {
    profile: 'realm-target-rating-observation-v1', context: data.questions.performance.context,
    target: projection('swimsuit-version'), expectedRevisionHead: null, value: 8, actingSubject: readers[0]!.actor,
  });
  expect(refused.status).toBe(422);
  expect(await refused.json()).toMatchObject({ code: 'rating_target_not_accepted' });
}, 30_000);
