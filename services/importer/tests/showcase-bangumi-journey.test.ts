import { expect, test } from 'bun:test';
import { citedAnimeCreditTargets, journeyTargets, selectJourneyWorks } from '../src/showcase-bangumi-journey.ts';

function publishedRow(sourceKey: string, provider = 'bangumi') {
  return {
    provider,
    sourceKey,
    subjectId: `subject-${provider}-${sourceKey}`,
    nativeType: 'schema:Book',
    readerRoute: `/subjects/subject-${provider}-${sourceKey}`,
    assertions: [{ citations: [`https://bgm.tv/subject/${sourceKey}`] }],
  };
}

test('the journey visits the selected anime and both light-novel families once each', () => {
  const published = journeyTargets.map((target) => publishedRow(target.sourceKey));
  const works = selectJourneyWorks([...published, publishedRow('999', 'vndb')]);
  expect(works.map((work) => work.sourceKey)).toEqual(journeyTargets.map((target) => target.sourceKey));
  expect(works.find((work) => work.sourceKey === '233')).toMatchObject({ role: 'anime' });
  expect(works.find((work) => work.sourceKey === '5329')).toMatchObject({ role: 'volume', series: '2815' });
  expect(works.find((work) => work.sourceKey === '10862')).toMatchObject({ role: 'volume', series: '2815' });
});

test('a missing or duplicated target stops the journey by its exact source key', () => {
  const published = journeyTargets.map((target) => publishedRow(target.sourceKey));
  expect(() => selectJourneyWorks(published.filter((row) => row.sourceKey !== '233'))).toThrow(
    'journey target bangumi:233 has 0 rows',
  );
  expect(() => selectJourneyWorks([...published, publishedRow('2815')])).toThrow(
    'journey target bangumi:2815 has 2 rows',
  );
});

test('anime Work targets require the selected Bangumi credit row and preserve its exact citation', () => {
  const statement = (id: string, property: string, target: string, citation: string) => ({
    id,
    property: { id: property },
    value: { type: 'value', content: target },
    references: [
      {
        parts: [
          {
            property: { id: 'schema:url' },
            value: { type: 'value', content: citation },
          },
        ],
      },
    ],
  });
  const read = {
    subject: {
      id: 'anime-233',
      type: 'schema:TVSeries',
      statements: {
        'wdt:P725': [
          statement('voice-1', 'wdt:P725', 'person-1', 'https://bgm.tv/subject/233#/person-characters/233/16/304'),
          statement(
            'voice-unrelated',
            'wdt:P725',
            'person-unrelated',
            'https://bgm.tv/subject/2815#/person-characters/2815/16/304',
          ),
        ],
        'schema:director': [
          statement(
            'director-1',
            'schema:director',
            'person-2',
            'https://bgm.tv/subject/233#/subject-persons/233/42/position',
          ),
          statement('director-uncited', 'schema:director', 'person-3', 'https://bgm.tv/subject/233'),
        ],
      },
    },
  };

  expect(citedAnimeCreditTargets(read, '233', 'cast')).toEqual([
    expect.objectContaining({
      id: 'person-1',
      property: 'wdt:P725',
      citation: 'https://bgm.tv/subject/233#/person-characters/233/16/304',
      statementId: 'voice-1',
      holder: 'anime-233',
      kind: 'person',
    }),
  ]);
  expect(citedAnimeCreditTargets(read, '233', 'staff')).toEqual([
    expect.objectContaining({
      id: 'person-2',
      property: 'schema:director',
      citation: 'https://bgm.tv/subject/233#/subject-persons/233/42/position',
      statementId: 'director-1',
      holder: 'anime-233',
      kind: 'person',
    }),
  ]);
});
