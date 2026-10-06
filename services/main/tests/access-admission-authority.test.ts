import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import {
  AccessAdmissionRegistry,
  AdmissionDenied,
  AdmissionUnavailable,
} from '../src/modules/access/admission.ts';
import {
  authorityWitnessCurrent,
  authorityWitnessDeadline,
  captureAuthorityWitness,
  type AuthorityWitness,
} from '../src/modules/access/authority-witness.ts';
import { selectedRoleWorkProof } from '../src/modules/access/role-proof.ts';
import { selectedPrivateRoleWorkProof } from '../src/modules/access/private-recipient-proof.ts';

test('C1: a witness keeps the earliest expiry across its exact grant, representation and edge', async () => {
  const deadlines = {
    representation: new Date('2030-01-01T00:00:30Z'),
    permission_grant: new Date('2030-01-01T00:00:20Z'),
    representation_edge: new Date('2030-01-01T00:00:10Z'),
  };
  const client = {
    query: async (sql: string, values: string[]) => {
      const table = Object.keys(deadlines).find((name) => sql.includes(`FROM access.${name} `))!;
      return {
        rows: [
          {
            id: values[0],
            generation: '7',
            valid_until: deadlines[table as keyof typeof deadlines],
          },
        ],
      };
    },
  } as unknown as PoolClient;
  const witness = await captureAuthorityWitness(
    client,
    Object.keys(deadlines).map((table) => ({
      table: table as keyof typeof deadlines,
      id: table,
      generation: '7',
    })),
  );
  expect(witness.map((row) => row.validUntil).sort()).toEqual(
    Object.values(deadlines)
      .map((date) => date.toISOString())
      .sort(),
  );
  expect(authorityWitnessDeadline(witness)).toBe(deadlines.representation_edge.toISOString());
});

test('C1: infinite authority does not remove the thirty-second admission ceiling', async () => {
  const client = {
    query: async () => ({ rows: [{ id: 'unbounded', generation: '0', valid_until: Infinity }] }),
  } as unknown as PoolClient;
  const witness = await captureAuthorityWitness(client, [
    { table: 'representation', id: 'unbounded' },
  ]);
  expect(witness).toEqual([{ table: 'representation', id: 'unbounded', generation: '0' }]);
  expect(authorityWitnessDeadline(witness)).toBeNull();
});

test('C1: revalidation probes exact saved rows and live expiry even for older witnesses', async () => {
  const witness: AuthorityWitness[] = [{ table: 'permission_grant', id: 'saved', generation: '2' }];
  const queries: string[] = [];
  let current = true;
  const client = {
    query: async (sql: string, values: string[][]) => {
      queries.push(sql);
      expect(values).toEqual([['saved']]);
      return { rows: current ? [{ id: 'saved', generation: '2' }] : [] };
    },
  } as unknown as PoolClient;
  expect(await authorityWitnessCurrent(client, witness)).toBe(true);
  current = false;
  expect(await authorityWitnessCurrent(client, witness)).toBe(false);
  expect(
    queries.every(
      (sql) => sql.includes('valid_until > clock_timestamp()') && sql.includes('id = ANY'),
    ),
  ).toBe(true);
});

test('C1: unreadable witnesses are unavailable; absent or changed selected authority is denied', async () => {
  const unavailable = {
    query: async () => {
      throw new Error('connection lost');
    },
  } as unknown as PoolClient;
  const source = { table: 'permission_grant' as const, id: 'chosen', generation: '1' };
  await expect(captureAuthorityWitness(unavailable, [source])).rejects.toBeInstanceOf(
    AdmissionUnavailable,
  );
  await expect(authorityWitnessCurrent(unavailable, [source])).rejects.toBeInstanceOf(
    AdmissionUnavailable,
  );
  const absent = { query: async () => ({ rows: [] }) } as unknown as PoolClient;
  await expect(captureAuthorityWitness(absent, [source])).rejects.toBeInstanceOf(AdmissionDenied);
});

test('C1: witness capture rejects an authority path beyond its source-row bound', async () => {
  let reads = 0;
  const client = {
    query: async (_sql: string, values: string[]) => {
      reads++;
      return { rows: [{ id: values[0], generation: '0' }] };
    },
  } as unknown as PoolClient;
  await expect(
    captureAuthorityWitness(
      client,
      Array.from({ length: 17 }, (_, at) => ({
        table: 'permission_grant',
        id: String(at),
      })),
    ),
  ).rejects.toBeInstanceOf(AdmissionDenied);
  expect(reads).toBe(16);
});

test('C1: an unreachable Access store is unavailable at both admission boundaries', async () => {
  const pool = {
    connect: async () => {
      throw new Error('connection refused');
    },
  } as unknown as Pool;
  const registry = new AccessAdmissionRegistry(pool);
  await expect(
    registry.register({
      principal: { issuer: 'account', subject: 'principal' },
      actingSubject: 'agent',
      scope: 'work:create:root',
      action: 'work.create',
      idempotencyKey: 'unreachable',
      requestDigest: '0'.repeat(64),
    }),
  ).rejects.toBeInstanceOf(AdmissionUnavailable);
  await expect(registry.claim('admission', '0'.repeat(64))).rejects.toBeInstanceOf(
    AdmissionUnavailable,
  );
});

test('C1: selected role claims read only the saved binding and revision without rediscovering alternatives', async () => {
  const queries: string[] = [];
  const client = {
    query: async (sql: string, values: string[]) => {
      queries.push(sql);
      expect(sql).toContain('WHERE b.id = $1');
      expect(values[0]).toBe('chosen');
      return { rows: [{ id: 'chosen' }], rowCount: 1 };
    },
  } as unknown as PoolClient;
  const proof = {
    bindingId: 'chosen',
    bindingGeneration: '2',
    familyId: 'family',
    roleRevision: '4',
  };
  expect(await selectedRoleWorkProof(client, 'actor', proof)).toBe(true);
  expect(await selectedPrivateRoleWorkProof(client, 'principal', proof)).toBe(true);
  expect(queries).toHaveLength(2);
});
