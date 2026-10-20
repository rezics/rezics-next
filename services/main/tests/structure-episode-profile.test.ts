import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Value } from 'typebox/value';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { checkedOperations, compositionChangeDigest, orderTree, recordTree } from '../src/modules/structure/change.ts';
import { checkEpisodeOrder, authorizeEpisodeTarget, episodeTargetGuard,
  hydrateEpisodeOrder, projectEpisodeOrder } from '../src/modules/structure/episode-profile.ts';
import { checkOccurrenceRecord, type OccurrenceRecord } from '../src/modules/structure/format.ts';
import { derivedId, orderTreeKey, roleFromIri, roleIri, type PlacementState } from '../src/modules/structure/graph.ts';
import { structureProfileFor, workPublicationProfileFor, type StructureTargetReader } from '../src/modules/structure/profiles.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { WorkReadSession } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { declaredStructureQualifier } from '../src/routes/compositions.ts';

const id = (key: string) => derivedId(`episode-profile-${key}`);
const qualifier = () => ({ type: 'fields' as const, id: 'episode-order-v1', values: {
  position: { numerator: 1, denominator: 2 }, disc: { numerator: 0, denominator: 1 },
  kindCode: '1', kindScheme: 'bangumi:episode:type', label: '0.5',
} });
const record = (key = 'first'): OccurrenceRecord => ({ occurrence: id(key), state: 'active',
  parent: id('structure'), segmentKey: 'a', orderKey: key === 'first' ? 'a' : 'b',
  role: 'episode', target: id('episode-36420'), labels: [], introducedBy: id('revision'),
  sourceKey: `/sources/0/edges/${key === 'first' ? 0 : 1}`, qualifier: qualifier() });
const state = (entry = record()): PlacementState => {
  const { selection: _selection, ...fields } = entry;
  return { ...fields, placement: id(`placement-${entry.occurrence}`), active: entry.state === 'active' };
};
type Row = NonNullable<SparqlResult['results']>['bindings'][number];
const literal = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });

test('episode admission uses Work authority and an exact supporting resource without changing V1 profiles', () => {
  const profile = structureProfileFor('episode-list-v1');
  expect(profile).toMatchObject({ ownerType: 'https://schema.org/CreativeWork',
    componentType: `${RV}MainVersion`, editAction: 'work.edit', editScopePrefix: 'work:edit:',
    receiptFamily: 'edit-metadata-work', roles: ['group', 'episode'], targetRoles: ['episode'], maxDepth: 2 });
  expect(roleFromIri(roleIri('episode'))).toBe('episode');
  const entry = record();
  expect(() => checkOccurrenceRecord(entry, profile.id)).not.toThrow();
  const insert = { op: 'insert' as const, parent: entry.parent, position: 'last' as const,
    role: entry.role, target: entry.target, sourceKey: entry.sourceKey, qualifier: entry.qualifier };
  expect(checkedOperations([insert], profile)).toEqual([insert]);
  for (const other of ['book-composition', 'work-composition', 'recipe-composition']) {
    expect(() => checkedOperations([insert], other)).toThrow();
  }
  expect(() => checkedOperations([{ ...insert, selection: { mode: 'follow-context' } }], profile)).toThrow('no content selection');
  expect(() => checkedOperations([{ ...insert, target: undefined }], profile)).toThrow();
  expect(() => workPublicationProfileFor(profile)).toThrow('not reviewed');
  expect(structureProfileFor('book-composition').roles).toEqual(['group', 'chapter']);
  expect(structureProfileFor('work-composition').qualifiers?.part.type).toBe('work-part');
});

