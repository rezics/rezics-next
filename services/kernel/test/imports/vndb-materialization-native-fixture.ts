import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { converter_revision, type VndbConversion } from '../../../../packages/conversion/src/vndb.ts';
import { bindVndbDriver } from '../../../../packages/conversion/tests/vndb-driver.ts';
import { bundledRelease, bundledDigest } from '@rezics/definitions/bundled';
import type { VndbTablesDriver } from '../../../../specs/imports-vndb-tables-driver.ts';
import { runImportCli } from '../../../importer/src/cli.ts';
import { Importer } from '../../../importer/src/importer.ts';
import { createImportTransport } from '../../../importer/src/import-client.ts';
import { VndbMaterialization } from '../../../importer/src/vndb-materialization.ts';
import { openApiRuntime, type ApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { createGrowthSqliteCapture } from './growth-sqlite-capture.ts';
import { identitySupport } from './identity-fixture.ts';
import { captureVndbStatistics, VNDB_API_ORIGIN } from './vndb-statistics-driver.ts';

const names = ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta'];
const text = (name: string) =>
  readFileSync(new URL(`../../../../specs/fixtures/imports/vndb-tables/db/${name}`, import.meta.url), 'utf8');

const converter = bindVndbDriver();

/** Live logical rows only. SQLite free pages/WAL remnants are not logical retention. */
function logicalMarkers(db: Database, markers: string[]) {
  const found = new Set<string>();
  const tables = db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {
    name: string;
  }[];
  for (const { name } of tables) {
    for (const row of db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).iterate()) {
      for (const value of Object.values(row as object)) {
        const bytes = value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : String(value);
        for (const marker of markers) if (bytes.includes(marker)) found.add(marker);
      }
    }
  }
  return [...found].sort();
}

function transportFor(
  runtime: ApiRuntime,
  capture: ReturnType<typeof captureVndbStatistics>,
  onRequest: (request: Request) => void,
) {
  const transport = createImportTransport({
    origin: VNDB_API_ORIGIN,
    tokenProvider: async () => runtime.bulk.bearer,
    fetch: (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      onRequest(request);
      return capture.fetch(request);
    }) as typeof fetch,
  });
  return {
    batchWrite: (body: Parameters<typeof transport.batch>[0]) => transport.batch(body),
    readFence: (tuple: { source: string; external_id: string; field_group: 'facts' | 'summary' | 'cover' }) =>
      transport.fence({ source: tuple.source, externalId: tuple.external_id, fieldGroup: tuple.field_group }),
    writeSourceStatistic: (input: Parameters<typeof transport.writeSourceStatistic>[0], signal?: AbortSignal) =>
      transport.writeSourceStatistic(input, signal),
  };
}

