import { expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { BatchCommand, BatchStatement, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { converter_revision } from '../../../../packages/conversion/src/open-library.ts';
import { runImportCli, type ImportCliResult } from '../../../importer/src/cli.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';
import workSource from '../../../../specs/fixtures/imports/open-library/work.json';
import editionSource from '../../../../specs/fixtures/imports/open-library/edition.json';

// Explicit bibliographic input: native keys/revisions, no cover or unknown-licensed prose.
const work = {
  type: workSource.type,
  key: workSource.key,
  revision: workSource.revision,
  last_modified: workSource.last_modified,
  title: workSource.title,
};
const edition = {
  type: editionSource.type,
  key: editionSource.key,
  revision: editionSource.revision,
  last_modified: editionSource.last_modified,
  title: editionSource.title,
  works: editionSource.works,
  authors: editionSource.authors,
  isbn_13: editionSource.isbn_13,
};
type InputRecord = typeof work | typeof edition;
type Candidate = { id: string; statement: BatchStatement; source: BatchCommand['source']; retracted: number | null };
type Exchange = { path: string; bytes: string; status: number; response: string };
type Invocation = {
  source: string;
  inputDigest: string;
  eof: boolean;
  returned: number;
  consumed: number;
  auth: string[];
  exchanges: Exchange[];
  result?: ImportCliResult;
};
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const relation = 'schema:exampleOfWork';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { resolve, promise };
}

/** Scheduling only: next() really remains pending before EOF until cancellation calls return(). */
function input(records: readonly InputRecord[], held = false) {
  const bytes = new TextEncoder().encode(
    records
      .map((r) => [r.type.key, r.key, r.revision, r.last_modified.value, JSON.stringify(r)].join('\t'))
      .join('\n') + '\n',
  );
  const waiting = deferred();
  let finish: ((value: IteratorResult<Uint8Array>) => void) | undefined;
  let sent = false;
  const observation = { eof: false, returned: 0 };
  const stream: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (!sent) {
        sent = true;
        return { done: false, value: bytes };
      }
      if (held) {
        waiting.resolve();
        return new Promise<IteratorResult<Uint8Array>>((resolve) => (finish = resolve));
      }
      observation.eof = true;
      return { done: true, value: undefined };
    },
    async return() {
      observation.returned++;
      const end = { done: true as const, value: undefined };
      finish?.(end);
      return end;
    },
  };
  return { bytes, stream, waiting: waiting.promise, observation };
}

