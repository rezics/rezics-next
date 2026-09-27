import { expect, test } from 'bun:test';
import type { FusekiClient, SparqlResult } from '../../../services/main/src/infrastructure/fuseki.ts';
import { resolveInterpretation } from '../../../services/main/src/modules/context/interpretation.ts';
import { admitRelationCandidatePage, GraphQueryNotFound, queryRelationGraph }
  from '../../../services/main/src/modules/graph-query/query.ts';
import { readPublicStatementsAt, StatementBatchBudgetExceeded, StatementBatchUnavailable }
  from '../../../services/main/src/modules/statement/read.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';

const id = (number: number) => `https://rezics.com/id/${String(number).padStart(8, '0')}-1111-4111-8111-111111111111`;
const binding = (value: string) => ({ type: 'literal', value });
const position = { dataEpoch: 'epoch', sequence: '7' };

function batchFixture(rows: SparqlResult['results']) {
  const queries: string[] = [];
  const env = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    fuseki: { query: async (sparql: string): Promise<SparqlResult> => {
      queries.push(sparql);
      return sparql.includes('ASK {') ? { boolean: true } : { results: rows };
    } } as FusekiClient } as WorkActivationEnvironment;
  return { env, queries };
}

test('SEARCH01/SEARCH10: one position-fenced Statement batch rejects missing and private supports', async () => {
  const row = { epoch: binding('epoch'), sequence: binding('7'), statement: binding(id(1)),
    subject: binding(id(2)), predicate: binding(id(3)), object: { type: 'uri', value: id(4) },
    relation: binding(id(5)), speaker: binding(id(6)), key: binding('urn:rezics:meaning:one'),
    head: binding(id(7)) };
  const complete = batchFixture({ bindings: [row] });
  const hydrated = await readPublicStatementsAt(complete.env, [id(1)], position);
  expect(hydrated.get(id(1))).toMatchObject({ subject: id(2),
    value: { kind: 'resource', iri: id(4) }, sourcePosition: { sequence: '7' } });
  expect(complete.queries.filter(query => query.includes('VALUES ?statement'))).toHaveLength(1);
  await expect(readPublicStatementsAt(complete.env, [id(1), id(8)], position))
    .rejects.toBeInstanceOf(StatementBatchUnavailable);
  const privatePin = batchFixture({ bindings: [{ ...row, pin: binding(id(9)),
    context: binding(id(10)), disclosure: binding('https://rezics.com/vocab/Private') }] });
  await expect(readPublicStatementsAt(privatePin.env, [id(1)], position))
    .rejects.toBeInstanceOf(StatementBatchUnavailable);
  await expect(readPublicStatementsAt(complete.env,
    Array.from({ length: 513 }, (_, index) => id(index + 1)), position))
    .rejects.toBeInstanceOf(StatementBatchBudgetExceeded);
});

test('SEARCH07/SEARCH16: Context selection returns its graph position and rejects a moved read', async () => {
  const request = { object: id(1), relation: id(2),
    explicit: { context: id(3), semanticRevision: id(4) }, speaker: { kind: 'realm' as const, realm: id(5) } };
  const fixture = (move: boolean) => {
    let positions = 0;
    const env = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
      fuseki: { query: async (sparql: string): Promise<SparqlResult> => {
        if (sparql.includes('SELECT ?epoch ?sequence')) {
          positions++;
          return { results: { bindings: [{ epoch: binding('epoch'),
            sequence: binding(move && positions === 2 ? '8' : '7') }] } };
        }
        if (sparql.includes('rv:baseRevision*')) return { results: { bindings: [{
          revision: binding(id(4)), depth: binding('0'), context: binding(id(3)),
          disclosure: binding('https://rezics.com/vocab/Public'), entry: binding(id(6)),
          state: binding('https://rezics.com/vocab/Defined'), definition: binding(id(7)),
          relation: binding(id(2)),
        }] } };
        throw new Error('unexpected Context query');
      } } as FusekiClient } as WorkActivationEnvironment;
    return env;
  };
  expect(await resolveInterpretation(fixture(false), request)).toMatchObject({ state: 'resolved',
    definition: id(7), sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '7' } });
  expect(await resolveInterpretation(fixture(true), request)).toEqual({ state: 'unavailable' });
});

test('SEARCH01/GRAPH04: an unreadable explicit relation participant is rejected before matching', async () => {
  const calls: string[] = [];
  const env = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    fuseki: { query: async (sparql: string): Promise<SparqlResult> => {
      calls.push(sparql);
      if (sparql.includes('ASK {')) return { boolean: true };
      throw new Error('an inadmissible participant reached the relation match');
    } } as FusekiClient } as WorkActivationEnvironment;
  await expect(queryRelationGraph(env, { canReadResource: async resource => resource !== id(4) }, {
    profile: 'relation-graph-v1', actingSubject: id(1), anchor: { kind: 'resource', id: id(2) },
    definition: id(3), fromRole: 'lead', toRole: 'character', direction: 'outgoing',
    roleBindings: [{ role: 'character', participant: id(4) }],
  })).rejects.toBeInstanceOf(GraphQueryNotFound);
  expect(calls).toHaveLength(1);
});

test('SEARCH10/GRAPH04: bounded discovered candidates are admitted before a count is precise', async () => {
  const attempts: string[] = [];
  const rows = Array.from({ length: 65 }, (_, index) => ({
    occurrence: binding(id(index + 10)), revision: binding(id(index + 100)),
    from: binding(id(1)), to: binding(id(index + 200)), target: binding(id(index + 200)),
  }));
  const admitted = await admitRelationCandidatePage({ canReadResource: async resource => {
    attempts.push(resource);
    return resource === id(10) || resource === id(200);
  } }, rows);
  expect(admitted.rawBoundReached).toBe(true);
  expect(admitted.admitted).toHaveLength(1);
  expect(attempts).toHaveLength(66);
  expect(admitted.admitted[0]?.occurrence?.value).toBe(id(10));
});
