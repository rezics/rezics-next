import { expect as playwrightExpect, test, type Page, type Route } from '@playwright/test';
import { uuidToSid } from '@rezics/model/address';
import { canonicalHref } from '../features/address/path.ts';
import type { ResolvedAddress } from '../features/address/client.ts';
import { browseMessages } from '../features/discover/browse-messages.ts';
import { copyOf } from '../features/wiki/messages.ts';
import { signInAtAccounts } from './account-sign-in.ts';
import { credentials, PublicCommands, selectedSessionAgent, short } from './direction-9-fixture.ts';

const expect = playwrightExpect.configure({ timeout: 30_000 });

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

interface PositionPage {
  items: { occurrence: string; labels?: { value: string; language: string }[] }[];
  nextCursor: string | null;
  complete: boolean;
}

/** Read the shared official fixture without creating or extending any content. */
async function wiki(page: Page) {
  const actor = await selectedSessionAgent(page.request, await page.context().cookies());
  const api = new PublicCommands(page.request);
  const query = new URLSearchParams({ actingSubject: actor });
  const address = await api.read<ResolvedAddress>(
    `/addresses/resolve?${query}&scope=space&key=franchise-wiki`,
  );
  const zone = address.capabilities?.zone;
  expect(zone, 'the shared stack has the official wiki fixture').toBeTruthy();
  const route = await api.read<{ items: { id: string; title?: unknown }[] }>(
    `/zones/${short(zone!)}/routes?${query}&path=%2Ffranchise`,
  );
  const work = route.items.find((item) => 'title' in item)!.id;
  const first = await api.read<PositionPage>(`/reading-positions/${short(work)}?${query}&limit=50`);
  expect(first.complete, 'the fixture traverses beyond page one').toBe(false);
  const later = await api.read<PositionPage>(
    `/reading-positions/${short(work)}?${query}&${new URLSearchParams({ cursor: first.nextCursor!, limit: '50' })}`,
  );
  const chapter = later.items.find((item) =>
    item.labels?.some((label) => /遠方/u.test(label.value)),
  )!;
  const label = chapter.labels!.find((item) => /遠方/u.test(item.value))!.value;
  return {
    work,
    chapter: short(chapter.occurrence),
    label,
    path: canonicalHref(address.canonical, 'zh-Hant', address.canonical.suffixSource, {
      surface: 'site',
      tail: ['franchise', uuidToSid(short(work))],
      search: '?position=all',
    }),
  };
}

test.use({ viewport: { width: 390, height: 844 } });

