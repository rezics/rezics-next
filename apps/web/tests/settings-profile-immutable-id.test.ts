import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  loadProfileRecord,
  saveProfileRecord,
  type ProfilePatch,
  type ProfileValues,
} from '../src/settings/profile-data';
import { ProfileEditor } from '../src/settings/profile-write';

const accountId = '019a0000-0000-7000-8000-000000000001';
const mediaId = '019a0000-0000-7000-8000-000000000002';
function source(kind: ProfileValues['kind'] = 'actor'): ProfileValues {
  return {
    accountId,
    kind,
    displayName: null,
    biography: 'Private editable source',
    avatar: {
      media: mediaId,
      width: 96,
      height: 80,
      placeholder: { thumbhash: 'actual-thumbhash', color: '#123456' },
      variants: [
        { format: 'avif', width: 96 },
        { format: 'webp', width: 48 },
      ],
      focalPoint: { x: 0.25, y: 0.75 },
      credit: null,
    },
    links: [{ label: 'Notes', url: 'https://example.test/notes' }],
    publicViews: { posts: false, reviews: true, collections: false, realms: true },
    ...(kind === 'organization' ? { speakersListed: false } : {}),
  };
}

// Transport responses exercise the consumer boundary; native authority remains the Accounts API's responsibility.
function boundary(authorization: string, initial = source()) {
  let current = structuredClone(initial);
  let readStatus = 200;
  let writeStatus = 200;
  let readBody: unknown;
  const requests: Request[] = [];
  const writes: ProfilePatch[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      expect(request.headers.get('authorization')).toBe(authorization);
      const url = new URL(request.url);
      expect(url.search).toBe('');
      if (request.method === 'GET') {
        expect(url.pathname).toBe(`/v1/accounts/${accountId}/profile`);
        const { accountId: id, biography: bio, ...fields } = current;
        return Response.json(readBody ?? { profile: { id, handle: null, bio, ...fields } }, {
          status: readStatus,
          headers: { 'cache-control': 'private, no-store' },
        });
      }
      expect(request.method).toBe('PATCH');
      expect(url.pathname).toBe(`/v1/accounts/${accountId}`);
      expect(request.headers.get('idempotency-key')).toBeTruthy();
      const patch = (await request.json()) as ProfilePatch;
      writes.push(patch);
      if (writeStatus !== 200) return Response.json({ code: 'forbidden' }, { status: writeStatus });
      current = {
        ...current,
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        ...(patch.biography !== undefined ? { biography: patch.biography } : {}),
        ...(patch.links !== undefined ? { links: patch.links } : {}),
        publicViews: { ...current.publicViews, ...patch.publicViews },
        ...(patch.speakersListed !== undefined ? { speakersListed: patch.speakersListed } : {}),
      };
      return Response.json({ accountId });
    }) as typeof fetch,
  });
  return {
    editor: new ProfileEditor({
      read: () => loadProfileRecord(client, authorization, accountId),
      save: (attempt) =>
        saveProfileRecord(client, authorization, accountId, attempt.before, attempt.after, attempt.idempotencyKey),
    }),
    requests,
    writes,
    current: () => current,
    denyWrite: () => {
      writeStatus = 403;
    },
    respond: (status: number, body: unknown) => {
      readStatus = status;
      readBody = body;
    },
  };
}

test('Handleless and operated accounts load actual editable self profile by immutable native ID and can save only under the existing backend authority', async () => {
  for (const authorization of ['Bearer handleless-owner', 'Bearer current-operator-authority']) {
    const api = boundary(authorization);
    await api.editor.reload();
    expect(api.editor.snapshot().known).toEqual(source());
    expect(api.requests).toHaveLength(1);
    api.editor.edit({ displayName: 'Edited source', biography: null });
    await api.editor.submit('profile');
    expect(api.editor.snapshot().phase).toBe('saved');
    expect(api.writes).toEqual([{ displayName: 'Edited source', biography: null }]);
    api.editor.edit({ publicViews: { ...source().publicViews, realms: false } });
    await api.editor.submit('views');
    expect(api.editor.snapshot().phase).toBe('saved');
    expect(api.writes[1]).toEqual({ publicViews: { realms: false } });
    await api.editor.reload();
    expect(api.editor.snapshot().known).toEqual(api.current());
    api.denyWrite();
    api.editor.edit({ biography: 'Retain the refused draft' });
    await api.editor.submit('profile');
    expect(api.editor.snapshot().phase).toBe('refused');
    expect(api.editor.snapshot().failure?.status).toBe(403);
    expect(api.editor.snapshot().draft?.biography).toBe('Retain the refused draft');
    expect(api.current().biography).toBeNull();
  }
});

test('The actual returned avatar/public-view fields are used and denied/unavailable data is never fabricated', async () => {
  for (const initial of [source(), source('organization'), { ...source(), avatar: null, biography: null, links: [] }]) {
    const api = boundary('Bearer native-authority', initial);
    await api.editor.reload();
    expect(api.editor.snapshot().known).toEqual(initial);
    expect(api.editor.snapshot().draft).toEqual(initial);
    expect(api.requests).toHaveLength(1);
  }
  const { accountId: id, biography: bio, ...fields } = source();
  for (const [status, body] of [
    [401, { code: 'authentication_required' }],
    [403, { code: 'forbidden' }],
    [403, { code: 'platform_closed' }],
    [503, { code: 'dependency_unavailable' }],
    [200, { accounts: [{ id: accountId, handle: 'public-selector' }], next: null }],
    [200, { profile: { id: mediaId, handle: null, bio, ...fields } }],
  ] as const) {
    const api = boundary('Bearer unchanged-credential');
    api.respond(status, body);
    await api.editor.reload();
    expect(api.editor.snapshot().phase).toBe('unavailable');
    expect(api.editor.snapshot().known).toBeNull();
    expect(api.editor.snapshot().draft).toBeNull();
    await api.editor.submit('profile');
    expect(api.writes).toHaveLength(0);
    expect(api.requests).toHaveLength(1);
    expect(new URL(api.requests[0]!.url).pathname).toBe(`/v1/accounts/${accountId}/profile`);
    api.respond(200, { profile: { id, handle: null, bio, ...fields } });
    await api.editor.reload();
    expect(api.editor.snapshot().known).toEqual(source());
  }
});
