import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { ContentCore } from '../../content/src/core.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { MediaStore } from '../src/modules/media/store.ts';
import { WorkReadMoved, WorkReadSession, WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { readZoneBrowse } from '../src/modules/zone-modules/browse.ts';
import { ZoneBrowseProjection } from '../src/modules/zone-browse/store.ts';
import { MAIN_RELAY_STREAM_SCOPE, type RelayHandoffPosition } from '../src/modules/outbox/relay-position.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import type { RealmPolicy } from '../src/modules/space/policy.ts';
import { fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const term = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });

function fixture(count: number) {
  const eligible = Array.from({ length: count }, (_, index) => id(index + 1));
  const state = { epoch: 'media', sequence: '1', changed: null as string | null,
    closing: false, closingCalls: 0, moveBetweenBatches: false };
  const attempted: string[][] = [];
  const pool = { query: async (_sql: string, values: unknown[]) => {
    const targets = values[0] as string[];
    if (state.closing && ++state.closingCalls === 2 && state.moveBetweenBatches) state.sequence = '2';
    const owner = { owner_epoch: state.epoch, owner_sequence: state.sequence };
    return { rows: [owner, ...targets.filter(target => target === state.changed)
      .map(target => ({ ...owner, target, context: 'urn:rezics:media:context:default', selection: 'changed' }))] };
  } } as unknown as Pool;
  const media = new MediaStore(pool, {} as ContentCore);
  const graph = new FusekiClient('http://graph.invalid/realm-browse-availability');
  graph.query = async body => {
    const resources = [...(body.match(/VALUES \?r \{([^}]+)\}/)?.[1] ?? '').matchAll(/<([^>]+)>/g)]
      .map(match => match[1]!);
    const control = { epoch: term('epoch'), sequence: term('7') };
    return { results: { bindings: [control, ...resources.filter(resource => eligible.includes(resource))
      .map(resource => ({ ...control, r: uri(resource), work: uri(resource), head: uri(id(1000)),
        type: term('work'), public: term('true'), label: { ...term(`Animation ${resource}`), 'xml:lang': 'en' } }))] } };
  };
  const deps = { environment: { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } },
    media: { store: { avatarRows: (targets: readonly string[], context: string) => {
      attempted.push([...targets]);
      return media.avatarRows(targets, context);
    } } } } as unknown as MainWorkDependencies;
  const session = new WorkReadSession(deps, new Request('http://main.test/v1/realms/browse'), {},
    { dataEpoch: 'epoch', sequence: '7' });
  const prepare = async () => {
    const summaries = [];
    for (let offset = 0; offset < eligible.length; offset += 64) {
      summaries.push(...await session.summaries(eligible.slice(offset, offset + 64)));
    }
    expect(summaries.map(summary => summary.reference)).toEqual(eligible);
    expect(summaries.every(summary => summary.status === 'available')).toBe(true);
    state.closing = true;
  };
  return { eligible, session, state, attempted, prepare };
}

for (const count of [65, 129]) {
  test(`browse summary sections retain all ${count} eligible identities through bounded media fences`, async () => {
    const f = fixture(count);
    await f.prepare();
    await f.session.fenceSummaryMedia();
    expect(f.attempted.every(batch => batch.length <= 64)).toBe(true);
    expect(f.attempted.slice(Math.ceil(count / 64)).flat()).toEqual(f.eligible);
  });
}

test('the final media batch still rejects a changed avatar', async () => {
  const f = fixture(65);
  await f.prepare();
  f.state.changed = f.eligible[64]!;
  await expect(f.session.fenceSummaryMedia()).rejects.toBeInstanceOf(WorkReadMoved);
});

test('a media generation change between closing batches cannot combine incompatible cuts', async () => {
  const f = fixture(65);
  await f.prepare();
  f.state.moveBetweenBatches = true;
  await expect(f.session.fenceSummaryMedia()).rejects.toBeInstanceOf(WorkReadMoved);
});

test('a restored media owner still rejects the retained summary basis', async () => {
  const f = fixture(65);
  await f.prepare();
  f.state.epoch = 'restored';
  await expect(f.session.fenceSummaryMedia()).rejects.toBeInstanceOf(WorkReadMoved);
});

test('stale classification cannot assert an exact empty Condition inventory', async () => {
  const eligible = [id(1)], concept = id(2), realm = id(3);
  const environment = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: {
    query: async (body: string) => {
      if (!body.includes('SELECT ?work ?head ?owningWork') || !body.includes(`<${realm}>`)) {
        throw new Error('Unexpected Realm disclosure query');
      }
      return { results: { bindings: [{ work: uri(realm), head: uri(id(4)) }] } };
    },
  } } as unknown as WorkActivationEnvironment;
  configureDisclosure(environment, fixtureDisclosureReader(async targets => targets.map(target =>
    target.owner === 'graph' && target.resource === realm && target.component === 'record' ? 'visible' : 'hidden')));
  const session = { options: { limit: 5 }, position: { dataEpoch: 'epoch', sequence: '7' },
    viewer: ANONYMOUS_VIEWER,
    checkDeadline: () => {},
    observeDependency: () => {},
    realm: async (): Promise<RealmPolicy> => ({ realmRevision: id(4), space: id(9),
      visibility: 'public', reviewMode: 'mandatory', revision: id(10), listing: 'listed',
      history: 'everything', admission: 'open' }),
    query: async (body: string) => body.includes('?evidence')
      ? eligible.map(work => ({ work: uri(work), main: uri(id(5)), head: uri(id(6)),
        evidence: uri(id(7)), revisionEpoch: term('epoch'), sequence: term('1') }))
      : body.includes('SELECT ?work ?type') ? eligible.map(work => ({ work: uri(work), type: uri('https://schema.org/TVSeries') })) : [],
    summaries: async (resources: string[]) => resources.map(reference => ({ reference, status: 'available',
      disclosure: 'public', type: reference === concept ? 'concept' : 'work',
      name: { value: 'Selected animation', language: 'en', direction: 'ltr', basis: 'requested' } })),
    deps: { environment, zoneBrowse: { current: () => true, batch: async (_realm: string, _sort: string, after: unknown) => after ? []
      : eligible.map(work => ({ work, adoptedOrder: '1', updatedAt: null, words: null })) },
    discovery: { active: async () => ({ stale: true }), workTerms: async () => eligible.map(work => ({ work, concept })) } },
  } as unknown as WorkReadSession;
  for (const filter of [{ concept: [concept] }, { excludeConcept: [id(8)] }]) {
    await expect(readZoneBrowse(session, realm, filter)).rejects.toBeInstanceOf(WorkReadUnavailable);
  }
});

test('a delivered watermark before the 65th committed selection cannot prove a current inventory', async () => {
  const eligible = Array.from({ length: 65 }, (_, index) => id(index + 1));
  const relay = { query: async () => ({ rows: [{ stream_scope: MAIN_RELAY_STREAM_SCOPE,
    data_epoch: 'epoch', sequence: String(eligible.length - 1) }] }) } as unknown as Pool;
  const env = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: {
    query: async () => ({ results: { bindings: [{ sequence: term('1000'),
      relaySequence: term(String(eligible.length)) }] } }),
  } } as unknown as WorkActivationEnvironment;
  const projection = new ZoneBrowseProjection({} as Pool, relay, env);
  const state = projection as unknown as { usableCut: boolean; checkpoint: RelayHandoffPosition };
  state.usableCut = true;
  state.checkpoint = { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch', sequence: '64' };
  expect(await projection.current({ dataEpoch: 'epoch', sequence: '1000' })).toBe(false);
});
