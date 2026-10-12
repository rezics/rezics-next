import { expect, test } from 'bun:test';
import { direction } from '@rezics/main/language';
import { spaceHref } from '../address/path.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import { gateFor, type PlatformAccess } from '../api/platform-access.ts';
import { ShellProvider } from '../shell/shell-provider.tsx';
import { messages as shellMessages } from '../shell/messages.ts';
import type { MainClient } from '../discover/types.ts';
import { mainAboutDiscussionApi, type AboutDiscussionRead, type AboutPostIntent } from './about-discussion-api.ts';
import { AboutDiscussion } from './about-discussion.tsx';
import { aboutDiscussionMessages } from './about-discussion-messages.ts';

const reference = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const intent: AboutPostIntent = {
  key: 'about-discussion-access', actingSubject: reference(4),
  basis: { zone: reference(1), realm: reference(2), about: reference(3),
    targetRevision: reference(5), path: '/chapter', routeRevision: reference(6) },
  body: 'A question about this chapter.', language: 'en', spoiler: false,
};
const reply = reference(7);
const granted: PlatformAccess = { groups: ['realm-reply'], operations: [], generation: 'granted' };
const accessCases: Array<[string, PlatformAccess, boolean]> = [
  ['anonymous', { groups: [], operations: [], generation: '' }, false],
  ['signed in without a grant', { groups: [], operations: [], generation: 'signed-in' }, false],
  ['group granted', granted, true],
  ['operation granted', { groups: [], operations: ['postV1RealmsByRealmAbout-posts'], generation: 'operation' }, true],
  ['another operation granted', { groups: [], operations: ['getV1RealmsByRealmAbout-thread'], generation: 'read' }, false],
  ['revoked', { groups: [], operations: [], generation: 'revoked' }, false],
];

function transport() {
  const calls: Array<{ realm: string; body: unknown; key: string }> = [];
  const main = { v1: { realms: ({ realm }: { realm: string }) => ({ 'about-posts': {
    post: async (body: unknown, options: { headers: { 'idempotency-key': string } }) => {
      calls.push({ realm, body, key: options.headers['idempotency-key'] });
      return { data: { reply }, error: null, response: new Response(null, { status: 201 }) };
    },
  } }) } } as unknown as MainClient;
  return { main, calls };
}

test.each(accessCases)('the about-discussion adapter respects %s access before posting', async (_state, access, allowed) => {
  const { main, calls } = transport();
  const retained = structuredClone(intent);
  expect(await mainAboutDiscussionApi(() => main, gateFor(access)).post(retained))
    .toEqual(allowed ? { kind: 'posted', reply } : { kind: 'closed' });
  expect(retained).toEqual(intent);
  expect(calls).toHaveLength(allowed ? 1 : 0);
  if (allowed) expect(calls[0]).toEqual({ realm: intent.basis.realm.slice(-36), key: intent.key,
    body: { profile: 'realm-about-post-v1', about: intent.basis.about,
      targetRevision: intent.basis.targetRevision, zone: intent.basis.zone,
      path: intent.basis.path, routeRevision: intent.basis.routeRevision,
      actingSubject: intent.actingSubject, body: intent.body, language: 'en',
      direction: direction(intent.language, intent.body), spoiler: false } });
});

test('revocation and reopening use the current gate while preserving the retained intent', async () => {
  const { main, calls } = transport();
  let access = granted;
  const api = mainAboutDiscussionApi(() => main, operation => gateFor(access)(operation));
  const retained = structuredClone(intent);
  access = { groups: [], operations: [], generation: 'revoked' };
  expect(await api.post(retained)).toEqual({ kind: 'closed' });
  expect(calls).toHaveLength(0);
  expect(retained).toEqual(intent);
  access = granted;
  expect(await api.post(retained)).toEqual({ kind: 'posted', reply });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.key).toBe(intent.key);
  expect(retained).toEqual(intent);
});

test('isolated callers without a viewer retain the adapter compatibility default', async () => {
  const { main, calls } = transport();
  expect(await mainAboutDiscussionApi(() => main).post(intent)).toEqual({ kind: 'posted', reply });
  expect(calls).toHaveLength(1);
});

const ready: Extract<AboutDiscussionRead, { kind: 'ready' }> = {
  kind: 'ready', basis: intent.basis, thread: null, mode: 'open', actingSubject: intent.actingSubject,
};
const router: AppRouterInstance = {
  back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: 'about-access',
};
const t = aboutDiscussionMessages.en;

function draw(access: PlatformAccess, signedIn = true, read: AboutDiscussionRead = ready) {
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router },
    createElement(ShellProvider, {
      locale: 'en', messages: shellMessages, initialTheme: 'light', initialCollapsed: false,
      signedIn, platformAccess: access,
      children: createElement(AboutDiscussion, { read, locale: 'en', href: spaceHref('reading', 'site', ['chapter']), retain: false }),
    })));
}

test.each(accessCases)('the rendered about-discussion entry respects %s access with an open server read',
  (_state, access, allowed) => {
    const html = draw(access, _state !== 'anonymous');
    expect(html.includes(`>${t.start}</button>`)).toBe(allowed);
    expect(html.includes(t.postingUnavailable)).toBe(!allowed);
    expect(html).toContain(t.empty);
    expect(html).toContain(t.title);
    expect(html).not.toContain(`>${t.retry}</button>`);
  });

test.each(['closed', 'sign-in', 'identity', 'join', 'reviewed', 'unavailable'] as const)(
  'a platform grant cannot override the server %s posting mode', mode => {
    const html = draw(granted, true, { ...ready, mode });
    expect(html).not.toContain(`>${t.start}</button>`);
    expect(html).not.toContain(`>${t.send}</button>`);
    expect(html).toContain(t.empty);
  });