test('fractional positions, zero disc and source codes survive transport and have exact command identity', () => {
  const original = qualifier();
  expect(Value.Check(declaredStructureQualifier, original)).toBe(true);
  expect(checkEpisodeOrder(original)).toEqual(original);
  const structure = id('structure'), revision = id('revision');
  const update = { op: 'update' as const, occurrence: id('first'), qualifier: original };
  const digest = compositionChangeDigest(structure, revision, [update], 'episode-list-v1');
  expect(compositionChangeDigest(structure, revision, [JSON.parse(JSON.stringify(update))], 'episode-list-v1')).toBe(digest);
  for (const changed of [
    { ...original.values, position: { numerator: 3, denominator: 2 } },
    { ...original.values, disc: { numerator: 1, denominator: 1 } },
    { ...original.values, kindCode: '0' }, { ...original.values, kindScheme: 'other:episode:type' },
  ]) expect(compositionChangeDigest(structure, revision,
    [{ ...update, qualifier: { ...original, values: changed } }], 'episode-list-v1')).not.toBe(digest);
  for (const position of [{ numerator: 0, denominator: 1 }, { numerator: 3, denominator: 2 }])
    expect(checkEpisodeOrder({ ...original, values: { position } }).values.position).toEqual(position);
});

test('owner admission refuses incomplete, unqualified, imprecise and undeclared occurrence fields', () => {
  const original = qualifier();
  for (const values of [
    {}, { ...original.values, position: 0.5 }, { ...original.values, position: { numerator: 1, denominator: 0 } },
    { ...original.values, position: { numerator: 2, denominator: 4 } },
    { ...original.values, position: { numerator: -1, denominator: 2 } },
    { ...original.values, position: { numerator: 1_000_000_000_001, denominator: 1 } },
    { ...original.values, disc: { numerator: 1, denominator: 2 } },
    { ...original.values, kindScheme: undefined }, { ...original.values, kindCode: undefined },
    { ...original.values, kindCode: true }, { ...original.values, label: '0.5\n' },
    { ...original.values, protagonist: true },
  ]) expect(() => checkEpisodeOrder(JSON.parse(JSON.stringify({ ...original, values })))).toThrow();
  expect(() => checkEpisodeOrder({ ...original, id: 'other-profile' })).toThrow();
  const group = { ...record(), role: 'group', target: undefined };
  expect(() => checkOccurrenceRecord(group, 'episode-list-v1')).toThrow();
});

test('the transport retains every existing field kind and refuses envelopes the native format cannot store', () => {
  const q = { type: 'fields', id: 'entry', values: { text: 'retained', flag: false,
    fraction: { numerator: 0, denominator: 1 }, title: { value: '特番', language: 'ja' }, refs: ['urn:source:a'] } };
  expect(Value.Check(declaredStructureQualifier, q)).toBe(true);
  for (const invalid of [
    { ...q, extra: true }, { ...q, values: { 'bad-key': 'field' } },
    { ...q, values: { fraction: { numerator: 0, denominator: 0 } } },
    { ...q, values: { fraction: { numerator: 0.5, denominator: 1 } } },
    { ...q, values: { title: { value: '特番', language: 'JA' } } },
    { ...q, values: { title: { value: '特番', language: 'ja', extra: 'discarded' } } },
    { ...q, values: { refs: Array(65).fill('urn:source:a') } },
  ]) expect(Value.Check(declaredStructureQualifier, invalid)).toBe(false);
});

test('immutable Structure records preserve repeated uses of the same Episode with independent source keys', async () => {
  const bodies = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = { put: async bytes => {
    const digest = createHash('sha256').update(bytes).digest('hex'); bodies.set(digest, bytes); return digest;
  }, get: async digest => bodies.get(digest)! };
  const records = [record(), record('second')], cost = newCost();
  for (const item of records) checkOccurrenceRecord(item, 'episode-list-v1');
  const tree = recordTree(objects), order = orderTree(objects);
  const root = await tree.apply(await tree.empty(cost), new Map(records.map(item => [item.occurrence, item])), cost);
  const ordered = await order.apply(await order.empty(cost), new Map(records.map(item => {
    const entry = { occurrence: item.occurrence, parent: item.parent, segmentKey: item.segmentKey!, orderKey: item.orderKey! };
    return [orderTreeKey(entry), entry];
  })), cost);
  const original = await tree.lookup(root, records.map(item => item.occurrence), newCost());
  expect(original.get(records[0]!.occurrence)).toEqual(records[0]!);
  expect(original.get(records[1]!.occurrence)).toEqual(records[1]!);
  expect(records[0]!.target).toBe(records[1]!.target);
  expect(records[0]!.sourceKey).not.toBe(records[1]!.sourceKey);
  expect(root).not.toEqual(ordered);
  const retired = { ...records[0]!, state: 'removed' as const, removedBy: id('human-revision'),
    segmentKey: undefined, orderKey: undefined };
  const changed = await tree.apply(root, new Map([[retired.occurrence, retired]]), newCost());
  expect((await tree.lookup(root, [retired.occurrence], newCost())).get(retired.occurrence)).toEqual(records[0]!);
  const current = await tree.lookup(changed, records.map(item => item.occurrence), newCost());
  expect(current.get(retired.occurrence)).toEqual(retired);
  expect(current.get(records[1]!.occurrence)).toEqual(records[1]!);
});

