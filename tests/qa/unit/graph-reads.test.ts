import { expect, test } from 'bun:test';
import type { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { GRAPHS } from '../../../services/main/src/modules/work/activate.ts';
import { assertGraphSubjectAbsent } from '../integration/support/graph-reads.ts';

const identity = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const other = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
type Triple = { graph: string | null; subject: string; predicate: string; object: string };

function graphClient(triples: Triple[]): Pick<FusekiClient, 'query'> {
  return { async query(sparql) {
    if (!sparql.trimStart().startsWith('ASK')) throw new Error('Expected an ASK probe');
    const patterns = [...sparql.matchAll(/(?:GRAPH\s+(\?\w+|<[^>]+>)\s*)?\{\s*<([^>]+)>\s+\?\w+\s+\?\w+\s*\}/g)];
    if (!patterns.length) throw new Error('Expected a subject-only triple pattern');
    return { boolean: triples.some(triple => patterns.some(([, graph, subject]) => triple.subject === subject
      && (graph === undefined ? triple.graph === null : graph.startsWith('?')
        ? triple.graph !== null : triple.graph === graph.slice(1, -1)))) };
  } };
}

test('graph subject absence accepts an empty identity and ignores triples about another subject', async () => {
  const triples: Triple[] = [{ graph: GRAPHS.current, subject: other,
    predicate: 'https://example.org/ref', object: identity }];
  await assertGraphSubjectAbsent(graphClient([]), identity);
  await assertGraphSubjectAbsent(graphClient(triples), identity);
});

test('graph subject absence rejects a fabricated bare Resource type without a semantic head in every dataset graph', async () => {
  for (const graph of [null, ...Object.values(GRAPHS), 'urn:graph:other-owner']) {
    const triples: Triple[] = [];
    const client = graphClient(triples);
    await assertGraphSubjectAbsent(client, identity);
    // Mutation: a refused command fabricated only an identity stub, with no revision or manifest.
    triples.push({ graph, subject: identity,
      predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      object: 'http://www.w3.org/2000/01/rdf-schema#Resource' });
    await expect(assertGraphSubjectAbsent(client, identity)).rejects.toThrow(`Graph subject has triples: ${identity}`);
  }
});

test('graph subject absence rejects any predicate and refuses an unavailable ASK result', async () => {
  await expect(assertGraphSubjectAbsent(graphClient([{ graph: GRAPHS.current, subject: identity,
    predicate: 'https://example.org/unowned', object: 'orphan' }]), identity))
    .rejects.toThrow('Graph subject has triples');
  await expect(assertGraphSubjectAbsent({ query: async () => ({}) }, identity))
    .rejects.toThrow('Graph subject absence probe has no ASK result');
});
