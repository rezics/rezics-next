import { expect, test } from 'bun:test';
import { withholdPassage, evidenceId } from '../src/modules/wiki/evidence.ts';
import { wikiEntityState } from '../src/modules/wiki/apply.ts';
import type { WikiSnapshot } from '../src/modules/wiki/apply-snapshot.ts';

test('G-846: a rights restriction redacts every nested source-text fallback', () => {
  const locator = { version: 'rezics-locator-v1',source: { representationSha256: 'a'.repeat(64) },
    selector: { type: 'TextQuoteSelector',exact: 'passage',prefix: 'preceding',suffix: 'following' },
    quote: { exact: 'passage',prefix: 'preceding' } };
  expect(withholdPassage(locator)).toEqual({ ...locator,selector: { type: 'TextQuoteSelector',exact: null,prefix: null,suffix: null },
    quote: null });
  expect(locator.selector.exact).toBe('passage');
  expect(withholdPassage([{ locator },{ exact: 'alternative' }])).toEqual([
    { locator: withholdPassage(locator) },{ exact: null }]);
});
test('G-846: retained evidence identity separates revisions and claim citations', () => {
  const id = evidenceId('proposal',1,0,0);
  expect(evidenceId('proposal',1,0,0)).toBe(id);
  expect(new Set([id,evidenceId('proposal',2,0,0),evidenceId('proposal',1,1,0),evidenceId('proposal',1,0,1)]).size).toBe(4);
});
test('G-846: entity reuse retains unrelated facts and de-duplicates language-tagged names', () => {
  const entity = { id: 'lizzy',type: 'https://rezics.com/vocab/Character',match: 'https://rezics.com/id/00000000-0000-0000-0000-000000000001',
    names: [{ value: 'Elizabeth',language: 'en',kind: 'primary' as const,revealedAt: 'one' },
      { value: 'Lizzy',language: 'en',kind: 'alias' as const,revealedAt: 'two' }] };
  const name = { predicate: 'https://schema.org/name',value: { kind: 'language-string' as const,lexical: 'Elizabeth',language: 'en' } };
  const fact = { predicate: 'https://schema.org/description',value: { kind: 'string' as const,lexical: 'Retained editorial fact' } };
  const snapshot: WikiSnapshot = { submitter: 'holder',collections: {},predicates: {},entities: {
    lizzy: { head: 'head',state: { component: 'resource',types: [entity.type],lifecycle: 'active',properties: [name,fact] } } } };
  expect(wikiEntityState(entity,snapshot)).toEqual({ component: 'resource',types: [entity.type],lifecycle: 'active',properties: [name,fact,
    { predicate: 'https://schema.org/alternateName',value: { kind: 'language-string',lexical: 'Lizzy',language: 'en' } }] });
  expect(snapshot.entities.lizzy!.state).toMatchObject({ properties: [name,fact] });
});
