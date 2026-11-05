import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import type { SessionEnv } from '../src/session/client';
import { newCsrfToken } from '../src/session/csrf';
import { boundViewer } from '../src/accounts/profile-editor/request';
import { AccountProfileEditor } from '../src/accounts/profile-editor/editor';
import { parseSubmission, profilePageReadError, readTarget, writeTarget } from '../src/accounts/profile-editor/data';
import type { ProfilePatch, ProfileValues } from '../src/settings/profile-data';
import { officialProfileRead } from '../src/settings/editable-profile-source';

const accountId = '00000000-0000-7000-8000-000000000002';
const viewerId = '00000000-0000-7000-8000-000000000001';
const otherId = '00000000-0000-7000-8000-000000000003';
const mediaId = '00000000-0000-7000-8000-000000000004';
const target = { accountId, viewerId };
function profile(): ProfileValues {
  return {
    accountId,
    kind: 'organization',
    displayName: 'Managed organization',
    biography: 'Native biography',
    avatar: {
      media: mediaId,
      width: 96,
      height: 80,
      placeholder: { thumbhash: 'native', color: '#123456' },
      variants: [{ format: 'avif', width: 96 }],
      focalPoint: null,
      credit: null,
    },
    links: [{ label: 'Home', url: 'https://example.test/' }],
    publicViews: { posts: false, reviews: true, collections: false, realms: false },
    speakersListed: false,
  };
}
// Exercise the real client transport and product controller. These responses are consumer fixtures,
// not proof of the native permission formula, which remains covered by the existing native oracles.
function boundary() {
  let current = profile();
  let readStatus = 200;
  let readOverride: unknown;
  let loseReply = false;
  let supersede = false;
  const requests: Request[] = [];
  const writes: { body: ProfilePatch; key: string | null }[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      expect(request.headers.get('authorization')).toBe('Bearer current-viewer');
      expect(request.cache).toBe('no-store');
      const path = new URL(request.url).pathname;
      if (request.method === 'GET') {
        expect(path).toBe(`/v1/accounts/${accountId}/profile`);
        if (readStatus !== 200) return Response.json({ code: 'forbidden' }, { status: readStatus });
        const { accountId: id, biography: bio, ...fields } = current;
        return Response.json(readOverride ?? officialProfileRead({ id, handle: null, bio, ...fields }, viewerId));
      }
      expect(request.method).toBe('PATCH');
      expect(path).toBe(`/v1/accounts/${accountId}`);
      const body = (await request.json()) as ProfilePatch;
      writes.push({ body, key: request.headers.get('idempotency-key') });
      current = {
        ...current,
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        publicViews: { ...current.publicViews, ...body.publicViews },
        ...(body.speakersListed !== undefined ? { speakersListed: body.speakersListed } : {}),
      };
      if (loseReply) {
        loseReply = false;
        throw new Error('Reply lost after commit');
      }
      if (supersede) current.displayName = 'Changed since acknowledgement';
      return Response.json({ accountId });
    }) as typeof fetch,
  });
  const editor = new AccountProfileEditor({
    read: async () => {
      const page = await readTarget(client, 'Bearer current-viewer', target);
      if (page.state !== 'ready') throw profilePageReadError(page);
      return page.profile;
    },
    save: (attempt) =>
      writeTarget(
        client,
        'Bearer current-viewer',
        parseSubmission({
          ...target,
          patch: attempt.patch,
          idempotencyKey: attempt.idempotencyKey,
          confirmed: true,
        }),
      ),
  });
  return {
    editor,
    requests,
    writes,
    client,
    status: (status: number) => {
      readStatus = status;
    },
    response: (value: unknown) => {
      readOverride = value;
    },
    loseReply: () => {
      loseReply = true;
    },
    supersede: () => {
      supersede = true;
    },
  };
}

test('Edit a genuinely managed account profile from its native target preserves exact native authority current-account binding explicit confirmation and unavailable states', async () => {
  const api = boundary();
  await api.editor.reload();
  expect(api.editor.snapshot().known).toEqual(profile());
  api.editor.edit({ displayName: 'Edited managed account' });
  await api.editor.submit('profile');
  expect(api.editor.confirmationSnapshot()).toBe('profile');
  expect(api.writes).toHaveLength(0);
  api.editor.edit({ displayName: 'Not approved' });
  await api.editor.confirm();
  expect(api.writes[0]?.body).toEqual({ displayName: 'Edited managed account' });
  expect(api.editor.snapshot().phase).toBe('saved');
  expect(api.editor.snapshot().known?.avatar).toEqual(profile().avatar);
  expect(api.requests.map((r) => r.method)).toEqual(['GET', 'GET', 'PATCH', 'GET']);
  api.editor.edit({ speakersListed: true });
  await api.editor.submit('views');
  expect(api.writes).toHaveLength(1);
  await api.editor.confirm();
  expect(api.writes[1]?.body).toEqual({ speakersListed: true });
  expect(api.editor.snapshot().known?.speakersListed).toBe(true);

  for (const [status, expected] of [
    [403, 'denied'],
    [404, 'missing'],
    [503, 'unavailable'],
  ] as const) {
    const denied = boundary();
    denied.status(status);
    expect(await readTarget(denied.client, 'Bearer current-viewer', target)).toEqual({ state: expected });
    await denied.editor.reload();
    expect(denied.editor.snapshot().draft).toBeNull();
    await denied.editor.submit('profile');
    await denied.editor.confirm();
    expect(denied.writes).toHaveLength(0);
  }
});

