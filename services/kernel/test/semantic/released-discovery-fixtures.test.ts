import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { releaseDigest } from '@rezics/definitions';
import { validateFilter } from '@rezics/filter';
import type { HttpResponse, Statement, Subject } from '../../../../specs/semantic-driver.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  discoveryStatement,
  type CreatedSubject,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

let fixture: ReleasedDiscoveryFixture;
beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture({ version: 1 });
}, 180_000);
afterAll(async () => {
  await fixture?.close();
}, 180_000);

function subject(response: HttpResponse): Subject {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.subject as Subject;
}
function fact(value: Subject, property: string): Statement {
  expect(value.statements[property], `Missing public ${property} on ${value.id}`).toHaveLength(1);
  return value.statements[property]![0]!;
}
function problem(response: HttpResponse, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  expect(response.body).toMatchObject({ status, code });
}

test('versioned shared native discovery fixtures use the actual released Book Recipe classification and profile data and real created IDs', async () => {
  expect(fixture.version).toBe(1);
  expect(fixture.release.digest).toBe(bundledDigest);
  expect(fixture.release.definition).toEqual(bundledRelease);
  expect(releaseDigest(fixture.release.definition)).toBe(bundledDigest);
  const definition = fixture.release.definition;
  const required = {
    bookWords: definition.types['schema:Book']!.facets.includes('schema:wordCount'),
    bookForm: definition.types['schema:Book']!.facets.includes('wdt:P7937'),
    recipeDiet: definition.types['schema:Recipe']!.facets.includes('schema:suitableForDiet'),
    recipeTime: definition.types['schema:Recipe']!.facets.includes('schema:cookTime'),
    bookProfile: Boolean(definition.types['schema:Book']!.library?.profileId),
    recipeProfile: Boolean(definition.types['schema:Recipe']!.library?.profileId),
    gameProfile: Boolean(definition.types['schema:VideoGame']!.library?.profileId),
  };
  expect(required, `Observed bundled/HTTP release ${bundledDigest}`).toEqual({
    bookWords: true,
    bookForm: true,
    recipeDiet: true,
    recipeTime: true,
    bookProfile: true,
    recipeProfile: true,
    gameProfile: true,
  });
  for (const type of ['schema:Book', 'schema:Recipe', 'schema:VideoGame']) {
    const id = definition.types[type]!.library!.profileId;
    expect(definition.libraryProfiles?.[id]?.id).toBe(id);
    expect(definition.libraryProfiles?.[id]?.entryStateSet?.states.length).toBeGreaterThan(0);
  }
}, 120_000);

test('public classification Concepts retain real scheme membership, reviewed source scope, acceptance pins and citations', async () => {
  const c = await fixture.classification();
  expect(new Set([c.formScheme.id, c.sourceScheme.id, c.lightNovel.id, c.otherForm.id, c.harem.id]).size).toBe(5);
  for (const [concept, scheme] of [
    [c.lightNovel, c.formScheme],
    [c.otherForm, c.formScheme],
    [c.harem, c.sourceScheme],
  ] as const) {
    const value = subject(await fixture.read(concept));
    expect(value.type).toBe('skos:Concept');
    const membership = fact(value, 'skos:inScheme');
    expect(membership.value).toEqual({ type: 'value', content: scheme.id });
    expect(membership.rank).toBe('preferred');
    expect(membership.rezics.release).toBe(bundledDigest);
    expect(membership.references[0]!.parts[0]!.value.content).toBe(
      'https://example.org/released-discovery/v1/controlled-assertions',
    );
    expect(subject(await fixture.read(scheme)).type).toBe('skos:ConceptScheme');
  }
  expect(fact(subject(await fixture.read(c.lightNovel)), 'schema:sameAs').value.content).toBe(
    fixture.meaning.lightNovel,
  );
  const harem = subject(await fixture.read(c.harem));
  expect(fact(harem, 'schema:url').value.content).toBe('https://bgm.tv/wiki/tag/list?type=1');
  expect(harem.statements['schema:sameAs'] ?? []).toEqual([]);
  expect(fixture.meaning.harem).toEqual({
    source: 'bangumi',
    field: 'meta_tags',
    member: '后宫',
    canonicalRelation: 'close',
  });
  for (const adopted of c.facts) {
    expect(adopted.acceptanceHead).toBeGreaterThan(0);
    expect(adopted.adoptionHead).toBeGreaterThan(0);
    expect(adopted.release).toBe(bundledDigest);
  }
}, 120_000);

