import { expect, spyOn, test } from 'bun:test';
import { Client } from 'pg';
import { accountFixture } from './account-fixture.ts';
import { cleanupRevokedSessionPage } from '../src/first-party-session.ts';

async function queryCount<T>(work: () => Promise<T>) {
  let queries = 0;
  const query = Client.prototype.query;
  const spy = spyOn(Client.prototype, 'query').mockImplementation(function(this: Client, ...args: unknown[]) {
    queries++;
    return Reflect.apply(query, this, args);
  });
  try { return { result: await work(), queries }; }
  finally { spy.mockRestore(); }
}

test('maintenance rotates past a huge pending user and retries its failed page without starving unrelated users', async () => {
  const f = await accountFixture();
  try {
    const people = [await f.signup('fair-large@example.test'), await f.signup('fair-small@example.test')];
    const order = (await f.pool.query<{ id: string }>('SELECT id FROM "user" WHERE id = ANY($1::text[]) ORDER BY id',
      [people.map(person => person.id)])).rows;
    const huge = people.find(person => person.id === order[0]!.id)!;
    const small = people.find(person => person.id === order[1]!.id)!;
    const current = (await f.auth.api.getSession({ headers: new Headers({ cookie: huge.cookie }) }))!.session;
    await f.pool.query(`INSERT INTO "session" (id, "userId", token, "createdAt", "updatedAt", "expiresAt")
      SELECT 'fair-session-' || n, "userId", 'fair-token-' || n, now(), now(), "expiresAt"
      FROM "session", generate_series(1, 1500) n WHERE id = $1`, [current.id]);
    for (const person of [huge, small]) expect((await f.request('/api/auth/revoke-sessions', {}, person.cookie)).status).toBe(200);
    const sizes = (await f.pool.query<{ userId: string; size: number }>(`SELECT "userId" AS "userId", count(*)::integer AS size
      FROM "session" GROUP BY "userId"`)).rows;
    await f.pool.query(`CREATE TABLE fair_cleanup_writes (table_name text);
      CREATE FUNCTION record_fair_cleanup_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        INSERT INTO fair_cleanup_writes VALUES (TG_TABLE_NAME); RETURN NULL; END $$;
      CREATE FUNCTION fail_huge_cleanup_page() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF OLD.id LIKE 'fair-session-%' THEN RAISE EXCEPTION 'injected_fair_cleanup_failure'; END IF;
        RETURN OLD; END $$;
      CREATE TRIGGER fail_huge_cleanup_page BEFORE DELETE ON "session"
        FOR EACH ROW EXECUTE FUNCTION fail_huge_cleanup_page()`);
    for (const table of ['session', 'oauthAccessToken', 'oauthRefreshToken', 'rezics_account_pending_consent',
      'rezics_account_step_up', 'rezics_account_email_change', 'rezics_account_security_event', 'rezics_account_security']) {
      await f.pool.query(`CREATE TRIGGER record_fair_cleanup_write AFTER INSERT OR UPDATE OR DELETE ON "${table}"
        FOR EACH ROW EXECUTE FUNCTION record_fair_cleanup_write()`);
    }
    await expect(cleanupRevokedSessionPage(f.pool)).rejects.toThrow('injected_fair_cleanup_failure');
    expect((await f.pool.query('SELECT 1 FROM fair_cleanup_writes')).rowCount).toBe(0);
    expect((await f.pool.query(`SELECT "userId" AS "userId", count(*)::integer AS size FROM "session" GROUP BY "userId"`)).rows)
      .toEqual(sizes);
    await f.pool.query('DROP TRIGGER fail_huge_cleanup_page ON "session"');
    const second = await queryCount(() => cleanupRevokedSessionPage(f.pool));
    expect(second.queries).toBeLessThanOrEqual(24);
    expect(second.result).toMatchObject({ userId: small.id, pending: false });
    expect((await f.pool.query('SELECT 1 FROM "session" WHERE "userId" = $1', [small.id])).rowCount).toBe(0);
    expect((await f.pool.query('SELECT session_cleanup_pending FROM rezics_account_security WHERE user_id = $1', [huge.id]))
      .rows[0]).toEqual({ session_cleanup_pending: true });
    await f.pool.query('TRUNCATE fair_cleanup_writes');
    const third = await queryCount(() => cleanupRevokedSessionPage(f.pool));
    expect(third.queries).toBeLessThanOrEqual(24);
    expect(third.result).toMatchObject({ userId: huge.id, sessions: 100, pending: true });
    const writes = (await f.pool.query<{ table_name: string; size: number }>(`SELECT table_name, count(*)::integer AS size
      FROM fair_cleanup_writes GROUP BY table_name`)).rows;
    for (const row of writes) expect(row.size).toBeLessThanOrEqual(
      ['rezics_account_security', 'rezics_account_email_change'].includes(row.table_name) ? 1 : 100);
    expect(await f.auth.api.getSession({ headers: new Headers({ cookie: huge.cookie }) })).toBeNull();
  } finally { await f.close(); }
}, 60_000);
