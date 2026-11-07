import { expect, test } from 'bun:test';
import type { Release } from '@rezics/definitions';

const [{ pageRenderBinding }, { installSemanticRenderPort, selectSubjectPageProfiles }] = await Promise.all([
  import('../src/features/catalogue/page-render-binding'),
  import('../src/features/pages/subject-page-application'),
]);

test('the installed Semantic binding selects current Subject profiles from released definitions', () => {
  installSemanticRenderPort(pageRenderBinding);
  const definitions = {
    types: {
      'schema:VideoGame': { bases: [], properties: ['schema:gamePlatform'] },
    },
    properties: {
      'schema:gamePlatform': { datatype: 'wikibase-item', relation: { group: 'classification' } },
    },
  } as unknown as Pick<Release, 'types' | 'properties'>;

  expect(
    selectSubjectPageProfiles({ type: 'schema:VideoGame', summaryTypes: ['schema:VideoGame'], definitions }),
  ).toEqual({
    gameReader: true,
    gameType: true,
    gameGroups: { credits: [], classification: ['schema:gamePlatform'], relations: [], facts: [] },
    releasedWorkNames: false,
  });

  expect(selectSubjectPageProfiles({ type: 'schema:VideoGame' })).toEqual({
    gameReader: true,
    gameType: false,
    gameGroups: { credits: [], classification: [], relations: [], facts: [] },
    releasedWorkNames: false,
  });
});
