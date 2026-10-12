import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { FusekiClient, type SourceAuthorNamesRequest } from '../src/infrastructure/fuseki.ts';
import { SourceAuthorNameStore } from '../src/modules/source/author-name.ts';
import { publishSourceAuthorName } from '../src/modules/source/author-name-publication.ts';
import type { SourceIntakeStore } from '../src/modules/source/intake.ts';
import { normalizedSearchText } from '../src/modules/search/fields.ts';
import { SourceIntakeUnavailable } from '../src/modules/source/intake.ts';

const sourceKey = '/authors/OL1A';
const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
/** Same in-process HTTP Fuseki fixture as command.test: exercises the client
 * wire contract without starting a second shared backend. */
function fixture(works = [id(1)], mainVersion: string | null = id(2)) {
  const commands: SourceAuthorNamesRequest[] = [], queries: string[] = [];
  let fail = false, tooMany = false;
  const server = Bun.serve({ port: 0, fetch: async request => {
    const text = await request.text();
    if (new URL(request.url).pathname.endsWith('/query')) {
      queries.push(text);
      const values = text.includes('SELECT DISTINCT ?work')
        ? works.filter(work => work > (/FILTER\(STR\(\?work\) > "([^"]*)"\)/u.exec(text)?.[1] ?? '')).slice(0, 65)
        : Array.from({ length: tooMany ? 129 : 1 }, (_, index) => id(index + 100));
      const variable = text.includes('SELECT DISTINCT ?work') ? 'work' : 'credit';
      return Response.json({ results: { bindings: values.map(value => ({ [variable]: { type: 'uri', value } })) } });
    }
    expect(request.headers.get('authorization')).toBe(`Bearer ${'a'.repeat(64)}`);
    const body = JSON.parse(text) as { sourceAuthorNames: SourceAuthorNamesRequest };
    commands.push(body.sourceAuthorNames);
    if (fail) return Response.json({}, { status: 503 });
    return Response.json({ target: body.sourceAuthorNames.target, work: body.sourceAuthorNames.target,
      sourceKey: body.sourceAuthorNames.sourceKey,
      mainVersion, sourcePosition: body.sourceAuthorNames.sourcePosition,
      names: body.sourceAuthorNames.names.length, examined: body.sourceAuthorNames.names.length + 1,
      replayed: commands.slice(0, -1).some(prior => prior.idempotencyKey === body.sourceAuthorNames.idempotencyKey) });
  } });
  return { commands, queries, client: new FusekiClient(`http://localhost:${server.port}/rezics`, '', 'a'.repeat(64)),
    fail: (value: boolean) => { fail = value; }, tooMany: () => { tooMany = true; }, stop: () => server.stop(true) };
}

test('source name publication adds, replaces, removes and replays exact bounded native snapshots', async () => {
  const run = fixture();
  let head = { sourcePosition: '1', name: { displayName: 'ÉLODIE  Martin' } as { displayName: string } | null };
  const reader = { read: async () => head };
  try {
    await publishSourceAuthorName(run.client, reader, sourceKey);
    await publishSourceAuthorName(run.client, reader, sourceKey);
    expect(run.commands[0]).toEqual(run.commands[1]);
    expect(run.commands[0]?.credits).toEqual([id(100)]);
    expect(normalizedSearchText(run.commands[0]!.names[0]!.displayName)).toBe('élodie martin');
    head = { sourcePosition: '2', name: { displayName: 'New Name' } };
    await publishSourceAuthorName(run.client, reader, sourceKey, id(1));
    expect(run.commands[2]?.names[0]?.displayName).toBe('New Name');
    expect(run.commands[2]?.idempotencyKey).not.toBe(run.commands[0]?.idempotencyKey);
    head = { sourcePosition: '3', name: null };
    await publishSourceAuthorName(run.client, reader, sourceKey);
    expect(run.commands[3]?.names).toEqual([]);
    expect(run.commands[3]?.sourceKey).toBe(sourceKey);
    expect(run.queries.every(query => /LIMIT (65|129)/u.test(query))).toBe(true);
    run.tooMany();
    await expect(publishSourceAuthorName(run.client, reader, sourceKey)).rejects.toThrow('exceed their bound');
    expect(run.commands).toHaveLength(4);
  } finally { await run.stop(); }
});

test('source name publication refuses invalid languages before calling the native client', async () => {
  const run = fixture();
  try {
    for (const language of ['not a language', 'en--US', ' en ']) {
      await expect(publishSourceAuthorName(run.client, { read: async () => ({ sourcePosition: '1',
        name: { displayName: 'Author', language } }) }, sourceKey)).rejects.toBeInstanceOf(SourceIntakeUnavailable);
    }
    expect(run.commands).toHaveLength(0);
    await publishSourceAuthorName(run.client, { read: async () => ({ sourcePosition: '1',
      name: { displayName: 'Author', language: 'en-US' } }) }, sourceKey);
    expect(run.commands[0]?.names[0]?.language).toBe('en-US');
  } finally { await run.stop(); }
});

test('source refresh fanout advances across bounded Work pages without dropping the 65th Work', async () => {
  const run = fixture(Array.from({ length: 65 }, (_, index) => id(index + 1)));
  try {
    await publishSourceAuthorName(run.client,
      { read: async () => ({ sourcePosition: '7', name: { displayName: 'Author' } }) }, sourceKey);
    expect(run.commands).toHaveLength(65);
    expect(new Set(run.commands.map(command => command.target)).size).toBe(65);
    expect(run.queries.filter(query => query.includes('SELECT DISTINCT ?work'))).toHaveLength(2);
    expect(run.commands.every(command => command.names.length === 1 && command.credits.length === 1)).toBe(true);
  } finally { await run.stop(); }
});

test('an author refresh commits SQL then repairs failed native publication on API replay using the current head', async () => {
  const run = fixture();
  const principal = '00000000-0000-4000-8000-000000000010', revision = '00000000-0000-4000-8000-000000000011';
  const input = { action: 'remove' as const, expectedRevision: revision, reason: 'Removed upstream' };
  const requestDigest = createHash('sha256').update(JSON.stringify([sourceKey, input.action, revision, input.reason])).digest('hex');
  let replay: Record<string, unknown> | undefined;
  let head: Record<string, unknown> = { id: revision, source_position: '1', display_name: null, provider_revision: null };
  const calls: string[] = [];
  let released = false;
  const query = async (sql: string, args?: unknown[]) => {
    calls.push(sql);
    if (sql.includes('INSERT INTO source.author_name_revision')) {
      head = { id: args![0], source_position: '2', display_name: null, provider_revision: null, request_digest: requestDigest };
      replay = head;
    }
    if (sql.startsWith('SELECT n.*')) {
      if (sql.includes('n.principal_id')) return { rows: replay ? [replay] : [] };
      return { rows: [head] };
    }
    return { rows: [] };
  };
  const pool = { query, connect: async () => ({ query, release: () => { released = true; } }) } as unknown as Pool;
  const store = new SourceAuthorNameStore(pool, {} as SourceIntakeStore,
    (() => { throw new Error('Removal/replay must not acquire upstream content'); }) as unknown as typeof fetch, run.client);
  try {
    run.fail(true);
    await expect(store.command(principal, 'remove-author', sourceKey, input)).rejects.toThrow('incomplete');
    expect(calls).toContain('COMMIT');
    expect(calls).not.toContain('ROLLBACK');
    expect(released).toBe(true);
    // A later source head wins even when the API replays the old SQL receipt.
    head = { ...head, source_position: '3' };
    run.fail(false);
    expect((await store.command(principal, 'remove-author', sourceKey, input)).replayed).toBe(true);
    expect(run.commands.at(-1)?.sourcePosition).toBe('3');
    expect(calls.filter(sql => sql.includes('INSERT INTO source.author_name_revision'))).toHaveLength(1);
  } finally { await run.stop(); }
});

test('a refresh publishes the captured factual name before completing its response', async () => {
  const run = fixture();
  let saved: Record<string, unknown> | undefined;
  const observation = id(80);
  const query = async (sql: string, args?: unknown[]) => {
    if (sql.includes('INSERT INTO source.author_name_revision')) saved = {
      id: args![0], source_position: '8', author_key: sourceKey, display_name: args![7],
      observation_id: observation.split('/').at(-1), record_id: id(81).split('/').at(-1),
      byte_digest: 'a'.repeat(64), source_revision: 'open-library-revision:4',
      capture: { url: 'https://openlibrary.org/authors/OL1A.json', fetchedAt: '2026-10-12T00:00:00Z' },
    };
    return { rows: sql.startsWith('SELECT n.*') && !sql.includes('n.principal_id') && saved ? [saved] : [] };
  };
  const pool = { query, connect: async () => ({ query, release: () => {} }) } as unknown as Pool;
  const intake = { replay: async () => ({ observation, rawBytesBase64: Buffer.from(JSON.stringify({
    key: sourceKey, name: 'ÉLODIE Writer', revision: 4, type: { key: '/type/author' },
  })).toString('base64') }) } as unknown as SourceIntakeStore;
  try {
    const store = new SourceAuthorNameStore(pool, intake, fetch, run.client);
    const result = await store.command('00000000-0000-4000-8000-000000000010', 'refresh-author',
      sourceKey, { action: 'refresh', expectedRevision: null });
    expect(result.name?.displayName).toBe('ÉLODIE Writer');
    expect(run.commands).toHaveLength(1);
    expect(run.commands[0]?.names).toEqual([{ sourceKey, displayName: 'ÉLODIE Writer', language: null }]);
    expect(run.commands[0]?.sourcePosition).toBe('8');
  } finally { await run.stop(); }
});

test('rollout publication returns a resumable author-head page and replays safely', async () => {
  const run = fixture();
  const keys = Array.from({ length: 65 }, (_, index) => `/authors/OL${index + 1}A`).sort();
  const queries: { sql: string; args?: unknown[] }[] = [];
  const pool = { query: async (sql: string, args?: unknown[]) => {
    queries.push({ sql, args });
    return { rows: sql.startsWith('SELECT author_key')
      ? keys.filter(key => key > String(args![0])).slice(0, 65).map(author_key => ({ author_key }))
      : [{ id: '00000000-0000-4000-8000-000000000011', source_position: '1', display_name: null }] };
  } } as unknown as Pool;
  try {
    const names = new SourceAuthorNameStore(pool, {} as SourceIntakeStore, fetch, run.client);
    const first = await names.publishNativePage();
    expect(first).toEqual({ authors: 64, more: true, after: keys[63]! });
    expect(await names.publishNativePage(first.after)).toEqual({ authors: 1, more: false, after: null });
    expect(new Set(run.commands.map(command => command.sourceKey)).size).toBe(65);
    expect(queries.filter(query => query.sql.startsWith('SELECT author_key')).every(query => query.sql.includes('LIMIT 65'))).toBe(true);
    expect(await names.publishNativePage(first.after)).toEqual({ authors: 1, more: false, after: null });
    expect(run.commands.at(-1)).toEqual(run.commands.at(-2));
  } finally { await run.stop(); }
});

test('a Work awaiting its first Main does not block source-name publication', async () => {
  const run = fixture([id(1)], null);
  try {
    await publishSourceAuthorName(run.client,
      { read: async () => ({ sourcePosition: '1', name: { displayName: 'Author' } }) }, sourceKey);
    expect(run.commands).toHaveLength(1);
    expect(run.commands[0]?.target).toBe(id(1));
  } finally { await run.stop(); }
});
