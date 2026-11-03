import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { expect, test } from 'bun:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkBatchWrite,
  type BatchCommand,
  type BatchWriteRequest,
  type BatchWriteResult,
} from '@rezics/definitions/bulk';
import { Importer, type ImportMediaResolver, type ImportRunResult } from '../src/importer.ts';
import { ImportSession } from '../src/import-session.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { runImportCli as runCli } from '../src/cli.ts';

const registration = createSourceRegistration('bangumi');
const types = [1, 2, 4, 3, 6];
const created = ['1', '2', '3', '4', '6'];
const marker = 'PRIVATE_SCOPE_MARKER';
function dump(withImages = true, changed = false) {
  return (
    types
      .map((type) =>
        JSON.stringify({
          id: type,
          type,
          name: changed && type === 1 ? 'Changed book' : `Title ${type}`,
          name_cn: `中文标题 ${type}`,
          summary: `Complete summary ${type}`,
          ...(withImages ? { images: { large: `https://lain.bgm.tv/pic/cover/l/${type}.jpg` } } : {}),
          posts: [marker],
          user: { email: marker },
        }),
      )
      .join('\n') + '\n'
  );
}
async function* bytes(text = dump()) {
  const encoded = new TextEncoder().encode(text);
  for (let offset = 0; offset < encoded.length; offset += 31) yield encoded.slice(offset, offset + 31);
}

// The only simulated behavior is the remote boundary; receipts outlive local reopen.
function remote() {
  const receipts = new Map<string, { bytes: string; result: BatchWriteResult['results'][number] }>();
  const subjects = new Map<string, string>();
  const effects: BatchCommand[] = [];
  const requests: BatchCommand[] = [];
  const media = new Map<string, { bytes: string; id: string }>();
  const mediaRequests: string[] = [];
  const transport = {
    setSourceRecordMetadata: sourceRecordMetadataFixture().setSourceRecordMetadata,
    async readFence() {
      return { fenced: false, securityRevision: null };
    },
    async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
      expect(checkBatchWrite(request)).toEqual([]);
      expect(JSON.stringify(request)).not.toContain(marker);
      return {
        results: request.commands.map((command) => {
          requests.push(structuredClone(command));
          const body = JSON.stringify(command),
            prior = receipts.get(command.key);
          if (prior) {
            expect(body).toBe(prior.bytes);
            return structuredClone(prior.result);
          }
          const owner = command.source.external_id;
          if (command.op === 'create') {
            expect(subjects.has(owner)).toBe(false);
            subjects.set(owner, randomUUID());
          } else if (command.op === 'propose') expect(command.subject).toBe(subjects.get(owner)!);
          const result = {
            key: command.key,
            status: 200 as const,
            value:
              command.op === 'create'
                ? { id: subjects.get(owner)!, revision: 1 }
                : command.op === 'propose'
                  ? { candidate: randomUUID(), revision: 1 }
                  : { revision: 1 },
          };
          receipts.set(command.key, { bytes: body, result });
          effects.push(structuredClone(command));
          return result;
        }),
      };
    },
  };
  const mediaResolver: ImportMediaResolver = {
    async resolve({ owner, mediaImportIntents }) {
      mediaRequests.push(owner.external_id);
      const mediaIds: Record<string, string> = {};
      for (const intent of mediaImportIntents) {
        const body = JSON.stringify(intent),
          prior = media.get(intent.sourceUrl);
        if (!prior) media.set(intent.sourceUrl, { bytes: body, id: randomUUID() });
        mediaIds[intent.sourceUrl] = media.get(intent.sourceUrl)!.id;
      }
      return { status: 'available', mediaIds };
    },
  };
  return { transport, mediaResolver, subjects, effects, requests, media, mediaRequests };
}
function completed(result: ImportRunResult, counts?: ImportRunResult['counts']) {
  expect(result.status).toBe('committed');
  // Additive per-run count, independent of the existing reconciliation categories.
  expect(result).toHaveProperty('skipped', 0);
  if (counts) expect(result.counts).toEqual(counts);
}
function scope(f: ReturnType<typeof remote>, importer: Importer, images = true) {
  expect([...f.subjects.keys()].sort()).toEqual(created);
  expect(f.media.size).toBe(images ? 5 : 0);
  expect(f.requests.map((command) => command.source.external_id).sort()).toEqual(
    expect.arrayContaining(created),
  );
  expect([...new Set(f.mediaRequests)].sort()).toEqual(images ? created : []);
  const source = importer.session.store.source(registration.source);
  expect(source.count).toBe(5);
  expect(source.generation).not.toBeNull();
  for (const key of created) {
    const state = importer.session.store.key(registration.source, key);
    expect(state.baseline).toEqual(state.acknowledged);
    expect(state.baseline?.state).toBe('present');
  }
}

