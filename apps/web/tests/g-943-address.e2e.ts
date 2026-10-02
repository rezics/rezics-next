import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { uuidToSid } from '@rezics/model/address';
import { canonicalHref } from '../features/address/path.ts';
import type { ResolvedAddress } from '../features/address/client.ts';
import { signInAtAccounts } from './account-sign-in.ts';

async function resolve(request: APIRequestContext, scope: string, key: string) {
  const response = await request.get(
    `/api/main/v1/addresses/resolve?${new URLSearchParams({ scope, key })}`,
    { headers: { 'accept-language': 'en', 'x-rezics-display-languages': 'en' } },
  );
  expect(
    response.status(),
    'G-937 address-resolution-v1 must be served before the browser journey',
  ).toBe(200);
  return (await response.json()) as ResolvedAddress;
}

test('G-943 Realm, Zone, Work, named and unnamed people, and legacy URLs have one canonical 200 page', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  // Read the shared launch fixture through Main. The isolated QA harness also
  // installs these official Zones; no registry or graph is edited by this test.
  const zone = await resolve(page.request, 'space', 'fiction');
  const workPage = await page.request.get('/api/main/v1/works?limit=1');
  expect(workPage.status()).toBe(200);
  const work = ((await workPage.json()) as { items: { id: string }[] }).items[0];
  expect(work, 'the launch corpus needs one adopted public Work').toBeTruthy();
  const authPath = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!authPath)
    throw new Error('Run this journey through goalctl test with the QA authorization fixture');
  const { member } = JSON.parse(readFileSync(authPath, 'utf8')) as {
    member: { email: string; password: string };
  };
  await signInAtAccounts(page, '/en/settings', member);
  const person = async (name: string) => {
    const result = await page.request.post('/api/main/v1/agents', {
      headers: { 'idempotency-key': randomUUID() },
      data: { profile: 'agent-provision-v1', kind: 'person', displayName: name },
    });
    expect(result.status()).toBe(201);
    return ((await result.json()) as { agent: string }).agent;
  };
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const named = await person(`Named reader ${suffix}`);
  const unnamed = await person(`Unnamed reader ${suffix}`);
  const handle = `reader-${suffix}`;
  const claim = await page.request.post('/api/main/v1/addresses/claims', {
    headers: { 'idempotency-key': randomUUID() },
    data: {
      profile: 'name-write-v1',
      scope: 'agent',
      holder: named,
      actingSubject: named,
      operation: 'claim',
      name: handle,
      expectedRevision: null,
    },
  });
  expect(claim.status()).toBe(201);
  const people = await Promise.all([
    resolve(page.request, 'agent', named.slice(-36)),
    resolve(page.request, 'agent', unnamed.slice(-36)),
  ]);
  const workAddress = await resolve(page.request, 'work', work!.id.slice(-36));
  const walks = [
    { read: zone, surface: 'community' as const, name: 'realm' },
    { read: zone, surface: 'site' as const, name: 'zone' },
    { read: workAddress, name: 'work' },
    { read: people[0]!, name: 'named-person' },
    { read: people[1]!, name: 'unnamed-person' },
  ];
  await page.context().clearCookies();
  for (const walk of walks) {
    const canonical = canonicalHref(walk.read.canonical, 'en', walk.read.canonical.slugSource, {
      surface: 'surface' in walk ? walk.surface : undefined,
    });
    const response = await page.goto(canonical);
    expect(response?.status(), `${walk.name}: canonical HTTP response`).toBe(200);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      new URL(canonical, page.url()).toString(),
    );
    const direct = await page.request.get(canonical, { maxRedirects: 0 });
    expect(direct.status(), `${walk.name}: canonical target has no second redirect`).toBe(200);
    if ('surface' in walk) {
      const other = walk.surface === 'community' ? 'site' : 'community';
      await expect(
        page
          .getByRole('link', { name: other === 'site' ? 'Site' : 'Community', exact: true })
          .first(),
      ).toHaveAttribute(
        'href',
        canonicalHref(walk.read.canonical, 'en', walk.read.canonical.slugSource, {
          surface: other,
        }),
      );
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({ path: info.outputPath(`${walk.name}.png`), fullPage: true });
    const prefix =
      walk.read.canonical.prefix === '/@'
        ? '/a/'
        : 'surface' in walk
          ? walk.surface === 'community'
            ? '/r/'
            : '/z/'
          : walk.read.canonical.prefix;
    const old = await page.request.get(`/en${prefix}${walk.read.holder.slice(-36)}`, {
      maxRedirects: 0,
    });
    expect(old.status()).toBe(301);
    expect(new URL(old.headers().location!, page.url()).pathname).toBe(canonical);
    if ('surface' in walk) {
      const capability = walk.read.capabilities?.[walk.surface === 'community' ? 'realm' : 'zone'];
      expect(capability, `${walk.name}: launch Space exposes the surface capability`).toBeTruthy();
      const legacy = await page.request.get(`/en${prefix}${capability!.slice(-36)}`, {
        maxRedirects: 0,
      });
      expect(legacy.status()).toBe(301);
      expect(new URL(legacy.headers().location!, page.url()).pathname).toBe(canonical);
    }
    await page.goto(`/en${prefix}${uuidToSid(walk.read.holder.slice(-36))}-stale-title`);
    await expect(page).toHaveURL(new URL(canonical, page.url()).toString());
  }
  const oldSite = await page.request.get('/en/r/fiction/browse?view=grid', { maxRedirects: 0 });
  expect(oldSite.status()).toBe(301);
  expect(new URL(oldSite.headers().location!, page.url()).pathname).toBe('/en/z/fiction/browse');
  await page.goto('/en/r/fiction/browse?view=grid');
  await expect(page).toHaveURL(/\/en\/z\/fiction\/browse\?view=grid$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('legacy-site-phone.png'), fullPage: true });
});
