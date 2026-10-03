import { profileHref } from '../features/profile/route.ts';
import { localizedPath } from '../i18n/locale.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { signInAtAccounts } from './account-sign-in.ts';

test('G525: retired profile addresses answer one 301 and retain works and shelf paths', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const fixturePath = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!fixturePath || !process.env.ACCESS_DATABASE_URL)
    throw new Error('Run against the isolated QA e2e stack');
  const { member } = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    member: { email: string; password: string };
  };
  await signInAtAccounts(page, '/en/settings', member);
  const help = page.getByText(
    'You can change your handle once every 30 days. Your previous handles stay yours and keep leading to your profile.',
    { exact: true },
  );
  await expect(help).toBeVisible();
  await help.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('permanent-handle-settings.png') });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const displayName = `Durable Reader ${suffix}`;
  const created = await page.request.post('/api/main/v1/agents', {
    headers: { 'idempotency-key': randomUUID() },
    data: { profile: 'agent-provision-v1', kind: 'person', displayName },
  });
  expect(created.status()).toBe(201);
  const { agent } = (await created.json()) as { agent: string };
  const oldHandle = `past_${suffix}`;
  const newHandle = `present_${suffix}`;
  const change = async (handle: string, expectedHandle: string | null) => {
    const current = expectedHandle
      ? ((await (
          await page.request.get(
            `/api/main/v1/addresses/resolve?${new URLSearchParams({ scope: 'agent', key: expectedHandle })}`,
          )
        ).json()) as { revision: string })
      : null;
    return page.request.post(`/api/main/v1/addresses/${current ? 'renames' : 'claims'}`, {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        profile: 'alias-write-v1',
        scope: 'agent',
        holder: agent,
        actingSubject: agent,
        operation: current ? 'rename' : 'claim',
        alias: handle,
        expectedRevision: current?.revision ?? null,
      },
    });
  };
  expect((await change(oldHandle, null)).status()).toBe(201);
  const pool = new Pool({ connectionString: process.env.ACCESS_DATABASE_URL });
  try {
    // Only the isolated fixture's clock is advanced; both changes use the real API.
    await pool.query(
      `UPDATE access.alias_registry SET changed_at = now() - interval '31 days'
      WHERE scope = 'agent' AND key = $1 AND holder = $2`,
      [oldHandle, agent],
    );
  } finally {
    await pool.end();
  }
  expect((await change(newHandle, oldHandle)).status()).toBe(201);
  for (const path of [
    '',
    '/works',
    '/works?cursor=a+b',
    '/shelves/read',
    '/shelves/want-to-read?cursor=a+b',
  ]) {
    const response = await page.request.get(
      localizedPath(`${profileHref(oldHandle)}${path}`, 'en'),
      { maxRedirects: 0 },
    );
    expect(response.status()).toBe(301);
    const target = new URL(response.headers().location!, page.url());
    expect(target.pathname + target.search).toBe(
      localizedPath(`${profileHref(newHandle)}${path}`, 'en'),
    );
  }
  // Follow the redirect in Chromium too, with the real SSR profile read.
  await page.goto(localizedPath(profileHref(oldHandle), 'en'));
  await expect(page).toHaveURL(new RegExp(localizedPath(`${profileHref(newHandle)}$`, 'en')));
  await expect(page.getByRole('heading', { name: displayName, exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('renamed-profile.png'), fullPage: true });
  await page.goto(localizedPath(`${profileHref(oldHandle)}/works`, 'en'));
  await expect(page).toHaveURL(new RegExp(localizedPath(`${profileHref(newHandle)}/works$`, 'en')));
});
