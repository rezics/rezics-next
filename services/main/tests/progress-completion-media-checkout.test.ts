import { expect, spyOn, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import { ContentCore } from '../../content/src/core.ts';
import { boundedPool, NestedPoolCheckoutError, nestedPoolCheckoutMode,
  setNestedPoolCheckoutMode } from '../src/infrastructure/pg-pool.ts';
import { MediaStore, DEFAULT_MEDIA_CONTEXT } from '../src/modules/media/store.ts';
import { ProgressCompletionProjector, type CompletionPlanner } from '../src/modules/progress/completion.ts';
import { graphCompletionPlanner } from '../src/modules/progress/completion-plan.ts';
import type { StructureProgressStore } from '../src/modules/progress/store.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const target = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const structure = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const credit = { source: { displayName: 'Cover archive', href: 'https://archive.example/cover' },
  holderEvidence: { name: 'Cover artist' } };

async function fixture(run: (pool: Pool, media: MediaStore, state: {
  checkouts: number; releases: number; held: boolean; statements: string[];
}) => Promise<void>) {
  const state = { checkouts: 0, releases: 0, held: false, statements: [] as string[] };
  const connect = spyOn(Pool.prototype, 'connect').mockImplementation(((callback?: unknown) => {
    state.checkouts++;
    const client = {
      query(text: string, values?: unknown, done?: (error: undefined, result: { rows: unknown[] }) => void) {
        state.statements.push(text);
        const rows = text.includes('WITH owner AS') ? [{ target, context: DEFAULT_MEDIA_CONTEXT,
          selection: 'cleared-selection', use: 'cleared-use', asset_id: 'asset', cover_only: true,
          cover_provenance: credit, owner_epoch: 'epoch', owner_sequence: '7' }]
          : text.includes('SELECT DISTINCT ON (structure, occurrence)') && state.held ? [{ structure, occurrence: target }] : [];
        const result = { rows };
        const cb = typeof values === 'function' ? values as typeof done : done;
        cb?.(undefined, result);
        return Promise.resolve(result);
      },
      release() { state.releases++; },
      on() { return client; },
      once() { return client; },
      removeListener() { return client; },
    } as unknown as PoolClient;
    if (typeof callback === 'function') {
      (callback as (error: undefined, client: PoolClient, release: () => void) => void)(undefined, client, client.release);
      return;
    }
    return Promise.resolve(client);
  }) as Pool['connect']);
  const mode = nestedPoolCheckoutMode();
  setNestedPoolCheckoutMode('throw');
  const pool = boundedPool({ max: 1, connectionTimeoutMillis: 50 });
  try { await run(pool, new MediaStore(pool, new ContentCore(pool)), state); }
  finally {
    setNestedPoolCheckoutMode(mode);
    connect.mockRestore();
    await pool.end();
  }
}

test('completion demand and release planning hydrate avatars and disclosure on the held Content client', async () => {
  await fixture(async (pool, media, state) => {
    const hydrated: string[] = [];
    let demandClient: PoolClient;
    const read = async (kind: string, client?: PoolClient) => {
      if (client) expect(client).toBe(demandClient);
      const hydrate = async () => {
        const result = await media.avatarRows([target], DEFAULT_MEDIA_CONTEXT);
        expect(result.generation).toEqual({ owner: 'content', dataEpoch: 'epoch', sequence: '7' });
        expect(result.rows.get(target)).toMatchObject({ selection: 'cleared-selection', use: 'cleared-use',
          coverOnly: true, coverCredit: { kind: 'copyright', text: 'Cover artist', holder: 'Cover artist',
            source: { name: credit.source.displayName, href: credit.source.href }, permittedRole: 'cover' } });
        await media.visibilityFacts([target]);
        hydrated.push(kind);
        return null;
      };
      return client ? media.withSummaryClient(client, hydrate) : hydrate();
    };
    const planner: CompletionPlanner = {
      occurrence: (_target, client) => read('occurrence', client),
      lastOf: (_work, client) => read('lastOf', client),
    };
    const projector = new ProgressCompletionProjector({} as StructureProgressStore, pool, planner);
    const source = { agent: target, principal: { issuer: 'https://account.example', subject: 'reader' }, source: 'session:finished',
      demand: async (client: PoolClient) => {
        demandClient = client;
        return { occurrences: [target], lastOfWorks: [target] };
      } };
    await projector.reconcile(source);
    state.held = true;
    await projector.reconcile({ ...source, demand: async client => {
      demandClient = client;
      return { occurrences: [], lastOfWorks: [] };
    } });
    expect(hydrated).toEqual(['occurrence', 'lastOf', 'occurrence']);
    expect(state.checkouts).toBe(2);
    expect(state.releases).toBe(2);
    expect(state.statements.filter(sql => sql === 'COMMIT')).toHaveLength(2);
  });
});

test('graph completion binds both planner methods to the supplied summary client', async () => {
  await fixture(async (pool, media) => {
    const client = await pool.connect();
    const binding = spyOn(media, 'withSummaryClient').mockImplementation((async () => null) as MediaStore['withSummaryClient']);
    try {
      const planner = graphCompletionPlanner({ media: { store: media } } as unknown as MainWorkDependencies);
      expect(await planner.occurrence(target, client)).toBeNull();
      expect(await planner.lastOf(target, client)).toBeNull();
      expect(binding.mock.calls.map(call => call[0])).toEqual([client, client]);
    } finally { binding.mockRestore(); client.release(); }
  });
});

test('summary borrowing ends on failure and ordinary reads retain the nested-checkout guard', async () => {
  await fixture(async (pool, media, state) => {
    const client = await pool.connect();
    try {
      await expect(media.avatarRows([target], DEFAULT_MEDIA_CONTEXT)).rejects.toBeInstanceOf(NestedPoolCheckoutError);
      await expect(media.withSummaryClient(client, async () => {
        await media.avatarRows([target], DEFAULT_MEDIA_CONTEXT);
        throw new Error('read failed');
      })).rejects.toThrow('read failed');
      await expect(media.avatarRows([target], DEFAULT_MEDIA_CONTEXT)).rejects.toBeInstanceOf(NestedPoolCheckoutError);
      expect(state.releases).toBe(0);
    } finally { client.release(); }
    expect((await media.avatarRows([target], DEFAULT_MEDIA_CONTEXT)).rows.has(target)).toBe(true);
    expect(state.checkouts).toBe(2);
    expect(state.releases).toBe(2);
  });
});
