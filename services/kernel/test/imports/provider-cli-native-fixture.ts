import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import type { SourceId } from '@rezics/conversion';
import type {
  BatchCommand,
  BatchStatement,
  BatchWriteRequest,
  BatchWriteResult,
  Source,
} from '@rezics/definitions/bulk';
import { runImportCli } from '../../../importer/src/cli.ts';
import { IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import type { Seal } from '../../../importer/src/run-store.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';

export type Candidate = {
  id: string;
  statement: Omit<BatchStatement, 'value'> & {
    value:
      | Extract<BatchStatement['value'], { type: 'value' }>
      | (Exclude<BatchStatement['value'], { type: 'value' }> & { content?: never });
  };
  source: Source;
  revision: number;
  retracted: number | null;
  head: number | null;
};
type Exchange = {
  url: string;
  method: string;
  headers: Headers;
  bytes: string;
  status: number;
  responseHeaders: Headers;
  responseBytes: string;
};

/** Only external byte/fetch boundaries are supplied to the production CLI. */
export async function openProviderCli(source: Exclude<SourceId, 'vndb'>, converterRevision: string) {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  let directory: string | undefined;
  try {
    directory = await mkdtemp('/dev/shm/import-provider-cli-');
    const state = join(directory, 'state.sqlite');
    const keyPath = join(directory, 'account.jwk');
    // SQLite and its sidecars inherit the owned database's private mode.
    await writeFile(state, '', { mode: 0o600, flag: 'wx' });
    const native = identitySupport(runtime.identity);
    const editor = await openApiObserver(runtime);
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
      flag: 'wx',
    });
    const api = 'https://provider-cli.import.test';
    const auth = new URL(runtime.identity.auth.verifier.jwksUrl).origin;
    const argv = [
      '--source',
      source,
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
    ];
    const commands = new Map<string, BatchCommand>();
    const exchanges: Exchange[] = [];
    const authPaths: string[] = [];
    const ownedSubjects = new Set<string>();
    const inspect = (keys: readonly string[]) => {
      const session = new ImportSession(state);
      try {
        return {
          source: session.store.source(source),
          active: session.store.activeRun(source),
          records: keys.map((external_id) => ({
            external_id,
            claim: session.bindings.claim({ source, external_id }),
            baseline: session.store.key(source, external_id).baseline,
          })),
          bootstraps: session.store.database
            .query(
              'SELECT r.external_id,r.bootstrap_key,j.bytes,j.acknowledgement FROM binding_records r JOIN binding_journal j ON j.source=r.source AND j.external_id=r.external_id AND j.key=r.bootstrap_key WHERE r.source=? ORDER BY r.external_id LIMIT 16',
            )
            .all(source),
        };
      } finally {
        session.close();
      }
    };
    async function invoke(text: string) {
      const bytes = new TextEncoder().encode(text);
      const original = bytes.slice();
      const offset = exchanges.length;
      const authOffset = authPaths.length;
      const seals: { complete: boolean; result: Seal }[] = [];
      let passes = 0,
        consumed = 0,
        observed = 0,
        peakRetainedBytes = 0,
        coordinators = 0;
      const result = await runImportCli(argv, {
        stdin: (async function* () {
          // Split UTF-8 and framing at actual byte boundaries.
          for (let offset = 0; offset < bytes.length; offset += 127) {
            const chunk = bytes.slice(offset, offset + 127);
            consumed += chunk.length;
            yield chunk;
          }
        })(),
        observer: {
          onInputPass() {
            passes++;
          },
          onInputChunk(_kind, size, backing) {
            observed += size;
            expect(backing).toBe(size);
          },
          onInputBuffer(size) {
            peakRetainedBytes = Math.max(peakRetainedBytes, size);
          },
          onAccountKey(path, observation) {
            expect(path).toBe(keyPath);
            expect(observation.regularFile).toBe(true);
            expect(observation.mode & 0o777).toBe(0o600);
          },
          onCoordinator({ importer, registration, converterModule, decoderModule }) {
            coordinators++;
            expect(registration.sourceKind).toBe(source);
            expect(registration.source).toBe(source);
            expect(registration.converter_revision).toBe(converterRevision);
            expect(converterModule).toBe(
              import.meta.resolve(`@rezics/conversion/${source === 'openlibrary' ? 'open-library' : source}`),
            );
            expect(decoderModule).toBe(import.meta.resolve('../../../importer/src/dumps.ts'));
            const store = importer.session.store;
            const seal = store.seal.bind(store);
            store.seal = (run, input) => {
              const result = seal(run, input);
              seals.push({ complete: input.complete, result });
              return result;
            };
          },
        },
        fetch: (async (input: Request | string | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const url = new URL(request.url);
          if (url.origin === auth) {
            authPaths.push(url.pathname);
            return native.host.service.handler(request);
          }
          expect(url.origin).toBe(api);
          expect(request.headers.has('cookie')).toBe(false);
          expect(['/v1/subjects:batchWrite', '/v1/sourceFences:check']).toContain(url.pathname);
          const bearer = request.headers.get('authorization')!;
          expect(bearer).toStartWith('Bearer ');
          const claims = decodeJwt(bearer.slice(7));
          expect(claims.sub).toBe(runtime.identity.bulk.accountId);
          expect(claims.client_id).toBe(runtime.identity.client.clientId);
          expect(String(claims.scope).split(' ').sort()).toEqual([...IMPORTER_SCOPES].sort());
          const bytes = request.method === 'GET' ? '' : await request.clone().text();
          if (url.pathname === '/v1/subjects:batchWrite') {
            expect(Buffer.byteLength(bytes!)).toBeLessThanOrEqual(65536);
            const body = JSON.parse(bytes!) as BatchWriteRequest;
            for (const command of body.commands) {
              const previous = commands.get(command.key);
              if (previous) expect(command).toEqual(previous);
              commands.set(command.key, command);
            }
          }
          const response = await runtime.replay(request);
          const responseBytes = await response.clone().text();
          exchanges.push({
            url: request.url,
            method: request.method,
            headers: new Headers(request.headers),
            bytes,
            status: response.status,
            responseHeaders: new Headers(response.headers),
            responseBytes,
          });
          if (url.pathname === '/v1/subjects:batchWrite' && response.status === 200) {
            for (const entry of (JSON.parse(responseBytes) as BatchWriteResult).results) {
              expect('value' in entry, JSON.stringify(entry)).toBe(true);
              if ('value' in entry && 'id' in entry.value) ownedSubjects.add(entry.value.id);
            }
          }
          return response;
        }) as typeof fetch,
      });
      const diagnostic = JSON.stringify(result);
      expect(result.openHandles, diagnostic).toBe(0);
      expect(coordinators, diagnostic).toBe(1);
      expect(passes, diagnostic).toBe(1);
      expect(consumed, diagnostic).toBe(bytes.length);
      expect(observed, diagnostic).toBe(bytes.length);
      expect(bytes).toEqual(original);
      expect(authPaths.slice(authOffset).filter((path) => path === '/signin/key')).toHaveLength(1);
      expect(authPaths.slice(authOffset).filter((path) => path === '/token')).toHaveLength(1);
      for (const name of await readdir(directory!))
        expect((await stat(join(directory!, name))).mode & 0o777).toBe(0o600);
      const captured = exchanges.slice(offset);
      return {
        ...result,
        seals,
        consumed,
        peakRetainedBytes,
        captured,
        writes: captured.filter((exchange) => exchange.method !== 'GET'),
      };
    }
    async function receipt(key: string) {
      const command = commands.get(key)!;
      const route =
        command.op === 'create'
          ? tupleRoute(runtime.identity.routeKey, command.source.source, command.source.external_id)
          : routeOf(command.subject)!;
      return (
        await runtime.database.admin.query(
          'SELECT transaction_id,response FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5',
          [partitionOf(route), 'account', runtime.identity.bulk.accountId, `subject.batch_${command.op}`, key],
        )
      ).rows;
    }
    async function claim(externalId: string) {
      return (
        await runtime.database.admin.query<{ subject_id: string }>(
          'SELECT subject_id FROM semantic.external_claim WHERE route=$1 AND source=$2 AND external_id=$3',
          [tupleRoute(runtime.identity.routeKey, source, externalId), source, externalId],
        )
      ).rows;
    }
    async function effects() {
      const subjects = [];
      for (const id of [...ownedSubjects].sort()) {
        const parameters = [routeOf(id), id];
        subjects.push({
          id,
          subject: (
            await runtime.database.admin.query(
              'SELECT * FROM semantic.subject WHERE route=$1 AND subject_id=$2',
              parameters,
            )
          ).rows,
          candidates: (
            await runtime.database.admin.query(
              'SELECT * FROM semantic.candidate WHERE route=$1 AND subject_id=$2 ORDER BY candidate_id LIMIT 100',
              parameters,
            )
          ).rows,
          retractions: (
            await runtime.database.admin.query(
              'SELECT * FROM semantic.retraction WHERE route=$1 AND subject_id=$2 ORDER BY revision LIMIT 100',
              parameters,
            )
          ).rows,
          revisions: (
            await runtime.database.admin.query(
              'SELECT * FROM semantic.revision WHERE route=$1 AND subject_id=$2 ORDER BY revision LIMIT 100',
              parameters,
            )
          ).rows,
        });
      }
      const receipts = [];
      for (const key of [...commands.keys()].sort()) receipts.push({ key, rows: await receipt(key) });
      return { subjects, receipts };
    }
    async function candidates(id: string, property: string, sameAs?: string) {
      const response = await editor.http(
        `/v1/subjects/${id}/candidates?${new URLSearchParams({
          property,
          context: GLOBAL_CONTEXT,
          limit: '100',
          ...(sameAs ? { sameAs } : {}),
        })}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.next).toBeNull();
      return response.body.candidates as unknown as Candidate[];
    }
    async function select(id: string, candidate: Candidate) {
      const grant = await editor.http('/v1/grants', {
        resource: { route: 0, id: GLOBAL_CONTEXT },
        subject: { kind: 'account', id: runtime.identity.governance.accountId },
        actions: ['context:accept', 'context:adopt'],
        valid: '(,)',
      });
      expect(grant.status).toBe(201);
      const accepted = await editor.http(`/v1/subjects/${id}/candidates/${candidate.id}:accept`, {
        context: GLOBAL_CONTEXT,
        expected_head: candidate.head,
      });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      const adopted = await editor.http(`/v1/subjects/${id}:adopt`, {
        context: GLOBAL_CONTEXT,
        property: candidate.statement.property.id,
        mode: 'replace',
        expected_head: null,
        selection: [{ candidate: candidate.id, rank: candidate.statement.rank ?? 'normal' }],
      });
      expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
    }
    async function anonymous(id: string) {
      const response = await runtime.request(`/v1/subjects/${id}`);
      expect(response.status).toBe(200);
      return response.json() as Promise<{
        subject: {
          id: string;
          type: string;
          labels: Record<string, string>;
          statements: Record<string, { id: string }[]>;
        };
      }>;
    }
    return {
      runtime,
      editor,
      invoke,
      inspect,
      receipt,
      claim,
      effects,
      candidates,
      select,
      anonymous,
      commands,
      async close() {
        try {
          await runtime.close();
        } finally {
          await rm(directory!, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      await runtime.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
export type ProviderCli = Awaited<ReturnType<typeof openProviderCli>>;
