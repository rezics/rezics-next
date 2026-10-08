import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { acting, header, iri, now, realm } from './fixtures.ts';
import { messages } from './messages.ts';
import { realmEditSite } from './realm-site.ts';

// The frame's tabs read the path. Stories and this render have no router.
void mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh() {} }),
  usePathname: () => '/manage/r/fiction',
  useSearchParams: () => new URLSearchParams(),
}));

const { RealmFrame } = await import('./realm-frame.tsx');
const { ManageHome } = await import('./manage-home.tsx');

const zoneId = '00000000-0000-4000-8000-0000000000aa';
const zoneIri = `https://rezics.com/id/${zoneId}`;

function frame(siteHref: string | null) {
  return renderToStaticMarkup(<RealmFrame realm={realm} address="fiction" header={header} agent={acting} locale="en"
    messages={messages} settingsAllowed siteHref={siteHref}>Queue</RealmFrame>);
}

test('a Realm without a Zone shows no link', async () => {
  let editorReads = 0;
  const href = await realmEditSite({
    zone: async () => ({ ok: false, failure: 'missing' }),
    editor: async () => { editorReads += 1; return { ok: true, data: {} }; },
  });
  expect(href).toBeNull();
  expect(editorReads).toBe(0);
  const html = frame(href);
  expect(html).toContain('Join requests');
  expect(html).not.toContain('Edit site');
});

test('a manager without edit rights shows no link', async () => {
  let editorReads = 0;
  const href = await realmEditSite({
    zone: async () => ({ ok: true, data: { zone: zoneIri, routeSegment: 'fiction' } }),
    editor: async id => { editorReads += 1; expect(id).toBe(zoneId); return { ok: false, failure: 'denied' }; },
  });
  expect(href).toBeNull();
  expect(editorReads).toBe(1);
  expect(frame(href)).not.toContain('Edit site');
});

test('an editor of a Realm with a Zone shows it', async () => {
  const href = await realmEditSite({
    zone: async () => ({ ok: true, data: { zone: zoneIri, routeSegment: 'fiction' } }),
    editor: async id => { expect(id).toBe(zoneId); return { ok: true, data: {} }; },
  });
  expect(href).toBe('/manage/z/fiction');
  const html = frame(href);
  expect(html).toContain('Edit site');
  expect(html).toContain('/en/manage/z/fiction');

  const byId = await realmEditSite({
    zone: async () => ({ ok: true, data: { zone: zoneIri, routeSegment: null } }),
    editor: async () => ({ ok: true, data: {} }),
  });
  expect(byId).toBe(`/manage/z/${zoneId}`);
});

test('a managed Realm card shows no Edit site', () => {
  const html = renderToStaticMarkup(createElement(ManageHome, {
    agent: acting,
    realms: { ok: true, data: { items: [{
      realm: { realm: iri(31), permissions: ['realm.owner'], openCount: { value: 1, kind: 'exact' },
        escalatedCount: { value: 0, kind: 'exact' }, latestActivity: null },
      header, address: 'fiction',
    }], nextCursor: null } },
    moreHref: null, now, locale: 'en', messages,
  }));
  expect(html).toContain('Open queue');
  expect(html).not.toContain('Edit site');
});