test('Unknown replies keep the exact key and body; current readback and current rights decide completion', async () => {
  const api = boundary();
  await api.editor.reload();
  api.editor.edit({ displayName: 'Original immutable change' });
  await api.editor.submit('profile');
  api.loseReply();
  await api.editor.confirm();
  const original = api.editor.snapshot().attempt;
  expect(api.writes[0]?.key).toBe(JSON.stringify(original?.idempotencyKey));
  expect(api.editor.snapshot().phase).toBe('uncertain');
  expect(Object.isFrozen(original?.patch)).toBe(true);
  api.editor.edit({ displayName: 'Later draft' });
  api.status(403);
  await api.editor.retry();
  expect(api.writes).toHaveLength(1);
  expect(api.editor.snapshot().attempt).toBe(original);
  api.status(200);
  api.supersede();
  await api.editor.retry();
  expect(api.writes[1]).toEqual(api.writes[0]);
  expect(api.editor.snapshot().known?.displayName).toBe('Changed since acknowledgement');
  expect(api.editor.snapshot().draft?.displayName).toBe('Later draft');
  expect(api.editor.snapshot().phase).toBe('review');
  expect(api.editor.snapshot().attempt).toBeNull();
});

test('Closed input and wrong-target native output never create a replacement target or write authority', async () => {
  const api = boundary();
  const { accountId: _id, biography: bio, ...fields } = profile();
  api.response({ profile: { ...fields, id: otherId, handle: null, bio } });
  await api.editor.reload();
  expect(api.editor.snapshot().known).toBeNull();
  const input = { ...target, confirmed: true, idempotencyKey: crypto.randomUUID(), patch: { displayName: 'New' } };
  expect(() => parseSubmission({ ...input, authorization: 'Bearer administrator' })).toThrow();
  expect(() => parseSubmission({ ...input, confirmed: false })).toThrow();
  expect(() => parseSubmission({ ...input, patch: { operatorId: viewerId } })).toThrow();
  expect(() =>
    parseSubmission({
      ...input,
      patch: { links: Array.from({ length: 6 }, () => ({ label: 'A', url: 'https://example.test' })) },
    }),
  ).toThrow();
  expect(() =>
    parseSubmission({ ...input, patch: { links: [{ label: 'A', url: 'https://user:pass@example.test' }] } }),
  ).toThrow();
  expect(api.writes).toHaveLength(0);
  const otherEditor = new AccountProfileEditor({
    read: async () => ({ ...profile(), accountId: otherId }),
    save: async () => {
      throw new Error('Unexpected write');
    },
  });
  await otherEditor.reload();
  expect(otherEditor.snapshot().known?.accountId).toBe(otherId);
  expect(otherEditor.snapshot().attempt).toBeNull();
  expect(otherEditor.confirmationSnapshot()).toBeNull();
});

test('delegated profile advice binds the signed-in viewer separately from the selected target', async () => {
  const api = boundary();
  const { accountId: id, biography: bio, ...fields } = profile();
  expect(await readTarget(api.client, 'Bearer current-viewer', target)).toMatchObject({
    state: 'ready',
    profile: { accountId, editing: { viewer: { accountId: viewerId }, target: { accountId } } },
  });
  api.response(officialProfileRead({ id, handle: null, bio, ...fields }, otherId));
  expect(await readTarget(api.client, 'Bearer current-viewer', target)).toEqual({ state: 'unavailable' });
  expect(api.writes).toHaveLength(0);
});

test('The BFF binds the current cookie viewer and rejects Origin, CSRF and bearer replacement before transport', async () => {
  const csrfToken = newCsrfToken();
  const env = {
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://api.example.test',
    WEBSITE_SCOPES: 'account:update',
    WEBSITE_CLIENT_ID: 'website',
    WEBSITE_CLIENT_KEY: 'configured',
    SITE_ORIGINS: 'https://www.example.test',
    SESSIONS: {
      idFromName: () => 'session',
      get: () => ({
        credential: async () => ({
          status: 'active',
          subject: viewerId,
          accessToken: 'current-viewer',
          csrfToken,
        }),
      }),
    },
  } as unknown as SessionEnv;
  const request = (headers: Record<string, string> = {}) =>
    new Request('https://www.example.test/_serverFn/profile', {
      method: 'POST',
      headers: {
        cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
        origin: 'https://www.example.test',
        'X-CSRF-Token': csrfToken,
        ...headers,
      },
    });
  expect(await boundViewer(request(), env, viewerId)).toBe('Bearer current-viewer');
  expect(await boundViewer(request(), env, otherId)).toBeNull();
  expect(await boundViewer(request({ authorization: 'Bearer replacement' }), env, viewerId)).toBeNull();
  await expect(boundViewer(request({ origin: 'https://foreign.example.test' }), env, viewerId)).rejects.toBeDefined();
  await expect(boundViewer(request({ 'X-CSRF-Token': newCsrfToken() }), env, viewerId)).rejects.toBeDefined();
});
