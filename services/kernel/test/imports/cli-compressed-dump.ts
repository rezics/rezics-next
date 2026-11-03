import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { exportJWK, generateKeyPair } from 'jose';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { runImportCli } from '../../../importer/src/cli.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';

const fixtures = new URL('../../../../specs/fixtures/imports/api/', import.meta.url);

type Exchange = { status: number; body: BatchWriteRequest; result: BatchWriteResult };

export async function openCompressedDumpCli() {
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
    directory = await mkdtemp('/dev/shm/imports-gzip-cli-');
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
    const authorizedFetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === auth) return native.host.service.handler(request);
      expect(url.origin).toBe(api);
      if (url.pathname !== '/v1/subjects:batchWrite') return runtime.replay(request);
      const body = JSON.parse(await request.clone().text()) as BatchWriteRequest;
      const response = await runtime.replay(request);
      exchanges.push({
        status: response.status,
        body,
        result: JSON.parse(await response.clone().text()) as BatchWriteResult,
      });
      return response;
    }) as unknown as typeof fetch;

    async function invoke(source: 'openlibrary' | 'wikidata', bytes: Uint8Array | string, extra: string[] = []) {
      const state = join(directory!, `${source}.sqlite`);
      const dump = join(directory!, `${source}.dump`);
      await writeFile(dump, bytes, { mode: 0o600 });
      const start = exchanges.length;
      const result = await runImportCli(
        [
          '--source',
          source,
          '--dump',
          dump,
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
          ...extra,
        ],
        { fetch: authorizedFetch },
      );
      expect(result.openHandles, JSON.stringify(result)).toBe(0);
      return { ...result, exchanges: exchanges.slice(start), state, dump };
    }

    async function preview(source: 'openlibrary' | 'wikidata', bytes: Uint8Array, extra: string[] = []) {
      const dump = join(directory!, `${source}-preview.dump`);
      await writeFile(dump, bytes, { mode: 0o600 });
      const network: string[] = [];
      const result = await runImportCli(['preview', '--source', source, '--dump', dump, '--json', ...extra], {
        fetch: (async (input: RequestInfo | URL) => {
          network.push(String(input));
          throw new Error('preview network');
        }) as unknown as typeof fetch,
      });
      return { ...result, network, dump };
    }

    function inspect(state: string, source: string, keys: string[]) {
      const session = new ImportSession(state);
      try {
        return {
          source: session.store.source(source),
          active: session.store.activeRun(source),
          records: keys.map((key) => ({
            key,
            claim: session.bindings.claim({ source, external_id: key }),
            state: session.store.key(source, key),
          })),
        };
      } finally {
        session.close();
      }
    }

    const openlibrary = await readFile(new URL('openlibrary.tsv', fixtures));
    const wikidata = await readFile(new URL('wikidata.jsonl', fixtures));
    return { close, invoke, preview, inspect, editor, openlibrary, wikidata, gzip: (bytes: Uint8Array) => gzipSync(bytes) };
  } catch (error) {
    await close();
    throw error;
  }
}
