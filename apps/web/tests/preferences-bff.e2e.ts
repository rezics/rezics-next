import { expect, test } from '@playwright/test';
import { forwardDisplayPreferences } from '../features/api/preferences.ts';

test('G311: a browser reads, writes and re-reads preferences through the same-origin BFF', async ({ page }) => {
  let value = { revision: 0, displayMode: 'system', showZoneThemes: true };
  const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer web-session-token');
    if (init?.method === 'PUT') {
      const body = JSON.parse(await new Response(init.body).text()) as typeof value & { expectedRevision: number };
      if (body.expectedRevision !== value.revision) return Response.json({ error: 'conflict' }, { status: 409 });
      value = { revision: value.revision + 1, displayMode: body.displayMode,
        showZoneThemes: body.showZoneThemes };
    }
    return Response.json(value);
  }) as typeof fetch;
  await page.route('https://web.test/**', async route => {
    if (new URL(route.request().url()).pathname === '/') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>Preferences</body></html>' });
      return;
    }
    const incoming = route.request();
    const request = new Request(incoming.url(), { method: incoming.method(),
      headers: incoming.headers(), body: incoming.postData() ?? undefined });
    const result = await forwardDisplayPreferences(request, { accountOrigin: 'https://account.test',
      accessToken: 'web-session-token', fetch: upstream });
    await route.fulfill({ status: result.status, headers: Object.fromEntries(result.headers),
      body: await result.text() });
  });
  await page.goto('https://web.test/');
  const seen = await page.evaluate(async () => {
    const read = () => fetch('/api/preferences').then(response => response.json());
    const before = await read();
    const written = await fetch('/api/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: before.revision, displayMode: 'dark', showZoneThemes: false }) });
    return { before, written: await written.json(), after: await read() };
  });
  expect(seen).toEqual({ before: { revision: 0, displayMode: 'system', showZoneThemes: true },
    written: { revision: 1, displayMode: 'dark', showZoneThemes: false },
    after: { revision: 1, displayMode: 'dark', showZoneThemes: false } });
});
