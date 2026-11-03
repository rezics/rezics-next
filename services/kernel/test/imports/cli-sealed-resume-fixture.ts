import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { converter_revision as vndbRevision } from '../../../../packages/conversion/src/vndb.ts';
import { converter_revision as wikidataRevision } from '../../../../packages/conversion/src/wikidata.ts';
import entity from '../../../../specs/fixtures/imports/wikidata/entity.json';
import { runImportCli } from '../../../importer/src/cli.ts';
import { IMPORTER_SCOPES, VNDB_IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';
import { identitySupport } from './identity-fixture.ts';

type Source = 'vndb' | 'wikidata';
type Exchange = {
  ordinal: number;
  path: string;
  method: string;
  bytes: string;
  status: number;
  keys: string[];
};
const names = ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta'];
const encoder = new TextEncoder();
const sources = [
  { source: 'vndb' as const, keys: ['v123', 'v124'], converter: vndbRevision },
  { source: 'wikidata' as const, keys: [entity.id], converter: wikidataRevision },
];

function archive() {
  const chunks: Uint8Array[] = [];
  for (const name of names) {
    const body = encoder.encode(
      readFileSync(new URL(`../../../../specs/fixtures/imports/vndb-tables/db/${name}`, import.meta.url), 'utf8'),
    );
    const header = new Uint8Array(512);
    const put = (offset: number, value: string) => header.set(encoder.encode(value), offset);
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

function dump(source: Source) {
  if (source === 'vndb') return archive();
  return encoder.encode(`[\n${JSON.stringify(entity)}\n]\n`);
}

/** Native dump-free resume after sealed acquisition; dump bytes are deleted before resume. */
export async function runSealedResumeJourney() {
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
    directory = await mkdtemp('/dev/shm/import-cli-sealed-resume-');
    const state = join(directory, 'state.sqlite');
    const keyPath = join(directory, 'account.jwk');
    const dumpPath = join(directory, 'source.dump');
    await writeFile(state, '', { flag: 'wx', mode: 0o600 });
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
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256' }), {
      flag: 'wx',
      mode: 0o600,
    });
    const editor = await openApiObserver(runtime);
    const api = 'https://cli-sealed-resume.import.test';
    const auth = new URL(runtime.identity.auth.verifier.jwksUrl).origin;
    const exchanges: Exchange[] = [];
    const commands = new Map<string, BatchCommand>();
    const anchors = new Map<string, { partition: number; kind: string; key: string }>();

    function inspect(feed: (typeof sources)[number]) {
      const session = new ImportSession(state);
      try {
        const active = session.store.activeRun(feed.source);
        return {
          source: session.store.source(feed.source),
          active,
          pending: active ? session.store.pagePending(active, { limit: 100 }) : [],
          records: feed.keys.map((key) => session.store.key(feed.source, key)),
        };
      } finally {
        session.close();
      }
    }

    async function invoke(feed: (typeof sources)[number], mode: 'import' | 'resume', lose = false, deny = false) {
      const start = exchanges.length;
      const controller = new AbortController();
      let consumed = 0;
      let inputPasses = 0;
      const bytes = dump(feed.source);
      if (mode === 'import') await writeFile(dumpPath, bytes);
      else await rm(dumpPath, { force: true });
      const common = [
        '--source',
        feed.source,
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
      const result = await runImportCli(mode === 'resume' ? ['resume', ...common] : ['--dump', dumpPath, ...common], {
        signal: controller.signal,
        stdin: (async function* () {
          if (mode === 'resume') throw new Error('resume must not read stdin');
        })(),
        observer: {
          onInputPass() {
            inputPasses++;
          },
          onInputChunk(_kind, size) {
            consumed += size;
          },
          onVndbStore() {
            if (mode === 'resume') throw new Error('resume must not materialize VNDB');
          },
        },
        fetch: (async (input: Request | string | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const url = new URL(request.url);
          if (url.origin === auth) return support.host.service.handler(request);
          expect(url.origin).toBe(api);
          const claims = decodeJwt(request.headers.get('authorization')!.slice(7));
          expect(claims.sub).toBe(runtime.identity.bulk.accountId);
          expect(String(claims.scope).split(' ').sort()).toEqual(
            [...(feed.source === 'vndb' ? VNDB_IMPORTER_SCOPES : IMPORTER_SCOPES)].sort(),
          );
          const bodyText = request.method === 'GET' ? '' : await request.clone().text();
          const bulk = url.pathname === '/v1/subjects:batchWrite';
          const body = bulk ? (JSON.parse(bodyText) as BatchWriteRequest) : null;
          for (const command of body?.commands ?? []) {
            if (commands.has(command.key)) expect(command).toEqual(commands.get(command.key)!);
            commands.set(command.key, command);
            const route =
              command.op === 'create'
                ? tupleRoute(runtime.identity.routeKey, command.source.source, command.source.external_id)
                : routeOf(command.subject)!;
            anchors.set(command.key, {
              partition: partitionOf(route),
              kind: `subject.batch_${command.op}`,
              key: command.key,
            });
          }
          if (deny && bulk) return new Response('{"error":"denied"}', { status: 403 });
          const response = await runtime.replay(request);
          const responseBytes = await response.clone().text();
          const exchange = {
            ordinal: exchanges.length + 1,
            path: url.pathname,
            method: request.method,
            bytes: bodyText,
            status: response.status,
            keys: body?.commands.map((command) => command.key) ?? [],
          };
          exchanges.push(exchange);
          if (bulk && lose && body!.commands.some((command) => command.op === 'propose')) {
            controller.abort(new DOMException('Interrupted after native commit before local ACK', 'AbortError'));
            throw controller.signal.reason;
          }
          return response;
        }) as typeof fetch,
      });
      expect(result.openHandles).toBe(0);
      if (mode === 'resume') {
        expect(inputPasses).toBe(0);
        expect(consumed).toBe(0);
      }
      return { ...result, captured: exchanges.slice(start), consumed, inputPasses };
    }

    const results = [];
    for (const feed of sources) {
      const initial = await invoke(feed, 'import');
      expect(initial.code, JSON.stringify(initial)).toBe(0);
      const interrupted = await invoke(feed, 'import', true);
      expect([1, 130]).toContain(interrupted.code);
      const pending = inspect(feed);
      expect(pending.pending.length).toBeGreaterThan(0);
      const originalBytes = pending.pending.map((row) => row.bytes);
      const originalKeys = pending.pending.flatMap((row) => row.keys);
      const denied = await invoke(feed, 'resume', false, true);
      expect(denied.code).toBe(4);
      expect(inspect(feed).pending.map((row) => row.bytes)).toEqual(originalBytes);
      const cancelled = await invoke(feed, 'resume', true);
      expect([1, 130]).toContain(cancelled.code);
      expect(inspect(feed).active).not.toBeNull();
      const resumed = await invoke(feed, 'resume');
      expect(resumed.code, resumed.stderr).toBe(0);
      const after = inspect(feed);
      expect(after.source.generation).toBe(pending.active?.id);
      expect(after.active).toBeNull();
      const replayed = resumed.captured.filter((exchange) => exchange.path === '/v1/subjects:batchWrite');
      expect(replayed.some((exchange) => originalBytes.includes(exchange.bytes))).toBe(true);
      expect(originalKeys.every((key) => commands.get(key))).toBe(true);
      const id = (
        await runtime.database.admin.query<{ subject_id: string }>(
          'SELECT subject_id FROM semantic.external_claim WHERE route=$1 AND source=$2 AND external_id=$3',
          [tupleRoute(runtime.identity.routeKey, feed.source, feed.keys[0]!), feed.source, feed.keys[0]!],
        )
      ).rows[0]!.subject_id;
      const listing = await editor.http(
        `/v1/subjects/${id}/candidates?${new URLSearchParams({ property: 'schema:name', context: '00000000-0000-8000-8000-000000000000', limit: '100' })}`,
      );
      expect(listing.status).toBe(200);
      results.push({
        source: feed.source,
        originalBytes,
        originalKeys,
        denied: denied.code,
        resumed: resumed.code,
        inputPasses: resumed.inputPasses,
        consumed: resumed.consumed,
        candidates: (listing.body.candidates as { id: string }[]).map((row) => row.id),
      });
    }
    return { close, sources: results, sha256: createHash('sha256').update(dump('wikidata')).digest('hex') };
  } catch (error) {
    await close();
    throw error;
  }
}
