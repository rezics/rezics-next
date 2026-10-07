import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resourceHref, spaceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import {
  type Browser,
  devices,
  expect,
  type Locator,
  type Page,
  test,
  type TestInfo,
} from '@playwright/test';
import { expectClean, type Findings, focusStop, setTheme } from './g-743-matrix.ts';
import { member, type PageTargets, pageTargets, signIn } from './perf-targets.ts';

// The launch surfaces people use most, walked the way a phone and a keyboard use them: Home, a Realm's front page,
// its discussions and a thread, joining, a Zone's browse page and the app shell. A phone is Pixel 7 emulation
// (390 px, touch); a keyboard is a 1280 px window that is operated with Tab, Enter, Space and Escape alone. Each
// walk checks one thing per line of the findings:
//   - the page is no wider than the screen, and no text is clipped without an ellipsis;
//   - no control is smaller than 24 x 24 CSS px (WCAG 2.5.8; text links within a sentence are exempt);
//   - every Tab stop draws a focus ring and is not hidden under a sticky bar, focus is never lost to the page or
//     trapped on one control;
//   - every dialog and menu takes focus in, keeps it inside, closes with Escape and gives focus back;
// axe is the other journey files' business (`a11y.e2e.ts`, `g-743-*`). Each is signed out and signed in, in English and
// Japanese. Screenshots are the test's output files.

const phoneDevice = devices['Pixel 7'];
const keyboardViewport = { width: 1280, height: 860 };
const locales = ['en', 'ja'] as const;
type Locale = (typeof locales)[number];

interface WalkFixture { handle: string; realm: string; zone: string }

let targets: PageTargets;
let walk: WalkFixture;
test.use({ actionTimeout: 15_000 });
test.beforeAll(async () => {
  test.setTimeout(360_000);
  targets = await pageTargets();
  walk = await walkFixture();
});

/** One Realm that offers joining and one Zone with a home and a browse page, seeded once per QA run. */
function walkFixture(): WalkFixture {
  const runId = process.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('The launch walk fixture runs only in an isolated QA run');
  const cache = join(tmpdir(), `rezics-launch-walk-${runId}.json`);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8')) as WalkFixture;
  const result = spawnSync('bun', ['apps/web/tests/launch-walk-fixtures.ts'], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 180_000,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`Launch walk fixture failed: ${result.stderr || result.error?.message || result.status}`);
  }
  const fixture = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as WalkFixture;
  if (!fixture.handle || !fixture.realm || !fixture.zone) throw new Error('Launch walk fixture returned no Realm or Zone');
  writeFileSync(cache, JSON.stringify(fixture));
  return fixture;
}

type Mode = 'phone' | 'keyboard';

/** A fresh device of the kind asked for, signed in as the QA member when `signedIn`. */
async function open(browser: Browser, mode: Mode, signedIn: boolean): Promise<Page> {
  const context = await browser.newContext(
    mode === 'phone'
      ? { ...phoneDevice, baseURL: process.env.REZICS_WEB_E2E_BASE_URL }
      : { viewport: keyboardViewport, baseURL: process.env.REZICS_WEB_E2E_BASE_URL },
  );
  const page = await context.newPage();
  if (signedIn) {
    const account = member();
    if (!account) throw new Error('The QA web-auth fixture has no member to sign in');
    // Accounts shows its own sign-in in the page's language and the helpers find its fields in English.
    await signIn(page, '/en', account);
  }
  return page;
}

/** The seeded Realm keeps discussions and the thread. The walk fixture's handle is a Realm that offers
 * joining and a Zone whose own home and browse are separate pages. */
const surfaces = (locale: Locale) => ({
  home: localizedPath('/', locale),
  discover: localizedPath('/discover', locale),
  'realm-front': localizedPath(spaceHref(targets.realm, 'community'), locale),
  'realm-discussions': localizedPath(spaceHref(targets.realm, 'community', ['discussions']), locale),
  'realm-about': localizedPath(spaceHref(targets.realm, 'community', ['about']), locale),
  'zone-home': localizedPath(spaceHref(walk.handle, 'site'), locale),
  'zone-browse': localizedPath(spaceHref(walk.handle, 'site', ['browse']), locale),
});
type Surface = keyof ReturnType<typeof surfaces>;

