import { expect, test } from 'bun:test';
import { FusekiClient, type SparqlResult } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AddressClaimUnavailable } from '../../../services/main/src/modules/address/claim.ts';
import { MAX_WORK_REDIRECT_HOPS, resolveWorkRoute }
  from '../../../services/main/src/modules/address/resolution.ts';
import { ID, RV, type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';

const node = (index: number) => `${ID}00000000-0000-0000-0000-${index.toString(16).padStart(12, '0')}`;
const binding = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });

class ChainFuseki extends FusekiClient {
  calls = 0;
  constructor(private readonly length: number, private readonly cycle = false,
    private readonly missing = false) {
    super('http://127.0.0.1:1/');
  }

  override async query(): Promise<SparqlResult> {
    this.calls++;
    if (this.calls === 1) return { results: { bindings: [{
      address: binding(node(100)), revision: binding(node(101)),
      work: binding(node(0)), state: binding(`${RV}Redirected`),
      redirectWork: binding(node(1)), sequence: literal('7'),
    }] } };
    if (this.missing) return { results: { bindings: [] } };
    const index = this.calls - 1;
    const merged = index <= this.length;
    return { results: { bindings: [{
      address: binding(node(index + 100)), revision: binding(node(index + 200)),
      slug: literal(`route-${index}`), sequence: literal('7'),
      state: binding(`${RV}${merged ? 'Redirected' : 'Current'}`),
      ...(merged ? { disposition: binding(`${RV}Merged`),
        redirectWork: binding(node(this.cycle && index === 2 ? 1 : index + 1)) } : {}),
    }] } };
  }
}

function environment(fuseki: FusekiClient): WorkActivationEnvironment {
  return { fuseki, lineage: { dataEpoch: 'test', routingEpoch: 'test' },
    objectDirectory: '.temp' };
}

test('VIEW02: bounded redirect traversal preserves a valid last hop', async () => {
  const fuseki = new ChainFuseki(MAX_WORK_REDIRECT_HOPS - 1);
  const result = await resolveWorkRoute(environment(fuseki), 'old-route');
  expect(result).toMatchObject({ state: 'redirected', originalWork: node(0),
    targetWork: node(MAX_WORK_REDIRECT_HOPS),
    canonical: { slug: `route-${MAX_WORK_REDIRECT_HOPS}` } });
  expect(fuseki.calls).toBe(MAX_WORK_REDIRECT_HOPS + 1);
});

test('VIEW02: a valid chain past the bound is unavailable, not missing', async () => {
  const fuseki = new ChainFuseki(MAX_WORK_REDIRECT_HOPS);
  await expect(resolveWorkRoute(environment(fuseki), 'old-route'))
    .rejects.toBeInstanceOf(AddressClaimUnavailable);
  expect(fuseki.calls).toBe(MAX_WORK_REDIRECT_HOPS + 1);
});

test('VIEW02: a cycle or missing redirect target is unavailable', async () => {
  const cycle = new ChainFuseki(3, true);
  await expect(resolveWorkRoute(environment(cycle), 'old-route'))
    .rejects.toBeInstanceOf(AddressClaimUnavailable);
  expect(cycle.calls).toBe(3);
  const missing = new ChainFuseki(1, false, true);
  await expect(resolveWorkRoute(environment(missing), 'old-route'))
    .rejects.toBeInstanceOf(AddressClaimUnavailable);
});
