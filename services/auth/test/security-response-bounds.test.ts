import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { securityResponseByteBudgets, securityScopeLimit, securityJsonStringBytes } from '@rezics/auth-contract';
import { composeSecurityPage } from '../src/security-page.ts';
import { securityPasskey } from '../src/security-response-bounds.ts';
import { securityInventory } from '../src/security-inventory.ts';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const id = '\u0000'.repeat(1024),
  label = '\u0000'.repeat(100);
const now = Date.now();
const date = new Date(now).toISOString();
const viewer = {
  account_id: id,
  session_id: id,
  client_id: id,
  now: now / 1000,
  fresh: true,
  credentialCommands: true,
  passwordCommands: true,
};
const session = {
  id,
  client_id: id,
  client_display_name: label,
  created_at: date,
  expires_at: new Date(now + 60000),
  user_agent: '\u0000'.repeat(512),
};
const key = { id, name: '\u0000'.repeat(128), created_at: date, last_used_at: date, secret: 'must not escape' };
const pool = (sessions: unknown[], passkeys: unknown[]) =>
  ({
    query: async (sql: string) => ({
      rows: sql.includes('FROM session') ? sessions : sql.includes('FROM passkey') ? passkeys : [],
    }),
  }) as unknown as Pool;

test('escaped native maxima fit field-derived budgets and projections discard extra columns', async () => {
  const page = await composeSecurityPage(
    pool(
      Array.from({ length: 65 }, (_, i) => ({
        ...session,
        id: i === 0 ? id : id.slice(0, -3) + String(i).padStart(3, '0'),
      })),
      Array.from({ length: 33 }, (_, i) => ({ ...key, id: id.slice(0, -3) + String(i).padStart(3, '0') })),
    ),
    viewer,
  );
  expect(page.sessions.kind).toBe('ready');
  expect(page.passkeys.kind).toBe('ready');
  expect(page.sessions.kind === 'ready' && page.sessions.rows).toHaveLength(64);
  expect(page.actions.register_passkey).toBe('capacity');
  expect(bytes(page)).toBeLessThanOrEqual(securityResponseByteBudgets(1000).securityPage);
  const projected = securityPasskey(key);
  expect(Object.keys(projected)).toEqual(['id', 'name', 'created_at', 'last_used_at']);
  expect(bytes({ passkeys: Array(32).fill(projected) })).toBeLessThanOrEqual(
    securityResponseByteBudgets(1000).passkeys,
  );
  for (const value of ['\u0000', '\ud800', '😀', '"', '\\'])
    expect(bytes(value.repeat(128))).toBeLessThanOrEqual(securityJsonStringBytes(value.repeat(128).length));
});

test('oversized historical display metadata preserves exact identity, credential decisions and independent availability', async () => {
  const page = await composeSecurityPage(
    pool(
      [{ ...session, user_agent: 'x'.repeat(513), client_display_name: 'x'.repeat(101) }],
      [{ ...key, name: 'x'.repeat(129) }],
    ),
    viewer,
  );
  expect(page.sessions.kind === 'ready' && page.sessions.rows[0]).toMatchObject({
    id,
    current: true,
    user_agent: null,
    client_display_name: null,
    revoke: 'allowed',
  });
  expect(page.passkeys.kind === 'ready' && page.passkeys.rows[0]).toMatchObject({
    id,
    name: '',
    remove: 'last-credential',
  });
  const invalid = await composeSecurityPage(pool([{ ...session, client_id: 'x'.repeat(1025) }], [key]), viewer);
  expect(invalid.sessions).toEqual({ kind: 'unavailable' });
  expect(invalid.passkeys.kind).toBe('ready');
  const invalidDate = await composeSecurityPage(pool([session], [{ ...key, created_at: null }]), viewer);
  expect(invalidDate.passkeys).toEqual({ kind: 'unavailable' });
  expect(invalidDate.sessions.kind).toBe('ready');
});

test('catalogue growth retains every configured scope on selected clients and consents pages', async () => {
  const scopes = Array.from({ length: 1200 }, (_, i) => `action:${i}`);
  const ceiling = securityScopeLimit(scopes);
  expect(ceiling).toBe(1203);
  expect(securityScopeLimit()).toBe(1000);
  const proof = {
    account_id: id,
    client_id: id,
    scope: Array(ceiling).fill('x'.repeat(128)),
    authn_epoch: Number.MAX_SAFE_INTEGER,
    auth_time: Number.MAX_SAFE_INTEGER,
    amr: ['private_key_jwt'],
  };
  expect(bytes(proof)).toBeLessThanOrEqual(securityResponseByteBudgets(ceiling).session);
  expect(securityResponseByteBudgets(ceiling).clients).toBeGreaterThan(securityResponseByteBudgets(512).clients);
  const rows = Array.from({ length: 21 }, (_, i) => ({
    client_id: `client-${i}`,
    display_name: label,
    disabled: false,
    first_party: false,
    scopes,
    pending_scopes: null,
    ready: true,
    reducing: false,
    erasure_fenced: false,
  }));
  const connection = {
    release() {},
    async query(sql: string, args?: unknown[]) {
      if (sql.includes('disabled=false')) return { rowCount: 1, rows: [] };
      if (sql.includes('LIMIT $3')) {
        expect(args?.[2]).toBe(21);
        return { rows };
      }
      return { rows: sql.includes('ANY') ? rows : [] };
    },
  };
  const inventory = securityInventory(
    { connect: async () => connection } as unknown as Pool,
    'persistent-test-secret',
    'https://auth.test',
    () => 1000,
    ceiling,
  );
  const binding = { accountId: 'owner', sessionId: 'session', clientId: 'login', epoch: 1, scopes: [] };
  const clients = await inventory.clients(binding, { limit: 20 });
  const consents = await inventory.consents(binding, { limit: 20 });
  expect(clients.clients).toHaveLength(20);
  expect(consents.consents).toHaveLength(20);
  expect(clients.clients[0]!.scopes).toHaveLength(1200);
  expect(consents.consents[0]!.granted).toHaveLength(1200);
  expect(new Set(consents.consents[0]!.granted)).toEqual(new Set(scopes));
  expect(clients.next).toBeString();
  expect(bytes(clients)).toBeLessThanOrEqual(securityResponseByteBudgets(ceiling).clients);
  expect(bytes(consents)).toBeLessThanOrEqual(securityResponseByteBudgets(ceiling).consents);
});

test('budget arithmetic refuses unsafe or nonfinite configuration rather than producing a cap', () => {
  for (const count of [-1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER])
    expect(() => securityResponseByteBudgets(count)).toThrow(RangeError);
  expect(() => securityResponseByteBudgets(1000, 101)).toThrow(RangeError);
});
