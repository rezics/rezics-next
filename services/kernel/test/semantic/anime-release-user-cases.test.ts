import { afterAll, beforeAll, expect, test } from 'bun:test';
import { releaseDigest } from '@rezics/definitions';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { HttpResponse, Statement, StatementInput, Subject } from '../../../../specs/semantic-driver.ts';
import {
  compiledProfile,
  launchProfiles,
  legacyProfile,
  libraryProfile,
} from '../../../../packages/definitions/test/support/library-profiles.ts';
import { selectLibraryProfile } from '../../src/library/profile.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  discoveryStatement,
  type CreatedSubject,
  type DiscoveryPersona,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

const releaseType = 'rezics:AnimeRelease';
const locales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
let fixture: ReleasedDiscoveryFixture;
beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture({ version: 1 });
}, 180_000);
afterAll(async () => {
  await fixture?.close();
}, 180_000);

function ok(response: HttpResponse, status = 200) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return response.body;
}
function subject(response: HttpResponse): Subject {
  return ok(response).subject as Subject;
}
function facts(value: Subject, property: string): Statement[] {
  return value.statements[property] ?? [];
}
function problem(response: HttpResponse, status: number, code: string) {
  ok(response, status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  expect(response.body.code).toBe(code);
}
function labels(value: Record<string, string> | undefined) {
  expect(value).toBeDefined();
  for (const locale of locales) expect(value?.[locale]?.trim().length).toBeGreaterThan(0);
}
const snak = (property: string, content: StatementInput['value']['content']) => ({
  property: { id: property },
  value: { type: 'value' as const, content },
});

async function adopted(holder: CreatedSubject, input: StatementInput) {
  const receipt = await fixture.adopt(holder, input);
  expect(receipt.subject).toBe(holder.id);
  expect(receipt.release).toBe(bundledDigest);
  expect(receipt.acceptanceHead).toBeGreaterThan(0);
  expect(receipt.adoptionHead).toBeGreaterThan(0);
  expect(receipt.revision).toBeGreaterThan(holder.revision);
  const response = await fixture.read(holder);
  const value = subject(response);
  const matches = facts(value, input.property.id).filter((s) => s.value.content === input.value.content);
  expect(matches).toHaveLength(1);
  const fact = matches[0]!;
  expect(fact.rank).toBe(input.rank ?? 'normal');
  expect(fact.rezics.release).toBe(bundledDigest);
  expect(fact.qualifiers.map((q) => ({ property: { id: q.property.id }, value: q.value }))).toEqual(
    input.qualifiers ?? [],
  );
  expect(
    fact.references.map((r) => ({ parts: r.parts.map((p) => ({ property: { id: p.property.id }, value: p.value })) })),
  ).toEqual(input.references ?? []);
  for (const reference of fact.references) expect(reference.hash.length).toBeGreaterThan(0);
  return { value, fact, response };
}

async function collection(visibility: 'public' | 'unlisted' | 'private') {
  const response = await fixture.request(
    'alice',
    'POST',
    '/v1/collections',
    {
      title: 'Independently identified anime publications',
      visibility,
    },
    discoveryKey(),
  );
  return ok(response, 201).collection as { id: string };
}
async function members(id: string, persona: DiscoveryPersona = 'anonymous') {
  return ok(await fixture.request(persona, 'GET', `/v1/collections/${id}/members?limit=10`));
}

// The expected 201 is deliberate: an absent bundled type answering 422 is a native red,
// not a successful unsupported-feature control. No replacement release or fixture database.
test('anime release is a distinct publicly readable catalogue subject with work and anthology relations and no library profile', async () => {
  const single = await fixture.createSubject(releaseType, 'Identified bilingual publication');
  const definition = fixture.release.definition;
  expect(fixture.release.digest).toBe(bundledDigest);
  expect(definition).toEqual(bundledRelease);
  expect(releaseDigest(definition)).toBe(bundledDigest);
  const type = definition.types[releaseType]!;
  expect(type).toBeDefined();
  expect(type.iri).toBe('https://rezics.com/vocab/AnimeRelease');
  expect(type.bases).toEqual(['schema:CreativeWork', 'schema:Thing']);
  expect(type.schemaOrgType).toBe('https://schema.org/CreativeWork');
  expect(type.mappings).toEqual([]);
  expect(type.library).toBeUndefined();
  labels(type.labels);
  for (const property of [
    'schema:exampleOfWork',
    'bf:hasPart',
    'marcrel:fds',
    'schema:inLanguage',
    'schema:datePublished',
    'wdt:P437',
  ])
    expect(type.properties).toContain(property);
  expect(definition.properties['schema:exampleOfWork']!.targets).toEqual(['schema:CreativeWork']);
  expect(definition.properties['schema:exampleOfWork']!.relation).toMatchObject({
    group: 'derivation',
    inverse: 'schema:workExample',
    order: 'date',
    acyclic: true,
  });
  expect(definition.properties['bf:hasPart']).toMatchObject({
    iri: 'http://id.loc.gov/ontologies/bibframe/hasPart',
    datatype: 'wikibase-item',
    multivalued: true,
    targets: ['schema:Episode', 'schema:Movie', 'schema:TVSeason', 'schema:TVSeries'],
    relation: { group: 'membership', inverse: 'bf:partOf', order: 'name', acyclic: true },
  });
  expect(definition.properties['marcrel:fds']).toMatchObject({
    iri: 'http://id.loc.gov/vocabulary/relators/fds',
    datatype: 'wikibase-item',
    multivalued: true,
    targets: ['schema:Organization', 'schema:Person'],
    qualifiers: ['schema:position', 'wdt:P1932', 'wdt:P3831', 'wdt:P518'],
    relation: { group: 'credit', inverse: 'rezics:filmDistributionOf', order: 'position' },
  });
  for (const property of ['bf:hasPart', 'marcrel:fds']) {
    labels(definition.properties[property]!.labels);
    labels(definition.properties[property]!.relation!.inverseLabels);
  }

  const work = await fixture.createSubject('schema:TVSeries', 'Anime work');
  const film = await fixture.createSubject('schema:Movie', 'Independent anime film work');
  const anthology = await fixture.createSubject(releaseType, 'One identified anthology publication');
  const distributor = await fixture.createSubject('schema:Organization', 'Publication distributor');
  const role = await fixture.createSubject('skos:Concept', 'Distribution role supplied by contributor');
  await adopted(single, discoveryStatement('schema:exampleOfWork', work.id));
  await adopted(single, discoveryStatement('schema:inLanguage', 'ja'));
  // Resource languages describe one identified publication, never UI locales or new release IDs.
  const bilingual = await fixture.createSubject(
    releaseType,
    'Second independently identified multilingual publication',
    {
      'schema:inLanguage': [
        discoveryStatement('schema:inLanguage', 'ja'),
        discoveryStatement('schema:inLanguage', 'en'),
      ],
    },
  );
  await adopted(bilingual, discoveryStatement('schema:exampleOfWork', work.id));
  expect(
    facts(subject(await fixture.read(bilingual)), 'schema:inLanguage')
      .map((s) => s.value.content)
      .sort(),
  ).toEqual(['en', 'ja']);
  await adopted(anthology, discoveryStatement('bf:hasPart', work.id));
  await adopted(anthology, discoveryStatement('bf:hasPart', film.id));
  const credit = discoveryStatement('marcrel:fds', distributor.id);
  credit.qualifiers = [
    snak('wdt:P1932', 'Contributor supplied distribution credit'),
    snak('schema:position', '1'),
    snak('wdt:P3831', role.id),
  ];
  credit.rank = 'normal';
  const distributed = await adopted(single, credit);
  expect(
    (distributed.response.body.related as Record<string, { labels: Record<string, string> }>)[distributor.id]!.labels
      .en,
  ).toContain('Publication distributor');
  for (const persona of ['anonymous', 'outsider', 'bob'] as const) {
    const read = subject(await fixture.read(single, persona));
    expect(read.type).toBe(releaseType);
    expect(facts(read, 'schema:exampleOfWork').map((s) => s.value.content)).toEqual([work.id]);
    expect(facts(read, 'marcrel:fds')).toEqual(facts(distributed.value, 'marcrel:fds'));
  }
  const contained = subject(await fixture.read(anthology));
  expect(
    facts(contained, 'bf:hasPart')
      .map((s) => s.value.content)
      .sort(),
  ).toEqual([work.id, film.id].sort());
  expect(facts(contained, 'schema:exampleOfWork')).toEqual([]);
  expect(facts(subject(await fixture.read(work)), 'marcrel:fds')).toEqual([]);
  expect(facts(subject(await fixture.read(film)), 'bf:hasPart')).toEqual([]);
  expect(new Set([single.id, bilingual.id, anthology.id, work.id, film.id]).size).toBe(5);

  // Actual mounted current API for work releases/editions discovery; not a Web page witness.
  await fixture.catchUp([single, bilingual, anthology, work, film, distributor, role]);
  const inverse = ok(
    await fixture.request(
      'anonymous',
      'GET',
      `/v1/subjects/${work.id}/links?property=schema%3AexampleOfWork&type=rezics%3AAnimeRelease&limit=10`,
    ),
  );
  const links = inverse.links as { subject: string; type: string }[];
  expect(links.map((link) => link.subject).sort()).toEqual([single.id, bilingual.id].sort());
  expect(links.every((link) => link.type === releaseType)).toBe(true);
  expect(inverse.next).toBeNull();
  const forward = ok(
    await fixture.request('anonymous', 'GET', `/v1/subjects/${anthology.id}/relations?property=bf%3AhasPart&limit=10`),
  );
  expect((forward.relations as { target: string }[]).map((row) => row.target).sort()).toEqual(
    [work.id, film.id].sort(),
  );
  expect(forward.next).toBeNull();

  for (const visibility of ['public', 'unlisted', 'private'] as const) {
    const curated = await collection(visibility);
    const added = ok(
      await fixture.request(
        'alice',
        'POST',
        `/v1/collections/${curated.id}/members`,
        { subjectId: single.id, note: 'An identified release, not a work tracking state' },
        discoveryKey(),
      ),
      201,
    );
    expect(added.member).toMatchObject({
      subjectId: single.id,
      note: 'An identified release, not a work tracking state',
    });
    for (const persona of ['anonymous', 'outsider', 'bob'] as const) {
      if (visibility === 'private') {
        for (const suffix of ['', '/members'])
          problem(await fixture.request(persona, 'GET', `/v1/collections/${curated.id}${suffix}`), 404, 'not_found');
      } else {
        const page = await members(curated.id, persona);
        expect((page.members as { subjectId: string }[]).map((row) => row.subjectId)).toEqual([single.id]);
        expect(page.next).toBeNull();
      }
    }
    const before = await members(curated.id, 'alice');
    const denied = await fixture.request(
      'outsider',
      'POST',
      `/v1/collections/${curated.id}/members`,
      { subjectId: anthology.id },
      discoveryKey(),
    );
    problem(denied, 404, 'not_found');
    expect(denied.body.effect_status).toBe('not_applied');
    expect(await members(curated.id, 'alice')).toEqual(before);
  }
  const before = subject(await fixture.read(single));
  const denied = await fixture.request(
    'outsider',
    'POST',
    `/v1/subjects/${single.id}:adopt`,
    {
      context: before.context,
      property: 'schema:exampleOfWork',
      target: work.id,
      mode: 'replace',
      selection: [],
      expected_head: null,
    },
    discoveryKey(),
  );
  problem(denied, 403, 'forbidden');
  expect(denied.body.effect_status).toBe('not_applied');
  expect(subject(await fixture.read(single))).toEqual(before);
}, 120_000);

test('release grain preserves independent work season episode identities and existing eleven tracking profiles', async () => {
  const definition = fixture.release.definition;
  // This checks actual HTTP bundle data, not a synthetic launch profile registry.
  const expectedProfiles = Object.fromEntries(launchProfiles.map(([, , type, id]) => [type, { profileId: id }]));
  const actualProfiles = Object.fromEntries(
    Object.entries(definition.types)
      .filter(([, type]) => type.library !== undefined)
      .map(([id, type]) => [id, type.library]),
  );
  expect(actualProfiles).toEqual(expectedProfiles);
  for (const [, , type, id, unit] of launchProfiles) {
    expect<unknown>(definition.libraryProfiles?.[id]).toEqual(compiledProfile(libraryProfile(id, unit)));
    expect(selectLibraryProfile(definition, type)?.id).toBe(id);
  }
  expect<unknown>(definition.libraryProfiles?.['legacy-fixed-v1']).toEqual(compiledProfile(legacyProfile()));
  expect(Object.keys(definition.libraryProfiles ?? {}).sort()).toEqual(
    [...launchProfiles.map(([, , , id]) => id), 'legacy-fixed-v1'].sort(),
  );

  const work = await fixture.createSubject('schema:TVSeries', 'Independent work without mandatory season');
  const season = await fixture.createSubject('schema:TVSeason', 'Independent season');
  const episode = await fixture.createSubject('schema:Episode', 'Independent episode');
  const standalone = await fixture.createSubject('schema:Episode', 'Episode without filler ancestors');
  const film = await fixture.createSubject('schema:Movie', 'Movie remains anime film work');
  const release = await fixture.createSubject(releaseType, 'Independently identified season publication');
  await adopted(episode, discoveryStatement('schema:isPartOf', season.id));
  await adopted(episode, discoveryStatement('schema:episodeNumber', '01'));
  await adopted(release, discoveryStatement('schema:exampleOfWork', season.id));
  const episodeRelease = await fixture.createSubject(releaseType, 'Independently identified episode publication');
  await adopted(episodeRelease, discoveryStatement('schema:exampleOfWork', standalone.id));
  const filmRelease = await fixture.createSubject(releaseType, 'Independently identified film publication');
  await adopted(filmRelease, discoveryStatement('schema:exampleOfWork', film.id));
  const subjects = [
    [work, 'schema:TVSeries'],
    [season, 'schema:TVSeason'],
    [episode, 'schema:Episode'],
    [standalone, 'schema:Episode'],
    [film, 'schema:Movie'],
    [release, releaseType],
    [episodeRelease, releaseType],
    [filmRelease, releaseType],
  ] as const;
  expect(new Set(subjects.map(([value]) => value.id)).size).toBe(subjects.length);
  for (const [created, type] of subjects) {
    const read = subject(await fixture.read(created));
    expect(read.id).toBe(created.id);
    expect(read.type).toBe(type);
    expect(read.release).toBe(bundledDigest);
  }
  for (const created of [work, season, standalone])
    expect(facts(subject(await fixture.read(created)), 'schema:isPartOf')).toEqual([]);
  for (const created of [release, episodeRelease, filmRelease]) {
    const read = subject(await fixture.read(created));
    expect(facts(read, 'schema:episodeNumber')).toEqual([]);
    expect(facts(read, 'schema:isPartOf')).toEqual([]);
    expect(facts(read, 'schema:version')).toEqual([]);
  }
  expect(definition.types[releaseType]!.library).toBeUndefined();
  // Production selector returns no descriptor at all: no entry states, sessions or holdings,
  // including no inheritance/fallback to Movie, Book Edition, game release or legacy-fixed-v1.
  expect(selectLibraryProfile(definition, releaseType)).toBeNull();
  expect(definition.types['bf:Instance']!.iri).toBe('http://id.loc.gov/ontologies/bibframe/Instance');
  expect(definition.types['wd:Q20631656']!.iri).toBe('http://www.wikidata.org/entity/Q20631656');
  expect(definition.types['schema:Movie']!.library?.profileId).toBe('anime.film');
  expect(definition.types['bf:Instance']!.library?.profileId).toBe('book.edition');
  expect(definition.types['wd:Q20631656']!.library?.profileId).toBe('game.release');
}, 120_000);
