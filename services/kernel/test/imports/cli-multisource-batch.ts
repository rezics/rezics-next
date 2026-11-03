import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { runImportCli } from '../../../importer/src/cli.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';

const bangumiRecords = Array.from({ length: 3 }, (_, index) => ({
  id: 940001 + index,
  type: 2,
  name: `Batch Bangumi ${index + 1}`,
}));
const libraryRecords = Array.from({ length: 3 }, (_, index) => {
  const key = `/works/OL${940101 + index}W`;
  const record = {
    key,
    type: { key: '/type/work' },
    revision: 1,
    title: `Batch Open Library ${index + 1}`,
    last_modified: { type: '/type/datetime', value: '2026-10-25T00:00:00.000000' },
  };
  return {
    key,
    line: `/type/work\t${key}\t1\t2026-10-25T00:00:00Z\t${JSON.stringify(record)}\n`,
  };
});
const wikidataRecords = Array.from({ length: 2 }, (_, index) => ({
  id: `Q${940201 + index}`,
  type: 'item',
  lastrevid: 7,
  labels: { en: { language: 'en', value: `Batch Wikidata ${index + 1}` } },
  claims: {
    P31: [
      {
        type: 'statement',
        rank: 'normal',
        mainsnak: {
          snaktype: 'value',
          property: 'P31',
          datatype: 'wikibase-item',
          datavalue: {
            type: 'wikibase-entityid',
            value: { 'entity-type': 'item', 'numeric-id': 47461344, id: 'Q47461344' },
          },
        },
      },
    ],
  },
}));