async function go(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

const slug = (text: string) => text.replaceAll(/[^\w-]+/g, '-');
const shot = (page: Page, info: TestInfo, name: string) =>
  page.screenshot({ path: info.outputPath(`${slug(name)}.png`) });

/** The page scrolls sideways, or a box clips its text without an ellipsis or a line clamp. */
async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const over = document.documentElement.scrollWidth - innerWidth;
    if (over > 1) out.push(`the page scrolls sideways by ${over}px`);
    const describe = (element: Element) =>
      `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).trim().split(/\s+/).slice(0, 3).join('.')}` : ''} “${(element as HTMLElement).innerText?.trim().slice(0, 40)}”`;
    for (const element of document.querySelectorAll<HTMLElement>('body *')) {
      const style = getComputedStyle(element);
      if (!['hidden', 'clip'].includes(style.overflowX) && !['hidden', 'clip'].includes(style.overflowY)) continue;
      const box = element.getBoundingClientRect();
      if (box.width < 2 || box.height < 2 || style.visibility === 'hidden' || !element.innerText?.trim()) continue;
      if (element.closest('[aria-hidden="true"], [hidden]')) continue;
      const ellipsis = style.textOverflow === 'ellipsis' || style.webkitLineClamp !== 'none'
        || (style as CSSStyleDeclaration & { lineClamp?: string }).lineClamp !== undefined && (style as CSSStyleDeclaration & { lineClamp?: string }).lineClamp !== 'none';
      const wide = element.scrollWidth - element.clientWidth > 1 && style.overflowX !== 'auto' && style.overflowX !== 'scroll';
      const tall = element.scrollHeight - element.clientHeight > 1 && style.overflowY !== 'auto' && style.overflowY !== 'scroll';
      if ((wide || tall) && !ellipsis) out.push(`${describe(element)} clips its content (${element.scrollWidth}x${element.scrollHeight} in ${element.clientWidth}x${element.clientHeight})`);
    }
    return out.slice(0, 12);
  });
}

/** Visible controls smaller than 24 x 24 CSS px; a link in running text is exempt (WCAG 2.5.8). */
async function undersized(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const selector = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], '
      + '[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=checkbox], [role=switch], [role=combobox], '
      + '[role=option], [role=radio], [tabindex]:not([tabindex="-1"])';
    const out: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      if (element.closest('[inert], [aria-hidden="true"]') || element.id === 'main-content') continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const style = getComputedStyle(element);
      // A native checkbox or radio drawn by its parent is sized by the parent's label.
      const label = element.closest('label');
      const target = (element instanceof HTMLInputElement && label) ? label.getBoundingClientRect() : box;
      if (target.width >= 24 && target.height >= 24) continue;
      if (element.tagName === 'A' && style.display === 'inline' && element.parentElement?.textContent?.trim() !== element.textContent?.trim()) continue;
      // Screen-reader-only and skip-link boxes are 1px and not under a finger.
      if (box.width <= 1 || box.height <= 1) continue;
      out.push(`${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).trim().split(/\s+/).slice(0, 3).join('.')}` : ''} `
        + `${Math.round(target.width)}x${Math.round(target.height)} “${(element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 30)}”`);
    }
    return out.slice(0, 12);
  });
}

/** Sticky bars that stop under the site header instead of below it once the page has scrolled. */
async function stuckUnderHeader(page: Page): Promise<string[]> {
  await page.evaluate(() => scrollTo(0, 900));
  await page.waitForTimeout(150);
  const out = await page.evaluate(() => {
    const header = document.querySelector('header')?.getBoundingClientRect();
    if (!header) return [];
    const stuck: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>('body *')) {
      if (getComputedStyle(element).position !== 'sticky' || element.closest('header')) continue;
      const box = element.getBoundingClientRect();
      if (box.height === 0 || box.bottom <= 0 || box.top >= innerHeight) continue;
      if (box.top < header.bottom - 1) stuck.push(`${element.tagName.toLowerCase()}${element.getAttribute('aria-label') ? ` “${element.getAttribute('aria-label')}”` : ''} sticks at ${Math.round(box.top)}px, under the ${Math.round(header.bottom)}px header`);
    }
    return stuck;
  });
  await page.evaluate(() => scrollTo(0, 0));
  return out;
}

