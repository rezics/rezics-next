import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  expect as baseExpect,
  type Locator,
  type Page,
  test,
  type TestInfo,
} from '@playwright/test';
import { materializeData } from 'native-i18n';
import { catalogs } from '../i18n/catalogs.ts';
import { parseAddressSegment } from '../features/address/path.ts';
import { selectedSessionAgent } from './direction-9-fixture.ts';
import { realmHref } from '../features/realm/route.ts';
import { mediaMessages } from '../features/document-editor/media-messages.ts';
import {
  keyboardReach,
  pressByKeyboard,
  expectClean,
  type Findings,
  locales,
} from './g-743-matrix.ts';
import {
  closeParticipant,
  createPublicWork,
  createRealm,
  grant,
  joinRealm,
  letMemberDraft,
  managerSession,
  participantFor,
  seedThread,
  waitForThreads,
  waitForWorkTypeahead,
} from './realm-community-fixture.ts';

const expect = baseExpect.configure({ timeout: 30_000 });
const diagnosticRealms = new WeakMap<Page, string>();
test.use({ actionTimeout: 30_000, reducedMotion: 'reduce' });
test.setTimeout(600_000);
test.afterAll(closeParticipant);
async function capture(page: Page, info: TestInfo, name: string, detail = '') {
  const directory = resolve('.temp/realm-journeys', process.env.REZICS_QA_RUN_ID ?? 'local');
  await mkdir(directory, { recursive: true });
  const file = resolve(directory, `${info.testId}-${name}`);
  await writeFile(
    `${file}.txt`,
    `${page.url()}\n${detail}\n${await page.locator('body').innerText()}`,
  );
  await page.screenshot({ path: `${file}.png`, fullPage: true });
  await info.attach(name, { path: `${file}.txt`, contentType: 'text/plain' });
  await info.attach(`${name}-screen`, { path: `${file}.png`, contentType: 'image/png' });
}
function recordApiFailures(page: Page) {
  page.on('requestfailed', request => {
    if (new URL(request.url()).pathname.startsWith('/api/main/'))
      console.log(`Realm journey transport failure: ${request.method()} ${request.url()} ${request.failure()?.errorText}`);
  });
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/main/') || response.status() < 400) return;
    // Navigation can discard the browser's response body; diagnostics must not interrupt the journey.
    const body = await response.text().catch(() => '[response body unavailable after navigation]');
    console.log(
      `Realm journey API response: ${response.request().method()} ${url.pathname}${url.search} ${response.request().postData() ?? ''} HTTP ${response.status()} ${body}`,
    );
  });
}
test.afterEach(async ({ browser }, info) => {
  if (info.status === info.expectedStatus) return;
  let index = 0;
  for (const context of browser.contexts())
    for (const page of context.pages()) {
      const parts = new URL(page.url()).pathname.split('/');
      const realm = diagnosticRealms.get(page);
      const reply = parts[4] === 'discussions' ? parseAddressSegment(parts[5] ?? '') : null;
      let detail = '';
      if (realm && reply && reply.kind !== 'alias') {
        const cookies = await context.cookies();
        const actor = cookies.some((cookie) => cookie.name === 'rezics_session_key')
          ? await selectedSessionAgent(page.request, cookies)
          : null;
        const path = `/api/main/v1/realms/${realm}/threads/${reply.id}?${new URLSearchParams({
          sort: 'best',
          ...(actor ? { actingSubject: actor } : {}),
        })}`;
        const response = await page.request.get(path);
        detail = `GET ${path}\nHTTP ${response.status()}\n${await response.text()}`;
      }
      await capture(page, info, `failed-page-${index++}`, detail);
    }
});

