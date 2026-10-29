import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import type { Statement, Subject } from '../../../../specs/semantic-driver.ts';
import { runImportCli } from '../../../importer/src/cli.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { routeOf, partitionOf } from '../../src/route/route.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';

export const records = Array.from({ length: 5 }, (_, index) => ({
  id: 910001 + index,
  type: 2,
  name: `Synthetic disappearance title ${index + 1}`,
}));
export const feed = (rows = records) => rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
export type NativeCandidate = {
  id: string;
  statement: Statement;
  revision: number;
  source: BatchCommand['source'] | null;
  retracted: number | null;
  retraction: { source: BatchCommand['source']; references: Statement['references'] } | null;
};
type Exchange = {
  request: Request;
  bytes: string;
  body: BatchWriteRequest;
  status: number;
  response: string;
  result: BatchWriteResult;
};

/** Only the external fetch boundary is routed; Auth, Access and every reply are native. */
export async function openDisappearanceCli() {
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
    // Both secrets and durable SQLite (including sidecars) are private, owned tmpfs files.
    directory = await mkdtemp('/dev/shm/imports-disappearance-');
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
    const commands = new Map<string, BatchCommand>();
    const authPaths: string[] = [];
    async function invoke(text: string, threshold?: string, failAtEof = false) {
      let ended = false;
      let consumed = 0;
      const start = exchanges.length;
      const result = await runImportCli(
        [
          '--source',
          'bangumi',
          '--dump',
          '-',
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
          ...(threshold === undefined ? [] : ['--disappearance-threshold', threshold]),
        ],
        {
          stdin: (async function* () {
            try {
              const bytes = new TextEncoder().encode(text);
              for (let offset = 0; offset < bytes.length; offset += 31) {
                const chunk = bytes.slice(offset, offset + 31);
                consumed += chunk.length;
                yield chunk;
              }
              if (failAtEof) throw new Error('Synthetic upstream read failure at EOF');
            } finally {
              ended = true;
            }
          })(),
          observer: {
            onAccountKey(_path, observation) {
              expect(observation.regularFile).toBe(true);
              expect(observation.mode & 0o777).toBe(0o600);
            },
          },
          fetch: (async (input: Request | string | URL, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init);
            const url = new URL(request.url);
            if (url.origin === auth) {
              expect(['/signin/key', '/token', '/.well-known/jwks.json']).toContain(url.pathname);
              authPaths.push(url.pathname);
              return native.host.service.handler(request);
            }
            expect(url.origin).toBe(api);
            expect(['/v1/subjects:batchWrite', '/v1/sourceFences:check']).toContain(url.pathname);
            expect(request.headers.has('cookie')).toBe(false);
            if (url.pathname !== '/v1/subjects:batchWrite') return runtime.replay(request);
            const saved = request.clone();
            const bytes = await request.clone().text();
            const body = JSON.parse(bytes) as BatchWriteRequest;
            for (const command of body.commands) {
              const previous = commands.get(command.key);
              if (previous) expect(command).toEqual(previous);
              commands.set(command.key, command);
            }
            const response = await runtime.replay(request);
            const responseBytes = await response.clone().text();
            exchanges.push({
              request: saved,
              bytes,
              body,
              status: response.status,
              response: responseBytes,
              result: JSON.parse(responseBytes) as BatchWriteResult,
            });
            return response;
          }) as typeof fetch,
        },
      );
      expect(result.openHandles, JSON.stringify(result)).toBe(0);
      expect(ended).toBe(true);
      expect(consumed).toBe(Buffer.byteLength(text));
      expect((await stat(state)).mode & 0o777).toBe(0o600);
      return { ...result, exchanges: exchanges.slice(start) };
    }
    function inspect() {
      const session = new ImportSession(state);
      try {
        const source = session.store.source('bangumi');
        const sequence = session.store.database
          .query('SELECT sequence FROM run_sources WHERE source=?')
          .get('bangumi') as { sequence: number };
        const acquisition = session.store.database
          .query(
            'SELECT status,threshold,prior,supplied,survivors,classified,resolved,prepared FROM run_generations WHERE source=? AND id=?',
          )
          .get('bangumi', String(sequence.sequence));
        return {
          source,
          active: session.store.activeRun('bangumi'),
          acquisition,
          records: records.map((record) => {
            const owner = { source: 'bangumi', external_id: String(record.id) };
            const bootstrap = [...commands.values()].find(
              (c) => c.op === 'create' && c.source.external_id === owner.external_id,
            );
            return {
              key: owner.external_id,
              claim: session.bindings.claim(owner),
              state: session.store.key('bangumi', owner.external_id),
              bootstrap: bootstrap ? session.bindings.journal(owner, bootstrap.key) : null,
              candidates: session.bindings.candidates(owner, 'facts', { limit: 100 }),
            };
          }),
        };
      } finally {
        session.close();
      }
    }
    async function receipts() {
      const rows = [];
      for (const [key, command] of commands) {
        const route =
          command.op === 'create'
            ? tupleRoute(runtime.identity.routeKey, command.source.source, command.source.external_id)
            : routeOf(command.subject)!;
        const result = await runtime.database.admin.query(
          'SELECT transaction_id,response FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5',
          [partitionOf(route), 'account', runtime.identity.bulk.accountId, `subject.batch_${command.op}`, key],
        );
        expect(result.rows).toHaveLength(1);
        rows.push({ key, ...result.rows[0] });
      }
      return rows;
    }
    async function revisions(ids: string[]) {
      const result = [];
      for (const id of ids) {
        const subjects = await runtime.database.admin.query(
          'SELECT subject_id FROM semantic.subject WHERE route=$1 AND subject_id=$2',
          [routeOf(id), id],
        );
        expect(subjects.rows).toEqual([{ subject_id: id }]);
        const rows = await runtime.database.admin.query(
          'SELECT revision,recorded_transaction_id,kind FROM semantic.revision WHERE route=$1 AND subject_id=$2 ORDER BY revision LIMIT 100',
          [routeOf(id), id],
        );
        expect(rows.rows.length).toBeLessThan(100);
        result.push({ id, rows: rows.rows });
      }
      return result;
    }
    async function candidates(id: string, context?: string) {
      const response = await editor.http(
        `/v1/subjects/${id}/candidates?${new URLSearchParams({
          property: 'schema:name',
          limit: '100',
          ...(context ? { context } : {}),
        })}`,
      );
      expect(response.status).toBe(200);
      expect(response.body.next).toBeNull();
      return { rows: response.body.candidates as NativeCandidate[], adoption: response.body.adoption };
    }
    async function subject(id: string, context?: string) {
      const response = await editor.http(`/v1/subjects/${id}${context ? `?context=${context}` : ''}`);
      expect(response.status).toBe(200);
      return response.body.subject as Subject;
    }
    return {
      runtime,
      native,
      editor,
      invoke,
      inspect,
      receipts,
      revisions,
      candidates,
      subject,
      exchanges,
      commands,
      authPaths,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