test('mixed complete dump counts both exclusions on initial, unchanged and changed runs without false disappearance', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bangumi-scope-'));
  const path = join(directory, 'state.sqlite'),
    f = remote();
  let importer = new Importer({ path, ...f });
  try {
    expect(importer.session).toBeInstanceOf(ImportSession);
    completed(await importer.runDump(registration, bytes()), { new: 5, changed: 0, unchanged: 0, vanished: 0 });
    scope(f, importer);
    const effects = f.effects.length,
      mediaCalls = f.mediaRequests.length;
    completed(await importer.runDump(registration, bytes()), { new: 0, changed: 0, unchanged: 5, vanished: 0 });
    expect(f.effects).toHaveLength(effects);
    expect(f.mediaRequests).toHaveLength(mediaCalls);
    await importer.close();
    importer = new Importer({ path, ...f });
    completed(await importer.runDump(registration, bytes()), { new: 0, changed: 0, unchanged: 5, vanished: 0 });
    expect(f.effects).toHaveLength(effects);
    expect(f.mediaRequests).toHaveLength(mediaCalls);
    completed(await importer.runDump(registration, bytes(dump(true, true))), {
      new: 0,
      changed: 1,
      unchanged: 4,
      vanished: 0,
    });
    scope(f, importer);
  } finally {
    await importer.close();
    rmSync(directory, { recursive: true });
  }
});

for (const crash of ['remote success', 'finalization'] as const) {
  test(`durable resume after ${crash} counts skipped inputs once without consuming replacement input`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bangumi-scope-resume-'));
    const path = join(directory, 'state.sqlite'),
      f = remote();
    let fault = true;
    let importer = new Importer({
      path,
      ...f,
      afterBulkSuccess() {
        if (crash === 'remote success' && fault) {
          fault = false;
          throw new Error('Crash after remote success');
        }
      },
    });
    if (crash === 'finalization') {
      const finalize = importer.session.store.finalize.bind(importer.session.store);
      importer.session.store.finalize = (...args) => {
        if (fault) {
          fault = false;
          throw new Error('Crash before source finalization');
        }
        return finalize(...args);
      };
    }
    try {
      expect((await importer.runDump(registration, bytes())).status).toBe(
        crash === 'remote success' ? 'interrupted' : 'bulk-failed',
      );
      await importer.close();
      importer = new Importer({ path, ...f });
      let consumed = false;
      const replacement = (async function* () {
        consumed = true;
        yield* bytes(dump(true, true));
      })();
      completed(await importer.runDump(registration, replacement));
      expect(consumed).toBe(false);
      scope(f, importer);
      const effects = f.effects.length;
      completed(await importer.runDump(registration, bytes()));
      expect(f.effects).toHaveLength(effects);
      scope(f, importer);
    } finally {
      await importer.close();
      rmSync(directory, { recursive: true });
    }
  });
}

