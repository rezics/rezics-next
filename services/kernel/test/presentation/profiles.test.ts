import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  MAX_PROFILE_BYTES,
  PROFILE_FORMAT,
  profileDigest,
  type CompositionDocument,
  type PresentationProfile,
} from '@rezics/composition';
import canonicalize from 'canonicalize';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { ProfileCache } from '../../src/presentation/profile-cache.ts';
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
import { newId } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createRealAccess } from '../semantic/real-access.ts';

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

const payloadBytes = (value: PresentationProfile) => Buffer.byteLength(canonicalize(value)!, 'utf8');

// Well-formed platform configuration storage fixtures, not product commands or Access evidence.
async function store(body: PresentationProfile): Promise<string> {
  const digest = profileDigest(body);
  await admin.query('INSERT INTO presentation.profile(route,digest,body,recorded_transaction_id) VALUES(0,$1,$2,$3)', [
    digest,
    body,
    randomUUID(),
  ]);
  return digest;
}

function largeProfile(): PresentationProfile {
  const body = profile(randomUUID());
  const texts: { id: string; text: string }[] = [];
  body.routes = Array.from({ length: 32 }, (_, route) => ({
    route: `/cache-${String(route).padStart(2, '0')}`,
    document: {
      root: { props: {} },
      content: Array.from({ length: 16 }, (_, node) => {
        const props = { id: `text-${node}`, text: '界'.repeat(600) };
        texts.push(props);
        return { type: 'Text', props };
      }),
    },
  }));
  let remaining = MAX_PROFILE_BYTES - payloadBytes(body);
  expect(remaining).toBeGreaterThan(0);
  for (const props of texts) {
    const added = Math.min(remaining, 2_000 - props.text.length);
    props.text += 'a'.repeat(added);
    remaining -= added;
  }
  expect(remaining).toBe(0);
  expect(payloadBytes(body)).toBe(MAX_PROFILE_BYTES);
  return body;
}

test('retention accounts exact canonical UTF-8 bytes and LRU order independently of history', () => {
  const cache = new ProfileCache();
  const bodies = Array.from({ length: 9 }, (_, n) => profile(`界 ${n}`));
  const read = (n: number) => cache.read(profileDigest(bodies[n]!), bodies[n]);
  const first = read(0);
  const second = read(1);
  read(2);
  read(3);
  expect(cache.retained).toEqual({
    entries: 4,
    bytes: bodies.slice(0, 4).reduce((n, body) => n + payloadBytes(body), 0),
  });
  expect(payloadBytes(bodies[0]!)).toBeGreaterThan(canonicalize(bodies[0]!)!.length);
  expect(read(0)).toBe(first); // Refresh the oldest entry before admitting the fifth.
  read(4);
  expect(read(0)).toBe(first);
  expect(read(1)).not.toBe(second);
  for (let n = 5; n < bodies.length; n++) {
    read(n);
    expect(cache.retained.entries).toBe(4);
    expect(cache.retained.bytes).toBeLessThanOrEqual(4 * MAX_PROFILE_BYTES);
  }
  expect(read(0)).not.toBe(first);
  expect(cache.retained.bytes).toBe(
    bodies.slice(6).reduce((n, body) => n + payloadBytes(body), payloadBytes(bodies[0]!)),
  );
});

test('four maximum-size valid multibyte bodies retain exactly four MiB and failures retain nothing extra', () => {
  const cache = new ProfileCache();
  const bodies = Array.from({ length: 5 }, largeProfile);
  const snapshots = bodies.slice(0, 4).map((body) => cache.read(profileDigest(body), body));
  expect(cache.retained).toEqual({ entries: 4, bytes: 4 * MAX_PROFILE_BYTES });
  const before = cache.retained;
  expect(() => cache.read(profileDigest(bodies[0]!), { format: PROFILE_FORMAT })).toThrow(ProfileInputError);
  expect(() => cache.read(profileDigest(bodies[0]!), bodies[4])).toThrow('Stored presentation profile digest mismatch');
  const oversized = structuredClone(bodies[0]!);
  oversized.routes.push({ route: '/overflow', document: { root: { props: {} }, content: [] } });
  expect(() => cache.read(profileDigest(oversized), oversized)).toThrow(ProfileInputError);
  expect(cache.retained).toEqual(before);
  cache.read(profileDigest(bodies[4]!), bodies[4]);
  expect(cache.retained).toEqual(before);
  // Failed reads did not refresh the oldest entry.
  expect(cache.read(profileDigest(bodies[0]!), bodies[0])).not.toBe(snapshots[0]);
  expect(cache.retained).toEqual(before);
});

