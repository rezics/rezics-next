import { expect, test } from 'bun:test';
import { parseSuggestionPage } from '../src/search/header-search/suggestion-page';

const row = (id: string, summary: unknown = null) => ({ id, type: 'person', labels: { en: 'Person' }, summary });
const summary = (id: string, type = 'person') => ({ id, type, types: [], label: null, creativeWork: false, cover: null });
const page = (subjects: unknown[]) => ({ subjects, as_of: '2025-01-01T00:00:00.000Z', types: {} });
const first = '123e4567-e89b-12d3-a456-426614174000';
const second = '123e4567-e89b-12d3-a456-426614174001';

test('header suggestion pages reject incoherent subject identities and retain null summaries', () => {
  expect(() => parseSuggestionPage(page([row(first, summary(second))]))).toThrow(TypeError);
  expect(() => parseSuggestionPage(page([row(first, summary(first, 'organization'))]))).toThrow(TypeError);
  expect(() => parseSuggestionPage(page([row(first), row(first.toUpperCase())]))).toThrow(TypeError);
  expect(parseSuggestionPage(page([row(first)])).subjects[0]?.summary).toBeNull();
});
