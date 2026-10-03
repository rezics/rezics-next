import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { uiLocales } from '../i18n/define.ts';
import { realmHref } from '../features/realm/route.ts';
import { signInPath } from '../features/auth/paths.ts';
import {
  accessActor,
  accessFixtureApi,
  joinPageFixture,
} from '../features/manage/settings-fixtures.ts';
import { accessMessages } from '../features/manage/settings-messages.ts';
import { PrivateSpaceJoinPage } from '../features/space-access/join-page.tsx';

for (const locale of uiLocales) {
  test(`G-988 ${locale}: the signed-out join page offers sign-in before hydration and returns to the request`, () => {
    const next = realmHref(locale, 'private-books', 'home', { direction9: 'preserved' });
    const href = signInPath(next);
    const html = renderToStaticMarkup(
      <PrivateSpaceJoinPage
        page={joinPageFixture}
        actingSubject={null}
        signInHref={href}
        locale={locale}
        discoveryMetadata={false}
      />,
    );
    const link = html
      .match(/<a\b[^>]*>[^<]*<\/a>/g)
      ?.find((link) => link.endsWith(`>${accessMessages[locale].signIn}</a>`));
    expect(link).toBeDefined();
    expect(link).toContain(`href="${href}"`);
    expect(new URL(href, 'https://web.test').searchParams.get('next')).toBe(next);
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain(accessMessages[locale].statusLoading);
  });
}

test('G-988: signed-in requesters wait for owner status before a request form is offered', () => {
  let reads = 0;
  const html = renderToStaticMarkup(
    <PrivateSpaceJoinPage
      page={joinPageFixture}
      actingSubject={accessActor}
      signInHref="/auth/start"
      locale="en"
      discoveryMetadata={false}
      api={accessFixtureApi({
        mine: async () => {
          reads++;
          return { ok: false, failure: 'unavailable' };
        },
      })}
    />,
  );
  expect(html).toContain(accessMessages.en.statusLoading);
  expect(html).not.toContain('<textarea');
  expect(html).not.toContain(accessMessages.en.signIn);
  expect(reads).toBe(0);
});
