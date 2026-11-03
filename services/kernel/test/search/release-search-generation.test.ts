import { expect, test } from 'bun:test';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import {
  readSubjectCalendarFormat,
  readSubjectCalendarMappingFormat,
  markSubjectCalendarReady,
  subjectIndexDefinition,
} from '../../src/search/indices.ts';
import { calendarIndexDefinition } from '../../src/search/release-search-calendar.ts';

test('calendar readiness belongs to the completed physical incarnation', async () => {
  const index = 'test-subjects-g2';
  const definition = calendarIndexDefinition(subjectIndexDefinition()) as {
    mappings: Record<string, unknown> & { _meta: Record<string, unknown> };
  };
  let uuid = 'physical-a';
  const search = {
    async request(method: string, path: string, body?: unknown) {
      if (path.endsWith('/_mapping')) {
        if (method === 'PUT') {
          const metadata = (body as { _meta: Record<string, unknown> })._meta;
          definition.mappings._meta = metadata;
          return { status: 200, body: { acknowledged: true } };
        }
        return { status: 200, body: { [index]: { mappings: definition.mappings } } };
      }
      if (path.endsWith('/_settings'))
        return { status: 200, body: { [index]: { settings: { index: { uuid } } } } };
      throw new Error(`Unexpected Search request: ${path}`);
    },
  } as unknown as OpenSearch;

  expect(await readSubjectCalendarMappingFormat(search, 'test-', 2)).toBe(1);
  expect(await readSubjectCalendarFormat(search, 'test-', 2)).toBeNull();
  expect(await markSubjectCalendarReady(search, 'test-', 2)).toBe(uuid);
  expect(await readSubjectCalendarFormat(search, 'test-', 2)).toBe(1);
  uuid = 'physical-b';
  expect(await readSubjectCalendarFormat(search, 'test-', 2)).toBeNull();
});
