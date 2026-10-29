import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { loadProfileRecord, saveProfileRecord, type ProfileValues } from '../src/settings/profile-data';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';

const account = {
  id: 'alice',
  kind: 'actor',
  handle: 'alice',
  displayName: 'Alice',
  bio: 'A short bio',
  avatar: { id: 'media-old', url: '/media/old' },
  links: [{ label: 'Home', url: 'https://example.test' }],
  publicViews: { posts: true, reviews: true, collections: true, realms: true },
  verified: false,
  subject: null,
};

function clientFor(handler: (request: Request) => Response | Promise<Response>) {
  const calls: { method: string; url: string; body: unknown; key: string | null }[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      let body: unknown = null;
      if (request.method === 'PATCH') body = await request.json();
      calls.push({
        method: request.method,
        url: new URL(request.url).pathname + new URL(request.url).search,
        body,
        key: request.headers.get('idempotency-key'),
      });
      return handler(request);
    }) as typeof fetch,
  });
  return { client, calls };
}

test('profile story responses accept the relative URL used by PageStory and include extended identity data', async () => {
  const storyGlobal = globalThis as typeof globalThis & {
    __rezicsStoryContext?: { visitor: 'Signed In' | 'Signed Out'; url: string };
  };
  const previous = storyGlobal.__rezicsStoryContext;
  storyGlobal.__rezicsStoryContext = { visitor: 'Signed In', url: '/en/settings?profile=extended' };
  try {
    const response = await createStoryRecordedKernelFetch()(
      new Request('http://kernel.local/v1/accounts?ids=story-viewer'),
    );
    const body = (await response.json()) as { accounts: Array<Record<string, unknown>> };
    expect(response.status).toBe(200);
    expect(body.accounts[0]).toMatchObject({
      id: 'story-viewer',
      kind: 'actor',
      displayName: 'Avery Reader',
      avatar: { id: 'story-avatar' },
    });
    expect(body.accounts[0]?.links).toHaveLength(5);
    expect(String(body.accounts[0]?.bio).length).toBeGreaterThan(200);
  } finally {
    if (previous === undefined) delete storyGlobal.__rezicsStoryContext;
    else storyGlobal.__rezicsStoryContext = previous;
  }
});

test('profile reads the signed-in identity by id, then loads editable values by handle', async () => {
  const { client, calls } = clientFor((request) =>
    new URL(request.url).searchParams.has('ids')
      ? Response.json({ accounts: [{ id: 'alice', kind: 'actor', handle: 'alice', displayName: 'Alice' }] })
      : Response.json({ accounts: [account] }),
  );
  const profile = await loadProfileRecord(client, 'Bearer page-token', 'alice');
  expect(profile).toMatchObject({
    accountId: 'alice',
    kind: 'actor',
    displayName: 'Alice',
    biography: 'A short bio',
    avatar: { id: 'media-old' },
    links: [{ label: 'Home', url: 'https://example.test' }],
  });
  expect(calls).toEqual([
    { method: 'GET', url: '/v1/accounts?ids=alice', body: null, key: null },
    { method: 'GET', url: '/v1/accounts?handle=alice', body: null, key: null },
  ]);
  expect(profile).not.toHaveProperty('speakersListed');
});

test('profile save sends only changed fields and an idempotency key, then returns the confirmed values', async () => {
  const { client, calls } = clientFor(() => Response.json({ ...account, displayName: 'Alice A.' }));
  const before = account as unknown as ProfileValues;
  const result = await saveProfileRecord(
    client,
    'Bearer page-token',
    'alice',
    before,
    {
      ...before,
      displayName: 'Alice A.',
    },
    '123e4567-e89b-42d3-a456-426614174000',
  );
  expect(result).toMatchObject({ ok: true, profile: { displayName: 'Alice A.' } });
  expect(calls).toEqual([
    {
      method: 'PATCH',
      url: '/v1/accounts/alice',
      body: { displayName: 'Alice A.' },
      key: '123e4567-e89b-42d3-a456-426614174000',
    },
  ]);
});

test('public activity patches only the switched key and links reject a sixth row before a write', async () => {
  const { client, calls } = clientFor(() =>
    Response.json({ ...account, publicViews: { ...account.publicViews, posts: false } }),
  );
  await saveProfileRecord(
    client,
    'Bearer page-token',
    'alice',
    account as unknown as ProfileValues,
    { ...account, publicViews: { ...account.publicViews, posts: false } } as unknown as ProfileValues,
    '123e4567-e89b-42d3-a456-426614174000',
  );
  expect(calls[0]?.body).toEqual({ publicViews: { posts: false } });
  await expect(
    saveProfileRecord(
      client,
      'Bearer page-token',
      'alice',
      account as unknown as ProfileValues,
      {
        ...account,
        links: Array.from({ length: 6 }, (_, index) => ({
          label: `Link ${index}`,
          url: `https://example.test/${index}`,
        })),
      } as unknown as ProfileValues,
      '123e4567-e89b-42d3-a456-426614174001',
    ),
  ).rejects.toThrow();
  expect(calls).toHaveLength(1);
});

test('removing an avatar sends null and link edits are sent as the complete labelled list', async () => {
  const { client, calls } = clientFor(() => Response.json({ ...account, avatar: null }));
  const before = account as unknown as ProfileValues;
  await saveProfileRecord(
    client,
    'Bearer page-token',
    'alice',
    before,
    { ...before, avatar: null },
    '123e4567-e89b-42d3-a456-426614174000',
  );
  expect(calls[0]?.body).toEqual({ avatar: null });
  await saveProfileRecord(
    client,
    'Bearer page-token',
    'alice',
    before,
    {
      ...before,
      links: [...before.links, { label: 'Notes', url: 'https://notes.example.test' }],
    },
    '123e4567-e89b-42d3-a456-426614174001',
  );
  expect(calls[1]?.body).toEqual({
    links: [
      { label: 'Home', url: 'https://example.test' },
      { label: 'Notes', url: 'https://notes.example.test' },
    ],
  });
});

test('an organization exposes speakersListed; API refusals retain their status for the form message', async () => {
  const organization = { ...account, id: 'org', kind: 'organization', speakersListed: false };
  const { client, calls } = clientFor(() => Response.json({ ...organization, speakersListed: true }));
  const saved = await saveProfileRecord(
    client,
    'Bearer page-token',
    'org',
    organization as unknown as ProfileValues,
    { ...organization, speakersListed: true } as unknown as ProfileValues,
    '123e4567-e89b-42d3-a456-426614174000',
  );
  expect(saved).toMatchObject({ ok: true, profile: { speakersListed: true } });
  expect(calls[0]?.body).toEqual({ speakersListed: true });

  for (const status of [400, 403, 409, 422]) {
    const refused = clientFor(() =>
      Response.json({ code: `error_${status}`, detail: `refused ${status}` }, { status }),
    );
    const answer = await saveProfileRecord(
      refused.client,
      'Bearer page-token',
      'alice',
      account as unknown as ProfileValues,
      { ...account, displayName: 'Draft remains' } as unknown as ProfileValues,
      '123e4567-e89b-42d3-a456-426614174000',
    );
    expect(answer).toMatchObject({ ok: false, status });
  }
});