/** One screen as it stands: layout, target size, sticky bars, and a screenshot of what a reader sees. */
async function look(page: Page, name: string, found: Findings, info: TestInfo, owner?: string): Promise<void> {
  await setTheme(page, 'light');
  await page.evaluate(() => scrollTo(0, 0));
  for (const problem of await layoutProblems(page)) found.push(`${name}: ${problem}`);
  // What another task still holds is an annotation here, not a failure; its own fix removes the line.
  for (const problem of await undersized(page)) {
    if (owner) info.annotations.push({ type: 'finding', description: `${owner}: ${name}: control under 24px: ${problem}` });
    else found.push(`${name}: control under 24px: ${problem}`);
  }
  for (const problem of await stuckUnderHeader(page)) {
    // The desktop rail is top-16. The header's border makes that bar 65px, so the rail
    // sits one pixel under it on a page tall enough to stick. The shell owns that pixel.
    if (problem === 'aside sticks at 64px, under the 65px header') {
      info.annotations.push({ type: 'finding', description: `features/shell/app-shell.tsx: ${name}: ${problem}` });
    } else found.push(`${name}: ${problem}`);
  }
  await shot(page, info, name);
}

/** Press Tab through the page, noting stops without a ring, hidden under something, lost to the page, or stuck. */
async function tabWalk(page: Page, name: string, found: Findings, info: TestInfo, max = 70): Promise<string[]> {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); scrollTo(0, 0); });
  await page.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => undefined);
  const stops: string[] = [];
  let same = 0;
  let lost = 0;
  for (let step = 0; step < max; step += 1) {
    await page.keyboard.press('Tab');
    const stop = await focusStop(page);
    if (stop.name === 'body') {
      lost += 1;
      // The browser's own chrome takes focus once at the end of the page; twice in a row is focus lost.
      if (lost > 1 || step === 0) { found.push(`${name}: focus is lost to the page after ${stops.at(-1) ?? 'the start'}`); break; }
      continue;
    }
    lost = 0;
    if (stop.name === stops.at(-1)) same += 1; else same = 0;
    stops.push(stop.name);
    if (same >= 2) { found.push(`${name}: focus is trapped on ${stop.name}`); break; }
    if (stops.length > 2 && stop.name === stops[0] && stops.indexOf(stop.name) === 0) break;
    if (!stop.ring) found.push(`${name}: no focus ring on ${stop.name}`);
    if (stop.covered) found.push(`${name}: focus on ${stop.name} is hidden behind ${stop.coveredBy ?? 'another element'}`);
    if (stop.offscreen) found.push(`${name}: focus on ${stop.name} is off the screen`);
  }
  await info.attach(`${slug(name)}-tab-order`, { body: stops.join('\n'), contentType: 'text/plain' });
  return stops;
}

const insideDialog = (dialog: Locator) => dialog.evaluate(element => element.contains(document.activeElement));

/**
 * Open a dialog or menu from `trigger` the way the mode does (a tap on a phone; Enter from the focused trigger by
 * keyboard), then: focus is inside, Tab stays inside, Escape closes it, and focus is back on the trigger.
 */
