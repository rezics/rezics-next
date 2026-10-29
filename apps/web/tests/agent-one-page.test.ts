import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import agentRecording from '../src/kernel/recorded/agent-page.json';
import { agentPageHead, agentPagePaths } from '../src/features/pages/agent-page';
import { readPageAuthors } from '../src/identity/read';
import { SubjectPage } from '../src/features/pages/subject';
import { loadSubjectPage } from '../src/features/pages/subject';
import { accountOf } from '../src/features/pages/account-read';
import { accountSchemaType } from '../src/features/pages/account';
import { subjectAccountRedirect } from '../src/features/pages/subject';
import { routes as agentRoutes } from '../src/kernel/fake/agent-one-page';
import { loadViewPages } from '../src/features/pages/subject-frame';
import { readRelationsPage } from '../src/features/pages/relations-view';

const redirectedClient = (data: unknown) =>
  ({
    pages: { $read: { post: async () => ({ status: 200, data }) } },
  }) as never;

test('a subject read redirected to an account handle is treated as an agent redirect', async () => {
  const result = await loadSubjectPage(
    redirectedClient({ subject: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e81', reads: {} }),
    '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e80',
    'reviews',
    'zh-Hans',
  );
  expect(result).toEqual({ kind: 'redirect', id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e81' });
});

test('a followed subject redirect uses the handle returned by the page read', async () => {
  const requests: unknown[] = [];
  const client = {
    pages: {
      $read: {
        post: async (request: unknown) => {
          requests.push(request);
          return {
            status: 200,
            data: {
              subject: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e80',
              account: 'account-id',
              document: { root: { props: {} }, content: [{ type: 'AccountIdentity', props: { id: 'account' } }] },
              reads: {
                r0: { status: 200, body: { accounts: [{ id: 'account-id', state: 'active', handle: 'helper' }] } },
              },
            },
          };
        },
      },
    },
  } as never;
  const result = await loadSubjectPage(client, '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e80', 'reviews', 'zh-Hans');
  expect(result).toEqual({ kind: 'redirect', id: 'helper', target: 'account' });
  expect(requests).toHaveLength(1);
});

test('an unfollowed 308 page response uses the handle in its redirect descriptor', async () => {
  const client = {
    pages: { $read: { post: async () => ({ status: 308, data: { redirect: { from: 'subject', to: 'helper' } } }) } },
  } as never;
  const result = await loadSubjectPage(client, '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e80', 'reviews', 'zh-Hans');
  expect(result).toEqual({ kind: 'redirect', id: 'helper', target: 'account' });
});

test('a redirected subject document keeps its locale, view, and query on the handle URL with status 308', () => {
  expect(subjectAccountRedirect('zh-Hans', 'helper', 'reviews', '?sort=recent&tag=a%20b')).toEqual({
    statusCode: 308,
    href: '/zh-Hans/@helper/reviews?sort=recent&tag=a%20b',
  });
  expect(subjectAccountRedirect('en', 'helper', undefined, '?q=two+words')).toEqual({
    statusCode: 308,
    href: '/en/@helper?q=two+words',
  });
});

test('account profiles preserve automation and the public identity operator id', () => {
  const profile = accountOf({
    accounts: [
      {
        id: 'automated-account',
        state: 'active',
        kind: 'actor',
        automated: true,
        operatorId: 'operator-account',
        handle: 'helper',
        links: [],
      },
    ],
  });
  expect(profile).toMatchObject({ automated: true, operatorId: 'operator-account' });
});

test('automated, organization, and fallback account types map to their schema types', () => {
  const automated = accountOf({
    accounts: [{ id: 'bot', state: 'active', kind: 'actor', automated: true, links: [] }],
  })!;
  const organization = accountOf({ accounts: [{ id: 'org', state: 'active', kind: 'organization', links: [] }] })!;
  const person = accountOf({
    accounts: [{ id: 'person', state: 'active', kind: 'actor', automated: false, links: [] }],
  })!;
  expect(accountSchemaType(automated)).toBe('schema:SoftwareApplication');
  expect(accountSchemaType(organization)).toBe('schema:Organization');
  expect(accountSchemaType(person)).toBe('schema:Person');
});

test('ordinary and organization account descriptors remain distinguishable', () => {
  expect(accountOf({ accounts: [{ id: 'person', state: 'active', kind: 'actor', links: [] }] })?.kind).toBe('actor');
  expect(accountOf({ accounts: [{ id: 'org', state: 'active', kind: 'organization', links: [] }] })?.kind).toBe(
    'organization',
  );
});

test('an automated agent uses SoftwareApplication JSON-LD and shows its operator as a page link', () => {
  const page = structuredClone(agentRecording) as any;
  page.account = { id: page.account, handle: page.handle };
  const profileRead = Object.values(page.reads).find((read: any) => Array.isArray(read.body?.accounts)) as any;
  profileRead.body.accounts[0].automated = true;
  profileRead.body.accounts[0].operatorId = 'operator-account';
  const paths = agentPagePaths('helper');
  const head = agentPageHead(page, 'en', 'https://rezics.test', paths);
  const jsonLd = JSON.parse(head.scripts.find((script: any) => script.type === 'application/ld+json')!.children);
  expect(jsonLd['@graph'][0].mainEntity['@type']).toBe('SoftwareApplication');

  const queryClient = new QueryClient();
  queryClient.setQueryData(['exposure', 'anonymous'], []);
  const html = renderToString(
    createElement(QueryClientProvider, {
      client: queryClient,
      children: createElement(SubjectPage, {
        page,
        locale: 'en',
        messages: {
          unknown: 'Unknown',
          none: 'None',
          unlabelled: 'Unlabelled',
          sources: 'Sources',
          aliases: 'Aliases',
          details: 'Details',
        },
        operator: { id: 'operator-account', handle: 'operator', displayName: 'Operator Name' },
        base: '/en/@helper',
        renderJsonLd: false,
      } as never),
    }),
  );
  expect(html).toContain('Operated by');
  expect(html).toMatch(/href="\/en\/@operator"[^>]*>Operator Name<\/a>/);
});

test("the account page's optional operator lookup is one public identity read", async () => {
  const calls: string[] = [];
  const client = {
    accounts: {
      get: async ({ query }: { query: { ids: string } }) => {
        calls.push(query.ids);
        return { data: { accounts: [{ id: 'operator-account', handle: 'operator', displayName: 'Operator Name' }] } };
      },
    },
  } as never;
  const identities = await readPageAuthors(client, ['operator-account', 'operator-account']);
  expect(calls).toEqual(['operator-account']);
  expect(identities?.['operator-account']).toMatchObject({ handle: 'operator', displayName: 'Operator Name' });
});

test('a followed handle page takes precedence over a merged subject survivor without another read', async () => {
  let reads = 0;
  const client = {
    pages: {
      $read: {
        post: async () => {
          reads += 1;
          return {
            status: 200,
            data: {
              subject: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e81',
              account: 'account-id',
              document: { root: { props: {} }, content: [{ type: 'AccountIdentity', props: { id: 'account' } }] },
              reads: {
                r0: { status: 200, body: { accounts: [{ id: 'account-id', state: 'active', handle: 'helper' }] } },
              },
            },
          };
        },
      },
    },
  } as never;
  expect(await loadSubjectPage(client, '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e80', 'reviews', 'en')).toEqual({
    kind: 'redirect',
    id: 'helper',
    target: 'account',
  });
  expect(reads).toBe(1);
});

test('the operator fake answers its own identity without replacing unrelated public identities', async () => {
  const route = agentRoutes.find((route) => route.path === '/v1/accounts')!;
  for (const answer of [route.story!, route.fixture!]) {
    const context = (ids: string) =>
      ({ request: new Request(`https://kernel.test/v1/accounts?ids=${ids}`), recordings: {}, match: null }) as never;
    expect(await answer(context('unrelated-account'))).toBeUndefined();
    expect(await answer(context('0192f3a0-6c1e-7b2a-f001-000000000009'))).toMatchObject({
      status: 200,
      accounts: [{ handle: 'operator', displayName: 'Operator Name' }],
    });
  }
});

test('a redirected subject view stops after its page read without loading the overview', async () => {
  const requests: unknown[] = [];
  const client = {
    pages: {
      $read: {
        post: async (request: unknown) => {
          requests.push(request);
          return { status: 308, data: { redirect: { from: 'subject', to: 'helper' } } };
        },
      },
    },
  } as never;
  expect(await loadViewPages(client, '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e80', 'reviews', 'zh-Hans')).toEqual({
    kind: 'redirect',
    id: 'helper',
    target: 'account',
  });
  expect(requests).toEqual([
    { target: { subject: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e80', view: 'reviews' }, languages: ['zh-Hans'] },
  ]);
});

test('a redirected relations view never reads inverse links', async () => {
  const requests: unknown[] = [];
  const client = {
    pages: {
      $read: {
        post: async (request: unknown) => {
          requests.push(request);
          return { status: 308, data: { redirect: { from: 'subject', to: 'helper' } } };
        },
      },
    },
  } as never;
  expect(await readRelationsPage(client, { id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e80', locale: 'en' })).toEqual({
    overview: { kind: 'redirect', id: 'helper', target: 'account' },
    links: null,
  });
  expect(requests).toEqual([{ target: { subject: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e80' }, languages: ['en'] }]);
});
