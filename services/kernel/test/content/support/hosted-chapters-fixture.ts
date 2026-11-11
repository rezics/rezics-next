import { fromPlainText } from '@rezics/document';
import type { HostedChapterTarget } from '../../../src/content/hosted-chapters-model.ts';
import { newId, routeOf } from '../../../src/route/route.ts';
import { postPublicationFixture, type PublicationPost } from './post-publication-fixture.ts';

type ThreadPost = { id: string; firstPost: PublicationPost };

/** Reuse ordinary Post creation and its real native Access/publication path. */
export async function hostedChaptersFixture() {
  const native = await postPublicationFixture();
  try {
    const catalogue = await native.thread();
    const route = routeOf(catalogue.firstPost.id);
    if (route === null) throw new Error('Hosted fixture catalogue has no route');

    const target = (thread: ThreadPost): HostedChapterTarget => {
      const post = thread.firstPost as PublicationPost & { sha256: string };
      return { threadId: thread.id, postId: post.id, revisionId: post.revisionId, sha256: post.sha256 };
    };
    return {
      native,
      catalogueId: catalogue.firstPost.id,
      threadId: catalogue.id,
      newOccurrenceId: () => newId(route),
      target,
      async protectedChapter() {
        const created = await native.command('/v1/threads', {
          title: 'Protected source',
          body: fromPlainText('Protected chapter'),
          licence: 'MIT',
          subjectIds: [],
          boardId: native.board.id,
          visibility: 'protected',
        });
        return target(created.thread as ThreadPost);
      },
      close: native.close,
    };
  } catch (error) {
    await native.close();
    throw error;
  }
}