/** One native application/Auth/worker world; only external input and HTTP routing are supplied. */
export async function runConcurrentCliOwnersJourney() {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  let directory: string | undefined;
  let controller = new AbortController();
  const pending = new Set<Promise<ImportCliResult>>();
  const invocations: Invocation[] = [];
  const publicReads: { path: string; status: number; body: unknown }[] = [];
  const databases: Database[] = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    controller.abort();
    await Promise.allSettled(pending);
    try {
      await runtime.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    directory = await mkdtemp('/dev/shm/imports-concurrent-cli-');
    const state = join(directory, 'state.sqlite');
    await writeFile(state, '', { mode: 0o600 });
    const keyPath = join(directory, 'account.jwk');
    const identity = runtime.identity;
    const native = identitySupport(identity);
    await native.renewManagement();
    const kid = randomUUID();
    const pair = await generateKeyPair('ES256', { extractable: true });
    const staged = await identity.auth.internal.stageCredentialEffect({
      key: kid,
      subjectAccountId: identity.bulk.accountId,
      headers: native.managementHeaders,
      credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(pair.publicKey)), kid } },
    });
    const effect = {
      key: staged.key,
      effectRef: staged.effectRef,
      subjectAccountId: identity.bulk.accountId,
      headers: native.managementHeaders,
    };
    const approval = await identity.auth.internal.approveCredentialEffect(effect);
    await identity.auth.internal.applyCredentialEffect({ ...effect, authorization: approval.reference });
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256' }), {
      mode: 0o600,
    });
    const editor = await openApiObserver(runtime);
    // openApiRuntime starts the registered worker. No second worker or service is constructed here.
    expect(runtime.mediaBoundary).toBeDefined();
    const api = 'https://kernel.import.test';
    const auth = new URL(identity.auth.verifier.jwksUrl).origin;
    const a = 'concurrent-books-a';
    const b = 'concurrent-books-b';
    function invoke(source: string, records: readonly InputRecord[], hold = false) {
      const feed = input(records, hold);
      const observed: Invocation = {
        source,
        inputDigest: digest(feed.bytes),
        eof: false,
        returned: 0,
        consumed: 0,
        auth: [],
        exchanges: [],
      };
      invocations.push(observed);
      const done = runImportCli(
        [
          '--source',
          'openlibrary',
          '--source-alias',
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
          identity.bulk.accountId,
          '--client',
          identity.client.clientId,
        ],
        {
          stdin: feed.stream,
          signal: controller.signal,
          observer: {
            onAccountKey(path, observation) {
              expect(path).toBe(keyPath);
              expect(observation.regularFile).toBe(true);
              expect(observation.mode & 0o777).toBe(0o600);
            },
            onInputChunk(_kind, size) {
              observed.consumed += size;
            },
            onCoordinator({ importer, registration, state: openedState }) {
              expect(openedState).toBe(state);
              expect(registration.source).toBe(source);
              expect(registration.sourceKind).toBe('openlibrary');
              expect(registration.converter_revision).toBe(converter_revision);
              databases.push(importer.session.store.database);
            },
          },
          fetch: (async (url: Request | string | URL, init?: RequestInit) => {
            const request = url instanceof Request ? url : new Request(url, init);
            const target = new URL(request.url);
            if (target.origin === auth) {
              observed.auth.push(target.pathname);
              return native.host.service.handler(request);
            }
            expect(target.origin).toBe(api);
            expect(feed.observation.eof).toBe(true);
            expect(request.headers.has('cookie')).toBe(false);
            const bytes = await request.clone().text();
            if (target.pathname === '/v1/subjects:batchWrite') {
              for (const command of (JSON.parse(bytes) as BatchWriteRequest).commands) {
                expect(command.source.source).toBe(source);
                expect(command.source.converter_revision).toBe(converter_revision);
                expect(command.key.startsWith(`${source}:${command.source.external_id}:`)).toBe(true);
              }
            } else {
              expect(target.pathname).toBe('/v1/sourceFences:check');
              expect(target.searchParams.get('source')).toBe(source);
            }
            const response = await runtime.replay(request);
            observed.exchanges.push({
              path: target.pathname + target.search,
              bytes,
              status: response.status,
              response: await response.clone().text(),
            });
            return response;
          }) as typeof fetch,
        },
      ).then((result) => {
        observed.result = result;
        observed.eof = feed.observation.eof;
        observed.returned = feed.observation.returned;
        return result;
      });
      pending.add(done);
      void done.finally(() => pending.delete(done)).catch(() => {});
      return { done, observed, feed };
    }
    async function complete(source: string, records: readonly InputRecord[]) {
      const invocation = invoke(source, records);
      const result = await invocation.done;
      expect(result.code, JSON.stringify(result)).toBe(0);
      expect(result.openHandles).toBe(0);
      expect(invocation.observed.eof).toBe(true);
      expect(invocation.observed.consumed).toBe(invocation.feed.bytes.length);
      for (const exchange of invocation.observed.exchanges) {
        expect(exchange.status, exchange.response).toBe(200);
        if (exchange.path === '/v1/subjects:batchWrite')
          for (const entry of (JSON.parse(exchange.response) as BatchWriteResult).results)
            expect([200, 201]).toContain(entry.status);
      }
      return result;
    }
    function inspect(source: string) {
      const session = new ImportSession(state);
      try {
        const db = session.store.database;
        const maintained = session.store.source(source);
        return {
          source: db.query('SELECT source,generation,present_count FROM run_sources WHERE source=?').get(source) as {
            source: string;
            generation: string;
            present_count: number;
          } | null,
          records: maintained.count,
          active: session.store.activeRun(source),
          entries: [work.key, edition.key].map((key) => ({
            key,
            row: session.store.key(source, key),
            claim: session.bindings.claim({ source, external_id: key }),
            signature: session.store.referenceSignature(source, key),
            journal: db
              .query(
                'SELECT key,bytes,acknowledgement FROM binding_journal WHERE source=? AND external_id=? ORDER BY key LIMIT 100',
              )
              .all(source, key),
          })),
        };
      } finally {
        session.close();
      }
    }
    function owner(source: string) {
      const db = new Database(state, { readonly: true });
      try {
        return db.query('SELECT source,pid,birth,capability FROM import_owners WHERE source=?').get(source);
      } finally {
        db.close();
      }
    }
    function claim(source: string, key: string) {
      const entry = inspect(source).entries.find((e) => e.key === key)!;
      if (entry.claim?.state !== 'bound') throw new Error(`Missing actual bound claim: ${source}:${key}`);
      return entry.claim.subject;
    }
    function commands(source: string) {
      return invocations
        .filter((i) => i.source === source)
        .flatMap((i) => i.exchanges)
        .filter((e) => e.path === '/v1/subjects:batchWrite')
        .flatMap((e) => (JSON.parse(e.bytes) as BatchWriteRequest).commands);
    }
    async function receipts(source: string) {
      const rows = [];
      for (const command of new Map(commands(source).map((c) => [c.key, c])).values()) {
        const route =
          command.op === 'create'
            ? tupleRoute(identity.routeKey, command.source.source, command.source.external_id)
            : routeOf(command.subject)!;
        const result = await runtime.database.admin.query(
          'SELECT transaction_id,response FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5',
          [partitionOf(route), 'account', identity.bulk.accountId, `subject.batch_${command.op}`, command.key],
        );
        expect(result.rows).toHaveLength(1);
        rows.push({ key: command.key, ...result.rows[0] });
        if (command.op === 'create') {
          const actual = await runtime.database.admin.query(
            'SELECT subject_id FROM semantic.external_claim WHERE route=$1 AND source=$2 AND external_id=$3',
            [route, source, command.source.external_id],
          );
          expect(actual.rows).toEqual([{ subject_id: claim(source, command.source.external_id) }]);
        }
      }
      return rows;
    }
    async function read(path: string, body?: unknown) {
      const response = await editor.http(path, body);
      publicReads.push({ path, status: response.status, body: response.body });
      expect(response.status, JSON.stringify(response.body)).toBe(body && path === '/v1/contexts' ? 201 : 200);
      return response.body;
    }
    async function candidates(id: string, property: string, context?: string, target?: string) {
      const result = await read(
        `/v1/subjects/${id}/candidates?${new URLSearchParams({
          property,
          limit: '100',
          ...(context ? { context } : {}),
          ...(target ? { target } : {}),
        })}`,
      );
      expect(result.next).toBeNull();
      return result.candidates as Candidate[];
    }
    async function relationValue(source: string) {
      const id = claim(source, edition.key);
      const rows = (await candidates(id, relation)).filter((c) => c.retracted === null);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source.source).toBe(source);
      const value = rows[0]!.statement.value;
      if (value.type !== 'value') throw new Error('Native relation is still unresolved');
      return value.content;
    }
    async function snapshot(source: string) {
      const local = inspect(source);
      const nativeRows = [];
      for (const entry of local.entries) {
        if (entry.claim?.state !== 'bound') continue;
        const id = entry.claim.subject;
        const subject = await read(`/v1/subjects/${id}`);
        const revisions = await read(`/v1/subjects/${id}/revisions?limit=100`);
        expect(revisions.next).toBeNull();
        nativeRows.push({
          subject,
          revisions,
          names: await candidates(id, 'schema:name'),
          relations: await candidates(id, relation),
        });
      }
      return { local, receipts: await receipts(source), nativeRows };
    }

    // Establish old identities before concurrent acquisition. Editions learn only their own work.
    await complete(a, [work]);
    await complete(a, [work, edition]);
    const oldA = inspect(a);
    const oldAReceipts = await receipts(a);
    const sourceAWork = claim(a, work.key);
    const sourceAClaim = claim(a, edition.key);
    expect(await relationValue(a)).toBe(sourceAWork);
    const revised = { ...work, revision: work.revision + 1, title: 'Owner A revised bibliographic title' };
    const heldOwner = invoke(a, [revised, edition], true);
    await Promise.race([
      heldOwner.feed.waiting,
      heldOwner.done.then((result) => {
        throw new Error(`Owner stopped before held EOF: ${JSON.stringify(result)}`);
      }),
    ]);
    const heldRow = owner(a);
    expect(heldRow).toMatchObject({ source: a, pid: process.pid });
    expect(heldOwner.feed.observation.eof).toBe(false);
    expect(heldOwner.observed.auth).toEqual([]);
    expect(heldOwner.observed.exchanges).toEqual([]);
    const sameSource = invoke(a, [work, edition]);
    const sameSourceCompetitor = await sameSource.done;
    expect(sameSource.observed.consumed).toBe(0);
    expect(owner(a)).toEqual(heldRow);

    // B's edition must not borrow A's already durable work. All CLI handles use the same SQLite.
    const independent = await complete(b, [edition]);
    const independentBaseline = inspect(b);
    const sourceBClaim = claim(b, edition.key);
    const unresolved = (await candidates(sourceBClaim, relation)).filter((c) => c.retracted === null);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.statement.value).toEqual({ type: 'somevalue' });
    expect(independentBaseline.entries.find((e) => e.key === work.key)!.claim).toBeNull();
    expect(await candidates(sourceBClaim, relation, undefined, sourceAWork)).toEqual([]);
    await complete(b, [work, edition]);
    await complete(b, [work, edition]);
    const sourceBWork = claim(b, work.key);
    const sourceBRelation = await relationValue(b);
    expect(owner(a)).toEqual(heldRow);
    expect(heldOwner.observed.exchanges).toEqual([]);
    const sourceBBefore = await snapshot(b);

    // Cancellation closes the actual pending iterator and coordinator; the next ordinary CLI reopens the file.
    controller.abort(new DOMException('Operator interrupted held acquisition', 'AbortError'));
    const cancelledOwner = await heldOwner.done;
    expect(heldOwner.observed.returned).toBeGreaterThan(0);
    expect(heldOwner.observed.eof).toBe(false);
    expect(owner(a)).toBeNull();
    expect(inspect(a).entries).toEqual(oldA.entries);
    expect(await receipts(a)).toEqual(oldAReceipts);
    controller = new AbortController();
    const recoveredOwner = await complete(a, [revised, edition]);
    expect(claim(a, work.key)).toBe(sourceAWork);
    expect(claim(a, edition.key)).toBe(sourceAClaim);
    const sourceARelation = await relationValue(a);
    const afterA = inspect(a);
    for (const old of oldA.entries)
      for (const journal of old.journal) {
        expect(afterA.entries.find((entry) => entry.key === old.key)!.journal).toContainEqual(journal);
      }
    const currentReceipts = await receipts(a);
    for (const receipt of oldAReceipts) expect(currentReceipts).toContainEqual(receipt);
    const sourceBAfter = await snapshot(b);

    // Select real candidate values, then take down exactly A's work/facts tuple through the native API.
    const contextBody = await read('/v1/contexts', { labels: { en: 'Concurrent feed ownership review' } });
    const context = (contextBody.context as { id: string }).id;
    async function selectName(id: string) {
      const rows = (await candidates(id, 'schema:name', context)).filter((c) => c.retracted === null);
      expect(rows).toHaveLength(1);
      await read(`/v1/subjects/${id}/candidates/${rows[0]!.id}:accept`, { context, expected_head: null });
      await read(`/v1/subjects/${id}:adopt`, {
        context,
        property: 'schema:name',
        mode: 'replace',
        selection: [{ candidate: rows[0]!.id, rank: 'normal' }],
        expected_head: null,
      });
      const links = linkProjection(runtime.database.pool);
      let drained = false;
      for (let batch = 0; batch < 16; batch++) {
        const result = await links.run(partitionOf(routeOf(id)!));
        expect(result.status).not.toBe('stopped');
        if (result.status === 'busy') {
          await Bun.sleep(5);
          continue;
        }
        if (result.status === 'read' && result.envelopes === 0) {
          drained = true;
          break;
        }
      }
      expect(drained).toBe(true);
    }
    await selectName(sourceAWork);
    await selectName(sourceBWork);
    const beforeFence = await read(`/v1/subjects/${sourceAWork}?context=${context}`);
    const values = (body: typeof beforeFence) =>
      (body.subject as { statements: Record<string, BatchStatement[]> }).statements['schema:name']?.map(
        (s) => s.value,
      ) ?? [];
    expect(values(beforeFence).length).toBeGreaterThan(0);
    const fence = await read('/v1/sourceFences:takedown', {
      source: a,
      externalId: work.key,
      fieldGroup: 'facts',
      reason: 'Controlled owner A tuple withdrawal',
    });
    expect(fence.securityRevision).toMatch(/^[1-9][0-9]*$/);
    const sourceA = inspect(a).source!.source;
    const sourceB = inspect(b).source!.source;
    for (const source of [sourceA, sourceB]) {
      const checked = await read(
        `/v1/sourceFences:check?${new URLSearchParams({ source, externalId: work.key, fieldGroup: 'facts' })}`,
      );
      expect(checked).toEqual({
        fenced: source === sourceA,
        securityRevision: source === sourceA ? fence.securityRevision : null,
      });
    }
    const fencedSourceVisibleValues = values(await read(`/v1/subjects/${sourceAWork}?context=${context}`));
    const unfencedSourceVisibleValues = values(await read(`/v1/subjects/${sourceBWork}?context=${context}`));
    const foreignReceiptDisclosures = invocations.flatMap((i) => {
      const foreign =
        i.source === a
          ? [sourceBWork, sourceBClaim, ...commands(b).map((c) => c.key)]
          : [sourceAWork, sourceAClaim, ...commands(a).map((c) => c.key)];
      return i.exchanges.filter((e) => foreign.some((key) => e.bytes.includes(key) || e.response.includes(key)));
    });
    expect((await stat(state)).mode & 0o777).toBe(0o600);
    for (const db of databases) expect(() => db.query('SELECT 1').get()).toThrow();
    const db = new Database(state, { readonly: true });
    let remainingOwners: unknown[];
    try {
      remainingOwners = db.query('SELECT source FROM import_owners WHERE source IN (?,?)').all(a, b);
    } finally {
      db.close();
    }
    const openHandlesAtEnd = invocations.reduce((n, i) => n + i.result!.openHandles, remainingOwners.length);
    console.log(
      'concurrent CLI native evidence',
      JSON.stringify({
        converterRevision: converter_revision,
        bundleDigest: bundledDigest,
        bundleCatalogue: bundledRelease.catalogue,
        sourceFixtureDigests: {
          work: digest(
            await readFile(join(import.meta.dir, '../../../../specs/fixtures/imports/open-library/work.json')),
          ),
          edition: digest(
            await readFile(join(import.meta.dir, '../../../../specs/fixtures/imports/open-library/edition.json')),
          ),
        },
        heldRow,
        invocations,
        oldA,
        oldAReceipts,
        afterA,
        currentReceipts,
        sourceBBefore,
        sourceBAfter,
        publicReads,
        nativeGrowthEvidence: 'missing: this connected caller is not a new growth series',
      }),
    );
    return {
      sameSourceCompetitor,
      competitorAuthRequests: sameSource.observed.auth,
      competitorPublicWrites: sameSource.observed.exchanges.filter((e) => e.path === '/v1/subjects:batchWrite'),
      independent,
      independentBaseline,
      cancelledOwner,
      recoveredOwner,
      sourceA,
      sourceB,
      sourceAClaim,
      sourceBClaim,
      sourceARelation,
      sourceBRelation,
      sourceAWork,
      sourceBWork,
      sourceBAfter,
      sourceBBefore,
      foreignReceiptDisclosures,
      fencedSourceVisibleValues,
      unfencedSourceVisibleValues,
      openHandlesAtEnd,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
