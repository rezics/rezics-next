import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { createContentNotificationDriver } from './notification-driver.ts';

test('retrying an owned seen point cannot acknowledge a notice delivered after the original request', async () => {
  const driver = await createContentNotificationDriver();
  try {
    const people = await driver.provision();
    const options = (actor = people.author) => ({ actor, key: JSON.stringify(randomUUID()) });
    const created = await driver.createThread(
      { boardId: people.publicBoardId, body: fromPlainText('Opening'), visibility: 'published' },
      options(),
    );
    expect(created.response.status).toBe(201);
    const post = async () => {
      const result = await driver.createPost(
        { threadId: created.value!.id, body: fromPlainText('Reply'), visibility: 'published' },
        options(people.replier),
      );
      expect(result.response.status).toBe(201);
      await driver.effects('drain');
      return result.value!;
    };
    await post();
    const first = await driver.inbox(people.author.id, people.author);
    expect(first.response.status).toBe(200);
    expect(first.value!.items).toHaveLength(1);
    const through = first.value!.items[0]!.id;
    const retry = options();
    expect((await driver.markSeen(people.author.id, through, retry)).response.status).toBe(204);
    expect((await driver.unread(people.author.id, people.author)).value).toEqual({ count: 0, capped: false });

    const later = await post();
    expect((await driver.markSeen(people.author.id, through, retry)).response.status).toBe(204);
    expect((await driver.markSeen(people.author.id, through, options())).response.status).toBe(204);
    expect((await driver.unread(people.author.id, people.author)).value).toEqual({ count: 1, capped: false });
    const after = await driver.inbox(people.author.id, people.author);
    expect(after.response.status).toBe(200);
    expect(after.value!.items).toEqual([
      expect.objectContaining({ target: { threadId: created.value!.id, postId: later.id }, unread: true }),
      expect.objectContaining({ id: through, unread: false }),
    ]);
    expect((await driver.markSeen(people.replier.id, through, options(people.replier))).response.status).toBe(404);
    expect((await driver.unread(people.author.id, people.author)).value).toEqual({ count: 1, capped: false });
  } finally {
    await driver.close();
  }
}, 120_000);
