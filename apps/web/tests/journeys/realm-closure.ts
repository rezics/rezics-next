import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { expect, test, type Page } from '@playwright/test';
import { localizedPath } from '../../i18n/locale.ts';
import { i18n } from '../../i18n/instance.ts';
import { realmHref } from '../../features/realm/route.ts';
import { realmHref as manageHref } from '../../features/manage/routes.ts';
import { parseAddressSegment, resourceHref } from '../../features/address/path.ts';
import { mediaMessages } from '../../features/document-editor/media-messages.ts';
import { command, imageDocument, realmClosureFixture, short } from '../realm-closure-fixture.ts';
import { expectClean, type Findings, keyboardReach, motionRunning, pressByKeyboard } from '../g-743-matrix.ts';

test.use({ actionTimeout: 15_000 });

async function loadedImage(page: Page, alt: string) {
  const image = page.getByRole('img', { name: alt, exact: true });
  await expect(image).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0),
    { timeout: 30_000 }).toBe(true);
}

export function registerRealmClosureJourney() {
for (const locale of ['en', 'ja'] as const) {
  test(`realm-closure-notifications: a recipient reloads a concealed reply notice and keeps the independent notice (${locale})`, async ({ browser }, info) => {
    test.setTimeout(360_000);
    const fixture = await realmClosureFixture(browser, info);
    const found: Findings = [];
    try {
      const { owner, closed, live } = fixture;
      const target = await fixture.work(`Notification original ${randomUUID().slice(0, 8)}`);
      const independent = await fixture.work(`Independent notification original ${randomUUID().slice(0, 8)}`);
      await fixture.publish(target, fromPlainText('An independent original remains available.'));
      await fixture.publish(independent, fromPlainText('This original belongs to the live discussion.'));
      // Watches require a real existing thread placement, then a different author supplies both notices.
      await fixture.reply(closed, target, 'Initial closure thread.');
      await fixture.reply(live, independent, 'Initial independent thread.');
      for (const work of [target, independent]) await command(owner.page, 'POST', '/me/watches', {
        target: work.work, kind: 'thread', level: 'all', actingSubject: owner.actor, expectedRevision: null });
      const closedText = `Closed reply ${randomUUID()}`, liveText = `Independent reply ${randomUUID()}`;
      const closedReply = await fixture.reply(closed, target, closedText);
      const liveReply = await fixture.reply(live, independent, liveText);
      await expect.poll(async () => {
        const inbox = await command<{ items: { subject: { ref: string } | null }[] }>(owner.page, 'GET', '/me/notifications');
        return [closedReply, liveReply].every(reply => inbox.items.some(item => item.subject?.ref === reply));
      }, { timeout: 45_000 }).toBe(true);
      const page = owner.page;
      const path = localizedPath('/notifications', locale);
      await page.goto(path);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.getByText(closedText, { exact: true })).toBeVisible();
      await expect(page.getByText(liveText, { exact: true })).toBeVisible();
      const liveNotice = page.getByRole('listitem').filter({ hasText: liveText });
      await keyboardReach(page, liveNotice.getByRole('link').first(), found, 'independent reply notice');
      await page.screenshot({ path: info.outputPath(`notifications-open-${locale}.png`) });

      await fixture.restrict();
      await page.reload();
      await expect(page.getByText(liveText, { exact: true })).toBeVisible();
      await expect(page.getByText(closedText, { exact: true })).toHaveCount(0);
      await expect(page.getByRole('main')).not.toContainText(closed.name);
      // Concealed retained items must carry no link; an omitted item is also a valid disclosure answer.
      const inbox = await command<{ items: { subject: { ref: string } | null; display: unknown }[] }>(page, 'GET', '/me/notifications');
      expect(inbox.items.some(item => item.subject?.ref === closedReply)).toBe(false);
      await page.screenshot({ path: info.outputPath(`notifications-closed-${locale}.png`) });
      await pressByKeyboard(page, liveNotice.getByRole('link').first(), found, 'open independent Realm notice');
      // Predicate URL matchers also wait for document load; assert the committed navigation before waiting for its UI.
      await expect.poll(() => {
        const url = new URL(page.url());
        const ref = parseAddressSegment(decodeURIComponent(url.pathname.split('/')[3] ?? ''));
        return ref !== null && ref.kind !== 'alias' && [short(live.realm), short(live.space)].includes(ref.id);
      }, { timeout: 60_000 }).toBe(true);
      await expect(page.getByRole('main')).toContainText(live.name, { timeout: 30_000 });
      await page.reload();
      await expect(page.getByRole('main')).toContainText(live.name);
      expect(await motionRunning(page)).toEqual([]);
      expectClean(found);
    } finally { await fixture.close(); }
  });

  test(`realm-closure-media: a reader reloads reply-backed art as unavailable while independent art survives, then sees restoration (${locale})`, async ({ browser }, info) => {
    test.setTimeout(360_000);
    const fixture = await realmClosureFixture(browser, info);
    try {
      const target = await fixture.work(`Illustrated original ${randomUUID().slice(0, 8)}`);
      const reply = await fixture.reply(fixture.closed, target, 'The Realm owns this image occurrence.');
      const closedImage = await fixture.image(reply, fixture.closed.realm);
      const independentImage = await fixture.image(target.work, 'urn:rezics:context:global');
      await fixture.publish(target, imageDocument(target.title, [
        { ...closedImage, alt: 'Realm reply art' }, { ...independentImage, alt: 'Independent original art' },
      ]));
      const page = fixture.owner.page;
      await page.goto(localizedPath(resourceHref('/w/', short(target.work)), locale));
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      const found: Findings = [];
      const read = page.locator('a[data-next-action][href*="/read"]:visible').first();
      await expect(read).toBeVisible();
      await pressByKeyboard(page, read, found, 'read the illustrated Work');
      await expect.poll(() => new URL(page.url()).pathname.endsWith('/read'), { timeout: 60_000 }).toBe(true);
      await loadedImage(page, 'Realm reply art');
      await loadedImage(page, 'Independent original art');
      await page.screenshot({ path: info.outputPath(`media-open-${locale}.png`) });
      await fixture.restrict();
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: target.title, exact: true })).toBeVisible();
      await expect(page.getByRole('img', { name: 'Realm reply art', exact: true })).toHaveCount(0);
      await expect(page.locator('[data-slot="media-image-placeholder"]')).toHaveText(mediaMessages[locale].unavailable);
      await loadedImage(page, 'Independent original art');
      // The browser's real byte request also refuses a retained URL, rather than relying on a UI mask.
      const bytes = await page.request.get(`/api/main/v1/media/uses/${closedImage.use}`);
      expect(bytes.status(), await bytes.text()).toBe(404);
      await page.screenshot({ path: info.outputPath(`media-closed-${locale}.png`) });
      await fixture.restore();
      await page.reload();
      await loadedImage(page, 'Realm reply art');
      await loadedImage(page, 'Independent original art');
      await page.screenshot({ path: info.outputPath(`media-restored-${locale}.png`) });
      expect(await motionRunning(page)).toEqual([]);
      expectClean(found);
    } finally { await fixture.close(); }
  });

  test(`realm-closure-roster: a founder and listed member reload concealed public and management rosters, then recover unchanged membership (${locale})`, async ({ browser }, info) => {
    test.setTimeout(360_000);
    const fixture = await realmClosureFixture(browser, info);
    const found: Findings = [];
    try {
      const { owner, writer, closed, live } = fixture;
      const { t: realm } = await i18n.getTranslation('realm', [locale]);
      const { t: manage } = await i18n.getTranslation('manage', [locale]);
      const publicPath = realmHref(locale, closed.realm, 'members');
      const managementPath = localizedPath(manageHref(short(closed.realm), 'members'), locale);
      await writer.page.goto(publicPath);
      const publicRoster = writer.page.getByRole('region', { name: realm.membersTitle });
      await expect(publicRoster.getByRole('link', { name: writer.name, exact: true })).toBeVisible();
      await keyboardReach(writer.page, publicRoster.getByRole('link', { name: writer.name, exact: true }), found, 'listed member');
      await owner.page.goto(managementPath);
      const members = owner.page.getByRole('list', { name: manage.membersTitle });
      await expect(members).toContainText(writer.name);
      await owner.page.screenshot({ path: info.outputPath(`roster-open-${locale}.png`) });
      await fixture.restrict();
      await writer.page.reload();
      await expect(writer.page.locator('html')).toHaveAttribute('lang', locale);
      await expect(writer.page.getByRole('heading', { name: realm.notFoundTitle, exact: true })).toBeVisible();
      await expect(publicRoster).toHaveCount(0);
      await expect(writer.page.getByRole('main')).not.toContainText(writer.name);
      await owner.page.reload();
      const memberRequest = `/api/main/v1/realms/${short(closed.realm)}/members?actingSubject=${encodeURIComponent(owner.actor)}`;
      const memberAnswer = await owner.page.request.get(memberRequest);
      const memberBody = await memberAnswer.text();
      await info.attach('closed-management-roster-request', { contentType: 'application/json',
        body: JSON.stringify({ method: 'GET', path: memberRequest, status: memberAnswer.status(), body: memberBody }) });
      expect(memberAnswer.status(), `GET ${memberRequest}\nHTTP ${memberAnswer.status()}: ${memberBody}`).toBe(404);
      await expect(owner.page.getByRole('heading', { name: manage.missingTitle, exact: true })).toBeVisible();
      await expect(members).toHaveCount(0);
      await expect(owner.page.getByRole('main')).not.toContainText(writer.name);
      await expect(owner.page.getByRole('button', { name: manage.loadMore, exact: true })).toHaveCount(0);
      await owner.page.screenshot({ path: info.outputPath(`roster-closed-${locale}.png`) });
      await writer.page.goto(realmHref(locale, live.realm, 'members'));
      await expect(writer.page.getByRole('region', { name: realm.membersTitle })).toContainText(writer.name);
      await fixture.restore();
      await writer.page.goto(publicPath);
      await writer.page.reload();
      await expect(publicRoster.getByRole('link', { name: writer.name, exact: true })).toBeVisible();
      await owner.page.reload();
      await expect(members).toContainText(writer.name);
      await owner.page.screenshot({ path: info.outputPath(`roster-restored-${locale}.png`) });
      expectClean(found);
    } finally { await fixture.close(); }
  });
}
}
