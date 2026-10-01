import { expect, test } from 'bun:test';
import { withholdPassage, evidenceId } from '../src/modules/wiki/evidence.ts';
import { wikiEntityState, wikiItemKey } from '../src/modules/wiki/apply.ts';
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

test('G-846: maximum wire entity ids retain bounded, distinct compensation keys', () => {
  const input = { revision: { proposal: '00000000-0000-0000-0000-000000000001',n: 2147483647,
    candidate: null,candidateDigest: 'a'.repeat(64),before: null,baseHeads: [],evidence: [] } };
  const item = `retract-entity:${'a'.repeat(64)}`;
  const key = wikiItemKey(input,item);
  expect(key.length).toBeLessThanOrEqual(128);
  expect(wikiItemKey(input,item)).toBe(key);
  expect(wikiItemKey(input,`retract-entity:${'b'.repeat(64)}`)).not.toBe(key);
  expect(wikiItemKey(input,'entity:lizzy')).toBe(`wiki:${input.revision.proposal}:${input.revision.n}:entity:lizzy`);
});


test('G-846: a registered wiki record without a revelation fails closed for every position', async () => {
  const { ReadingBoundary } = await import('../src/modules/reading-position/boundary.ts');
  const { WorkReadSession } = await import('../src/modules/work/read-session.ts');
  const record = 'https://rezics.com/id/00000000-0000-0000-0000-000000000001';
  for (const position of ['start','mine','all']) {
    const deps = { readingPositions: { generation: async () => '1',lookup: async () => new Map(),
      required: async () => new Set([record]) } } as unknown as import('../src/routes/dependencies.ts').MainWorkDependencies;
    const session = new WorkReadSession(deps,new Request(`http://main.local/?position=${position}`),{},
      { dataEpoch: 'epoch',sequence: '1' });
    expect([...(await new ReadingBoundary(session).visible([record,'ordinary']))]).toEqual(['ordinary']);
  }
});

test('G-846: personal withdrawal binds the applying speaker even when a legacy originalSpeaker is supplied', async () => {
  const { withdrawStatementRequest } = await import('../src/modules/statement/graph.ts');
  const actor = 'https://rezics.com/id/00000000-0000-0000-0000-000000000001';
  const request = { statement: actor,expectedHead: actor,speaker: { kind: 'personal' as const },actingSubject: actor };
  const originalSpeaker = 'https://rezics.com/id/00000000-0000-0000-0000-000000000002';
  expect(withdrawStatementRequest({ ...request,originalSpeaker } as typeof request)).toEqual(withdrawStatementRequest(request));
  expect(withdrawStatementRequest(request).scope).toBe(`statement:speak:${actor}`);
});
