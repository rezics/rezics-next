import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { BatchCommand, BatchStatement, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { converter_revision as bangumiRevision } from '../../../../packages/conversion/src/bangumi.ts';
import { converter_revision as libraryRevision } from '../../../../packages/conversion/src/open-library.ts';
import edition from '../../../../specs/fixtures/imports/open-library/edition.json';
import { runImportCli } from '../../../importer/src/cli.ts';
import { IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import type { Importer } from '../../../importer/src/importer.ts';
import type { Pending, Seal } from '../../../importer/src/run-store.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';
import { identitySupport } from './identity-fixture.ts';

type Source = 'bangumi' | 'openlibrary';
type Exchange = {
  ordinal: number;
  path: string;
  method: string;
  bytes: string;
  status: number;
  response: string;
  keys: string[];
};
type Candidate = { id: string; source: BatchCommand['source'] | null; statement: BatchStatement };
type Journal = { source: string; external_id: string; key: string; bytes: string; acknowledgement: string | null };
type MediaJournal = {
  source: string;
  external_id: string;
  key: string;
  bytes: string;
  accepted: string;
  status: string;
};
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bangumi = {
  id: 424242,
  type: 2,
  name: 'The Clockwork Observatory',
  images: { large: 'https://lain.bgm.tv/cover.jpg' },
};
const jsonl = (record: unknown) => `${JSON.stringify(record)}\n`;
const tsv = (record: typeof edition) =>
  [record.type.key, record.key, record.revision, record.last_modified.value, JSON.stringify(record)].join('\t') + '\n';
const feeds = [
  {
    source: 'bangumi' as const,
    externalId: String(bangumi.id),
    converter: bangumiRevision,
    initial: jsonl(bangumi),
    interrupted: jsonl({ ...bangumi, name: 'The Interrupted Observatory' }),
    successor: jsonl({ ...bangumi, name: 'The Successor Observatory' }),
  },
  {
    source: 'openlibrary' as const,
    externalId: edition.key,
    converter: libraryRevision,
    initial: tsv(edition),
    interrupted: tsv({ ...edition, revision: 12, title: 'The Interrupted Atlas' }),
    successor: tsv({ ...edition, revision: 13, title: 'The Successor Atlas' }),
  },
];

/** One native application/Auth/worker world; only input delivery and response-loss timing are supplied. */
export async function runCliAckRecoveryJourney() {
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
    directory = await mkdtemp('/dev/shm/import-cli-ack-');
    const state = join(directory, 'state.sqlite');
    const keyPath = join(directory, 'account.jwk');
    await writeFile(state, '', { flag: 'wx', mode: 0o600 });
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
      flag: 'wx',
      mode: 0o600,
    });
    const editor = await openApiObserver(runtime);
    const api = 'https://cli-ack.import.test';
    const auth = new URL(runtime.identity.auth.verifier.jwksUrl).origin;
    const exchanges: Exchange[] = [];
    const commands = new Map<string, BatchCommand>();
    // Requests containing credentials stay private to this closure, never in evidence or assertion diagnostics.
    const lostRequests: Request[] = [];
    const committedBeforeLoss: { exchange: Exchange; receipts: Awaited<ReturnType<typeof receipts>> }[] = [];

    async function receipts(keys: readonly string[]) {
      const result = [];
      for (const key of keys) {
        const command = commands.get(key)!;
        const route =
          command.op === 'create'
            ? tupleRoute(runtime.identity.routeKey, command.source.source, command.source.external_id)
            : routeOf(command.subject)!;
        const rows = (
          await runtime.database.admin.query(
            'SELECT partition_no,principal_kind,principal_id,command_kind,idempotency_key,transaction_id,response FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5',
            [partitionOf(route), 'account', runtime.identity.bulk.accountId, `subject.batch_${command.op}`, key],
          )
        ).rows;
        expect(rows).toHaveLength(1);
        result.push({ key, rows });
      }
      return result;
    }
    function inspect(source: Source, externalId: string) {
      const session = new ImportSession(state);
      try {
        const active = session.store.activeRun(source);
        const owner = { source, external_id: externalId };
        return {
          source: session.store.source(source),
          active,
          pending: active ? session.store.pagePending(active, { limit: 100 }) : [],
          record: session.store.key(source, externalId),
          claim: session.bindings.claim(owner),
          journals: session.store.database
            .query<Journal, [string, string]>(
              'SELECT source,external_id,key,bytes,acknowledgement FROM binding_journal WHERE source=? AND external_id=? ORDER BY key LIMIT 100',
            )
            .all(source, externalId),
          media: session.store.database
            .query<MediaJournal, [string, string]>(
              'SELECT source,external_id,key,bytes,accepted,status FROM binding_media WHERE source=? AND external_id=? ORDER BY key LIMIT 64',
            )
            .all(source, externalId),
        };
      } finally {
        session.close();
      }
    }
    async function invoke(feed: (typeof feeds)[number], text: string, lose = false) {
      const start = exchanges.length;
      const controller = new AbortController();
      let coordinator: Importer | undefined;
      let ended = false;
      let consumed = 0;
      let observed = 0;
      let passes = 0;
      let sealed = false;
      const seals: Seal[] = [];
      const authPaths: string[] = [];
      const result = await runImportCli(
        [
          '--source',
          feed.source,
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
        ],
        {
          signal: controller.signal,
          stdin: (async function* () {
            const bytes = new TextEncoder().encode(text);
            for (let offset = 0; offset < bytes.length; offset += 127) {
              const chunk = bytes.slice(offset, offset + 127);
              consumed += chunk.length;
              yield chunk;
            }
            ended = true;
          })(),
          observer: {
            onAccountKey(path, observation) {
              expect(path).toBe(keyPath);
              expect(observation.regularFile).toBe(true);
              expect(observation.mode & 0o777).toBe(0o600);
            },
            onInputPass() {
              passes++;
            },
            onInputChunk(_kind, size, backing) {
              observed += size;
              expect(backing).toBe(size);
            },
            onCoordinator({ importer, registration, converterModule }) {
              coordinator = importer;
              expect(registration.source).toBe(feed.source);
              expect(registration.converter_revision).toBe(feed.converter);
              expect(converterModule).toBe(
                import.meta.resolve(
                  `../../../../packages/conversion/src/${feed.source === 'openlibrary' ? 'open-library' : 'bangumi'}.ts`,
                ),
              );
              // Observe the real seal, without changing its input or result.
              const seal = importer.session.store.seal.bind(importer.session.store);
              importer.session.store.seal = (run, input) => {
                const result = seal(run, input);
                seals.push(result);
                sealed = result.status === 'ready';
                return result;
              };
              // A reopened run's sealed payload, not this invocation's stdin, owns recovery.
              const active = importer.session.store.activeRun(feed.source);
              if (active) sealed = importer.session.store.pagePending(active, { limit: 100 }).length > 0;
            },
          },
          fetch: (async (input: Request | string | URL, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init);
            const url = new URL(request.url);
            if (url.origin === auth) {
              expect(sealed).toBe(true);
              authPaths.push(url.pathname);
              return native.host.service.handler(request);
            }
            expect(url.origin).toBe(api);
            expect(sealed).toBe(true);
            expect(request.headers.has('cookie')).toBe(false);
            const claims = decodeJwt(request.headers.get('authorization')!.slice(7));
            expect(claims.sub).toBe(runtime.identity.bulk.accountId);
            expect(String(claims.scope).split(' ').sort()).toEqual([...IMPORTER_SCOPES].sort());
            const bytes = request.method === 'GET' ? '' : await request.clone().text();
            const bulk = url.pathname === '/v1/subjects:batchWrite';
            const body = bulk ? (JSON.parse(bytes) as BatchWriteRequest) : null;
            for (const command of body?.commands ?? []) {
              expect(command.source.source).toBe(feed.source);
              const previous = commands.get(command.key);
              if (previous) expect(command).toEqual(previous);
              commands.set(command.key, command);
            }
            const saved = request.clone();
            const response = await runtime.replay(request);
            const responseBytes = await response.clone().text();
            const exchange: Exchange = {
              ordinal: exchanges.length + 1,
              path: url.pathname,
              method: request.method,
              bytes,
              status: response.status,
              response: responseBytes,
              keys: body?.commands.map((command) => command.key) ?? [],
            };
            exchanges.push(exchange);
            expect(response.status, responseBytes).toBeLessThan(300);
            if (bulk) {
              const results = (JSON.parse(responseBytes) as BatchWriteResult).results;
              for (const entry of results) expect('value' in entry, JSON.stringify(entry)).toBe(true);
              if (lose && body!.commands.some((command) => command.op === 'propose')) {
                committedBeforeLoss.push({ exchange, receipts: await receipts(exchange.keys) });
                lostRequests.push(saved);
                controller.abort(new DOMException('Interrupted after native commit before local ACK', 'AbortError'));
                throw controller.signal.reason;
              }
            }
            if (url.pathname === '/v1/media:importFromUrl' && response.status === 202) {
              const accepted = JSON.parse(responseBytes) as { media: { id: string } };
              await runtime.mediaBoundary.drain({
                mediaIds: [accepted.media.id],
                maxJobs: 16,
                signal: controller.signal,
              });
            }
            return response;
          }) as typeof fetch,
        },
      );
      expect(result.openHandles).toBe(0);
      expect(coordinator).toBeDefined();
      expect(() => coordinator!.session.store.source(feed.source)).toThrow();
      for (const name of await readdir(directory!))
        expect((await stat(join(directory!, name))).mode & 0o777).toBe(0o600);
      if (!lose) expect(result.code, JSON.stringify(result)).toBe(0);
      const captured = exchanges.slice(start);
      const writes = captured.filter((exchange) => exchange.path === '/v1/subjects:batchWrite');
      expect(authPaths).toEqual(['/signin/key', '/token']);
      if (seals.length) {
        expect(passes).toBe(1);
        expect(ended).toBe(true);
        expect(consumed).toBe(Buffer.byteLength(text));
        expect(observed).toBe(consumed);
        expect(seals).toHaveLength(1);
        expect(seals[0]!.status).toBe('ready');
      } else {
        // Recovery finishes the old sealed generation. A later invocation admits the supplied successor.
        expect(consumed).toBe(0);
        expect(passes).toBe(0);
      }
      return { ...result, captured, writes, seals, consumed, inputSha256: sha256(text) };
    }
    async function candidates(id: string, context: string) {
      const response = await editor.http(
        `/v1/subjects/${id}/candidates?${new URLSearchParams({
          property: 'schema:name',
          context,
          limit: '100',
        })}`,
      );
      expect(response.status).toBe(200);
      expect(response.body.next).toBeNull();
      return response;
    }
    async function subject(id: string, context: string) {
      const response = await runtime.request(`/v1/subjects/${id}?context=${context}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { subject: { statements: Record<string, unknown[]> } };
      const listing = await candidates(id, context);
      return { statements: body.subject.statements['schema:name'], adoption: listing.body.adoption };
    }
    async function nativeEffects(id: string) {
      const parameters = [routeOf(id), id];
      const rows = [];
      for (const [kind, sql] of [
        ['subject', 'SELECT * FROM semantic.subject WHERE route=$1 AND subject_id=$2'],
        [
          'candidate',
          'SELECT * FROM semantic.candidate WHERE route=$1 AND subject_id=$2 ORDER BY candidate_id LIMIT 100',
        ],
        [
          'retraction',
          'SELECT * FROM semantic.retraction WHERE route=$1 AND subject_id=$2 ORDER BY revision,candidate_id LIMIT 100',
        ],
        ['revision', 'SELECT * FROM semantic.revision WHERE route=$1 AND subject_id=$2 ORDER BY revision LIMIT 100'],
      ] as const) {
        const result = await runtime.database.admin.query(sql, parameters);
        expect(result.rows.length).toBeLessThan(100);
        rows.push(...result.rows.map((row) => ({ kind, row })));
      }
      return rows;
    }

    const children = [];
    for (const feed of feeds) {
      const initial = await invoke(feed, feed.initial);
      const local = inspect(feed.source, feed.externalId);
      expect(local.source.count).toBe(1);
      expect(local.active).toBeNull();
      expect(local.claim?.state).toBe('bound');
      if (local.claim?.state !== 'bound') throw new Error('Native CLI did not bind its exact source');
      const id = local.claim.subject;
      const claim = await runtime.database.admin.query<{ subject_id: string }>(
        'SELECT subject_id FROM semantic.external_claim WHERE route=$1 AND source=$2 AND external_id=$3',
        [tupleRoute(runtime.identity.routeKey, feed.source, feed.externalId), feed.source, feed.externalId],
      );
      expect(claim.rows).toEqual([{ subject_id: id }]);
      const contextResponse = await editor.http('/v1/contexts', { labels: { en: 'Independent ACK recovery review' } });
      expect(contextResponse.status).toBe(201);
      const context = (contextResponse.body.context as { id: string }).id;
      const listed = await candidates(id, context);
      const candidate = (listed.body.candidates as unknown as Candidate[])[0]!;
      expect(candidate.source!.source).toBe(feed.source);
      expect(
        (
          await editor.http(`/v1/subjects/${id}/candidates/${candidate.id}:accept`, {
            context,
            expected_head: null,
          })
        ).status,
      ).toBe(200);
      const independent = await editor.http(`/v1/subjects/${id}/candidates`, {
        statement: {
          property: { id: 'schema:name' },
          value: { type: 'value', content: { language: 'en', text: 'Independent community title' } },
          references:
            candidate.statement.references?.map((reference) => ({
              parts: reference.parts.map((part) => ({ property: { id: part.property.id }, value: part.value })),
            })) ?? [],
        },
      });
      expect(independent.status).toBe(201);
      const independentId = independent.body.candidate as string;
      expect(independentId).not.toBe(candidate.id);
      expect(
        (
          await editor.http(`/v1/subjects/${id}/candidates/${independentId}:accept`, {
            context,
            expected_head: null,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await editor.http(`/v1/subjects/${id}:adopt`, {
            context,
            property: 'schema:name',
            mode: 'replace',
            expected_head: null,
            selection: [{ candidate: independentId, rank: 'normal' }],
          })
        ).status,
      ).toBe(200);
      const selection = await subject(id, context);
      expect(selection.statements).toHaveLength(1);
      const bootstrap = local.journals.filter((journal) =>
        (JSON.parse(journal.bytes) as BatchWriteRequest).commands.some((command) => command.op === 'create'),
      );
      expect(bootstrap).toHaveLength(1);
      const immutableReceipts = await receipts(initial.writes.flatMap((exchange) => exchange.keys));
      // Snapshot the old request attachments. Later rows are looked up by these same exact keys.
      children.push({ feed, id, context, initial, selection, bootstrap, local, immutableReceipts });
    }
    expect(children[0]!.id).not.toBe(children[1]!.id);
    const media = children[0]!.local.media;
    expect(media.length).toBeGreaterThan(0);
    const mediaBefore = [];
    for (const journal of media) {
      const accepted = JSON.parse(journal.accepted) as { media: { id: string } };
      const observed = await runtime.mediaBoundary.observe(accepted.media.id);
      expect(observed.row.state).toBe('available');
      expect(observed.original).not.toBeNull();
      expect(observed.variants.length).toBeGreaterThan(0);
      mediaBefore.push(observed);
    }
    const worker = await runtime.mediaBoundary.capture();
    expect(worker.executedJobs).toBeGreaterThan(0);
    expect(worker.liveInternetRequests).toEqual([]);
    expect(worker.registrations.some((registration) => registration.name === 'content.importFromUrl')).toBe(true);

    const interrupted = [];
    const pendingAfterClose: (Pending & { source: Source })[] = [];
    const effectsBeforeResume = [];
    for (const child of children) {
      const result = await invoke(child.feed, child.feed.interrupted, true);
      expect([1, 130]).toContain(result.code);
      interrupted.push(result);
      const local = inspect(child.feed.source, child.feed.externalId);
      expect(local.pending).toHaveLength(1);
      expect(local.source).toEqual(child.local.source);
      expect(local.record.baseline).toEqual(child.local.record.baseline);
      expect(local.record.acknowledged).toEqual(child.local.record.acknowledged);
      const loss = committedBeforeLoss.at(-1)!;
      expect(local.pending.map((pending) => pending.bytes)).toEqual([loss.exchange.bytes]);
      expect(local.pending.flatMap((pending) => pending.keys)).toEqual(loss.exchange.keys);
      expect(local.journals.filter((journal) => loss.exchange.keys.includes(journal.key))).toHaveLength(
        loss.exchange.keys.length,
      );
      expect(
        local.journals
          .filter((journal) => loss.exchange.keys.includes(journal.key))
          .every((journal) => journal.acknowledgement === null),
      ).toBe(true);
      pendingAfterClose.push(...local.pending.map((pending) => ({ ...pending, source: child.feed.source })));
      effectsBeforeResume.push(await nativeEffects(child.id));
    }
    expect(committedBeforeLoss).toHaveLength(2);
    const originalReceiptRowsBefore = await receipts([
      ...children.flatMap((child) => child.initial.writes.flatMap((exchange) => exchange.keys)),
      ...pendingAfterClose.flatMap((pending) => pending.keys),
    ]);
    const originalPendingBodies = pendingAfterClose.map((pending) => pending.bytes);
    const originalPendingKeys = pendingAfterClose.flatMap((pending) => pending.keys);
    const resumed = [];
    const duplicateEffectRows = [];
    for (const [index, child] of children.entries()) {
      const result = await invoke(child.feed, child.feed.successor);
      resumed.push(result);
      const pending = pendingAfterClose.filter((pending) => pending.source === child.feed.source);
      expect(result.writes.map((exchange) => exchange.bytes)).toEqual(pending.map((entry) => entry.bytes));
      const local = inspect(child.feed.source, child.feed.externalId);
      expect(local.active).toBeNull();
      expect(local.pending).toEqual([]);
      const after = await nativeEffects(child.id);
      // Independently observed extra or altered native rows, rather than a fixture success flag.
      duplicateEffectRows.push(
        ...after.filter((row) => !effectsBeforeResume[index]!.some((before) => isDeepStrictEqual(row, before))),
      );
      expect(after).toEqual(effectsBeforeResume[index]);
    }
    const originalReceiptRowsAfter = await receipts(originalReceiptRowsBefore.map((row) => row.key));
    expect(originalReceiptRowsAfter).toEqual(originalReceiptRowsBefore);
    const pendingDrainLastEffectOrdinal = Math.max(
      ...resumed.flatMap((result) => result.writes.map((exchange) => exchange.ordinal)),
    );
    const changedSuccessor = [];
    const changedProposalIds: string[] = [];
    for (const child of children) {
      const result = await invoke(child.feed, child.feed.successor);
      changedSuccessor.push(result);
      expect(result.writes.length).toBeGreaterThan(0);
      const local = inspect(child.feed.source, child.feed.externalId);
      expect(local.record.baseline!.digest).not.toBe(child.local.record.baseline!.digest);
      expect(local.record.baseline!.converter_revision).toBe(child.feed.converter);
      expect(local.record.baseline!.digest).toMatch(/^[a-f0-9]{64}$/);
      const listing = await candidates(child.id, child.context);
      const writtenIds = result.writes.flatMap((exchange) =>
        (JSON.parse(exchange.response) as BatchWriteResult).results.flatMap((entry) =>
          'value' in entry && 'candidate' in entry.value ? [entry.value.candidate] : [],
        ),
      );
      const proposals = (listing.body.candidates as unknown as Candidate[]).filter(
        (candidate) =>
          writtenIds.includes(candidate.id) &&
          candidate.source?.source === child.feed.source &&
          candidate.source.digest === local.record.baseline!.digest,
      );
      expect(proposals.length).toBeGreaterThan(0);
      changedProposalIds.push(...proposals.map((candidate) => candidate.id));
    }
    const newerInputFirstEffectOrdinal = Math.min(
      ...changedSuccessor.flatMap((result) => result.writes.map((exchange) => exchange.ordinal)),
    );
    const originalBootstrapBefore = children.map((child) => child.bootstrap);
    const originalBootstrapAfter = children.map((child) =>
      inspect(child.feed.source, child.feed.externalId).journals.filter((journal) =>
        child.bootstrap.some((old) => old.key === journal.key),
      ),
    );
    expect(originalBootstrapAfter).toEqual(originalBootstrapBefore);
    for (const child of children) {
      const local = inspect(child.feed.source, child.feed.externalId);
      expect(local.journals.filter((journal) => child.local.journals.some((old) => old.key === journal.key))).toEqual(
        child.local.journals,
      );
      expect(local.media.filter((journal) => child.local.media.some((old) => old.key === journal.key))).toEqual(
        child.local.media,
      );
      expect(await receipts(child.immutableReceipts.map((row) => row.key))).toEqual(child.immutableReceipts);
    }
    for (const old of mediaBefore) expect(await runtime.mediaBoundary.observe(old.row.id)).toEqual(old);
    const independentSelectionBefore = children.map((child) => child.selection);
    const independentSelectionAfter = [];
    for (const child of children) independentSelectionAfter.push(await subject(child.id, child.context));
    expect(independentSelectionAfter).toEqual(independentSelectionBefore);

    await runtime.identity.setBulkPermission(false);
    const revoked = [];
    for (const [index, request] of lostRequests.entries()) {
      // A new network attempt carries the exact old bearer and body, with a fresh connection signal.
      const replay = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: await request.text(),
      });
      expect(await replay.clone().text()).toBe(committedBeforeLoss[index]!.exchange.bytes);
      const response = await runtime.replay(replay);
      const body = (await response.json()) as Record<string, unknown>;
      expect(response.status).toBe(403);
      expect(body.results ?? null).toBeNull();
      revoked.push({ status: response.status, storedSuccess: body.results ?? null, body });
    }
    expect(await receipts(originalReceiptRowsBefore.map((row) => row.key))).toEqual(originalReceiptRowsBefore);
    const evidence = {
      callerSha256: sha256(new Uint8Array(await Bun.file(import.meta.filename).arrayBuffer())),
      bundleRevision: bundledDigest,
      children: children.map((child, index) => ({
        source: child.feed.source,
        converterRevision: child.feed.converter,
        subject: child.id,
        baselineBefore: child.local.record.baseline,
        baselineAfter: inspect(child.feed.source, child.feed.externalId).record.baseline,
        initial: child.initial,
        interrupted: interrupted[index],
        resumed: resumed[index],
        changedSuccessor: changedSuccessor[index],
      })),
      committedBeforeLoss,
      pendingAfterClose,
      originalReceiptRowsBefore,
      originalReceiptRowsAfter,
      originalBootstrapBefore,
      originalBootstrapAfter,
      independentSelectionBefore,
      independentSelectionAfter,
      duplicateEffectRows,
      changedProposalIds,
      pendingDrainLastEffectOrdinal,
      newerInputFirstEffectOrdinal,
      revoked,
      worker: {
        executedJobs: worker.executedJobs,
        calls: worker.calls,
        registrations: worker.registrations.map(({ name, queue }) => ({ name, queue })),
      },
      media: mediaBefore.map((observation) => ({
        ...observation,
        original: sha256(observation.original!),
        variants: observation.variants.map((variant) => ({ ...variant, bytes: sha256(variant.bytes) })),
      })),
    };
    const evidencePath = join(import.meta.dir, '../../../../.temp/goal/cli-ack-recovery', `${randomUUID()}.json`);
    await mkdir(join(evidencePath, '..'), { recursive: true });
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    // Check-host snapshots omit Git metadata and scratch-file return paths. Preserve the raw witness in stdout too.
    console.log(`cli-ack-recovery-evidence ${JSON.stringify(evidence)}`);
    console.log(
      JSON.stringify({
        outcome: 'Ordinary operator exact ACK interruption and restart recovery',
        evidencePath,
        callerSha256: evidence.callerSha256,
        children: evidence.children.map((child) => ({
          source: child.source,
          converterRevision: child.converterRevision,
          recordRevision: child.baselineAfter!.recordRevision,
          digest: child.baselineAfter!.digest,
        })),
        committedBeforeLoss: committedBeforeLoss.length,
        pendingEnvelopes: pendingAfterClose.length,
        changedProposalIds,
        executedJobs: worker.executedJobs,
        nativeGrowth: 'missing: no new PG growth series',
      }),
    );
    return {
      interrupted: interrupted[0]!,
      resumed: resumed.at(-1)!,
      changedSuccessor: changedSuccessor.at(-1)!,
      committedBeforeLoss,
      pendingAfterClose,
      originalPendingBodies,
      originalPendingKeys,
      replayedBodies: resumed.flatMap((result) => result.writes.map((exchange) => exchange.bytes)),
      replayedKeys: resumed.flatMap((result) => result.writes.flatMap((exchange) => exchange.keys)),
      originalReceiptRowsBefore,
      originalReceiptRowsAfter,
      duplicateEffectRows,
      pendingDrainLastEffectOrdinal,
      newerInputFirstEffectOrdinal,
      changedProposalIds,
      revokedReplay: revoked[0]!,
      originalBootstrapBefore,
      originalBootstrapAfter,
      independentSelectionBefore,
      independentSelectionAfter,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
