import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import * as liked from '../../src/content/liked-read.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { newId } from '../../src/route/route.ts';
import { reactionFixture, request } from './reactions.test.ts';

let f: Awaited<ReturnType<typeof reactionFixture>>;
let commands: typeof import('../../src/content/reactions.ts');
beforeAll(async () => {
  f = await reactionFixture();
  commands = await import('../../src/content/reactions.ts');
}, 120_000);
afterAll(async () => {
  await f?.close();
});

async function subject(): Promise<string> {
  const id = newId(f.targetRoute);
  await createSubject(f.db.pool, {
    actor: await f.verified(f.managerId),
    target: { route: f.targetRoute, id },
    idempotencyKey: crypto.randomUUID(),
    digest: createHash('sha256').update(id).digest(),
    item: { type: 'schema:Book', labels: { en: 'Version target' } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  return id;
}

async function react(
  targetId: string,
  kind: Parameters<typeof commands.setReaction>[2]['kind'],
  actorId = f.accountId,
  targetKind: 'subject' | 'thread' | 'post' = 'subject',
) {
  return commands.setReaction(
    { pool: f.db.pool, access: f.access },
    await f.verified(actorId),
    { targetId, targetKind, kind },
    request(),
  );
}

async function version(actorAccountId = f.accountId): Promise<bigint> {
  // Keep this outcome test runnable against the pre-version implementation for the initial red evidence.
  const reader = (
    liked as unknown as {
      readLikedVersion: (client: typeof f.db.pool, input: { actorAccountId: string }) => Promise<bigint>;
    }
  ).readLikedVersion;
  return reader(f.db.pool, { actorAccountId });
}

test("the Liked version increases on every change of the actor's like and love subject set and on no other reaction change", async () => {
  const id = await subject();
  const before = await version();
  for (const [kind, increment] of [
    ['like', 1n],
    ['love', 2n],
    ['laugh', 3n],
    ['sad', 3n],
    ['like', 4n],
  ] as const) {
    await react(id, kind);
    expect(await version()).toBe(before + increment);
  }
  await react(id, 'like');
  expect(await version()).toBe(before + 4n);
  await f.db.admin.query(
    'UPDATE content.reaction SET updated_at=clock_timestamp() WHERE route=$1 AND actor_account_id=$2',
    [f.home, f.accountId],
  );
  expect(await version()).toBe(before + 4n);
  const targets = await f.target();
  await react(targets.thread, 'like', f.accountId, 'thread');
  await react(targets.post, 'love', f.accountId, 'post');
  await react(id, 'love', f.managerId);
  expect(await version()).toBe(before + 4n);
  await commands.clearReaction(
    { pool: f.db.pool, access: f.access },
    await f.verified(),
    { targetKind: 'subject', targetId: id },
    request(),
  );
  expect(await version()).toBe(before + 5n);
});
