import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { readAgentPages } from '../../src/access/account-data.ts';
import type { Access } from '../../src/request/access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const kernel = createKernel({ pool, routeKey: new Uint8Array(32).fill(29) });
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(41)]]) };
const created = '2000-01-01T00:00:00.123456Z';
const seeded: Array<{ id: string; handle: string; kind: string }> = [];
const firstViewer = newId(23);
const secondViewer = newId(23);
const viewerAccess: Access = {
  async authenticate(token) {
    return {
      kind: 'account',
      accountId: token === 'first-viewer' ? firstViewer : secondViewer,
      clientId: 'agent-pages-test',
      scopes: [],
      requestedBy: null,
      authnEpoch: 1,
    };
  },
  async authorize() {
    return true;
  },
};
const viewerKernel = createKernel({ pool, routeKey: new Uint8Array(32).fill(30), access: viewerAccess });

function expectOpaqueCursor(token: string, after: readonly (string | number)[]) {
  expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  const decoded = Buffer.from(token, 'base64url').toString('utf8');
  for (const value of after.filter((item): item is string => typeof item === 'string')) {
    expect(token).not.toContain(value);
    expect(decoded).not.toContain(value);
  }
  const serialized = JSON.stringify(after);
  expect(token).not.toContain(serialized);
  expect(decoded).not.toContain(serialized);
}

