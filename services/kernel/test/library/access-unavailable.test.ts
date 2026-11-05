import { afterAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { AccessUnavailableError } from '../../src/access/index.ts';
import { createCollectionReads } from '../../src/library/collection-reads.ts';
import { fullMembers } from '../../src/library/views.ts';
import type { Access, Actor } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: url, max: 2 });
afterAll(() => pool.end());

const anonymous: Actor = { kind: 'anonymous' };
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(11)]]) };
const failure = new AccessUnavailableError('deadline');
const access = {
  async authorize() {
    throw failure;
  },
} as unknown as Access;

test('an Access failure in a Collection read is unavailability, not a denial', async () => {
  const reads = createCollectionReads({ pool, access, tokens });
  await expect(reads.readCollection(anonymous, newId(4096))).rejects.toBe(failure);
});

test('an Access failure in a FULL members read is unavailability, not a denial', async () => {
  await expect(
    fullMembers({ routeKey: new Uint8Array(32).fill(1), pool, access, tokens }, anonymous, newId(4096), {}),
  ).rejects.toBe(failure);
});
