import { expect, test } from 'bun:test';
import captured from '../../services/main/tests/bangumi-captured-subjects.json';
import { bangumiWorkFacts, importBangumiWorkFacts, type BangumiFactSource, type BangumiFactsClient,
  type BangumiPublicationDate } from './bangumi.ts';

const subjects = captured as Record<string, BangumiFactSource>;
const day = 'http://www.w3.org/2001/XMLSchema#date';
const year = 'http://www.w3.org/2001/XMLSchema#gYear';
const on = (lexical: string, datatype: BangumiPublicationDate['datatype']): BangumiPublicationDate =>
  ({ lexical, datatype });

test('an anime first air date and a book first publication date keep the source precision', () => {
  expect(bangumiWorkFacts(subjects['975']!).date).toEqual(on('1999-10-20', day));
  expect(bangumiWorkFacts(subjects['1869']!).date).toEqual(on('2000-03-04', day));
  expect(bangumiWorkFacts(subjects['3582']!).date).toEqual(on('2007-11-10', day));
  expect(bangumiWorkFacts(subjects['20700']!).date).toEqual(on('2010-01-29', day));
  expect(bangumiWorkFacts({
    id: 1, type: 2, platform: 1, infobox: '|放送开始= 1998年\n|发售日= 1998-07-26',
  }).date).toEqual(on('1998', year));
  expect(bangumiWorkFacts({ id: 2, type: 1, platform: 1001, date: '2012' }).date).toEqual(on('2012', year));
});

test('the API date, then the archive date, then the infobox, and a blank field is skipped', () => {
  const infobox = '|放送开始= 1990年1月2日\n|发售日= 1991-03-04';
  expect(bangumiWorkFacts({
    id: 3, type: 2, platform: 1, date: '1992-05-06', infobox,
    api_subject: { type: 2, platform: 1, date: '1993-07-08', infobox: '|放送开始= 1994年8月9日' },
  }).date).toEqual(on('1993-07-08', day));
  expect(bangumiWorkFacts({
    id: 4, type: 2, platform: 1, date: '1992-05-06', infobox,
    api_subject: { type: 2, platform: 1, date: '   ', infobox: '|放送开始= 1994年8月9日' },
  }).date).toEqual(on('1992-05-06', day));
  expect(bangumiWorkFacts({
    id: 5, type: 2, platform: 1, date: '', infobox,
    api_subject: { type: 2, platform: 1, infobox: '|上映年度= \n|放送开始= 1994年8月9日' },
  }).date).toEqual(on('1994-08-09', day));
  expect(bangumiWorkFacts({
    id: 6, type: 1, platform: 1001, infobox: '|发行日期= 1988年2月3日\n|开始= 1980-01-01',
  }).date).toEqual(on('1988-02-03', day));
});

test('a missing, partial or malformed date states nothing, and a later field does not fill it in', () => {
  expect(bangumiWorkFacts({ id: 7, type: 2, platform: 1 }).date).toBeNull();
  expect(bangumiWorkFacts({ id: 8, type: 2, platform: 1, date: '   ', infobox: '|放送开始= ' }).date).toBeNull();
  for (const date of ['1999-10', '1999年10月', '1999-02-31', 'not-a-date', '1997-07-22 (1997年34号)', '0000-00-00']) {
    expect(bangumiWorkFacts({
      id: 9, type: 2, platform: 1, date, infobox: '|放送开始= 1999年10月20日',
    }).date, date).toBeNull();
  }
  expect(bangumiWorkFacts(subjects['3510']!).date).toEqual(on('1997-12-24', day));
});

const actor = 'https://rezics.com/id/019d0000-0000-7000-8000-000000000001';
const work = {
  work: 'https://rezics.com/id/019d0000-0000-7000-8000-0000000000aa',
  mainVersion: 'https://rezics.com/id/019d0000-0000-7000-8000-0000000000bb',
};
const definition = {
  component: 'https://rezics.com/id/019d0000-0000-7000-8000-0000000000cc',
  revision: 'https://rezics.com/id/019d0000-0000-7000-8000-0000000000dd',
};

