import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import type { Statement, Subject } from '../../../../specs/semantic-driver.ts';
import { runImportCli } from '../../../importer/src/cli.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';

type Candidate = {
  id: string;
  statement: Statement;
  source: BatchCommand['source'] | null;
  retracted: number | null;
};
type Exchange = { bytes: string; body: BatchWriteRequest; result: BatchWriteResult };
const owner = { source: 'bangumi', external_id: '940001' };
const properties = ['schema:name', 'wdt:P5732'];

/** One ordinary CLI/Auth/public API world; SQL below observes exact native keys only. */
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
    directory = await mkdtemp('/dev/shm/import-source-provenance-');
    const state = join(directory, 'state.sqlite');
    await writeFile(state, '', { mode: 0o600 });
    const support = identitySupport(runtime.identity);
    await support.renewManagement();
    const kid = randomUUID();
    const pair = await generateKeyPair('ES256', { extractable: true });
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
    const api = 'https://source-provenance.import.test';
    const auth = new URL(runtime.identity.auth.verifier.jwksUrl).origin;
    const exchanges: Exchange[] = [];
    const commands = new Map<string, BatchCommand>();
    const authExchanges: { path: string; status: number }[] = [];

    async function invoke(date: string) {
      const offset = exchanges.length;
      let acquired = false;
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
        ],
        {
          stdin: (async function* () {
            // Only an admitted native date changes; there is no native revision, media or private input.
            yield new TextEncoder().encode(JSON.stringify({ id: 940001, type: 1, name: 'Same Book', date }) + '\n');
            acquired = true;
          })(),
          observer: {
            onCoordinator({ registration, converterModule, decoderModule }) {
              expect(registration.source).toBe('bangumi');
              expect(registration.converter_revision).toBe('bangumi@3');
              expect(registration.converter_revision).toBe(createSourceRegistration('bangumi').converter_revision);
              expect(converterModule).toContain('bangumi');
              expect(decoderModule).toContain('dumps.ts');
            },
            onAccountKey(_path, observation) {
              expect(observation.regularFile).toBe(true);
              expect(observation.mode & 0o777).toBe(0o600);
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
            const bytes = await request.clone().text();
            const body = JSON.parse(bytes) as BatchWriteRequest;
            for (const command of body.commands) {
              expect(command.source).toMatchObject({
                ...owner,
                field_group: 'facts',
                record_revision: 'unversioned',
                converter_revision: 'bangumi@3',
              });
              expect('rights' in command).toBe(false);
              const previous = commands.get(command.key);
              if (previous) expect(command).toEqual(previous);
              commands.set(command.key, command);
            }
            const response = await runtime.replay(request);
            const responseBytes = await response.clone().text();
            expect(response.status, responseBytes).toBe(200);
            const parsed = JSON.parse(responseBytes) as BatchWriteResult;
            expect(parsed.results).toHaveLength(body.commands.length);
            expect(parsed.results.every((entry) => entry.status < 300 && 'value' in entry)).toBe(true);
            exchanges.push({ bytes, body, result: parsed });
            return response;
          }) as typeof fetch,
        },
      );
      expect(result.code, JSON.stringify(result)).toBe(0);
      expect(result.openHandles).toBe(0);
      expect(acquired).toBe(true);
      return { ...result, exchanges: exchanges.slice(offset) };
    }
    function inspect() {
      const session = new ImportSession(state);
      try {
        expect(session.store.activeRun('bangumi')).toBeNull();
        const bootstrap = [...commands.values()].find((command) => command.op === 'create');
        expect(bootstrap).toBeDefined();
        return {
          source: session.store.source('bangumi'),
          row: session.store.key('bangumi', owner.external_id).baseline!,
          claim: session.bindings.claim(owner),
          bootstrap: session.bindings.journal(owner, bootstrap!.key),
          candidates: session.bindings.candidates(owner, 'facts', { limit: 100 }),
        };
      } finally {
        session.close();
      }
    }
    async function nativeClaim() {
      const result = await runtime.database.admin.query<{ subject_id: string }>(
        'SELECT subject_id FROM semantic.external_claim WHERE route=$1 AND source=$2 AND external_id=$3',
        [tupleRoute(runtime.identity.routeKey, owner.source, owner.external_id), owner.source, owner.external_id],
      );
      expect(result.rows).toHaveLength(1);
      return result.rows[0]!.subject_id;
    }
    async function receipts(keys: string[]) {
      const rows = [];
      for (const key of keys) {
        const command = commands.get(key)!;
        const route =
          command.op === 'create'
            ? tupleRoute(runtime.identity.routeKey, owner.source, owner.external_id)
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
    async function candidates(subject: string, property: string, context?: string) {
      const response = await editor.http(
        `/v1/subjects/${subject}/candidates?${new URLSearchParams({ property, limit: '100', ...(context ? { context } : {}) })}`,
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

    const initial = await invoke('2000-01-01');
    const before = inspect();
    expect(before.source.count).toBe(1);
    expect(before.bootstrap).not.toBeNull();
    const subjectBefore = await nativeClaim();
    expect(before.claim).toEqual({ state: 'bound', subject: subjectBefore });
    expect((await subject(subjectBefore)).type).toBe('schema:Book');
    const original = (await Promise.all(properties.map((property) => candidates(subjectBefore, property)))).flat();
    expect(original).toHaveLength(2);
    const originalKeys = [...commands.keys()];
    const originalReceiptsBefore = await receipts(originalKeys);
    const originalBodies = structuredClone(initial.exchanges);
    const oldJournals = before.candidates.map((candidate) => ({ key: candidate.key, bytes: candidate.bytes }));
    const contextReply = await editor.http('/v1/contexts', { labels: { en: 'Independent source refresh catalogue' } });
    expect(contextReply.status).toBe(201);
    const context = (contextReply.body.context as { id: string }).id;
    const sourceTitle = original.find((candidate) => candidate.statement.property.id === 'schema:name')!;
    const proposed = await editor.http(`/v1/subjects/${subjectBefore}/candidates`, {
      statement: {
        property: { id: 'schema:name' },
        value: { type: 'value', content: { language: 'en', text: 'Independent editor title' } },
        references: sourceTitle.statement.references.map((reference) => ({
          parts: reference.parts.map((part) => ({ property: { id: part.property.id }, value: part.value })),
        })),
      },
    });
    expect(proposed.status).toBe(201);
    const independentId = proposed.body.candidate as string;
    expect(
      (
        await editor.http(`/v1/subjects/${subjectBefore}/candidates/${independentId}:accept`, {
          context,
          expected_head: null,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await editor.http(`/v1/subjects/${subjectBefore}:adopt`, {
          context,
          property: 'schema:name',
          mode: 'replace',
          selection: [{ candidate: independentId, rank: 'normal' }],
          expected_head: null,
        })
      ).status,
    ).toBe(200);
    const independentSelectionBefore = (await subject(subjectBefore, context)).statements;
    expect(independentSelectionBefore['schema:name']?.[0]?.id).toBe(independentId);

    const changed = await invoke('2001-01-01');
    const after = inspect();
    const subjectAfter = await nativeClaim();
    expect(after.source.count).toBe(1);
    expect(after.claim).toEqual(before.claim);
    expect(after.candidates).toHaveLength(2);
    const changedCommands = changed.exchanges.flatMap((exchange) => exchange.body.commands);
    expect(changedCommands.filter((command) => command.op === 'create')).toEqual([]);
    expect(
      changedCommands
        .filter((command) => command.op === 'retract')
        .map((command) => command.candidate)
        .sort(),
    ).toEqual(original.map((candidate) => candidate.id).sort());
    const allFacts = (await Promise.all(properties.map((property) => candidates(subjectAfter, property)))).flat();
    const oldOwnedFacts = allFacts.filter((candidate) => original.some((old) => old.id === candidate.id));
    expect(oldOwnedFacts).toHaveLength(2);
    for (const old of oldOwnedFacts) {
      const originalCandidate = original.find((candidate) => candidate.id === old.id)!;
      expect(old.statement).toEqual(originalCandidate.statement);
      expect(old.source).toEqual(originalCandidate.source);
    }
    const freshFacts = allFacts
      .filter((candidate) => candidate.source !== null && !original.some((old) => old.id === candidate.id))
      .map((candidate) => ({ ...candidate, digest: candidate.source!.digest }));
    expect(freshFacts).toHaveLength(2);
    for (const fresh of freshFacts) {
      expect(fresh.retracted).toBeNull();
      expect(fresh.source).toMatchObject({
        ...owner,
        field_group: 'facts',
        digest: after.row.digest,
        record_revision: 'unversioned',
        converter_revision: 'bangumi@3',
      });
      const old = original.find((candidate) => candidate.statement.property.id === fresh.statement.property.id)!;
      expect(fresh.statement.property).toEqual(old.statement.property);
      expect(fresh.statement.value).toEqual(old.statement.value);
      expect(fresh.statement.references).toEqual(old.statement.references);
      expect(fresh.statement.qualifiers).toEqual(old.statement.qualifiers);
      expect(fresh.statement.rank).toEqual(old.statement.rank);
      expect(JSON.stringify(fresh.statement.references)).toContain('https://bgm.tv/subject/940001');
    }
    const newDateSlots = await candidates(subjectAfter, 'schema:datePublished');
    const originalReceiptsAfter = await receipts(originalKeys);
    expect(initial.exchanges).toEqual(originalBodies);
    const reopened = new ImportSession(state);
    try {
      for (const old of oldJournals) expect(reopened.bindings.journal(owner, old.key)?.bytes).toBe(old.bytes);
    } finally {
      reopened.close();
    }

    const unchanged = await invoke('2001-01-01');
    expect(inspect()).toEqual(after);
    const fence = await editor.http('/v1/sourceFences:takedown', {
      source: owner.source,
      externalId: owner.external_id,
      fieldGroup: 'facts',
      reason: 'Synthetic source-only rights complaint',
    });
    expect(fence.status, JSON.stringify(fence.body)).toBe(200);
    const fenced = await invoke('2002-01-01');
    const final = inspect();
    expect(final.source.count).toBe(1);
    expect(final.row.digest).not.toBe(after.row.digest);
    expect(await nativeClaim()).toBe(subjectBefore);
    expect(final.claim).toEqual(before.claim);
    const disclosedFencedFacts = (await Promise.all(properties.map((property) => candidates(subjectAfter, property))))
      .flat()
      .filter(
        (candidate) => candidate.source?.source === owner.source && candidate.source.external_id === owner.external_id,
      );
    const independentSelectionAfter = (await subject(subjectAfter, context)).statements;
    const independent = (await candidates(subjectAfter, 'schema:name', context)).find(
      (candidate) => candidate.id === independentId,
    )!;
    expect(independent.source).toBeNull();
    expect(independent.retracted).toBeNull();
    expect(authExchanges.filter((exchange) => exchange.path === '/signin/key')).toHaveLength(4);
    expect(authExchanges.filter((exchange) => exchange.path === '/token')).toHaveLength(4);
    expect([...commands.values()].filter((command) => command.op === 'create')).toHaveLength(1);
    console.log(
      'Source-only provenance evidence',
      JSON.stringify({
        before: before.row,
        after: after.row,
        fenced: final.row,
        subjectBefore,
        subjectAfter,
        oldOwnedFacts,
        freshFacts,
        originalReceiptsBefore,
        originalReceiptsAfter,
        bootstrap: final.bootstrap,
        fence,
        authExchanges,
      }),
    );
    return {
      initial,
      changed,
      unchanged,
      fenced,
      subjectBefore,
      subjectAfter,
      digestBefore: before.row.digest,
      digestAfter: after.row.digest,
      recordRevision: after.row.recordRevision,
      converterRevision: after.row.converter_revision,
      freshFacts,
      oldOwnedFacts,
      newDateSlots,
      originalReceiptsBefore,
      originalReceiptsAfter,
      bootstrapBefore: before.bootstrap,
      bootstrapAfter: final.bootstrap,
      independentSelectionBefore,
      independentSelectionAfter,
      unchangedWrites: unchanged.exchanges,
      fencedFactWrites: fenced.exchanges
        .flatMap((exchange) => exchange.body.commands)
        .filter((command) => command.source.field_group === 'facts'),
      disclosedFencedFacts,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
