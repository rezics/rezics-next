import { createPool } from '../../src/database/pool.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { createSubjectProjectionCoordinator, type IndexIncarnation } from '../../src/search/coverage.ts';
import { createOpenSearch, SearchUnavailableError, type OpenSearch } from '../../src/search/opensearch.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';

export type Gate = { phase: 'before-bulk' | 'after-bulk' | 'before-refresh'; ordinal: number; lose?: boolean };
export type ChildCommand =
  | { id: number; op: 'open'; incarnation: IndexIncarnation; gate: Gate | null }
  | { id: number; op: 'run'; partition: number }
  | { id: number; op: 'release' }
  | { id: number; op: 'close' };
export type ChildMessage = {
  id?: number;
  event?: string;
  value?: unknown;
  error?: string;
};

// Only the production coordinator runs here. Decorations observe native results or delay transport;
// they never substitute source facts, bulk responses, checkpoint results or readiness evidence.
let pool: ReturnType<typeof createPool> | undefined;
let coordinator: ReturnType<typeof createSubjectProjectionCoordinator> | undefined;
let incarnation: IndexIncarnation;
let gate: Gate | null;
let resume: (() => void) | undefined;
let bulkOrdinal = 0;
let refreshOrdinal = 0;
let active = false;
const send = (message: ChildMessage) => process.send?.(message);
async function boundary(phase: Gate['phase'], ordinal: number, value?: unknown) {
  if (gate?.phase !== phase || gate.ordinal !== ordinal) return;
  const waiting = Promise.withResolvers<void>();
  resume = () => waiting.resolve();
  send({ event: 'gate', value: { phase, ordinal, data: value } });
  await waiting.promise;
  resume = undefined;
  if (gate.lose) throw new SearchUnavailableError('Actual bulk applied; response lost at controlled transport');
}

process.on('message', (input: unknown) => {
  const command = input as ChildCommand;
  void (async () => {
    switch (command.op) {
      case 'open': {
        if (pool) throw new Error('Child already opened');
        const database = process.env.DATABASE_URL;
        const engine = process.env.OPENSEARCH_URL;
        if (!database || !engine) throw new Error('Native database and engine environment required');
        incarnation = command.incarnation;
        gate = command.gate;
        pool = createPool(database);
        const search = createOpenSearch(engine);
        const nativeSource = subjectSource(pool, new Uint8Array(32).fill(83));
        const transport: OpenSearch = {
          async bulk<T>(lines: readonly unknown[], options?: Parameters<OpenSearch['bulk']>[1]) {
            const ordinal = ++bulkOrdinal;
            await boundary('before-bulk', ordinal, lines);
            const result = await search.bulk<T>(lines, options);
            send({ event: 'bulk', value: { ordinal, lines, result } });
            await boundary('after-bulk', ordinal, result);
            return result;
          },
          async request<T>(
            method: Parameters<OpenSearch['request']>[0],
            path: string,
            body?: unknown,
            options?: Parameters<OpenSearch['request']>[3],
          ) {
            if (path === `/${incarnation.index}/_refresh`) await boundary('before-refresh', ++refreshOrdinal);
            return search.request<T>(method, path, body, options);
          },
        };
        coordinator = createSubjectProjectionCoordinator({
          pool,
          search: transport,
          source: {
            ...nativeSource,
            async read(partition, ids) {
              send({ event: 'source', value: { partition, ids: [...ids] } });
              return nativeSource.read(partition, ids);
            },
          },
          listing: subjectListingSource(pool),
          prefix: incarnation.prefix,
        });
        return { pid: process.pid };
      }
      case 'release':
        if (!resume) throw new Error('No held transport boundary');
        resume();
        return null;
      case 'run':
        if (!coordinator || active) throw new Error('Child not open or run already active');
        active = true;
        try {
          return await coordinator.run(incarnation, command.partition);
        } finally {
          active = false;
        }
      case 'close':
        if (active) throw new Error('Cannot close an unresolved run');
        await pool?.end();
        return null;
    }
  })().then(
    (value) => send({ id: command.id, value }),
    (error) => send({ id: command.id, error: error instanceof Error ? (error.stack ?? error.message) : String(error) }),
  );
});
// Disconnect never records successful drain; the parent must retain the durable ambiguous attempt.
process.on('disconnect', () => process.exit(1));