test('meaningful API outcomes expose missing words form harem diet cooking time without a testonly release or fake binding', async () => {
  // Each write must succeed as a real released fact. Unsupported admission never counts as completing the job.
  const c = await fixture.classification();
  const d = await fixture.diet();
  const book = await fixture.createSubject('schema:Book', 'Released predicate admission control');
  const recipe = await fixture.createSubject('schema:Recipe', 'Released recipe admission control');
  const observed: { property: string; status: number; body: unknown }[] = [];
  for (const [holder, statement] of [
    [book, discoveryStatement('schema:wordCount', { amount: '+1200001', unit: '1' })],
    [book, discoveryStatement('wdt:P7937', c.lightNovel.id)],
    [book, discoveryStatement('schema:keywords', c.harem.id)],
    [recipe, discoveryStatement('schema:suitableForDiet', d.vegetarian.id)],
    [recipe, discoveryStatement('schema:cookTime', { amount: '+25', unit: fixture.meaning.minuteStorage })],
  ] as const) {
    const response = await fixture.request(
      'editor',
      'POST',
      `/v1/subjects/${holder.id}/candidates`,
      { statement },
      discoveryKey(),
    );
    observed.push({ property: statement.property.id, status: response.status, body: response.body });
  }
  expect(
    observed.map(({ property, status }) => ({ property, status })),
    JSON.stringify(observed),
  ).toEqual([
    { property: 'schema:wordCount', status: 201 },
    { property: 'wdt:P7937', status: 201 },
    { property: 'schema:keywords', status: 201 },
    { property: 'schema:suitableForDiet', status: 201 },
    { property: 'schema:cookTime', status: 201 },
  ]);
}, 120_000);

