import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { documentText } from '@rezics/document';
import { Client } from 'pg';
import * as revisionPages from '../../src/content/revision-pages.ts';
import readChain from '../../src/content/read-chain.sql';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { routeOf } from '../../src/route/route.ts';
import { decodeCursor, encodeCursor } from '../../src/tokens/cursor.ts';
import { createContentDisclosureDriver } from './disclosure-driver.ts';
import * as nativeSystem from './support/native-system.ts';

setDefaultTimeout(180_000);
let driver: Awaited<ReturnType<typeof createContentDisclosureDriver>>;
let system: nativeSystem.NativeContentSystem;
beforeAll(async () => {
  const create = nativeSystem.createNativeContentSystem;
  const observe = spyOn(nativeSystem, 'createNativeContentSystem').mockImplementation(async (...args) => {
    system = await create(...args);
    return system;
  });
  try {
    driver = await createContentDisclosureDriver();
  } finally {
    observe.mockRestore();
  }
});
afterAll(async () => driver?.close());

type Persona = 'anonymous' | 'author' | 'other';
async function read(path: string, persona: Persona = 'author') {
  const actor = persona === 'anonymous' ? null : system.actors[persona];
  return system.kernel.handle(
    new Request(`https://content.test${path}`, {
      headers: actor ? { authorization: `Bearer ${actor.bearer}` } : {},
    }),
  );
}
async function page(path: string, persona: Persona = 'author') {
  const response = await read(path, persona);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get(SESSION_HEADER)).toBeTruthy();
  return response.json();
}
async function fixture() {
  const board = await driver.board();
  const thread = await driver.publish({ board, body: 'Opening manuscript' });
  const post = await driver.publish({ board, thread, body: 'Original chapter manuscript' });
  return { board, thread, post, path: `/v1/posts/${post.id}/revision-headers` };
}

test('author lists 20/21 exact headers with no body probes and fetches the old body separately', async () => {
  const { thread, post, path } = await fixture();
  const revisions = [post.revision];
  for (let i = 1; i <= 20; i++) revisions.push(await driver.edit(post, `Later manuscript ${i}`));
  const before = await driver.inspectCommandCopies(post);
  const sql = spyOn(Client.prototype, 'query');
  const selected = spyOn(revisionPages, 'pageRevisionCandidates');
  let first;
  try {
    first = await page(path);
    expect(selected).toHaveBeenCalledTimes(1);
    expect(selected.mock.calls[0]![1]).toMatchObject({ postId: post.id, after: null, limit: 20 });
    const probes = sql.mock.calls.filter(([text]) => text === readChain.sql);
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) {
      expect(Array.isArray(probe[1])).toBe(true);
      expect((probe[1] as unknown[])[readChain.params.indexOf('include_body')]).toBe(false);
    }
  } finally {
    sql.mockRestore();
    selected.mockRestore();
  }
  expect(Object.keys(first).sort()).toEqual(['next', 'revisions']);
  expect(first.revisions.map((row: { revisionId: string }) => row.revisionId)).toEqual(
    revisions.slice(0, 20).map((revision) => revision.id),
  );
  const recorded = await system.database.pool.query<{ revision_id: string; at: string }>(
    `SELECT revision_id, to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
     FROM content.revision WHERE route=$1 AND post_id=$2 ORDER BY recorded_at, revision_id`,
    [routeOf(post.id), post.id],
  );
  for (const [index, row] of first.revisions.entries()) {
    expect(Object.keys(row).sort()).toEqual([
      'authorId',
      'documentKind',
      'kind',
      'licence',
      'postId',
      'recordedAt',
      'revisionId',
      'sha256',
      'subjectIds',
      'threadId',
    ]);
    expect(row).toEqual({
      postId: post.id,
      threadId: thread.id,
      revisionId: revisions[index]!.id,
      sha256: revisions[index]!.hash,
      recordedAt: recorded.rows[index]!.at,
      authorId: system.actors.author.actor.accountId,
      kind: 'discussion',
      documentKind: 'reply',
      licence: 'MIT',
      subjectIds: [],
    });
  }
  const second = await page(`${path}?cursor=${encodeURIComponent(first.next)}`);
  expect(second.revisions.map((row: { revisionId: string }) => row.revisionId)).toEqual([revisions[20]!.id]);
  expect(second.next).toBeNull();
  const opening = await system.database.pool.query<{ first_post_id: string }>(
    'SELECT first_post_id FROM content.thread WHERE route=$1 AND thread_id=$2',
    [routeOf(thread.id), thread.id],
  );
  expect((await page(`/v1/posts/${opening.rows[0]!.first_post_id}/revision-headers`)).revisions[0].documentKind).toBe(
    'opening',
  );
  const exact = await read(`/v1/posts/${post.id}/revisions/${first.revisions[0].revisionId}`);
  expect(exact.status).toBe(200);
  const body = (await exact.json()).post;
  expect(documentText(body.body)).toBe('Original chapter manuscript');
  expect(body.sha256).toBe(first.revisions[0].sha256);
  expect(await driver.inspectCommandCopies(post)).toEqual(before);
});