async function getPage(path: string, bearer?: string) {
  return viewerKernel.handle(
    new Request(`http://kernel${path}`, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
  );
}
async function insert(
  route: number,
  state = 'active',
  fenced = false,
  handle: string | null = `agent_${newId(route).replaceAll('-', '')}`,
  kind = 'actor',
) {
  const id = newId(route);
  await pool.query(
    `INSERT INTO access.account(route, account_id, kind, state, authn_fenced, handle, transaction_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$2,$7)`,
    [route, id, kind, state, fenced, handle, created],
  );
  return id;
}
beforeAll(async () => {
  for (const [route, kind] of [
    [65535, 'organization'],
    [0, 'actor'],
    [23, 'actor'],
    [23, 'organization'],
  ] as const) {
    const id = await insert(route, 'active', false, undefined, kind);
    const result = await pool.query('SELECT handle FROM access.account WHERE route=$1 AND account_id=$2', [route, id]);
    seeded.push({ id, handle: result.rows[0].handle, kind });
  }
  for (const state of ['pending', 'suspended', 'deleted']) await insert(0, state);
  await insert(0, 'active', true);
  await insert(0, 'active', false, null);
});
afterAll(async () => pool.end());

test('agent pages README states the 1000 entry server-to-server sitemap exception to the shared maximum of 100', () => {
  const readme = readFileSync(new URL('../../src/access/README.md', import.meta.url), 'utf8');
  const section = readme.split('## Agent pages\n')[1]!.split('\n## ')[0]!;
  expect(section).toContain('1,000 entry page limit');
  expect(section).toContain('server-to-server sitemap exception to the shared list maximum of 100');
});

test('agent pages list exactly active unfenced handles in opaque keyset order', async () => {
  const expected = seeded.toSorted((a, b) => routeOf(a.id)! - routeOf(b.id)! || a.id.localeCompare(b.id));
  const found = [];
  let cursor: string | undefined;
  do {
    const response = await kernel.handle(
      new Request(`http://kernel/v1/agent-pages?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
    );
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.agentPages).toHaveLength(1);
    expect(Object.keys(page).sort()).toEqual(['agentPages', 'next']);
    found.push(...page.agentPages);
    cursor = page.next ?? undefined;
  } while (cursor);
  expect(found).toEqual(
    expected.map(({ handle, kind }) => ({ handle, kind, lastModified: '2000-01-01 00:00:00.123456+00' })),
  );
  expect((await readAgentPages(pool, tokens, {})).agentPages).toHaveLength(4);
});

test('agent pages cursors hide their after-keys and bind the feed query and viewer', async () => {
  const anonymous = await getPage('/v1/agent-pages?limit=1');
  expect(anonymous.status).toBe(200);
  const anonymousPage = await anonymous.json();
  const after = seeded
    .toSorted((a, b) => routeOf(a.id)! - routeOf(b.id)! || a.id.localeCompare(b.id))
    .slice(0, 1)
    .map(({ id }) => id);
  expect(anonymousPage.next).toEqual(expect.any(String));
  expectOpaqueCursor(anonymousPage.next, [routeOf(after[0]!)!, after[0]!]);
  expect(
    (await getPage(`/v1/agent-pages?limit=1&cursor=${encodeURIComponent(anonymousPage.next)}`, 'first-viewer')).status,
  ).toBe(400);

  const accountPageResponse = await getPage('/v1/agent-pages?limit=1', 'first-viewer');
  expect(accountPageResponse.status).toBe(200);
  const accountPage = await accountPageResponse.json();
  expect(accountPage.next).toEqual(expect.any(String));
  expectOpaqueCursor(accountPage.next, [routeOf(after[0]!)!, after[0]!]);
  expect(
    (await getPage(`/v1/agent-pages?limit=1&cursor=${encodeURIComponent(accountPage.next)}`, 'second-viewer')).status,
  ).toBe(400);
  expect((await getPage(`/v1/agent-pages?limit=1&cursor=${encodeURIComponent(accountPage.next)}`)).status).toBe(400);
  expect(
    (await getPage(`/v1/agent-pages?limit=2&cursor=${encodeURIComponent(accountPage.next)}`, 'first-viewer')).status,
  ).toBe(400);
});

test('agent pages refuse tampered cursors and limits outside 1 through 1000', async () => {
  const response = await kernel.handle(new Request('http://kernel/v1/agent-pages?limit=1'));
  const { next } = await response.json();
  expect(typeof next).toBe('string');
  const changed = `${next[0] === 'a' ? 'b' : 'a'}${next.slice(1)}`;
  for (const query of [`cursor=${encodeURIComponent(changed)}`, 'limit=0', 'limit=1001', 'limit=-1', 'limit=1.5']) {
    const response = await kernel.handle(new Request(`http://kernel/v1/agent-pages?${query}`));
    expect(response.status).toBe(400);
  }
  expect((await kernel.handle(new Request('http://kernel/v1/agent-pages?limit=1000'))).status).toBe(200);
});

test('every public identity column advances public change time and private columns preserve it', async () => {
  const read = readFileSync(new URL('../../src/access/account-public-read.sql', import.meta.url), 'utf8').split(
    'FROM',
  )[0]!;
  const columns = (
    await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='access' AND table_name='account'",
    )
  ).rows.map(({ column_name }) => column_name);
  const publicColumns = columns.filter((column) => new RegExp(`\\b${column}\\b`).test(read));
  const immutable = ['account_id', 'kind', 'route', 'created_at'];
  const changes: Record<string, string> = {
    state: "state='suspended'",
    authn_fenced: 'authn_fenced=true',
    handle: "handle='changed_handle'",
    display_name: "display_name='Changed'",
    avatar_url: "avatar_url='https://example.com/avatar'",
    biography: "biography='Changed'",
    avatar: `avatar='${newId(23)}'`,
    public_views: `public_views='{"posts":false,"reviews":true,"collections":true,"realms":false}'`,
    speakers_listed: 'speakers_listed=true',
    links: `links='[{"label":"Site","url":"https://example.com"}]'`,
    operator_account_id: `operator_account_id='${newId(23)}'`,
    agent_verified: `agent_verified=true, agent_subject_id='${newId(23)}', agent_verification_receipt_id='${newId(23)}'`,
    agent_subject_id: `agent_subject_id='${newId(23)}'`,
    controller_id: `controller_id='${newId(23)}'`,
    birth_date: "birth_date='2000-01-01'",
    content_preferences: `content_preferences='{"private":true}'`,
    suspension_reason: "suspension_reason='Private'",
    minimum_authn_epoch: 'minimum_authn_epoch=2',
    transaction_id: `transaction_id='${newId(23)}'`,
    registration_id: `registration_id='${newId(23)}'`,
    registration_expires_at: "registration_expires_at='2030-01-01'",
    fence_receipt_id: `fence_receipt_id='${newId(23)}'`,
    operator_relation_version: 'operator_relation_version=operator_relation_version',
    operator_reservation_id: `operator_reservation_id='${newId(23)}'`,
    membership_inverse_complete: 'membership_inverse_complete=NOT membership_inverse_complete',
    handle_operation_id: "handle_operation_id='private'",
    handle_change_times: "handle_change_times=ARRAY['2030-01-01'::timestamptz]",
    rate_tier: "rate_tier='trusted'",
    agent_verification_receipt_id: `agent_verification_receipt_id='${newId(23)}'`,
    pending_agent_subject_id: `pending_agent_subject_id='${newId(23)}', pending_agent_receipt_id='${newId(23)}'`,
    pending_agent_receipt_id: `pending_agent_subject_id='${newId(23)}', pending_agent_receipt_id='${newId(23)}'`,
    public_changed_at: "public_changed_at='2090-01-01'",
  };
  for (const column of columns.filter((column) => !immutable.includes(column))) {
    expect(changes[column], `Missing mutation for ${column}`).toBeDefined();
    const id = await insert(23);
    if (column === 'agent_subject_id' || column === 'agent_verification_receipt_id') {
      // Establish a valid verified account while retaining the old baseline time.
      await pool.query(`UPDATE access.account SET ${changes.agent_verified} WHERE route=23 AND account_id=$1`, [id]);
    }
    const before = await pool.query(
      'SELECT public_changed_at::text AS at FROM access.account WHERE route=23 AND account_id=$1',
      [id],
    );
    await pool.query(`UPDATE access.account SET ${changes[column]} WHERE route=23 AND account_id=$1`, [id]);
    const after = await pool.query(
      'SELECT public_changed_at::text AS at FROM access.account WHERE route=23 AND account_id=$1',
      [id],
    );
    expect(after.rows[0].at !== before.rows[0].at, column).toBe(publicColumns.includes(column));
    const unchanged = await pool.query(
      `UPDATE access.account SET display_name=display_name WHERE route=23 AND account_id=$1 RETURNING public_changed_at::text AS at`,
      [id],
    );
    expect(unchanged.rows[0].at).toBe(after.rows[0].at);
  }
});

test('migration backfills public change time from creation for existing accounts', async () => {
  const migration = readFileSync(
    new URL('../../db/access/migrations/20261027065707_agent_pages.sql', import.meta.url),
    'utf8',
  );
  const [up, down] = migration.split('-- migrate:down');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(down!);
    const id = newId(23);
    await client.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id,created_at)
      VALUES (23,$1,'actor','active',$1,$2)`,
      [id, created],
    );
    await client.query(up!.replace('-- migrate:up', ''));
    const result = await client.query(
      'SELECT public_changed_at = created_at AS same FROM access.account WHERE route=23 AND account_id=$1',
      [id],
    );
    expect(result.rows[0].same).toBe(true);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
