import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import pg from 'pg';
import { newId } from '../../src/route/route.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(() => pool.end());
const route = 0x1234;
const author = newId(0x5678);
const board = newId(0x9abc);
const subject = newId(0xdef0);
const transaction = randomUUID();
const bytes = (text: string) =>
  Buffer.from(
    canonicalize({
      version: 'rezics-document-v1',
      profile: 'text',
      doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
    })!,
  );
const digest = (body: Buffer) => createHash('sha256').update(body).digest();

async function fixture(work: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    // The board, account and subject references need no rows in another module.
    await client.query(
      `INSERT INTO content.board (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
       VALUES ($1, $2, $3, 'Books', 'public', 1, $4)`,
      [0x9abc, board, subject, transaction],
    );
    await work(client);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function rejected(client: pg.PoolClient, work: () => Promise<unknown>, constraint?: string): Promise<void> {
  await client.query('SAVEPOINT rejection');
  const error = await work().catch((caught: unknown) => caught);
  await client.query('ROLLBACK TO SAVEPOINT rejection');
  expect(error).toMatchObject({ code: constraint ? '23514' : expect.stringMatching(/^235(?:03|14)$/) });
  if (constraint) expect(error).toMatchObject({ constraint });
}

async function thread(client: pg.PoolClient, thread_id = newId(route)) {
  const { default: insert } = await import('../../src/content/insert-thread.sql');
  await insert.run(client, {
    route,
    thread_id,
    author_account_id: author,
    board_id: board,
    title: 'Kokoro',
    visibility: 'public',
    security_revision: 1,
    transaction_id: transaction,
  });
  return thread_id;
}

async function post(client: pg.PoolClient, thread_id: string, reply_to_post_id: string | null = null) {
  const { default: insert } = await import('../../src/content/insert-post.sql');
  const post_id = newId(route);
  const revision_id = newId(route);
  await insert.run(client, {
    route,
    thread_id,
    post_id,
    reply_to_post_id,
    author_account_id: author,
    head_revision_id: revision_id,
    visibility: 'public',
    security_revision: 1,
    transaction_id: transaction,
  });
  return { post_id, revision_id };
}

async function revision(
  client: pg.PoolClient,
  thread_id: string,
  post_id: string,
  revision_id: string,
  body = bytes('First edition'),
) {
  const { default: insert } = await import('../../src/content/insert-revision.sql');
  await insert.run(client, {
    route,
    thread_id,
    post_id,
    revision_id,
    body,
    body_sha256: digest(body),
    search_text: 'First edition',
    licence: 'CC-BY-SA-4.0',
    subject_ids: [subject],
    board_id: board,
    availability: 'available',
    transaction_id: transaction,
  });
}

async function read(
  client: pg.PoolClient,
  thread_id: string,
  post_id: string,
  revision_id: string,
  selectedRoute = route,
) {
  const { default: select } = await import('../../src/content/read-revision.sql');
  return select.run(client, { route: selectedRoute, thread_id, post_id, revision_id });
}

test('canonical document storage enforces digest and size in PostgreSQL', async () => {
  await fixture(async (client) => {
    const thread_id = await thread(client);
    const ids = await post(client, thread_id);
    const body = bytes('First edition');
    await revision(client, thread_id, ids.post_id, ids.revision_id, body);
    expect(await read(client, thread_id, ids.post_id, ids.revision_id)).toMatchObject([
      {
        ...ids,
        thread_id,
        route,
        body,
        body_sha256: digest(body),
        search_text: 'First edition',
        licence: 'CC-BY-SA-4.0',
        subject_ids: [subject],
        board_id: board,
        availability: 'available',
        recorded_transaction_id: transaction,
      },
    ]);
    await rejected(
      client,
      () =>
        client.query(
          `INSERT INTO content.revision SELECT route, thread_id, post_id, $1, body, $2, search_text,
       licence, subject_ids, board_id, availability, recorded_transaction_id, recorded_at
       FROM content.revision WHERE route = $3 AND revision_id = $4`,
          [newId(route), digest(bytes('Wrong digest')), route, ids.revision_id],
        ),
      'revision_body_sha256_matches',
    );
    const oversized = bytes('x'.repeat(2 * 1024 * 1024));
    await rejected(
      client,
      () => revision(client, thread_id, ids.post_id, newId(route), oversized),
      'revision_body_size_limit',
    );
    const overhead = bytes('').length;
    const maximum = bytes('x'.repeat(2 * 1024 * 1024 - overhead));
    expect(maximum.length).toBe(2 * 1024 * 1024);
    await revision(client, thread_id, ids.post_id, newId(route), maximum);
    const { rows } = await client.query(
      `SELECT attcompression FROM pg_attribute WHERE attrelid = 'content.revision'::regclass AND attname = 'body'`,
    );
    expect(rows).toEqual([{ attcompression: 'l' }]);
  });
});

test('content containment and revisions preserve thread route', async () => {
  await fixture(async (client) => {
    const thread_id = await thread(client);
    const root = await post(client, thread_id);
    await revision(client, thread_id, root.post_id, root.revision_id);
    const reply = await post(client, thread_id, root.post_id);
    await revision(client, thread_id, reply.post_id, reply.revision_id);
    const previous = await read(client, thread_id, root.post_id, root.revision_id);
    const next = newId(route);
    await revision(client, thread_id, root.post_id, next, bytes('Second edition'));
    expect(await read(client, thread_id, root.post_id, root.revision_id)).toEqual(previous);
    expect(await read(client, thread_id, root.post_id, next)).toMatchObject([
      { revision_id: next, body: bytes('Second edition') },
    ]);
    expect(await read(client, thread_id, root.post_id, next, route + 1)).toEqual([]);
    const otherThread = await thread(client);
    expect(await read(client, otherThread, root.post_id, next)).toEqual([]);
    await rejected(client, () => post(client, otherThread, root.post_id));
    await rejected(client, () => thread(client, newId(route + 1)));
    await rejected(client, () => revision(client, thread_id, root.post_id, newId(route + 1)));
    await rejected(client, () => revision(client, otherThread, root.post_id, newId(route)));
    await rejected(client, () => post(client, newId(route + 1)));
    await rejected(client, () =>
      client
        .query('UPDATE content.post SET head_revision_id = $3 WHERE route = $1 AND post_id = $2', [
          route,
          reply.post_id,
          next,
        ])
        .then(() => client.query('SET CONSTRAINTS ALL IMMEDIATE')),
    );
    const { rows } = await client.query(
      `SELECT t.thread_id, t.board_id, t.author_account_id, t.title, t.visibility, t.security_revision,
       p.reply_to_post_id FROM content.thread t JOIN content.post p USING (route, thread_id)
       WHERE t.route = $1 AND t.thread_id = $2 AND p.post_id = $3`,
      [route, thread_id, reply.post_id],
    );
    expect(rows).toEqual([
      {
        thread_id,
        board_id: board,
        author_account_id: author,
        title: 'Kokoro',
        visibility: 'public',
        security_revision: '1',
        reply_to_post_id: root.post_id,
      },
    ]);
  });
});

test('revisions are immutable except explicit erasure retaining the original hash and identity', async () => {
  await fixture(async (client) => {
    const thread_id = await thread(client);
    const ids = await post(client, thread_id);
    await revision(client, thread_id, ids.post_id, ids.revision_id);
    const where = 'WHERE route = $1 AND revision_id = $2';
    const key = [route, ids.revision_id];
    for (const change of [
      "search_text = 'rewritten'",
      "licence = 'CC0-1.0'",
      'body = NULL, search_text = NULL',
      "availability = 'erased'",
      'body_sha256 = sha256(body || body)',
      'revision_id = $3',
    ]) {
      await rejected(client, () =>
        client.query(
          `UPDATE content.revision SET ${change} ${where}`,
          change.includes('$3') ? [...key, newId(route)] : key,
        ),
      );
    }
    await rejected(client, () => client.query(`DELETE FROM content.revision ${where}`, key));
    await client.query(
      `UPDATE content.revision SET body = NULL, search_text = NULL, availability = 'erased' ${where}`,
      key,
    );
    expect(await read(client, thread_id, ids.post_id, ids.revision_id)).toMatchObject([
      { ...ids, body: null, search_text: null, availability: 'erased', body_sha256: digest(bytes('First edition')) },
    ]);
    await rejected(client, () =>
      client.query(`UPDATE content.revision SET body_sha256 = $3 ${where}`, [...key, digest(bytes('Replacement'))]),
    );
    await rejected(client, () =>
      client.query(
        `UPDATE content.revision SET body = $3, search_text = 'First edition', availability = 'available' ${where}`,
        [...key, bytes('First edition')],
      ),
    );
  });
});
