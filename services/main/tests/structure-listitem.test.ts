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
const env = (row: Omit<ReturnType<typeof binding>, 'mode'> & { mode?: ReturnType<typeof field> }): WorkActivationEnvironment => ({
  fuseki: { query: async (query: string) => {
    expect(query).toContain(`<${GRAPHS.current}>`);
    expect(query).toContain('schema:item ?item');
    expect(query).not.toContain('rv:target');
    return { results: { bindings: [row] } };
  } },
}) as unknown as WorkActivationEnvironment;

test('MODEL13: ListItem read requires normalized schema:item membership', async () => {
  const target = id('target');
  const generation = id('generation');
  for (const row of [binding(target)]) {
    const placements = await readPlacements(env(row), generation,
      { occurrences: [id('occurrence')] });
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({ occurrence: id('occurrence'), target,
      role: 'chapter', orderKey: '1' });
  }
  await expect(readPlacements(env(binding(undefined, target)), generation,
    { occurrences: [id('occurrence')] })).rejects.toBeInstanceOf(CompositionCorrupt);
});

test('ListItem group payload stays structural when read back for editing', async () => {
  const row = { ...binding(id('occurrence')), role: field(`${RV}GroupRole`), mode: undefined };
  const placements = await readPlacements(env(row), id('generation'),
    { occurrences: [id('occurrence')] });
  expect(placements[0]).toMatchObject({ role: 'group', occurrence: id('occurrence') });
  expect(placements[0]?.target).toBeUndefined();
});