test('native disclosure applies to other viewers and an author needs container Access', async () => {
  const { board, post, path } = await fixture();
  const author = await page(path);
  for (const persona of ['anonymous', 'other'] as const) expect(await page(path, persona)).toEqual(author);
  await driver.protect(board);
  await driver.revokeCreatorReadAuthority(board);
  for (const persona of ['anonymous', 'author', 'other'] as const) {
    const response = await read(path, persona);
    expect(response.status).toBe(404);
    expect(response.headers.get(SESSION_HEADER)).toBeNull();
    expect(await response.text()).not.toContain(post.revision.id);
  }
  await driver.grantRead('author', board);
  expect((await page(path)).revisions[0].revisionId).toBe(post.revision.id);
});

test('erased history consumes its raw slot and cursors isolate projection, viewer, Post and epoch', async () => {
  const { thread, post, path } = await fixture();
  const later = await driver.edit(post, 'Retained current manuscript');
  await system.database.pool.query('UPDATE content.post SET author_erased=true WHERE route=$1 AND post_id=$2', [
    routeOf(post.id),
    post.id,
  ]);
  await system.database.pool.query(
    `UPDATE content.revision SET availability='erased',body=NULL,body_sha256=NULL,search_text=NULL
     WHERE route=$1 AND revision_id=$2`,
    [routeOf(post.id), post.revision.id],
  );
  const selection = spyOn(revisionPages, 'pageRevisionCandidates');
  let first;
  try {
    first = await page(`${path}?limit=1`);
    expect(selection).toHaveBeenCalledTimes(1);
  } finally {
    selection.mockRestore();
  }
  expect(first.revisions).toEqual([]);
  expect(first.next).toBeTruthy();
  const binding = {
    operation: 'content.revision-headers',
    parameters: { threadId: thread.id, postId: post.id, viewer: system.actors.author.actor.accountId },
  };
  const decoded = decodeCursor(system.tokenKeys, binding, first.next);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) throw new Error('Expected a valid header cursor');
  expect(decoded.after[1]).toBe(post.revision.id);
  const next = `${path}?limit=1&cursor=${encodeURIComponent(first.next)}`;
  expect((await page(next)).revisions.map((row: { revisionId: string }) => row.revisionId)).toEqual([later.id]);
  expect(await page(next)).toEqual(await page(next));
  for (const persona of ['anonymous', 'other'] as const) expect((await read(next, persona)).status).toBe(400);
  expect((await read(`/v1/posts/${post.id}/revisions?cursor=${encodeURIComponent(first.next)}`)).status).toBe(400);
  const full = await page(`/v1/posts/${post.id}/revisions?limit=1`);
  expect((await read(`${path}?cursor=${encodeURIComponent(full.next)}`)).status).toBe(400);
  const other = await fixture();
  expect((await read(`${other.path}?cursor=${encodeURIComponent(first.next)}`)).status).toBe(400);
  const stale = encodeCursor(system.tokenKeys, binding, { epoch: decoded.epoch + 1, after: decoded.after });
  for (const cursor of [stale, `${first.next}x`, 'malformed'])
    expect((await read(`${path}?cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
  for (const limit of [0, 101, 1.5]) expect((await read(`${path}?limit=${limit}`)).status).toBe(400);
});

test('head, Board, authority and epoch changes withhold the complete page and session, including empty selection', async () => {
  for (const change of ['head', 'board', 'authority', 'epoch'] as const) {
    const { board, post, path } = await fixture();
    if (change === 'authority') await driver.protect(post);
    const original = await system.database.pool.query<{ epoch: number }>(
      'SELECT epoch FROM core.partition WHERE partition_no=$1',
      [post.partition],
    );
    const select = revisionPages.pageRevisionCandidates;
    const observation = spyOn(revisionPages, 'pageRevisionCandidates').mockImplementationOnce(async (...args) => {
      const selected = await select(...args);
      if (change === 'head') await driver.edit(post, 'Changed after initial observation');
      if (change === 'board') await driver.protect(board);
      if (change === 'authority') await driver.revokeCreatorReadAuthority(post);
      if (change === 'epoch')
        await system.database.pool.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [
          post.partition,
        ]);
      return change === 'board' || change === 'epoch' ? { candidates: [], nextKey: null } : selected;
    });
    try {
      const response = await read(path);
      expect(response.status).toBe(404);
      expect(response.headers.get(SESSION_HEADER)).toBeNull();
      const body = await response.text();
      expect(body).not.toContain('revisions');
      expect(body).not.toContain(post.revision.id);
    } finally {
      observation.mockRestore();
      if (change === 'epoch')
        await system.database.pool.query('UPDATE core.partition SET epoch=$2 WHERE partition_no=$1', [
          post.partition,
          original.rows[0]!.epoch,
        ]);
    }
  }
});