test('cache snapshots own and deeply freeze nested input including already-frozen caller roots', () => {
  const cache = new ProfileCache();
  const input = profile('Owned snapshot');
  const expected = structuredClone(input);
  Object.freeze(input);
  const digest = profileDigest(input);
  const snapshot = cache.read(digest, input);
  expect(snapshot).not.toBe(input);
  const document = input.generic as CompositionDocument;
  document.content[0]!.props.text = 'Caller changed';
  expect(snapshot).toEqual(expected);
  const nested = (snapshot.generic as CompositionDocument).content[0]!.props;
  expect(Object.isFrozen(nested)).toBe(true);
  expect(() => {
    nested.text = 'Reader changed';
  }).toThrow();
  expect(cache.read(digest, expected)).toBe(snapshot);
});

test('native concurrent reads reuse one snapshot and eviction is LRU without retaining database history', async () => {
  const records: { body: PresentationProfile; digest: string }[] = [];
  try {
    for (let n = 0; n < 9; n++) {
      const body = profile(`Native ${randomUUID()} ${n}`);
      records.push({ body, digest: await store(body) });
    }
    const read = (n: number) => readProfile(pool, records[n]!.digest);
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => read(0)));
    expect(concurrent.every((body) => body === concurrent[0])).toBe(true);
    const second = await read(1);
    await read(2);
    await read(3);
    expect(await read(0)).toBe(concurrent[0]);
    await read(4);
    expect(await read(0)).toBe(concurrent[0]);
    expect(await read(1)).not.toBe(second);
    for (let n = 5; n < 9; n++) expect(await read(n)).toEqual(records[n]!.body);
    const cold = await read(0);
    expect(cold).toEqual(records[0]!.body);
    expect(cold).not.toBe(concurrent[0]);
    expect(Object.isFrozen((cold!.generic as CompositionDocument).content[0]!.props)).toBe(true);
    expect(
      (
        await admin.query('SELECT count(*)::int AS n FROM presentation.profile WHERE digest=ANY($1::text[])', [
          records.map((r) => r.digest),
        ])
      ).rows[0].n,
    ).toBe(9);
  } finally {
    await admin.query('DELETE FROM presentation.profile WHERE digest=ANY($1::text[])', [records.map((r) => r.digest)]);
  }
});