test('G1061: phone CJK choice survives slow hydration and an earlier query arriving during navigation', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  await signInAtAccounts(page, '/zh-Hant/settings', credentials().member);
  const fixture = await wiki(page);
  let pathname = new URL(fixture.path, String(info.project.use.baseURL)).pathname;
  const hydration = gate(),
    initialRead = gate(),
    matchedRead = gate(),
    navigation = gate(),
    earlierChoice = gate();
  let hydrated = false,
    initialSeen = false,
    matchSeen = false,
    navigating = false,
    initialFinished = false;
  const reads: { method: string; q: string }[] = [];
  const handler = async (route: Route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (!hydrated && request.resourceType() === 'script') await hydration.promise;
    // Also recognize the old Server Action transport: the regression must
    // reproduce against the previous implementation, not simply await a new URL.
    const chooser =
      (url.pathname === pathname && request.method() === 'POST') ||
      url.pathname === `/api/main/v1/reading-positions/${short(fixture.work)}`;
    if (chooser) {
      const q =
        request.method() === 'POST'
          ? request.postData()?.includes('遠方')
            ? '遠方'
            : ''
          : (url.searchParams.get('q') ?? '');
      reads.push({ method: request.method(), q });
      try {
        const response = await route.fetch();
        if (q) {
          matchSeen = true;
          await matchedRead.promise;
        } else {
          initialSeen = true;
          await initialRead.promise;
        }
        await route.fulfill({ response });
      } catch (error) {
        // Document navigation can abort reads from the departing page. Other
        // transport failures must remain test failures.
        if (!request.failure()) throw error;
      }
      if (!q) initialFinished = true;
      return;
    }
    if (
      request.method() === 'GET' &&
      url.searchParams.get('position') === fixture.chapter &&
      (url.pathname === pathname || url.pathname === `${pathname}.rsc`)
    ) {
      navigating = true;
      await navigation.promise;
    }
    await route.continue();
  };
  await page.route('**/*', handler);
  try {
    await page.goto(fixture.path, { waitUntil: 'commit' });
    // Identity links canonicalize their Work suffix before the chooser opens.
    pathname = new URL(page.url()).pathname;
    const trigger = page
      .getByRole('region', { name: copyOf('zh-Hant').region })
      .getByRole('button');
    await expect(trigger).toBeDisabled();
    await trigger.evaluate((button) => (button as HTMLButtonElement).click());
    await expect(page.getByRole('dialog')).toHaveCount(0);
    hydrated = true;
    hydration.release();
    await expect(trigger).toHaveAttribute('data-hydrated', 'true');
    await expect(trigger).toBeEnabled();
    await trigger.click();
    await expect.poll(() => initialSeen, { timeout: 30_000 }).toBe(true);
    const input = page.getByRole('combobox', { name: browseMessages['zh-Hant'].searchChapters });
    await expect(input).toBeEnabled();
    await input.dispatchEvent('compositionstart');
    await input.fill('遠方');
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
    expect(reads).toHaveLength(1);
    await input.dispatchEvent('compositionend', { data: '遠方' });
    await expect.poll(() => matchSeen, { timeout: 30_000 }).toBe(true);
    await expect(page.getByRole('option', { name: fixture.label, exact: true })).toHaveCount(0);
    matchedRead.release();
    const result = page.getByRole('option', { name: fixture.label, exact: true });
    await expect(result).toBeVisible();
    await info.attach('CJK search in phone sheet', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    const requestsBeforeSelection = reads.length;
    await result.click();
    await expect.poll(() => navigating, { timeout: 30_000 }).toBe(true);
    await expect(page.getByRole('combobox')).toHaveCount(0);
    // Complete the older empty read while the chosen navigation is still held.
    // Cancelling EntityPickerSource alone cannot suppress a Server Action's root.
    initialRead.release();
    await expect.poll(() => initialFinished, { timeout: 30_000 }).toBe(true);
    navigation.release();
    await expect(page).toHaveURL((url) => url.searchParams.get('position') === fixture.chapter, {
      timeout: 30_000,
    });
    await expect(trigger).toContainText(fixture.label);
    expect(reads.length, 'sheet teardown and restored focus issue no new query').toBe(
      requestsBeforeSelection,
    );
    expect(
      reads.every((read) => read.method === 'GET'),
      'search reads cannot carry a page payload',
    ).toBe(true);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await info.attach('Chapter remains selected', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await page.reload();
    await expect(trigger).toContainText(fixture.label);
    await expect(page).toHaveURL((url) => url.searchParams.get('position') === fixture.chapter);
    // A newer deliberate choice may supersede the chapter. Keep the earlier
    // "everything" document request pending while the reader chooses progress.
    let earlierSeen = false,
      earlierFinished = false;
    await page.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (
        request.resourceType() === 'document' &&
        url.pathname === pathname &&
        url.searchParams.get('position') === 'all'
      ) {
        earlierSeen = true;
        await earlierChoice.promise;
        // The browser cancels this request when the newer document wins.
        await route.continue().catch(() => undefined);
        earlierFinished = true;
      } else await route.fallback();
    });
    await page
      .getByRole('region', { name: copyOf('zh-Hant').region })
      .getByRole('link', { name: copyOf('zh-Hant').showEverything, exact: true })
      .click({ noWaitAfter: true });
    await expect.poll(() => earlierSeen).toBe(true);
    await trigger.click({ noWaitAfter: true });
    await page
      .getByRole('link', { name: new RegExp(copyOf('zh-Hant').progressOption) })
      .click({ noWaitAfter: true });
    await expect(page).toHaveURL(
      (url) => url.pathname === pathname && !url.searchParams.has('position'),
      { timeout: 30_000 },
    );
    earlierChoice.release();
    await expect.poll(() => earlierFinished).toBe(true);
    await expect(trigger).toHaveAttribute('data-hydrated', 'true');
    await expect(trigger).not.toContainText(fixture.label);
    await expect(page).toHaveURL(
      (url) => url.pathname === pathname && !url.searchParams.has('position'),
    );
    await info.attach('Only the newer choice supersedes the chapter', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  } finally {
    hydrated = true;
    [hydration, initialRead, matchedRead, navigation, earlierChoice].forEach((pending) =>
      pending.release(),
    );
    await page.unrouteAll({ behavior: 'wait' });
  }
});
