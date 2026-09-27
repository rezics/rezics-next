import { describe, expect, test } from 'bun:test';
import { parseOptions } from '../../../scripts/dev/seed/cli.ts';
import { people, realms, seedKey, semanticTypes, works } from '../../../scripts/dev/seed/plan.ts';

describe('dev seed plan', () => {
  test('contains distinct stable Accounts, Works and Realms across both languages', () => {
    expect(people).toHaveLength(7);
    expect(new Set(people.map(person => person.email)).size).toBe(people.length);
    expect(works.length).toBeGreaterThanOrEqual(25);
    expect(works.length).toBeLessThanOrEqual(40);
    expect(new Set(works.map(work => work.id)).size).toBe(works.length);
    expect(realms.map(realm => realm.id)).toEqual([
      'fiction', 'books', 'mods', 'ai-workshop', 'software', 'kitchen',
    ]);
    expect(realms.every(realm => realm.featured.length > 0
      && realm.featured.every(id => works.some(work => work.id === id)))).toBe(true);
    expect(new Set(works.map(work => work.language))).toEqual(new Set(['en', 'zh-Hans']));
    expect(new Set(works.map(work => work.type))).toEqual(new Set(['book', 'document', 'recipe']));
    expect(works.filter(work => work.excerpt).length).toBeGreaterThanOrEqual(5);
  });

  test('uses stable bounded operation keys and valid type IRIs', () => {
    const keys = works.map(work => seedKey('work', work.id));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every(key => /^[A-Za-z0-9:_./-]{1,128}$/.test(key))).toBe(true);
    expect(semanticTypes('book')).toEqual(['https://schema.org/Book']);
    expect(semanticTypes('recipe')).toEqual(['https://schema.org/Recipe']);
    expect(semanticTypes('document')).toEqual(['https://schema.org/DigitalDocument']);
  });

  test('accepts only the documented CLI switches', () => {
    expect(parseOptions([])).toEqual({ dryRun: false, resetOwn: false });
    expect(parseOptions(['--dry-run', '--reset-own'])).toEqual({ dryRun: true, resetOwn: true });
    expect(() => parseOptions(['--remove-all'])).toThrow('Usage:');
  });
});
