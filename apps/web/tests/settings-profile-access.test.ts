import { expect, test } from 'bun:test';
import { readAgentProfile } from '../features/auth/agent-profile.ts';

const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';

test('settings reads a private profile through the controlling person’s bearer and acting subject', async () => {
  const prior = process.env.WEB_OAUTH_CLIENT_ID;
  process.env.WEB_OAUTH_CLIENT_ID = 'test-client';
  try {
    let requested = '';
    let authorization = '';
    const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requested = String(input);
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return Response.json({ id: agent, revision: agent, displayName: 'Ada Lovelace',
        bio: null, avatarSelection: null, avatarUrl: null });
    }) as typeof fetch;
    const profile = await readAgentProfile(agent, 'private-token', send);
    expect(profile?.displayName).toBe('Ada Lovelace');
    expect(new URL(requested).searchParams.get('actingSubject')).toBe(agent);
    expect(authorization).toBe('Bearer private-token');
  } finally {
    if (prior === undefined) delete process.env.WEB_OAUTH_CLIENT_ID;
    else process.env.WEB_OAUTH_CLIENT_ID = prior;
  }
});