test('each pool observes its own snapshot existence and validates hot and cold stored bodies', async () => {
  const other = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const records: string[] = [];
  const body = profile(`Pool ${randomUUID()}`);
  const digest = profileDigest(body);
  try {
    await other.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    expect(await readProfile(other, digest)).toBeNull();
    records.push(await store(body));
    const hot = await readProfile(pool, digest);
    expect(hot).toEqual(body);
    expect(await readProfile(other, digest)).toBeNull(); // No negative cache, nor foreign positive authority.
    await other.query('COMMIT');
    expect(await readProfile(other, digest)).toBe(hot);
    await admin.query('DELETE FROM presentation.profile WHERE digest=$1', [digest]);
    expect(await readProfile(other, digest)).toBeNull();
    await store(body);
    expect(await readProfile(other, digest)).toBe(hot);
    for (const cold of [false, true]) {
      if (cold) {
        for (let n = 0; n < 4; n++) {
          const filler = profile(`Evict ${randomUUID()}`);
          const fillerDigest = await store(filler);
          records.push(fillerDigest);
          await readProfile(pool, fillerDigest);
        }
      }
      // Deliberately corrupt storage to prove that no cached digest masks the actual body.
      await admin.query('UPDATE presentation.profile SET body=$2 WHERE digest=$1', [
        digest,
        { format: PROFILE_FORMAT },
      ]);
      await expect(readProfile(other, digest)).rejects.toBeInstanceOf(ProfileInputError);
      await admin.query('UPDATE presentation.profile SET body=$2 WHERE digest=$1', [
        digest,
        profile('Foreign valid body'),
      ]);
      await expect(readProfile(other, digest)).rejects.toThrow('Stored presentation profile digest mismatch');
      await admin.query('UPDATE presentation.profile SET body=$2 WHERE digest=$1', [digest, body]);
      const recovered = await readProfile(other, digest);
      expect(recovered).toEqual(body);
      if (cold) expect(recovered).not.toBe(hot);
      else expect(recovered).toBe(hot);
    }
  } finally {
    await other.query('ROLLBACK');
    await other.end();
    await admin.query('DELETE FROM presentation.profile WHERE digest=ANY($1::text[])', [records]);
  }
});

test('native large multibyte bodies reload after eviction at the unchanged validation limit', async () => {
  const records: { body: PresentationProfile; digest: string }[] = [];
  try {
    for (let n = 0; n < 5; n++) {
      const body = largeProfile();
      records.push({ body, digest: await store(body) });
    }
    const first = await readProfile(pool, records[0]!.digest);
    for (const record of records.slice(1)) expect(await readProfile(pool, record.digest)).toEqual(record.body);
    const reloaded = await readProfile(pool, records[0]!.digest);
    expect(reloaded).toEqual(records[0]!.body);
    expect(reloaded).not.toBe(first);
    expect(Object.isFrozen(reloaded!.routes[0]!.document!.content[0]!.props)).toBe(true);
  } finally {
    await admin.query('DELETE FROM presentation.profile WHERE digest=ANY($1::text[])', [records.map((r) => r.digest)]);
  }
});

test('publish captures an owned input before asynchronous command execution', async () => {
  // This tests input ownership only; the API case below supplies real Access evidence.
  const input = profile(`Capture ${randomUUID()}`);
  const expected = structuredClone(input);
  const pending = publishProfile(pool, { ...options(), profile: input });
  (input.generic as CompositionDocument).content[0]!.props.text = 'Changed while publishing';
  const result = await pending;
  expect(result.digest).toBe(profileDigest(expected));
  expect(await readProfile(pool, result.digest)).toEqual(expected);
  expect(Object.isFrozen(input)).toBe(false);
});

