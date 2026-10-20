import { expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Pool } from 'pg';
import { chromium, expect as visible } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';
import { people } from '../../../scripts/dev/seed/plan.ts';
import { mainRelationships } from '../features/relationships/api.ts';
import { actor } from '../features/relationships/fixtures.ts';
import { localizedPath } from '../i18n/locale.ts';
import { spaceHref } from '../features/address/path.ts';
import { readEnv } from '../../../scripts/dev/config.ts';
import { grantPlatformResource, grantPlatformUse, platformAdministratorSession, revokePlatformUse }
  from '../../../tests/qa/fixtures/platform-grant.ts';
import type { FollowState, JoinPolicy } from '../features/relationships/types.ts';

// Run through goalctl against the shared stack. By default create dedicated open test Spaces through Main.
// REZICS_G944_REALM optionally supplies an unjoined /r route segment; REZICS_G944_MEMBER_ID defaults to daniel.
// The browser's web origin must serve this change and allow the Accounts redirect.

async function spaceFixtureAuthority(email: string): Promise<() => Promise<void>> {
  let env = process.env;
  let sharedRoot: string | undefined;
  if (!env.REZICS_WEB_AUTH_PUBLIC_PATH && !env.REZICS_WEB_AUTH_PRIVATE_PATH) {
    const root = resolve(import.meta.dir, '../../..');
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
    sharedRoot = dirname(isAbsolute(common) ? common : resolve(root, common));
    const directory = join(sharedRoot, '.temp/stack/rezics-dev');
    env = { ...readEnv(join(directory, 'dev.env')), ...env,
      REZICS_WEB_AUTH_PUBLIC_PATH: join(directory, 'web-auth/public.json'),
      REZICS_WEB_AUTH_PRIVATE_PATH: join(directory, 'web-auth/private.json') };
  }
  const account = new Pool({ connectionString: env.ACCOUNT_DATABASE_URL });
  const access = new Pool({ connectionString: env.ACCESS_DATABASE_URL });
  let principalId: string;
  let privatePath: string | undefined;
  try {
    const user = (await account.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])).rows[0];
    if (!user) throw new Error('The shared journey member is unavailable');
    const principal = (await access.query<{ id: string }>(
      'SELECT id FROM access.principal WHERE account_subject = $1 AND account_issuer = $2 AND active',
      [user.id, env.ACCOUNT_ISSUER])).rows[0];
    if (!principal) throw new Error('The shared journey principal is unavailable');
    principalId = principal.id;
    if (sharedRoot) {
      const issuer = (await access.query<{ principalId: string; actingSubject: string; accountSubject: string }>(`
        SELECT p.id AS "principalId", r.subject_id AS "actingSubject", p.account_subject AS "accountSubject"
        FROM access.principal_permission_grant g JOIN access.principal p ON p.id = g.principal_id
        JOIN access.representation r ON r.principal_id = p.id
        JOIN access.authority_subject s ON s.id = r.subject_id AND s.kind = 'agent' AND s.active
        WHERE p.account_issuer = $1 AND p.active AND g.action = 'platform:grant'
          AND g.active AND g.valid_until > clock_timestamp()
          AND r.action = 'agent.control' AND r.active AND r.valid_until > clock_timestamp()
        ORDER BY g.id, r.id LIMIT 1`, [env.ACCOUNT_ISSUER])).rows[0];
      if (!issuer) throw new Error('The shared stack has no live platform grant issuer');
      const holder = (await account.query<{ email: string }>('SELECT email FROM "user" WHERE id = $1',
        [issuer.accountSubject])).rows[0];
      if (!holder) throw new Error('The platform grant issuer account is unavailable');
      const saved = JSON.parse(readFileSync(env.REZICS_WEB_AUTH_PRIVATE_PATH!, 'utf8')) as {
        member: { email: string } };
      // The dataset administrator can hold the first designation before the
      // web-auth member. Use that recorded identity, as the dev seed does.
      if (holder.email !== saved.member.email) {
        const directory = join(sharedRoot, '.temp/datasets');
        const credentials = readdirSync(directory).filter(name => name.startsWith('administrator-') && name.endsWith('.json'))
          .map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')) as {
            name: string; email: string; password: string })
          .find(item => item.name === 'Local dataset administrator' && item.email === holder.email);
        if (!credentials?.password) throw new Error('The designated platform administrator fixture is unavailable');
        await mkdir('.temp/g-944/shared-browser', { recursive: true });
        privatePath = `.temp/g-944/shared-browser/platform-administrator-${crypto.randomUUID()}.json`;
        await writeFile(privatePath, JSON.stringify({ member: credentials, ...issuer }), { mode: 0o600 });
        env = { ...env, REZICS_WEB_AUTH_PRIVATE_PATH: privatePath };
      }
    }
  } finally { await Promise.all([account.end(), access.end()]); }
  let administrator: Awaited<ReturnType<typeof platformAdministratorSession>>;
  try { administrator = await platformAdministratorSession(env); }
  finally { if (privatePath) await rm(privatePath); }
  const grants: { grantId: string; generation: string }[] = [];
  const revoke = async () => {
    const failures: unknown[] = [];
    for (const grant of grants.toReversed()) {
      try { await revokePlatformUse(administrator, grant); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Fixture authority cleanup failed');
  };
  try {
    // Repeated fixture creation has its own exact authority; it must not spend
    // the shared reader's three ordinary member Spaces each month.
    const until = new Date(Date.now() + 8 * 60 * 60 * 1_000).toISOString();
    grants.push(await grantPlatformUse(administrator, principalId, 'platform-admin', until));
    grants.push(await grantPlatformResource(administrator, principalId, 'space.create', 'space:create:root', until));
    return revoke;
  } catch (error) { await revoke(); throw error; }
}

test('G-944: shared stack browser journey follows, changes level, pins, joins, leaves and bulk-unfollows at desktop and phone widths', async () => {
  const mainOrigin = process.env.MAIN_ORIGIN ?? 'http://127.0.0.1:3001';
  const probe = await fetch(`${mainOrigin}/v1/me/memberships?actingSubject=${encodeURIComponent(actor)}`);
  expect(probe.status, 'G-938 memberships must be served before this journey can run').not.toBe(404);
  expect(mainRelationships(actor).canLeave).toBe(true);
  const person = people.find(item => item.id === (process.env.REZICS_G944_MEMBER_ID ?? 'daniel'))!;
  const browser = await chromium.launch({ headless: true });
  const baseURL = process.env.REZICS_WEB_E2E_BASE_URL ?? 'http://127.0.0.1:3000';
  await mkdir('.temp/g-944/shared-browser', { recursive: true });
  const failures: unknown[] = [];
  let fixtureRoute = process.env.REZICS_G944_REALM;
  let releaseAuthority = async () => {};
  try {
    if (!fixtureRoute) releaseAuthority = await spaceFixtureAuthority(person.email);
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ baseURL, viewport: { width, height: 860 } });
      const page = await context.newPage();
      page.on('response', response => {
        if (response.url().includes('/v1/access/membership-changes') && !response.ok()) {
          console.error(`G-944 Leave returned ${response.status()}`);
        }
      });
      let cleanup: { realm: string; subject: string; dedicated: boolean } | null = null;
      let sessionHeaders: Record<string, string> = {};
      const command = async <T,>(method: string, path: string, body?: object): Promise<T> => {
        const response = await context.request.fetch(`/api/main${path}`, { method,
          headers: { ...sessionHeaders, origin: new URL(baseURL).origin, 'idempotency-key': crypto.randomUUID() }, data: body });
        if (!response.ok()) throw new Error(`${method} ${path} returned ${response.status()}: ${await response.text()}`);
        return await response.json() as T;
      };
      const main = (subject: string) => mainRelationships(subject, { origin: `${baseURL}/api/main`,
        headers: { origin: new URL(baseURL).origin, 'x-rezics-page-url': page.url() },
        fetch: (async (input, init) => {
          const response = await context.request.fetch(String(input), { method: init?.method, data: init?.body ? String(init.body) : undefined,
            headers: Object.fromEntries(new Headers(init?.headers)) });
          return new Response(await response.text(), { status: response.status(), headers: response.headers() });
        }) as typeof fetch,
      });
      try {
        console.info(`G-944 ${width}px: sign in`);
        await signInAtAccounts(page, '/en/following', person);
        console.info(`G-944 ${width}px: create/read fixture`);
        await visible(page.getByRole('button', { name: 'Account menu' })).toHaveAttribute('data-hydrated', 'true');
        sessionHeaders = { 'x-session-key': (await context.cookies()).find(item => item.name === 'rezics_session_key')!.value };
        const session = await context.request.get('/api/main/v1/me/session-agent', { headers: sessionHeaders });
        const subject = (await session.json() as { sessionAgent: { actingSubject: string } }).sessionAgent.actingSubject;
        // Recover only this test's dedicated fixtures after an interrupted browser run.
        const prior = await main(subject).follows({ q: 'G-944 journey', kind: 'space' });
        for (const item of prior.items.filter(item => item.name?.value.startsWith('G-944 journey ') && item.realm)) {
          const policy = await main(subject).joining(item.realm!);
          if (policy.state === 'joined') {
            const root = `/v1/realms/${item.realm!.slice(-36)}`;
            const settings = await command<{ generation: string }>('GET', `${root}/settings?actingSubject=${encodeURIComponent(subject)}`);
            await command('POST', `${root}/members`, { actingSubject: subject, expectedGeneration: settings.generation,
              reason: 'Clean up an interrupted dedicated relationship journey', member: subject,
              expectedMembershipGeneration: policy.membershipGeneration, action: 'remove', consent: null, durationSeconds: null });
          }
          const state = await main(subject).state(item.id, 'space');
          if (state.following) await main(subject).set({ target: item.id, following: false, expectedRevision: state.revision });
        }
        let route = fixtureRoute;
        if (!route) {
          const created = await command<{ realm: string }>('POST', '/v1/spaces', {
            profile: 'space-realm-v2', name: `G-944 journey ${width} ${crypto.randomUUID().slice(0, 8)}`,
            language: 'en', capabilities: ['realm'], actingSubject: subject,
          });
          const root = `/v1/realms/${created.realm.slice(-36)}`;
          await command('POST', `${root}/management`, { actingSubject: subject });
          const settings = await command<{ generation: string; settings: object; ruleBasis: { revision: string | null } }>(
            'GET', `${root}/settings?actingSubject=${encodeURIComponent(subject)}`);
          await command('PUT', `${root}/settings`, { actingSubject: subject, expectedGeneration: settings.generation,
            reason: 'Open a dedicated relationship journey fixture', expectedRulesRevision: settings.ruleBasis.revision,
            settings: { ...settings.settings, visibility: 'public', selfJoin: true } });
          route = created.realm.slice(-36);
          fixtureRoute = route;
        }
        await page.goto(localizedPath(spaceHref(route, 'community'), 'en'));
        await visible(page.getByRole('button', { name: 'Account menu' })).toHaveAttribute('data-hydrated', 'true');
        const control = page.locator('[data-relationship]').first();
        const realm = (await control.getAttribute('data-relationship'))!;
        const basisQuery = `actingSubject=${encodeURIComponent(subject)}`;
        const joining = await context.request.get(`/api/main/v1/realms/${realm.slice(-36)}/joining?${basisQuery}`);
        const policy = await joining.json() as JoinPolicy;
        expect(policy.selfJoin && policy.open && policy.state !== 'joined', 'Use an open test Space without an existing membership').toBe(true);
        const readState = () => main(subject).state(realm, 'realm');
        const before = await readState();
        expect(before.following, 'Use an unfollowed test Space so this journey leaves no preexisting relation changed').toBe(false);
        cleanup = { realm, subject, dedicated: (await page.getByRole('heading', { level: 1 }).textContent())?.startsWith('G-944 journey ') === true };
        console.info(`G-944 ${width}px: follow, level, pin, join, leave`);
        await control.getByRole('button', { name: /^More actions/ }).click();
        await page.getByRole('menuitem', { name: 'Follow independently of membership' }).click();
        const bell = control.getByRole('button', { name: /^Notifications:/ });
        await visible(bell).toBeVisible();
        await bell.click();
        await page.getByRole('menuitemradio', { name: 'All', exact: true }).click();
        await visible(control.getByRole('button', { name: 'Notifications: All' })).toBeVisible();
        await control.getByRole('button', { name: /^More actions/ }).click();
        await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();
        await visible.poll(async () => (await readState()).pinPosition).toBe(0);
        await control.getByRole('button', { name: /^Join ·/ }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Join', exact: true }).click();
        await visible(control.getByRole('button', { name: /^Joined ·/ })).toBeVisible();
        // Join preserves the explicit interest, bell and pin already chosen.
        await visible.poll(readState).toMatchObject({ following: true, source: 'explicit', level: 'all', pinPosition: 0 });
        page.once('dialog', dialog => void dialog.accept());
        await control.getByRole('button', { name: /^Joined ·/ }).click();
        try {
          await visible(control.getByRole('button', { name: /^Join ·/ })).toBeVisible();
        } catch (error) {
          // Preserve the denial evidence, then finish sidebar and manager checks at both widths.
          const policy = await main(subject).joining(realm);
          try {
            await command('POST', '/v1/access/membership-changes', { profile: 'access-membership-change-v1', kind: 'realm',
              ownerSubject: realm, memberSubject: subject, action: 'leave', expectedGeneration: policy.membershipGeneration,
              expectedPolicyRevision: policy.policyRevision });
          } catch (denial) { failures.push(new Error(`${width}px recipient Leave failed`, { cause: denial })); }
          failures.push(new Error(`${width}px Joined did not change to Join`, { cause: error }));
        }
        expect((await readState()).source).toBe('explicit');
        console.info(`G-944 ${width}px: sidebar and manager`);
        if (width === 390) await page.getByRole('button', { name: 'Open navigation' }).click();
        const pinned = page.getByRole('region', { name: 'Pinned' });
        const described = await readState() as FollowState & { target: { id: string; href: string } };
        await visible(pinned.locator(`a[href='/en${described.target.href}']`)).toBeVisible();
        await page.screenshot({ path: `.temp/g-944/shared-browser/${width}-sidebar.png`, fullPage: false });
        if (width === 390) await page.getByRole('dialog', { name: 'Menu' }).getByRole('button', { name: 'Close' }).click();
        await page.goto('/en/following');
        await visible(page.getByRole('button', { name: 'Account menu' })).toHaveAttribute('data-hydrated', 'true');
        const inventory = page.getByRole('region', { name: 'Following' });
        await inventory.getByRole('searchbox', { name: 'Search by name' }).fill('G-944 journey');
        const follow = inventory.locator(`[data-follow="${described.target.id}"]`);
        await visible(follow).toBeVisible();
        await page.screenshot({ path: `.temp/g-944/shared-browser/${width}-manager.png`, fullPage: false });
        await follow.locator('[data-slot="checkbox"]').click();
        await visible(follow.getByRole('checkbox')).toBeChecked();
        await inventory.getByRole('button', { name: 'Unfollow selected' }).click();
        await visible(follow).toHaveCount(0);
        expect((await readState()).following).toBe(false);
        await page.screenshot({ path: `.temp/g-944/shared-browser/${width}.png`, fullPage: false });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      } catch (error) {
        await page.screenshot({ path: `.temp/g-944/shared-browser/${width}-failed.png`, fullPage: false });
        failures.push(new Error(`${width}px journey failed at ${new URL(page.url()).pathname}`, { cause: error }));
      } finally {
        if (cleanup) {
          const { realm, subject, dedicated } = cleanup;
          const api = main(subject);
          const policy = await api.joining(realm);
          if (policy.state === 'joined') {
            try { await api.leave(realm, policy.membershipGeneration); }
            catch (error) {
              if (!dedicated) throw error;
              // A failed recipient Leave must not strand a membership in our own fixture.
              const root = `/v1/realms/${realm.slice(-36)}`;
              const basis = await command<{ generation: string }>('GET', `${root}/settings?actingSubject=${encodeURIComponent(subject)}`);
              await command('POST', `${root}/members`, { actingSubject: subject, expectedGeneration: basis.generation,
                reason: 'Clean up the dedicated relationship journey fixture', member: subject,
                expectedMembershipGeneration: policy.membershipGeneration, action: 'remove', consent: null, durationSeconds: null });
            }
          }
          const state = await api.state(realm, 'realm');
          if (state.following) await api.set({ target: realm, following: false, expectedRevision: state.revision });
        }
        await context.close();
      }
    }
  } finally {
    try { await browser.close(); } finally { await releaseAuthority(); }
  }
  if (failures.length) throw new AggregateError(failures, 'Live relationship journeys failed');
}, 240_000);
