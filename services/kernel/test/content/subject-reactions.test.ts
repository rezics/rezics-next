import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createLifecycleCommands } from '../../src/access/lifecycle.ts';
import { mergeSubjects } from '../../src/semantic/merges.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { readReactionCounts, projectReactionCounts } from '../../src/content/reaction-projection.ts';
import { ContentNotFoundError } from '../../src/content/commands.ts';
import { reactionFixture, request } from './reactions.test.ts';

let f: Awaited<ReturnType<typeof reactionFixture>>;
let commands: typeof import('../../src/content/reactions.ts');

beforeAll(async () => {
  f = await reactionFixture();
  commands = await import('../../src/content/reactions.ts');
  await bootstrapRelease(f.db.pool, bundledRelease);
}, 120_000);

afterAll(async () => {
  await f?.close();
});

async function subject(label: string): Promise<string> {
  const id = newId(f.targetRoute);
  await createSubject(f.db.pool, {
    actor: await f.verified(f.managerId),
    target: { route: f.targetRoute, id },
    idempotencyKey: crypto.randomUUID(),
    digest: createHash('sha256').update(id).digest(),
    item: { type: 'schema:Book', labels: { en: label } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  await f.grant(id, ['reaction:set']);
  return id;
}

async function relay(): Promise<void> {
  await projectReactionCounts(f.db.pool, partitionOf(f.home));
}

async function counts(targetId: string) {
  const client = await f.db.pool.connect();
  try {
    return await readReactionCounts(client, { targetId });
  } finally {
    client.release();
  }
}

async function reactor(targetId: string) {
  const result = await f.db.admin.query<{ kind: string }>(
    `SELECT kind FROM content.subject_reactor WHERE route=$1 AND subject_id=$2 AND actor_account_id=$3`,
    [f.targetRoute, targetId, f.accountId],
  );
  return result.rows[0]?.kind ?? null;
}

test('a person sets, changes and clears one reaction on a subject, and counts and its reactor row follow the relay', async () => {
  const targetId = await subject('Reaction subject');
  const actor = await f.verified();
  const input = { targetKind: 'subject' as const, targetId };

  await commands.setReaction({ pool: f.db.pool, access: f.access }, actor, { ...input, kind: 'like' }, request());
  await relay();
  expect(await reactor(targetId)).toBe('like');
  expect((await counts(targetId)).counts).toEqual([{ kind: 'like', count: 1 }]);

  await commands.setReaction({ pool: f.db.pool, access: f.access }, actor, { ...input, kind: 'love' }, request());
  await relay();
  expect(await reactor(targetId)).toBe('love');
  expect((await counts(targetId)).counts).toEqual([{ kind: 'love', count: 1 }]);

  await commands.clearReaction({ pool: f.db.pool, access: f.access }, actor, input, request());
  await relay();
  expect(await reactor(targetId)).toBeNull();
  expect((await counts(targetId)).counts).toEqual([]);
});

test('subject reactions accept the five emoji kinds and reject score reactions with the invalid-kind error', async () => {
  const targetId = await subject('Reaction kinds');
  const actor = await f.verified();
  for (const kind of ['like', 'love', 'laugh', 'insightful', 'sad'] as const) {
    await commands.setReaction(
      { pool: f.db.pool, access: f.access },
      actor,
      { targetKind: 'subject', targetId, kind },
      request(),
    );
  }
  for (const kind of ['upvote', 'downvote'] as const) {
    await expect(
      commands.setReaction(
        { pool: f.db.pool, access: f.access },
        actor,
        { targetKind: 'subject', targetId, kind },
        request(),
      ),
    ).rejects.toThrow('Invalid reaction kind');
  }
});

test('unknown and unreadable subjects are not found, and a merged subject reaction is stored on its survivor', async () => {
  const targetId = await subject('Merged survivor');
  const mergedId = await subject('Merged source');
  const actor = await f.verified();
  await f.db.admin.query(
    `UPDATE semantic.subject SET visibility='hidden',security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2`,
    [f.targetRoute, mergedId],
  );
  await expect(
    commands.setReaction(
      { pool: f.db.pool, access: f.access },
      actor,
      { targetKind: 'subject', targetId: mergedId, kind: 'like' },
      request(),
    ),
  ).rejects.toBeInstanceOf(ContentNotFoundError);
  await f.db.admin.query(
    `UPDATE semantic.subject SET visibility='visible',security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2`,
    [f.targetRoute, mergedId],
  );

  await mergeSubjects(f.db.pool, {
    subjects: [targetId, mergedId],
    actor: await f.verified(f.managerId),
    idempotencyKey: crypto.randomUUID(),
    digest: createHash('sha256').update(`${targetId}:${mergedId}`).digest(),
    release: { digest: bundledDigest, release: bundledRelease },
    deadline: Date.now() + 30_000,
    authorization: {
      action: 'subject:merge',
      resource: { route: 0, id: GLOBAL_CONTEXT },
      denied: () => new Error('Denied'),
      async authorize() {
        return 'execute';
      },
    },
  });
  const survivor = [targetId, mergedId].sort()[0]!;
  const redirected = [targetId, mergedId].sort()[1]!;
  await commands.setReaction(
    { pool: f.db.pool, access: f.access },
    actor,
    { targetKind: 'subject', targetId: redirected, kind: 'like' },
    request(),
  );
  await relay();
  expect(await reactor(survivor)).toBe('like');
  expect(await reactor(redirected)).toBeNull();
  expect((await counts(survivor)).counts).toEqual([{ kind: 'like', count: 1 }]);

  await expect(
    commands.setReaction(
      { pool: f.db.pool, access: f.access },
      actor,
      { targetKind: 'subject', targetId: newId(f.targetRoute), kind: 'like' },
      request(),
    ),
  ).rejects.toBeInstanceOf(ContentNotFoundError);
});

test('the subject reactor index contains one row per reactor and clears with the slot event after account erasure', async () => {
  const targetId = await subject('Reactor erasure');
  const actor = await f.verified();
  await commands.setReaction(
    { pool: f.db.pool, access: f.access },
    actor,
    { targetKind: 'subject', targetId, kind: 'sad' },
    request(),
  );
  await relay();
  expect(await reactor(targetId)).toBe('sad');

  await commands.clearReaction(
    { pool: f.db.pool, access: f.access },
    actor,
    { targetKind: 'subject', targetId },
    request(),
  );
  await f.db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,'account:delete','(,)',$3)`,
    [routeOf(f.accountId), f.accountId, f.accountId],
  );
  await createLifecycleCommands({ pool: f.db.pool, access: f.access }).tombstone(
    { actor, deadline: Date.now() + 30_000 },
    { accountId: f.accountId, key: crypto.randomUUID() },
  );
  await relay();
  expect(await reactor(targetId)).toBeNull();
  expect((await counts(targetId)).counts).toEqual([]);
});
