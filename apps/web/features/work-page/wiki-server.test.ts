import { describe, expect, test } from 'bun:test';
import type { StatementGroup } from '../entity-page/types.ts';
import { wikiRealm, wikiStatements } from './hub-fixtures.ts';
import type { Loaded, ReadFailure } from './types.ts';
import { wikiZoneRead } from './wiki.ts';

// Explore the wiki maps two Main reads. Absence of a wiki-Zone Statement is "no wiki".
// A failed read stays a failure, so an outage is not shown as a Work that has no wiki.

const page = { ok: true as const, data: { sections: [{ id: 'statements' }] } };
const named = (groups: readonly StatementGroup[]): Loaded<{ groups: readonly StatementGroup[] }> =>
  ({ ok: true, data: { groups } });
const failed = (failure: ReadFailure): Loaded<never> => ({ ok: false, failure });

describe('the wiki Zone read', () => {
  test('no Statements section, and statements that name no wiki Zone, are no wiki', () => {
    expect(wikiZoneRead(page, undefined)).toEqual({ ok: true, data: null });
    expect(wikiZoneRead(page, named([]))).toEqual({ ok: true, data: null });
    expect(wikiZoneRead(page, named([{ predicate: 'https://schema.org/name', items: [] }] as never))).toEqual({
      ok: true, data: null,
    });
  });

  test('a wiki-Zone Statement names that Realm', () => {
    expect(wikiZoneRead(page, named(wikiStatements()))).toEqual({ ok: true, data: wikiRealm });
  });

  test('a failed projection or Statements read stays that failure', () => {
    for (const failure of ['unavailable', 'missing', 'budget', 'invalid'] as const) {
      expect(wikiZoneRead(failed(failure), undefined)).toEqual({ ok: false, failure });
      expect(wikiZoneRead(page, failed(failure))).toEqual({ ok: false, failure });
    }
  });
});
