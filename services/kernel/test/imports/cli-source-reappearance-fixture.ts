import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import type { SourceId } from '@rezics/conversion';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { Statement, Subject } from '../../../../specs/semantic-driver.ts';
import { runImportCli } from '../../../importer/src/cli.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';

const providers = ['bangumi', 'vndb', 'openlibrary', 'wikidata'] as const;
// Every provider key below is synthetic. Only the first of five records changes or disappears.
const key = (source: SourceId, index: number) => {
  const id = 930001 + index;
  return source === 'vndb'
    ? `v${id}`
    : source === 'openlibrary'
      ? `/works/OL${id}W`
      : source === 'wikidata'
        ? `Q${id}`
        : String(id);
};
const title = (source: SourceId, index: number, version: number) =>
  `Synthetic ${source} reappearance ${index + 1} version ${index === 0 ? version : 1}`;
const lines = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';

/** Native dump framing, including actual tar members and COPY headers for VNDB. */
async function* input(source: SourceId, version: number, absent = false): AsyncGenerator<Uint8Array> {
  const indexes = Array.from({ length: 5 }, (_, i) => i).filter((i) => !absent || i !== 0);
  if (source !== 'vndb') {
    const rows = indexes.map((i) => {
      const revision = i === 0 ? version + 6 : 7;
      const name = title(source, i, version);
      if (source === 'bangumi') return { id: Number(key(source, i)), type: 2, name };
      if (source === 'openlibrary')
        return {
          key: key(source, i),
          type: { key: '/type/work' },
          revision,
          last_modified: { value: '2026-10-25T00:00:00.000000' },
          title: name,
        };
      return {
        id: key(source, i),
        type: 'item',
        lastrevid: revision,
        labels: { en: { language: 'en', value: name } },
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
      };
    });
    const text =
      source === 'openlibrary'
        ? rows
            .map(
              (row) =>
                `/type/work\t${Reflect.get(row, 'key')}\t${Reflect.get(row, 'revision')}\t2026-10-25T00:00:00Z\t${JSON.stringify(row)}\n`,
            )
            .join('')
        : lines(rows);
    const bytes = new TextEncoder().encode(text);
    for (let offset = 0; offset < bytes.length; offset += 97) yield bytes.slice(offset, offset + 97);
    return;
  }
  // Same native columns as specs/fixtures/imports/vndb-tables/db. No assets, summaries or statistics.
  const tables: Record<string, string> = {
    'vn.header':
      'id\timage\tc_image\tolang\tc_votecount\tc_rating\tc_average\tc_length\tc_lengthnum\tlength\tdevstatus\talias\tdescription\n',
    vn: indexes.map((i) => `${key(source, i)}\t\\N\t\\N\ten\t0\t\\N\t\\N\t\\N\t0\t0\t0\t\\N\t\\N\n`).join(''),
    'vn_titles.header': 'id\tlang\tofficial\ttitle\tlatin\n',
    vn_titles: indexes.map((i) => `${key(source, i)}\ten\tt\t${title(source, i, version)}\t\\N\n`).join(''),
    'entry_meta.header': 'id\tcreated\tlastmod\trevision\tnum_edits\tnum_users\n',
    entry_meta: indexes
      .map((i) => `${key(source, i)}\t2020-01-01\t2026-10-25\t${i === 0 ? version + 6 : 7}\t6\t3\n`)
      .join(''),
  };
  for (const [name, text] of Object.entries(tables)) {
    const body = new TextEncoder().encode(text);
    const header = new Uint8Array(512);
    const put = (offset: number, value: string) => header.set(new TextEncoder().encode(value), offset);
    put(0, `db/${name}`);
    put(100, '0000644\0');
    put(108, '0000000\0');
    put(116, '0000000\0');
    put(124, body.length.toString(8).padStart(11, '0') + '\0');
    put(136, '00000000000\0');
    put(148, '        ');
    put(156, '0');
    put(257, 'ustar\0');
    put(263, '00');
    put(
      148,
      header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
    );
    yield header;
    yield body;
    if (body.length % 512) yield new Uint8Array(512 - (body.length % 512));
  }
  yield new Uint8Array(1024);
}

type Candidate = {
  id: string;
  statement: Statement;
  revision: number;
  source: BatchCommand['source'] | null;
  retracted: number | null;
};
type Exchange = {
  request: Request;
  bytes: string;
  body: BatchWriteRequest;
  status: number;
  response: string;
  result: BatchWriteResult;
};

