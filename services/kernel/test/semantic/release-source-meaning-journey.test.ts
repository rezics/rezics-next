import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { HttpResponse, Statement, StatementInput, Subject } from '../../../../specs/semantic-driver.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  discoveryStatement,
  type CreatedSubject,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

const locales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
const calendar = 'http://www.wikidata.org/entity/Q1985727';
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
const snak = (property: string, content: StatementInput['value']['content']) => ({
  property: { id: property },
  value: { type: 'value' as const, content },
});
const unknownDate = (property: string): StatementInput => ({
  property: { id: property },
  value: { type: 'somevalue' },
  rank: 'preferred',
  references: discoveryStatement('schema:url', 'https://example.org/released-discovery/v1/tba').references,
});

async function adopted(holder: CreatedSubject, input: StatementInput) {
  const receipt = await fixture.adopt(holder, input);
  expect(receipt.subject).toBe(holder.id);
  expect(receipt.release).toBe(bundledDigest);
  return receipt;
}

async function scheme(uri: string, label: string) {
  const created = await fixture.createSubject('skos:ConceptScheme', label);
  await adopted(created, discoveryStatement('schema:url', uri));
  await adopted(created, discoveryStatement('schema:sameAs', uri));
  return created;
}

async function concept(schemeHolder: CreatedSubject, uri: string, label: string) {
  const created = await fixture.createSubject('skos:Concept', label);
  await adopted(created, discoveryStatement('skos:inScheme', schemeHolder.id));
  await adopted(created, discoveryStatement('schema:url', uri));
  await adopted(created, discoveryStatement('schema:sameAs', uri));
  return created;
}

