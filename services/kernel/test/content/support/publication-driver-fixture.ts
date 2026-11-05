import { expect } from 'bun:test';
import type { ApiResult, Persona, Post } from '../../../../../specs/content-notification-driver.ts';
import { createContentNotificationDriver } from '../notification-driver.ts';
import { mentions } from './publication-notices-fixture.ts';

export function ok<T>(result: ApiResult<T>, status = 200): T {
  expect(result.response.status).toBe(status);
  expect(result.value).not.toBeNull();
  return result.value!;
}

/** Compare the adapter snapshot with the unmodified native response. */
export async function revision(result: ApiResult<Post>, visibility: 'draft' | 'published', status = 200) {
  const post = ok(result, status);
  const native = (await result.response.clone().json()).post;
  expect(native.visibility).toBe(visibility);
  expect(native.revisionId).toEqual(expect.any(String));
  expect(post).toMatchObject({ id: native.id, revisionId: native.revisionId });
  return native.revisionId as string;
}

/** Uses the driver's native Auth system and registered delivery host unchanged. */
export async function publicationDriverFixture() {
  const driver = await createContentNotificationDriver();
  const people = await driver.provision();
  let serial = 0;
  const options = (actor = people.replier) => ({ actor, key: JSON.stringify(`notification-${++serial}`) });
  return {
    driver,
    people,
    options,
    async thread(protectedRealm = false) {
      return ok(
        await driver.createThread(
          {
            boardId: protectedRealm ? people.protectedBoardId : people.publicBoardId,
            body: mentions(),
            visibility: 'published',
          },
          options(people.author),
        ),
        201,
      );
    },
    post(threadId: string, accounts: Persona[], visibility: 'draft' | 'published' = 'published') {
      return driver.createPost({ threadId, body: mentions(...accounts), visibility }, options());
    },
    revise(post: Post, accounts: Persona[], visibility: 'draft' | 'published' = 'published', write = options()) {
      return driver.revise({ post, body: mentions(...accounts), visibility }, write);
    },
    async notices(actor: Persona, post: Post) {
      const inbox = ok(await driver.inbox(actor.id, actor, { limit: 50 }));
      expect(inbox.next).toBeNull();
      return inbox.items.filter((item) => item.target.postId === post.id);
    },
    close: () => driver.close(),
  };
}
