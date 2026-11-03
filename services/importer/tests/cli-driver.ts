import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { BatchWriteRequest } from '@rezics/definitions/bulk';
import { IMPORTER_SCOPES, VNDB_IMPORTER_SCOPES } from '../src/credentials.ts';
import { ImportSession } from '../src/import-session.ts';
import { RUN_TABLES, type RunStore, type SourceProjection } from '../src/run-store.ts';
import { runImportCli, type ImportCliObserver } from '../src/cli.ts';
import type { ImportProgressSink } from '../src/import-progress.ts';
import { createSqliteProbe } from './support/sqlite-growth.ts';
import type { CliDriver, Command, Execution, Options, Source } from '../../../specs/imports-cli-driver.ts';

const GROWING_TABLES = [
  ...RUN_TABLES,
  'import_owners',
  'binding_records',
  'binding_groups',
  'binding_journal',
  'binding_candidates',
  'binding_media',
  'vndb_table_runs',
  'vndb_table_rows',
  'vndb_table_spool',
] as const;
const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;

type SqliteCapture = {
  database: Database;
  start(): void;
  attachCoordinator(importer: Parameters<NonNullable<ImportCliObserver['onCoordinator']>>[0]['importer']): void;
  finish(): { sql: Execution['sql']; counts: Execution['counts'] };
};

function createSqliteCapture(database: Database): SqliteCapture {
  const probe = createSqliteProbe(database, { growingTables: GROWING_TABLES });
  let enabled = false;
  let depth = 0;
  let verified = false;
  let verificationFailure: unknown;
  const statementProxies = new WeakMap<object, object>();
  let cachedFinish: { sql: Execution['sql']; counts: Execution['counts'] } | undefined;

  const measure = <T>(operation: () => T): T => {
    if (!enabled || depth > 0) return operation();
    depth++;
    try {
      return probe.measure(operation).value;
    } finally {
      depth--;
    }
  };

  const wrapStatement = (statement: object): object => {
    const prior = statementProxies.get(statement);
    if (prior) return prior;
    const wrapped = new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (typeof value !== 'function') return value;
        if (key === 'iterate') return (...args: unknown[]) => Reflect.apply(value, target, args);
        return (...args: unknown[]) => measure(() => Reflect.apply(value, target, args));
      },
    });
    statementProxies.set(statement, wrapped);
    return wrapped;
  };

  const finish = () => {
    if (verified) return;
    verified = true;
    enabled = false;
    try {
      probe.verifyPlans();
    } catch (error) {
      verificationFailure = error;
    }
  };

  const databaseProxy = new Proxy(probe.database, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (key === 'query' || key === 'prepare')
        return (...args: unknown[]) =>
          wrapStatement(Reflect.apply(value as (...args: unknown[]) => object, target, args));
      if (key === 'close')
        return (...args: unknown[]) => {
          finish();
          return Reflect.apply(value as (...args: unknown[]) => unknown, target, args);
        };
      if (key === 'run' || key === 'exec')
        return (...args: unknown[]) =>
          measure(() => Reflect.apply(value as (...args: unknown[]) => unknown, target, args));
      if (key === 'transaction')
        return (...args: unknown[]) => {
          const transaction = Reflect.apply(value as (...args: unknown[]) => unknown, target, args) as
            | ((...callArgs: unknown[]) => unknown)
            | undefined;
          if (typeof transaction !== 'function') return transaction;
          const wrapped = (...callArgs: unknown[]) => measure(() => Reflect.apply(transaction, target, callArgs));
          for (const modifier of ['immediate', 'deferred', 'exclusive'] as const) {
            const method = Reflect.get(transaction, modifier) as unknown;
            if (typeof method === 'function')
              Object.defineProperty(wrapped, modifier, {
                configurable: true,
                value: (...callArgs: unknown[]) => measure(() => Reflect.apply(method, transaction, callArgs)),
              });
          }
          return wrapped;
        };
      if (typeof value === 'function') return (...args: unknown[]) => Reflect.apply(value, target, args);
      return value;
    },
  }) as Database;

  const attachObject = (object: object) => {
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(object))) {
      if (name === 'constructor') continue;
      const original = Reflect.get(object, name) as unknown;
      if (typeof original !== 'function' || original.constructor?.name === 'AsyncFunction') continue;
      Object.defineProperty(object, name, {
        configurable: true,
        writable: true,
        value: function (this: object, ...args: unknown[]) {
          return measure(() => Reflect.apply(original, this, args));
        },
      });
    }
  };

  return {
    database: databaseProxy,
    start() {
      enabled = true;
    },
    attachCoordinator(importer) {
      attachObject(importer.session);
      attachObject(importer.session.store);
      attachObject(importer.session.bindings);
    },
    finish() {
      finish();
      if (verificationFailure) throw verificationFailure;
      if (!cachedFinish) {
        const evidence = probe.verifyPlans();
        const sql = evidence.map((event) => ({
          sql: event.sql,
          parameters: event.parameters,
          rows: event.rows,
          plan: event.plan.map((row) => row.detail),
        }));
        cachedFinish = {
          sql,
          counts: {
            'sqlite statements': sql.length,
            'sqlite returned rows': sql.reduce((sum, statement) => sum + statement.rows, 0),
          },
        };
      }
      return cachedFinish;
    },
  };
}