export async function createVndbTablesDriver(
  limits: { childRowsPerVn: number; pageSize: number },
  attachSqlite: (database: Database) => void,
): Promise<VndbTablesDriver> {
  const runtimeSqlite = createGrowthSqliteCapture();
  const instrumentRuntime = runtimeSqlite.instrument;
  runtimeSqlite.instrument = (db) => {
    attachSqlite(db);
    return instrumentRuntime(db);
  };
  const runtime = await openApiRuntime(
    { batchRecords: 8, maxFields: 64, maxRecordBytes: 65536, sourceStatistics: 'vndb' },
    runtimeSqlite,
  );
  let directory: string | undefined;
  let importer: Importer | undefined;
  let materialization: VndbMaterialization;
  let activeRun: string | null = null;
  const events: Array<{ run: string | null; kind: 'conversion' | 'published' | 'request'; value: number | string }> =
    [];
  let measuring = false;
  let writes = 0,
    peakRows = 0,
    statements = 0,
    returnedRows = 0,
    kernelCalls = 0;
  const executedSql: string[] = [];
  const capture = captureVndbStatistics(runtime);
  // Count real application executor calls, including acquired clients. Stage/page
  // make none; this boundary observes that absence rather than predicting it.
  const pool = runtime.database.pool;
  const query = pool.query.bind(pool);
  pool.query = ((...args: unknown[]) => {
    if (measuring) kernelCalls++;
    return Reflect.apply(query, pool, args);
  }) as typeof pool.query;
  const connected = new WeakSet<object>();
  const connect = pool.connect.bind(pool);
  pool.connect = (async (...args: unknown[]) => {
    const client = await Reflect.apply(connect, pool, args);
    if (client && !connected.has(client)) {
      connected.add(client);
      const query = client.query.bind(client);
      client.query = ((...args: unknown[]) => {
        if (measuring) kernelCalls++;
        return Reflect.apply(query, client, args);
      }) as typeof client.query;
    }
    return client;
  }) as typeof pool.connect;

  const transport = transportFor(runtime, capture, (request) => {
    events.push({ run: activeRun, kind: 'request', value: `${request.method} ${new URL(request.url).pathname}` });
  });
  const batchWrite = transport.batchWrite;
  transport.batchWrite = async (request) => {
    const result = await batchWrite(request);
    events.push({
      run: activeRun,
      kind: 'published',
      value: result.results.filter((r) => r.status === 200 || r.status === 201).length,
    });
    return result;
  };
  const instrumentDatabase = (db: Database) => {
    attachSqlite(db); // Before RunStore, bindings, table DDL or any preparation.
    const seen = new WeakSet<object>();
    for (const method of ['prepare', 'query'] as const) {
      const original = db[method].bind(db);
      Object.defineProperty(db, method, {
        configurable: true,
        value: (...args: unknown[]) => {
          const statement = Reflect.apply(original, db, args);
          if (seen.has(statement)) return statement;
          seen.add(statement);
          for (const operation of ['get', 'all', 'run', 'values'] as const) {
            const execute = statement[operation].bind(statement);
            Object.defineProperty(statement, operation, {
              configurable: true,
              value: (...values: unknown[]) => {
                executedSql.push(String(args[0]));
                if (measuring) statements++;
                const result = Reflect.apply(execute, statement, values);
                if (measuring && operation === 'get' && result != null) returnedRows++;
                if (measuring && (operation === 'all' || operation === 'values'))
                  returnedRows += (result as unknown[]).length;
                return result;
              },
            });
          }
          return statement;
        },
      });
    }
    const exec = db.exec.bind(db);
    Object.defineProperty(db, 'exec', {
      configurable: true,
      value: (sql: string) => {
        executedSql.push(sql);
        if (measuring) statements++;
        return exec(sql);
      },
    });
    return db;
  };
  const open = () => {
    importer = new Importer({
      path: join(directory!, 'import.sqlite'),
      transport,
      instrumentDatabase,
      onConversionOutput(output) {
        events.push({ run: activeRun, kind: 'conversion', value: output.proposals.length });
      },
    });
    materialization = new VndbMaterialization(importer, undefined, {
      ...limits,
      observer: {
        onRowWrite() {
          if (measuring) writes++;
        },
        onBufferedRows(rows) {
          if (measuring) peakRows = Math.max(peakRows, rows);
        },
      },
    });
  };
  const close = async () => {
    try {
      await importer?.close();
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        await runtime.close();
      }
    }
  };
  try {
    directory = await mkdtemp(join(tmpdir(), 'vndb-materialization-'));
    open();
    return {
      converter,
      async begin() {
        return materialization.begin();
      },
      async stage(run, entries) {
        await materialization.stage(run, entries);
      },
      async page(run, after, limit) {
        const page = materialization.page(run, after, limit);
        for (const row of page.records) events.push({ run, kind: 'conversion', value: row.output.proposals.length });
        return page;
      },
      async commit(run) {
        activeRun = run;
        try {
          const result = await materialization.commit(run);
          if (result.status !== 'committed') throw new Error(`VNDB publication: ${JSON.stringify(result)}`);
        } finally {
          activeRun = null;
        }
      },
      async baseline(key) {
        return materialization.baseline(key);
      },
      async inspect(run) {
        const retained = importer!.session.store.database
          .query(`SELECT DISTINCT table_name FROM vndb_table_rows WHERE source=? AND run_id=?`)
          .all('vndb', run) as { table_name: string }[];
        const observations = events.filter((event) => event.run === run);
        const sum = (kind: 'conversion' | 'published') =>
          observations.filter((e) => e.kind === kind).reduce((n, e) => n + Number(e.value), 0);
        return {
          ...materialization.tables.inspect('vndb', run),
          retainedTables: retained.map((row) => row.table_name),
          proposalEmissions: sum('conversion'),
          publishedProposals: sum('published'),
          externalRequests: observations.filter((e) => e.kind === 'request').map((e) => String(e.value)),
          executedDumpStatements: executedSql.filter(
            (sql) => sql.includes('pg_sleep(999)') || sql.includes('PRIVATE_SENTINEL'),
          ).length,
        };
      },
      async retainedMarkers(markers) {
        return logicalMarkers(importer!.session.store.database, markers);
      },
      async measure(operation) {
        if (measuring)
          return {
            value: await operation(),
            cost: {
              statements,
              rows: returnedRows,
              rowWrites: writes,
              peakBufferedRows: peakRows,
              crossPartitionStatements: kernelCalls,
            },
          };
        writes = peakRows = statements = returnedRows = kernelCalls = 0;
        measuring = true;
        try {
          const value = await operation();
          return {
            value,
            cost: {
              statements,
              rows: returnedRows,
              rowWrites: writes,
              peakBufferedRows: peakRows,
              crossPartitionStatements: kernelCalls,
            },
          };
        } finally {
          measuring = false;
        }
      },
      async seed({ unrelatedKeys, historicalActivity }) {
        // Synthetic unrelated native records enter the same actual table/source.
        // Their catalogue identities are created through ordinary bulk commands.
        const contents: Record<string, string> = {};
        for (const name of names) contents[name] = name.endsWith('.header') ? text(name) : '';
        for (let i = 0; i < unrelatedKeys; i++) {
          const id = `v${100000 + i}`;
          contents.vn += `${id}\t\\N\t\\N\ten\t0\t\\N\t\\N\t\\N\t0\t0\t0\t\t\n`;
          contents.vn_titles += `${id}\ten\tt\tUnrelated ${i}\t\\N\n`;
          contents.entry_meta += `${id}\t2020-01-01\t2026-10-25\t1\t0\t0\n`;
        }
        const run = materialization.begin();
        await materialization.stage(
          run,
          (async function* () {
            for (const name of names) {
              const bytes = new TextEncoder().encode(contents[name]!);
              yield {
                path: `db/${name}`,
                kind: 'file' as const,
                declaredBytes: bytes.length,
                bytes: (async function* () {
                  for (let i = 0; i < bytes.length; i += 4096) yield bytes.slice(i, i + 4096);
                })(),
              };
            }
          })(),
        );
        let after: string | null = null;
        do {
          const page = materialization.page(run, after, limits.pageSize);
          const commands = page.records.flatMap((row) => row.output.proposals);
          const response = await transport.batchWrite({ commands });
          if (response.results.some((r) => r.status !== 200 && r.status !== 201))
            throw new Error('Unrelated native catalogue seed failed');
          after = page.next;
        } while (after);
        // Actual abandoned staging activity, not invented receipt history. Each
        // supplied key is durable in RunStore; it never becomes a complete baseline.
        const page = materialization.page(run, null, 1);
        const row = page.records[0]!;
        const store = importer!.session.store;
        for (let i = 0; i < historicalActivity; i++) {
          const history = store.begin('vndb');
          if (history === 'busy') throw new Error('Historical seed source is busy');
          store.stage(history, {
            row: {
              source: 'vndb',
              recordKey: row.key,
              recordRevision: String(row.revision),
              digest: row.output.digest,
              converter_revision,
              state: 'present',
            },
            projection: { sourceKind: 'vndb', normalizedRecord: row.output.normalizedRecord },
          });
          store.seal(history, { complete: false, reason: 'truncated' });
        }
      },
      async reopen() {
        await importer!.close();
        open();
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function* archive(lateDuplicate = false): AsyncGenerator<Uint8Array> {
  for (const name of [...names, ...(lateDuplicate ? ['entry_meta'] : [])]) {
    const body = new TextEncoder().encode(text(name));
    const header = new Uint8Array(512);
    const put = (offset: number, value: string) => header.set(new TextEncoder().encode(value), offset);
    put(0, `db/${name}`);
    put(100, '0000644\0');
    put(108, '0000000\0');
    put(116, '0000000\0');
    put(124, body.length.toString(8).padStart(11, '0') + '\0');
    put(136, '00000000000\0');
    put(148, '        ');
    put(156, '0');
    put(257, 'ustar\0');
    put(263, '00');
    put(
      148,
      header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
    );
    yield header;
    yield body;
    if (body.length % 512) yield new Uint8Array(512 - (body.length % 512));
  }
  yield new Uint8Array(1024);
}

export async function runVndbMaterializationPublication() {
  const runtime = await openApiRuntime({
    batchRecords: 8,
    maxFields: 64,
    maxRecordBytes: 65536,
    sourceStatistics: 'vndb',
  });
  let directory: string | undefined, secrets: string | undefined;
  const close = async () => {
    try {
      if (directory) await rm(directory, { recursive: true, force: true });
    } finally {
      try {
        if (secrets) await rm(secrets, { recursive: true, force: true });
      } finally {
        await runtime.close();
      }
    }
  };
  try {
    directory = await mkdtemp(join(tmpdir(), 'vndb-publication-'));
    secrets = await mkdtemp('/dev/shm/vndb-publication-key-');
    const support = identitySupport(runtime.identity);
    await support.renewManagement();
    const kid = randomUUID(),
      pair = await generateKeyPair('ES256', { extractable: true });
    const staged = await runtime.identity.auth.internal.stageCredentialEffect({
      key: kid,
      subjectAccountId: runtime.identity.bulk.accountId,
      headers: support.managementHeaders,
      credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(pair.publicKey)), kid } },
    });
    const effect = {
      key: staged.key,
      effectRef: staged.effectRef,
      subjectAccountId: runtime.identity.bulk.accountId,
      headers: support.managementHeaders,
    };
    const approved = await runtime.identity.auth.internal.approveCredentialEffect(effect);
    await runtime.identity.auth.internal.applyCredentialEffect({ ...effect, authorization: approved.reference });
    const keyPath = join(secrets, 'account.jwk');
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256' }), {
      mode: 0o600,
    });
    const state = join(directory, 'import.sqlite'),
      auth = new URL(runtime.identity.auth.verifier.jwksUrl).origin;
    const argv = [
      '--source',
      'vndb',
      '--dump',
      '-',
      '--state',
      state,
      '--api',
      VNDB_API_ORIGIN,
      '--auth',
      auth,
      '--account-key',
      keyPath,
      '--account',
      runtime.identity.bulk.accountId,
      '--client',
      runtime.identity.client.clientId,
    ];
    const capture = captureVndbStatistics(runtime);
    let grouped: ReturnType<VndbMaterialization['page']>['records'][number] | undefined;
    const sourceRevisions = new Set<number>();
    const invoke = (unsafe = false) =>
      runImportCli(argv, {
        stdin: archive(unsafe),
        observer: {
          onVndbStore({ store }) {
            const page = store.page.bind(store);
            store.page = (...args) => {
              const result = page(...args);
              for (const row of result.records) sourceRevisions.add(row.revision);
              const row = result.records.find((row) => row.key === 'v123');
              if (row) grouped = { ...row, output: converter.convert(row.record) as VndbConversion };
              return result;
            };
          },
        },
        fetch: (async (input: Request | string | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          if (new URL(request.url).origin === auth) return support.host.service.handler(request);
          if (new URL(request.url).origin !== VNDB_API_ORIGIN) throw new Error('Unexpected CLI HTTP origin');
          return capture.fetch(request);
        }) as typeof fetch,
      });
    const baseline = async () => {
      const reader = new Importer({ path: state, transport: transportFor(runtime, capture, () => {}) });
      const session = reader.session;
      try {
        const facade = new VndbMaterialization(reader);
        return {
          source: session.store.source('vndb'),
          record: session.store.key('vndb', 'v123').baseline,
          materialization: facade.baseline('v123'),
        };
      } finally {
        await reader.close();
      }
    };
    const firstExchanges = capture.begin();
    const cli = await invoke();
    if (cli.code !== 0 || !grouped) throw new Error(`VNDB CLI did not publish: ${JSON.stringify(cli)}`);
    const initialBaseline = await baseline();
    const initial = await capture.observe({
      fingerprint: initialBaseline.source.generation,
      records: initialBaseline.source.count,
    });
    const publicStatistic = (initial.current?.body as Array<{ mean: number; count: number; licence: string }>)[0];
    if (!publicStatistic || !initial.subjectId) throw new Error('Missing public VNDB statistic');
    const observer = await openApiObserver(runtime);
    const publicSubject = await observer.http(`/v1/subjects/${initial.subjectId}`);
    if (publicSubject.status !== 200) throw new Error('Published VNDB subject is unreadable');
    const originalReceiptsBefore = { bulk: await capture.bulkReceipts(), statistic: initial.storage.statisticReceipts };
    const secondExchanges = capture.begin();
    const unchanged = await invoke();
    const baselineBeforeUnsafe = await baseline();
    const unsafeExchanges = capture.begin();
    const unsafe = await invoke(true);
    const baselineAfterUnsafe = await baseline();
    const after = await capture.observe({
      fingerprint: baselineAfterUnsafe.source.generation,
      records: baselineAfterUnsafe.source.count,
    });
    const originalReceiptsAfter = { bulk: await capture.bulkReceipts(), statistic: after.storage.statisticReceipts };
    const db = new Database(state);
    const markers = ['UNLICENSED_DESCRIPTION_SENTINEL', 'cv123', 'Harbor Sentinel', 'PRIVATE_SENTINEL'];
    let unlicensedMarkers: string[];
    try {
      unlicensedMarkers = logicalMarkers(db, markers);
      const publicBytes = JSON.stringify({
        publicSubject: publicSubject.body,
        initial: initial.current,
        after: after.current,
        effects: [...firstExchanges, ...secondExchanges, ...unsafeExchanges].map(({ body, response }) => ({
          body,
          response,
        })),
      });
      unlicensedMarkers = [
        ...new Set([...unlicensedMarkers, ...markers.filter((marker) => publicBytes.includes(marker))]),
      ].sort();
    } finally {
      db.close();
    }
    const writes = (exchanges: typeof firstExchanges) =>
      exchanges
        .filter((e) => !['GET', 'HEAD'].includes(e.method))
        .map(({ method, path, status, body, response, receipt }) => ({
          method,
          path,
          status,
          body,
          response,
          receipt,
        }));
    console.log(
      JSON.stringify({
        converter_revision,
        bundledRelease: bundledRelease.catalogue,
        bundledDigest,
        sourceRevisions: [...sourceRevisions].sort((a, b) => a - b),
        source: baselineAfterUnsafe,
        receipts: originalReceiptsAfter,
        nativeVoteRows: after.storage.nativeVoteRows,
      }),
    );
    return {
      cli,
      grouped,
      publicStatistic,
      nativeVoteRows: after.storage.nativeVoteRows,
      unchanged,
      unchangedWrites: writes(secondExchanges),
      unsafe,
      unsafeWrites: writes(unsafeExchanges),
      baselineBeforeUnsafe,
      baselineAfterUnsafe,
      originalReceiptsBefore,
      originalReceiptsAfter,
      unlicensedMarkers,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
