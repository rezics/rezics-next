import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { runImportCli } from '../../../importer/src/cli.ts';
import { VNDB_IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { openApiRuntime } from './api-runtime.ts';
import { identitySupport } from './identity-fixture.ts';
import { captureVndbStatistics, VNDB_API_ORIGIN } from './vndb-statistics-driver.ts';

// Synthetic changes to the same real-shaped COPY rows used by the frozen six cases.
// The native entry revision, column headers and statistic-bearing columns survive.
async function* archive(average: number): AsyncGenerator<Uint8Array> {
  for (const name of ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta']) {
    let text = readFileSync(
      new URL(`../../../../specs/fixtures/imports/vndb-tables/db/${name}`, import.meta.url),
      'utf8',
    );
    if (name === 'vn') {
      const rows = text.trimEnd().split('\n');
      const cells = rows[0]!.split('\t');
      cells[4] = '20';
      cells[6] = String(average);
      rows[0] = cells.join('\t');
      text = rows.join('\n') + '\n';
    }
    const body = new TextEncoder().encode(text);
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

test('ordinary VNDB archive CLI publishes and reopens through real account-key Auth, bulk and statistic HTTP', async () => {
  const runtime = await openApiRuntime({
    batchRecords: 8,
    maxFields: 64,
    maxRecordBytes: 65536,
    sourceStatistics: 'vndb',
  });
  let directory: string | undefined;
  let secrets: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'vndb-cli-native-'));
    secrets = await mkdtemp('/dev/shm/vndb-cli-key-');
    const f = runtime.identity;
    const native = identitySupport(f);
    await native.renewManagement();
    const kid = randomUUID();
    const pair = await generateKeyPair('ES256', { extractable: true });
    const staged = await f.auth.internal.stageCredentialEffect({
      key: kid,
      subjectAccountId: f.bulk.accountId,
      headers: native.managementHeaders,
      credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(pair.publicKey)), kid } },
    });
    const effect = {
      key: staged.key,
      effectRef: staged.effectRef,
      subjectAccountId: f.bulk.accountId,
      headers: native.managementHeaders,
    };
    const approval = await f.auth.internal.approveCredentialEffect(effect);
    await f.auth.internal.applyCredentialEffect({ ...effect, authorization: approval.reference });
    const keyPath = join(secrets, 'account.jwk');
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256' }), {
      mode: 0o600,
    });
    const auth = new URL(f.auth.verifier.jwksUrl).origin;
    const state = join(directory, 'import.sqlite');
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
      f.bulk.accountId,
      '--client',
      f.client.clientId,
    ];
    const capture = captureVndbStatistics(runtime);
    const authExchanges: { path: string; status: number; account?: string; scopes?: string[] }[] = [];
    const sourceRecords: { key: string; revision: number; average: number | null; count: number }[] = [];
    let inputPasses = 0;
    let inputBytes = 0;
    let inputChunks = 0;
    const invoke = async (average: number, loss = false) => {
      const exchanges = capture.begin(loss);
      sourceRecords.length = 0;
      const result = await runImportCli(argv, {
        stdin: archive(average),
        observer: {
          onAccountKey(_path, observation) {
            expect(observation.regularFile).toBe(true);
            expect(observation.mode).toBe(0o600);
          },
          onInputPass() {
            inputPasses++;
          },
          onInputChunk(_kind, bytes) {
            inputBytes += bytes;
            inputChunks++;
          },
          onVndbStore({ store }) {
            const page = store.page.bind(store);
            store.page = (...args) => {
              const result = page(...args);
              for (const row of result.records)
                sourceRecords.push({
                  key: row.key,
                  revision: row.revision,
                  average: row.record.vn.c_average,
                  count: row.record.vn.c_votecount,
                });
              return result;
            };
          },
        },
        fetch: (async (input: Request | string | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const url = new URL(request.url);
          if (url.origin === auth) {
            expect(['/signin/key', '/token']).toContain(url.pathname);
            const body = await request.clone().json();
            if (url.pathname === '/signin/key') {
              expect(body.scope).toEqual([...VNDB_IMPORTER_SCOPES]);
              expect(body.account_id).toBe(f.bulk.accountId);
              expect(body.client_id).toBe(f.client.clientId);
              expect(decodeJwt(body.assertion).sub).toBe(f.bulk.accountId);
            }
            const response = await native.host.service.handler(request);
            authExchanges.push({
              path: url.pathname,
              status: response.status,
              ...(url.pathname === '/signin/key' ? { account: body.account_id, scopes: body.scope } : {}),
            });
            expect(response.status).toBe(200);
            return response;
          }
          expect(url.origin).toBe(VNDB_API_ORIGIN);
          expect(request.headers.has('cookie')).toBe(false);
          const actor = await f.access.authenticate(request.headers.get('authorization')!.slice(7), {
            pool: runtime.database.pool,
            deadline: Date.now() + 10_000,
          });
          expect(actor.accountId).toBe(f.bulk.accountId);
          expect([...actor.scopes].sort()).toEqual([...VNDB_IMPORTER_SCOPES].sort());
          return capture.fetch(request);
        }) as typeof fetch,
      });
      expect(result.code, JSON.stringify(result)).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.openHandles).toBe(0);
      expect(sourceRecords.find((row) => row.key === 'v123')).toEqual({ key: 'v123', revision: 7, average, count: 20 });
      return { result, exchanges };
    };
    const observe = async () => {
      const session = new ImportSession(state);
      try {
        expect(session.store.activeRun('vndb')).toBeNull();
        const source = session.store.source('vndb');
        return await capture.observe({ fingerprint: source.generation, records: source.count });
      } finally {
        session.close();
      }
    };
    const expected = {
      source: 'vndb' as const,
      sourceRecordId: 'v123',
      mean: 7.35,
      count: 20,
      scale: { min: 1, max: 10 },
      asOf: '2026-10-25',
      licence: 'ODbL-1.0',
      attribution: 'VNDB',
    };
    const first = await invoke(735);
    const initial = await observe();
    expect(
      first.exchanges.some(
        (exchange) =>
          exchange.method === 'POST' && exchange.path === '/v1/subjects:batchWrite' && exchange.status === 200,
      ),
    ).toBe(true);
    const writes = first.exchanges.filter((exchange) => exchange.method === 'PUT');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.response).toEqual(expected);
    expect(writes[0]!.receipt).toBeTruthy();
    expect(initial.subjectId).toBeTruthy();
    expect(initial.currentRequest).toEqual({
      method: 'GET',
      path: `/v1/subjects/${initial.subjectId}/source-statistics`,
      authorization: null,
    });
    expect(initial.current).toEqual({ status: 200, body: [expected] });
    expect(initial.storage.statistics).toEqual([expected]);
    expect(initial.storage.statisticEvents).toHaveLength(1);
    expect(initial.storage.statisticReceipts).toEqual([writes[0]!.receipt!]);
    expect(initial.storage.nativeVoteRows).toBe(0);
    expect(initial.baseline.records).toBe(2);
    expect(initial.baseline.fingerprint).toBeTruthy();
    const receipts = await capture.bulkReceipts();
    expect(receipts.length).toBeGreaterThan(0);
    // Every actual CLI invocation closes; the next one reopens that same durable SQLite file.
    const unchanged = await invoke(735);
    expect(unchanged.result.stdout).toContain('unchanged=2');
    expect(unchanged.exchanges.filter((exchange) => exchange.method === 'PUT' || exchange.method === 'POST')).toEqual(
      [],
    );
    expect(await observe()).toEqual(initial);
    expect(await capture.bulkReceipts()).toEqual(receipts);
    const changed = await invoke(810, true);
    const changedWrites = changed.exchanges.filter((exchange) => exchange.method === 'PUT');
    expect(changedWrites.length).toBeGreaterThanOrEqual(2);
    expect(changedWrites[0]!.responseLost).toBe(true);
    for (const retry of changedWrites.slice(1)) {
      for (const field of ['body', 'idempotencyKey', 'authorization', 'path', 'receipt'] as const)
        expect(retry[field]).toEqual(changedWrites[0]![field]);
      expect(retry.status).toBe(200);
    }
    const after = await observe();
    expect(after.subjectId).toBe(initial.subjectId);
    expect(after.current).toEqual({ status: 200, body: [{ ...expected, mean: 8.1 }] });
    expect(after.storage.statistics).toEqual([{ ...expected, mean: 8.1 }]);
    expect(after.storage.statisticTransactions).toHaveLength(1);
    expect(after.storage.statisticTransactions).not.toEqual(initial.storage.statisticTransactions);
    expect(after.storage.statisticEvents).toHaveLength(2);
    expect(after.storage.statisticReceipts).toHaveLength(2);
    expect(after.storage.nativeVoteRows).toBe(0);
    await native.setStatisticGrant(false);
    const denied = await capture.replay(changedWrites[0]!);
    expect(denied.status).toBe(403);
    expect(denied.receipt).toBeNull();
    expect(denied.response).toEqual({
      type: 'https://rezics.com/problems/forbidden',
      title: 'Forbidden',
      status: 403,
      code: 'forbidden',
      retryable: false,
      effect_status: 'not_applied',
      request_id: expect.any(String),
    });
    expect(await observe()).toEqual(after);
    expect(inputPasses).toBe(3);
    expect(inputBytes).toBeGreaterThan(0);
    expect(inputChunks).toBeGreaterThan(0);
    expect(authExchanges.filter((exchange) => exchange.path === '/signin/key')).toHaveLength(3);
    expect(authExchanges.filter((exchange) => exchange.path === '/token')).toHaveLength(3);
    console.log(
      'VNDB native CLI evidence',
      JSON.stringify({
        bundleRevision: bundledRelease.catalogue.version,
        bundleDigest: bundledDigest,
        converterRevision: createSourceRegistration('vndb').converter_revision,
        sourceRevision: 7,
        sourceDate: expected.asOf,
        inputPasses,
        'input bytes': inputBytes,
        'input chunks': inputChunks,
        authExchanges,
        baseline: after.baseline,
        receipts: after.storage.statisticReceipts,
        transactions: after.storage.statisticTransactions,
        events: after.storage.statisticEvents,
        nativeVoteRows: after.storage.nativeVoteRows,
        bulkReceipts: (await capture.bulkReceipts()).length,
      }),
    );
  } finally {
    try {
      await runtime.close();
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        if (secrets) await rm(secrets, { recursive: true, force: true });
      }
    }
  }
}, 240_000);