test('real Global grants, receipts, sessions and active CAS survive hot reads and eviction', async () => {
  const actions = ['presentation:read', 'presentation:publish', 'presentation:activate'] as const;
  const access = await createRealAccess(admin, { curator: newId(0), editor: newId(0) }, actions);
  const global = { route: 0, id: GLOBAL_CONTEXT };
  for (const action of ['presentation:publish', 'presentation:activate']) await access.grant(global, 'curator', action);
  const kernel = createKernel({
    pool,
    access: access.access,
    requestDeadlineMs: 30_000,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) },
    routeKey: new Uint8Array(32).fill(8),
    writeRate: access.writeRate,
  });
  const call = async (method: string, path: string, body?: unknown, key?: string, token?: string, session?: string) => {
    const headers = new Headers();
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (key) headers.set('idempotency-key', key);
    if (session) headers.set(SESSION_HEADER, session);
    if (body !== undefined) headers.set('content-type', 'application/json');
    return kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  };
  const curator = access.bearer('curator');
  const editor = access.bearer('editor');
  const body = profile(`Governed ${randomUUID()}`);
  const digest = profileDigest(body);
  const publishKey = `"${randomUUID()}"`;
  const published = await call('POST', '/v1/presentation/profiles', { profile: body }, publishKey, curator);
  expect(published.status).toBe(201);
  expect(await published.json()).toEqual({ digest });
  const session = published.headers.get(SESSION_HEADER)!;
  expect(session).toBeTruthy();
  const hot = await readProfile(pool, digest);
  const prior = (await activeProfile(pool))!;
  const activationKey = `"${randomUUID()}"`;
  const activationPath = `/v1/presentation/profiles/${digest}:activate`;
  const activated = await call('POST', activationPath, { expected_head: prior.head }, activationKey, curator, session);
  expect(activated.status).toBe(200);
  expect(await activated.json()).toEqual({ digest, head: prior.head + 1 });
  expect(activated.headers.get(SESSION_HEADER)).toBeTruthy();

  for (let n = 0; n < 5; n++) {
    const filler = profile(`Published eviction ${randomUUID()}`);
    const response = await call('POST', '/v1/presentation/profiles', { profile: filler }, `"${randomUUID()}"`, curator);
    expect(response.status).toBe(201);
    await readProfile(pool, profileDigest(filler));
  }
  const cold = await activeProfile(pool);
  expect(cold).toEqual({ digest, head: prior.head + 1, profile: body });
  expect(cold!.profile).not.toBe(hot);
  expect((await call('GET', '/v1/presentation/active')).status).toBe(200);
  const publicRead = await call('GET', `/v1/presentation/profiles/${digest}`);
  expect(publicRead.status).toBe(200);
  expect(await publicRead.json()).toEqual({ digest, profile: body });
  expect(publicRead.headers.get('etag')).toBe(`"${digest}"`);
  expect(publicRead.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

  const before = { profiles: await count('profile'), heads: await count('profile_activation') };
  expect((await call('POST', activationPath, { expected_head: prior.head }, `"${randomUUID()}"`, curator)).status).toBe(
    409,
  );
  const activationReplay = await call('POST', activationPath, { expected_head: prior.head }, activationKey, curator);
  expect(activationReplay.status).toBe(200);
  expect(await activationReplay.json()).toEqual({ digest, head: prior.head + 1 });
  const publishReplay = await call('POST', '/v1/presentation/profiles', { profile: body }, publishKey, curator);
  expect(publishReplay.status).toBe(201);
  expect(await publishReplay.json()).toEqual({ digest });
  expect(publishReplay.headers.get(SESSION_HEADER)).toBeTruthy();
  expect((await call('POST', '/v1/presentation/profiles', { profile: body }, `"${randomUUID()}"`, editor)).status).toBe(
    403,
  );
  expect(
    (await call('POST', activationPath, { expected_head: prior.head + 1 }, `"${randomUUID()}"`, editor)).status,
  ).toBe(403);
  expect((await call('POST', '/v1/presentation/profiles', { profile: body }, `"${randomUUID()}"`)).status).toBe(401);
  for (const action of ['presentation:publish', 'presentation:activate'])
    await access.revoke(global, 'curator', action);
  expect((await call('POST', '/v1/presentation/profiles', { profile: body }, publishKey, curator)).status).toBe(403);
  expect((await call('POST', activationPath, { expected_head: prior.head }, activationKey, curator)).status).toBe(403);
  expect(await count('profile')).toBe(before.profiles);
  expect(await count('profile_activation')).toBe(before.heads);
  expect((await activeProfile(pool))!.head).toBe(prior.head + 1);
  try {
    await admin.query('UPDATE presentation.profile SET body=$2 WHERE digest=$1', [digest, { format: PROFILE_FORMAT }]);
    await expect(activeProfile(pool)).rejects.toBeInstanceOf(ProfileInputError);
    await admin.query('UPDATE presentation.profile SET body=$2 WHERE digest=$1', [
      digest,
      profile('Foreign active body'),
    ]);
    await expect(activeProfile(pool)).rejects.toThrow('Stored presentation profile digest mismatch');
  } finally {
    await admin.query('UPDATE presentation.profile SET body=$2 WHERE digest=$1', [digest, body]);
  }
  expect(await activeProfile(pool)).toEqual({ digest, head: prior.head + 1, profile: body });
});