test('sourced release status, directed release targets and episode kinds keep their meaning through native adoption and the composed page', async () => {
  const definition = fixture.release.definition;
  expect(fixture.release.digest).toBe(bundledDigest);
  expect(definition).toEqual(bundledRelease);
  expect(definition.types['wd:Q20631656']!.bases).toEqual([]);
  expect(definition.types['wd:Q20631656']!.properties).toEqual(
    expect.arrayContaining(['wdt:P155', 'schema:creativeWorkStatus', 'schema:exampleOfWork']),
  );
  expect(definition.properties['wdt:P155']!.targets).toEqual(['schema:CreativeWork', 'wd:Q20631656']);
  expect(definition.properties['schema:exampleOfWork']!.qualifiers).toContain('wdt:P31');
  for (const locale of locales) {
    expect(definition.properties['schema:creativeWorkStatus']!.labels[locale]?.trim().length).toBeGreaterThan(0);
    expect(definition.properties['schema:creativeWorkStatus']!.relation!.inverseLabels![locale]?.trim().length).toBeGreaterThan(
      0,
    );
  }

  const development = await scheme('https://vndb.org/development-status', 'VNDB development status');
  const finished = await concept(development, 'https://vndb.org/development-status/0', 'Finished');
  const inDevelopment = await concept(development, 'https://vndb.org/development-status/1', 'In development');
  const completeness = await scheme('https://rezics.com/schemes/vndb/release-types', 'VNDB release completeness');
  const complete = await concept(completeness, 'https://rezics.com/schemes/vndb/release-types/complete', 'Complete');
  const trial = await concept(completeness, 'https://rezics.com/schemes/vndb/release-types/trial', 'Trial');
  const episodeTypes = await scheme('https://rezics.com/schemes/bangumi/episode-types', 'Bangumi episode types');
  const mainStory = await concept(episodeTypes, 'https://rezics.com/schemes/bangumi/episode-types/0', 'Main story');
  const special = await concept(episodeTypes, 'https://rezics.com/schemes/bangumi/episode-types/1', 'Special');

  const work = await fixture.createSubject('wd:Q689445', 'Visual novel work');
  await adopted(work, discoveryStatement('schema:creativeWorkStatus', finished.id));
  const prior = await fixture.createSubject('wd:Q20631656', 'Prior complete release');
  const current = await fixture.createSubject('wd:Q20631656', 'Current trial release');
  const completeLink = discoveryStatement('schema:exampleOfWork', work.id);
  completeLink.qualifiers = [snak('wdt:P31', complete.id)];
  await adopted(prior, completeLink);
  const trialLink = discoveryStatement('schema:exampleOfWork', work.id);
  trialLink.qualifiers = [snak('wdt:P31', trial.id)];
  await adopted(current, trialLink);
  const follows = discoveryStatement('wdt:P155', prior.id);
  follows.qualifiers = [snak('schema:sameAs', 'vndb:rtype:unreviewed-99')];
  await adopted(current, follows);
  await adopted(
    current,
    discoveryStatement('schema:datePublished', {
      time: '+2004-10-15T00:00:00Z',
      precision: 11,
      calendarmodel: calendar,
    }),
  );
  await adopted(prior, unknownDate('schema:datePublished'));
  const yearOnly = await fixture.createSubject('wd:Q20631656', 'Year-precision release');
  await adopted(
    yearOnly,
    discoveryStatement('schema:datePublished', {
      time: '+2004-00-00T00:00:00Z',
      precision: 9,
      calendarmodel: calendar,
    }),
  );
  const episode = await fixture.createSubject('schema:Episode', 'Contained episode');
  await adopted(episode, discoveryStatement('schema:keywords', mainStory.id));
  await adopted(episode, discoveryStatement('schema:keywords', special.id));

  const currentRead = subject(await fixture.read(current));
  expect(facts(currentRead, 'wdt:P155').map((row) => row.value.content)).toEqual([prior.id]);
  expect(facts(currentRead, 'wdt:P155')[0]!.qualifiers.some((part) => part.value.content === 'vndb:rtype:unreviewed-99')).toBe(
    true,
  );
  expect(facts(currentRead, 'schema:exampleOfWork')[0]!.qualifiers.map((part) => part.value.content)).toEqual([trial.id]);
  expect(facts(subject(await fixture.read(prior)), 'schema:exampleOfWork')[0]!.qualifiers.map((part) => part.value.content)).toEqual(
    [complete.id],
  );
  expect(facts(subject(await fixture.read(work)), 'schema:creativeWorkStatus').map((row) => row.value.content)).toEqual([
    finished.id,
  ]);
  expect(facts(subject(await fixture.read(prior)), 'schema:datePublished')[0]!.value.type).toBe('somevalue');
  expect(facts(subject(await fixture.read(yearOnly)), 'schema:datePublished')[0]!.value.content).toMatchObject({
    precision: 9,
  });
  expect(
    facts(subject(await fixture.read(episode)), 'schema:keywords')
      .map((row) => row.value.content)
      .sort(),
  ).toEqual([mainStory.id, special.id].sort());

  const book = await fixture.createSubject('schema:Book', 'Work-only holder');
  const wrongHolder = await fixture.request(
    'alice',
    'POST',
    `/v1/subjects/${book.id}/candidates`,
    { statement: discoveryStatement('schema:creativeWorkStatus', inDevelopment.id) },
    discoveryKey(),
  );
  expect(wrongHolder.status, JSON.stringify(wrongHolder.body)).toBeGreaterThanOrEqual(400);
  expect(facts(subject(await fixture.read(book)), 'schema:creativeWorkStatus')).toEqual([]);

  const wrongQualifier = discoveryStatement('schema:exampleOfWork', work.id);
  wrongQualifier.qualifiers = [snak('schema:position', '1')];
  const rejectedQualifier = await fixture.request(
    'alice',
    'POST',
    `/v1/subjects/${current.id}/candidates`,
    { statement: wrongQualifier },
    discoveryKey(),
  );
  expect(rejectedQualifier.status, JSON.stringify(rejectedQualifier.body)).toBeGreaterThanOrEqual(400);

  await fixture.catchUp([work, prior, current, yearOnly, episode, development, finished, completeness, complete, trial]);
  const relations = ok(
    await fixture.request('anonymous', 'GET', `/v1/subjects/${current.id}/relations?property=wdt%3AP155&limit=20`),
  );
  expect((relations.relations as { target: string }[]).map((row) => row.target)).toEqual([prior.id]);
  expect(relations.next).toBeNull();

  const editorPage = ok(
    await fixture.request('alice', 'POST', '/v1/pages:read', { target: { subject: current.id } }),
  );
  expect(editorPage.subject).toBe(current.id);
  expect(editorPage.viewer).toEqual({ kind: 'account', account: fixture.personas.alice.accountId });
  expect(editorPage.actions.propose).toBe('allowed');
  expect(editorPage.reads).toBeDefined();
  const readerPage = ok(
    await fixture.request('anonymous', 'POST', '/v1/pages:read', { target: { subject: current.id } }),
  );
  expect(readerPage.viewer).toEqual({ kind: 'anonymous' });
  expect(readerPage.actions.propose).toBe('denied');
  expect(readerPage.subject).toBe(current.id);

  const hidden = await fixture.request(
    'alice',
    'POST',
    `/v1/subjects/${finished.id}:hide`,
    { reason: 'Retracted development-status concept' },
    discoveryKey(),
  );
  if (hidden.status < 300) {
    const afterHide = subject(await fixture.read(work));
    expect(facts(afterHide, 'schema:creativeWorkStatus').map((row) => row.value.content)).toEqual([finished.id]);
    expect(facts(afterHide, 'schema:name').length).toBeGreaterThan(0);
  }
}, 180_000);
