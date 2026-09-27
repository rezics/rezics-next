import { expect, test } from 'bun:test';
import { GRAPHS, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { CompositionCorrupt, derivedId, readPlacements }
  from '../src/modules/structure/graph.ts';

const id = (name: string) => derivedId(`list-item:${name}`);
const field = (value: string) => ({ type: 'uri', value });
const binding = (item?: string, legacyTarget?: string) => ({
  placement: field('urn:rezics:placement:legacy'), occurrence: field(id('occurrence')),
  type: field(`${RV}OccurrencePlacement`), segment: field(id('segment')),
  parent: field(id('structure')), segmentKey: { type: 'literal', value: '0' },
  orderKey: { type: 'literal', value: '1' }, role: field(`${RV}ChapterRole`),
  introducedBy: field(id('introduced')), mode: field(`${RV}FollowContext`),
  ...(item ? { item: field(item) } : {}),
  ...(legacyTarget ? { legacyTarget: field(legacyTarget) } : {}),
});
const env = (row: ReturnType<typeof binding>): WorkActivationEnvironment => ({
  fuseki: { query: async (query: string) => {
    expect(query).toContain(`<${GRAPHS.current}>`);
    expect(query).toContain('schema:item ?item');
    expect(query).toContain('rv:target ?legacyTarget');
    return { results: { bindings: [row] } };
  } },
}) as unknown as WorkActivationEnvironment;

test('MODEL13: ListItem read accepts schema:item and retained rv:target data', async () => {
  const target = id('target');
  const generation = id('generation');
  for (const row of [binding(target), binding(undefined, target)]) {
    const placements = await readPlacements(env(row), generation,
      { occurrences: [id('occurrence')] });
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({ occurrence: id('occurrence'), target,
      role: 'chapter', orderKey: '1' });
  }
  await expect(readPlacements(env(binding(target, id('other'))), generation,
    { occurrences: [id('occurrence')] })).rejects.toBeInstanceOf(CompositionCorrupt);
});