function recordingClient() {
  const calls: { path: string; body: object; key: string }[] = [];
  let n = 0;
  const client: BangumiFactsClient = {
    post: async (path, body, key) => {
      calls.push({ path, body, key });
      if (path === '/v1/statements') {
        const dated = key.endsWith(':first-publication-date');
        n += 1;
        return {
          statement: dated
            ? 'https://rezics.com/id/019d0000-0000-7000-8000-000000000e10'
            : `https://rezics.com/id/019d0000-0000-7000-8000-000000000e${n}0`,
          meaningKey: dated ? 'meaning-date' : `meaning-${n}`,
        };
      }
      if (path === '/v1/classification-vocabulary') {
        n += 1;
        return { scheme: 'https://rezics.com/id/scheme', schemeHead: 'https://rezics.com/id/head',
          concept: `https://rezics.com/id/019d0000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`,
          definitionRevision: definition.revision };
      }
      if (path === '/v1/contexts') {
        return { context: 'https://rezics.com/id/context', semanticRevision: definition.revision };
      }
      if (key === 'statement-first-publication-date:v1:property') return definition;
      return { component: definition.component, revision: definition.revision };
    },
    put: async (path, body, key) => {
      calls.push({ path, body, key });
      return {};
    },
    authorizeDefinition: async () => {},
  };
  return { client, calls };
}

test('a dated subject posts the first-publication statement and its global acceptance', async () => {
  const { client, calls } = recordingClient();
  const imported = await importBangumiWorkFacts(client, actor, work, subjects['975']!);
  expect(imported.facts.date).toEqual(on('1999-10-20', day));
  const prefix = `work-format:v1:${work.work.slice(-36)}:975`;
  const posted = calls.filter((call) => call.key === `${prefix}:first-publication-date`);
  expect(posted).toEqual([{
    path: '/v1/statements', key: `${prefix}:first-publication-date`,
    body: {
      profile: 'statement-v1', speaker: { kind: 'personal' }, subject: work.work,
      predicate: definition.component, relationDefinition: definition.revision,
      value: { kind: 'literal', lexical: '1999-10-20', datatype: day, language: null },
      applicability: [], interpretation: { kind: 'selected' },
      evidence: ['https://bgm.tv/subject/975'], actingSubject: actor,
    },
  }]);
  const statement = 'https://rezics.com/id/019d0000-0000-7000-8000-000000000e10';
  expect(calls.filter((call) => call.key === `${prefix}:first-publication-date:decision`)).toEqual([{
    path: '/v1/statement-decisions', key: `${prefix}:first-publication-date:decision`,
    body: {
      profile: 'statement-decision-v1',
      target: { kind: 'qualified-fact', meaningKey: 'meaning-date', support: [statement] },
      acceptance: { kind: 'global' }, expectedDecisionHead: null, outcome: 'accepted', actingSubject: actor,
    },
  }]);
  const book = recordingClient();
  await importBangumiWorkFacts(book.client, actor, work, { id: 11, type: 1, platform: 1001, date: '2004' });
  const bookPost = book.calls.find((call) => call.key.endsWith(':first-publication-date'));
  expect(bookPost?.body).toMatchObject({
    value: { kind: 'literal', lexical: '2004', datatype: year, language: null },
    evidence: ['https://bgm.tv/subject/11'],
  });
});

test('an undated subject posts no first-publication statement', async () => {
  const { client, calls } = recordingClient();
  const imported = await importBangumiWorkFacts(client, actor, work, { id: 12, type: 2, platform: 1 });
  expect(imported.facts.date).toBeNull();
  expect(calls.some((call) => call.path === '/v1/statements' && call.key.endsWith(':first-publication-date'))).toBe(false);
  expect(calls.some((call) => call.key.endsWith(':first-publication-date:decision'))).toBe(false);
});
