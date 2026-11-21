import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { withBoundedReadLifetime } from '../src/database/bounded-read-lifetime.ts';
import { isEconomyBookId } from '../src/economy/contract.ts';
import { reconcileBook, type BookReconciliationDatabase } from '../src/economy/storage/book-reconciliation.ts';

const credentialName = 'ECONOMY_RECONCILIATION_DATABASE_URL';
const usage = {
  kind: 'usage',
  credentialEnvironment: credentialName,
  arguments: '--book BOOK [--page-limit 1..2048] [--timeout-ms 100..10000]',
  statuses: { consistent: 0, invalid: 2, absent: 3, incomplete: 4, divergent: 5, unavailable: 6 },
} as const;
type Options = Readonly<{ bookId: string; pageLimit?: number; timeoutMillis: number }>;

function integer(raw: string, min: number, max: number): number | undefined {
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) return undefined;
  const value = Number(raw);
  return value >= min && value <= max ? value : undefined;
}

function parseArguments(args: readonly string[]): Options | undefined {
  if (args.length < 2 || args.length > 6 || args.length % 2 !== 0) return undefined;
  const named = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    if (!['--book', '--page-limit', '--timeout-ms'].includes(key) || named.has(key)) return undefined;
    named.set(key, args[i + 1]!);
  }
  const bookId = named.get('--book');
  if (bookId === undefined || !isEconomyBookId(bookId)) return undefined;
  const rawLimit = named.get('--page-limit');
  const pageLimit = rawLimit === undefined ? undefined : integer(rawLimit, 1, 2048);
  const timeoutMillis = integer(named.get('--timeout-ms') ?? '8000', 100, 10_000);
  if ((rawLimit !== undefined && pageLimit === undefined) || timeoutMillis === undefined) return undefined;
  return { bookId, ...(pageLimit === undefined ? {} : { pageLimit }), timeoutMillis };
}

function databaseConfig(raw: string | undefined, timeoutMillis: number): PoolConfig | undefined {
  if (!raw || raw.trim() !== raw || /[\x00-\x1f\x7f]/.test(raw)) return undefined;
  try {
    const url = new URL(raw);
    const sslModes = url.searchParams.getAll('sslmode');
    const sslMode = sslModes[0] ?? 'verify-full';
    if (
      (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
      url.hash ||
      !url.hostname ||
      !/^\/[^/]+$/.test(url.pathname) ||
      [...url.searchParams.keys()].some((key) => key !== 'sslmode') ||
      sslModes.length > 1 ||
      (sslMode !== 'disable' && sslMode !== 'verify-full')
    )
      return undefined;
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const database = decodeURIComponent(url.pathname.slice(1));
    const port = integer(url.port || '5432', 1, 65535);
    if (
      !user ||
      !password ||
      !database ||
      [user, password, database].some((value) => value.includes('\0')) ||
      port === undefined
    )
      return undefined;
    const config: PoolConfig & { replication: 'false' } = {
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port,
      user,
      password,
      database,
      ssl: sslMode === 'verify-full',
      sslnegotiation: 'postgres',
      replication: 'false',
      client_encoding: 'UTF8',
      application_name: 'economy-book-audit',
      // Override ambient PGOPTIONS and make startup read-only even before the pinned transaction begins.
      options: '-c default_transaction_read_only=on -c search_path=pg_catalog',
      connectionTimeoutMillis: timeoutMillis,
      max: 1,
    };
    return config;
  } catch {
    return undefined;
  }
}

function snapshotDatabase(pool: Pool): BookReconciliationDatabase {
  return {
    snapshot(deadline, work) {
      let discarded: PoolClient | undefined;
      return withBoundedReadLifetime(
        async (run) => {
          const client = await pool.connect();
          try {
            return await run(client);
          } finally {
            if (discarded !== client) client.release();
          }
        },
        (client, error) => {
          discarded = client;
          client.release(error);
        },
        deadline,
        work,
        { transaction: 'repeatable-read-read-only' },
      );
    },
  };
}

function emit(result: object, status: number): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = status;
}

async function main(args: readonly string[], credential: string | undefined): Promise<void> {
  if (args.length === 1 && args[0] === '--help') return emit(usage, 0);
  const options = parseArguments(args);
  if (options === undefined) return emit({ kind: 'invalid', reason: 'arguments' }, usage.statuses.invalid);
  const config = databaseConfig(credential, options.timeoutMillis);
  if (!config) return emit({ kind: 'invalid', reason: 'database_configuration' }, usage.statuses.invalid);
  const pool = new Pool(config);
  // The single awaited checkout classifies errors. Idle client errors must never print driver details.
  pool.on('error', () => {});
  try {
    const report = await reconcileBook(snapshotDatabase(pool), {
      bookId: options.bookId,
      deadline: Date.now() + options.timeoutMillis,
      ...(options.pageLimit === undefined ? {} : { pageLimit: options.pageLimit }),
    });
    await pool.end();
    emit(report, usage.statuses[report.kind]);
  } catch {
    if (!pool.ending) await pool.end().catch(() => {});
    emit({ kind: 'unavailable', bookId: options.bookId }, usage.statuses.unavailable);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2), process.env[credentialName]).catch(() =>
    emit({ kind: 'unavailable' }, usage.statuses.unavailable),
  );
}
