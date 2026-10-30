import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { BatchCommand, BatchStatement, BatchWriteResult, Source } from '@rezics/definitions/bulk';
import { runImportCli } from '../../../importer/src/cli.ts';
import { IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';

type Candidate = {
  id: string;
  statement: BatchStatement & { id: string };
  source: Source | null;
  retracted: number | null;
};
type Exchange = { method: string; path: string; bytes: string; status: number; response: string };
const target = '71001';
const marker = 'PRIVATE_BANGUMI_SCOPE_TRANSITION_SENTINEL';
// Synthetic metadata-only native envelopes, not observations of live provider records.
const records = [
  { id: Number(target), type: 1, name: 'The Cartographer’s Book' },
  { id: 71002, type: 2, name: 'The Observatory Animation' },
  { id: 71004, type: 4, name: 'The Atlas Game' },
  { id: 71003, type: 3, name: 'The Observatory Soundtrack' },
  { id: 71006, type: 6, name: 'The Cartographer Live Action' },
];

/** Input, scheduling and independent observation over one real Auth/API/worker world. */
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
    directory = await mkdtemp('/dev/shm/bangumi-scope-cli-');
    const state = join(directory, 'state.sqlite');
    const keyPath = join(directory, 'account.jwk');
    await writeFile(state, '', { mode: 0o600, flag: 'wx' });
    const support = identitySupport(runtime.identity);
    const editor = await openApiObserver(runtime);
    await support.renewManagement();
    const pair = await generateKeyPair('ES256', { extractable: true });
    const kid = randomUUID();
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
    const approved = await runtime.identity.auth.internal.approveCredentialEffect(effect);
    await runtime.identity.auth.internal.applyCredentialEffect({ ...effect, authorization: approved.reference });
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256' }), {
      mode: 0o600,
      flag: 'wx',
    });
    const api = 'https://bangumi-scope-cli.import.test';
    const auth = new URL(runtime.identity.auth.verifier.jwksUrl).origin;
    const argv = [
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
    ];
    const exchanges: Exchange[] = [];
    const commands = new Map<string, BatchCommand>();
    const sourceRows: ReturnType<typeof inspect>[] = [];
    const publicReads: unknown[] = [];
    const converterRevisions: string[] = [];
    const owner = (key: string) => ({ source: 'bangumi', external_id: key });

    function inspect() {
      const session = new ImportSession(state);
      try {
        const source = session.store.source('bangumi');
        const generation = session.store.database
          .query('SELECT * FROM run_generations WHERE source=? AND id=?')
          .get('bangumi', source.generation);
        const members = records.map((r) => ({
          key: String(r.id),
          row: session.store.key('bangumi', String(r.id)),
          claim: session.bindings.claim(owner(String(r.id))),
          candidates: session.bindings.candidates(owner(String(r.id)), 'facts', { limit: 100 }),
        }));
        const bootstrap = [...commands.values()]
          .filter((c) => c.op === 'create')
          .map((c) => ({
            key: c.key,
            journal: session.bindings.journal(owner(c.source.external_id), c.key),
          }));
        // All retained payload surfaces, bounded to this five-record isolated source.
        const retained = [
          'run_entries',
          'run_acknowledged',
          'run_members',
          'run_payloads',
          'run_envelopes',
          'binding_records',
          'binding_journal',
          'binding_candidates',
          'binding_media',
        ].map((table) => ({
          table,
          rows: session.store.database.query(`SELECT * FROM ${table} WHERE source=? LIMIT 100`).all('bangumi'),
        }));
        return { source, generation, members, bootstrap, retained };
      } finally {
        session.close();
      }
    }
    async function invoke(type: number, title = records[0]!.name) {
      const input = records.map((r, i) => ({
        ...r,
        ...(i === 0 ? { type, name: title } : {}),
        ...((i === 0 && (type === 3 || type === 6)) || r.type === 3 || r.type === 6
          ? {
              // Invalid supported-field shapes must be discarded before validation.
              name: { private: marker },
              summary: { private: marker },
              images: { large: `http://127.0.0.1/${marker}` },
              tags: { private: marker },
            }
          : {}),
        user_posts: [{ text: marker }],
        reviews: { private: marker },
      }));
      const bytes = new TextEncoder().encode(input.map((r) => JSON.stringify(r)).join('\n') + '\n');
      const offset = exchanges.length;
      let consumed = 0;
      let sealed = false;
      const result = await runImportCli(argv, {
        stdin: (async function* () {
          for (let start = 0; start < bytes.length; start += 127) {
            const chunk = bytes.slice(start, start + 127);
            consumed += chunk.length;
            yield chunk;
          }
        })(),
        observer: {
          onAccountKey(path, observed) {
            expect(path).toBe(keyPath);
            expect(observed.regularFile).toBe(true);
            expect(observed.mode & 0o777).toBe(0o600);
          },
          onCoordinator({ importer, registration, converterModule, decoderModule }) {
            converterRevisions.push(registration.converter_revision);
            expect(registration.source).toBe('bangumi');
            expect(converterModule).toBe(import.meta.resolve('../../../../packages/conversion/src/bangumi.ts'));
            expect(decoderModule).toBe(import.meta.resolve('../../../importer/src/dumps.ts'));
            const store = importer.session.store;
            const seal = store.seal.bind(store);
            store.seal = (run, request) => {
              const result = seal(run, request);
              if (request.complete && result.status === 'ready') {
                expect(consumed).toBe(bytes.length);
                sealed = true;
              }
              return result;
            };
          },
        },
        fetch: (async (value: Request | string | URL, init?: RequestInit) => {
          const request = value instanceof Request ? value : new Request(value, init);
          const url = new URL(request.url);
          expect(sealed).toBe(true);
          if (url.origin === auth) return support.host.service.handler(request);
          expect(url.origin).toBe(api);
          expect(request.headers.has('cookie')).toBe(false);
          const claims = decodeJwt(request.headers.get('authorization')!.slice(7));
          expect(claims.sub).toBe(runtime.identity.bulk.accountId);
          expect(claims.client_id).toBe(runtime.identity.client.clientId);
          expect(String(claims.scope).split(' ').sort()).toEqual([...IMPORTER_SCOPES].sort());
          const body = request.method === 'GET' ? '' : await request.clone().text();
          expect(body).not.toContain(marker);
          if (url.pathname === '/v1/subjects:batchWrite') {
            expect(Buffer.byteLength(body)).toBeLessThanOrEqual(65536);
            for (const command of (JSON.parse(body) as { commands: BatchCommand[] }).commands) {
              if (commands.has(command.key)) expect(command).toEqual(commands.get(command.key));
              commands.set(command.key, command);
            }
          }
          const response = await runtime.replay(request);
          exchanges.push({
            method: request.method,
            path: url.pathname,
            bytes: body,
            status: response.status,
            response: await response.clone().text(),
          });
          return response;
        }) as typeof fetch,
      });
      expect(result.code, JSON.stringify(result)).toBe(0);
      expect(result.openHandles).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.stringify(result)).not.toContain('Bearer ');
      expect(JSON.stringify(result)).not.toContain('"d":');
      const observed = inspect();
      for (const member of observed.members) {
        expect(member.row.baseline?.state).toBe('present');
        expect(member.row.acknowledged).toEqual(member.row.baseline);
        expect(member.row.baseline?.converter_revision).toBe('bangumi@3');
        expect(member.row.baseline?.recordRevision).toBe('unversioned');
      }
      sourceRows.push(observed);
      const captured = exchanges.slice(offset);
      return { ...result, captured, writes: captured.filter((e) => e.method !== 'GET') };
    }
    async function receipt(command: BatchCommand) {
      const route =
        command.op === 'create'
          ? tupleRoute(runtime.identity.routeKey, command.source.source, command.source.external_id)
          : routeOf(command.subject)!;
      const result = await runtime.database.admin.query(
        `SELECT to_jsonb(r) AS receipt FROM core.receipt r WHERE partition_no=$1 AND principal_kind=$2
         AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5`,
        [partitionOf(route), 'account', runtime.identity.bulk.accountId, `subject.batch_${command.op}`, command.key],
      );
      expect(result.rows).toHaveLength(1);
      return result.rows[0];
    }
    async function candidates(id: string, property: string, context = GLOBAL_CONTEXT) {
      const response = await editor.http(
        `/v1/subjects/${id}/candidates?${new URLSearchParams({ property, context, limit: '100' })}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.next).toBeNull();
      publicReads.push(response.body);
      return response.body.candidates as unknown as Candidate[];
    }
    async function publicSelection(id: string, context: string) {
      const links = linkProjection(runtime.database.pool);
      let caughtUp = false;
      for (let batch = 0; batch < 16; batch++) {
        const result = await links.run(partitionOf(routeOf(id)!));
        expect(result.status).not.toBe('stopped');
        if (result.status === 'read' && result.envelopes === 0) {
          caughtUp = true;
          break;
        }
        if (result.status === 'busy') await Bun.sleep(5);
      }
      expect(caughtUp).toBe(true);
      const response = await runtime.request(`/v1/subjects/${id}?context=${context}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { subject: { statements: Record<string, unknown[]> } };
      publicReads.push(body);
      return body.subject.statements['schema:name'];
    }
    async function nativeIdentities() {
      return Promise.all(
        records.map(async (r) => {
          const rows = await runtime.database.admin.query(
            'SELECT subject_id,recorded_transaction_id FROM semantic.external_claim WHERE route=$1 AND source=$2 AND external_id=$3',
            [tupleRoute(runtime.identity.routeKey, 'bangumi', String(r.id)), 'bangumi', String(r.id)],
          );
          return { key: String(r.id), rows: rows.rows };
        }),
      );
    }

    const initial = await invoke(1);
    const initialState = sourceRows[0]!;
    const claim = initialState.members[0]!.claim;
    if (claim?.state !== 'bound') throw new Error('CLI did not bind the Book');
    const id = claim.subject;
    const subjectIdsBefore = await nativeIdentities();
    expect(subjectIdsBefore.filter((r) => r.rows.length)).toHaveLength(3);
    const originalCommands = [...commands.values()];
    const originalReceiptsBefore = await Promise.all(originalCommands.map(receipt));
    async function immutable() {
      const native = [];
      for (const member of initialState.members) {
        if (member.claim?.state !== 'bound') continue;
        const subject = member.claim.subject;
        const parameters = [routeOf(subject), subject];
        native.push({
          subject: (
            await runtime.database.admin.query(
              'SELECT subject_id,type,recorded_transaction_id FROM semantic.subject WHERE route=$1 AND subject_id=$2',
              parameters,
            )
          ).rows,
          terms: (
            await runtime.database.admin.query(
              "SELECT * FROM semantic.fact WHERE route=$1 AND subject_id=$2 AND kind IN ('label','description','alias') ORDER BY slot_id,log_seq LIMIT 100",
              parameters,
            )
          ).rows,
          create: (
            await runtime.database.admin.query(
              "SELECT * FROM semantic.revision WHERE route=$1 AND subject_id=$2 AND revision=1 AND kind='create'",
              parameters,
            )
          ).rows,
          candidates: (
            await runtime.database.admin.query(
              'SELECT * FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=ANY($3::uuid[]) ORDER BY candidate_id',
              [...parameters, member.candidates.map((c) => c.candidate)],
            )
          ).rows,
        });
      }
      return { journal: inspect().bootstrap, native };
    }
    const bootstrapBefore = await immutable();
    const oldOwned = initialState.members[0]!.candidates;
    const oldCandidateIds = oldOwned.map((c) => c.candidate);
    expect(oldCandidateIds).toHaveLength(2);
    const oldNative = [...(await candidates(id, 'schema:name')), ...(await candidates(id, 'wdt:P5732'))];
    expect(oldNative.map((c) => c.id).sort()).toEqual([...oldCandidateIds].sort());

    const created = await editor.http('/v1/contexts', { labels: { en: 'Independent Book review' } });
    expect(created.status).toBe(201);
    const context = (created.body.context as { id: string }).id;
    const independent = await editor.http(`/v1/subjects/${id}/candidates`, {
      statement: {
        property: { id: 'schema:name' },
        value: { type: 'value', content: { language: 'en', text: 'An independent editor title' } },
        references: oldNative
          .find((c) => c.statement.property.id === 'schema:name')!
          .statement.references.map((reference) => ({
            parts: reference.parts.map((part) => ({ property: { id: part.property.id }, value: part.value })),
          })),
      },
    });
    expect(independent.status, JSON.stringify(independent.body)).toBe(201);
    const independentId = independent.body.candidate as string;
    expect(oldCandidateIds).not.toContain(independentId);
    expect(
      (await editor.http(`/v1/subjects/${id}/candidates/${independentId}:accept`, { context, expected_head: null }))
        .status,
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
    const independentSelectionBefore = await publicSelection(id, context);
    expect(independentSelectionBefore).toHaveLength(1);

    const music = await invoke(3);
    const firstIgnoredCommands = music.writes.flatMap((e) =>
      e.path === '/v1/subjects:batchWrite' ? (JSON.parse(e.bytes) as { commands: BatchCommand[] }).commands : [],
    );
    expect(firstIgnoredCommands).toHaveLength(oldCandidateIds.length);
    expect(
      firstIgnoredCommands.every(
        (c) => c.op === 'retract' && c.source.external_id === target && oldCandidateIds.includes(c.candidate),
      ),
    ).toBe(true);
    const retractionReceipts = await Promise.all(firstIgnoredCommands.map(receipt));
    const oldOwnedCandidates = [
      ...(await candidates(id, 'schema:name')),
      ...(await candidates(id, 'wdt:P5732')),
    ].filter((c) => oldCandidateIds.includes(c.id));
    expect(oldOwnedCandidates).toHaveLength(oldCandidateIds.length);
    const liveAction = await invoke(6);
    expect(liveAction.writes).toEqual([]);
    for (const observed of sourceRows.slice(1)) {
      expect(observed.members[0]!.claim).toEqual(claim);
      expect(observed.members[0]!.candidates).toEqual([]);
      expect(observed.members.slice(1).map((m) => m.candidates)).toEqual(
        initialState.members.slice(1).map((m) => m.candidates),
      );
      expect(observed.bootstrap).toEqual(initialState.bootstrap);
    }
    expect(await nativeIdentities()).toEqual(subjectIdsBefore);
    expect(await publicSelection(id, context)).toEqual(independentSelectionBefore);
    const ignoredBoundary = await runtime.mediaBoundary.capture();
    const returned = await invoke(1, 'The Cartographer’s Book: Revised');
    const returnedState = sourceRows[3]!;
    expect(returnedState.members[0]!.claim).toEqual(claim);
    expect(returnedState.members[0]!.row.baseline!.digest).not.toBe(initialState.members[0]!.row.baseline!.digest);
    const returnedCandidateIds = returnedState.members[0]!.candidates.map((c) => c.candidate);
    const returnedProposals = [...(await candidates(id, 'schema:name')), ...(await candidates(id, 'wdt:P5732'))].filter(
      (c) => returnedCandidateIds.includes(c.id),
    );
    expect(returnedProposals).toHaveLength(2);
    for (const candidate of returnedProposals) {
      expect(candidate.source).toMatchObject({
        source: 'bangumi',
        external_id: target,
        record_revision: 'unversioned',
        converter_revision: 'bangumi@3',
        digest: returnedState.members[0]!.row.baseline!.digest,
        field_group: 'facts',
      });
      expect(candidate.statement.references).toContainEqual({
        parts: [
          expect.objectContaining({
            property: expect.objectContaining({ id: 'schema:url' }),
            value: { type: 'value', content: `https://bgm.tv/subject/${target}` },
          }),
        ],
      });
    }
    expect(returnedProposals.find((c) => c.statement.property.id === 'schema:name')!.statement.value).toEqual({
      type: 'value',
      content: { language: 'und', text: 'The Cartographer’s Book: Revised' },
    });
    const unchanged = await invoke(1, 'The Cartographer’s Book: Revised');
    const subjectIdsAfter = await nativeIdentities();
    const bootstrapAfter = await immutable();
    const originalReceiptsAfter = await Promise.all(originalCommands.map(receipt));
    const independentSelectionAfter = await publicSelection(id, context);
    const independentAfter = (await candidates(id, 'schema:name', context)).find((c) => c.id === independentId)!;
    expect(independentAfter.retracted).toBeNull();
    expect(
      [...(await candidates(id, 'schema:name')), ...(await candidates(id, 'wdt:P5732'))].filter((c) =>
        oldCandidateIds.includes(c.id),
      ),
    ).toEqual(oldOwnedCandidates);
    const boundary = await runtime.mediaBoundary.capture();
    expect(boundary.registrations.length).toBeGreaterThan(0);
    const ignoredExchanges = [...music.captured, ...liveAction.captured];
    const ignoredCreatesAndProposals = ignoredExchanges.flatMap((e) =>
      e.path === '/v1/subjects:batchWrite'
        ? (JSON.parse(e.bytes) as { commands: BatchCommand[] }).commands.filter(
            (c) => c.op === 'create' || c.op === 'propose',
          )
        : [],
    );
    const ignoredMediaRequests = [
      ...ignoredExchanges.filter((e) => e.path.startsWith('/v1/media')),
      ...ignoredBoundary.sourceRequests,
      ...ignoredBoundary.liveInternetRequests,
      ...ignoredBoundary.calls,
    ];
    const retainedPrivateMarkers = [
      ...sourceRows,
      ...exchanges,
      ...publicReads,
      subjectIdsAfter,
      bootstrapAfter,
      originalReceiptsAfter,
      boundary,
    ].filter((value) => JSON.stringify(value).includes(marker));
    console.log(
      JSON.stringify({
        journey: 'Bangumi CLI supported / music / live action / supported / unchanged',
        converterRevisions,
        bundleRevision: bundledRelease.catalogue,
        bundleDigest: bundledDigest,
        sourceRows,
        exchanges,
        originalReceiptsBefore,
        originalReceiptsAfter,
        retractionReceipts,
        oldOwnedCandidates,
        returnedProposals,
        independentSelectionBefore,
        independentSelectionAfter,
        media: boundary,
      }),
    );
    return {
      initial,
      music,
      liveAction,
      returned,
      unchanged,
      presentCounts: sourceRows.slice(0, 4).map((r) => r.source.count),
      skippedCounts: sourceRows.slice(0, 4).map((r) => (r.generation as { skipped: number }).skipped),
      subjectIdsBefore,
      subjectIdsAfter,
      bootstrapBefore,
      bootstrapAfter,
      originalReceiptsBefore,
      originalReceiptsAfter,
      retractionReceipts,
      oldOwnedCandidates,
      ignoredCreatesAndProposals,
      ignoredMediaRequests,
      retainedPrivateMarkers,
      returnedProposals: returnedProposals as (Candidate & { source: Source })[],
      returnedCandidateIds,
      oldCandidateIds,
      independentSelectionBefore,
      independentSelectionAfter,
      unchangedWrites: unchanged.writes,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
