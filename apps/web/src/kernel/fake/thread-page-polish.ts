import type { FakeRoute } from '../fake-modules.ts';

const boardId = '01a17a3b-09a4-7204-87d4-43219f9a15ad';
const threadId = '01a17a3b-09b4-77bf-a24b-1234ebeab5b2';

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: `/v1/boards/${boardId}/threads`,
    story: ({ recordings }) => {
      const recording = recordings['board-threads'];
      const threads = recording?.threads;
      if (!recording || !Array.isArray(threads) || !threads[0]) return undefined;
      const original = threads[0] as Record<string, unknown>;
      const firstPost = original.firstPost as Record<string, unknown>;
      const longTitle = {
        ...original,
        id: '01a17a3b-09b4-77bf-a24b-1234ebeab5b3',
        title: 'A long title about the quiet planet, the little fox, and the stars that guide every traveler home',
      };
      const untitled = {
        ...original,
        id: '01a17a3b-09b4-77bf-a24b-1234ebeab5b4',
        title: null,
        firstPost: {
          ...firstPost,
          body: {
            version: 'rezics-document-v1',
            profile: 'blocks',
            doc: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  attrs: { id: 'opening-thought' },
                  content: [{ type: 'text', text: 'When the stars are quiet, where does the fox sleep?' }],
                },
              ],
            },
          },
        },
      };
      return { ...recording, threads: [threads[0], longTitle, untitled] };
    },
  },
  {
    method: 'GET',
    path: `/v1/threads/${threadId}/posts`,
    story: ({ recordings }) => {
      const recording = recordings['thread-posts'];
      const posts = recording?.posts;
      if (!recording || !Array.isArray(posts)) return undefined;
      const revisedPosts = posts.map((post, index) => {
        if (!post || typeof post !== 'object') return post;
        const copy = { ...(post as Record<string, unknown>) };
        if (index === 1) delete copy.revisedAt;
        if (index === 2 && typeof copy.createdAt === 'string') copy.revisedAt = copy.createdAt;
        return copy;
      });
      return { ...recording, posts: revisedPosts };
    },
  },
];
