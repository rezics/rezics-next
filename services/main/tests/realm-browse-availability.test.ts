import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { ContentCore } from '../../content/src/core.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { MediaStore } from '../src/modules/media/store.ts';
import { WorkReadMoved, WorkReadSession } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

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
