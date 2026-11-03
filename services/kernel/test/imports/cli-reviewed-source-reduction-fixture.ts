import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { converter_revision as vndbRevision } from '../../../../packages/conversion/src/vndb.ts';
import { converter_revision as olRevision } from '../../../../packages/conversion/src/open-library.ts';
import { converter_revision as wdRevision } from '../../../../packages/conversion/src/wikidata.ts';
import type { Statement, Subject } from '../../../../specs/semantic-driver.ts';
import { runImportCli } from '../../../importer/src/cli.ts';
import { IMPORTER_SCOPES, VNDB_IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';

type Provider = 'vndb' | 'openlibrary' | 'wikidata';
const providers: Provider[] = ['vndb', 'openlibrary', 'wikidata'];
const revisions = { vndb: vndbRevision, openlibrary: olRevision, wikidata: wdRevision };
const titles = ['Harbor Observatory', 'Glass Orchard', 'Winter Cartographer', 'Copper Library', 'Moonlit Railway'];
const keys = (source: Provider) =>
  titles.map((_, i) =>
    source === 'vndb' ? `v${910001 + i}` : source === 'openlibrary' ? `/works/OL${910001 + i}W` : `Q${910001 + i}`,
  );

// These identities and bibliographic facts are synthetic, in the released native formats.
// No descriptions, images, reviews or inferred source permissions are supplied.
export function reviewedProviderInput(source: Provider, count: number): Uint8Array {
  const ids = keys(source).slice(0, count);
  if (source === 'vndb') {
    const members: [string, string][] = [
      [
        'vn.header',
        'id\timage\tc_image\tolang\tc_votecount\tc_rating\tc_average\tc_length\tc_lengthnum\tlength\tdevstatus\talias\tdescription\n',
      ],
      ['vn', ids.map((id, i) => `${id}\t\\N\t\\N\ten\t${20 + i}\t700\t${700 + i}\t\\N\t0\t2\t0\t\\N\t\\N\n`).join('')],
      ['vn_titles.header', 'id\tlang\tofficial\ttitle\tlatin\n'],
      ['vn_titles', ids.map((id, i) => `${id}\ten\tt\t${titles[i]}\t\\N\n`).join('')],
      ['entry_meta.header', 'id\tcreated\tlastmod\trevision\tnum_edits\tnum_users\n'],
      ['entry_meta', ids.map((id, i) => `${id}\t2020-01-01\t2026-10-25\t${7 + i}\t6\t3\n`).join('')],
    ];
    const chunks: Uint8Array[] = [];
    for (const [name, text] of members) {
      const body = new TextEncoder().encode(text);
      const header = new Uint8Array(512);
      const put = (offset: number, text: string) => header.set(new TextEncoder().encode(text), offset);
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
      chunks.push(header, body);
      if (body.length % 512) chunks.push(new Uint8Array(512 - (body.length % 512)));
    }
    chunks.push(new Uint8Array(1024));
    return Buffer.concat(chunks);
  }
  const rows = ids.map((id, i) => {
    if (source === 'openlibrary') {
      const row = {
        type: { key: '/type/work' },
        key: id,
        revision: 11 + i,
        last_modified: { value: '2026-10-25T00:00:00' },
        title: titles[i],
      };
      return [row.type.key, id, row.revision, row.last_modified.value, JSON.stringify(row)].join('\t');
    }
    return JSON.stringify({
      type: 'item',
      id,
      lastrevid: 24681012 + i,
      labels: { en: { language: 'en', value: titles[i] } },
      aliases: {},
      descriptions: {},
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
    });
  });
  return new TextEncoder().encode(rows.join('\n') + (rows.length ? '\n' : ''));
}

type Candidate = {
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

/** A single native application/Auth/worker world; the only routing seam is external fetch. */
export async function runReviewedProviderReduction() {
  // Input preflight shares these exact bytes without loading the native SQL runtime.
  const [{ openApiRuntime }, { openApiObserver }, { identitySupport }] = await Promise.all([
    import('./api-runtime.ts'),
    import('./api-observer.ts'),
    import('./identity-fixture.ts'),
  ]);
  const runtime = await openApiRuntime({
    batchRecords: 8,
    maxFields: 64,
    maxRecordBytes: 65536,
    sourceStatistics: 'vndb',
  });
  let directory: string | undefined;
  const close = async () => {
    try {
      await runtime.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    directory = await mkdtemp('/dev/shm/imports-reviewed-reduction-');
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

    async function invoke(source: Provider, count: number, threshold?: string) {
      const bytes = reviewedProviderInput(source, count);
      const offset = exchanges.length;
      const writes: { method: string; path: string; status: number; response: string }[] = [];
      const seals: unknown[] = [];
      let passes = 0,
        consumed = 0,
        eof = false,
        closed = false;
      let sealed = false;
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
          ...(threshold === undefined ? [] : ['--disappearance-threshold', threshold]),
        ],
        {
          stdin: (async function* () {
            try {
              for (let offset = 0; offset < bytes.length; offset += 127) {
                const chunk = bytes.slice(offset, offset + 127);
                consumed += chunk.length;
                yield chunk;
              }
              eof = true;
            } finally {
              closed = true;
            }
          })(),
          observer: {
            onInputPass() {
              passes++;
            },
            onAccountKey(_path, observation) {
              expect(observation.regularFile).toBe(true);
              expect(observation.mode & 0o777).toBe(0o600);
            },
            onCoordinator({ importer, registration, converterModule, decoderModule }) {
              expect(registration.source).toBe(source);
              expect(registration.converter_revision).toBe(revisions[source]);
              expect(converterModule).toBe(
                import.meta.resolve(
                  `../../../../packages/conversion/src/${source === 'openlibrary' ? 'open-library' : source}.ts`,
                ),
              );
              expect(decoderModule).toBe(
                import.meta.resolve(`../../../importer/src/${source === 'vndb' ? 'vndb-tables' : 'dumps'}.ts`),
              );
              const store = importer.session.store;
              const seal = store.seal.bind(store);
              store.seal = (run, input) => {
                expect(eof).toBe(true);
                const result = seal(run, input);
                seals.push(result);
                sealed = result.status === 'ready';
                return result;
              };
            },
          },
          fetch: (async (input: Request | string | URL, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init);
            const url = new URL(request.url);
            expect(eof).toBe(true);
            expect(sealed).toBe(true);
            if (url.origin === auth) {
              expect(['/signin/key', '/token']).toContain(url.pathname);
              return native.host.service.handler(request);
            }
            expect(url.origin).toBe(api);
            expect(request.headers.has('cookie')).toBe(false);
            const token = decodeJwt(request.headers.get('authorization')!.slice(7));
            expect(token.sub).toBe(runtime.identity.bulk.accountId);
            expect(token.client_id).toBe(runtime.identity.client.clientId);
            expect(String(token.scope).split(' ').sort()).toEqual(
              [...(source === 'vndb' ? VNDB_IMPORTER_SCOPES : IMPORTER_SCOPES)].sort(),
            );
            expect(
              url.pathname === '/v1/subjects:batchWrite' ||
                url.pathname === '/v1/sourceFences:check' ||
                url.pathname === '/v1/source-records:setMetadata' ||
                (source === 'vndb' && /^\/v1\/subjects\/[^/]+\/source-statistics\/vndb(?::clear)?$/.test(url.pathname)),
            ).toBe(true);
            const saved = request.clone();
            const bodyBytes = request.body === null ? '' : await request.clone().text();
            const response = await runtime.replay(request);
            const responseBytes = await response.clone().text();
            if (request.method !== 'GET')
              writes.push({
                method: request.method,
                path: url.pathname,
                status: response.status,
                response: responseBytes,
              });
            if (url.pathname === '/v1/subjects:batchWrite') {
              expect(Buffer.byteLength(bodyBytes)).toBeLessThanOrEqual(65536);
              const body = JSON.parse(bodyBytes) as BatchWriteRequest;
              expect(body.commands.length).toBeLessThanOrEqual(100);
              for (const command of body.commands) {
                const previous = commands.get(command.key);
                if (previous) expect(command).toEqual(previous);
                commands.set(command.key, command);
                expect(command.source.source).toBe(source);
                expect(command.source.converter_revision).toBe(revisions[source]);
                expect(command.source.digest).toMatch(/^[a-f0-9]{64}$/);
              }
              exchanges.push({
                request: saved,
                bytes: bodyBytes,
                body,
                status: response.status,
                response: responseBytes,
                result: JSON.parse(responseBytes) as BatchWriteResult,
              });
            }
            return response;
          }) as typeof fetch,
        },
      );
      expect(result.openHandles, JSON.stringify(result)).toBe(0);
      expect(passes).toBe(1);
      expect(eof).toBe(true);
      expect(closed).toBe(true);
      expect(consumed).toBe(bytes.length);
      expect(seals).toHaveLength(1);
      expect((await stat(state)).mode & 0o777).toBe(0o600);
      return { ...result, writes, seals, exchanges: exchanges.slice(offset) };
    }

    function inspect(source: Provider) {
      const session = new ImportSession(state);
      try {
        expect(session.store.activeRun(source)).toBeNull();
        const baseline = session.store.source(source);
        const sequence = session.store.database
          .query('SELECT sequence FROM run_sources WHERE source=?')
          .get(source) as { sequence: number };
        const acquisition = session.store.database
          .query(
            'SELECT status,threshold,prior,supplied,survivors,classified,resolved,prepared FROM run_generations WHERE source=? AND id=?',
          )
          .get(source, String(sequence.sequence));
        return {
          baseline: { generation: baseline.generation, records: baseline.count },
          acquisition,
          records: keys(source).map((key) => {
            const owner = { source, external_id: key };
            const bootstrap = [...commands.values()].find(
              (c) => c.op === 'create' && c.source.source === source && c.source.external_id === key,
            );
            return {
              key,
              claim: session.bindings.claim(owner),
              row: session.store.key(source, key),
              bootstrap: bootstrap ? session.bindings.journal(owner, bootstrap.key) : null,
              candidates: session.bindings.candidates(owner, 'facts', { limit: 100 }),
            };
          }),
        };
      } finally {
        session.close();
      }
    }
    async function receipts(selected: BatchCommand[]) {
      const result = [];
      for (const command of selected) {
        const route =
          command.op === 'create'
            ? tupleRoute(runtime.identity.routeKey, command.source.source, command.source.external_id)
            : routeOf(command.subject)!;
        const rows = await runtime.database.admin.query(
          'SELECT partition_no,principal_kind,principal_id,command_kind,idempotency_key,transaction_id,response FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5',
          [partitionOf(route), 'account', runtime.identity.bulk.accountId, `subject.batch_${command.op}`, command.key],
        );
        expect(rows.rows).toHaveLength(1);
        result.push(rows.rows[0]!);
      }
      return result;
    }
    async function candidates(id: string, property = 'schema:name', context?: string) {
      const response = await editor.http(
        `/v1/subjects/${id}/candidates?${new URLSearchParams({ property, limit: '100', ...(context ? { context } : {}) })}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.next).toBeNull();
      return { rows: response.body.candidates as Candidate[], adoption: response.body.adoption };
    }
    async function subject(id: string, context?: string) {
      const response = await editor.http(`/v1/subjects/${id}${context ? `?context=${context}` : ''}`);
      expect(response.status).toBe(200);
      return response.body.subject as Subject;
    }
    const initials = new Map<Provider, Awaited<ReturnType<typeof invoke>>>();
    // All three native source baselines coexist before any reduction is reviewed.
    for (const source of providers) {
      const initial = await invoke(source, 5);
      expect(initial.code, JSON.stringify({ code: initial.code, stderr: initial.stderr })).toBe(0);
      expect(initial.stdout).toBe('Import complete: new=5 changed=0 unchanged=0 vanished=0 skipped=0\n');
      for (const exchange of initial.exchanges) {
        expect(exchange.status).toBe(200);
        expect(exchange.result.results.every((entry) => entry.status < 300 && 'value' in entry)).toBe(true);
      }
      if (source === 'vndb') expect(initial.writes.filter((w) => w.method === 'PUT')).toHaveLength(5);
      initials.set(source, initial);
    }

    const sources = [];
    for (const source of providers) {
      const initial = initials.get(source)!;
      const first = inspect(source);
      expect(first.baseline.records).toBe(5);
      const ids = first.records.map((record) => {
        if (record.claim?.state !== 'bound') throw new Error('Missing actual CLI subject binding');
        expect(record.bootstrap).not.toBeNull();
        expect(record.row.baseline?.state).toBe('present');
        expect(record.row.acknowledged).toEqual(record.row.baseline);
        expect(record.row.baseline?.converter_revision).toBe(revisions[source]);
        expect(record.candidates.length).toBeGreaterThan(0);
        return record.claim.subject;
      });
      expect(new Set(ids).size).toBe(5);
      const affected = ids[3]!;
      const name = (await candidates(affected)).rows[0]!;
      expect(name.source?.external_id).toBe(keys(source)[3]);
      expect(name.retracted).toBeNull();
      const contexts: string[] = [];
      for (const label of ['Reviewed source title', 'Independent community title']) {
        const response = await editor.http('/v1/contexts', { labels: { en: `${source}: ${label}` } });
        expect(response.status).toBe(201);
        contexts.push((response.body.context as { id: string }).id);
      }
      const independent = await editor.http(`/v1/subjects/${affected}/candidates`, {
        statement: {
          property: { id: 'schema:name' },
          value: { type: 'value', content: { language: 'en', text: `Community ${source} catalogue title` } },
          references: name.statement.references.map((reference) => ({
            parts: reference.parts.map((part) => ({ property: { id: part.property.id }, value: part.value })),
          })),
        },
      });
      expect(independent.status).toBe(201);
      const independentId = independent.body.candidate as string;
      expect(independentId).not.toBe(name.id);
      for (const [index, candidate] of [name.id, independentId].entries()) {
        const context = contexts[index]!;
        const current = await candidates(affected, 'schema:name', context);
        expect(
          (
            await editor.http(`/v1/subjects/${affected}/candidates/${candidate}:accept`, {
              context,
              expected_head: null,
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await editor.http(`/v1/subjects/${affected}:adopt`, {
              context,
              property: 'schema:name',
              mode: 'replace',
              selection: [{ candidate, rank: 'normal' }],
              expected_head: (current.adoption as { head: number } | null)?.head ?? null,
            })
          ).status,
        ).toBe(200);
      }
      const community = async () =>
        Promise.all(
          contexts.map(async (context) => ({
            subject: await subject(affected, context),
            listing: await candidates(affected, 'schema:name', context),
          })),
        ).then((rows) =>
          rows.map(({ subject, listing }) => ({
            id: subject.id,
            statements: subject.statements,
            adoption: listing.adoption,
            independent: listing.rows.find((c) => c.id === independentId),
          })),
        );
      const communitySelectionBefore = await community();
      expect(communitySelectionBefore[0]!.statements['schema:name']?.[0]?.value).toEqual(name.statement.value);
      expect(communitySelectionBefore[1]!.statements['schema:name']?.[0]?.value.content).toEqual({
        language: 'en',
        text: `Community ${source} catalogue title`,
      });
      const originalCommands = initial.exchanges.flatMap((e) => e.body.commands);
      const immutable = async () => ({
        journals: inspect(source).records.map((r) => r.bootstrap),
        receipts: await receipts(originalCommands),
      });
      const originalBootstrapBefore = await immutable();
      const subjectIdsBefore = await Promise.all(ids.map(async (id) => (await subject(id)).id));
      const unrelated = async () =>
        Promise.all(
          providers
            .filter((s) => s !== source)
            .map(async (s) => {
              const state = inspect(s);
              const selected = [...commands.values()].filter((c) => c.source.source === s);
              const native = [];
              for (const record of state.records) {
                if (record.claim?.state !== 'bound') throw new Error('Unrelated native binding disappeared');
                const id = record.claim.subject;
                const properties = [
                  ...new Set(
                    selected.flatMap((c) => (c.op === 'propose' && c.subject === id ? [c.statement.property.id] : [])),
                  ),
                ].sort();
                native.push({
                  subject: await subject(id),
                  candidates: await Promise.all(properties.map((p) => candidates(id, p))),
                });
              }
              return { source: s, state, native, receipts: await receipts(selected) };
            }),
        );
      const unrelatedSourcesBefore = await unrelated();
      const nativeBefore = await Promise.all(
        ids.map(async (id, index) => {
          const properties = [
            ...new Set(
              originalCommands
                .filter((c) => c.op === 'propose' && c.subject === id)
                .map((c) => (c.op === 'propose' ? c.statement.property.id : '')),
            ),
          ].sort();
          const rows = (await Promise.all(properties.map((property) => candidates(id, property))))
            .flatMap((page) => page.rows)
            .filter((candidate) => candidate.source?.source === source);
          expect(rows.map((r) => r.id).sort()).toEqual(first.records[index]!.candidates.map((r) => r.candidate).sort());
          return { id, properties, rows };
        }),
      );
      const stopped = await invoke(source, 3);
      expect(stopped.code).toBe(3);
      expect(stopped.writes).toEqual([]);
      const afterStop = inspect(source);
      expect(afterStop).toEqual({
        ...first,
        acquisition: {
          status: 'mass-disappearance',
          threshold: 0.2,
          prior: 5,
          supplied: 3,
          survivors: 3,
          classified: 0,
          resolved: 0,
          prepared: 0,
        },
      });
      expect(await immutable()).toEqual(originalBootstrapBefore);

      const reviewed = await invoke(source, 3, '0.5');
      expect(reviewed.code, JSON.stringify({ code: reviewed.code, stderr: reviewed.stderr })).toBe(0);
      expect(reviewed.stdout).toBe('Import complete: new=0 changed=0 unchanged=3 vanished=2 skipped=0\n');
      const removed = reviewed.exchanges.flatMap((exchange) => {
        expect(exchange.status).toBe(200);
        expect(exchange.result.results.every((entry) => entry.status < 300 && 'value' in entry)).toBe(true);
        return exchange.body.commands;
      });
      const removedExternalIds = [...new Set(removed.map((c) => c.source.external_id))].sort();
      expect(removedExternalIds).toEqual(keys(source).slice(3).sort());
      expect(removed.length).toBe(first.records.slice(3).reduce((n, r) => n + r.candidates.length, 0));
      for (const command of removed) {
        if (command.op !== 'retract') throw new Error('Reviewed reduction sent a non-retraction');
        const prior = first.records.find((r) => r.key === command.source.external_id)!;
        expect(prior.candidates.some((c) => c.candidate === command.candidate && c.subject === command.subject)).toBe(
          true,
        );
        expect(command.source.digest).toBe(prior.row.baseline!.digest);
        expect(command.source.record_revision).toBe(prior.row.baseline!.recordRevision);
        expect(command.references.length).toBeGreaterThan(0);
      }
      const reduced = inspect(source);
      expect(reduced.baseline.records).toBe(3);
      expect(reduced.baseline.generation).not.toBe(first.baseline.generation);
      expect(reduced.acquisition).toMatchObject({
        status: 'complete',
        threshold: 0.5,
        prior: 5,
        supplied: 3,
        survivors: 3,
        classified: 5,
        resolved: 5,
      });
      for (const [index, record] of reduced.records.entries()) {
        expect(record.claim).toEqual(first.records[index]!.claim);
        expect(record.row.baseline?.state).toBe(index < 3 ? 'present' : 'vanished');
        expect(record.candidates).toEqual(index < 3 ? first.records[index]!.candidates : []);
        const original = nativeBefore[index]!;
        const now = (await Promise.all(original.properties.map((property) => candidates(original.id, property))))
          .flatMap((p) => p.rows)
          .filter((c) => c.source?.source === source);
        for (const old of original.rows) {
          const current = now.find((c) => c.id === old.id)!;
          expect(current.statement).toEqual(old.statement);
          expect(current.revision).toBe(old.revision);
          if (index < 3) expect(current).toEqual(old);
          else {
            expect(current.retracted).not.toBeNull();
            expect(current.retraction?.source.external_id).toBe(record.key);
            expect(current.retraction?.references.length).toBeGreaterThan(0);
          }
        }
      }
      const nativeRetractionReceipts = await receipts(removed);
      const subjectIdsAfter = await Promise.all(ids.map(async (id) => (await subject(id)).id));
      const communitySelectionAfter = await community();
      const unrelatedSourcesAfter = await unrelated();
      const originalBootstrapAfter = await immutable();
      const allReceipts = await receipts([...commands.values()]);
      const unchanged = await invoke(source, 3);
      expect(unchanged.code).toBe(0);
      expect(unchanged.writes).toEqual([]);
      expect(inspect(source)).toMatchObject({ baseline: reduced.baseline, records: reduced.records });
      const lossAll = await invoke(source, 0, '1');
      expect(lossAll.code).toBe(3);
      expect(lossAll.writes).toEqual([]);
      const final = inspect(source);
      expect(final.baseline).toEqual(reduced.baseline);
      expect(final.records).toEqual(reduced.records);
      expect(final.acquisition).toMatchObject({
        status: 'mass-disappearance',
        threshold: 1,
        prior: 3,
        supplied: 0,
        survivors: 0,
        prepared: 0,
      });

      const original = reviewed.exchanges[0]!;
      expect(await original.request.clone().text()).toBe(original.bytes);
      const replay = await runtime.replay(original.request.clone());
      expect(replay.status).toBe(200);
      expect(await replay.text()).toBe(original.response);
      await native.renewManagement();
      await runtime.identity.setBulkPermission(false);
      const denied = await runtime.replay(original.request.clone());
      const deniedBody = await denied.json();
      expect(denied.status).toBe(403);
      expect(deniedBody).not.toHaveProperty('results');
      expect(JSON.stringify(deniedBody)).not.toContain(original.response);
      for (const command of original.body.commands) {
        if (command.op !== 'retract') throw new Error('Captured replay was not a retraction');
        expect(JSON.stringify(deniedBody)).not.toContain(command.candidate);
        expect(JSON.stringify(deniedBody)).not.toContain(command.subject);
      }
      // Projection from the actual denied response; success disclosure must be absent.
      const revokedReplay = { status: denied.status, storedSuccess: deniedBody.results ?? null };
      await runtime.identity.setBulkPermission(true);
      expect(await receipts([...commands.values()])).toEqual(allReceipts);
      expect(await community()).toEqual(communitySelectionBefore);
      expect(await unrelated()).toEqual(unrelatedSourcesBefore);
      expect(await immutable()).toEqual(originalBootstrapBefore);
      sources.push({
        source,
        initial,
        initialBaseline: first.baseline,
        stopped,
        stopWrites: stopped.writes,
        baselineAfterStop: afterStop.baseline,
        reviewed,
        reviewedBaseline: reduced.baseline,
        removedExternalIds,
        nativeRetractionReceipts,
        subjectIdsBefore,
        subjectIdsAfter,
        communitySelectionBefore,
        communitySelectionAfter,
        unrelatedSourcesBefore,
        unrelatedSourcesAfter,
        originalBootstrapBefore,
        originalBootstrapAfter,
        unchanged,
        unchangedWrites: unchanged.writes,
        lossAll,
        lossAllWrites: lossAll.writes,
        baselineAfterLossAll: final.baseline,
        revokedReplay,
        openHandlesAtEnd: lossAll.openHandles,
      });
    }
    // Evidence contains only public/provenance data, never the account key or bearer.
    await writeFile(
      new URL('../../../../.temp/cli-reviewed-source-reduction.json', import.meta.url),
      JSON.stringify(
        {
          bundle: bundledDigest,
          converters: revisions,
          sources: sources.map((s) => ({
            source: s.source,
            initialBaseline: s.initialBaseline,
            reviewedBaseline: s.reviewedBaseline,
            sourceRows: inspect(s.source).records.map((r) => r.row.baseline),
            nativeRetractionReceipts: s.nativeRetractionReceipts,
          })),
        },
        null,
        2,
      ),
    );
    return { sources, close };
  } catch (error) {
    await close();
    throw error;
  }
}