function hydration(entries: [string, string][]) {
  const calls: { query: string; bytes?: number }[] = [];
  const rows: Row[] = entries.map(([key, value]) => ({ p: uri(`${RV}${key}`),
    o: { ...literal(value), datatype: `http://www.w3.org/2001/XMLSchema#${/Numerator$|Denominator$/.test(key) ? 'integer' : 'string'}` } }));
  const env = { fuseki: { query: async (query: string, bytes?: number) => {
    calls.push({ query, bytes }); return { results: { bindings: rows } };
  } } } as unknown as WorkActivationEnvironment;
  return { env, calls, rows };
}
const fields: [string, string][] = [['episodePositionNumerator', '1'], ['episodePositionDenominator', '2'],
  ['episodeDiscNumerator', '0'], ['episodeDiscDenominator', '1'], ['episodeKindCode', '1'],
  ['episodeKindScheme', 'bangumi:episode:type'], ['episodeOrderLabel', '0.5']];

test('projection and bounded recovery preserve exact episode qualifiers without asserting Work ancestry or publication', async () => {
  const entry = state(), projected = projectEpisodeOrder(entry, id('generation'))!;
  expect(projected.iri).toBe(entry.placement);
  const triples = projected.triples.join('\n');
  expect(triples).toContain('rv:episodePositionNumerator 1');
  expect(triples).toContain('rv:episodePositionDenominator 2');
  expect(triples).toContain('rv:episodeDiscNumerator 0');
  expect(triples).toContain('"bangumi:episode:type"');
  expect(triples).not.toContain('composedWork');
  expect(triples).not.toContain('isPartOf');
  expect(projectEpisodeOrder({ ...entry, active: false, removedBy: id('human-revision') }, id('generation'))).toEqual(projected);
  const f = hydration(fields);
  expect(await hydrateEpisodeOrder(f.env, entry)).toEqual(qualifier());
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.query).toContain('LIMIT 8');
  expect(f.calls[0]!.bytes).toBe(32 * 1024);
  expect(f.calls[0]!.query).toContain(`<${entry.placement}>`);
});

test('recovery refuses partial or repeated fields instead of changing the next command intent', async () => {
  for (const entries of [fields.slice(1), fields.filter(([key]) => key !== 'episodeDiscDenominator'),
    fields.filter(([key]) => key !== 'episodeKindScheme'), [...fields, fields[0]!],
    fields.map(([key, value]): [string, string] => [key, key === 'episodePositionNumerator' ? '1.5' : value]),
    fields.map(([key, value]): [string, string] => [key, key === 'episodeDiscDenominator' ? '2' : value]),
    fields.map(([key, value]): [string, string] => [key, key === 'episodePositionNumerator' ? 'Infinity' : value]),
  ]) expect(await hydrateEpisodeOrder(hydration(entries).env, state())).toBeUndefined();
  for (const bad of [{ type: 'uri', value: '1' }, { ...literal('1'), 'xml:lang': 'en' }, literal('1'),
    { ...literal('1'), datatype: 'http://www.w3.org/2001/XMLSchema#string' }]) {
    const f = hydration(fields); f.rows[0]!.o = bad;
    expect(await hydrateEpisodeOrder(f.env, state())).toBeUndefined();
  }
  const wrongText = hydration(fields);
  wrongText.rows[4]!.o = { ...literal('1'), datatype: 'http://www.w3.org/2001/XMLSchema#integer' };
  expect(await hydrateEpisodeOrder(wrongText.env, state())).toBeUndefined();
  const wrongPredicate = hydration(fields);
  wrongPredicate.rows[0]!.p = literal(`${RV}episodePositionNumerator`);
  expect(await hydrateEpisodeOrder(wrongPredicate.env, state())).toBeUndefined();
  const minimal = hydration(fields.slice(0, 2));
  expect(await hydrateEpisodeOrder(minimal.env, state())).toEqual({ type: 'fields', id: 'episode-order-v1',
    values: { position: { numerator: 1, denominator: 2 } } });
});

