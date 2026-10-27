import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PROFILE_FORMAT, profileDigest, type CompositionDocument, type PresentationProfile } from '@rezics/composition';
import { createPool } from '../../src/database/pool.ts';
import {
  activateProfile,
  activeProfile,
  bootstrapProfile,
  ProfileAccessDeniedError,
  ProfileInputError,
  ProfileNotFoundError,
  publishProfile,
  readProfile,
  StaleProfileHeadError,
} from '../../src/presentation/profiles.ts';
import type { AccountActor } from '../../src/request/access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const actor: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-c0a7e0000001',
  clientId: 'web',
  scopes: [],
  requestedBy: null,
  authnEpoch: 1,
};
const options = (allowed = true) => ({
  actor,
  idempotencyKey: randomUUID(),
  digest: new Uint8Array(32).fill(4),
  authorize: async () => allowed,
});
const profile = (text: string): PresentationProfile => ({
  format: PROFILE_FORMAT,
  generic: { root: { props: {} }, content: [{ type: 'Heading', props: { id: 'title', text, level: 2 } }] },
  bases: [],
  types: [],
  routes: [],
});
const first = profile('First');
const second = profile('Second');
const firstDigest = profileDigest(first);
const secondDigest = profileDigest(second);
async function count(table: string): Promise<number> {
  const { rows } = await admin.query(`SELECT count(*)::int AS n FROM presentation.${table}`);
  return rows[0].n;
}

test('nothing is active until a profile is bootstrapped, and bootstrap installs it once', async () => {
  expect(await activeProfile(pool)).toBeNull();
  expect(await bootstrapProfile(pool, first)).toBe(firstDigest);
  expect(await activeProfile(pool)).toEqual({ digest: firstDigest, head: 1, profile: first });
  expect(await bootstrapProfile(pool, second)).toBe(firstDigest);
  expect(await count('profile')).toBe(1);
  expect(await count('profile_activation')).toBe(1);
});

test('a profile is published once and read back by digest, immutably', async () => {
  const published = await publishProfile(pool, { ...options(), profile: second });
  expect(published).toMatchObject({ digest: secondDigest, created: true, replayed: false });
  expect(published.component).toMatchObject({ partition: 0 });
  const again = await publishProfile(pool, { ...options(), profile: structuredClone(second) });
  expect(again).toMatchObject({ digest: secondDigest, created: false });
  expect(await count('profile')).toBe(2);
  const read = await readProfile(pool, secondDigest);
  expect(read).toEqual(second);
  expect(Object.isFrozen(read)).toBe(true);
  expect(Object.isFrozen((read!.generic as CompositionDocument).content[0]!.props)).toBe(true);
  expect(await readProfile(pool, `sha256:${'0'.repeat(64)}`)).toBeNull();
  expect(await readProfile(pool, 'sha256:not-a-digest')).toBeNull();
});

test('an invalid profile is refused with its violations and stores nothing', async () => {
  const refused = publishProfile(pool, { ...options(), profile: profile('<b>bold</b>') });
  await expect(refused).rejects.toBeInstanceOf(ProfileInputError);
  await refused.catch((error: ProfileInputError) =>
    expect(error.violations).toEqual([{ pointer: '/generic/content/0/props/text', code: 'unsafe' }]),
  );
  await expect(publishProfile(pool, { ...options(), profile: { format: PROFILE_FORMAT } })).rejects.toBeInstanceOf(
    ProfileInputError,
  );
  expect(await count('profile')).toBe(2);
});

test('activation moves the head only from the expected head', async () => {
  const activated = await activateProfile(pool, { ...options(), profileDigest: secondDigest, expectedHead: 1 });
  expect(activated).toMatchObject({ digest: secondDigest, head: 2 });
  expect(await activeProfile(pool)).toEqual({ digest: secondDigest, head: 2, profile: second });
  await expect(
    activateProfile(pool, { ...options(), profileDigest: firstDigest, expectedHead: 1 }),
  ).rejects.toBeInstanceOf(StaleProfileHeadError);
  await expect(
    activateProfile(pool, { ...options(), profileDigest: `sha256:${'1'.repeat(64)}`, expectedHead: 2 }),
  ).rejects.toBeInstanceOf(ProfileNotFoundError);
  const back = await activateProfile(pool, { ...options(), profileDigest: firstDigest, expectedHead: 2 });
  expect(back).toMatchObject({ digest: firstDigest, head: 3 });
  expect(await count('profile_activation')).toBe(3);
});

test('a denied actor publishes and activates nothing', async () => {
  await expect(publishProfile(pool, { ...options(false), profile: profile('Denied') })).rejects.toBeInstanceOf(
    ProfileAccessDeniedError,
  );
  await expect(
    activateProfile(pool, { ...options(false), profileDigest: secondDigest, expectedHead: 3 }),
  ).rejects.toBeInstanceOf(ProfileAccessDeniedError);
  expect(await count('profile')).toBe(2);
  expect(await count('profile_activation')).toBe(3);
  expect((await activeProfile(pool))!.digest).toBe(firstDigest);
});
