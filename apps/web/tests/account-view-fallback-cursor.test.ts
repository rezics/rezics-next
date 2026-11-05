import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { profilePage } from '../src/stories/pages/accounts-public-profile/fixtures';
mock.module('cloudflare:workers', () => ({ env: {} }));
const { loadPublicAccountJourney } = await import('../src/accounts/public-profile/page-read');
test.each(['missing', 'private', 'unlisted', 'realms', 'former'])(
  '%s fallback preserves unrelated query selection',
  async (state) => {
    const page = profilePage({
      profile: { handle: 'reader', publicViews: { posts: state !== 'private', realms: false } },
    });
    page.views = state === 'unlisted' ? ['overview'] : ['overview', 'posts'];
    const calls: string[] = [];
    const client = createKernelClient('https://kernel.test', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        calls.push(new URL(request.url).pathname);
        if (request.method === 'GET')
          return Response.json({
            accounts: [{ id: page.account!.id, state: 'active', movedTo: state === 'former' ? 'reader' : undefined }],
          });
        const { target } = (await request.json()) as { target: { view?: string } };
        return target.view && ['missing', 'former'].includes(state)
          ? Response.json({}, { status: 404 })
          : Response.json({ ...page, account: page.account!.id });
      }) as typeof fetch,
    });
    for (const [search, clean] of [
      ['?cursor=old', ''],
      ['?realm=r&q=a%20b&cursor=old&%63ursor=again&realm=s', '?realm=r&q=a%20b&realm=s'],
      ['?q=a+b', '?q=a+b'],
    ]) {
      const result = await loadPublicAccountJourney(client, {
        handle: 'old',
        locale: 'ja',
        view: state === 'realms' ? 'realms' : 'posts',
        search,
        cursor: 'old',
      });
      expect(result).toEqual({
        kind: 'redirect',
        redirectTo: `/ja/@reader${state === 'former' ? '/posts' + search : clean}`,
      });
    }
    expect(calls).toEqual(
      Array.from({ length: 3 }, () =>
        state === 'realms'
          ? ['/v1/pages:read']
          : ['/v1/pages:read', '/v1/pages:read', ...(['missing', 'former'].includes(state) ? ['/v1/accounts'] : [])],
      ).flat(),
    );
  },
);
