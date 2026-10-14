import { replaceModule } from '../../tests/support/module-replacement.ts';
import { afterAll, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AboutDiscussionRouteReader, AboutDiscussionTargetReader } from './about-discussion-api.ts';

const actingSubject = 'https://rezics.com/id/00000000-0000-4000-8000-000000000004';
const about = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
const revision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000006';
let lookupFailure = true;
let postingOpen = true;
const projections: Array<[string, string | undefined]> = [];
const routes: Array<[string, string, string | undefined]> = [];
let target: Awaited<ReturnType<AboutDiscussionTargetReader>>;

const mainApi = { ...(await import('../api/main.ts')) };
const platformAccess = { ...(await import('../api/platform-access.ts')) };
const authSession = { ...(await import('../auth/session.ts')) };
const workReads = { ...(await import('../work-page/read.ts')) };
const entityReads = { ...(await import('../entity-page/read.ts')) };
const realmReads = { ...(await import('../realm/read.ts')) };
const discussionApi = { ...(await import('./about-discussion-api.ts')) };
const discussionView = { ...(await import('./about-discussion.tsx')) };

const restoreAuthSession = replaceModule(import.meta.resolve('../auth/session.ts'), authSession, { readSession: async () => null });
const restoreWorkReads = replaceModule(import.meta.resolve('../work-page/read.ts'), workReads, {
  reader: async () => ({ main: {}, signedIn: true, actingSubject }),
});
const restoreMainApi = replaceModule(import.meta.resolve('../api/main.ts'), mainApi, { readPlatformAccess: async () => ({}) });
const restorePlatformAccess = replaceModule(import.meta.resolve('../api/platform-access.ts'), platformAccess, { gateFor: () => () => postingOpen });
const restoreEntityReads = replaceModule(import.meta.resolve('../entity-page/read.ts'), entityReads, {
  readEntityProjection: async (resource: string, position?: string) => {
    projections.push([resource, position]);
    return { ok: true, data: { target: { resource: about, revision } } };
  },
});
const restoreRealmReads = replaceModule(import.meta.resolve('../realm/read.ts'), realmReads, {
  readZoneRoute: async (zone: string, path: string, cursor?: string) => {
    routes.push([zone, path, cursor]);
    return { ok: true, data: { kind: 'detail', path, resource: { id: about } } };
  },
});
const restoreDiscussionApi = replaceModule(import.meta.resolve('./about-discussion-api.ts'), discussionApi, {
  readAboutDiscussion: async (_main: unknown, _input: unknown, readTarget?: AboutDiscussionTargetReader,
    readRoute?: AboutDiscussionRouteReader) => {
    if (lookupFailure) throw new Error('DisclosureUnavailable');
    if (!readTarget) throw new Error('Current projection reader is missing');
    target = await readTarget(about);
    if (!readRoute) throw new Error('Current frame route reader is missing');
    expect(await readRoute()).toMatchObject({ error: null, data: { path: '/guide/harbor-field-guide' } });
    return { kind: 'ready' };
  },
});
const restoreDiscussionView = replaceModule(import.meta.resolve('./about-discussion.tsx'), discussionView, {
  AboutDiscussion: ({ read, recoveryScope }: {
    read: { kind: string }; recoveryScope?: { actingSubject: string | null; postingOpen: boolean };
  }) => <aside data-zone-discussion-entry data-discussion-state={read.kind}
    data-acting-subject={recoveryScope?.actingSubject} data-posting-open={recoveryScope?.postingOpen} />,
});
afterAll(async () => {
  restoreDiscussionView();
  restoreDiscussionApi();
  restoreRealmReads();
  restoreEntityReads();
  restorePlatformAccess();
  restoreMainApi();
  restoreWorkReads();
  restoreAuthSession();
});

const { ZoneAboutDiscussion } = await import('./about-discussion-entry.tsx');

test('a failed discussion lookup leaves its parent Zone page renderable', async () => {
  const discussion = await ZoneAboutDiscussion({
    zone: '00000000-0000-4000-8000-000000000001', path: '/guide/harbor-field-guide',
    href: '/guide/harbor-field-guide', locale: 'en',
  });
  const page = renderToStaticMarkup(createElement('main', null,
    createElement('h1', null, 'Harbor field guide'), discussion));

  expect(page).toContain('<h1>Harbor field guide</h1>');
  expect(page).toContain('data-discussion-state="unavailable"');
  expect(page).toContain(`data-acting-subject="${actingSubject}"`);
});

test('the discussion shares the entity frame reader with an explicit current position', async () => {
  lookupFailure = false;
  try {
    const discussion = await ZoneAboutDiscussion({
      zone: '00000000-0000-4000-8000-000000000001', path: '/guide/harbor-field-guide',
      href: '/guide/harbor-field-guide', locale: 'en',
    });
    expect(renderToStaticMarkup(discussion!)).toContain('data-discussion-state="ready"');
    expect(projections).toEqual([[about.slice(-36), undefined]]);
    expect(target).toEqual({ resource: about, revision });
    expect(routes).toEqual([['00000000-0000-4000-8000-000000000001', '/guide/harbor-field-guide', undefined]]);
  } finally { lookupFailure = true; }
});

test('a failed discussion lookup keeps the closed posting gate in its recovery scope', async () => {
  postingOpen = false;
  try {
    const discussion = await ZoneAboutDiscussion({
      zone: '00000000-0000-4000-8000-000000000001', path: '/guide/harbor-field-guide',
      href: '/guide/harbor-field-guide', locale: 'en',
    });
    const page = renderToStaticMarkup(discussion!);
    expect(page).toContain('data-discussion-state="unavailable"');
    expect(page).toContain('data-posting-open="false"');
  } finally { postingOpen = true; }
});
