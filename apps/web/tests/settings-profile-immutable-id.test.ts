import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  loadProfileRecord,
  saveProfileRecord,
  type ProfilePatch,
  type ProfileValues,
} from '../src/settings/profile-data';
import { performanceAmbientTree } from './performance-ambient';
import { ProfileEditor, ProfileEditorSession, type ProfileAttempt } from '../src/settings/profile-write';
import { EditableProfileReadError, officialProfileRead } from '../src/settings/editable-profile-source';
import { createBrowserSettingsAmbient } from '../src/settings/adapters/ambient';

const settingsAmbient = createBrowserSettingsAmbient();

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
        return Response.json(readBody ?? officialProfileRead({ id, handle: null, bio, ...fields }), {
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
      ambient: settingsAmbient,
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
    api.respond(200, officialProfileRead({ id, handle: null, bio, ...fields }));
    await api.editor.reload();
    expect(api.editor.snapshot().known).toEqual(source());
  }
});

test('A new or unready actor never receives a prior private profile and an explicit native read denial hides cached server values without converting a transport-uncertain save into an unapplied result', async () => {
  const signedIn = { state: 'signed-in', subject: accountId, csrfToken: 'original-session' };
  const original = new ProfileEditorSession(signedIn, () => ({
    read: async () => source(),
    save: async (attempt) => ({ ok: true, profile: attempt.after }),
  }));
  await original.editor.reload();
  original.editor.edit({ biography: 'Unsent private draft', avatar: { media: 'local-avatar' } });
  expect(original.matches({ ...signedIn })).toBe(true);
  for (const session of [
    { ...signedIn, subject: mediaId }, // Even a reused token never identifies another actor.
    { ...signedIn, csrfToken: 'new-session' },
    { ...signedIn, state: 'signed-out' },
    { ...signedIn, state: 'unknown' },
    { ...signedIn, state: 'unavailable' },
    { ...signedIn, subject: null },
    { ...signedIn, csrfToken: null },
  ]) {
    expect(original.matches(session)).toBe(false);
    let reads = 0;
    let writes = 0;
    const next = new ProfileEditorSession(session, () => ({
      read: async () => {
        reads++;
        return source();
      },
      save: async (attempt) => {
        writes++;
        return { ok: true, profile: attempt.after };
      },
    }));
    expect(next.key).not.toEqual(original.key);
    expect(next.editor.snapshot().known).toBeNull();
    expect(next.editor.snapshot().draft).toBeNull();
    expect(next.editor.snapshot().attempt).toBeNull();
    if (session.state === 'signed-in' && session.subject === accountId && session.csrfToken === null) {
      expect(next.reader?.subject).toBe(accountId);
      expect(next.actor).toBeNull();
      expect(next.canRead()).toBe(true);
      expect(next.canWrite()).toBe(false);
      await next.editor.reload();
      expect(reads).toBe(1);
      expect(next.editor.snapshot().known).toEqual(source());
      next.editor.edit({ biography: 'Read-only mutation attempt' });
      await next.editor.submit('profile');
      await next.editor.retry();
      expect(next.editor.snapshot().draft).toEqual(source());
      expect(writes).toBe(0);
    } else {
      expect(reads).toBe(0);
    }
    if (!next.reader) {
      await next.editor.reload();
      await next.editor.submit('profile');
      expect(reads).toBe(0);
      expect(writes).toBe(0);
    }
    next.retire();
  }
  original.retire();
  const returned = new ProfileEditorSession(signedIn, () => ({
    read: async () => source(),
    save: async (attempt) => ({ ok: true, profile: attempt.after }),
  }));
  expect(original.matches(signedIn)).toBe(false);
  expect(returned.key).not.toEqual(original.key);
  expect(returned.editor.snapshot().draft).toBeNull();
  returned.retire();

  // Exercise the real cards' outer guards without introducing a browser or native harness.
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { ProfileCard } = await import('../src/settings/profile');
  const { PublicViewsCard } = await import('../src/settings/public-views');
  for (const unresolved of [false, true]) {
    let denied = true;
    const sent: ProfileAttempt[] = [];
    const editor = new ProfileEditor(
      {
        ambient: settingsAmbient,
        read: async () => {
          if (denied) throw new EditableProfileReadError(403);
          return source();
        },
        save: async (attempt) => {
          sent.push(attempt);
          if (sent.length === 1) throw new Error('Response lost');
          return { ok: false, status: 403, message: 'Forbidden' };
        },
      },
      source(),
    );
    editor.edit({ biography: 'Retained unsent words', publicViews: { ...source().publicViews, posts: true } });
    if (unresolved) await editor.submit('profile');
    const before = editor.snapshot();
    await editor.reload();
    expect(editor.snapshot().readAuthority).toBe('denied');
    expect(editor.snapshot().known).toBe(before.known);
    expect(editor.snapshot().draft).toBe(before.draft);
    expect(editor.snapshot().attempt).toBe(before.attempt);
    const html = renderToStaticMarkup(
      performanceAmbientTree(
        createElement('div', null, createElement(ProfileCard, { editor }), createElement(PublicViewsCard, { editor })),
      ),
    );
    for (const privateValue of ['Private editable source', 'Retained unsent words', 'example.test/notes', mediaId])
      expect(html).not.toContain(privateValue);
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('role="switch"');
    editor.receive(source()); // A previously successful cached projection is not a new native authorized read.
    editor.review();
    expect(editor.snapshot().readAuthority).toBe('denied');
    await editor.submit('profile');
    expect(sent).toHaveLength(unresolved ? 1 : 0);
    if (unresolved) {
      await editor.retry();
      expect(sent[1]).toBe(before.attempt);
      expect(editor.snapshot().attempt).toBe(before.attempt);
      expect(editor.snapshot().phase).toBe('uncertain');
      expect(Object.isFrozen(editor.snapshot().attempt)).toBe(true);
    }
    denied = false;
    await editor.reload();
    expect(editor.snapshot().readAuthority).toBe('allowed');
    expect(editor.snapshot().draft?.biography).toBe('Retained unsent words');
    expect(editor.snapshot().draft?.publicViews.posts).toBe(true);
    expect(editor.snapshot().attempt).toBe(before.attempt);
    expect(editor.snapshot().phase).toBe(unresolved ? 'uncertain' : 'review');
    const hidden = renderToStaticMarkup(
      performanceAmbientTree(createElement(ProfileCard, { editor, writable: false })),
    );
    expect(hidden).not.toContain('Retained unsent words');
    expect(hidden).not.toContain('<input');
    const explicitlyReadable = renderToStaticMarkup(
      performanceAmbientTree(
        createElement(
          'div',
          null,
          createElement(ProfileCard, { editor, writable: false, readable: true }),
          createElement(PublicViewsCard, { editor, writable: false, readable: true }),
        ),
      ),
    );
    expect(explicitlyReadable).toContain('Retained unsent words');
    expect(explicitlyReadable).toContain('role="switch"');
    expect(explicitlyReadable).toContain('disabled=""');
    editor.retire();
  }
});

