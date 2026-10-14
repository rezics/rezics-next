import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { MAIN_RELAY_STREAM_SCOPE, type RelayHandoffPosition } from '../src/modules/outbox/relay-position.ts';
import type { RealmPolicy } from '../src/modules/space/policy.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../src/modules/work/read-session.ts';
import { ZoneBrowseProjection } from '../src/modules/zone-browse/store.ts';
import { readZoneBrowse } from '../src/modules/zone-modules/browse.ts';
import { fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

const id = (value: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const realm = id(100), adopted = id(5), phrase = 'published but not adopted';
const term = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });

function fixture(type: string) {
  // Four prior indexed selections and an independently committed fifth
  // selection reproduce the historical complete-empty title-search shape.
  const inventory = Array.from({ length: 5 }, (_, index) => id(index + 1));
  const index = inventory.slice(0, 4);
  const source = { delivered: '37', committed: '38', graph: '38' };
  const indexReads: unknown[] = [];
  const environment = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: {
    query: async (body: string) => {
      if (body.includes('SELECT ?sequence ?relaySequence')) return { results: { bindings: [{
        sequence: term(source.graph), relaySequence: term(source.committed),
      }] } };
      if (body.includes('SELECT ?work ?head ?owningWork') && body.includes(`<${realm}>`)) {
        return { results: { bindings: [{ work: uri(realm), head: uri(id(101)) }] } };
      }
      throw new Error('Unexpected coverage or Realm disclosure query');
    },
  } } as unknown as WorkActivationEnvironment;
  configureDisclosure(environment, fixtureDisclosureReader(async targets => targets.map(target =>
    target.owner === 'graph' && target.resource === realm && target.component === 'record' ? 'visible' : 'hidden')));
  const access = { query: async (_sql: string, values: unknown[]) => {
    indexReads.push(values);
    expect(values[0]).toBe(realm);
    return { rows: [...index].reverse().map(work => ({ work,
      adopted_order: work === adopted ? '38' : work.slice(-1), updated_at: null, word_count: null })) };
  } } as unknown as Pool;
  const relay = { query: async () => ({ rows: [{ stream_scope: MAIN_RELAY_STREAM_SCOPE,
    data_epoch: 'epoch', sequence: source.delivered }] }) } as unknown as Pool;
  const projection = new ZoneBrowseProjection(access, relay, environment);
  const state = projection as unknown as { usableCut: boolean; checkpoint: RelayHandoffPosition };
  state.usableCut = true;
  state.checkpoint = { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch', sequence: '37' };
  const session = () => ({
    deps: { environment, zoneBrowse: projection }, options: { limit: 20, language: 'en' },
    position: { dataEpoch: 'epoch', sequence: source.graph }, viewer: ANONYMOUS_VIEWER,
    checkDeadline: () => {}, observeDependency: () => {},
    realm: async (): Promise<RealmPolicy> => ({ realmRevision: id(101), space: id(102),
      visibility: 'public', reviewMode: 'mandatory', revision: id(103), listing: 'listed',
      history: 'everything', admission: 'open' }),
    summaries: async (works: string[]) => works.map(work => ({ status: 'available', disclosure: 'public',
      type: 'work', name: { value: work === adopted ? phrase : `Prior selection ${work}`,
        language: 'en', direction: 'ltr', basis: 'requested' }, avatar: { kind: 'fallback',
        policy: 'test', key: work, resourceType: 'work' } })),
    query: async (body: string) => {
      const works = [...new Set([...body.matchAll(/<(https:\/\/rezics\.com\/id\/[^>]+)>/g)]
        .map(match => match[1]!).filter(work => inventory.includes(work)))];
      if (body.includes('?evidence')) return works.map(work => ({ work: uri(work), head: uri(id(104)),
        main: uri(id(105)), evidence: uri(id(106)), revisionEpoch: term('epoch'),
        sequence: term(work === adopted ? '38' : '1') }));
      if (body.includes('SELECT ?work ?type')) return works.map(work => ({ work: uri(work),
        type: uri(work === id(4) ? 'https://schema.org/Book' : type) }));
      if (body.includes('SELECT ?work ?head') || body.includes('# Zone population batch')) {
        return works.map(work => ({ work: uri(work) }));
      }
      return [];
    },
  }) as unknown as WorkReadSession;
  const cover = () => {
    index.push(adopted);
    source.delivered = '38';
    state.checkpoint = { ...state.checkpoint, sequence: '38' };
  };
  return { session, source, cover, indexReads, projection };
}

for (const type of ['VideoGame', 'Recipe', 'TVSeries'].map(name => `https://schema.org/${name}`)) {
  test(`delivered coverage cannot publish a complete-current omission of a committed ${type}`, async () => {
    const data = fixture(type);
    let answer: unknown;
    try { answer = await readZoneBrowse(data.session(), realm, { q: phrase, type: [type] }); }
    catch (error) { answer = error; }
    if (!(answer instanceof WorkReadUnavailable)) await Bun.write(
      `.temp/realm-browse-adoption-owner-${type.slice(type.lastIndexOf('/') + 1)}.json`,
      JSON.stringify({ expected: [adopted], adoptionPosition: { dataEpoch: 'epoch', sequence: '38' }, answer }, null, 2));
    expect(answer).toBeInstanceOf(WorkReadUnavailable);
    expect(data.indexReads).toEqual([]);
  });

  test(`first and later covered readers find the committed ${type} at its adoption position`, async () => {
    const data = fixture(type);
    data.cover();
    for (const reader of ['first', 'later']) {
      const page = await readZoneBrowse(data.session(), realm, { q: phrase, type: [type] });
      expect(page.items.map(item => item.id), reader).toEqual([adopted]);
      expect(page.matches).toEqual({ value: 1, kind: 'exact' });
      expect(page.window).toEqual({ scanned: 5, complete: true });
      expect(page.nextCursor).toBeNull();
      expect(page.sourcePosition).toEqual({ dataEpoch: 'epoch', sequence: '38' });
      expect(page.items[0]!.sequence).toBe('38');
    }
  });
}

test('a graph diagnostic counter cannot substitute for committed Main adoption coverage', async () => {
  const data = fixture('https://schema.org/VideoGame');
  data.source.graph = '1000';
  expect(await data.projection.current(data.session().position)).toBe(false);
  data.cover();
  expect(await data.projection.current(data.session().position)).toBe(true);
});
