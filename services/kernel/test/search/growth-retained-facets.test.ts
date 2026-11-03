import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import type { FacetDiscovery200Response } from '../../src/search/facet-discovery-contract.ts';
import { property, request, retainedFacetGrowthFixture } from './support/retained-facet-growth-fixture.ts';

// Diagnostic first slice. This does not certify a composed constant or three-scale growth acceptance.
let world: Awaited<ReturnType<typeof retainedFacetGrowthFixture>>;
beforeAll(async () => {
  world = await retainedFacetGrowthFixture(64);
  await world.ready();
}, 600_000);
afterAll(async () => {
  await world?.close();
}, 180_000);

function page(body: Record<string, unknown>) {
  expect(Object.keys(body).sort()).toEqual(['as_of', 'facets']);
  assert(Array.isArray(body.facets));
  assert(typeof body.as_of === 'string' && Number.isFinite(Date.parse(body.as_of)));
  for (const facet of body.facets) {
    expect(Object.keys(facet).sort()).toEqual(['next', 'property', 'values']);
    for (const entry of facet.values) expect(Object.keys(entry).sort()).toEqual(['labels', 'value']);
  }
  return (body as unknown as FacetDiscovery200Response).facets[0]!;
}

test('native retained first, opaque deep and terminal pages consume the real canonical values', async () => {
  const cardinality = await world.fixture.inspect<{ n: number }>(
    `SELECT count(*)::integer AS n FROM search.facet_value v JOIN search.facet_generation g
     USING (partition_no,definition,generation) WHERE g.state='ready' AND g.property=$1`,
    [property],
  );
  expect(cardinality.rows).toEqual([{ n: 64 }]);
  let cursor: string | undefined;
  const all: string[] = [];
  for (let offset = 0; offset < 64; offset += 20) {
    const body = { ...request, facets: [{ property, size: 20, ...(cursor ? { cursor } : {}) }] };
    const measured = await world.measured(body);
    expect(measured.value.status).toBe(200);
    const facet = page(measured.value.body);
    expect(facet.values.map(({ value }) => value)).toEqual(world.expected.slice(offset, offset + 20));
    expect(facet.values.every(({ labels }) => typeof labels.en === 'string')).toBe(true);
    expect(measured.seeks).toHaveLength(1);
    expect(measured.seeks[0]!.returned).toBeLessThanOrEqual(21);
    expect(measured.capture.plans.length).toBeGreaterThan(0);
    all.push(...facet.values.map(({ value }) => value));
    if (offset < 60) {
      assert(typeof facet.next === 'string' && facet.next.length > 0);
      expect(facet.next).not.toBe(cursor);
      cursor = facet.next;
    } else expect(facet.next).toBeNull();
  }
  expect(all).toEqual(world.expected);
}, 180_000);

test('a real reduction after START retires the retained page before another candidate seek', async () => {
  await world.native.indexing('paused');
  const barrier = world.barrier();
  const pending = world.measured();
  try {
    // The barrier holds an actual completed SELECT, after native capture and the common START.
    // Hiding one contributor invalidates all 64 retained author rows without a fake Source.
    await Promise.race([
      barrier.reached,
      pending.then(() => {
        throw new Error('Native request finished before its candidate response barrier');
      }),
    ]);
    const hidden = await world.hide();
    expect(hidden.status).toBe(200);
    barrier.release();
    const measured = await pending;
    expect(measured.value.status).toBe(503);
    expect(['index_not_ready', 'semantic_not_ready', 'deadline_exceeded']).toContain(String(measured.value.body.code));
    expect(measured.value.body).not.toHaveProperty('facets');
    // The structural invariant is one candidate SELECT per sibling page, independent of rejected rows.
    expect(measured.seeks).toHaveLength(1);
    expect(measured.seeks.every(({ returned }) => returned <= 21)).toBe(true);
    expect(measured.seeks.flatMap(({ values }) => values).length).toBeLessThanOrEqual(21);
  } finally {
    barrier.release();
    await pending;
    await world.native.indexing('running');
  }
}, 180_000);

test('native 1x/4x/16x source cardinality keeps fixed page seeks and records preparation separately', async () => {
  const scales = [64, 256, 1024];
  const runs: unknown[] = [];
  for (const count of scales) {
    const sample = await retainedFacetGrowthFixture(count);
    try {
      await sample.ready();
      const measured = await sample.measured();
      expect(measured.value.status).toBe(200);
      const facet = page(measured.value.body);
      expect(facet.values.map(({ value }) => value)).toEqual(sample.expected.slice(0, 20));
      expect(facet.next === null).toBe(count <= 20);
      expect(measured.seeks).toHaveLength(1);
      expect(measured.seeks[0]!.returned).toBeLessThanOrEqual(21);
      runs.push({
        count,
        preparation: sample.preparation.map(({ status, code, cost }) => ({ status, code, cost })),
        readyPage: measured.cost,
        seeks: measured.seeks,
      });
    } finally {
      await sample.close();
    }
  }
  console.info('retained facet cardinality growth', {
    scales: runs,
    structural: { readyPageSeeksPerSibling: 1, candidateLimit: 21 },
    unmeasured: ['isolated Auth pools', 'native engine profiles', 'Source history H(id) bound'],
  });
}, 600_000);
