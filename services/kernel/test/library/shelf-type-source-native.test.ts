import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { releaseDigest } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { CommandAuthorization } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { createShelfTypeSource, observeShelfType } from '../../src/library/shelf-type-source.ts';
import { accessCheck, type AccountActor } from '../../src/request/access.ts';
import { deadlineFor, withRequestDeadline } from '../../src/request/deadline.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { mergeSubjects } from '../../src/semantic/merges.ts';
import { moderateSubject } from '../../src/semantic/moderation.ts';
import { createSubject, updateSubjectIdentity } from '../../src/semantic/subject.ts';
import { createRealAccess } from '../semantic/real-access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
const actions = ['subject:create', 'subject:merge', 'moderation:hide'];
const realAccess = await createRealAccess(admin, { editor: newId(0x6a00) }, actions);
const access = realAccess.access({ actions: new Map(actions.map((action) => [action, { anonymous: false }])) });
const resource = { route: 0, id: GLOBAL_CONTEXT };
const longType = `schema:${'A'.repeat(8192)}`;
const releaseBody = {
  ...bundledRelease,
  types: {
    ...bundledRelease.types,
    [longType]: {
      ...bundledRelease.types['schema:Person']!,
      iri: `http://schema.org/${'A'.repeat(8192)}`,
      mappings: [],
    },
  },
};
const release = { release: releaseBody, digest: releaseDigest(releaseBody) };
const source = createShelfTypeSource();
const observe = (id: string) => observeShelfType({ pool, source }, id);
let actor: AccountActor;
const digest = (key: string) => createHash('sha256').update(key).digest();

beforeAll(async () => {
  expect(await bootstrapRelease(pool, releaseBody)).toBe(release.digest);
  for (const action of actions) await realAccess.grant(resource, 'editor', action);
  actor = await access.authenticate(realAccess.bearer('editor'), { pool, deadline: deadlineFor(60_000) });
});
afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
});

async function authorization(action: string) {
  const check = await accessCheck(access, actor, action, resource, { pool, deadline: deadlineFor(5_000) });
  const denied = () => new Error(`Real Access denied ${action}`);
  const command: CommandAuthorization = {
    action,
    resource,
    denied,
    async authorize(client, attempt) {
      if (!(await check(client, attempt.time))) throw denied();
      return 'execute';
    },
  };
  return { command, check };
}

async function create(route: number, type = 'schema:Person') {
  const id = newId(route);
  const key = randomUUID();
  const result = await createSubject(pool, {
    actor,
    target: { route, id },
    item: { type, labels: { en: 'Source observation' } },
    release,
    idempotencyKey: key,
    digest: digest(key),
    authorization: (await authorization('subject:create')).command,
  });
  expect(result.subject.id).toBe(id);
  return id;
}

async function retype(subject: string, type: string) {
  return updateSubjectIdentity(pool, {
    subject,
    type,
    release,
    authorize: (await authorization('subject:create')).check,
  });
}

async function merge(redirected: string, survivor: string) {
  const key = randomUUID();
  return mergeSubjects(pool, {
    subjects: [redirected, survivor],
    survivor,
    actor,
    release,
    idempotencyKey: key,
    digest: digest(key),
    authorization: (await authorization('subject:merge')).command,
    deadline: deadlineFor(5_000),
  });
}

async function stamp(id: string) {
  const owner = await source.readPartition(admin, partitionOf(routeOf(id)!));
  if (!owner) throw new Error('Test source partition is missing');
  return { partition: owner.partitionNo, epoch: owner.epoch, position: owner.position };
}

test('native source observation follows identity changes and preserves full type bytes and bigint positions', async () => {
  const id = await create(0x6a10);
  const before = await observe(id);
  expect(before.source?.type).toBe('schema:Person');
  // Initialize only the partition counter; the subject change still uses its production command and fence.
  const position = 9007199254740993n;
  await admin.query('UPDATE core.partition SET position = $2 WHERE partition_no = $1', [
    partitionOf(routeOf(id)!),
    position.toString(),
  ]);
  await retype(id, longType);
  const got = await observe(id);
  expect(got.source).toEqual({ sourceId: id, type: longType, stamp: await stamp(id) });
  expect(got.binding).toEqual({ sourceId: id, stamp: got.source!.stamp });
  expect(got.binding.stamp.position).toBe(position + 1n);
  expect(got.survivorId).toBeNull();
  expect(realAccess.checks.some((check) => check.action === 'subject:create')).toBe(true);
});