test('CLI executes actual acquisition and prints skipped=0 on each same-input invocation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bangumi-scope-cli-'));
  const keyPath = join(directory, 'account-key.json'),
    f = remote();
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  writeFileSync(
    keyPath,
    JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: 'scope-key', alg: 'ES256', key_ops: ['sign'] }),
    { mode: 0o600 },
  );
  const origin = 'http://127.0.0.1:43179';
  const argv = [
    '--source',
    'bangumi',
    '--dump',
    '-',
    '--state',
    join(directory, 'state.sqlite'),
    '--api',
    origin,
    '--account-key',
    keyPath,
    '--account',
    '00000000-0000-4000-8000-000000000001',
    '--client',
    'scope-cli',
    '--auth',
    'https://auth.importer.test',
  ];
  const metadata = sourceRecordMetadataFixture();
  const fetchRemote = async (request: Request) => {
    const url = new URL(request.url);
    if (url.origin === 'https://auth.importer.test') {
      if (url.pathname === '/signin/key')
        return Response.json({}, { headers: { 'set-cookie': 'session=scope; HttpOnly; Secure' } });
      if (url.pathname === '/token')
        return Response.json({ access_token: 'SCOPE_TOKEN', token_type: 'Bearer', expires_in: 300 });
    }
    expect(url.origin).toBe(origin);
    if (url.pathname === '/v1/source-records:setMetadata') return metadata.fetch(request);
    if (url.pathname === '/v1/sourceFences:check') return Response.json(await f.transport.readFence());
    expect(url.pathname).toBe('/v1/subjects:batchWrite');
    return Response.json(await f.transport.batchWrite((await request.json()) as BatchWriteRequest));
  };
  try {
    let previousEffects: number | undefined;
    for (let run = 0; run < 2; run++) {
      let consumed = false;
      const result = await runCli(argv, {
        stdin: (async function* () {
          consumed = true;
          yield* bytes(dump(false));
        })(),
        fetch: fetchRemote as typeof fetch,
        testOrigin: origin,
      });
      expect(result.code).toBe(0);
      expect(consumed).toBe(true);
      expect(result.stdout).toMatch(/\bskipped=0\b/);
      expect(result.stdout + result.stderr).not.toContain(marker);
      expect(result.openHandles).toBe(0);
      expect([...f.subjects.keys()].sort()).toEqual(created);
      expect(f.requests.map((command) => command.source.external_id).sort()).toEqual(expect.arrayContaining(created));
      if (previousEffects !== undefined) expect(f.effects).toHaveLength(previousEffects);
      previousEffects = f.effects.length;
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('a prior ignored identity-only 3/6 baseline refreshes to typed conversion without disappearance', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bangumi-scope-refresh-'));
  const path = join(directory, 'state.sqlite'),
    f = remote();
  const importer = new Importer({ path, ...f });
  async function* identityOnly() {
    yield* bytes(
      `${JSON.stringify({ id: 3, type: 3 })}\n${JSON.stringify({ id: 6, type: 6 })}\n${JSON.stringify({
        id: 1,
        type: 1,
        name: 'Book',
      })}\n`,
    );
  }
  try {
    const ignored = await importer.runDump(registration, identityOnly());
    expect(ignored.status).toBe('committed');
    expect(ignored.skipped).toBe(2);
    expect(ignored.counts).toEqual({ new: 3, changed: 0, unchanged: 0, vanished: 0 });
    expect([...f.subjects.keys()]).toEqual(['1']);
    expect(importer.session.store.key(registration.source, '3').baseline?.state).toBe('present');
    const named = bytes(
      `${JSON.stringify({ id: 3, type: 3, name: 'Soundtrack', date: '2024-04-01' })}\n${JSON.stringify({
        id: 6,
        type: 6,
        name: 'Live film',
        platform: 'movie',
      })}\n${JSON.stringify({ id: 1, type: 1, name: 'Book' })}\n`,
    );
    const refreshed = await importer.runDump(registration, named);
    expect(refreshed.status).toBe('committed');
    expect(refreshed.skipped).toBe(0);
    expect(refreshed.counts).toEqual({ new: 0, changed: 2, unchanged: 1, vanished: 0 });
    expect([...f.subjects.keys()].sort()).toEqual(['1', '3', '6']);
    const music = f.effects.filter((command) => command.source.external_id === '3');
    expect(music.some((command) => command.op === 'create' && command.subject.type === 'schema:MusicAlbum')).toBe(true);
    const film = f.effects.filter((command) => command.source.external_id === '6');
    expect(film.some((command) => command.op === 'create' && command.subject.type === 'schema:Movie')).toBe(true);
    expect(importer.session.store.source(registration.source).count).toBe(3);
  } finally {
    await importer.close();
    rmSync(directory, { recursive: true });
  }
});
