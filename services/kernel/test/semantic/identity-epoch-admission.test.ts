import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createFollowCommands } from '../../src/library/follows.ts';
import { epochFixture, seedLegacyGroup, type EpochFixture } from './support/identity-epoch.ts';

let f: EpochFixture;
beforeAll(async () => {
  f = await epochFixture();
});
afterAll(async () => {
  await f?.close();
});

test('native structural identity admission rejects over4096 before effects and preserves stored originals', async () => {
  const first = await f.create();
  const second = await f.create();
  const [survivor, redirected] = [first.subject.id, second.subject.id].sort() as [string, string];
  // Two valid groups of 2048 and 2049 originals. The command still has only TWO input subjects.
  const left = await seedLegacyGroup(f, survivor, 2047);
  const right = await seedLegacyGroup(f, redirected, 2048);
  expect(new Set([survivor, redirected, ...left, ...right]).size).toBe(4097);
  const follows = createFollowCommands({ pool: f.pool, access: f.access });
  const actor = await f.actor();
  // Save against active original roots before the attempted structural change.
  await follows.follow(actor, { targetType: 'subject', targetId: redirected }, randomUUID());
  const stored = await follows.readFollow(actor, redirected);
  const before = await f.snapshot([survivor, redirected, ...left, ...right]);
  let failure: unknown;
  try {
    await f.merge(redirected, survivor);
  } catch (error) {
    failure = error;
  }
  const after = await f.snapshot([survivor, redirected, ...left, ...right]);
  expect(after, 'overflow must precede revision, redirect, member, receipt and outbox effects').toEqual(before);
  expect(await follows.readFollow(actor, redirected)).toEqual(stored);
  expect(failure).toMatchObject({ code: 'identity_group_overflow' });
});

test('native authorization precedes replay receipt and successful merge keeps the stored follow original', async () => {
  const [survivor, redirected] = [(await f.create()).subject.id, (await f.create()).subject.id].sort() as [
    string,
    string,
  ];
  const follows = createFollowCommands({ pool: f.pool, access: f.access });
  const actor = await f.actor();
  await follows.follow(actor, { targetType: 'subject', targetId: redirected }, randomUUID());
  const stored = await follows.readFollow(actor, redirected);
  const key = randomUUID();
  const merged = await f.merge(redirected, survivor, key);
  expect(merged).toMatchObject({ survivor, redirected, revision: 2 });
  expect(await follows.readFollow(actor, redirected)).toEqual(stored);
  expect(await follows.readFollow(actor, survivor)).toBeNull();
  expect(await f.merge(redirected, survivor, key)).toEqual(merged);
  // Use the real Global resource; no grant callback or fabricated actor is accepted as proof.
  const { globalResource } = await import('./support/identity-epoch.ts');
  await f.real.revoke(globalResource, 'editor', 'subject:merge');
  const before = await f.snapshot([survivor, redirected]);
  await expect(f.merge(redirected, survivor, key)).rejects.toThrow('Denied subject:merge');
  expect(await f.snapshot([survivor, redirected])).toEqual(before);
});
