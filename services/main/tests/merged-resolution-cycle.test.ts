import { expect, test } from 'bun:test';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { MergeUnavailable } from '../src/modules/identity-merge/contract.ts';
import { resolveMergedIdentity } from '../src/modules/identity-merge/preflight.ts';
import { readMergedIdentity } from '../src/modules/identity-merge/resolution.ts';
import { DEFAULT_MEDIA_CONTEXT, MediaUnavailable } from '../src/modules/media/store.ts';
import { readResourceSummaries } from '../src/modules/media/summary.ts';
import { addressError } from '../src/routes/addresses.ts';
import { workReadError } from '../src/routes/work-reads.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const source = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const survivor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const uri = (value: string) => ({ type: 'uri' as const, value });
const literal = (value: string) => ({ type: 'literal' as const, value });

/** A cycle is not a product state. The resolver refuses it, and the public
 * read routes map that refusal to 503. */
function cycleGraph() {
  const edges = new Map([[source, survivor], [survivor, source]]);
  const graph = new FusekiClient('http://graph.invalid');
  graph.query = async query => {
    const requested = [...edges.keys()].filter(resource => query.includes(`<${resource}>`));
    let rows: NonNullable<SparqlResult['results']>['bindings'];
    if (query.includes('SELECT ?epoch ?sequence ?hold')) rows = requested.map(resource => ({
      epoch: literal('epoch'), sequence: literal('1'), r: uri(resource), type: literal('work'),
      work: uri(resource), head: uri(source), public: literal('true'), erased: literal('false'),
      label: { type: 'literal', value: 'Sword Art Online 1', 'xml:lang': 'en' },
      mergedInto: uri(edges.get(resource)!),
    }));
    else if (query.includes('SELECT ?sequence ?mergedInto')) {
      const resource = requested[0];
      rows = [{ sequence: literal('1'), ...(resource ? { mergedInto: uri(edges.get(resource)!) } : {}) }];
    } else if (query.includes('SELECT ?sequence WHERE')) rows = [{ sequence: literal('1') }];
    else throw new Error(`Unexpected graph probe: ${query}`);
    return { results: { bindings: rows } };
  };
  const environment: WorkActivationEnvironment = {
    fuseki: graph, objectDirectory: '.temp/merged-resolution-cycle',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
  };
  return environment;
}

test('a merge cycle is unavailable and the public read routes answer 503', async () => {
  const redirect = new Map([[source, survivor], [survivor, source]]);
  await expect(resolveMergedIdentity(source, resource => redirect.get(resource) ?? null))
    .rejects.toBeInstanceOf(MergeUnavailable);
  const environment = cycleGraph();
  await expect(readMergedIdentity(environment, source, () => Promise.resolve(true)))
    .rejects.toBeInstanceOf(MergeUnavailable);
  const summaries = readResourceSummaries(environment, undefined, {}, {
    resources: [source], context: DEFAULT_MEDIA_CONTEXT, language: null,
  });
  await expect(summaries).rejects.toBeInstanceOf(MediaUnavailable);
  const refused = await summaries.catch((error: unknown) => error);
  expect((await workReadError(refused)).status).toBe(503);
  expect((await addressError(refused)).status).toBe(503);
});
