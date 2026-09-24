import { expect, test } from 'bun:test';
import type { ContentCore } from '../../content/src/core.ts';
import type { ContentProjectionCursor } from '../../content/src/projection-cursor.ts';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { verifyQuarantinedContentIndex } from '../src/modules/content-publication/rebuild.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const graphEpoch = '11111111-1111-4111-8111-111111111111';
const sourceEpoch = '22222222-2222-4222-8222-222222222222';
const generation = 'urn:rezics:text-index-generation:33333333-3333-4333-8333-333333333333';
const variant = 'urn:rezics:variant:44444444-4444-4444-8444-444444444444';
const resource = 'https://rezics.com/id/55555555-5555-4555-8555-555555555555';
const revisionId = '66666666-6666-4666-8666-666666666666';
const revision = `urn:rezics:content:revision:${revisionId}`;
const decision = 'urn:rezics:content-publication:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const eligibility = 'urn:rezics:content-search-eligibility:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const unit = 'urn:rezics:content:match-unit:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const digest = 'd'.repeat(64);
const body = 'Exact receipt provenance matters';
const binding = (value: string, language?: string) => ({ type: language ? 'literal' : 'uri',
  value, ...(language ? { 'xml:lang': language } : {}) });

test('SEARCH20 activation rejects an eligible head lacking its terminal receipt chain', async () => {
  const head = { variant: binding(variant), resource: binding(resource), decision: binding(decision),
    eligibility: binding(eligibility), revision: binding(revision), digest: binding(digest) };
  const fuseki = { async query(sparql: string): Promise<SparqlResult> {
    if (sparql.includes('ASK { GRAPH <urn:rezics:search:public>')) return { boolean: false };
    if (sparql.includes('ASK { GRAPH <urn:rezics:graph:receipts>')) return { boolean: true };
    if (sparql.includes('SELECT ?epoch ?routing')) return { results: { bindings: [{
      epoch: binding(graphEpoch), routing: binding(graphEpoch), sequence: binding('3'),
      generation: binding(generation),
    }] } };
    if (sparql.includes('SELECT ?variant WHERE')) return { results: { bindings: [{ variant: binding(variant) }] } };
    if (sparql.includes('SELECT ?variant ?resource')) {
      // A restored graph can retain the head/decision while losing its terminal receipt.
      return { results: { bindings: sparql.includes('GRAPH <urn:rezics:graph:receipts>') ? [] : [head] } };
    }
    if (sparql.includes('SELECT ?unit ?body')) return { results: { bindings: [{
      unit: binding(unit), body: binding(body, 'en'), variant: binding(variant),
      revision: binding(revision), decision: binding(decision), eligibility: binding(eligibility),
    }] } };
    if (sparql.includes('SELECT ?unit ?literal')) return { results: { bindings: [{
      unit: binding(unit), literal: binding(body, 'en'), graph: binding('urn:rezics:search:public'),
    }] } };
    if (sparql.includes('ASK { GRAPH <urn:rezics:search:probe>')) return { boolean: true };
    throw new Error(`unexpected rebuild query: ${sparql.slice(0, 80)}`);
  } } as unknown as WorkActivationEnvironment['fuseki'];
  const position = { owner: 'content' as const, dataEpoch: sourceEpoch, sequence: '3' };
  const content = { ownerPosition: async () => position,
    readExactBatch: async () => [{ status: 'available',
      reference: { variantId: variant, resourceId: resource, byteDigest: digest,
        language: { kind: 'tag', tag: 'en' } }, body: { body } }],
  } as unknown as ContentCore;
  const cursor = { read: async () => position } as unknown as ContentProjectionCursor;
  await expect(verifyQuarantinedContentIndex({ fuseki,
    lineage: { dataEpoch: graphEpoch, routingEpoch: graphEpoch }, objectDirectory: '' },
  content, cursor, { id: graphEpoch, cut: position, consumer: 'content-rebuild.fixture' }))
    .rejects.toThrow('declared eligibility inventory differs');
});
