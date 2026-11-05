import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { runImportCli } from '../../../importer/src/cli.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';

export const records = Array.from({ length: 5 }, (_, index) => ({
  id: 920001 + index,
  type: 2,
  name: `Preview catalogue ${index + 1}`,
}));
export const feed = (rows = records) => rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');

type Exchange = {
  status: number;
  body: BatchWriteRequest;
  result: BatchWriteResult;
};

export async function openDumpPreviewCli() {
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
    directory = await mkdtemp('/dev/shm/imports-dump-preview-');
    const state = join(directory, 'state.sqlite');
    await writeFile(state, '', { mode: 0o600 });
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
    const keyPath = join(directory, 'account.jwk');
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256' }), {
      mode: 0o600,
    });
    const editor = await openApiObserver(runtime);
    const api = 'https://kernel.import.test';
    const auth = new URL(runtime.identity.auth.verifier.jwksUrl).origin;
    const exchanges: Exchange[] = [];
    const dumpPath = join(directory, 'dump.jsonl');
    const argv = [
      '--source',
      'bangumi',
      '--dump',
      dumpPath,
      '--state',
      state,
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
    const authorizedFetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === auth) return native.host.service.handler(request);
      expect(url.origin).toBe(api);
      if (url.pathname !== '/v1/subjects:batchWrite') return runtime.replay(request);
      const bytes = await request.clone().text();
      const body = JSON.parse(bytes) as BatchWriteRequest;
      const response = await runtime.replay(request);
      const responseBytes = await response.clone().text();
      exchanges.push({
        status: response.status,
        body,
        result: JSON.parse(responseBytes) as BatchWriteResult,
      });
      return response;
    }) as unknown as typeof fetch;

    async function invoke(text: string) {
      await writeFile(dumpPath, text, { mode: 0o600 });
      const start = exchanges.length;
      const result = await runImportCli(argv, { fetch: authorizedFetch });
      expect(result.openHandles, JSON.stringify(result)).toBe(0);
      return { ...result, exchanges: exchanges.slice(start) };
    }

    async function preview(text: string) {
      const path = join(directory!, 'preview.jsonl');
      await writeFile(path, text, { mode: 0o600 });
      const network: string[] = [];
      const result = await runImportCli(
        ['preview', '--source', 'bangumi', '--dump', path, '--baseline', state, '--json', '--page', 'changed'],
        {
          fetch: (async (input: RequestInfo | URL) => {
            network.push(String(input));
            throw new Error('preview network');
          }) as unknown as typeof fetch,
        },
      );
      return { ...result, network };
    }

    function inspect() {
      const session = new ImportSession(state);
      try {
        return {
          source: session.store.source('bangumi'),
          active: session.store.activeRun('bangumi'),
          records: records.map((record) => {
            const owner = { source: 'bangumi', external_id: String(record.id) };
            return {
              key: owner.external_id,
              claim: session.bindings.claim(owner),
              state: session.store.key('bangumi', owner.external_id),
              candidates: session.bindings.candidates(owner, 'facts', { limit: 100 }),
            };
          }),
        };
      } finally {
        session.close();
      }
    }

    return { close, invoke, preview, inspect, editor, records, feed, argv, state };
  } catch (error) {
    await close();
    throw error;
  }
}