/** One native application/Auth/worker world. Helpers only schedule and observe real operations. */
export async function runJourney() {
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
    directory = await mkdtemp('/dev/shm/import-reappearance-');
    const state = join(directory, 'state.sqlite');
    await writeFile(state, '', { mode: 0o600 });
    const support = identitySupport(runtime.identity);
    await support.renewManagement();
    const kid = randomUUID(),
      pair = await generateKeyPair('ES256', { extractable: true });
    const staged = await runtime.identity.auth.internal.stageCredentialEffect({
      key: kid,
      subjectAccountId: runtime.identity.bulk.accountId,
      headers: support.managementHeaders,
      credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(pair.publicKey)), kid } },
    });
    const effect = {
      key: staged.key,
      effectRef: staged.effectRef,
      subjectAccountId: runtime.identity.bulk.accountId,
      headers: support.managementHeaders,
    };
    const approval = await runtime.identity.auth.internal.approveCredentialEffect(effect);
    await runtime.identity.auth.internal.applyCredentialEffect({ ...effect, authorization: approval.reference });
    const keyPath = join(directory, 'account.jwk');
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256' }), {
      mode: 0o600,
    });
    const editor = await openApiObserver(runtime);
    const api = 'https://reappearance.import.test';
    const auth = new URL(runtime.identity.auth.verifier.jwksUrl).origin;
    const commands = new Map<string, BatchCommand>();
    const exchanges: Exchange[] = [];
    const authExchanges: { path: string; status: number }[] = [];

    async function invoke(source: SourceId, version: number, absent = false) {
      const start = exchanges.length;
      let acquired = false;
      let coordinator:
        | { source: string; converter_revision: string; converterModule: string; decoderModule: string }
        | undefined;
      const result = await runImportCli(
        [
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
        ],
        {
          stdin: (async function* () {
            yield* input(source, version, absent);
            acquired = true;
          })(),
          observer: {
            onAccountKey(_path, observation) {
              expect(observation.regularFile).toBe(true);
              expect(observation.mode & 0o777).toBe(0o600);
            },
            onCoordinator({ registration, converterModule, decoderModule }) {
              coordinator = {
                source: registration.source,
                converter_revision: registration.converter_revision,
                converterModule,
                decoderModule,
              };
            },
          },
          fetch: (async (value: Request | string | URL, init?: RequestInit) => {
            const request = value instanceof Request ? value : new Request(value, init);
            const url = new URL(request.url);
            if (url.origin === auth) {
              const response = await support.host.service.handler(request);
              authExchanges.push({ path: url.pathname, status: response.status });
              expect(response.status).toBe(200);
              return response;
            }
            expect(url.origin).toBe(api);
            expect(request.headers.has('cookie')).toBe(false);
            expect(['/v1/subjects:batchWrite', '/v1/sourceFences:check']).toContain(url.pathname);
            if (url.pathname !== '/v1/subjects:batchWrite') return runtime.replay(request);
            expect(acquired).toBe(true);
            const saved = request.clone(),
              bytes = await request.clone().text();
            const body = JSON.parse(bytes) as BatchWriteRequest;
            for (const command of body.commands) {
              const previous = commands.get(command.key);
              if (previous) expect(command).toEqual(previous);
              commands.set(command.key, command);
            }
            const response = await runtime.replay(request);
            const responseBytes = await response.clone().text();
            expect(response.status, responseBytes).toBe(200);
            const parsed = JSON.parse(responseBytes) as BatchWriteResult;
            expect(parsed.results.every((entry) => entry.status < 300 && 'value' in entry)).toBe(true);
            exchanges.push({
              request: saved,
              bytes,
              body,
              status: response.status,
              response: responseBytes,
              result: parsed,
            });
            return response;
          }) as typeof fetch,
        },
      );
      expect(result.code, JSON.stringify({ source, version, absent, ...result })).toBe(0);
      expect(result.openHandles).toBe(0);
      expect(acquired).toBe(true);
      expect(coordinator?.converter_revision).toBe(createSourceRegistration(source).converter_revision);
      return { ...result, coordinator, exchanges: exchanges.slice(start) };
    }
    function inspect(source: SourceId) {
      const session = new ImportSession(state);
      try {
        expect(session.store.activeRun(source)).toBeNull();
        return {
          source: session.store.source(source),
          records: Array.from({ length: 5 }, (_, i) => {
            const owner = { source, external_id: key(source, i) };
            const bootstrap = [...commands.values()].find(
              (c) => c.source.source === source && c.source.external_id === owner.external_id && c.op === 'create',
            );
            return {
              owner,
              claim: session.bindings.claim(owner),
              state: session.store.key(source, owner.external_id),
              bootstrap: bootstrap ? session.bindings.journal(owner, bootstrap.key) : null,
              candidates: session.bindings.candidates(owner, 'facts', { limit: 100 }),
            };
          }),
        };
      } finally {
        session.close();
      }
    }
    async function receipts(keys: string[]) {
      const rows = [];
      for (const key of keys) {
        const command = commands.get(key)!;
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
    async function nativeClaim(source: SourceId, externalId: string) {
      const result = await runtime.database.admin.query<{ subject_id: string }>(
        'SELECT subject_id FROM semantic.external_claim WHERE route=$1 AND source=$2 AND external_id=$3',
        [tupleRoute(runtime.identity.routeKey, source, externalId), source, externalId],
      );
      expect(result.rows).toHaveLength(1);
      return result.rows[0]!.subject_id;
    }
    async function candidates(id: string, property: string, context?: string) {
      const response = await editor.http(
        `/v1/subjects/${id}/candidates?${new URLSearchParams({ property, limit: '100', ...(context ? { context } : {}) })}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.next).toBeNull();
      return response.body.candidates as Candidate[];
    }
    async function subject(id: string, context?: string) {
      const response = await editor.http(`/v1/subjects/${id}${context ? `?context=${context}` : ''}`);
      expect(response.status).toBe(200);
      return response.body.subject as Subject;
    }
    // Exact source-local state plus every other provider's real native claims and receipts.
    async function otherSources(source: SourceId) {
      const rows = [];
      for (const other of providers.filter((s) => s !== source))
        rows.push({
          source: other,
          local: inspect(other),
          claims: await Promise.all(Array.from({ length: 5 }, (_, i) => nativeClaim(other, key(other, i)))),
          receipts: await receipts([...commands].filter(([, c]) => c.source.source === other).map(([key]) => key)),
        });
      return rows;
    }
    const initials = new Map<SourceId, Awaited<ReturnType<typeof invoke>>>();
    for (const source of providers) initials.set(source, await invoke(source, 1));
    const sources = [];
    for (const source of providers) {
      const initial = initials.get(source)!;
      const before = inspect(source),
        target = before.records[0]!;
      expect(before.source.count).toBe(5);
      const returnedExternalId = target.state.baseline!.recordKey;
      const originalSubjectId = await nativeClaim(source, returnedExternalId);
      expect(target.claim).toEqual({ state: 'bound', subject: originalSubjectId });
      expect(target.bootstrap).not.toBeNull();
      const properties = [
        ...new Set(
          target.candidates
            .map((c) => (JSON.parse(c.bytes) as BatchWriteRequest).commands[0]!)
            .filter((c) => c.op === 'propose')
            .map((c) => c.statement.property.id),
        ),
      ];
      expect(properties.length).toBeGreaterThan(0);
      const originalCandidates = (await Promise.all(properties.map((p) => candidates(originalSubjectId, p)))).flat();
      expect(originalCandidates.length).toBeGreaterThan(0);
      const originalKeys = initial.exchanges.flatMap((e) => e.body.commands.map((c) => c.key));
      const originalReceiptsBefore = await receipts(originalKeys);
      const otherSourceStateBefore = await otherSources(source);

      // An independent editor owns this candidate and Context selection, even though its reference cites a source.
      const contextReply = await editor.http('/v1/contexts', { labels: { en: `Independent ${source} catalogue` } });
      expect(contextReply.status).toBe(201);
      const context = (contextReply.body.context as { id: string }).id;
      const sourceTitle = originalCandidates.find((c) => c.statement.property.id === 'schema:name')!;
      expect(sourceTitle).toBeDefined();
      const proposed = await editor.http(`/v1/subjects/${originalSubjectId}/candidates`, {
        statement: {
          property: { id: 'schema:name' },
          value: { type: 'value', content: { language: 'en', text: `Independent ${source} editor title` } },
          references: sourceTitle.statement.references.map((reference) => ({
            parts: reference.parts.map((part) => ({ property: { id: part.property.id }, value: part.value })),
          })),
        },
      });
      expect(proposed.status).toBe(201);
      const independentId = proposed.body.candidate as string;
      expect(
        (
          await editor.http(`/v1/subjects/${originalSubjectId}/candidates/${independentId}:accept`, {
            context,
            expected_head: null,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await editor.http(`/v1/subjects/${originalSubjectId}:adopt`, {
            context,
            property: 'schema:name',
            mode: 'replace',
            selection: [{ candidate: independentId, rank: 'normal' }],
            expected_head: null,
          })
        ).status,
      ).toBe(200);
      const independentSelectionBefore = (await subject(originalSubjectId, context)).statements;
      expect(independentSelectionBefore['schema:name']?.[0]?.id).toBe(independentId);

      const removed = await invoke(source, 1, true);
      const afterRemoval = inspect(source);
      const removalKeys = removed.exchanges.flatMap((e) =>
        e.body.commands.map((c) => {
          expect(c.op).toBe('retract');
          expect(c.source.external_id).toBe(returnedExternalId);
          return c.key;
        }),
      );
      const removalReceipts = await receipts(removalKeys);
      expect(afterRemoval.records[0]!.state.baseline?.state).toBe('vanished');
      expect(afterRemoval.records[0]!.candidates).toEqual([]);
      let oldOwnedCandidates = (await Promise.all(properties.map((p) => candidates(originalSubjectId, p))))
        .flat()
        .filter((c) => originalCandidates.some((old) => old.id === c.id));
      expect(oldOwnedCandidates).toHaveLength(originalCandidates.length);
      for (const old of originalCandidates) {
        const observed = oldOwnedCandidates.find((c) => c.id === old.id)!;
        expect(observed.statement).toEqual(old.statement);
        expect(observed.revision).toBe(old.revision);
        expect(observed.retracted).not.toBeNull();
      }
      const returned = await invoke(source, 2);
      const afterReturn = inspect(source);
      oldOwnedCandidates = (await Promise.all(properties.map((p) => candidates(originalSubjectId, p))))
        .flat()
        .filter((c) => originalCandidates.some((old) => old.id === c.id));
      expect(oldOwnedCandidates).toHaveLength(originalCandidates.length);
      for (const candidate of oldOwnedCandidates) expect(candidate.retracted).not.toBeNull();
      const returnedSubjectId = await nativeClaim(source, returnedExternalId);
      const returnedRow = afterReturn.records[0]!.state.baseline!;
      expect(returnedRow.digest).not.toBe(target.state.baseline!.digest);
      expect(returnedRow.recordRevision).toBe(source === 'bangumi' ? 'unversioned' : '8');
      const newNativeProposals = (await Promise.all(properties.map((p) => candidates(returnedSubjectId, p))))
        .flat()
        .filter(
          (c): c is Candidate & { source: NonNullable<Candidate['source']> } =>
            c.source !== null && !originalCandidates.some((old) => old.id === c.id),
        );
      expect(newNativeProposals.length).toBeGreaterThan(0);
      for (const candidate of newNativeProposals) {
        expect(candidate.retracted).toBeNull();
        expect(candidate.source).toMatchObject({
          source,
          external_id: returnedExternalId,
          record_revision: returnedRow.recordRevision,
          digest: returnedRow.digest,
          converter_revision: returnedRow.converter_revision,
          field_group: 'facts',
        });
      }
      expect(
        newNativeProposals.find((c) => c.statement.property.id === 'schema:name')?.statement.value.content,
      ).toEqual({
        language: source === 'bangumi' || source === 'openlibrary' ? 'und' : 'en',
        text: title(source, 0, 2),
      });
      expect(returned.exchanges.flatMap((e) => e.body.commands).some((c) => c.op === 'create')).toBe(false);
      const removedAgain = await invoke(source, 2, true);
      const absentAgain = inspect(source);
      expect(absentAgain.records[0]!.state.baseline?.state).toBe('vanished');
      const fence = await editor.http('/v1/sourceFences:takedown', {
        source,
        externalId: returnedExternalId,
        fieldGroup: 'facts',
        reason: 'Synthetic rights complaint while absent',
      });
      expect(fence.status, JSON.stringify(fence.body)).toBe(200);
      const fencedReturn = await invoke(source, 3);
      const fenced = inspect(source);
      const fencedFactsWrites = fencedReturn.exchanges
        .flatMap((e) => e.body.commands)
        .filter(
          (c) =>
            c.source.source === source &&
            c.source.external_id === returnedExternalId &&
            c.source.field_group === 'facts',
        );
      const disclosedFencedFacts = (await Promise.all(properties.map((p) => candidates(originalSubjectId, p))))
        .flat()
        .filter(
          (c) =>
            c.source?.source === source &&
            c.source.external_id === returnedExternalId &&
            c.source.field_group === 'facts',
        );
      // Public receipt replays also recheck today's fence instead of revealing old source results.
      const replays = [];
      for (const exchange of [...initial.exchanges, ...returned.exchanges].filter((e) =>
        e.body.commands.some((c) => c.source.external_id === returnedExternalId),
      )) {
        const response = await runtime.replay(exchange.request.clone());
        const bytes = await response.text();
        expect(response.status).toBe(200);
        const replay = JSON.parse(bytes) as BatchWriteResult;
        expect(replay.results).toHaveLength(exchange.body.commands.length);
        for (const result of replay.results) {
          expect(result).toMatchObject({ status: 409, problem: { code: 'fenced', effect_status: 'not_applied' } });
          expect('value' in result).toBe(false);
        }
        expect(bytes).not.toContain(originalSubjectId);
        for (const candidate of [...originalCandidates, ...newNativeProposals])
          expect(bytes).not.toContain(candidate.id);
        replays.push({ status: response.status, body: JSON.parse(bytes) });
      }
      const unchanged = await invoke(source, 3);
      const final = inspect(source);
      expect(final.source).toEqual(fenced.source);
      expect(final.records).toEqual(fenced.records);
      expect(final.records[0]!.claim).toEqual(target.claim);
      expect(await nativeClaim(source, returnedExternalId)).toBe(originalSubjectId);
      expect((await subject(originalSubjectId)).id).toBe(originalSubjectId);
      const independentSelectionAfter = (await subject(originalSubjectId, context)).statements;
      const independent = (await candidates(originalSubjectId, 'schema:name', context)).find(
        (c) => c.id === independentId,
      )!;
      expect(independent.source).toBeNull();
      expect(independent.retracted).toBeNull();
      // Every original native receipt remains byte-identical, including all five bootstraps.
      const originalReceiptsAfter = await receipts(originalKeys);
      for (let i = 0; i < 5; i++) {
        expect(final.records[i]!.claim).toEqual(before.records[i]!.claim);
        expect(final.records[i]!.bootstrap).toEqual(before.records[i]!.bootstrap);
        if (i > 0) expect(final.records[i]).toEqual(before.records[i]);
      }
      sources.push({
        source: target.state.baseline!.source,
        initial,
        removed,
        returned,
        removedAgain,
        fencedReturn,
        unchanged,
        counts: [before, afterRemoval, afterReturn, absentAgain, fenced].map((s) => s.source.count),
        returnedExternalId,
        originalSubjectId,
        returnedSubjectId,
        bootstrapBefore: target.bootstrap,
        bootstrapAfter: final.records[0]!.bootstrap,
        originalReceiptsBefore,
        originalReceiptsAfter,
        removalReceipts,
        oldOwnedCandidates,
        newNativeProposals,
        fencedFactsWrites,
        disclosedFencedFacts,
        fence,
        replays,
        independentSelectionBefore,
        independentSelectionAfter,
        otherSourceStateBefore,
        otherSourceStateAfter: await otherSources(source),
        unchangedWrites: unchanged.exchanges,
      });
      console.log(
        'CLI source reappearance evidence',
        JSON.stringify({
          source,
          bundle: bundledRelease.catalogue,
          bundleDigest: bundledDigest,
          coordinator: returned.coordinator,
          original: target.state.baseline,
          returned: returnedRow,
          fenced: final.records[0]!.state.baseline,
          subject: originalSubjectId,
          bootstrap: target.bootstrap,
          originalReceipts: originalReceiptsAfter,
          removalReceipts,
          returnedCandidates: newNativeProposals.map((c) => ({ id: c.id, source: c.source })),
          fence,
        }),
      );
    }
    expect(authExchanges.filter((e) => e.path === '/signin/key')).toHaveLength(24);
    expect(authExchanges.filter((e) => e.path === '/token')).toHaveLength(24);
    return { sources, authExchanges, close };
  } catch (error) {
    await close();
    throw error;
  }
}
