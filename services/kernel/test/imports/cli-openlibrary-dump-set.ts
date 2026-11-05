import { expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import firstPublicationSource from './fixtures/open-library-first-publication.json';

type Candidate = { id: string; head?: number | null; statement: Statement };
type Exchange = { path: string; key: string | null; bytes: string; status: number; body: string };
type WorkRow = {
  type: { key: string };
  key: string;
  revision: number;
  last_modified: { value: string };
  title: string;
  [field: string]: unknown;
};
const author = {
  type: { key: '/type/author' },
  key: '/authors/OL900000001A',
  revision: 1,
  last_modified: { type: '/type/datetime', value: '2025-01-01T00:00:00Z' },
  name: 'Ada Example',
};
const extraWorks = [3, 4, 5, 6].map((n) => ({
  type: { key: '/type/work' as const },
  key: `/works/OL90000000${n}W`,
  revision: 1,
  last_modified: { type: '/type/datetime', value: '2025-01-01T00:00:00Z' },
  title: `Retained work ${n}`,
}));

function tsv(record: { type: { key: string }; key: string; revision: number; last_modified?: { value: string } }) {
  const date = record.last_modified?.value ?? '2025-01-01T00:00:00Z';
  return `${[record.type.key, record.key, record.revision, date, JSON.stringify(record)].join('\t')}\n`;
}

/** One Auth/application/worker world. Dump-set files and one lost native reply are supplied. */
export async function runOpenLibraryDumpSetJourney(options: { firstPublication?: boolean } = {}) {
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
    directory = await mkdtemp(join(tmpdir(), 'ol-dump-set-native-'));
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
    const own = 'dump-set-books';
    const reverse = 'dump-set-reverse';
    const exchanges: Exchange[] = [];
    const lostKeys: string[] = [];
    let sealed = false;

    async function writeManifest(
      name: string,
      order: ('author' | 'work' | 'edition')[],
      files: { author: string; work: string; edition: string },
    ) {
      const dir = join(directory!, name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'authors.txt'), files.author, { mode: 0o600 });
      await writeFile(join(dir, 'works.txt'), files.work, { mode: 0o600 });
      await writeFile(join(dir, 'editions.txt'), files.edition, { mode: 0o600 });
      const path = join(dir, 'manifest.json');
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          source: 'openlibrary',
          members: order.map((family) => ({
            family,
            path: { author: 'authors.txt', work: 'works.txt', edition: 'editions.txt' }[family],
          })),
        }),
        { mode: 0o600 },
      );
      return path;
    }

    const publicationWork: WorkRow | undefined = options.firstPublication
      ? {
          type: firstPublicationSource.type,
          key: firstPublicationSource.key,
          revision: firstPublicationSource.revision,
          last_modified: firstPublicationSource.last_modified,
          title: firstPublicationSource.title,
          authors: firstPublicationSource.authors,
          first_publish_date: firstPublicationSource.first_publish_date,
        }
      : undefined;
    const currentWork: WorkRow = publicationWork ?? workSource;
    const currentEdition = publicationWork
      ? { ...editionSource, works: [{ key: currentWork.key }], first_publish_date: '1853' }
      : editionSource;
    const firstFiles = {
      author: tsv(author),
      work: [currentWork, ...extraWorks].map(tsv).join(''),
      edition: tsv(currentEdition),
    };

    async function invoke(
      alias: string,
      manifest: string,
      options: { losePropose?: boolean; deny?: boolean; signal?: AbortSignal } = {},
    ) {
      sealed = false;
      const controller = new AbortController();
      const result = await runImportCli(
        [
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
        ],
        {
          signal: options.signal ?? controller.signal,
          observer: {
            onCoordinator({ importer, registration, converterModule, decoderModule }) {
              expect(registration.source).toBe(alias);
              expect(registration.converter_revision).toBe(converter_revision);
              expect(decoderModule).toContain('dumps.ts');
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
            const body = await response.clone().text();
            exchanges.push({
              path: url.pathname,
              key: request.headers.get('idempotency-key'),
              bytes,
              status: response.status,
              body,
            });
            if (
              options.losePropose &&
              url.pathname === '/v1/subjects:batchWrite' &&
              (JSON.parse(bytes) as BatchWriteRequest).commands.some((command) => command.op === 'propose')
            ) {
              lostKeys.push(...(JSON.parse(bytes) as BatchWriteRequest).commands.map((command) => command.key));
              controller.abort(new DOMException('Interrupted after native commit before local ACK', 'AbortError'));
              throw new DOMException('Interrupted after native commit before local ACK', 'AbortError');
            }
            return response;
          }) as typeof fetch,
        },
      );
      return result;
    }

    function local<T>(read: (db: Database) => T): T {
      const db = new Database(state, { readonly: true });
      try {
        return read(db);
      } finally {
        db.close();
      }
    }
    const commands = () =>
      exchanges
        .filter((e) => e.path === '/v1/subjects:batchWrite')
        .flatMap((e) => (JSON.parse(e.bytes) as BatchWriteRequest).commands);
    function claim(alias: string, key: string) {
      const create = commands().find(
        (c) => c.op === 'create' && c.source.source === alias && c.source.external_id === key,
      );
      if (!create) throw new Error('Missing captured bootstrap request');
      const reply = exchanges
        .filter((e) => e.path === '/v1/subjects:batchWrite')
        .flatMap((e) => (JSON.parse(e.body) as BatchWriteResult).results)
        .find((r) => r.key === create.key);
      if (!reply || !('value' in reply) || !('id' in reply.value)) throw new Error('Missing native bootstrap reply');
      const binding = local((db) =>
        db.query('SELECT state,subject FROM binding_records WHERE source=? AND external_id=?').get(alias, key),
      );
      expect(binding).toEqual({ state: 'bound', subject: reply.value.id });
      return reply.value.id as string;
    }
    async function datePage(subject: string) {
      const response = await editor.http(
        `/v1/subjects/${subject}/candidates?${new URLSearchParams({ property: 'schema:datePublished', context: GLOBAL_CONTEXT, limit: '100' })}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body as { candidates: Candidate[]; adoption: { head: number } | null };
    }
    async function currentDate(subject: string): Promise<Statement | undefined> {
      const response = await runtime.request(`/v1/subjects/${subject}?context=${GLOBAL_CONTEXT}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { subject: { statements: Record<string, Statement[]> } };
      return body.subject.statements['schema:datePublished']?.[0];
    }
    async function selectDate(subject: string, candidate: Candidate, adoption: { head: number } | null) {
      const accepted = await editor.http(`/v1/subjects/${subject}/candidates/${candidate.id}:accept`, {
        context: GLOBAL_CONTEXT,
        expected_head: candidate.head ?? null,
      });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      const adopted = await editor.http(`/v1/subjects/${subject}:adopt`, {
        context: GLOBAL_CONTEXT,
        property: 'schema:datePublished',
        mode: 'replace',
        expected_head: adoption?.head ?? null,
        selection: [{ candidate: candidate.id, rank: 'normal' }],
      });
      expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
    }

    const firstManifest = await writeManifest('first', ['author', 'work', 'edition'], firstFiles);
    const initial = await invoke(own, firstManifest);
    expect(initial.code).toBe(0);
    const workId = claim(own, currentWork.key);
    const editionId = claim(own, editionSource.key);
    const resolved = await editor.http(
      `/v1/subjects/${editionId}/candidates?${new URLSearchParams({ property: 'schema:exampleOfWork', context: GLOBAL_CONTEXT, limit: '100', target: workId })}`,
    );
    expect(resolved.status).toBe(200);
    const resolvedRows = resolved.body.candidates as Candidate[];
    expect(resolvedRows.some((row) => row.statement.value.type === 'value')).toBe(true);
    for (const row of resolvedRows) {
      const accepted = await editor.http(`/v1/subjects/${editionId}/candidates/${row.id}:accept`, {
        context: GLOBAL_CONTEXT,
        expected_head: null,
      });
      expect(accepted.status).toBe(200);
    }
    const adopted = await editor.http(`/v1/subjects/${editionId}:adopt`, {
      context: GLOBAL_CONTEXT,
      property: 'schema:exampleOfWork',
      target: workId,
      mode: 'replace',
      selection: resolvedRows.map((row) => ({ candidate: row.id, rank: 'normal' })),
      expected_head: null,
    });
    expect(adopted.status).toBe(200);
    const current = await runtime.request(`/v1/subjects/${editionId}`);
    expect(current.status).toBe(200);

    let activeWork: WorkRow = currentWork;
    let firstCandidate: Candidate | undefined;
    let firstSelected: Statement | undefined;
    let refreshedCandidate: Candidate | undefined;
    let refreshedSelected: Statement | undefined;
    let lostRequest: Exchange | undefined;
    let replayedRequest: Exchange | undefined;
    if (publicationWork) {
      firstCandidate = (await datePage(workId)).candidates[0];
      expect(firstCandidate).toBeDefined();
      expect(firstCandidate!.statement.value).toEqual({
        type: 'value',
        content: { time: '+1853-00-00T00:00:00Z', precision: 9, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
      });
      expect(await currentDate(workId)).toBeUndefined();
      expect(firstCandidate!.statement.references[0]!.parts.map((part) => [
        part.property.id,
        part.value.type === 'value' ? part.value.content : null,
      ])).toEqual([
        ['schema:url', 'https://openlibrary.org/works/OL66554W.json'],
        ['wdt:P648', 'OL66554W'],
        ['schema:version', '120'],
        ['schema:dateModified', { time: '+2026-09-18T00:00:00Z', precision: 11, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' }],
      ]);
      const editionDate = (await datePage(editionId)).candidates;
      expect(editionDate).toHaveLength(1);
      expect(editionDate[0]!.statement.value).toEqual({
        type: 'value',
        content: { time: '+1980-05-00T00:00:00Z', precision: 10, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
      });
      await selectDate(workId, firstCandidate, (await datePage(workId)).adoption);
      firstSelected = await currentDate(workId);
      expect(firstSelected).toEqual(firstCandidate.statement);
      const unchanged = await invoke(own, firstManifest);
      expect(unchanged.code).toBe(0);
      expect(claim(own, currentWork.key)).toBe(workId);
      expect(await currentDate(workId)).toEqual(firstSelected);
    }

    const reverseManifest = await writeManifest('reverse', ['edition', 'work', 'author'], firstFiles);
    const reversed = await invoke(reverse, reverseManifest);
    expect(reversed.code).toBe(0);
    const reverseWork = claim(reverse, currentWork.key);
    const reverseEdition = claim(reverse, editionSource.key);
    expect(reverseWork).not.toBe(workId);
    const reverseResolved = await editor.http(
      `/v1/subjects/${reverseEdition}/candidates?${new URLSearchParams({ property: 'schema:exampleOfWork', context: GLOBAL_CONTEXT, limit: '100', target: reverseWork })}`,
    );
    expect(
      (reverseResolved.body.candidates as Candidate[]).some(
        (row) => row.statement.value.type === 'value' && row.statement.value.content === reverseWork,
      ),
    ).toBe(true);

    const changedWork = { ...extraWorks[0]!, revision: 2, title: 'Changed retained work 3' };
    const refreshedPublicationWork: WorkRow = publicationWork
      ? {
          ...currentWork,
          revision: 121,
          last_modified: { value: '2026-10-01T00:00:00.000000' },
          title: 'Synthetic refresh of OL66554W',
          first_publish_date: '1854',
        }
      : currentWork;
    const refreshFiles = {
      author: tsv(author),
      work: [refreshedPublicationWork, changedWork, extraWorks[1]!, extraWorks[2]!].map(tsv).join(''),
      edition: tsv(currentEdition),
    };
    const refreshManifest = await writeManifest('refresh', ['author', 'work', 'edition'], refreshFiles);
    const refreshed = await invoke(own, refreshManifest);
    expect(refreshed.code).toBe(0);
    expect(refreshed.stdout).toContain('changed=');
    expect(refreshed.stdout).toContain('unchanged=');
    expect(refreshed.stdout).toContain('vanished=');
    activeWork = refreshedPublicationWork;
    if (publicationWork && firstCandidate && firstSelected) {
      expect(await currentDate(workId)).toEqual(firstSelected);
      const page = await datePage(workId);
      refreshedCandidate = page.candidates.find(
        (candidate) =>
          candidate.statement.value.type === 'value' &&
          JSON.stringify(candidate.statement.value.content) ===
            JSON.stringify({ time: '+1854-00-00T00:00:00Z', precision: 9, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' }),
      );
      expect(refreshedCandidate).toBeDefined();
      expect(refreshedCandidate!.id).not.toBe(firstCandidate.id);
      expect(refreshedCandidate!.statement.references[0]!.parts).toContainEqual({
        property: { id: 'schema:version' },
        value: { type: 'value', content: '121' },
      });
      await selectDate(workId, refreshedCandidate!, page.adoption);
      refreshedSelected = await currentDate(workId);
      expect(refreshedSelected).toEqual(refreshedCandidate!.statement);
    }
    const session = new ImportSession(state);
    try {
      const vanished = session.store.key(own, extraWorks[3]!.key);
      expect(vanished.acknowledged?.state === 'vanished' || vanished.baseline?.state === 'vanished').toBe(true);
    } finally {
      session.close();
    }

    const interruptedSourceWork: WorkRow = publicationWork
      ? {
          ...activeWork,
          revision: 122,
          last_modified: { value: '2026-10-02T00:00:00.000000' },
          title: 'Synthetic lost-response control for OL66554W',
          first_publish_date: '1855',
        }
      : { ...workSource, revision: 8, title: 'Interrupted atlas' };
    const interruptManifest = await writeManifest('interrupt', ['author', 'work', 'edition'], {
      author: tsv(author),
      work: [interruptedSourceWork, changedWork, extraWorks[1]!, extraWorks[2]!]
        .map(tsv)
        .join(''),
      edition: tsv(currentEdition),
    });
    const lostStart = exchanges.length;
    const interrupted = await invoke(own, interruptManifest, { losePropose: true });
    expect([1, 130]).toContain(interrupted.code);
    if (publicationWork && refreshedSelected) {
      expect(await currentDate(workId)).toEqual(refreshedSelected);
      lostRequest = exchanges.slice(lostStart).find(
        (exchange) =>
          exchange.path === '/v1/subjects:batchWrite' &&
          (JSON.parse(exchange.bytes) as BatchWriteRequest).commands.some(
            (command) =>
              command.source.external_id === currentWork.key &&
              command.source.record_revision === '122' &&
              command.op === 'propose' &&
              command.statement.property.id === 'schema:datePublished',
          ),
      );
      expect(lostRequest).toBeDefined();
    }
    const pendingBefore = local(
      (db) =>
        db.query('SELECT key,bytes FROM binding_journal WHERE acknowledgement IS NULL').all() as {
          key: string;
          bytes: string;
        }[],
    );
    const recoveryStart = exchanges.length;
    const recovered = await invoke(own, interruptManifest);
    expect(recovered.code).toBe(0);
    if (lostRequest && refreshedSelected) {
      replayedRequest = exchanges.slice(recoveryStart).find((exchange) => exchange.key === lostRequest!.key);
      expect(replayedRequest).toBeDefined();
      expect(replayedRequest!.bytes).toBe(lostRequest.bytes);
      expect(replayedRequest!.body).toBe(lostRequest.body);
      expect(claim(own, currentWork.key)).toBe(workId);
      expect(await currentDate(workId)).toEqual(refreshedSelected);
    }
    const pendingAfter = local(
      (db) =>
        db.query('SELECT key,bytes FROM binding_journal WHERE acknowledgement IS NULL').all() as {
          key: string;
          bytes: string;
        }[],
    );
    expect(pendingAfter.length).toBeLessThanOrEqual(pendingBefore.length);

    const denied = await invoke(own, interruptManifest, { deny: true });
    expect(denied.code).toBe(4);

    return {
      close,
      initial,
      reversed,
      refreshed,
      interrupted,
      recovered,
      denied,
      workId,
      editionId,
      reverseWork,
      reverseEdition,
      lostKeys,
      publication:
        firstCandidate && firstSelected && refreshedCandidate && refreshedSelected && replayedRequest
          ? {
              firstCandidateId: firstCandidate.id,
              firstSelected,
              refreshedCandidateId: refreshedCandidate.id,
              refreshedSelected,
              replayKey: replayedRequest.key!,
              replayBytes: replayedRequest.bytes,
              workId,
              editionId,
            }
          : undefined,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
