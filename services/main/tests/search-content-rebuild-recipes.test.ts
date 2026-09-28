import { expect, test } from 'bun:test';
import type { ContentCore, ExactContentReference } from '../../content/src/core.ts';
import type { ContentProjectionCursor } from '../../content/src/projection-cursor.ts';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { verifyQuarantinedContentIndex } from '../src/modules/content-publication/rebuild.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const epoch = '11111111-1111-4111-8111-111111111111';
const generation = 'urn:rezics:text-index-generation:22222222-2222-4222-8222-222222222222';
const source = { owner: 'content' as const, dataEpoch: epoch, sequence: '3' };
const bind = (value: string, language?: string) => ({ type: language ? 'literal' : 'uri', value,
  ...(language ? { 'xml:lang': language } : {}) });

test('SEARCH20 rebuild verifies each Content MatchUnit with its exact model recipe', async () => {
  const records = [
    { model: 'content-shape-v1', body: { body: 'single text Work source' }, text: 'single text Work source' },
    { model: 'rezics-prompt-v1', body: { content: 'Hub prompt source' }, text: 'Hub prompt source' },
    { model: 'rezics-skill-package-v1', body: { instructions: 'Hub skill source' },
      text: 'Hub skill source' },
  ].map((item, index) => {
    const suffix = String(index + 1).repeat(36);
    const reference: ExactContentReference = { owner: 'content',
      resourceId: `https://rezics.com/id/${suffix}`, variantId: `urn:rezics:variant:${suffix}`,
      revisionId: suffix, format: 'rezics-content-json-v1', model: item.model,
      byteDigest: 'a'.repeat(64), byteLength: 10,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      sourceRevision: null, predecessor: null, provenance: {} };
    return { ...item, reference, revision: `urn:rezics:content:revision:${suffix}`,
      decision: `urn:rezics:decision:${suffix}`, eligibility: `urn:rezics:eligibility:${suffix}`,
      unit: `urn:rezics:content:match-unit:${suffix}` };
  });
  const heads = records.map(record => ({ variant: bind(record.reference.variantId),
    resource: bind(record.reference.resourceId), revision: bind(record.revision),
    digest: bind(record.reference.byteDigest), decision: bind(record.decision),
    eligibility: bind(record.eligibility) }));
  const rdf = () => records.map(record => ({ unit: bind(record.unit), body: bind(record.text, 'en'),
    variant: bind(record.reference.variantId), revision: bind(record.revision),
    decision: bind(record.decision), eligibility: bind(record.eligibility) }));
  const env = { lineage: { dataEpoch: epoch, routingEpoch: epoch }, fuseki: {
    async query(sparql: string): Promise<SparqlResult> {
      if (sparql.includes('ASK { GRAPH <urn:rezics:search:public>')) return { boolean: false };
      if (sparql.includes('ASK { GRAPH <urn:rezics:graph:receipts>')) return { boolean: true };
      if (sparql.includes('SELECT ?epoch ?routing')) return { results: { bindings: [{
        epoch: bind(epoch), routing: bind(epoch), sequence: bind('9'), generation: bind(generation) }] } };
      if (sparql.includes('SELECT ?variant WHERE')) return { results: { bindings: records.map(record => ({
        variant: bind(record.reference.variantId) })) } };
      if (sparql.includes('SELECT ?variant ?resource')) return { results: { bindings: heads } };
      if (sparql.includes('SELECT ?unit ?body')) return { results: { bindings: rdf() } };
      if (sparql.includes('SELECT ?unit ?literal ?graph')) return { results: { bindings: records.map(record => ({
        unit: bind(record.unit), literal: bind(record.text, 'en'),
        graph: bind('urn:rezics:search:public') })) } };
      if (sparql.includes('ASK { GRAPH <urn:rezics:search:probe>')) return { boolean: true };
      throw new Error(`unexpected rebuild query: ${sparql}`);
    },
  } } as unknown as WorkActivationEnvironment;
  const content = { ownerPosition: async () => source,
    readExactBatch: async (ids: string[]) => ids.map(id => {
      const record = records.find(item => item.reference.revisionId === id)!;
      return { revisionId: id, status: 'available' as const, reference: record.reference,
        body: record.body, serializedJson: JSON.stringify(record.body) };
    }) } as unknown as ContentCore;
  const cursor = { read: async () => source } as unknown as ContentProjectionCursor;
  const job = { id: '33333333-3333-4333-8333-333333333333', cut: source, consumer: 'fixture' };
  expect((await verifyQuarantinedContentIndex(env, content, cursor, job)).contentUnitCount).toBe(3);
  records[1]!.text = 'wrong prompt text';
  await expect(verifyQuarantinedContentIndex(env, content, cursor, job))
    .rejects.toThrow('Content MatchUnit differs from exact approved source');
});
