import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import { admitMineCollectionsAddress as admit } from '../src/library/mine-collections-address';

let privateReads = 0;
const env = {
  KERNEL_ORIGIN: 'https://kernel.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => ({ status: 'active', subject: 'owner', accessToken: 'original-credential' }),
    }),
  },
};
const request = () =>
  new Request('https://site.test/fr/library/collections', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({ getRequest: request, setResponseHeader() {} }));
mock.module('cloudflare:workers', () => ({ env }));
afterAll(() => mock.restore());

test('router and both server reads admit the same address and malformed input never reads lists or pins', async () => {
  const { Route } = await import('../src/routes/library/collections');
  const { readMineCollectionsViewerPage, readMineCollectionsPage } =
    await import('../src/library/mine-collections-route');
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async () => {
    privateReads++;
    throw new Error('Unexpected private read');
  });
  try {
    const validate = Route.options.validateSearch as typeof admit;
    const cursor = 'opaque+/page==&return_to=https://example.test';
    expect(validate({ cursor, layout: 'previews' })).toEqual({ cursor, layout: 'previews' });
    expect(admit({ cursor: 'x'.repeat(4096) }).cursor).toHaveLength(4096);
    expect(admit({ cursor: '' })).toEqual({ layout: 'rows' });
    for (const input of [
      { cursor: 7, layout: 'previews' },
      { cursor: null },
      { cursor: ['page'] },
      { cursor: 'x'.repeat(4097), layout: 'rows' },
      { cursor, layout: 'tiles' },
      { cursor, layout: null },
      { cursor: { private: 'do not stringify' }, layout: false },
    ]) {
      const normalized = validate(input);
      expect(normalized.addressError).toBeDefined();
      expect(admit(normalized)).toEqual(normalized);
      for (const data of [input, normalized]) {
        const result = await readMineCollectionsViewerPage({ data });
        expect(result).toMatchObject({
          sessionSubject: 'owner',
          requested: { ...normalized, cursor: normalized.cursor ?? null },
          page: {
            signedIn: true,
            state: 'unavailable',
            invalidAddress: normalized.addressError,
            collections: [],
            next: null,
          },
          pins: { state: 'closed' },
        });
        expect(result.page.cursorReset).toBeUndefined();
        expect(await readMineCollectionsPage({ data })).toMatchObject({
          invalidAddress: normalized.addressError,
          collections: [],
        });
      }
    }
    expect(privateReads).toBe(0);
  } finally {
    transport.mockRestore();
  }
});

test('saved-address recovery escapes bounded context and offers localized explicit GET correction at the right boundary', async () => {
  const { MineCollectionsAddressRecovery: Recovery } = await import('../src/library/mine-collections-address-recovery');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('fr', { reload: false });
  try {
    const cursor = 'opaque+/page==&return_to=https://example.test';
    for (const layout of ['rows', 'previews'] as const) {
      const html = renderToStaticMarkup(
        <Recovery address={admit({ cursor: '<script>alert(1)</script>' + 'x'.repeat(4096), layout })} />,
      );
      expect(html).toContain('data-collections-state="invalid-address"');
      expect(html).toContain('role="alert"');
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('x'.repeat(161));
      expect(html).toContain('action="/fr/library/collections" method="get"');
      expect(html).toContain(`name="layout" value="${layout}"`);
      expect(html).toContain('name="cursor"');
      expect(html).toContain(`href="/fr/library/collections?layout=${layout}"`);
    }
    const html = renderToStaticMarkup(<Recovery address={admit({ cursor, layout: 'bad-layout' })} />);
    expect(html).toContain('<select name="layout"');
    expect(html).toContain('bad-layout');
    expect(html).not.toContain('name="cursor"');
    expect(html).not.toContain(cursor);
    expect(html).toContain('href="/fr/library/collections?layout=rows"');
    expect(admit({ cursor, layout: 'previews' }).cursor).toBe(cursor);
  } finally {
    setLocale('en', { reload: false });
  }
});
