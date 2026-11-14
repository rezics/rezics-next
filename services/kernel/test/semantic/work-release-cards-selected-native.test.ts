import { afterAll, expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { HttpResponse, StatementInput } from '../../../../specs/semantic-driver.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  discoveryStatement,
  type CreatedSubject,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

const fixturePromise = createReleasedDiscoveryFixture({ version: 1 });
let fixture: ReleasedDiscoveryFixture;
type Fact = Parameters<ReleasedDiscoveryFixture['adopt']>[1];
type Decision = 'accept' | 'reject';
type Mode = 'inherit' | 'replace' | 'suppress';
const date = (day: string) => ({ time: `+2024-03-${day}T00:00:00Z`, precision: 11 });
const named = (property: string, content: unknown, rank: 'normal' | 'preferred' = 'normal'): Fact => {
  const fact = discoveryStatement(property, content as StatementInput['value']['content']);
  fact.rank = rank;
  return fact;
};
function body(response: HttpResponse, status = 200) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return response.body as Record<string, any>;
}
async function propose(subject: CreatedSubject, fact: Fact) {
  return body(
    await fixture.request('editor', 'POST', `/v1/subjects/${subject.id}/candidates`, { statement: fact }, discoveryKey()),
    201,
  ).candidate as string;
}
async function decide(subject: CreatedSubject, candidate: string, context: string, decision: Decision, expected_head: number | null) {
  body(
    await fixture.request(
      'acceptor',
      'POST',
      `/v1/subjects/${subject.id}/candidates/${candidate}:${decision}`,
      { context, expected_head },
      discoveryKey(),
    ),
  );
}
async function adopt(
  subject: CreatedSubject,
  context: string,
  property: string,
  mode: Mode,
  candidate: string | undefined,
  expected_head: number | null,
) {
  return body(
    await fixture.request(
      'acceptor',
      'POST',
      `/v1/subjects/${subject.id}:adopt`,
      {
        context,
        property,
        mode,
        selection: candidate ? [{ candidate, rank: 'normal' }] : [],
        expected_head,
      },
      discoveryKey(),
    ),
  );
}
async function card(work: CreatedSubject, edition: CreatedSubject, context?: string) {
  const query = new URLSearchParams({
    property: 'schema:exampleOfWork',
    limit: '20',
    language: 'en',
    ...(context ? { context } : {}),
  });
  const result = body(await fixture.request('anonymous', 'GET', `/v1/subjects/${work.id}/links?${query}`));
  expect(result.workReleaseCards.state).toBe('available');
  return (result.workReleaseCards.cards as Record<string, any>[]).find(({ subject }) => subject === edition.id)!;
}

afterAll(async () => {
  fixture ??= await fixturePromise;
  await fixture.close();
});

test('native edition cards use adopted scalars across rejection, replacement and Context decisions', async () => {
  fixture = await fixturePromise;
  const work = await fixture.createSubject('schema:Book', 'Selected scalar work');
  const edition = await fixture.createSubject('bf:Instance', 'Expanded edition');
  const compactDate = date('01');
  const compact = await fixture.createSubject('bf:Instance', 'Compact edition', {
    'schema:exampleOfWork': [named('schema:exampleOfWork', work.id)],
    'schema:datePublished': [named('schema:datePublished', date('02'))],
    'schema:inLanguage': [named('schema:inLanguage', 'fr')],
  });
  const membership = await fixture.adopt(edition, named('schema:exampleOfWork', work.id));
  const selectedDate = await fixture.adopt(edition, named('schema:datePublished', compactDate));
  const selectedLanguage = await fixture.adopt(edition, named('schema:inLanguage', 'ja'));
  const rejectedDate = await propose(edition, named('schema:datePublished', date('03'), 'preferred'));
  const rejectedLanguage = await propose(edition, named('schema:inLanguage', 'zh', 'preferred'));
  await decide(edition, rejectedDate, GLOBAL_CONTEXT, 'reject', null);
  await decide(edition, rejectedLanguage, GLOBAL_CONTEXT, 'reject', null);
  await fixture.catchUp([work, edition, compact]);

  const rejected = await card(work, edition);
  expect(rejected.membership.id).toBe(membership.candidate);
  expect(rejected.fields['schema:datePublished'].statements.map(({ id, rank }: any) => [id, rank])).toEqual([
    [selectedDate.candidate, 'normal'],
  ]);
  expect(rejected.fields['schema:inLanguage'].statements.map(({ id }: any) => id)).toEqual([
    selectedLanguage.candidate,
  ]);
  expect(card(work, compact).fields['schema:datePublished'].statements[0].value.content).toEqual(date('02'));
  const ordinary = body(await fixture.read(edition));
  expect(ordinary.subject.statements['schema:datePublished'].find(({ id }: any) => id === rejectedDate).rank).toBe(
    'deprecated',
  );
  expect(ordinary.subject.statements['schema:inLanguage'].find(({ id }: any) => id === rejectedLanguage).rank).toBe(
    'deprecated',
  );

  for (const [property, candidate, head] of [
    ['schema:datePublished', rejectedDate, selectedDate.adoptionHead],
    ['schema:inLanguage', rejectedLanguage, selectedLanguage.adoptionHead],
  ] as const) {
    await decide(edition, candidate, GLOBAL_CONTEXT, 'accept', 1);
    await adopt(edition, GLOBAL_CONTEXT, property, 'replace', candidate, head);
  }
  await fixture.catchUp([work, edition]);
  const replaced = await card(work, edition);
  expect(replaced.fields['schema:datePublished'].statements.map(({ id }: any) => id)).toEqual([rejectedDate]);
  expect(replaced.fields['schema:inLanguage'].statements.map(({ id }: any) => id)).toEqual([rejectedLanguage]);

  const contextId = body(
    await fixture.request('editor', 'POST', '/v1/contexts', { labels: { en: 'Edition readers' } }, discoveryKey()),
    201,
  ).context.id as string;
  await fixture.grant('acceptor', ['context:accept', 'context:adopt'], contextId);
  const heads: Record<string, number> = {};
  for (const property of ['schema:datePublished', 'schema:inLanguage']) {
    const inherited = await adopt(edition, contextId, property, 'inherit', undefined, null);
    heads[property] = inherited.adoption.head;
  }
  await fixture.catchUp([work, edition]);
  const inherited = await card(work, edition, contextId);
  expect(inherited.fields['schema:datePublished'].statements.map(({ id }: any) => id)).toEqual([rejectedDate]);
  expect(inherited.fields['schema:inLanguage'].statements.map(({ id }: any) => id)).toEqual([rejectedLanguage]);

  await decide(edition, selectedDate.candidate, contextId, 'accept', null);
  await adopt(edition, contextId, 'schema:datePublished', 'replace', selectedDate.candidate, heads['schema:datePublished']!);
  await adopt(edition, contextId, 'schema:inLanguage', 'suppress', undefined, heads['schema:inLanguage']!);
  await fixture.catchUp([work, edition]);
  const overridden = await card(work, edition, contextId);
  expect(overridden.fields['schema:datePublished'].statements.map(({ id }: any) => id)).toEqual([
    selectedDate.candidate,
  ]);
  expect(overridden.fields['schema:inLanguage'].state).toBe('withheld');
});