export async function openMultisourceBatchCli() {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  let directory: string | undefined;
  const close = async () => {
    try {
      await runtime.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    directory = await mkdtemp('/dev/shm/imports-multisource-batch-');
    const state = join(directory, 'state.sqlite');
    const bangumiDump = join(directory, 'bangumi.jsonl');
    const libraryDump = join(directory, 'openlibrary.tsv');
    const wikidataDump = join(directory, 'wikidata.jsonl');
    const manifest = join(directory, 'launch.json');
    const keyPath = join(directory, 'account.jwk');
    await writeFile(state, '', { mode: 0o600 });
    await writeFile(bangumiDump, bangumiRecords.map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
    await writeFile(libraryDump, libraryRecords.map((row) => row.line).join(''), { mode: 0o600 });
    await writeFile(wikidataDump, wikidataRecords.map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
    await writeFile(
      manifest,
      `${JSON.stringify({
        version: 1,
        jobs: [
          { source: 'bangumi', dump: 'bangumi.jsonl', state: 'state.sqlite', name: 'bangumi-launch' },
          {
            source: 'openlibrary',
            sourceAlias: 'catalogue-ol',
            dump: 'openlibrary.tsv',
            state: 'state.sqlite',
            name: 'openlibrary-launch',
          },
          { source: 'wikidata', dump: 'wikidata.jsonl', state: 'state.sqlite', name: 'wikidata-launch' },
        ],
      })}\n`,
      { mode: 0o600 },
    );
    const native = identitySupport(runtime.identity);
    await native.renewManagement();
    const kid = randomUUID();
    const pair = await generateKeyPair('ES256', { extractable: true });
    const staged = await runtime.identity.auth.internal.stageCredentialEffect({
      key: kid,
      subjectAccountId: runtime.identity.bulk.accountId,
      headers: native.managementHeaders,
      credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(pair.publicKey)), kid } },
    });
    const effect = {
      key: staged.key,
      effectRef: staged.effectRef,
      subjectAccountId: runtime.identity.bulk.accountId,
      headers: native.managementHeaders,
    };
    const approval = await runtime.identity.auth.internal.approveCredentialEffect(effect);
    await runtime.identity.auth.internal.applyCredentialEffect({ ...effect, authorization: approval.reference });
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256' }), {
      mode: 0o600,
    });
    const editor = await openApiObserver(runtime);
    const api = 'https://kernel.import.test';
    const auth = new URL(runtime.identity.auth.verifier.jwksUrl).origin;
    const commands = new Map<string, BatchCommand>();
    const exchanges: { source: string; keys: string[]; bytes: string; status: number }[] = [];
    const credentials = [
      '--api',
      api,
      '--auth',
      auth,
      '--account-key',
      keyPath,
      '--account',
      runtime.identity.bulk.accountId,
      '--client',
      runtime.identity.client.clientId,
    ];

    function inspect(source: string, externalId: string) {
      const session = new ImportSession(state);
      try {
        const owner = { source, external_id: externalId };
        const active = session.store.activeRun(source);
        const claim = session.bindings.claim(owner);
        return {
          count: session.store.source(source).count,
          active,
          claim,
          subject: claim?.state === 'bound' ? claim.subject : null,
          candidates: session.bindings.candidates(owner, 'facts', { limit: 100 }),
          pending: active ? session.store.pagePending(active, { limit: 100 }) : [],
          journals: session.store.database
            .query<{ key: string; bytes: string; acknowledgement: string | null }, [string, string]>(
              'SELECT key,bytes,acknowledgement FROM binding_journal WHERE source=? AND external_id=? ORDER BY key LIMIT 100',
            )
            .all(source, externalId),
        };
      } finally {
        session.close();
      }
    }

    async function receipts(keys: readonly string[]) {
      const rows = [];
      for (const key of keys) {
        const command = commands.get(key);
        if (!command) continue;
        const route =
          command.op === 'create'
            ? tupleRoute(runtime.identity.routeKey, command.source.source, command.source.external_id)
            : routeOf(command.subject)!;
        const found = await runtime.database.admin.query(
          'SELECT idempotency_key,transaction_id FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3 AND idempotency_key=$4',
          [partitionOf(route), 'account', runtime.identity.bulk.accountId, key],
        );
        rows.push(...found.rows);
      }
      return rows;
    }

    async function authorizedFetch(input: Request | string | URL, init?: RequestInit, loseOpenLibrary = false) {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === auth) return native.host.service.handler(request);
      expect(url.origin).toBe(api);
      if (url.pathname !== '/v1/subjects:batchWrite') return runtime.replay(request);
      const bytes = await request.clone().text();
      const body = JSON.parse(bytes) as BatchWriteRequest;
      for (const command of body.commands) {
        const previous = commands.get(command.key);
        if (previous) expect(command).toEqual(previous);
        commands.set(command.key, command);
      }
      const sources = [...new Set(body.commands.map((command) => command.source.source))];
      expect(sources).toHaveLength(1);
      const response = await runtime.replay(request);
      const responseBytes = await response.clone().text();
      const parsed = JSON.parse(responseBytes) as BatchWriteResult;
      exchanges.push({
        source: sources[0]!,
        keys: body.commands.map((command) => command.key),
        bytes,
        status: response.status,
      });
      if (
        loseOpenLibrary &&
        body.commands.some((command) => command.source.source === 'catalogue-ol' && command.op === 'propose')
      ) {
        throw new DOMException('Lost Open Library write response', 'AbortError');
      }
      return response;
    }

    async function preview() {
      const network: string[] = [];
      const result = await runImportCli(['batch', '--manifest', manifest, '--json'], {
        fetch: (async (input: RequestInfo | URL) => {
          network.push(String(input));
          throw new Error('preview must not use the network');
        }) as unknown as typeof fetch,
        observer: {
          onAccountKey() {
            throw new Error('preview must not read credentials');
          },
          onDatabaseOpen() {
            throw new Error('preview must not open state');
          },
        },
      });
      return { ...result, network };
    }

    async function runBatch(loseOpenLibrary = false) {
      const start = exchanges.length;
      const result = await runImportCli(['batch', '--manifest', manifest, '--run', '--json', ...credentials], {
        fetch: ((input: Request | string | URL, init?: RequestInit) =>
          authorizedFetch(input, init, loseOpenLibrary)) as unknown as typeof fetch,
      });
      expect(result.openHandles, JSON.stringify(result)).toBe(0);
      return { ...result, exchanges: exchanges.slice(start), document: JSON.parse(result.stdout) };
    }

    async function reviseOpenLibrary() {
      const lines = libraryRecords.map((row, index) => {
        const record = {
          key: row.key,
          type: { key: '/type/work' },
          revision: 2,
          title: `Batch Open Library ${index + 1} revised`,
          last_modified: { type: '/type/datetime', value: '2026-10-26T00:00:00.000000' },
        };
        return `/type/work\t${row.key}\t2\t2026-10-26T00:00:00Z\t${JSON.stringify(record)}\n`;
      });
      await writeFile(libraryDump, lines.join(''), { mode: 0o600 });
    }

    async function readSubject(id: string) {
      return editor.http(`/v1/subjects/${id}`);
    }

    async function recoverOpenLibrary() {
      const result = await runImportCli(
        [
          '--source',
          'openlibrary',
          '--source-alias',
          'catalogue-ol',
          '--dump',
          libraryDump,
          '--state',
          state,
          ...credentials,
        ],
        { fetch: ((input: Request | string | URL, init?: RequestInit) => authorizedFetch(input, init)) as unknown as typeof fetch },
      );
      expect(result.openHandles).toBe(0);
      return result;
    }

    return {
      close,
      preview,
      runBatch,
      recoverOpenLibrary,
      reviseOpenLibrary,
      readSubject,
      inspect,
      receipts,
      editor,
      bangumiRecords,
      libraryRecords,
      wikidataRecords,
      state,
      commands,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