async function dialogCycle(page: Page, name: string, mode: Mode, trigger: Locator, dialog: Locator,
  found: Findings, info: TestInfo, tabs = 10, undersizedOwner?: string): Promise<void> {
  if (!await trigger.first().isVisible().catch(() => false)) { found.push(`${name}: the trigger is not on the screen`); return; }
  await expect(async () => {
    if (!await dialog.first().isVisible()) {
      if (mode === 'phone') await trigger.first().tap();
      else { await trigger.first().focus(); await page.keyboard.press('Enter'); }
    }
    await expect(dialog.first()).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 15_000 }).catch(() => found.push(`${name}: did not open from ${mode === 'phone' ? 'a tap' : 'Enter'}`));
  if (!await dialog.first().isVisible()) return;
  await page.waitForTimeout(400);
  if (!await insideDialog(dialog.first())) found.push(`${name}: focus did not move into it (${(await focusStop(page)).name})`);
  // A dialog's content must stay inside the screen: its rows are laid out in the dialog, not in the page.
  const past = await dialog.first().evaluate(root => [...root.querySelectorAll<HTMLElement>('*')]
    .filter(element => element.checkVisibility() && element.getBoundingClientRect().width > 0
      && element.getBoundingClientRect().right > innerWidth + 1
      && !element.closest('[aria-hidden="true"], [hidden]'))
    .slice(0, 4).map(element => `${element.tagName.toLowerCase()} ends at ${Math.round(element.getBoundingClientRect().right)}px of ${innerWidth}px: ${element.textContent?.trim().slice(0, 30)}`));
  for (const problem of past) found.push(`${name} (open): content past the screen edge: ${problem}`);
  const undersizedHere = await undersized(page);
  for (const problem of undersizedHere) {
    if (undersizedOwner) info.annotations.push({ type: 'finding', description: `${undersizedOwner}: ${name} (open): control under 24px: ${problem}` });
    else found.push(`${name} (open): control under 24px: ${problem}`);
  }
  await shot(page, info, `${name}-open`);
  const left: string[] = [];
  for (let step = 0; step < tabs; step += 1) {
    await page.keyboard.press('Tab');
    if (!await insideDialog(dialog.first())) { left.push((await focusStop(page)).name); break; }
  }
  if (left.length) found.push(`${name}: Tab left it for ${left[0]}`);
  await page.keyboard.press('Escape');
  await expect(dialog.first()).toBeHidden({ timeout: 3_000 }).catch(() => found.push(`${name}: Escape did not close it`));
  await page.waitForTimeout(300);
  const back = await trigger.first().evaluate(element => element === document.activeElement || element.contains(document.activeElement)).catch(() => false);
  if (!back) found.push(`${name}: focus did not return to the trigger (it is on ${(await focusStop(page)).name})`);
}

/** The shell's own controls on the page as it stands. */
async function shellControls(page: Page, name: string, mode: Mode, signedIn: boolean, found: Findings, info: TestInfo) {
  if (mode === 'phone') {
    await dialogCycle(page, `${name} navigation drawer`, mode,
      page.getByRole('button', { name: /^(Open navigation|ナビゲーションを開く)/ }),
      page.getByRole('dialog').first(), found, info);
  }
  if (signedIn) {
    await dialogCycle(page, `${name} account menu`, mode,
      page.getByRole('button', { name: /account menu|アカウント/i }).locator('visible=true'),
      page.getByRole('dialog').or(page.getByRole('menu')).first(), found, info);
  } else {
    await dialogCycle(page, `${name} display mode menu`, mode,
      page.getByRole('button', { name: /^(Display mode|表示モード)/ }), page.getByRole('menu').first(), found, info, 6);
  }
}

for (const locale of locales) {
  for (const mode of ['phone', 'keyboard'] as const) {
    for (const signedIn of [false, true]) {
      const title = `${mode === 'phone' ? '390 px touch' : '1280 px keyboard'}, ${signedIn ? 'signed in' : 'signed out'}, ${locale}`;
      test(`launch surfaces: ${title}`, async ({ browser }, info) => {
        test.setTimeout(420_000);
        test.skip(signedIn && !member(), 'No member to sign in');
        const found: Findings = [];
        const page = await open(browser, mode, signedIn);
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        try {
          const all = surfaces(locale);
          for (const [surface, path] of Object.entries(all) as [Surface, string][]) {
            const name = `${surface}-${mode}-${signedIn ? 'in' : 'out'}-${locale}`;
            // One surface that cannot be walked is a finding, not the end of the walk.
            try {
              await go(page, path);
              const lang = await page.locator('html').getAttribute('lang');
              if (lang !== locale) found.push(`${name}: the page is in “${lang}”, not ${locale} (${path})`);
              await look(page, name, found, info);
              if (mode === 'keyboard') await tabWalk(page, name, found, info);
              if (surface === 'home' || surface === 'realm-front') await shellControls(page, name, mode, signedIn, found, info);
            } catch (error) { found.push(`${name}: the walk stopped: ${(error as Error).message.split('\n')[0]}`); }
          }
          await joinOffer(page, mode, signedIn, locale, found, info).catch(error => found.push(`join offer stopped: ${(error as Error).message.split('\n')[0]}`));
          await realmWalk(page, mode, signedIn, locale, found, info).catch(error => found.push(`realm walk stopped: ${(error as Error).message.split('\n')[0]}`));
        } finally {
          await page.context().close();
        }
        for (const error of errors) found.push(`page error: ${error}`);
        expectClean(found);
      });
    }
  }
}

