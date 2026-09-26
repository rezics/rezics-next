import { expect, test } from 'bun:test';
import { relationGraphQueryText } from '../../../services/main/src/modules/graph-query/query.ts';
import { statementGraphQueryText } from '../../../services/main/src/modules/graph-query/statements.ts';
import { checkedRelationGraphQuery, GRAPH_QUERY_COST, GRAPH_QUERY_LIMITS,
  type RelationGraphQuery } from '../../../services/main/src/modules/graph-query/schema.ts';

const id = (suffix: string) => `https://rezics.com/id/00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const definition = id('1');
const roles = new Map([
  ['performer', `${definition}/role/performer`],
  ['character', `${definition}/role/character`],
]);

function request(overrides: Partial<RelationGraphQuery> = {}): RelationGraphQuery {
  return { profile: 'relation-graph-v1', actingSubject: id('2'),
    anchor: { kind: 'resource', id: id('3') }, definition,
    fromRole: 'performer', toRole: 'character', direction: 'outgoing', roleBindings: [], ...overrides };
}

test('GRAPH01: query binds role predicates and participants through one exact occurrence revision', () => {
  const query = relationGraphQueryText(request({ roleBindings: [
    { role: 'performer', participant: id('3') }, { role: 'character', participant: id('4') },
  ] }), roles, 'epoch-1');
  const normalized = query.replace(/\s+/gu, ' ');
  expect(normalized).toContain(`rv:RelationOccurrenceRevision ; rv:component ?occurrence ; rv:lifecycle rv:Active ; rv:participation ?fromPart, ?toPart`);
  expect(normalized).toContain(`?fromPart rv:role <${roles.get('performer')}> ; rv:participant ?from`);
  expect(normalized).toContain(`?toPart rv:role <${roles.get('character')}> ; rv:participant ?to`);
  expect(normalized).toContain(`?revision rv:participation ?constraint0`);
  expect(normalized).toContain(`?revision rv:participation ?constraint1`);
  expect(query.match(/SELECT \?unit \?score \?occurrence/g)).toHaveLength(1);
});

test('GRAPH03/GRAPH04: traversal has a hard candidate bound and does not expose hidden candidate counts', () => {
  expect(GRAPH_QUERY_LIMITS.edges).toBe(64);
  expect(GRAPH_QUERY_LIMITS.candidates).toBe(65);
  expect(GRAPH_QUERY_COST.relationPage.maxAccessProofs).toBe(141);
  expect(GRAPH_QUERY_COST.relationPage.maxResponseBytes).toBe(1_048_576);
  expect(GRAPH_QUERY_COST.relationPage.textSeed).toMatchObject({ maxCandidates: 513,
    maxFusekiCalls: 72, maxFusekiBytes: 8_388_608, maxRequestMs: 10_000 });
  expect(GRAPH_QUERY_COST.statementPage.graphQueries).toBe(2);
  expect(GRAPH_QUERY_COST.statementPage.resourceAccessChecks).toBe(68);
  const query = relationGraphQueryText(request(), roles, 'epoch-1');
  expect(query).toContain('LIMIT 65');
  expect(query).toContain('FILTER(?epoch = "epoch-1")');
  expect(query).not.toContain('COUNT(?occurrence)');
});

test('GRAPH05: text seed and relation join share one ARQ request and Main Version binding', () => {
  const checked = checkedRelationGraphQuery(request({ anchor: { kind: 'phrase', phrase: '  Café  noir ', language: 'fr' } }));
  expect(checked.anchor).toEqual({ kind: 'phrase', phrase: 'Café noir', language: 'fr' });
  const query = relationGraphQueryText(checked, roles, 'epoch-1');
  expect(query.match(/text:query/g)).toHaveLength(2);
  expect(query).toContain('rv:work ?seed');
  expect(query).toContain('rv:selectionHead ?selection');
  expect(query).toContain('FILTER(?from = ?seed)');
  expect(query).toContain('?revision a rv:RelationOccurrenceRevision');
  expect(query).toContain('LIMIT 65');
});

test('GRAPH03: continuations resume after the last visible edge in stable order', () => {
  const query = relationGraphQueryText(request({ continuation: {
    queryDigest: 'a'.repeat(64),
    sourcePosition: { datasetId: 'product', dataEpoch: 'epoch-1', sequence: '42' },
    after: { occurrence: id('4'), revision: id('5'), from: id('3'), to: id('6') }, expiresAt: 1_900_000_000_000,
  } }), roles, 'epoch-1');
  expect(query).toContain(`STR(?occurrence) > "${id('4')}"`);
  expect(query.match(/ORDER BY STR\(\?occurrence\) STR\(\?revision\) STR\(\?from\) STR\(\?to\)/gu))
    .toHaveLength(2);
  expect(query).toContain('LIMIT 65');
});

test('GRAPH02/GRAPH03/GRAPH04: statement reads join evidence, explicit canon and public decisions under one bound', () => {
  const query = statementGraphQueryText({ profile: 'statement-graph-v1', actingSubject: id('2'),
    anchor: id('3'), direction: 'outgoing' }, 'epoch-1');
  expect(query).toContain('LIMIT 65');
  expect(query).toContain('?head rv:evidence ?evidence');
  expect(query).toContain('?statement rv:interpretationDefinition ?definition');
  expect(query).toContain('?decisionTarget = ?statement');
  expect(query).toContain('?decisionTarget = ?key');
  expect(query).toContain('urn:rezics:classification-context:global');
  expect(query).toContain('rv:disclosure rv:Public');
  expect(query.match(/SELECT \?statement/g)).toHaveLength(2);
  expect(GRAPH_QUERY_COST.statementPage.maxResponseBytes).toBe(1_048_576);
  expect(GRAPH_QUERY_COST.statementPage.privateContextAccessChecks).toBe(65);
});

test('GRAPH03: Statement continuations resume by visible Statement identity', () => {
  const query = statementGraphQueryText({ profile: 'statement-graph-v1', actingSubject: id('2'),
    anchor: id('3'), direction: 'outgoing', continuation: {
      queryDigest: 'b'.repeat(64),
      sourcePosition: { datasetId: 'product', dataEpoch: 'epoch-1', sequence: '42' },
      after: id('4'), expiresAt: 1_900_000_000_000,
    } }, 'epoch-1');
  expect(query).toContain(`FILTER(STR(?statement) > "${id('4')}")`);
  expect(query.match(/ORDER BY STR\(\?statement\)/gu)).toHaveLength(2);
  expect(query).toContain('LIMIT 65');
});