async function hydrated(control: Locator) {
  await expect
    .poll(
      () =>
        control.evaluate((element) => {
          // ProseMirror owns the contenteditable; React owns its enclosing editor.
          for (let node: Element | null = element; node; node = node.parentElement) {
            if (Object.keys(node).some((key) => key.startsWith('__reactProps$'))) return true;
          }
          return false;
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
}

async function typeByKeyboard(page: Page, control: Locator, value: string, found: Findings) {
  await expect(control).toBeVisible();
  await hydrated(control);
  await keyboardReach(page, control, found, value);
  await page.keyboard.insertText(value);
}

async function activate(page: Page, control: Locator, found: Findings) {
  await hydrated(control);
  await pressByKeyboard(page, control, found, await control.innerText());
}

async function readerText(page: Page, text: string, locale: 'en' | 'ja', found: Findings) {
  const body = page.getByText(text, { exact: true });
  const failed = page.getByRole('status').filter({ hasText: mediaMessages[locale].ratingFailed });
  await expect(body.or(failed.first()).first()).toBeVisible();
  if (!await body.isVisible() && await failed.first().isVisible()) {
    await activate(page, failed.first().getByRole('button', {
      name: mediaMessages[locale].retryRating, exact: true,
    }), found);
  }
  await expect(body).toBeVisible();
}

/** Menus use arrow navigation rather than the document's Tab order. */
async function chooseMenu(
  page: Page,
  label: string,
  current: string,
  next: string,
  found: Findings,
) {
  const trigger = page.getByRole('button', { name: `${label}: ${current}`, exact: true });
  await hydrated(trigger);
  await keyboardReach(page, trigger, found, `${label}: ${current}`);
  await expect(trigger).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const choices = page.getByRole('menuitemradio');
  await expect(choices.first()).toBeVisible();
  await page.keyboard.press('Home');
  for (let index = 0; index < (await choices.count()); index++) {
    if (
      (await page.locator('[role="menuitemradio"][data-highlighted]').innerText()).split(
        '\n',
      )[0] === next
    ) {
      await page.keyboard.press('Enter');
      await expect(choices.first()).not.toBeVisible();
      await expect(
        page.getByRole('button', { name: `${label}: ${next}`, exact: true }),
      ).toBeVisible();
      return;
    }
    await page.keyboard.press('ArrowDown');
  }
  throw new Error(`The keyboard could not choose ${next}`);
}

test('realm-boards: a visitor selects boards and returns to all discussions after reload in English and Japanese', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(600_000);
  const found: Findings = [];
  const manager = await managerSession(page);
  const realm = await createRealm(
    manager.api,
    manager.actor,
    manager.principalId,
    `Board Circle ${randomUUID().slice(0, 8)}`,
  );
  const work = await createPublicWork(
    manager.api,
    manager.actor,
    manager.principalId,
    `Board Work ${randomUUID().slice(0, 8)}`,
  );
  await grant(
    'classification:define:global',
    'classification.proposition.define',
    manager.principalId,
    manager.actor,
  );
  await grant(
    `classification:context:${realm.realm}`,
    'classification.context.configure',
    manager.principalId,
    manager.actor,
  );
  type Concept = { concept: string; scheme: string; schemeHead: string };
  const labels = [`News ${randomUUID().slice(0, 6)}`, `Questions ${randomUUID().slice(0, 6)}`];
  const boards: Concept[] = [];
  for (const label of labels) {
    const previous = boards.at(-1);
    boards.push(
      await manager.api.write<Concept>('/classification-vocabulary', {
        profile: 'classification-proposition-v2',
        scheme: previous ? { id: previous.scheme, expectedHead: previous.schemeHead } : null,
        labels: [{ language: 'en', value: label }],
        alternativeLabels: [],
        broader: [],
        narrower: [],
        actingSubject: manager.actor,
      }),
    );
  }
  const last = boards.at(-1)!;
  await manager.api.write('/classification-contexts', {
    profile: 'classification-context-v2',
    realm: realm.realm,
    expectedHead: null,
    scheme: { id: last.scheme, expectedHead: last.schemeHead },
    actingSubject: manager.actor,
  });
  const titles = [
    `News thread ${randomUUID().slice(0, 6)}`,
    `Question thread ${randomUUID().slice(0, 6)}`,
  ];
  for (let index = 0; index < boards.length; index++) {
    await seedThread(
      manager.api,
      realm.realm,
      work,
      manager.actor,
      manager.principalId,
      titles[index]!,
      'A discussion placed on one board.',
      [boards[index]!.concept],
    );
  }
  await waitForThreads(manager.api, realm.realm, manager.actor, titles);
  for (let index = 0; index < boards.length; index++) {
    await waitForThreads(
      manager.api,
      realm.realm,
      manager.actor,
      [titles[index]!],
      boards[index]!.concept,
    );
  }
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
    reducedMotion: 'reduce',
  });
  try {
    const reader = await context.newPage();
    for (const locale of [locales.latin, locales.cjk]) {
      const t = materializeData(await catalogs.realm[locale](), { locale });
      const f = materializeData(await catalogs.feed[locale](), { locale });
      await reader.goto(realmHref(locale, realm.realm, 'discussions'));
      await expect(reader.locator('html')).toHaveAttribute('lang', locale);
      const nav = reader.getByRole('navigation', { name: t.boards, exact: true });
      const feed = reader.getByRole('feed', { name: f.discussionsLabel, exact: true });
      await expect(feed.getByRole('heading', { level: 3 })).toHaveCount(2);
      for (let index = 0; index < boards.length; index++) {
        const choice = nav.getByRole('link', { name: labels[index]!, exact: true });
        await activate(reader, choice, found);
        await expect(reader).toHaveURL(
          (url) => url.searchParams.get('concept') === boards[index]!.concept,
        );
        await reader.reload();
        await expect(choice).toHaveAttribute('aria-current', 'page');
        await expect(feed.getByRole('heading', { level: 3 })).toHaveText([titles[index]!]);
      }
      await activate(reader, nav.getByRole('link', { name: t.allDiscussions, exact: true }), found);
      await expect(reader).toHaveURL((url) => !url.searchParams.has('concept'));
      await reader.reload();
      await expect(feed.getByRole('heading', { level: 3 })).toHaveCount(2);
      for (const title of titles)
        await expect(feed.getByRole('heading', { name: title, exact: true })).toBeVisible();
    }
    expectClean(found);
  } catch (error) {
    const reader = context.pages()[0]!;
    const query = new URL(reader.url()).searchParams;
    const path = `/api/main/v1/realms/${realm.id}/threads?${query}`;
    const response = await reader.request.get(path);
    await capture(
      reader,
      info,
      'board-request',
      `GET ${path}\nHTTP ${response.status()}\n${await response.text()}`,
    );
    throw error;
  } finally {
    await context.close();
  }
});