async function boundedRequest(request: Request): Promise<{ bytes: number; body: Uint8Array }> {
  if (!request.body) return { bytes: 0, body: new Uint8Array() };
  const reader = request.clone().body!.getReader();
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.buffer.byteLength > MAX_HTTP_BODY_BYTES)
        throw new Error('Invalid bounded request');
      if (value.byteLength > MAX_HTTP_BODY_BYTES - size) throw new Error('Import request exceeds the body cap');
      size += value.byteLength;
      parts.push(value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes: size, body };
}

function row(key: string) {
  return {
    row: {
      source: 'unrelated',
      recordKey: key,
      recordRevision: 'unversioned',
      digest: 'a'.repeat(64),
      converter_revision: 'seed@1',
      state: 'present' as const,
    },
    projection: { sourceKind: 'wikidata' as const, normalizedRecord: { id: key } },
  };
}

export async function createImportCliDriver(options: Options): Promise<CliDriver> {
  let closed = false;
  let issuedTokens = 0;
  const observedCommands = new Map<string, { source: string; external_id: string; op: Command['op'] }>();
  const active = new Set<Promise<unknown>>();

  const invoke = async (argv: string[], boundaries: Parameters<CliDriver['invoke']>[1] = {}): Promise<Execution> => {
    if (closed) throw new Error('CLI driver is closed');
    const requests: Execution['requests'] = [];
    const tokenReads: Execution['tokenReads'] = [];
    const fileWrites = new Set<string>();
    const runners: Execution['runners'] = [];
    const input = { bytes: 0, passes: 0, records: 0, peakBufferedBytes: 0, maxPageRecords: 0 };
    let capture: SqliteCapture | undefined;
    let captureStarted = false;
    let signins = 0;
    let session = '';

    const startCapture = () => {
      if (capture && !captureStarted) {
        capture.start();
        captureStarted = true;
      }
    };
    const observeChunk: NonNullable<ImportCliObserver['onInputChunk']> = (_kind, bytes, backingBytes) => {
      input.bytes += bytes;
      input.peakBufferedBytes = Math.max(input.peakBufferedBytes, backingBytes);
    };
    const observer: ImportCliObserver = {
      onTokenRead(path, bytes) {
        tokenReads.push({ path, bytes });
      },
      onDatabaseOpen(path) {
        fileWrites.add(path);
      },
      onInputPass() {
        input.passes++;
      },
      onInputChunk: observeChunk,
      onInputBuffer(bytes) {
        input.peakBufferedBytes = Math.max(input.peakBufferedBytes, bytes);
      },
      onPageRecords(records) {
        input.maxPageRecords = Math.max(input.maxPageRecords, records);
      },
      onVndbStore() {
        startCapture();
      },
      onCoordinator({ importer, registration, state, converterModule, decoderModule }) {
        startCapture();
        capture?.attachCoordinator(importer);
        const store = importer.session.store as RunStore<SourceProjection>;
        const seal = store.seal.bind(store);
        store.seal = function (...args: Parameters<typeof store.seal>) {
          const result = seal(...args);
          input.records += result.supplied;
          return result;
        };
        const pageStaged = store.pageStaged.bind(store);
        store.pageStaged = function (...args: Parameters<typeof store.pageStaged>) {
          const records = pageStaged(...args);
          input.maxPageRecords = Math.max(input.maxPageRecords, records.length);
          return records;
        };
        runners.push({
          source: registration.source,
          sourceKind: registration.sourceKind as Source,
          state,
          converterModule,
          decoderModule,
        });
      },
    };

    const fetch = async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      if (url.origin === 'https://auth.importer.test') {
        if (url.pathname === '/signin/key') {
          signins++;
          if (signins > 1) return new Response('', { status: 401 });
          const sourceIndex = argv.indexOf('--source');
          const source = sourceIndex < 0 ? undefined : argv[sourceIndex + 1];
          const expectedScopes =
            source === 'vndb'
              ? VNDB_IMPORTER_SCOPES
              : source === 'bangumi'
                ? [...IMPORTER_SCOPES, 'subject:read']
                : IMPORTER_SCOPES;
          let body: unknown;
          try {
            body = JSON.parse(await request.clone().text());
          } catch {
            return new Response('', { status: 401 });
          }
          if (
            typeof body !== 'object' ||
            body === null ||
            JSON.stringify(Reflect.get(body, 'scope')) !== JSON.stringify(expectedScopes)
          )
            return new Response('', { status: 401 });
          session = `imports-cli-session-${issuedTokens + 1}`;
          return Response.json({}, { headers: { 'set-cookie': `session=${session}; HttpOnly; Secure` } });
        }
        if (url.pathname === '/token' && request.headers.get('cookie') === `session=${session}`) {
          issuedTokens++;
          return Response.json({
            access_token: issuedTokens === 1 ? 'CLI_TOKEN_PRIVATE_ONE' : 'CLI_TOKEN_PRIVATE_TWO',
            token_type: 'Bearer',
            expires_in: 300,
          });
        }
        return new Response('', { status: 404 });
      }
      const captured = await boundedRequest(request);
      const authorization = request.headers.get('authorization');
      requests.push({ url: request.url, authorization, bytes: captured.bytes });
      if (request.method === 'PUT' && /^\/v1\/subjects\/[0-9a-f-]{36}\/source-statistics\/vndb$/.test(url.pathname)) {
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(captured.body));
        } catch {
          return new Response('', { status: 400 });
        }
        if (
          typeof body === 'object' &&
          body !== null &&
          !Array.isArray(body) &&
          (request.headers.get('idempotency-key')?.length ?? 0) > 0
        )
          return Response.json({ source: 'vndb', ...(body as Record<string, unknown>) });
        return new Response('', { status: 400 });
      }
      if (url.pathname === '/v1/subjects:batchWrite') {
        try {
          const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(captured.body)) as BatchWriteRequest;
          for (const command of body.commands)
            observedCommands.set(command.key, {
              source: command.source.source,
              external_id: command.source.external_id,
              op: command.op,
            });
        } catch {
          // The actual transport validates this envelope; observation is best effort.
        }
      }
      return options.fetch(request);
    };

    const progressBoundaries = boundaries as typeof boundaries & {
      progressSink?: ImportProgressSink;
      progressTty?: boolean;
    };
    const pending = runImportCli(argv, {
      ...(boundaries.stdin === undefined ? {} : { stdin: boundaries.stdin }),
      ...(boundaries.entries === undefined ? {} : { entries: boundaries.entries as never }),
      ...(boundaries.signal === undefined ? {} : { signal: boundaries.signal }),
      ...(boundaries.testOrigin === undefined ? {} : { testOrigin: boundaries.testOrigin }),
      ...(progressBoundaries.progressSink ? { progressSink: progressBoundaries.progressSink } : {}),
      ...(progressBoundaries.progressTty === undefined ? {} : { progressTty: progressBoundaries.progressTty }),
      fetch: fetch as typeof globalThis.fetch,
      clock: options.clock,
      instrumentDatabase(database) {
        capture = createSqliteCapture(database);
        return capture.database;
      },
      observer,
    });
    active.add(pending);
    let result;
    try {
      result = await pending;
    } finally {
      active.delete(pending);
    }
    const evidence = capture?.finish();
    if (
      !evidence &&
      (fileWrites.size > 0 ||
        runners.length > 0 ||
        tokenReads.length > 0 ||
        requests.length > 0 ||
        Object.values(input).some((value) => value !== 0))
    )
      throw new Error('Missing SQLite capture outside observed no-I/O preflight');
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      runners,
      sql: evidence?.sql ?? [],
      fileWrites: [...fileWrites],
      tokenReads,
      requests,
      openHandles: result.openHandles,
      input,
      // Only the observed no-I/O preflight above can have no capture.
      counts: evidence?.counts ?? { 'sqlite statements': 0, 'sqlite returned rows': 0 },
    };
  };

  return {
    invoke,
    async inspect(state, source) {
      const session = new ImportSession(state);
      try {
        const view = session.store.source(source);
        const baseline =
          view.generation === null
            ? null
            : createHash('sha256').update(`${source}\0${view.generation}\0${view.count}`).digest('hex');
        const pendingKeys = new Set<string>();
        const activeRun = session.store.activeRun(source);
        if (activeRun) {
          let after: string | undefined;
          for (;;) {
            const page = session.store.pagePending(activeRun, { ...(after ? { after } : {}), limit: 100 });
            for (const entry of page) for (const key of entry.keys) pendingKeys.add(key);
            if (page.length < 100) break;
            after = page.at(-1)!.after;
          }
        }
        for (const [key, owner] of observedCommands) {
          if (owner.source !== source) continue;
          if (!session.bindings.journal({ source: owner.source, external_id: owner.external_id }, key)) continue;
          if (
            owner.op === 'create' &&
            session.bindings.claim({ source: owner.source, external_id: owner.external_id })?.state === 'pending'
          )
            pendingKeys.add(key);
        }
        return {
          baseline,
          pendingKeys: [...pendingKeys],
          normalized: { source, generation: baseline, count: view.count, pending: pendingKeys.size },
        };
      } finally {
        session.close();
      }
    },
    async seed(state, scale) {
      if (!Number.isSafeInteger(scale) || ![1, 8, 64].includes(scale)) throw new TypeError('Unsupported seed scale');
      const session = new ImportSession(state);
      try {
        const store = session.store;
        for (let index = 0; index < scale * 4; index++) {
          const run = store.begin('hot-history');
          if (run === 'busy') throw new Error('Unexpected seed ownership conflict');
          store.stage(run, {
            row: { ...row(`Failed${index}`).row, source: 'hot-history' },
            projection: { sourceKind: 'wikidata', normalizedRecord: { id: `Failed${index}` } },
          });
          store.seal(run, { complete: false, reason: 'malformed' });
        }

        const first = store.begin('unrelated');
        if (first === 'busy') throw new Error('Unexpected seed ownership conflict');
        for (let index = 0; index < scale; index++) store.stage(first, row(`Unrelated${index}`));
        if (store.seal(first, { complete: true }).status !== 'ready') throw new Error('Seed snapshot did not seal');
        for (let index = 0; index < scale; index++) {
          const key = `Unrelated${index}`;
          store.classify(first, key, { commands: [] });
          store.acknowledgeNoEffects(first, key, { reason: 'converter-ignored' });
        }
        let finalized = store.finalize(first, 100);
        while (finalized === 'more') finalized = store.finalize(first, 100);
        if (finalized !== 'complete') throw new Error('Seed baseline did not complete');

        const current = store.begin('unrelated', { disappearanceThreshold: 1 });
        if (current === 'busy') throw new Error('Unexpected seed ownership conflict');
        store.stage(current, row('Unrelated0'));
        if (store.seal(current, { complete: true }).status !== 'ready') throw new Error('Seed refresh did not seal');
        store.classify(current, 'Unrelated0', { commands: [] });
        store.acknowledgeNoEffects(current, 'Unrelated0', { reason: 'converter-ignored' });
        for (const prior of store.pageVanished(current, { limit: 100 })) {
          store.classify(current, prior.recordKey, { commands: [] });
          store.acknowledgeNoEffects(current, prior.recordKey, { reason: 'no-owned-candidates' });
        }
        finalized = store.finalize(current, 100);
        while (finalized === 'more') finalized = store.finalize(current, 100);
        if (finalized !== 'complete') throw new Error('Seed refresh did not complete');
        store.database.exec('ANALYZE');
      } finally {
        session.close();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...active]);
    },
  };
}
