import { expect, test } from 'bun:test';
import type { MainClient } from '../features/discover/types.ts';
import { readSetupFirstPost } from '../features/communities/setup-first-post.ts';

const actor = 'https://rezics.com/id/00000000-0000-8000-8000-000000000412';
const realm = 'https://rezics.com/id/00000000-0000-8000-8000-000000000436';

test('a private Realm checklist names the member on the thread read', async () => {
  let query: unknown;
  const main = {
    v1: {
      realms: () => ({
        threads: {
          get: async (input: { query: unknown }) => {
            query = input.query;
            return {
              data: {
                items: [{ reply: 'https://rezics.com/id/00000000-0000-8000-8000-000000000099' }],
              },
            };
          },
        },
      }),
    },
  } as unknown as MainClient;
  expect(await readSetupFirstPost(main, realm, actor)).toBe(true);
  expect(query).toEqual({ sort: 'new', limit: 1, actingSubject: actor });
});

test('no thread means the first post is still to write', async () => {
  const main = {
    v1: { realms: () => ({ threads: { get: async () => ({ data: { items: [] } }) } }) },
  } as unknown as MainClient;
  expect(await readSetupFirstPost(main, realm, actor)).toBe(false);
});