test('native merged sources keep their own stamp and expose only one hop before a separate survivor observation', async () => {
  const original = await create(0x6b10);
  const middle = await create(0x7b20);
  const survivor = await create(0x8b30);
  await merge(original, middle);
  await merge(middle, survivor);
  await retype(survivor, 'schema:Organization');

  const first = await observe(original);
  expect(first.survivorId).toBe(middle);
  expect(first.binding.stamp).toEqual(await stamp(original));
  expect(first.source?.type).toBe('schema:Person');
  const second = await observe(first.survivorId!);
  expect(second.survivorId).toBe(survivor);
  expect(second.binding.stamp).toEqual(await stamp(middle));
  const final = await observe(second.survivorId!);
  expect(final.source).toEqual({ sourceId: survivor, type: 'schema:Organization', stamp: await stamp(survivor) });
  expect(final.survivorId).toBeNull();
  expect(new Set([first, second, final].map((snapshot) => snapshot.binding.stamp.partition)).size).toBe(3);
  expect(realAccess.checks.some((check) => check.action === 'subject:merge')).toBe(true);
});

test('native missing and invisible types retain a binding without inventing a type observation', async () => {
  const missing = newId(0x6c10);
  expect(await observe(missing)).toEqual({
    binding: { sourceId: missing, stamp: await stamp(missing) },
    source: null,
    survivorId: null,
  });
  const hidden = await create(0x6c20);
  const key = randomUUID();
  await moderateSubject(pool, {
    actor,
    subject: hidden,
    action: 'hide',
    body: { reason: 'spam' },
    idempotencyKey: key,
    digest: digest(key),
    authorization: (await authorization('moderation:hide')).command,
    deadline: deadlineFor(5_000),
  });
  expect(await observe(hidden)).toEqual({
    binding: { sourceId: hidden, stamp: await stamp(hidden) },
    source: null,
    survivorId: null,
  });
});

test('native observation keeps partition and semantic reads in one snapshot during a concurrent identity command', async () => {
  const id = await create(0x6d10);
  const before = await observe(id);
  const paused = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const pending = observeShelfType(
    {
      pool,
      source: {
        ...source,
        async readItemTypes(client, ids) {
          paused.resolve();
          await resume.promise;
          return source.readItemTypes(client, ids);
        },
      },
    },
    id,
  );
  try {
    await paused.promise;
    await retype(id, 'schema:Organization');
  } finally {
    resume.resolve();
  }
  expect(await pending).toEqual(before);
  const after = await observe(id);
  expect(after.source?.type).toBe('schema:Organization');
  expect(after.binding.stamp.position).toBe(before.binding.stamp.position + 1n);
});

test('native observation permits fenced reads and fails closed for missing or moved partitions before semantic reads', async () => {
  const id = await create(0x6e10);
  const partition = partitionOf(routeOf(id)!);
  const before = await observe(id);
  try {
    await admin.query("UPDATE core.partition SET write_state = 'fenced' WHERE partition_no = $1", [partition]);
    expect(await observe(id)).toEqual(before);
    await admin.query("UPDATE core.partition SET write_state = 'moved', moved_to = 'new' WHERE partition_no = $1", [
      partition,
    ]);
    let probes = 0;
    const blockedSource = {
      ...source,
      async readItemTypes() {
        probes++;
        throw new Error('Must reject before reading types');
      },
      async readSurvivor() {
        probes++;
        throw new Error('Must reject before reading redirects');
      },
    };
    await expect(observeShelfType({ pool, source: blockedSource }, id)).rejects.toMatchObject({
      reason: 'moved',
      partition,
      movedTo: 'new',
    });
    await expect(
      observeShelfType({ pool, source: { ...blockedSource, readPartition: async () => null } }, id),
    ).rejects.toMatchObject({ reason: 'deadline', partition });
    expect(probes).toBe(0);
  } finally {
    await admin.query("UPDATE core.partition SET write_state = 'active', moved_to = NULL WHERE partition_no = $1", [
      partition,
    ]);
  }
});

test('source validation precedes checkout and the shared request deadline bounds native reads', async () => {
  let checkouts = 0;
  const invalidPool = {
    connect: async () => {
      checkouts++;
      throw new Error('Must reject before checkout');
    },
  } as unknown as pg.Pool;
  await expect(observeShelfType({ pool: invalidPool, source }, 'not-a-subject')).rejects.toBeInstanceOf(TypeError);
  expect(checkouts).toBe(0);
  let reads = 0;
  await expect(
    withRequestDeadline(Date.now() - 1, () =>
      observeShelfType(
        {
          pool,
          source: {
            ...source,
            async readPartition() {
              reads++;
              return null;
            },
          },
        },
        newId(0x6f10),
      ),
    ),
  ).rejects.toMatchObject({ reason: 'deadline' });
  expect(reads).toBe(0);
});
