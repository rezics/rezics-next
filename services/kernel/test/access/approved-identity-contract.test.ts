import { afterAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import {
  APPROVAL_REFERENCE_PURPOSE,
  ApprovalIdentityDeniedError,
  ApprovalIdentityUnavailableError,
  readApprovedIdentity,
} from '../../src/access/approved-identity.ts';
import { createAccess } from '../../src/access/index.ts';
import type { Access } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { seal } from '../../src/tokens/seal.ts';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const keys = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
const access = createAccess({
  actions: new Map(),
  auth: {
    issuer: 'https://approval-identity.test',
    audience: 'https://api.approval-identity.test',
    jwksUrl: 'https://approval-identity.test/jwks',
  },
});

test('malformed and missing native approval references are forbidden', async () => {
  const id = newId(0);
  const missing = seal(keys, APPROVAL_REFERENCE_PURPOSE, { route: routeOf(id), id, binding: 'missing' });
  for (const reference of ['invalid', 'x'.repeat(4097), missing]) {
    const read = readApprovedIdentity(access, keys, reference, { pool, deadline: Date.now() + 5000 });
    await expect(read).rejects.toBeInstanceOf(ApprovalIdentityDeniedError);
    await expect(read).rejects.toHaveProperty('status', 403);
  }
});

test('missing approval identity bridge remains unavailable', async () => {
  const read = readApprovedIdentity({} as Access, keys, 'reference', { pool, deadline: Date.now() + 5000 });
  await expect(read).rejects.toBeInstanceOf(ApprovalIdentityUnavailableError);
  await expect(read).rejects.toHaveProperty('status', 503);
});