test('retired actors ignore late read and save completions and release only their own callbacks', async () => {
  for (const operation of ['read', 'save'] as const) {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const confirmed: ProfileValues[] = [];
    let reads = 0;
    const owner = new ProfileEditorSession({ state: 'signed-in', subject: accountId, csrfToken: 'old' }, () => ({
      read: async () => {
        reads++;
        await pending;
        return source();
      },
      save: async (attempt) => {
        await pending;
        return { ok: true, profile: attempt.after };
      },
      confirmed: (current) => confirmed.push(current),
    }));
    owner.editor.receive(source());
    owner.editor.edit({ biography: 'Old local draft' });
    let notifications = 0;
    owner.editor.subscribe(() => {
      notifications++;
    });
    const completing = operation === 'read' ? owner.editor.reload() : owner.editor.submit('profile');
    owner.retire();
    const retired = owner.editor.snapshot();
    const count = notifications;
    finish();
    await completing;
    owner.editor.receive(source());
    await owner.editor.retry();
    expect(owner.editor.snapshot()).toBe(retired);
    expect(retired.known).toBeNull();
    expect(retired.draft).toBeNull();
    expect(retired.attempt).toBeNull();
    expect(confirmed).toHaveLength(0);
    expect(reads).toBe(operation === 'read' ? 1 : 0);
    expect(notifications).toBe(count);
  }
  for (const operation of ['read', 'save'] as const) {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let published = 0;
    let reads = 0;
    const editor = new ProfileEditor(
      {
        ambient: settingsAmbient,
        read: async () => {
          reads++;
          await pending;
          return source();
        },
        save: async (attempt) => {
          await pending;
          return { ok: true, profile: attempt.after };
        },
        confirmed: () => {
          published++;
        },
      },
      source(),
    );
    editor.edit({ biography: 'Retained local words' });
    const completing = operation === 'read' ? editor.reload() : editor.submit('profile');
    const original = editor.snapshot().attempt;
    editor.unavailable(new EditableProfileReadError(403));
    finish();
    await completing;
    expect(editor.snapshot().readAuthority).toBe('denied');
    expect(editor.snapshot().draft?.biography).toBe('Retained local words');
    expect(editor.snapshot().attempt).toBe(original);
    expect(published).toBe(0);
    expect(reads).toBe(operation === 'read' ? 1 : 0);
    editor.retire();
  }
});
