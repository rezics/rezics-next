// Runs axe over every page type of a running web build, signed out and as a
// reader, author and moderator, in light and dark and at desktop and phone
// widths, and prints the violations grouped by page:
//
//   node apps/web/tests/a11y-audit.ts --base http://127.0.0.1:3003 --work <uuid> --chapter <uuid> \
//     --profile <handle> [--realm fiction] [--account <email>:<password>] [--only <name>,...]
//
// `--account` signs in someone who writes in Studio and manages the Realm, as
// the demo seed's first person does; without it only signed-out pages run.
import { parseArgs } from 'node:util';
import { type Browser, chromium, type Page } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';
import { axeViolations, formatViolations } from './a11y-axe.ts';

const { values } = parseArgs({ options: { base: { type: 'string' }, work: { type: 'string' },
  chapter: { type: 'string' }, profile: { type: 'string' }, realm: { type: 'string', default: 'fiction' },
  account: { type: 'string' }, only: { type: 'string' } } });
if (!values.base || !values.work || !values.chapter || !values.profile) {
  throw new Error('--base, --work, --chapter and --profile are required');
}

interface Target { name: string; path: string | ((page: Page) => Promise<string>) }

const work = `/en/w/${values.work}`;
const signedOut: Target[] = [
  { name: 'home', path: '/en' }, { name: 'home-top', path: '/en?sort=top' },
  { name: 'discover', path: '/en/discover' }, { name: 'search', path: '/en/search?q=the' },
  { name: 'search-empty', path: '/en/search' }, { name: 'work', path: work },
  { name: 'work-contents', path: `${work}/contents` }, { name: 'work-discussion', path: `${work}/discussion` },
  { name: 'work-versions', path: `${work}/versions` }, { name: 'work-history', path: `${work}/history` },
  { name: 'reader', path: `${work}/read/${values.chapter}` }, { name: 'realm', path: `/en/r/${values.realm}` },
  { name: 'realm-about', path: `/en/r/${values.realm}/about` }, { name: 'realm-works', path: `/en/r/${values.realm}/works` },
  { name: 'realm-discussions', path: `/en/r/${values.realm}/discussions` },
  { name: 'profile', path: `/en/@${values.profile}` }, { name: 'profile-works', path: `/en/@${values.profile}/works` },
  { name: 'notifications-signed-out', path: '/en/notifications' }, { name: 'not-found', path: '/en/no-such-page/x' },
  { name: 'zh-home', path: '/zh-Hans' },
];

/** The first link on the page whose address matches, for pages reached through data. */
const firstLink = (from: string, pattern: RegExp) => async (page: Page) => {
  await page.goto(from);
  const hrefs = await page.locator('a[href]').evaluateAll(links => links.map(link => link.getAttribute('href')!));
  const href = hrefs.find(value => pattern.test(value));
  if (!href) throw new Error(`No link matching ${pattern} on ${from}`);
  return href;
};

const signedIn: Target[] = [
  { name: 'home-signed-in', path: '/en' }, { name: 'notifications', path: '/en/notifications' },
  { name: 'settings', path: '/en/settings' }, { name: 'settings-profile', path: '/en/settings/profile' },
  { name: 'studio', path: async page => { await page.goto('/en/studio'); return new URL(page.url()).pathname; } },
  { name: 'studio-new', path: async page => `${await studioDesk(page)}/new` },
  { name: 'studio-work', path: async page => firstLink(await studioDesk(page), /\/works\/[^/?]+$/)(page) },
  { name: 'studio-work-details', path: async page =>
    `${await firstLink(await studioDesk(page), /\/works\/[^/?]+$/)(page)}?tab=details` },
  { name: 'studio-write', path: async page =>
    firstLink(`${await firstLink(await studioDesk(page), /\/works\/[^/?]+$/)(page)}?tab=chapters`,
      /\/(?:write|chapters)\/[^/?]+$/)(page) },
  { name: 'manage', path: '/en/manage' },
  { name: 'manage-queue', path: async page => firstLink('/en/manage', /\/manage\/r\/[^/?]+$/)(page) },
  { name: 'manage-members', path: async page => `${await firstLink('/en/manage', /\/manage\/r\/[^/?]+$/)(page)}/members` },
  { name: 'manage-roles', path: async page => `${await firstLink('/en/manage', /\/manage\/r\/[^/?]+$/)(page)}/roles` },
  { name: 'manage-settings', path: async page =>
    `${await firstLink('/en/manage', /\/manage\/r\/[^/?]+$/)(page)}/settings` },
  { name: 'manage-log', path: async page => `${await firstLink('/en/manage', /\/manage\/r\/[^/?]+$/)(page)}/log` },
];

async function studioDesk(page: Page) {
  await page.goto('/en/studio');
  return new URL(page.url()).pathname;
}

const selected = (targets: Target[]) => targets.filter(target => !values.only
  || values.only.split(',').includes(target.name));

async function audit(browser: Browser, targets: Target[], storageState?: string) {
  let failures = 0;
  for (const target of selected(targets)) {
    for (const theme of ['light', 'dark'] as const) {
      for (const viewport of [{ width: 1280, height: 860 }, { width: 390, height: 844 }]) {
        const context = await browser.newContext({ baseURL: values.base, viewport, storageState });
        await context.addCookies([{ name: 'rezics_theme', value: theme, url: values.base! }]);
        const page = await context.newPage();
        try {
          const path = typeof target.path === 'string' ? target.path : await target.path(page);
          await page.goto(path);
          await page.waitForLoadState('networkidle');
          const violations = await axeViolations(page);
          const label = `${target.name} ${theme} ${viewport.width} (${path})`;
          if (violations.length) {
            failures += 1;
            console.log(`\n## ${label}\n${formatViolations(violations)}`);
          } else console.error(`ok ${label}`);
        } catch (error) {
          failures += 1;
          console.log(`\n## ${target.name} ${theme} ${viewport.width}: ${String(error)}`);
        } finally { await context.close(); }
      }
    }
  }
  return failures;
}

const browser = await chromium.launch();
try {
  let failures = await audit(browser, signedOut);
  if (values.account) {
    const [email, password] = [values.account.slice(0, values.account.indexOf(':')),
      values.account.slice(values.account.indexOf(':') + 1)];
    const context = await browser.newContext({ baseURL: values.base });
    await signInAtAccounts(await context.newPage(), '/en', { email, password });
    const state = `${process.env.TMPDIR ?? '/tmp'}/rezics-a11y-audit-${process.pid}.json`;
    await context.storageState({ path: state });
    await context.close();
    failures += await audit(browser, signedIn, state);
  }
  console.log(`\n${failures} page states with violations`);
  process.exitCode = failures ? 1 : 0;
} finally {
  await browser.close();
}
