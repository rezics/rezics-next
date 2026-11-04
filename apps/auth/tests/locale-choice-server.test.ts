import { expect, test } from 'bun:test';

test('actual server negotiation and concurrent shell renders keep request-local locale and exact query', async () => {
  // A separate server realm prevents browser fixtures' runtime overrides from masking SSR isolation.
  const child = Bun.spawn(
    [
      'bun',
      '--eval',
      `
    import { strict as assert } from 'node:assert';
    import { createElement } from 'react';
    import { renderToString } from 'react-dom/server';
    import { AuthShell } from './src/frame';
    import { installAuthLocaleNegotiation } from './src/locale-choice';
    import { paraglideMiddleware } from './src/paraglide/server.js';
    import { getLocale, locales } from './src/paraglide/runtime.js';
    installAuthLocaleNegotiation();
    const query = '?scope=one&scope=&state=a%2fb+z&unknown=x&unknown=y';
    const render = async (cookie, language, wanted) => {
      const request = new Request('https://auth.test/login' + query, {
        headers: { cookie, 'accept-language': language }
      });
      const response = await paraglideMiddleware(request, async ({locale, request: observed}) => {
        await Promise.resolve();
        assert.equal(getLocale(), wanted);
        assert.equal(locale, wanted);
        assert.equal(new URL(observed.url).search, query);
        return new Response(renderToString(createElement('html', { lang: getLocale() }, createElement(AuthShell))));
      });
      const html = await response.text();
      assert.ok(html.includes('lang="' + wanted + '"'));
      assert.ok(html.includes('value="' + wanted + '" lang="' + wanted + '" selected=""'));
      assert.equal(response.headers.get('set-cookie'), null);
    };
    await Promise.all(locales.map(locale => render('rezics_locale=' + locale, 'fr;q=1, en;q=0.5', locale)));
    await Promise.all([
      render('rezics_locale=../../bad', 'ja;q=0.2, de-DE;q=0.9', 'de'),
      render('', 'zh-TW, en;q=0.8', 'zh-Hant'),
      render('', 'zh-CN', 'zh-Hans'),
      render('rezics_locale=unknown', 'unknown, fr;q=0', 'en'),
      render('', '', 'en'),
    ]);
  `,
    ],
    { cwd: `${import.meta.dir}/..`, stdout: 'pipe', stderr: 'pipe' },
  );
  const error = await new Response(child.stderr).text();
  expect(await child.exited, error).toBe(0);
});
