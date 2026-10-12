import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as platformAccess from '../api/platform-access.ts';

const actingSubject = 'https://rezics.com/id/00000000-0000-4000-8000-000000000004';

void mock.module('../auth/session.ts', () => ({ readSession: async () => null }));
void mock.module('../work-page/read.ts', () => ({
  reader: async () => ({ main: {}, signedIn: true, actingSubject }),
}));
void mock.module('../api/main.ts', () => ({ readPlatformAccess: async () => ({}) }));
void mock.module('../api/platform-access.ts', () => ({ ...platformAccess, operationOpen: () => true }));
void mock.module('./about-discussion-api.ts', () => ({
  readAboutDiscussion: async () => { throw new Error('DisclosureUnavailable'); },
}));
void mock.module('./about-discussion.tsx', () => ({
  AboutDiscussion: ({ read, recoveryScope }: {
    read: { kind: string }; recoveryScope?: { actingSubject: string | null };
  }) => <aside data-zone-discussion-entry data-discussion-state={read.kind}
    data-acting-subject={recoveryScope?.actingSubject} />,
}));

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
