import { describe, expect, test } from 'bun:test';
import {
  CREDIT_SEARCH_LIMITS,
  currentCreditSearchMatch,
  projectCreditSearch,
  type CreditSearchEntry,
  type CreditSearchSource,
} from '../../src/search/credit-search.ts';
import { creditSearchIndexDefinition } from '../../src/search/credit-search-mapping.ts';
import { subjectIndexDefinition } from '../../src/search/indices.ts';

const entry = (id = 'statement', targetId = 'creator'): CreditSearchEntry => ({
  witness: {
    workId: 'work',
    statementId: id,
    targetId,
    direction: 'outgoing',
    revision: 1,
    release: 'release',
    property: 'released-credit-property',
    qualifiers: [{ property: 'role', value: 'writer' }],
    nameRevision: 'name-1',
  },
  names: [{ language: 'en', value: 'Name absent from title and description' }],
  namesComplete: true,
});
function native(entries: readonly CreditSearchEntry[] = [entry()]): CreditSearchSource {
  return {
    page: async () => ({ state: 'current', workId: 'work', observation: 'cut', entries, next: null }),
    current: async () => true,
    unchanged: async () => true,
  };
}

describe('bounded credited-name projection consumer', () => {
  test('retains homonyms as distinct exact native statements and names', async () => {
    const source = native([entry('a', 'person-a'), entry('b', 'person-b')]);
    const projection = await projectCreditSearch(source, 'work');
    expect(projection.state).toBe('complete');
    if (projection.state !== 'complete') throw new Error('complete projection required');
    expect(projection.names.map((w) => w.targetId)).toEqual(['person-a', 'person-b']);
    expect(await currentCreditSearchMatch(source, projection, projection.names[1]!)).toBe('current');
    expect(
      await currentCreditSearchMatch(source, projection, {
        ...projection.names[1]!,
        qualifiers: [{ property: 'role', value: 'composer' }],
      }),
    ).toBe('unavailable');
    source.current = async () => false; // renamed, concealed, merged or retired supporting identity
    expect(await currentCreditSearchMatch(source, projection, projection.names[1]!)).toBe('restart');
  });

  test('missing support and partial creator labels never prove an empty complete population', async () => {
    expect(await projectCreditSearch(undefined, 'work')).toEqual({ state: 'unavailable' });
    expect(await projectCreditSearch(native([{ ...entry(), namesComplete: false }]), 'work')).toEqual({
      state: 'incomplete',
    });
    const names = Array.from({ length: CREDIT_SEARCH_LIMITS.namesPerCreator + 1 }, () => entry().names[0]!);
    expect(await projectCreditSearch(native([{ ...entry(), names }]), 'work')).toEqual({ state: 'incomplete' });
  });

  test('seeks at most four native pages with independent expansion bounds', async () => {
    const source = native();
    let calls = 0;
    source.page = async (input) => {
      expect(input.limits).toBe(CREDIT_SEARCH_LIMITS);
      expect(input.after).toBe(calls ? `cursor-${calls}` : null);
      calls++;
      return {
        state: 'current',
        workId: 'work',
        observation: 'cut',
        entries: [entry(`statement-${calls}`)],
        next: `cursor-${calls}`,
      };
    };
    expect(await projectCreditSearch(source, 'work')).toEqual({ state: 'incomplete' });
    expect(calls).toBe(4);
  });

  test('rejects source replacement at final disclosure and across pages', async () => {
    const source = native();
    const projection = await projectCreditSearch(source, 'work');
    if (projection.state !== 'complete') throw new Error('complete projection required');
    source.unchanged = async () => false;
    expect(await currentCreditSearchMatch(source, projection, projection.names[0]!)).toBe('restart');
    let calls = 0;
    source.page = async () => ({
      state: 'current',
      workId: 'work',
      observation: `cut-${calls++}`,
      entries: [entry()],
      next: 'next',
    });
    expect(await projectCreditSearch(source, 'work')).toEqual({ state: 'restart' });
  });

  test('additive mapping preserves the installed analyzer, names and sort definitions', () => {
    const base = subjectIndexDefinition();
    const before = structuredClone(base);
    const mapped = creditSearchIndexDefinition(base) as {
      mappings: { _meta: Record<string, unknown>; properties: Record<string, unknown> };
    };
    expect(base).toEqual(before);
    expect(mapped.mappings.properties.credited_names).toMatchObject({ type: 'nested', dynamic: 'strict' });
    expect(mapped.mappings.properties.credit_search_complete).toEqual({ type: 'boolean' });
    expect(mapped.mappings._meta.credit_search_format).toBe(1);
    delete mapped.mappings.properties.credited_names;
    delete mapped.mappings.properties.credit_search_complete;
    delete mapped.mappings._meta.credit_search_format;
    expect(mapped as Record<string, unknown>).toEqual(base);
  });
});
