import { expect, test } from 'bun:test';
import { loadSubjectPage } from '../src/features/pages/subject';
import { accountOf } from '../src/features/pages/account-read';
import { accountSchemaType } from '../src/features/pages/account';
import { subjectAccountRedirect } from '../src/features/pages/subject';

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
                account: { status: 200, body: { accounts: [{ id: 'account-id', state: 'active', handle: 'helper' }] } },
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
