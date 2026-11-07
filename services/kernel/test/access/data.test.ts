import { afterAll, expect, test } from 'bun:test';
import pg, { type PoolClient } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(() => pool.end());

// Bytes 10 and 11 carry the account's 16-bit route, independently of its UUID suffix.
const actor = '00000000-0000-7000-8000-123400000001';
const organization = '00000000-0000-7000-8000-abcd00000002';
const person = '00000000-0000-7000-8000-ffff00000003';
const transaction = '00000000-0000-7000-8000-123400000004';
const route = 0x1234;
const organizationRoute = 0xabcd;

async function fixture(body: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await body(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function rejected(client: PoolClient, sql: string, values: unknown[] = [], code = '23514'): Promise<void> {
  await client.query('SAVEPOINT rejection');
  try {
    const error = await client.query(sql, values).then(
      () => null,
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ code });
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT rejection');
    await client.query('RELEASE SAVEPOINT rejection');
  }
}

async function accounts(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO access.account (route, account_id, kind, handle, display_name, state, transaction_id)
     VALUES ($1, $2, 'actor', 'automaton', 'Automaton', 'active', $5),
            ($3, $4, 'organization', 'collective', 'Collective', 'active', $5),
            (65535, $6, 'actor', 'person', 'Person', 'active', $5)`,
    [route, actor, organizationRoute, organization, transaction, person],
  );
}

test('account data permits only actors and organizations and prevents identity changes', async () => {
  await fixture(async (client) => {
    await accounts(client);
    const { readAccount } = await import('../../src/access/account-data.ts');
    expect(await readAccount(client, route, actor)).toMatchObject({ accountId: actor, kind: 'actor', route });
    expect(await readAccount(client, organizationRoute, organization)).toMatchObject({
      accountId: organization,
      kind: 'organization',
      route: organizationRoute,
    });
    expect(await readAccount(client, organizationRoute, actor)).toBeNull();
    expect(await readAccount(client, route, organization)).toBeNull();
    expect(await readAccount(client, route, transaction)).toBeNull();
    for (const kind of ['bot', 'application', 'person']) {
      await rejected(
        client,
        `INSERT INTO access.account (route, account_id, kind, transaction_id) VALUES ($1, $2, $3, $4)`,
        [route, transaction, kind, transaction],
      );
    }
    await rejected(
      client,
      `INSERT INTO access.account (route, account_id, kind, transaction_id) VALUES ($1, $2, 'actor', $3)`,
      [route, actor, transaction],
      '23505',
    );
    for (const wrongRoute of [-1, 65536, organizationRoute]) {
      await rejected(
        client,
        `INSERT INTO access.account (route, account_id, kind, transaction_id) VALUES ($1, $2, 'actor', $2)`,
        [wrongRoute, transaction],
      );
    }
    for (const assignment of [
      `account_id = '${transaction}'`,
      `kind = 'organization'`,
      `route = ${organizationRoute}`,
    ]) {
      await rejected(client, `UPDATE access.account SET ${assignment} WHERE route = $1 AND account_id = $2`, [
        route,
        actor,
      ]);
    }
    await client.query('UPDATE access.account SET display_name = $3 WHERE route = $1 AND account_id = $2', [
      route,
      actor,
      'Updated',
    ]);
    expect(await readAccount(client, route, actor)).toMatchObject({ displayName: 'Updated' });
  });
});

test('account private facts and operator stay on its own route', async () => {
  await fixture(async (client) => {
    await accounts(client);
    await client.query(
      `UPDATE access.account SET operator_account_id = $3, controller_id = $4, birth_date = '2000-02-29',
       content_preferences = '{"mature":false}', suspension_reason = 'Private reason', state = 'suspended'
       WHERE route = $1 AND account_id = $2`,
      [route, actor, organization, person],
    );
    const { readAccount } = await import('../../src/access/account-data.ts');
    expect(await readAccount(client, route, actor)).toMatchObject({
      operatorAccountId: organization,
      controllerId: person,
      birthDate: '2000-02-29',
      contentPreferences: { mature: false },
      suspensionReason: 'Private reason',
      state: 'suspended',
      minimumAuthnEpoch: 1n,
    });
    expect(await readAccount(client, organizationRoute, actor)).toBeNull();
    await rejected(client, 'UPDATE access.account SET operator_account_id = $3 WHERE route = $1 AND account_id = $2', [
      organizationRoute,
      organization,
      person,
    ]);
    await rejected(
      client,
      'UPDATE access.account SET operator_account_id = account_id WHERE route = $1 AND account_id = $2',
      [route, actor],
    );
    await rejected(
      client,
      `UPDATE access.account SET content_preferences = '[]' WHERE route = $1 AND account_id = $2`,
      [route, actor],
    );
    await client.query('UPDATE access.account SET operator_account_id = NULL WHERE route = $1 AND account_id = $2', [
      route,
      actor,
    ]);
    expect(await readAccount(client, route, actor)).toMatchObject({ operatorAccountId: null });
  });
});

test('account private facts and operator stay on its own route: lifecycle and monotonic authentication floor', async () => {
  await fixture(async (client) => {
    await accounts(client);
    const { readAccount } = await import('../../src/access/account-data.ts');
    for (const state of ['pending', 'active', 'suspended', 'deleted']) {
      await client.query('UPDATE access.account SET state = $3 WHERE route = $1 AND account_id = $2', [
        route,
        actor,
        state,
      ]);
      expect(await readAccount(client, route, actor)).toMatchObject({ state, minimumAuthnEpoch: 1n });
    }
    await rejected(client, `UPDATE access.account SET state = 'disabled' WHERE route = $1 AND account_id = $2`, [
      route,
      actor,
    ]);
    for (const floor of [0, -1]) {
      await rejected(
        client,
        'UPDATE access.account SET minimum_authn_epoch = $3 WHERE route = $1 AND account_id = $2',
        [route, actor, floor],
      );
    }
    await client.query(
      `UPDATE access.account SET minimum_authn_epoch = 9007199254740993, state = 'suspended'
      WHERE route = $1 AND account_id = $2`,
      [route, actor],
    );
    expect(await readAccount(client, route, actor)).toMatchObject({
      state: 'suspended',
      minimumAuthnEpoch: 9007199254740993n,
    });
    await client.query(
      'UPDATE access.account SET minimum_authn_epoch = minimum_authn_epoch WHERE route = $1 AND account_id = $2',
      [route, actor],
    );
    await rejected(client, 'UPDATE access.account SET minimum_authn_epoch = 1 WHERE route = $1 AND account_id = $2', [
      route,
      actor,
    ]);
  });
});

test('handle claims share a single namespace', async () => {
  await fixture(async (client) => {
    await accounts(client);
    // Handle claims route by the first two SHA-256 bytes of the ASCII normalized handle.
    const claim = `INSERT INTO access.handle_claim (route, normalized_handle, account_id, state, expires_at, reserved_until, transaction_id)
      SELECT get_byte(sha256(convert_to($1, 'UTF8')), 0) * 256 + get_byte(sha256(convert_to($1, 'UTF8')), 1),
      $1, $2::uuid, $3, $4::timestamptz, $5::timestamptz, $6::uuid`;
    await client.query(claim, ['shared', actor, 'active', null, null, transaction]);
    await rejected(client, claim, ['shared', organization, 'active', null, null, transaction], '23505');
    await client.query(claim, ['signup', transaction, 'pending', '2030-01-01', null, transaction]);
    await client.query(claim, ['old-handle', actor, 'reserved', null, '2030-02-01', transaction]);
    const { rows } = await client.query(`SELECT normalized_handle, account_id, state, expires_at IS NOT NULL AS expires,
      reserved_until IS NOT NULL AS reserved FROM access.handle_claim ORDER BY normalized_handle`);
    expect(rows).toEqual([
      { normalized_handle: 'old-handle', account_id: actor, state: 'reserved', expires: false, reserved: true },
      { normalized_handle: 'shared', account_id: actor, state: 'active', expires: false, reserved: false },
      { normalized_handle: 'signup', account_id: transaction, state: 'pending', expires: true, reserved: false },
    ]);
    for (const handle of ['SHARED', ' Shared', 'café', '', 'bad/name', 'trailing\n']) {
      await rejected(client, claim, [handle, organization, 'active', null, null, transaction]);
    }
    for (const [state, expires, reserved] of [
      ['pending', null, null],
      ['reserved', null, null],
      ['active', '2030-01-01', null],
      ['active', null, '2030-01-01'],
      ['unknown', null, null],
    ]) {
      await rejected(client, claim, ['invalid', actor, state, expires, reserved, transaction]);
    }
    await rejected(
      client,
      `INSERT INTO access.handle_claim (route, normalized_handle, account_id, state, transaction_id)
      VALUES (0, 'shared', $1, 'active', $2)`,
      [organization, transaction],
    );
    await rejected(client, `UPDATE access.account SET handle = 'SHARED' WHERE route = $1 AND account_id = $2`, [
      route,
      actor,
    ]);
    // Cleanup continuations have same-anchor foreign keys. No foreign key may
    // couple a handle, membership or account to a separately routed identity.
    const constraints = await client.query(`SELECT conrelid::regclass::text AS source,
      pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE connamespace = 'access'::regnamespace AND contype = 'f' ORDER BY source`);
    expect(constraints.rows).toEqual([
      {
        source: 'access.committed_continuation',
        definition: 'FOREIGN KEY (route, account_id) REFERENCES access.account(route, account_id)',
      },
      {
        source: 'access.operator_fence_page',
        definition:
          'FOREIGN KEY (route, continuation_id) REFERENCES access.committed_continuation(route, continuation_id)',
      },
    ]);
  });
});

test('account data permits only actors and organizations and prevents identity changes: organization roles are anchored and temporal', async () => {
  await fixture(async (client) => {
    await accounts(client);
    const insert = `INSERT INTO access.organization_member (route, organization_id, member_account_id, role, valid, transaction_id)
      VALUES ($1, $2, $3, $4, $5::tstzrange, $6)`;
    const interval = '[2026-01-01T00:00:00Z,2027-01-01T00:00:00Z)';
    await client.query(insert, [organizationRoute, organization, actor, 'owner', interval, transaction]);
    // The member need not exist locally: membership never joins the member's account partition.
    await client.query(insert, [organizationRoute, organization, transaction, 'member', interval, transaction]);
    const { readOrganizationRole } = await import('../../src/access/account-data.ts');
    const at = new Date('2026-06-01T00:00:00Z');
    expect(await readOrganizationRole(client, organizationRoute, organization, actor, at)).toBe('owner');
    expect(await readOrganizationRole(client, organizationRoute, organization, transaction, at)).toBe('member');
    expect(await readOrganizationRole(client, route, organization, actor, at)).toBeNull();
    expect(await readOrganizationRole(client, organizationRoute, actor, actor, at)).toBeNull();
    expect(await readOrganizationRole(client, organizationRoute, organization, person, at)).toBeNull();
    expect(
      await readOrganizationRole(client, organizationRoute, organization, actor, new Date('2027-01-01T00:00:00Z')),
    ).toBeNull();
    await rejected(client, insert, [organizationRoute, organization, actor, 'member', interval, transaction], '23P01');
    await client.query(insert, [organizationRoute, organization, actor, 'member', '[2027-01-01,)', transaction]);
    expect(
      await readOrganizationRole(client, organizationRoute, organization, actor, new Date('2027-01-01T00:00:00Z')),
    ).toBe('member');
    await rejected(client, insert, [organizationRoute, organization, person, 'admin', interval, transaction]);
    await rejected(client, insert, [organizationRoute, organization, person, 'member', 'empty', transaction]);
    await rejected(client, insert, [route, organization, person, 'member', interval, transaction]);
    const { rows } = await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = 'access.organization_member'::regclass AND contype = 'p'`);
    expect(rows[0]?.definition).toContain('WITHOUT OVERLAPS');
  });
});

