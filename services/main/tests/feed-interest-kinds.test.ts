import { expect, test } from 'bun:test';
import { interestKinds, interestSources, matchingActivityKinds, matchingWorkKinds }
  from '../src/modules/work/work-kinds.ts';

test('G302: home interests map admitted types and accepted terms without treating documents as software', () => {
  expect(interestKinds).toEqual(['books', 'software', 'ai', 'recipes', 'media', 'discussions']);
  expect(matchingWorkKinds(['https://schema.org/DigitalDocument'], [])).toEqual([]);
  expect(matchingWorkKinds(['https://schema.org/Book'], [])).toEqual(['books']);
  expect(matchingWorkKinds(['https://schema.org/BookSeries'], [])).toEqual(['books']);
  expect(matchingWorkKinds([], [' Fiction ', 'SERIAL'])).toEqual(['books']);
  expect(matchingWorkKinds(['https://schema.org/Recipe'], [])).toEqual(['recipes']);
  expect(matchingWorkKinds(['https://schema.org/SoftwareSourceCode'], [])).toEqual(['software']);
  expect(matchingWorkKinds([], ['Modrinth', 'game mod', 'package'])).toEqual(['software']);
  expect(matchingWorkKinds(['https://rezics.com/vocab/SkillPackage'], [])).toEqual(['ai']);
  expect(matchingWorkKinds(['https://rezics.com/vocab/PromptTemplate'], [])).toEqual(['ai']);
  expect(matchingWorkKinds([], ['animation', 'music'])).toEqual(['media']);
  expect(matchingWorkKinds(['https://schema.org/VideoObject'], [])).toEqual(['media']);
  expect(interestSources.media.workTypes).toContain('https://schema.org/Movie');
  expect(interestSources.media.workTypes).toContain('https://schema.org/TVSeries');
});

test('G302: Realm discussion and reply activities are an interest, not Work types', () => {
  expect(interestSources.discussions.workTypes).toEqual([]);
  expect(matchingWorkKinds(['https://schema.org/DigitalDocument'], ['discussion'])).toEqual([]);
  expect(matchingActivityKinds('discussion')).toEqual(['discussions']);
  expect(matchingActivityKinds('reply')).toEqual(['discussions']);
  expect(matchingActivityKinds('work')).toEqual([]);
});
