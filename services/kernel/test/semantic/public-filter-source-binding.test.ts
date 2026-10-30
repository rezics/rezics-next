import { expect, test } from 'bun:test';
import { createPublicFilterSourceBinding } from '../../src/semantic/public-filter-source-binding.ts';
import { fixture, nativeProducer, readContext } from './support/public-filter-source.ts';

test('native public Source configuration and immutable meaning/read definition resolve without trusting caller identity', async () => {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  try {
    const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    const source = publicFilterSource(f.config);
    const capture = { sort: 'id' as const, size: 10, filterDocument: undefined, text: undefined };
    const result = await binding.resolve({ source, meaning: f.meaning, capture }, readContext());
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error(`Native Source binding ${result.reason}`);
    expect(result.definition.source.epoch).toBeGreaterThan(0);
    expect(result.definition.source.configuration.length).toBeGreaterThan(0);
    expect(result.definition.readDefinition.length).toBeGreaterThan(0);
    expect(result.definition.dependencyKeys).toContainEqual({ kind: 'field', field: 'id' });
    capture.size = 20;
    expect(result.definition.capture.size).toBe(10);
    expect(
      (await binding.resolve({ source: { ...source }, meaning: f.meaning, capture }, readContext())).status,
    ).not.toBe('resolved');
    expect(
      (await binding.resolve({ source, meaning: { ...f.meaning, digest: 'invented' }, capture }, readContext())).status,
    ).not.toBe('resolved');
    const foreign = createPublicFilterSourceBinding(f.db.pool, new Uint8Array(32).fill(12), f.config.access);
    expect((await foreign.resolve({ source, meaning: f.meaning, capture }, readContext())).status).not.toBe('resolved');
  } finally {
    await f.close();
  }
});
