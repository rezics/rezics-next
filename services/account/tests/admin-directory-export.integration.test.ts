import { expect, test } from 'bun:test';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';

test('G411 admin download users: the filtered directory as safe CSV across pages, audited with its filters', async () => {
  const f = await accountFixture();
  try {
    const { owner } = await oauthFixture(f);
    const member = await f.signup('member@example.test');
    const support = await f.signup('support@example.test');
    const outsider = await f.signup('outsider@example.test');
    const promote = await f.request(`/api/account/admin/operators/${support.id}`, { role: 'support', reason: 'Support rotation' },
      owner.cookie);
    expect(promote.status).toBe(200);
    // More users than one export page, and a name a spreadsheet would run as a formula.
    await f.pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      SELECT 'bulk-' || n, 'Bulk ' || n, 'bulk-' || n || '@example.test', n % 2 = 0, now() - n * interval '1 second', now()
      FROM generate_series(1, 1200) n`);
    await f.pool.query(`UPDATE "user" SET name = '=HYPERLINK("x")' WHERE id = $1`, [member.id]);
    const download = (query: string, cookie: string) => f.request(`/api/account/admin/users/export?${query}`, undefined, cookie);

    expect((await download('', outsider.cookie)).status).toBe(403);
    const all = await download('sort=email&direction=asc', support.cookie);
    expect(all.status).toBe(200);
    expect(all.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(all.headers.get('content-disposition')).toMatch(/^attachment; filename="rezics-account-users-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(all.headers.get('x-rezics-rows')).toBe('1204');
    expect(all.headers.get('x-rezics-truncated')).toBe('false');
    // A byte-order mark lets spreadsheets read CJK names as UTF-8 (text() drops it).
    const bytes = new Uint8Array(await all.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith('id,name,email,status,role,email_verified,two_step,created_at,last_sign_in_at')).toBe(true);
    const lines = text.trimEnd().split('\r\n');
    expect(lines).toHaveLength(1205);
    // Sorted as asked, every user once, and no cell a spreadsheet would evaluate.
    const emails = lines.slice(1).map(line => line.split(',')[2]!.slice(1, -1));
    expect(emails).toEqual([...emails].sort());
    expect(new Set(emails).size).toBe(1204);
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(text).toContain(`"support","true","false"`);

    const unverified = await download('verified=false&q=bulk', owner.cookie);
    expect(unverified.headers.get('x-rezics-rows')).toBe('600');
    expect(await unverified.text()).not.toContain('"bulk-2"');
    expect((await download('status=bogus', owner.cookie)).status).toBe(400);

    const audit = await f.pool.query<{ actor_id: string; after_summary: { rows: number; truncated: boolean;
      filters: { verified: boolean | null; q: string | null } } }>(`SELECT actor_id, after_summary
      FROM rezics_account_operator_audit WHERE action = 'users_exported' ORDER BY occurred_at`);
    expect(audit.rows.map(row => [row.actor_id, row.after_summary.rows, row.after_summary.filters.verified])).toEqual([
      [support.id, 1204, null], [owner.id, 600, false]]);
    expect(audit.rows[1]!.after_summary).toMatchObject({ truncated: false, filters: { q: 'bulk' } });
  } finally { await f.close(); }
}, 60_000);
