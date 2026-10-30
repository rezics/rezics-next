import { expect, test } from 'bun:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import { runImportCli } from '../src/cli.ts';
import { ImportSession } from '../src/import-session.ts';

// A local wire proof only. Native authority, stored pixels and disclosure are proved by the kernel journey.
test('Bangumi CLI sends separately licensed summary and cover through its ordinary media port and honours a late fence', async () => {
  const directory = await mkdtemp('/dev/shm/bangumi-cli-wire-');
  try {
    const keyPath = join(directory, 'account.jwk');
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    await writeFile(
      keyPath,
      JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: randomUUID(), alg: 'ES256' }),
      { mode: 0o600 },
    );
    const state = join(directory, 'state.sqlite');
    await writeFile(state, '', { mode: 0o600 });
    const raw = JSON.parse(
      await readFile(new URL('../../../specs/fixtures/imports/bangumi/subject.json', import.meta.url), 'utf8'),
    );
    const api = 'https://api.importer.test';
    const auth = 'https://auth.importer.test';
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
      randomUUID(),
      '--client',
      'bangumi-media-wire',
    ];
    const subject = randomUUID();
    const receipts = new Map<string, BatchWriteResult['results'][number]>();
    const commands: BatchCommand[] = [];
    const media = new Map<string, { request: MediaImportRequest; id: string; key: string }>();
    const statuses: string[] = [];
    const calls: string[] = [];
    let fenced = false;
    let sealed = false;
    const fetchBoundary = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      expect(sealed).toBe(true);
      if (url.origin === auth) {
        if (url.pathname === '/signin/key')
          return Response.json({}, { headers: { 'set-cookie': 'session=wire; Secure; HttpOnly' } });
        expect(url.pathname).toBe('/token');
        return Response.json({ access_token: 'wire-only-token', token_type: 'Bearer', expires_in: 300 });
      }
      expect(url.origin).toBe(api);
      calls.push(url.pathname);
      if (url.pathname === '/v1/sourceFences:check') {
        return Response.json({
          fenced: fenced && url.searchParams.get('fieldGroup') === 'cover',
          securityRevision: fenced && url.searchParams.get('fieldGroup') === 'cover' ? '1' : null,
        });
      }
      if (url.pathname === '/v1/media:importFromUrl') {
        expect(fenced).toBe(false);
        const body = (await request.json()) as MediaImportRequest;
        expect(body.containerId).toBe(subject);
        expect(body.credit.license).toBe('LicenseRef-unknown');
        expect(body.credit.rightsHolder).toContain('rights holder');
        expect(body.provenance).toMatchObject({
          source: 'bangumi',
          external_id: String(raw.id),
          field_group: 'cover',
          converter_revision: 'bangumi@3',
          record_revision: 'unversioned',
        });
        const key = request.headers.get('idempotency-key')!;
        const previous = media.get(body.sourceUrl);
        if (previous) {
          expect(previous.request).toEqual(body);
          expect(previous.key).toBe(key);
        } else media.set(body.sourceUrl, { request: body, key, id: randomUUID() });
        return Response.json(
          { media: { id: media.get(body.sourceUrl)!.id, containerId: subject, purpose: 'cover', state: 'reserved' } },
          { status: 202 },
        );
      }
      const status = /^\/v1\/media\/([^/]+):importStatus$/.exec(url.pathname);
      if (status) {
        const entry = [...media.values()].find((entry) => entry.id === status[1])!;
        expect(entry).toBeDefined();
        statuses.push(entry.id);
        return Response.json({
          media: {
            id: entry.id,
            containerId: subject,
            purpose: 'cover',
            state: 'available',
            credit: entry.request.credit,
            provenance: entry.request.provenance,
            byteCount: 123,
            mediaType: 'image/png',
            sha256: 'a'.repeat(64),
          },
        });
      }
      expect(url.pathname).toBe('/v1/subjects:batchWrite');
      const body = (await request.json()) as BatchWriteRequest;
      return Response.json({
        results: body.commands.map((command) => {
          commands.push(command);
          const old = receipts.get(command.key);
          if (old) return old;
          const result: BatchWriteResult['results'][number] = {
            key: command.key,
            status: 200,
            value:
              command.op === 'create'
                ? { id: subject, revision: 1 }
                : command.op === 'propose'
                  ? { candidate: randomUUID(), revision: 1 }
                  : { revision: 1 },
          };
          receipts.set(command.key, result);
          return result;
        }),
      });
    }) as typeof fetch;
    async function invoke(payload: unknown) {
      sealed = false;
      const result = await runImportCli(argv, {
        stdin: (async function* () {
          yield new TextEncoder().encode(JSON.stringify(payload) + '\n');
        })(),
        fetch: fetchBoundary,
        observer: {
          onCoordinator({ importer }) {
            const seal = importer.session.store.seal.bind(importer.session.store);
            importer.session.store.seal = (run, input) => {
              const result = seal(run, input);
              sealed = result.status === 'ready';
              return result;
            };
          },
        },
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.openHandles).toBe(0);
    }
    await invoke(raw);
    const summary = commands.find((command) => command.op === 'propose' && command.source.field_group === 'summary');
    expect(summary?.op).toBe('propose');
    if (summary?.op !== 'propose') throw new Error('Missing summary wire command');
    expect(summary.rights?.license).toBe('CC-BY-SA-3.0');
    expect(JSON.stringify(summary)).toContain('SUMMARY_END_SENTINEL');
    expect(media.size).toBe(1);
    expect(statuses).toHaveLength(1);
    expect(
      commands.some(
        (c) =>
          c.op === 'propose' &&
          c.source.field_group === 'cover' &&
          c.statement.value.type === 'value' &&
          c.statement.value.content === [...media.values()][0]!.id,
      ),
    ).toBe(true);
    const initialCommands = commands.length;
    await invoke(raw);
    expect(commands).toHaveLength(initialCommands);
    const changed = structuredClone(raw);
    changed.images.large = 'https://lain.bgm.tv/pic/cover/l/ab/cd/424242_wire_refresh.png';
    await invoke(changed);
    expect(media.size).toBe(2);
    expect(statuses).toHaveLength(2);
    fenced = true;
    const before = calls.length;
    const beforeCommands = commands.length;
    changed.images.large = 'https://lain.bgm.tv/pic/cover/l/ab/cd/424242_wire_fenced.png';
    await invoke(changed);
    await invoke(changed);
    expect(calls.slice(before).filter((path) => path.startsWith('/v1/media'))).toEqual([]);
    expect(commands.slice(beforeCommands).filter((c) => c.source.field_group === 'cover')).toEqual([]);
    const session = new ImportSession(state);
    try {
      expect(session.bindings.claim({ source: 'bangumi', external_id: String(raw.id) })).toMatchObject({
        state: 'bound',
        subject,
      });
    } finally {
      session.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