test('realm-threads: a member publishes a thread and nested replies that another reader sees after reload in English and Japanese', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(600_000);
  const found: Findings = [];
  recordApiFailures(page);
  const manager = await managerSession(page);
  const realm = await createRealm(
    manager.api,
    manager.actor,
    manager.principalId,
    `Thread Circle ${randomUUID().slice(0, 8)}`,
  );
  const work = await createPublicWork(
    manager.api,
    manager.actor,
    manager.principalId,
    `Conversation Work ${randomUUID().slice(0, 8)}`,
  );
  await waitForWorkTypeahead(manager.api, work);
  const writer = await participantFor(browser, info);
  diagnosticRealms.set(page, realm.id);
  diagnosticRealms.set(writer.page, realm.id);
  recordApiFailures(writer.page);
  await grant(`work:read:${work.work}`, 'work.read', writer.principalId, writer.actor);
  await grant(`reply:create:${work.work}`, 'reply.create', writer.principalId, writer.actor);
  await grant(`reply:place:${realm.realm}`, 'reply.place', writer.principalId, writer.actor);
  await letMemberDraft(writer.page, writer.actor, writer.principalId);
  await joinRealm(writer.page, realm.realm);
  for (const locale of [locales.latin, locales.cjk]) {
    const t = materializeData(await catalogs.realm[locale](), { locale });
    const f = materializeData(await catalogs.feed[locale](), { locale });
    const p = materializeData(await catalogs.postComposer[locale](), { locale });
    await writer.page.goto(realmHref(locale, realm.realm, 'discussions'));
    await activate(
      writer.page,
      writer.page.getByRole('link', { name: t.createPost, exact: true }),
      found,
    );
    await expect(writer.page.getByText(p.draftSaved, { exact: true })).toBeVisible();
    const changeWork = writer.page.getByRole('button', { name: p.workChange, exact: true });
    if (await changeWork.isVisible()) await activate(writer.page, changeWork, found);
    const search = writer.page.getByRole('searchbox', { name: p.workSearch, exact: true });
    await typeByKeyboard(writer.page, search, work.title, found);
    await activate(
      writer.page,
      writer.page.getByRole('button', { name: work.title, exact: true }),
      found,
    );
    const title = `Conversation ${randomUUID().slice(0, 6)}`;
    const body =
      locale === 'ja' ? 'この物語について話しましょう。' : 'Let us talk about this story.';
    await typeByKeyboard(
      writer.page,
      writer.page.getByRole('textbox', { name: p.titleLabel, exact: true }),
      title,
      found,
    );
    await typeByKeyboard(
      writer.page,
      writer.page.getByRole('textbox', { name: p.body, exact: true }),
      body,
      found,
    );
    await activate(
      writer.page,
      writer.page.getByRole('button', { name: p.post, exact: true }),
      found,
    );
    await expect(
      writer.page.getByRole('heading', { level: 1, name: title, exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    const thread = writer.page.url();
    const comment = `First reply ${randomUUID().slice(0, 6)}`;
    await typeByKeyboard(
      writer.page,
      writer.page.getByRole('textbox', { name: f.addComment, exact: true }),
      comment,
      found,
    );
    await activate(
      writer.page,
      writer.page.getByRole('button', { name: f.comment, exact: true }),
      found,
    );
    await expect(writer.page.getByRole('textbox', { name: f.addComment, exact: true })).toBeEmpty();
    await expect(writer.page.getByText(comment, { exact: true })).toBeVisible();
    const article = writer.page.getByRole('article').filter({ hasText: comment });
    await activate(writer.page, article.getByRole('button', { name: f.reply, exact: true }), found);
    const nested = `Nested reply ${randomUUID().slice(0, 6)}`;
    await typeByKeyboard(
      writer.page,
      article.getByRole('textbox', { name: f.replyTo({ name: writer.publicName }), exact: true }),
      nested,
      found,
    );
    await activate(
      writer.page,
      article.getByRole('button', { name: f.reply, exact: true }).last(),
      found,
    );
    await expect(
      article.getByRole('textbox', {
        name: f.replyTo({ name: writer.publicName }),
        exact: true,
      }),
    ).not.toBeVisible();
    await expect(writer.page.getByText(nested, { exact: true })).toBeVisible();
    await writer.page.reload();
    await expect(writer.page.getByText(nested, { exact: true })).toBeVisible();
    await page.goto(thread);
    await readerText(page, body, locale, found);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
    // A failed suitability lookup offers a real retry; it never authorizes showing the body.
    for (const text of [body, comment, nested]) await readerText(page, text, locale, found);
  }
  expectClean(found);
});

test('realm-ranking: a reader votes and reloads Best, New and Top with each time window in English and Japanese', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(600_000);
  const found: Findings = [];
  const manager = await managerSession(page);
  const realm = await createRealm(
    manager.api,
    manager.actor,
    manager.principalId,
    `Ranking Circle ${randomUUID().slice(0, 8)}`,
  );
  const work = await createPublicWork(
    manager.api,
    manager.actor,
    manager.principalId,
    `Ranking Work ${randomUUID().slice(0, 8)}`,
  );
  const titles = ['Earlier', 'Popular', 'Latest'].map(
    (label) => `${label} ${randomUUID().slice(0, 6)}`,
  );
  for (const title of titles)
    await seedThread(
      manager.api,
      realm.realm,
      work,
      manager.actor,
      manager.principalId,
      title,
      'A discussion for the ranking.',
    );
  await waitForThreads(manager.api, realm.realm, manager.actor, titles);
  const voter = await participantFor(browser, info);
  recordApiFailures(voter.page);
  await grant(`work:read:${work.work}`, 'work.read', voter.principalId, voter.actor);
  for (const locale of [locales.latin, locales.cjk]) {
    const f = materializeData(await catalogs.feed[locale](), { locale });
    await voter.page.goto(realmHref(locale, realm.realm, 'discussions'));
    await expect(voter.page.locator('html')).toHaveAttribute('lang', locale);
    const feed = voter.page.getByRole('feed', { name: f.discussionsLabel, exact: true });
    const card = feed
      .getByRole('article')
      .filter({ has: voter.page.getByRole('heading', { name: titles[1]!, exact: true }) });
    const upvote = card.getByRole('button', { name: f.upvote, exact: true });
    if (locale === locales.latin) {
      const saved = voter.page.waitForResponse((response) =>
        /\/api\/main\/v1\/feed\/[0-9a-f-]{36}\/vote$/.test(new URL(response.url()).pathname),
      );
      await activate(voter.page, upvote, found);
      const response = await saved;
      expect(response.status(), await response.text()).toBe(200);
    }
    await expect(upvote).toHaveAttribute('aria-pressed', 'true');
    const best = [titles[1]!, titles[2]!, titles[0]!];
    const newest = [titles[2]!, titles[1]!, titles[0]!];
    const headings = feed.getByRole('heading', { level: 3 });
    await voter.page.reload();
    await expect(upvote).toHaveAttribute('aria-pressed', 'true');
    await expect(headings).toHaveText(best);
    await chooseMenu(voter.page, f.sortLabel, f.best, f.new, found);
    await expect(voter.page).toHaveURL((url) => url.searchParams.get('sort') === 'new');
    await voter.page.reload();
    await expect(headings).toHaveText(newest);
    await chooseMenu(voter.page, f.sortLabel, f.new, f.top, found);
    await expect(voter.page).toHaveURL((url) => url.searchParams.get('sort') === 'top');
    await voter.page.reload();
    await expect(headings).toHaveText(best);
    let current = f.week;
    for (const [window, label] of [
      ['month', f.month],
      ['all', f.allTime],
      ['week', f.week],
    ] as const) {
      await chooseMenu(voter.page, f.period, current, label, found);
      await expect(voter.page).toHaveURL((url) => (url.searchParams.get('t') ?? 'week') === window);
      await voter.page.reload();
      await expect(
        voter.page.getByRole('button', { name: `${f.period}: ${label}`, exact: true }),
      ).toBeVisible();
      await expect(headings).toHaveText(best);
      current = label;
    }
    await chooseMenu(voter.page, f.sortLabel, f.top, f.best, found);
    await voter.page.reload();
    await expect(headings).toHaveText(best);
    await keyboardReach(
      voter.page,
      card.getByRole('link', { name: titles[1]!, exact: true }),
      found,
      'ranked thread',
    );
    await capture(voter.page, info, `realm-ranking-${locale}`);
  }
  expectClean(found);
});