test('compact and expanded Book facts preserve qualifier support and release pins while competing candidates stay unselected', async () => {
  const c = await fixture.classification();
  const input = {
    ...discoveryStatement('schema:keywords', c.harem.id),
    qualifiers: [
      {
        property: { id: 'rezics:spoilerLevel' },
        value: { type: 'value' as const, content: { amount: '+1', unit: '1' } },
      },
    ],
  };
  const compact = await fixture.createSubject('schema:Book', 'Compact classification control', {
    'schema:keywords': [input],
  });
  const expanded = await fixture.createSubject('schema:Book', 'Expanded classification control');
  const receipt = await fixture.adopt(expanded, input);
  await fixture.catchUp([compact, expanded]);
  const a = fact(subject(await fixture.read(compact)), 'schema:keywords');
  const b = fact(subject(await fixture.read(expanded)), 'schema:keywords');
  expect(b).toMatchObject({
    property: a.property,
    value: a.value,
    qualifiers: a.qualifiers,
    references: a.references,
    rank: 'preferred',
  });
  expect(a.rezics).toEqual({ release: bundledDigest, revision: 1 });
  expect(b.rezics.release).toBe(bundledDigest);
  expect(b.id).toBe(receipt.candidate);
  expect(a.qualifiers).toMatchObject(input.qualifiers);
  expect(a.references[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  const before = subject(await fixture.read(expanded));
  const alternative = await fixture.request(
    'editor',
    'POST',
    `/v1/subjects/${expanded.id}/candidates`,
    {
      statement: {
        ...input,
        qualifiers: [
          { property: { id: 'rezics:spoilerLevel' }, value: { type: 'value', content: { amount: '+2', unit: '1' } } },
        ],
      },
    },
    discoveryKey(),
  );
  expect(alternative.status, JSON.stringify(alternative.body)).toBe(201);
  expect(fact(subject(await fixture.read(expanded)), 'schema:keywords')).toEqual(b);
  const rejected = await fixture.request(
    'acceptor',
    'POST',
    `/v1/subjects/${expanded.id}/candidates/${alternative.body.candidate}:reject`,
    {
      context: before.context,
      expected_head: null,
    },
    discoveryKey(),
  );
  expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
  const shown = subject(await fixture.read(expanded)).statements['schema:keywords']!;
  expect(shown.filter((s) => s.rank !== 'deprecated')).toEqual([b]);
  expect(shown.find((s) => s.id === alternative.body.candidate)).toMatchObject({
    rank: 'deprecated',
    value: input.value,
    references: b.references,
    rezics: { release: bundledDigest },
  });
}, 120_000);

test('released word count admits nonnegative integer unit one and Book facet while form reuses P7937', async () => {
  const release = fixture.release.definition;
  expect(
    release.properties['schema:wordCount'],
    `Absent in actual HTTP release ${fixture.release.digest}`,
  ).toMatchObject({
    datatype: 'quantity',
    minimum: 0,
    units: ['1'],
  });
  expect(release.types['schema:Book']!.facets).toContain('schema:wordCount');
  expect(release.types['schema:Book']!.facets).toContain('wdt:P7937');
  expect(release.properties['wdt:P7937']!.datatype).toBe('wikibase-item');
  const book = await fixture.createSubject('schema:Book', 'Exact word quantity validation');
  await fixture.adopt(book, discoveryStatement('schema:wordCount', { amount: '+0', unit: '1' }));
  expect(fact(subject(await fixture.read(book)), 'schema:wordCount').value.content).toEqual({
    amount: '+0',
    unit: '1',
  });
  const before = subject(await fixture.read(book));
  for (const content of [
    { amount: '-1', unit: '1' },
    { amount: '+1.5', unit: '1' },
    { amount: '+1', unit: fixture.meaning.minuteStorage },
  ]) {
    const response = await fixture.request(
      'editor',
      'POST',
      `/v1/subjects/${book.id}/candidates`,
      {
        statement: discoveryStatement('schema:wordCount', content),
      },
      discoveryKey(),
    );
    problem(response, 400, 'invalid_request');
    expect(response.body.effect_status).toBe('not_applied');
  }
  expect(subject(await fixture.read(book))).toEqual(before);
}, 120_000);

test('Book public facts distinguish strict million threshold, unknown evidence, characters and edition pages', async () => {
  const b = await fixture.books();
  const expected = { 'B-long': '+1200001', 'B-edge': '+1000000', 'B-short': '+999999' };
  for (const [name, amount] of Object.entries(expected)) {
    const value = subject(await fixture.read(b.subjects[name as keyof typeof expected]));
    expect(value.type).toBe('schema:Book');
    expect(fact(value, 'schema:wordCount').value.content).toEqual({ amount, unit: '1' });
  }
  for (const name of ['B-unknown', 'B-characters'] as const)
    expect(subject(await fixture.read(b.subjects[name])).statements['schema:wordCount'] ?? []).toEqual([]);
  const c = await fixture.classification();
  for (const name of ['B-long', 'B-edge', 'B-characters', 'B-form-only'] as const)
    expect(fact(subject(await fixture.read(b.subjects[name])), 'wdt:P7937').value.content).toBe(c.lightNovel.id);
  expect(fact(subject(await fixture.read(b.subjects['B-tag-only'])), 'wdt:P7937').value.content).toBe(c.otherForm.id);
  for (const name of ['B-short', 'B-form-only'] as const)
    expect(subject(await fixture.read(b.subjects[name])).statements['schema:keywords'] ?? []).toEqual([]);
  const edition = subject(await fixture.read(b.edition));
  expect(edition.type).toBe('bf:Instance');
  expect(fact(edition, 'schema:numberOfPages').value.content).toEqual({ amount: '+1400000', unit: '1' });
  expect(edition.statements['schema:wordCount'] ?? []).toEqual([]);
  // Character property and measurement association are explicit producer prerequisites in this version.
  // This case proves only the facts above; it cannot certify a character or measurement producer.
}, 120_000);

test('diet uses a public adopted VegetarianDiet Concept and released Recipe facet rather than a label heuristic', async () => {
  const d = await fixture.diet();
  const value = subject(await fixture.read(d.vegetarian));
  expect(fact(value, 'schema:sameAs').value.content).toBe('https://schema.org/VegetarianDiet');
  expect(fact(value, 'skos:inScheme').value.content).toBe(d.scheme.id);
  expect(fixture.release.definition.properties['schema:suitableForDiet']).toMatchObject({
    datatype: 'wikibase-item',
    targets: ['skos:Concept'],
  });
  expect(fixture.release.definition.types['schema:Recipe']!.facets).toContain('schema:suitableForDiet');
  const recipe = await fixture.createSubject('schema:Recipe', 'Diet public adoption');
  await fixture.adopt(recipe, discoveryStatement('schema:suitableForDiet', d.vegetarian.id));
  expect(fact(subject(await fixture.read(recipe)), 'schema:suitableForDiet').value.content).toBe(d.vegetarian.id);
}, 120_000);

test('authored Recipe instructions and ingredients use Content hooks and cookTime preserves integer minute storage', async () => {
  expect(fixture.release.definition.properties['schema:cookTime']).toMatchObject({
    datatype: 'quantity',
    minimum: 0,
    units: ['http://www.wikidata.org/entity/Q7727'],
  });
  const recipe = await fixture.authoredRecipe('Independent authored time control', 25);
  const value = subject(await fixture.read(recipe));
  expect(fact(value, 'schema:cookTime').value.content).toEqual({
    amount: '+25',
    unit: 'http://www.wikidata.org/entity/Q7727',
  });
  expect(fact(value, 'schema:recipeIngredient').value.content).toMatchObject({
    language: 'en',
    text: expect.any(String),
  });
  const document = fact(value, 'schema:recipeInstructions').value.content;
  expect(document).toMatchObject({
    language: 'en',
    document: expect.any(String),
    digest: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  const reference = document as { document: string };
  const content = await fixture.request('anonymous', 'GET', `/v1/documents/${reference.document}`);
  expect(content.status, JSON.stringify(content.body)).toBe(200);
  expect(content.body.document).toMatchObject({
    origin: 'account',
    licence: 'CC-BY-4.0',
    availability: 'available',
    language: 'en',
    body: expect.any(Object),
  });
  const before = subject(await fixture.read(recipe));
  const invalid = await fixture.request(
    'editor',
    'POST',
    `/v1/subjects/${recipe.id}/candidates`,
    {
      statement: discoveryStatement('schema:cookTime', { amount: '+25.5', unit: fixture.meaning.minuteStorage }),
    },
    discoveryKey(),
  );
  problem(invalid, 400, 'invalid_request');
  expect(subject(await fixture.read(recipe))).toEqual(before);
}, 120_000);

test('Recipe public diet and cooking populations admit the same released filter units and exact boundary values', async () => {
  const recipes = await fixture.recipes();
  const c = await fixture.classification();
  const d = await fixture.diet();
  const filters = fixture.filters(c, d);
  for (const filter of Object.values(filters)) expect(validateFilter(filter, fixture.release.definition)).toEqual([]);
  for (const [name, minutes] of [
    ['R-quick', 25],
    ['R-edge', 30],
    ['R-slow', 31],
    ['R-meat', 20],
    ['R-unknown', 20],
    ['R-cooked', 20],
    ['R-other-cooked', 20],
  ] as const) {
    const value = subject(await fixture.read(recipes.subjects[name]));
    expect(fact(value, 'schema:cookTime').value.content).toEqual({
      amount: `+${minutes}`,
      unit: fixture.meaning.minuteStorage,
    });
    if (name === 'R-unknown') expect(value.statements['schema:suitableForDiet'] ?? []).toEqual([]);
    else
      expect(fact(value, 'schema:suitableForDiet').value.content).toBe(
        name === 'R-meat' ? d.nonvegetarian.id : d.vegetarian.id,
      );
  }
  // Commerce's completed-session producer is required before either cooked logical name proves personal history.
}, 120_000);

test('revoked suspension bearers remain distinct from required valid suspended403 and outsider private writes have no unintended effects', async () => {
  const book = await fixture.createSubject('schema:Book', 'Authority control');
  // The existing native suspension command fences authentication and revokes this pre-suspension bearer.
  // It is a revoked401 control; privacy.required names the missing current suspended403 producer explicitly.
  for (const path of ['/v1/definitions/active', `/v1/definitions/releases/${bundledDigest}`, `/v1/subjects/${book.id}`])
    problem(await fixture.request('suspended', 'GET', path), 401, 'invalid_credentials');
  problem(
    await fixture.request(
      'suspended',
      'POST',
      '/v1/subjects',
      { type: 'schema:Book', labels: { en: 'Denied' } },
      discoveryKey(),
    ),
    401,
    'invalid_credentials',
  );
  const before = subject(await fixture.read(book));
  const denied = await fixture.request(
    'outsider',
    'POST',
    `/v1/subjects/${book.id}:adopt`,
    {
      context: before.context,
      property: 'schema:keywords',
      mode: 'replace',
      selection: [],
      expected_head: null,
    },
    discoveryKey(),
  );
  expect(denied.status, JSON.stringify(denied.body)).toBe(403);
  expect(denied.body.effect_status).toBe('not_applied');
  expect(subject(await fixture.read(book))).toEqual(before);
  const created = await fixture.request(
    'alice',
    'POST',
    '/v1/collections',
    { title: 'Private discovery control', visibility: 'private' },
    discoveryKey(),
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const collection = created.body.collection as CreatedSubject;
  for (const persona of ['anonymous', 'bob', 'outsider'] as const)
    problem(await fixture.request(persona, 'GET', `/v1/collections/${collection.id}`), 404, 'not_found');
  for (const headers of [{}, { authorization: 'Bearer invalid-discovery-token' }])
    expect(
      (
        await fixture.request(
          'anonymous',
          'POST',
          '/v1/subjects',
          { type: 'schema:Book', labels: { en: 'No bearer authority' } },
          { ...discoveryKey(), ...headers },
        )
      ).status,
    ).toBe(401);
}, 120_000);