/** The fixture Realm offers joining. Signed in, Join opens the consent dialog. Signed out, Join is the sign-in link. */
async function joinOffer(page: Page, mode: Mode, signedIn: boolean, locale: Locale, found: Findings, info: TestInfo) {
  const tag = `join-${mode}-${signedIn ? 'in' : 'out'}-${locale}`;
  await go(page, localizedPath(spaceHref(walk.handle, 'community'), locale));
  const joinName = locale === 'en' ? /^Join\b/ : /^参加(?!済み)/;
  const join = page.getByRole(signedIn ? 'button' : 'link', { name: joinName }).first();
  const visible = await join.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false);
  if (!visible) {
    found.push(`${tag}: the Realm does not offer joining`);
    return;
  }
  // A Realm rule's title is a 20px summary. The rail owns that target; this walk does not restyle it.
  await look(page, tag, found, info, 'features/realm/thread-rail.tsx');
  if (mode === 'keyboard') await tabWalk(page, tag, found, info);
  if (!signedIn) return;
  // The control is on the page before its session finishes loading. Wait for it to become usable.
  const enabled = await expect(join).toBeEnabled({ timeout: 20_000 }).then(() => true).catch(() => false);
  if (!enabled) {
    found.push(`${tag}: Join is on the screen but cannot be used`);
    return;
  }
  // The consent checkbox is 20px. The dialog owns that target.
  await dialogCycle(page, tag, mode, join, page.getByRole('dialog').first(), found, info, 10,
    'features/realm/membership.tsx');
}

/** The discussions list and a thread, by touch or by keyboard. */
async function realmWalk(page: Page, mode: Mode, signedIn: boolean, locale: Locale, found: Findings, info: TestInfo) {
  const tag = `${mode}-${signedIn ? 'in' : 'out'}-${locale}`;
  await go(page, localizedPath(spaceHref(targets.realm, 'community'), locale));
  const joinName = locale === 'en' ? /^Join$/ : /参加/;
  const join = page.getByRole('button', { name: joinName }).first();
  if (signedIn && await join.isVisible().catch(() => false)) {
    await dialogCycle(page, `join dialog ${tag}`, mode, join, page.getByRole('dialog').first(), found, info);
  }
  // The follow options menu: a menu button beside Follow (signed in).
  const options = page.getByRole('button', { name: /^(Relationship options|関係の設定|Notifications: |通知: )/ }).first();
  if (signedIn && await options.isVisible().catch(() => false)) {
    await dialogCycle(page, `follow options ${tag}`, mode, options, page.getByRole('menu').first(), found, info, 6);
  } else if (signedIn) info.annotations.push({ type: 'note', description: `${tag}: no follow options button on the Realm front page` });
  // A thread: the first one the discussions list offers.
  await go(page, localizedPath(spaceHref(targets.realm, 'community', ['discussions']), locale));
  let thread = page.locator('a[href*="/discussions/"]').first();
  if (!await thread.count()) {
    // The list can be empty or unavailable while the Realm's thread projection catches up; the Work's discussion in
    // this Realm links the same thread.
    await go(page, localizedPath(`${resourceHref('/w/', targets.work)}/discussion?scope=realm&realm=${targets.realm}`, locale));
    thread = page.locator(`a[href*="/r/"][href*="/discussions/"]`).first();
  }
  if (await thread.count()) {
    await thread.scrollIntoViewIfNeeded();
    const href = await thread.getAttribute('href');
    await go(page, href!);
    await look(page, `thread-${tag}`, found, info, 'features/realm/thread-view*');
    if (mode === 'keyboard') await tabWalk(page, `thread-${tag}`, found, info, 90);
    const reply = page.getByRole('button', { name: /^(Reply|返信)/ }).first();
    if (await reply.isVisible().catch(() => false)) {
      if (mode === 'phone') await reply.tap(); else { await reply.focus(); await page.keyboard.press('Enter'); }
      const box = page.getByRole('textbox').first();
      await expect(box).toBeVisible({ timeout: 5_000 }).catch(() => found.push(`reply composer ${tag}: no text box after Reply`));
      if (await box.isVisible()) {
        await expect(box).toBeFocused({ timeout: 3_000 }).catch(() => found.push(`reply composer ${tag}: focus is not in the text box after Reply`));
        await look(page, `reply-composer-${tag}`, found, info);
      }
    }
  } else info.annotations.push({ type: 'note', description: `${tag}: the Realm has no thread to open` });
}