test('actual command-target resolution and Semantic authority refuse wrong grains, denial and absent owner evidence', async () => {
  const principal = { issuer: 'account', subject: 'episode-reader' }, actor = id('actor'), target = id('episode-36420');
  let base = 'resource', type = 'https://schema.org/TVEpisode', allowed = true, present = true;
  let reads = 0, grants = 0;
  const graph = new FusekiClient('http://graph.invalid');
  graph.query = async query => {
    expect(query).toContain('SELECT ?epoch ?sequence ?r ?base ?work ?revision ?type'); reads++;
    return { results: { bindings: [{ epoch: literal('epoch'), sequence: literal('1'),
      ...(present ? { r: uri(target), base: literal(base), revision: uri(id('episode-revision')), type: uri(type),
        ...(base === 'work' ? { work: uri(target) } : {}) } : {}) }] } };
  };
  const access = { canReadWork: async () => false, canReadSemanticResource: async () => { grants++; return allowed; } };
  const deps = { environment: { fuseki: graph }, access } as unknown as MainWorkDependencies;
  const targetReader: StructureTargetReader = operation => operation(new WorkReadSession(deps,
    new Request('http://main.test'), {}, { dataEpoch: 'epoch', sequence: '1' }));
  const authority = { principal, actingSubject: actor, target, access,
    targetReader };
  expect(await authorizeEpisodeTarget(authority)).toBe(true);
  allowed = false;
  expect(await authorizeEpisodeTarget(authority)).toBe(false);
  allowed = true; base = 'work';
  expect(await authorizeEpisodeTarget(authority)).toBe(false);
  base = 'resource'; type = 'https://schema.org/MusicComposition';
  expect(await authorizeEpisodeTarget(authority)).toBe(false);
  present = false;
  await expect(authorizeEpisodeTarget(authority)).rejects.toThrow('Resource is unavailable');
  expect(reads).toBe(5); expect(grants).toBe(2);
  await expect(authorizeEpisodeTarget({ ...authority, targetReader: undefined })).rejects.toThrow('reader is unavailable');
  await expect(authorizeEpisodeTarget({ ...authority, access: { canReadWork: async () => true } }))
    .rejects.toThrow('authority is unavailable');
});

test('target grain and type are rechecked in the native commit predicate with bounded evidence', async () => {
  let invalid = false;
  const queries: string[] = [];
  const env = { fuseki: { query: async (query: string) => {
    queries.push(query); return { results: { bindings: invalid ? [{ target: uri(id('wrong-grain')) }] : [] } };
  } } } as unknown as WorkActivationEnvironment;
  const first = await episodeTargetGuard(env, id('owner'), [id('episode-36420'), id('episode-36420')]);
  expect(first.invalid).toBe(false);
  expect(first.guard).toContain('rv:semanticHead');
  expect(first.guard).toContain('https://schema.org/TVEpisode');
  expect(first.guard).toContain('rv:FixedRelease');
  expect(first.guard).toContain('rv:Release');
  expect(first.guard).not.toContain('*');
  expect(queries[0]).toContain('LIMIT 1');
  invalid = true;
  expect((await episodeTargetGuard(env, id('owner'), [id('episode-36420')])).invalid).toBe(true);
  expect(await episodeTargetGuard(env, id('owner'), [])).toEqual({ guard: '', rejection: '' });
  expect(queries).toHaveLength(2);
  expect(first.rejection.replace('FILTER EXISTS', 'FILTER NOT EXISTS')).toBe(first.guard);
});
