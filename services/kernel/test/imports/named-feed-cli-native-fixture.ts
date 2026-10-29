import { expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { runImportCli } from '../../../importer/src/cli.ts';
import { IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import type { Statement } from '../../src/semantic/item.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';
import workSource from '../../../../specs/fixtures/imports/open-library/work.json';
import editionSource from '../../../../specs/fixtures/imports/open-library/edition.json';

export type Alias = 'books-a' | 'books-b';
export type Record = typeof work | typeof edition;
// Explicit independent bibliographic records derived from the checked-in native records.
// Covers and unknown-licensed prose are outside this named-feed journey.
export const work = {
  type: workSource.type,
  key: workSource.key,
  revision: workSource.revision,
  last_modified: workSource.last_modified,
  title: workSource.title,
};
export const edition = {
  type: editionSource.type,
  key: editionSource.key,
  revision: editionSource.revision,
  last_modified: editionSource.last_modified,
  title: editionSource.title,
  works: editionSource.works,
  authors: editionSource.authors,
  isbn_13: editionSource.isbn_13,
};
export const control = { ...work, key: '/works/OL900000003W', title: 'Independent controlled work' };
export type Candidate = {
  id: string;
  statement: Statement;
  revision: number;
  retracted: number | null;
  source: BatchCommand['source'] | null;
};
export type Exchange = {
  alias: Alias;
  path: string;
  bytes: string;
  status: number;
  response: string;
  request: Request;
};
export const commands = (exchanges: readonly Exchange[]) =>
  exchanges
    .filter((e) => e.path === '/v1/subjects:batchWrite')
    .flatMap((e) => (JSON.parse(e.bytes) as BatchWriteRequest).commands);

export async function openNamedFeeds() {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  let directory: string | undefined;
  const owners = new Set<ImportSession>();
  const close = async () => {
    try {
      for (const session of owners) session.close();
    } finally {
      try {
        await runtime.close();
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
  };
  try {
    directory = await mkdtemp('/dev/shm/imports-named-feed-');
    const state = join(directory, 'state.sqlite');
    await writeFile(state, '', { mode: 0o600 });
    const keyPath = join(directory, 'account.jwk');
    const f = runtime.identity;
    const native = identitySupport(f);
    const editor = await openApiObserver(runtime);
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
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256' }), {
      mode: 0o600,
    });
    const api = 'https://kernel.import.test';
    const auth = new URL(f.auth.verifier.jwksUrl).origin;
    const exchanges: Exchange[] = [];
    const bibliographies: { alias: Alias; key: string; permission: unknown; url: unknown }[] = [];
    const authPaths: string[] = [];
    const bearers = new Map<Alias, string>();
    const publicResponses: { alias: Alias; path: string; status: number; body: unknown }[] = [];
    async function invoke(alias: Alias, records: readonly Record[]) {
      const dump = join(directory!, `${alias}.tsv`);
      const bytes =
        records
          .map((r) => [r.type.key, r.key, r.revision, r.last_modified.value, JSON.stringify(r)].join('\t'))
          .join('\n') + '\n';
      await writeFile(dump, bytes, { mode: 0o600 });
      let consumed = 0;
      const start = exchanges.length;
      const result = await runImportCli(
        [
          '--source',
          'openlibrary',
          '--source-alias',
          alias,
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
          f.bulk.accountId,
          '--client',
          f.client.clientId,
          '--disappearance-threshold',
          '1',
        ],
        {
          observer: {
            onAccountKey(path, observation) {
              expect(path).toBe(keyPath);
              expect(observation.regularFile).toBe(true);
              expect(observation.mode & 0o777).toBe(0o600);
            },
            onInputChunk(_kind, size) {
              consumed += size;
            },
            onDatabaseOpen(path) {
              expect(path).toBe(state);
            },
            onCoordinator({ registration }) {
              expect(registration.source).toBe(alias);
              expect(registration.sourceKind).toBe('openlibrary');
              // Observe the converter actually called by this CLI, preserving its output unchanged.
              const convert = registration.convert;
              registration.convert = (input, context) => {
                const output = convert(input, context);
                const metadata = Reflect.get(output, 'sourceMetadata');
                expect(metadata.bibliographyPermission).toBe('CC0-1.0');
                expect(metadata.recordUrl).toBe(`https://openlibrary.org${input.external_id}`);
                bibliographies.push({
                  alias,
                  key: input.external_id,
                  permission: metadata.bibliographyPermission,
                  url: metadata.recordUrl,
                });
                return output;
              };
            },
          },
          fetch: (async (input: Request | string | URL, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init);
            const url = new URL(request.url);
            if (url.origin === auth) {
              authPaths.push(url.pathname);
              if (url.pathname === '/signin/key') {
                const body = await request.clone().json();
                expect(body.account_id).toBe(f.bulk.accountId);
                expect(body.scope).toEqual([...IMPORTER_SCOPES]);
                expect(decodeJwt(body.assertion).sub).toBe(f.bulk.accountId);
              }
              return native.host.service.handler(request);
            }
            expect(url.origin).toBe(api);
            expect(request.headers.has('cookie')).toBe(false);
            const bearer = request.headers.get('authorization')!;
            expect(decodeJwt(bearer.slice(7)).sub).toBe(f.bulk.accountId);
            if (!bearers.has(alias)) bearers.set(alias, bearer);
            const bytes = await request.clone().text();
            if (url.pathname === '/v1/subjects:batchWrite') {
              for (const command of (JSON.parse(bytes) as BatchWriteRequest).commands) {
                expect(command.source.source).toBe(alias);
                expect(command.key.startsWith(`${alias}:${command.source.external_id}:`)).toBe(true);
              }
            } else {
              expect(url.pathname).toBe('/v1/sourceFences:check');
              expect(url.searchParams.get('source')).toBe(alias);
            }
            const saved = request.clone();
            const response = await runtime.replay(request);
            exchanges.push({
              alias,
              path: url.pathname,
              bytes,
              request: saved,
              status: response.status,
              response: await response.clone().text(),
            });
            return response;
          }) as typeof fetch,
        },
      );
      expect(result.openHandles, JSON.stringify(result)).toBe(0);
      expect((await stat(state)).mode & 0o777).toBe(0o600);
      return { ...result, exchanges: exchanges.slice(start), consumed, bytes };
    }
    function snapshot(alias: Alias, keys: readonly string[]) {
      const db = new Database(state, { readonly: true });
      try {
        const source = db.query('SELECT generation,present_count FROM run_sources WHERE source=?').get(alias) as {
          generation: string;
          present_count: number;
        } | null;
        return {
          source,
          records: keys.map((key) => {
            const baseline = source
              ? db
                  .query(
                    'SELECT row_json,projection_json FROM run_entries WHERE source=? AND run_id=? AND record_key=?',
                  )
                  .get(alias, source.generation, key)
              : null;
            return {
              key,
              baseline,
              fingerprint: createHash('sha256').update(JSON.stringify(baseline)).digest('hex'),
              claim: db
                .query('SELECT state,subject,bootstrap_key FROM binding_records WHERE source=? AND external_id=?')
                .get(alias, key),
              signature: db
                .query('SELECT signature FROM run_reference_signatures WHERE source=? AND record_key=?')
                .get(alias, key),
            };
          }),
        };
      } finally {
        db.close();
      }
    }
    function bootstrap(alias: Alias, key: string) {
      const create = commands(exchanges).find(
        (c) => c.op === 'create' && c.source.source === alias && c.source.external_id === key,
      );
      if (!create) throw new Error('Missing captured bootstrap');
      const db = new Database(state, { readonly: true });
      try {
        return db
          .query('SELECT key,bytes,acknowledgement FROM binding_journal WHERE source=? AND external_id=? AND key=?')
          .get(alias, key, create.key);
      } finally {
        db.close();
      }
    }
    function claim(alias: Alias, key: string) {
      const create = commands(exchanges).find(
        (c) => c.op === 'create' && c.source.source === alias && c.source.external_id === key,
      );
      if (!create) throw new Error('Missing actual create request');
      const result = exchanges
        .filter((e) => e.path === '/v1/subjects:batchWrite')
        .flatMap((e) => (JSON.parse(e.response) as BatchWriteResult).results)
        .find((r) => r.key === create.key);
      if (!result || !('value' in result) || !('id' in result.value)) throw new Error('Missing actual claim response');
      expect([200, 201]).toContain(result.status);
      const observed = snapshot(alias, [key]).records[0]!.claim;
      expect(observed).toMatchObject({ state: 'bound', subject: result.value.id, bootstrap_key: create.key });
      return { id: result.value.id, result, command: create };
    }
    async function receipts() {
      const rows = [];
      for (const command of new Map(commands(exchanges).map((c) => [c.key, c])).values()) {
        const route =
          command.op === 'create'
            ? tupleRoute(f.routeKey, command.source.source, command.source.external_id)
            : routeOf(command.subject)!;
        const result = await runtime.database.admin.query(
          'SELECT transaction_id,response FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5',
          [partitionOf(route), 'account', f.bulk.accountId, `subject.batch_${command.op}`, command.key],
        );
        expect(result.rows).toHaveLength(1);
        rows.push({ key: command.key, ...result.rows[0] });
        if (command.op === 'create') {
          const actual = claim(command.source.source as Alias, command.source.external_id);
          const native = await runtime.database.admin.query(
            'SELECT subject_id FROM semantic.external_claim WHERE route=$1 AND source=$2 AND external_id=$3',
            [route, command.source.source, command.source.external_id],
          );
          expect(native.rows).toEqual([{ subject_id: actual.id }]);
        }
      }
      return rows;
    }
    async function original(alias: Alias, path: string) {
      const bearer = bearers.get(alias);
      if (!bearer) throw new Error('Missing original CLI bearer');
      const response = await runtime.replay(new Request(`${api}${path}`, { headers: { authorization: bearer } }));
      const body = await response.json();
      publicResponses.push({ alias, path, status: response.status, body });
      return { status: response.status, body };
    }
    async function candidates(id: string, property: string, context?: string, target?: string) {
      const response = await editor.http(
        `/v1/subjects/${id}/candidates?${new URLSearchParams({
          property,
          limit: '100',
          ...(context ? { context } : {}),
          ...(target ? { target } : {}),
        })}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.next).toBeNull();
      return response.body.candidates as Candidate[];
    }
    async function select(id: string, property: string, candidate: string, context: string, target?: string) {
      const query = new URLSearchParams({ property, context, limit: '100', ...(target ? { target } : {}) });
      const listing = await editor.http(`/v1/subjects/${id}/candidates?${query}`);
      expect(listing.status).toBe(200);
      expect((listing.body.candidates as Candidate[]).some((c) => c.id === candidate)).toBe(true);
      expect(
        (
          await editor.http(`/v1/subjects/${id}/candidates/${candidate}:accept`, {
            context,
            expected_head: null,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await editor.http(`/v1/subjects/${id}:adopt`, {
            context,
            property,
            ...(target ? { target } : {}),
            mode: 'replace',
            selection: [{ candidate, rank: 'normal' }],
            expected_head: (listing.body.adoption as { head: number } | null)?.head ?? null,
          })
        ).status,
      ).toBe(200);
      const links = linkProjection(runtime.database.pool);
      let caughtUp = false;
      for (let batch = 0; batch < 16; batch++) {
        const delivered = await links.run(partitionOf(routeOf(id)!));
        expect(delivered.status).not.toBe('stopped');
        if (delivered.status === 'busy') {
          await Bun.sleep(5);
          continue;
        }
        if (delivered.status === 'read' && delivered.envelopes === 0) {
          caughtUp = true;
          break;
        }
      }
      expect(caughtUp).toBe(true);
    }
    function hold(alias: Alias) {
      const session = new ImportSession(state);
      owners.add(session);
      const ownership = session.acquire(alias);
      if (ownership === 'busy') throw new Error('Unexpected live owner');
      return {
        session,
        ownership,
        release() {
          session.release(ownership);
          session.close();
          owners.delete(session);
        },
      };
    }
    return {
      runtime,
      editor,
      invoke,
      snapshot,
      bootstrap,
      claim,
      receipts,
      original,
      candidates,
      select,
      hold,
      exchanges,
      authPaths,
      publicResponses,
      bibliographies,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
