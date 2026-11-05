import { expect, test } from 'bun:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { readDump } from '../src/dumps.ts';
import { IMPORTER_SCOPES } from '../src/credentials.ts';
import { runImportCli } from '../src/cli.ts';

const origin = 'http://127.0.0.1:43179';
const auth = 'https://auth.importer.test';
const evidence = JSON.parse(
  await readFile(new URL('../../../specs/fixtures/imports/bangumi/person-names.json', import.meta.url), 'utf8'),
) as { operatorExample: { responseBody: string } };
const mutations = JSON.parse(
  await readFile(new URL('./fixtures/bangumi-person-names.json', import.meta.url), 'utf8'),
) as {
  responseIdentityMismatch: Record<string, unknown>;
  responseTypeMismatch: Record<string, unknown>;
};

function valueContent(command: Extract<BatchCommand, { op: 'propose' }>) {
  return command.statement.value.type === 'value' ? command.statement.value.content : undefined;
}

test('actual runImportCli accepts pinned five-column PersonDetail rows as proposal-only imports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bangumi-person-names-cli-'));
  try {
    const keyPath = join(directory, 'account.jwk');
    const state = join(directory, 'state.sqlite');
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
    await writeFile(keyPath, JSON.stringify({ ...key, kid: randomUUID(), alg: 'ES256' }), { mode: 0o600 });
    const row = `/type/person\tperson:641\tunversioned\t\t${evidence.operatorExample.responseBody}\n`;
    const sent: BatchCommand[] = [];
    const subjects = new Map<string, string>();
    const receipts = new Map<string, BatchWriteResult['results'][number]>();
    let sequence = 0;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === auth) {
        if (url.pathname === '/signin/key') {
          const body = (await request.json()) as { scope: string[] };
          expect(body.scope).toEqual([...IMPORTER_SCOPES, 'subject:read']);
          const session = `person-${++sequence}`;
          return Response.json({}, { headers: { 'set-cookie': `session=${session}; Secure; HttpOnly` } });
        }
        if (url.pathname === '/token' && request.headers.get('cookie') === `session=person-${sequence}`)
          return Response.json({ access_token: `PERSON_TOKEN_${sequence}`, token_type: 'Bearer', expires_in: 300 });
        return new Response('', { status: 404 });
      }
      if (url.pathname === '/v1/sourceFences:check')
        return Response.json({ fenced: false, securityRevision: null });
      if (url.pathname === '/v1/source-records:setMetadata') {
        const body = (await request.json()) as { metadata: Record<string, unknown> };
        return Response.json({ record: body.metadata, metadata_revision: 1, effect: 'filled' }, { status: 201 });
      }
      if (url.pathname !== '/v1/subjects:batchWrite') return new Response('', { status: 404 });
      const body = (await request.json()) as BatchWriteRequest;
      const result: BatchWriteResult = {
        results: body.commands.map((command) => {
          sent.push(structuredClone(command));
          const prior = receipts.get(command.key);
          if (prior) return prior;
          const home = `${command.source.source}:${command.source.external_id}`;
          if (command.op === 'create' && !subjects.has(home)) subjects.set(home, randomUUID());
          const value =
            command.op === 'create'
              ? { id: subjects.get(home)!, revision: 1 }
              : command.op === 'propose'
                ? { candidate: randomUUID(), revision: 1 }
                : { revision: 1 };
          const receipt = { key: command.key, status: 200 as const, value };
          receipts.set(command.key, receipt);
          return receipt;
        }),
      };
      return Response.json(result);
    }) as unknown as typeof globalThis.fetch;
    const result = await runImportCli(
      [
        '--source', 'bangumi', '--source-alias', 'bangumi_cross_media', '--dump', '-', '--state', state,
        '--api', origin, '--auth', auth, '--account-key', keyPath, '--account', randomUUID(), '--client', 'person-names',
      ],
      {
        stdin: (async function* () {
          yield new TextEncoder().encode(row);
        })(),
        fetch: fakeFetch,
        testOrigin: origin,
        clock: { now: () => 1_000, sleep: async () => {} },
      },
    );
    if (result.code !== 0) throw new Error(result.stderr);
    expect(result.code).toBe(0);
    const names = sent.filter(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' && command.statement.property.id === 'schema:name',
    );
    expect(names.map(valueContent)).toEqual([
      { language: 'und', text: '岸本斉史' },
      { language: 'zh', text: '岸本齐史' },
    ]);
    expect(names.every((command) => command.source.record_revision === 'unversioned')).toBe(true);
    expect(names.every((command) => command.source.converter_revision === 'cross-media-entities@13+bangumi@14')).toBe(true);
    expect(sent.some((command) => command.op === 'retract')).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PersonDetail TSV binds the requested type-1 identity and never promotes ETags to revisions', async () => {
  const parse = async (record: Record<string, unknown>, key = 'person:641') => {
    const line = `/type/person\t${key}\tunversioned\t"cache-only"\t${JSON.stringify(record)}\n`;
    const rows = [];
    for await (const row of readDump('bangumi', (async function* () { yield new TextEncoder().encode(line); })(), {
      bangumiPersonDetailRows: true,
    })) rows.push(row);
    return rows[0];
  };
  const actual = JSON.parse(evidence.operatorExample.responseBody) as Record<string, unknown>;
  expect(await parse(actual)).toMatchObject({ key: 'person:641', revision: null, payload: actual });
  for (const record of [mutations.responseIdentityMismatch, mutations.responseTypeMismatch])
    await expect(parse(record)).rejects.toThrow('Invalid dump record or framing');
  await expect(parse({ ...actual, oversized: 'x'.repeat(65_536) })).rejects.toThrow('Invalid dump record or framing');
});
