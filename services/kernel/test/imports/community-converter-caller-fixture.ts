import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import type { ConversionInput, SourceId } from '../../../../packages/conversion/src/index.ts';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult, Source } from '@rezics/definitions/bulk';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { publicBulkRecord } from '../../../../packages/conversion/examples/public-bulk.ts';
import { createAccountTokenProvider, IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { createImportTransport } from '../../../importer/src/import-client.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { processImportedMedia } from '../../src/content/media-import-job.ts';
import { processImage } from '../../src/content/image-job.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import type { Item, Statement } from '../../src/semantic/item.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';
import bangumi from '../../../../specs/fixtures/imports/bangumi/subject.json';
import vndb from '../../../../specs/fixtures/imports/vndb/record.json';
import work from '../../../../specs/fixtures/imports/open-library/work.json';
import entity from '../../../../specs/fixtures/imports/wikidata/entity.json';

type Candidate = {
  id: string;
  statement: Statement;
  source: Source | null;
  revision: number;
  retracted: number | null;
};
type Exchange = { path: string; bytes: string; status: number; response: string };
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

// Acquisition is complete before opening the application. These explicit metadata projections omit media,
// prose and statistics; absent vote fields are not rewritten into invented zero-vote evidence.
const feeds: { source: SourceId; input: ConversionInput; citation: string }[] = [
  {
    source: 'bangumi',
    input: {
      external_id: String(bangumi.id),
      record_revision: null,
      record: { id: bangumi.id, type: bangumi.type, name: bangumi.name, name_cn: bangumi.name_cn },
    },
    citation: `https://bgm.tv/subject/${bangumi.id}`,
  },
  {
    source: 'vndb',
    input: {
      external_id: vndb.vn.id,
      record_revision: String(vndb.entry_meta.revision),
      record: {
        vn: { id: vndb.vn.id, olang: vndb.vn.olang },
        entry_meta: vndb.entry_meta,
        vn_titles: vndb.vn_titles,
        vn_extlinks: vndb.vn_extlinks,
        extlinks: vndb.extlinks,
      },
    },
    citation: `https://vndb.org/${vndb.vn.id}`,
  },
  {
    source: 'openlibrary',
    input: {
      external_id: work.key,
      record_revision: String(work.revision),
      record: {
        type: work.type,
        key: work.key,
        revision: work.revision,
        last_modified: work.last_modified,
        title: work.title,
      },
    },
    citation: `https://openlibrary.org${work.key}`,
  },
  {
    source: 'wikidata',
    input: {
      external_id: entity.id,
      record_revision: String(entity.lastrevid),
      record: {
        id: entity.id,
        type: entity.type,
        lastrevid: entity.lastrevid,
        labels: entity.labels,
        aliases: entity.aliases,
        descriptions: entity.descriptions,
        claims: { P31: entity.claims.P31, P577: entity.claims.P577, P856: entity.claims.P856 },
      },
    },
    citation: `https://www.wikidata.org/wiki/${entity.id}?oldid=${entity.lastrevid}`,
  },
];

export async function runJourney() {
  // The reused runtime owns the only application/Auth/registered-worker world, including its tmpfs SQLite.
  const previous = process.env.TMPDIR;
  const runtime = await (async () => {
    process.env.TMPDIR = '/dev/shm';
    try {
      return await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  })();
  let directory: string | undefined;
  const close = async () => {
    try {
      await runtime.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    const f = runtime.identity;
    const native = identitySupport(f);
    const editor = await openApiObserver(runtime);
    await native.renewManagement();
    directory = await mkdtemp('/dev/shm/import-community-key-');
    const keyPath = join(directory, 'account.jwk');
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
      flag: 'wx',
    });
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
    const api = 'https://kernel.import.test';
    const auth = new URL(f.auth.verifier.jwksUrl).origin;
    const exchanges: Exchange[] = [];
    const originals: Request[] = [];
    const authRequests: { path: string; status: number }[] = [];
    const publicReads: { path: string; status: number; body: unknown }[] = [];
    const boundary = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === auth) {
        const response = await native.host.service.handler(request);
        authRequests.push({ path: url.pathname, status: response.status });
        return response;
      }
      expect(url.origin).toBe(api);
      expect(url.pathname).toBe('/v1/subjects:batchWrite');
      expect(request.headers.has('cookie')).toBe(false);
      const bearer = request.headers.get('authorization')!;
      expect(bearer.startsWith('Bearer ')).toBe(true);
      expect(decodeJwt(bearer.slice(7)).sub).toBe(f.bulk.accountId);
      originals.push(request.clone());
      const bytes = await request.clone().text();
      const response = await runtime.replay(request);
      exchanges.push({ path: url.pathname, bytes, status: response.status, response: await response.clone().text() });
      return response;
    }) as typeof fetch;
    const tokenProvider = await createAccountTokenProvider({
      accountKeyPath: keyPath,
      account: f.bulk.accountId,
      client: f.client.clientId,
      authOrigin: auth,
      scopes: IMPORTER_SCOPES,
      fetch: boundary,
    });
    // This existing bounded public client is caller-owned. Neither Importer nor its CLI runs this example.
    const transport = createImportTransport({ origin: api, tokenProvider, fetch: boundary });
    async function read(path: string, body?: unknown, status = 200) {
      const response = await editor.http(path, body);
      publicReads.push({ path, status: response.status, body: response.body });
      expect(response.status, JSON.stringify(response.body)).toBe(status);
      return response.body;
    }
    async function receipts(commands: BatchCommand[]) {
      const rows = [];
      for (const command of commands) {
        const route =
          command.op === 'create'
            ? tupleRoute(f.routeKey, command.source.source, command.source.external_id)
            : routeOf(command.subject)!;
        const result = await runtime.database.admin.query(
          'SELECT partition_no,principal_kind,principal_id,command_kind,idempotency_key,transaction_id,response FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5',
          [partitionOf(route), 'account', f.bulk.accountId, `subject.batch_${command.op}`, command.key],
        );
        expect(result.rows).toHaveLength(1);
        rows.push(...result.rows);
      }
      return rows;
    }
    async function effects(id: string, source: Source) {
      const query = async (sql: string, values: unknown[]) => (await runtime.database.admin.query(sql, values)).rows;
      const route = routeOf(id)!;
      return {
        subjects: await query('SELECT * FROM semantic.subject WHERE route=$1 AND subject_id=$2', [route, id]),
        candidates: await query(
          'SELECT * FROM semantic.candidate WHERE route=$1 AND subject_id=$2 ORDER BY candidate_id LIMIT 100',
          [route, id],
        ),
        revisions: await query(
          'SELECT * FROM semantic.revision WHERE route=$1 AND subject_id=$2 ORDER BY revision LIMIT 100',
          [route, id],
        ),
        sourceCandidates: await query(
          'SELECT * FROM semantic.source_candidate WHERE route=$1 AND subject_id=$2 ORDER BY candidate_id LIMIT 100',
          [route, id],
        ),
        claims: await query('SELECT * FROM semantic.external_claim WHERE route=$1 AND source=$2 AND external_id=$3', [
          tupleRoute(f.routeKey, source.source, source.external_id),
          source.source,
          source.external_id,
        ]),
      };
    }
    const contextBody = await read('/v1/contexts', { labels: { en: 'Community converter review' } }, 201);
    const context = (contextBody.context as { id: string }).id;
    const sources = [];
    for (const feed of feeds) {
      const input = structuredClone(feed.input);
      const inputBefore = structuredClone(input);
      const start = exchanges.length;
      const submitted = await publicBulkRecord(input, feed.source, transport.batch);
      expect(submitted.outcome).toBe('submitted');
      if (submitted.outcome !== 'submitted') throw new Error('Metadata fixture unexpectedly ignored');
      const captured = exchanges.slice(start);
      expect(captured).toHaveLength(2);
      for (const e of captured) {
        expect(e.status, e.response).toBe(200);
        expect(
          (JSON.parse(e.response) as BatchWriteResult).results.every((r) => r.status === 200 || r.status === 201),
        ).toBe(true);
      }
      const commands = captured.flatMap((e) => (JSON.parse(e.bytes) as BatchWriteRequest).commands);
      const create = commands[0]!;
      expect(create.op).toBe('create');
      const result = (JSON.parse(captured[0]!.response) as BatchWriteResult).results.find((r) => r.key === create.key)!;
      if (!('value' in result) || !('id' in result.value)) throw new Error('Missing captured native create identity');
      const createdId = result.value.id;
      const boundCommands = commands.slice(1);
      expect(boundCommands.length).toBeGreaterThan(0);
      for (const c of boundCommands) {
        expect(c.op).toBe('propose');
        expect(c.subject).toBe(createdId);
        expect(c.source).toEqual(create.source);
      }
      const boundTargetId = boundCommands[0]!.subject as string;
      const before = await effects(createdId, create.source);
      expect(before.subjects).toHaveLength(1);
      expect(before.claims).toHaveLength(1);
      expect(before.claims[0]!.subject_id).toBe(createdId);
      expect(before.candidates).toHaveLength(boundCommands.length);
      expect(before.sourceCandidates).toHaveLength(boundCommands.length);
      const nativeCandidates: Candidate[] = [];
      const properties = [
        ...new Set(boundCommands.flatMap((c) => (c.op === 'propose' ? [c.statement.property.id] : []))),
      ];
      for (const property of properties) {
        const body = await read(
          `/v1/subjects/${createdId}/candidates?${new URLSearchParams({ property, context, limit: '100' })}`,
        );
        expect(body.next).toBeNull();
        nativeCandidates.push(...(body.candidates as Candidate[]));
      }
      expect(nativeCandidates).toHaveLength(before.candidates.length);
      for (const c of nativeCandidates) {
        expect(before.candidates.some((row) => row.candidate_id === c.id)).toBe(true);
        expect(c.source).toEqual(create.source);
        expect(
          c.statement.references.some((r) =>
            r.parts.some(
              (p) => p.property.id === 'schema:url' && p.value.type === 'value' && p.value.content === feed.citation,
            ),
          ),
        ).toBe(true);
      }
      const selected = nativeCandidates.find((c) => c.statement.property.id === 'schema:name')!;
      expect(selected).toBeDefined();
      await read(`/v1/subjects/${createdId}/candidates/${selected.id}:accept`, { context, expected_head: null });
      await read(`/v1/subjects/${createdId}:adopt`, {
        context,
        property: 'schema:name',
        mode: 'replace',
        selection: [{ candidate: selected.id, rank: 'normal' }],
        expected_head: null,
      });
      const links = linkProjection(runtime.database.pool);
      let drained = false;
      for (let batch = 0; batch < 16; batch++) {
        const delivered = await links.run(partitionOf(routeOf(createdId)!));
        expect(delivered.status).not.toBe('stopped');
        if (delivered.status === 'busy') {
          await Bun.sleep(5);
          continue;
        }
        if (delivered.status === 'read' && delivered.envelopes === 0) {
          drained = true;
          break;
        }
      }
      expect(drained).toBe(true);
      const nativeSubject = (await read(`/v1/subjects/${createdId}?context=${context}`)).subject as Item;
      const citedSelectedFacts = nativeSubject.statements['schema:name']!;
      expect(citedSelectedFacts.map((s) => s.id)).toEqual([selected.id]);
      expect(citedSelectedFacts[0]!.references).toEqual(selected.statement.references);
      const replayReceiptsBefore = await receipts(commands);
      const replayEffectsBefore = await effects(createdId, create.source);
      // Repeat the entire two-phase community call. The actual returned create identity binds the repeat too.
      const replayStart = exchanges.length;
      const replayed = await publicBulkRecord(input, feed.source, transport.batch);
      expect(replayed.outcome).toBe('submitted');
      const replay = exchanges.slice(replayStart);
      expect(replay).toHaveLength(2);
      expect(replay.map((e) => e.bytes)).toEqual(captured.map((e) => e.bytes));
      expect(replay.map((e) => e.response)).toEqual(captured.map((e) => e.response));
      const replayReceiptsAfter = await receipts(commands);
      const replayEffectsAfter = await effects(createdId, create.source);
      expect(replayEffectsAfter).toEqual(replayEffectsBefore);
      const duplicateEffects = Object.entries(replayEffectsAfter).flatMap(([kind, rows]) =>
        rows.filter(
          (row) =>
            !replayEffectsBefore[kind as keyof typeof replayEffectsBefore].some((old) => isDeepStrictEqual(old, row)),
        ),
      );
      sources.push({
        source: create.source.source,
        converterRevision: create.source.converter_revision,
        createdId,
        boundTargetId,
        nativeSubject,
        nativeCandidates,
        citedSelectedFacts,
        inputBefore,
        inputAfter: structuredClone(input),
        replayReceiptsBefore,
        replayReceiptsAfter,
        duplicateEffects,
        nativeRowsBefore: replayEffectsBefore,
        nativeRowsAfter: replayEffectsAfter,
        sourceDigest: create.source.digest,
        sourceRevision: create.source.record_revision,
        inputDigest: digest(JSON.stringify(inputBefore)),
      });
    }
    expect(authRequests.some((r) => r.path === '/signin/key' && r.status === 200)).toBe(true);
    expect(authRequests.some((r) => r.path === '/token' && r.status === 200)).toBe(true);
    const media = await runtime.mediaBoundary.capture();
    expect(media.registrations.map((r) => r.handler)).toContain(processImportedMedia);
    expect(media.registrations.map((r) => r.handler)).toContain(processImage);
    expect(media.calls).toEqual([]);
    expect(media.sourceRequests).toEqual([]);
    await native.renewManagement();
    await f.setBulkPermission(false);
    const original = originals[0]!;
    const denied = await boundary(original.clone());
    const deniedBody = await denied.json();
    expect(deniedBody).not.toHaveProperty('results');
    for (const s of sources) expect(JSON.stringify(deniedBody)).not.toContain(s.createdId);
    const revokedReplay = { status: denied.status, storedSuccess: deniedBody.results ?? null, body: deniedBody };
    console.log(
      'community converter caller native evidence',
      JSON.stringify({
        bundleDigest: bundledDigest,
        bundleCatalogue: bundledRelease.catalogue,
        authRequests,
        exchanges,
        publicReads,
        sources,
        revokedReplay,
        workerRegistrations: media.registrations.map((r) => ({ name: r.name, queue: r.queue })),
        workerCalls: media.calls,
        nativeGrowthEvidence: 'missing: this connected caller adds no growth series',
      }),
    );
    return { sources, revokedReplay, close };
  } catch (error) {
    await close();
    throw error;
  }
}
