import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { chromium, expect as visible } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';
import { people } from '../../../scripts/dev/seed/plan.ts';
import { actor } from '../features/relationships/fixtures.ts';
import type { FollowState, JoinPolicy } from '../features/relationships/types.ts';

// Run through goalctl after G-938 is served. Use an unjoined test Space to avoid disturbing seeded roles.
// REZICS_G944_REALM is its /r route segment; REZICS_G944_MEMBER_ID names a demo account (default daniel).
// The browser's web origin must serve this change and allow the Accounts redirect.
test('G-944: shared stack browser journey follows, changes level, pins, joins, leaves and bulk-unfollows at desktop and phone widths', async () => {
  const mainOrigin = process.env.MAIN_ORIGIN ?? 'http://127.0.0.1:3001';
  const probe = await fetch(`${mainOrigin}/v1/me/memberships?actingSubject=${encodeURIComponent(actor)}`);
  expect(probe.status, 'G-938 memberships must be served before this journey can run').not.toBe(404);
  const route = process.env.REZICS_G944_REALM;
  if (!route) throw new Error('Set REZICS_G944_REALM to an open, unjoined test Space after G-938 is merged; no seeded membership is removed by setup');
  const person = people.find(item => item.id === (process.env.REZICS_G944_MEMBER_ID ?? 'daniel'))!;
  const browser = await chromium.launch({ headless: true });
  const baseURL = process.env.REZICS_WEB_E2E_BASE_URL ?? 'http://127.0.0.1:3000';
  await mkdir('.temp/g-944/shared-browser', { recursive: true });
  try {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ baseURL, viewport: { width, height: 860 } });
      const page = await context.newPage();
      let cleanup: { realm: string; subject: string } | null = null;
      try {
        await signInAtAccounts(page, `/en/r/${route}`, person);
        await visible(page.getByRole('button', { name: 'Account menu' })).toHaveAttribute('data-hydrated', 'true');
        const headers = { 'x-session-key': (await context.cookies()).find(item => item.name === 'rezics_session_key')!.value };
        const session = await context.request.get('/api/main/v1/me/session-agent', { headers });
        const subject = (await session.json() as { sessionAgent: { actingSubject: string } }).sessionAgent.actingSubject;
        const control = page.locator('[data-relationship]').first();
        const realm = (await control.getAttribute('data-relationship'))!;
        const basisQuery = `actingSubject=${encodeURIComponent(subject)}`;
        const joining = await context.request.get(`/api/main/v1/realms/${realm.slice(-36)}/joining?${basisQuery}`);
        const policy = await joining.json() as JoinPolicy;
        expect(policy.selfJoin && policy.open && policy.state !== 'joined', 'Use an open test Space without an existing membership').toBe(true);
        const readState = async () => (await (await context.request.get(`/api/main/v1/me/follow-state?target=${encodeURIComponent(realm)}&kind=realm&${basisQuery}`)).json()) as FollowState;
        const before = await readState();
        expect(before.following, 'Use an unfollowed test Space so this journey leaves no preexisting relation changed').toBe(false);
        cleanup = { realm, subject };
        await control.getByRole('button', { name: /^Relationship options/ }).click();
        await page.getByRole('menuitem', { name: 'Follow independently of membership' }).click();
        await visible(control.getByRole('button', { name: 'Notifications: Highlights' })).toBeVisible();
        await control.getByRole('button', { name: 'Notifications: Highlights' }).click();
        await page.getByRole('menuitemradio', { name: 'All', exact: true }).click();
        await visible(control.getByRole('button', { name: 'Notifications: All' })).toBeVisible();
        await control.getByRole('button', { name: /^Relationship options/ }).click();
        await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();
        await visible.poll(async () => (await readState()).pinPosition).toBe(0);
        await control.getByRole('button', { name: /^Join ·/ }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Join', exact: true }).click();
        await visible(control.getByRole('button', { name: /^Joined ·/ })).toBeVisible();
        page.once('dialog', dialog => void dialog.accept());
        await control.getByRole('button', { name: /^Joined ·/ }).click();
        await visible(control.getByRole('button', { name: /^Join ·/ })).toBeVisible();
        expect((await readState()).source).toBe('explicit');
        if (width === 390) await page.getByRole('button', { name: 'Open navigation' }).click();
        const pinned = page.getByRole('region', { name: 'Pinned' });
        const described = await readState() as FollowState & { target: { href: string } };
        await visible(pinned.locator(`a[href='/en${described.target.href}']`)).toBeVisible();
        if (width === 390) await page.getByRole('dialog', { name: 'Menu' }).getByRole('button', { name: 'Close' }).click();
        await page.goto('/en/following');
        const inventory = page.getByRole('region', { name: 'Following' });
        const follow = inventory.locator('[data-follow]').filter({ has: page.locator(`[data-relationship="${realm}"]`) });
        await follow.getByRole('checkbox').check();
        await inventory.getByRole('button', { name: 'Unfollow selected' }).click();
        await visible(follow).toHaveCount(0);
        expect((await readState()).following).toBe(false);
        await page.screenshot({ path: `.temp/g-944/shared-browser/${width}.png`, fullPage: false });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      } finally {
        if (cleanup) {
          const { realm, subject } = cleanup;
          const query = `actingSubject=${encodeURIComponent(subject)}`;
          const headers = { origin: new URL(baseURL).origin, 'idempotency-key': crypto.randomUUID() };
          const policy = await (await context.request.get(`/api/main/v1/realms/${realm.slice(-36)}/joining?${query}`)).json() as JoinPolicy;
          if (policy.state === 'joined') {
            const response = await context.request.post(`/api/main/v1/realms/${realm.slice(-36)}/leave`, {
              headers, data: { actingSubject: subject, expectedMembershipGeneration: policy.membershipGeneration } });
            expect(response.ok(), 'The journey must remove only its own membership').toBe(true);
          }
          const state = await (await context.request.get(`/api/main/v1/me/follow-state?target=${encodeURIComponent(realm)}&kind=realm&${query}`)).json() as FollowState;
          if (state.following) {
            const response = await context.request.post('/api/main/v1/follows', { headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
              data: { profile: 'follow-command-v1', actingSubject: subject, target: realm, following: false, expectedRevision: state.revision } });
            expect(response.ok(), 'The journey must remove only its own follow').toBe(true);
          }
        }
        await context.close();
      }
    }
  } finally { await browser.close(); }
}, 240_000);