test('public account reads expose operator and omit private facts', async () => {
  await fixture(async (client) => {
    await accounts(client);
    await client.query(
      `UPDATE access.account SET operator_account_id = $3, controller_id = $4, birth_date = '2000-02-29',
      content_preferences = '{"mature":false}', suspension_reason = 'Secret', minimum_authn_epoch = 42,
      avatar_url = 'https://example.com/avatar', biography = 'Public biography' WHERE route = $1 AND account_id = $2`,
      [route, actor, organization, person],
    );
    const { readPublicAccount } = await import('../../src/access/public-identity.ts');
    const visible = {
      accountId: actor,
      kind: 'actor',
      handle: 'automaton',
      displayName: 'Automaton',
      avatarUrl: 'https://example.com/avatar',
      biography: 'Public biography',
      state: 'active',
      operatorAccountId: organization,
    };
    expect(await readPublicAccount(client, route, actor)).toEqual(visible);
    expect(await readPublicAccount(client, 65535, person)).toEqual({
      accountId: person,
      kind: 'actor',
      handle: 'person',
      displayName: 'Person',
      avatarUrl: null,
      biography: null,
      state: 'active',
      operatorAccountId: null,
    });
    expect(await readPublicAccount(client, organizationRoute, organization)).toMatchObject({
      kind: 'organization',
      operatorAccountId: null,
    });
    expect(await readPublicAccount(client, organizationRoute, actor)).toBeNull();
    expect(await readPublicAccount(client, route, transaction)).toBeNull();
    for (const state of ['suspended', 'pending', 'deleted']) {
      await client.query('UPDATE access.account SET state = $3 WHERE route = $1 AND account_id = $2', [
        route,
        actor,
        state,
      ]);
      const result = await readPublicAccount(client, route, actor);
      if (state === 'pending') expect(result).toBeNull();
      else if (state === 'deleted') expect(result).toEqual({ accountId: actor, kind: 'actor', state: 'deleted' });
      else expect(result).toEqual({ ...visible, state });
    }
  });
});
