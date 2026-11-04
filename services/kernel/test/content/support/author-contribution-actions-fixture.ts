import { fromPlainText } from '@rezics/document';
import type { AuthorContributionActionsInput } from '../../../src/content/author-contribution-actions-schema.ts';
import counts from '../../../src/content/reaction-count-page.sql';
import { createThreadReadingPageFixture } from './thread-reading-page-fixture.ts';
import { observeSql } from './sql-observer.ts';

/** Real registrations, Accounts publication, Access, mounted Kernel and native commands. */
export async function createAuthorContributionActionsFixture() {
  const f = await createThreadReadingPageFixture();
  try {
    await f.checked(
      'PATCH',
      `/v1/accounts/${f.author.accountId}`,
      {
        bearer: f.author.bearer,
        body: { publicViews: { posts: true, reviews: true } },
      },
      200,
    );
    const conceptId = await f.subject('Native contribution discussion board');
    const discussionBoard = (
      await f.checked('POST', '/v1/boards', {
        bearer: f.author.bearer,
        body: { conceptId, title: 'Contribution discussions', purpose: 'discussion', visibility: 'published' },
      })
    ).board.id as string;
    for (const person of [f.author, f.other])
      await f.grant(discussionBoard, person.accountId, ['thread:create', 'board:read']);

    const thread = async (kind: 'review' | 'discussion' = 'discussion') => {
      // A live review slot belongs to an author/subject pair. Never reuse that slot
      // as incidental setup for another independently selected journey.
      const subjectIds = kind === 'review' ? [await f.subject('Selected contribution review')] : [];
      await f.setTime((f.dependencies.clock?.() ?? new Date()).getTime() + 1);
      return (
        await f.checked('POST', '/v1/threads', {
          bearer: f.author.bearer,
          body: {
            kind,
            title: 'Native selected contribution',
            body: fromPlainText('Exact contribution opening'),
            licence: 'CC0-1.0',
            boardId: kind === 'review' ? f.boardId : discussionBoard,
            subjectIds,
            visibility: 'published',
          },
        })
      ).thread;
    };
    const admit = async (view: AuthorContributionActionsInput['view'], cursor: string | null = null, limit = 20) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (view !== 'posts') query.set('kind', view === 'reviews' ? 'review' : 'discussion');
      if (cursor !== null) query.set('cursor', cursor);
      const path = `/v1/accounts/${f.author.accountId}/${view === 'posts' ? 'posts' : 'threads'}?${query}`;
      const page = await f.call('GET', path);
      if (page.response.status !== 200 || !page.value.actionSelection)
        throw new Error(`Native author admission failed: ${page.response.status} ${page.text}`);
      const input: AuthorContributionActionsInput = {
        view,
        cursor,
        ...structuredClone(page.value.actionSelection),
      };
      for (const reference of input.references) Object.freeze(reference);
      Object.freeze(input.references);
      Object.freeze(input);
      const read = (bearer?: string) =>
        f.call('POST', `/v1/accounts/${f.author.accountId}/contribution-actions`, {
          ...(bearer === undefined ? {} : { bearer }),
          body: input,
        });
      return { page, input, read };
    };
    const duringAssembly = async (
      selected: Awaited<ReturnType<typeof admit>>,
      mutate: () => Promise<unknown>,
      bearer = f.other.bearer,
    ) => {
      const observer = observeSql(f.system.database.pool);
      const gate = observer.hold({ statement: counts.sql }, 'before');
      const pending = selected.read(bearer);
      try {
        await Promise.race([
          gate.entered,
          pending.then((result) => {
            throw new Error(`Private assembly was not reached: ${result.response.status} ${result.text}`);
          }),
        ]);
        await mutate();
        gate.release();
        return await pending;
      } finally {
        gate.release();
        await pending.catch(() => {});
        await observer.close();
      }
    };
    return { ...f, thread, admit, duringAssembly, discussionBoard };
  } catch (error) {
    try {
      await f.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Author contribution fixture setup failed', { cause: error });
    }
    throw error;
  }
}
