import { expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { converter_revision } from '../../../../packages/conversion/src/open-library.ts';
import { runImportCli } from '../../../importer/src/cli.ts';
import { IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import type { Seal } from '../../../importer/src/run-store.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { Statement } from '../../src/semantic/item.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';
import workSource from '../../../../specs/fixtures/imports/open-library/work.json';
import editionSource from '../../../../specs/fixtures/imports/open-library/edition.json';

type Candidate = { id: string; statement: Statement };
const author = {
  type: { key: '/type/author' },
  key: '/authors/OL900000001A',
  revision: 1,
  last_modified: { type: '/type/datetime', value: '2025-01-01T00:00:00Z' },
  name: 'Ada Example',
};
const extra = {
  type: { key: '/type/work' as const },
  key: '/works/OL900000003W',
  revision: 1,
  last_modified: { type: '/type/datetime', value: '2025-01-01T00:00:00Z' },
  title: 'Vanishing work',
};

function tsv(record: {
  type: { key: string };
  key: string;
  revision: number;
  last_modified?: { value: string };
  title?: string;
}) {
  const date = record.last_modified?.value ?? '2025-01-01T00:00:00Z';
  return `${[record.type.key, record.key, record.revision, date, JSON.stringify(record)].join('\t')}\n`;
}

/** Preview a mixed gzip/plain Open Library set, import one generation, then resume sealed work without member files. */
export async function runOpenLibrarySetPreviewJourney() {
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
    directory = await mkdtemp('/dev/shm/ol-set-preview-native-');
    const state = join(directory, 'state.sqlite');
    const keyPath = join(directory, 'account.jwk');
    const identity = runtime.identity;
    const support = identitySupport(identity);
    const editor = await openApiObserver(runtime);
    await support.renewManagement();
    const kid = randomUUID();
    const keys = await generateKeyPair('ES256', { extractable: true });
    const staged = await identity.auth.internal.stageCredentialEffect({
      key: kid,
      subjectAccountId: identity.bulk.accountId,
      headers: support.managementHeaders,
      credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(keys.publicKey)), kid } },
    });
    const effect = {
      key: staged.key,
      effectRef: staged.effectRef,
      subjectAccountId: identity.bulk.accountId,
      headers: support.managementHeaders,
    };
    const approval = await identity.auth.internal.approveCredentialEffect(effect);
    await identity.auth.internal.applyCredentialEffect({ ...effect, authorization: approval.reference });
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(keys.privateKey)), kid, alg: 'ES256' }), {
      mode: 0o600,
    });
    const auth = new URL(identity.auth.verifier.jwksUrl).origin;
    const api = 'https://kernel.import.test';
    const alias = 'set-preview-books';
    const exchanges: { path: string; key: string | null; bytes: string; status: number }[] = [];
    let sealed = false;

    async function writeManifest(
      name: string,
      files: { author: string; work: string; edition: string },
      gzipEdition = true,
    ) {
      const dir = join(directory!, name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'authors.txt.gz'), gzipSync(Buffer.from(files.author)), { mode: 0o600 });
      await writeFile(join(dir, 'works.txt'), files.work, { mode: 0o600 });
      await writeFile(
        join(dir, gzipEdition ? 'editions.txt.gz' : 'editions.txt'),
        gzipEdition ? gzipSync(Buffer.from(files.edition)) : files.edition,
        { mode: 0o600 },
      );
      const path = join(dir, 'manifest.json');
      await writeFile(
        path,
        JSON.stringify({
          version: 2,
          source: 'openlibrary',
          members: [
            { family: 'author', path: 'authors.txt.gz', compression: 'gzip' },
            { family: 'work', path: 'works.txt', compression: 'none' },
            {
              family: 'edition',
              path: gzipEdition ? 'editions.txt.gz' : 'editions.txt',
              compression: gzipEdition ? 'gzip' : 'none',
            },
          ],
        }),
        { mode: 0o600 },
      );
      return path;
    }

    const argv = (manifest: string) => [
      '--source',
      'openlibrary',
      '--source-alias',
      alias,
      '--dump-set',
      manifest,
      '--state',
      state,
      '--api',
      api,
      '--auth',
      auth,
      '--account-key',
      keyPath,
      '--account',
      identity.bulk.accountId,
      '--client',
      identity.client.clientId,
    ];

    async function invoke(manifest: string, options: { losePropose?: boolean; deny?: boolean } = {}) {
      sealed = false;
      const controller = new AbortController();
      return runImportCli(argv(manifest), {
        signal: controller.signal,
        observer: {
          onCoordinator({ importer, registration, converterModule }) {
            expect(registration.source).toBe(alias);
            expect(registration.converter_revision).toBe(converter_revision);
            expect(converterModule).toContain('open-library');
            const seal = importer.session.store.seal.bind(importer.session.store);
            importer.session.store.seal = (...args) => {
              const outcome = seal(...args) as Seal;
              sealed = outcome.status === 'ready';
              return outcome;
            };
          },
        },
        fetch: (async (input: Request | string | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const url = new URL(request.url);
          if (url.origin === auth) {
            if (options.deny) return new Response('denied', { status: 403 });
            return support.host.service.handler(request);
          }
          expect(url.origin).toBe(api);
          if (request.method !== 'GET') expect(sealed).toBe(true);
          const bytes = request.method === 'GET' ? '' : await request.clone().text();
          if (url.pathname === '/v1/subjects:batchWrite') {
            for (const command of (JSON.parse(bytes) as BatchWriteRequest).commands) {
              expect(command.source.source).toBe(alias);
              runtime.commands.set(command.key, { command, actor: identity.bulk.accountId });
            }
          }
          const claims = decodeJwt(request.headers.get('authorization')!.slice(7));
          expect(claims.sub).toBe(identity.bulk.accountId);
          expect(String(claims.scope).split(' ').sort()).toEqual([...IMPORTER_SCOPES].sort());
          const response = await runtime.replay(request);
          exchanges.push({
            path: url.pathname,
            key: request.headers.get('idempotency-key'),
            bytes,
            status: response.status,
          });
          if (
            options.losePropose &&
            url.pathname === '/v1/subjects:batchWrite' &&
            (JSON.parse(bytes) as BatchWriteRequest).commands.some((command) => command.op === 'propose')
          ) {
            controller.abort(new DOMException('Interrupted after native commit before local ACK', 'AbortError'));
            throw controller.signal.reason;
          }
          return response;
        }) as typeof fetch,
      });
    }

    const firstFiles = {
      author: tsv(author),
      work: tsv(workSource) + tsv(extra),
      edition: tsv(editionSource),
    };
    const first = await writeManifest('first', firstFiles);
    const initial = await invoke(first);
    expect(initial.code).toBe(0);

    const changed = await writeManifest('changed', {
      author: tsv(author),
      work: tsv({ ...workSource, revision: 2, title: 'Revised atlas' }),
      edition: tsv(editionSource),
    });
    const previewed = await runImportCli(
      ['preview', '--source', 'openlibrary', '--source-alias', alias, '--dump-set', changed, '--baseline', state, '--json', '--page', 'changed'],
      {
        fetch: (async () => {
          throw new Error('preview network');
        }) as unknown as typeof fetch,
      },
    );
    expect(previewed.code).toBe(0);
    const document = JSON.parse(previewed.stdout) as {
      complete: boolean;
      acquisition: string;
      counts: { changed: number; vanished: number };
      importInvocation: string[];
    };
    expect(document.complete).toBe(true);
    expect(document.acquisition).toBe('dump-set');
    expect(document.counts.changed).toBeGreaterThanOrEqual(1);
    expect(document.counts.vanished).toBe(1);
    expect(document.importInvocation.join('\n')).toContain('--dump-set <complete-manifest-path>');
    const session = new ImportSession(state);
    try {
      expect(session.store.source(alias).count).toBe(3);
    } finally {
      session.close();
    }

    const imported = await invoke(changed);
    expect(imported.code).toBe(0);

    const interrupt = await writeManifest('interrupt', {
      author: tsv(author),
      work: tsv({ ...workSource, revision: 3, title: 'Interrupted atlas' }),
      edition: tsv(editionSource),
    });
    const interrupted = await invoke(interrupt, { losePropose: true });
    expect([1, 130]).toContain(interrupted.code);
    await rm(join(directory, 'interrupt', 'authors.txt.gz'));
    await rm(join(directory, 'interrupt', 'works.txt'));
    await rm(join(directory, 'interrupt', 'editions.txt.gz'));
    const recovered = await invoke(interrupt);
    expect(recovered.code).toBe(0);
    const denied = await invoke(interrupt, { deny: true });
    expect(denied.code).toBe(4);

    const workId = (() => {
      const create = exchanges
        .filter((item) => item.path === '/v1/subjects:batchWrite' && item.bytes)
        .flatMap((item) => (JSON.parse(item.bytes) as BatchWriteRequest).commands)
        .find((command) => command.op === 'create' && command.source.external_id === workSource.key);
      if (!create) throw new Error('missing work bootstrap');
      const db = new Database(state, { readonly: true });
      try {
        return (db.query('SELECT subject FROM binding_records WHERE source=? AND external_id=?').get(alias, workSource.key) as {
          subject: string;
        }).subject;
      } finally {
        db.close();
      }
    })();
    const editionId = (() => {
      const db = new Database(state, { readonly: true });
      try {
        return (db.query('SELECT subject FROM binding_records WHERE source=? AND external_id=?').get(alias, editionSource.key) as {
          subject: string;
        }).subject;
      } finally {
        db.close();
      }
    })();
    const resolved = await editor.http(
      `/v1/subjects/${editionId}/candidates?${new URLSearchParams({ property: 'schema:exampleOfWork', context: GLOBAL_CONTEXT, limit: '100', target: workId })}`,
    );
    expect(resolved.status).toBe(200);
    expect((resolved.body.candidates as Candidate[]).length).toBeGreaterThan(0);

    return { close, initial, previewed, imported, interrupted, recovered, denied, workId, editionId };
  } catch (error) {
    await close();
    throw error;
  }
}
