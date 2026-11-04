import { afterAll, expect, test } from 'bun:test';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { HttpResponse, StatementInput } from '../../../../specs/semantic-driver.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryStatement,
  type CreatedSubject,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

const fixturePromise = createReleasedDiscoveryFixture({ version: 1 });
let fixture: ReleasedDiscoveryFixture;
function body(response: HttpResponse, status = 200) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return response.body as Record<string, any>;
}
type Fact = Parameters<ReleasedDiscoveryFixture['adopt']>[1];
const named = (property: string, content: unknown) =>
  discoveryStatement(property, content as StatementInput['value']['content']);
async function selected(subject: CreatedSubject, fact: Fact) {
  const result = await fixture.adopt(subject, fact);
  expect(result.candidate).toBeTruthy();
  return result;
}

afterAll(async () => {
  fixture ??= await fixturePromise;
  await fixture.close();
});

test('native comparison composes exact public work membership, current release evidence and current work advice', async () => {
  fixture = await fixturePromise;
  const work = await fixture.createSubject('wd:Q689445', 'Native VN work');
  const release = await fixture.createSubject('wd:Q20631656', 'Japanese Windows release');
  const sparse = await fixture.createSubject('wd:Q20631656', 'Sparse actual release');
  const platform = await fixture.createSubject('skos:Concept', 'Windows');
  const status = await fixture.createSubject('skos:Concept', 'Early access');
  const creator = await fixture.createSubject('schema:Person', 'Work creator');
  const publisher = await fixture.createSubject('schema:Organization', 'Release publisher');
  const producer = await fixture.createSubject('schema:Organization', 'Software producer');
  const developer = await fixture.createSubject('schema:Organization', 'Software developer');
  await selected(work, named('schema:author', creator.id));
  const membershipInput = named('schema:exampleOfWork', work.id);
  const membership = await selected(release, membershipInput);
  const sparseMembership = await selected(sparse, named('schema:exampleOfWork', work.id));
  await selected(release, named('schema:gamePlatform', platform.id));
  await selected(release, named('schema:inLanguage', 'ja'));
  const dateInput = named('schema:datePublished', { time: '+2004-10-00T00:00:00Z', precision: 10 });
  const date = await selected(release, dateInput);
  await selected(release, named('schema:creativeWorkStatus', status.id));
  const producerInput = named('schema:producer', producer.id);
  producerInput.qualifiers = [
    { property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'Harbour Studio source' } },
  ];
  const producerFact = await selected(release, producerInput);
  await selected(release, named('schema:publisher', publisher.id));
  await selected(release, named('wdt:P178', developer.id));
  await selected(release, named('wdt:P2899', { amount: '+17', unit: 'http://www.wikidata.org/entity/Q577' }));
  await fixture.catchUp([work, release, sparse, platform, status, creator, publisher, producer, developer]);

  const raw = body(
    await fixture.request(
      'anonymous',
      'GET',
      `/v1/subjects/${work.id}/links?property=schema%3AexampleOfWork&limit=20&language=en`,
    ),
  );
  expect(raw.freshness).toMatchObject({ caught_up: true });
  expect(raw.links).toHaveLength(2);
  expect(raw.workReleaseCards.state).toBe('available');
  const cards = raw.workReleaseCards.cards as Record<string, any>[];
  const card = cards.find((entry) => entry.subject === release.id)!;
  const sparseCard = cards.find((entry) => entry.subject === sparse.id)!;
  expect(card.membership.id).toBe(membership.candidate);
  expect(card.membership.property.id).toBe('schema:exampleOfWork');
  expect(card.membership.value.content).toBe(work.id);
  expect(card.membership.references).toEqual(membershipInput.references);
  expect(card.membership.rezics).toMatchObject({ release: bundledDigest });
  expect(card.fields['schema:gamePlatform']).toMatchObject({
    state: 'available',
    statements: [{ value: { content: platform.id } }],
    related: { [platform.id]: { id: platform.id, label: { value: expect.stringContaining('Windows') } } },
  });
  expect(card.fields['schema:inLanguage'].statements[0].value.content).toBe('ja');
  expect(card.fields['schema:datePublished'].statements[0]).toMatchObject({
    id: date.candidate,
    value: { type: 'value', content: { time: '+2004-10-00T00:00:00Z', precision: 10 } },
    references: dateInput.references,
  });
  expect(card.fields['schema:creativeWorkStatus'].statements[0].value.content).toBe(status.id);
  expect(card.fields['wdt:P2899'].statements[0].value.content).toEqual({
    amount: '+17',
    unit: 'http://www.wikidata.org/entity/Q577',
  });
  expect(card.fields['schema:publisher'].related[publisher.id].label.value).toContain('Release publisher');
  expect(card.fields['schema:producer'].statements[0]).toMatchObject({
    id: producerFact.candidate,
    qualifiers: producerInput.qualifiers,
    references: producerInput.references,
    rank: 'preferred',
    rezics: { release: bundledDigest, revision: expect.any(Number) },
  });
  expect(card.fields['schema:producer'].related[producer.id].label.value).toContain('Software producer');
  expect(card.fields['wdt:P178'].related[developer.id].label.value).toContain('Software developer');
  const workRead = body(await fixture.read(work, 'anonymous'));
  expect(workRead.subject.statements['schema:author'][0].value.content).toBe(creator.id);
  expect(card.fields['schema:author']).toBeUndefined();
  expect(card.fields['wdt:P5804'].state).toBe('unsupported');
  expect(card.fields['schema:publisher'].state).toBe('available');
  expect(sparseCard.membership.id).toBe(sparseMembership.candidate);
  expect(sparseCard.fields['wdt:P2899'].state).toBe('missing');
  expect(sparseCard.fields['schema:producer'].state).toBe('missing');

  const wide = body(
    await fixture.request(
      'anonymous',
      'GET',
      `/v1/subjects/${work.id}/links?property=schema%3AexampleOfWork&limit=21&language=en`,
    ),
  );
  expect(wide.links).toHaveLength(2);
  expect(wide.workReleaseCards).toEqual({ state: 'unavailable' });

  const advice = body(await fixture.request('alice', 'GET', `/v1/subjects/${work.id}?includeViewerActions=true`));
  expect(advice.viewerActions.state).toBe('available');
  expect(JSON.stringify(advice.viewerActions)).not.toMatch(/publish/i);

  await fixture.grant('steward', ['moderation:hide'], developer.id);
  body(await fixture.request('steward', 'POST', `/v1/subjects/${developer.id}:hide`, { reason: 'Conceal target' }));
  await fixture.catchUp([developer]);
  const hidden = body(
    await fixture.request(
      'anonymous',
      'GET',
      `/v1/subjects/${work.id}/links?property=schema%3AexampleOfWork&limit=20&language=en`,
    ),
  );
  const hiddenCard = (hidden.workReleaseCards.cards as Record<string, any>[]).find(
    (entry) => entry.subject === release.id,
  )!;
  expect(hiddenCard.fields['wdt:P178'].state).toBe('withheld');
  expect(JSON.stringify(hiddenCard)).not.toContain(developer.id);
});
