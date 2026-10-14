import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { localizedPath } from '../i18n/locale.ts';
import { realmHref as communityHref } from '../features/realm/route.ts';
import { realmHref as manageHref } from '../features/manage/routes.ts';
import { realmNavigationDiagnostics } from './realm-navigation-diagnostics.ts';
import {
  choosePublicModerator, closeParticipant, createPublicWork, createRealm, grant,
  grantRealmManager, idOf, joinRealm, letMemberDraft, managerSession, participantFor,
  seedThread, waitForThreads, waitForWorkTypeahead,
} from './realm-community-fixture.ts';

test.afterAll(closeParticipant);

async function visibleThreadTitles(page: Page): Promise<string[]> {
  return page.getByRole('feed', { name: 'Discussions' }).getByRole('heading', { level: 3 }).allTextContents();
}

async function chooseSort(page: Page, current: 'Best' | 'New' | 'Top', next: 'Best' | 'New' | 'Top') {
  const trigger = page.getByRole('button', { name: `Sort: ${current}`, exact: true });
  await waitForReactHandler(trigger);
  await trigger.click();
  const choice = page.getByRole('menuitemradio', { name: new RegExp(`^${next}\\b`) });
  await waitForReactHandler(choice);
  await choice.click();
  await expect(page.getByRole('button', { name: `Sort: ${next}`, exact: true })).toBeVisible();
}

async function waitForReactHandler(control: Locator) {
  await expect.poll(() => control.evaluate(element => Object.keys(element)
    .some(key => key.startsWith('__reactProps$'))), { timeout: 15_000 }).toBe(true);
}

test('a manager creates a role, assigns it to a member, and sees the public team after reload', async ({ page, browser }, info) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  const manager = await managerSession(page);
  const realm = await createRealm(manager.api, manager.actor, manager.principalId, `Role Circle ${randomUUID().slice(0, 8)}`);
  await grantRealmManager(realm.realm, manager.actor, manager.principalId);
  const member = await participantFor(browser, info);
  await joinRealm(member.page, realm.realm);
  const roleName = `Conversation guides ${randomUUID().slice(0, 6)}`;
  await grant(`realm:profile:${realm.realm}`, 'realm.profile.publish', manager.principalId, manager.actor);
  await grant(`realm:moderator-choice:${idOf(realm.realm)}:${idOf(member.actor)}`,
    'realm.moderator.choose', member.principalId, member.actor);
  await choosePublicModerator(member, realm.realm, info);
  await manager.api.write(`/realms/${idOf(realm.realm)}/profile`, {
    profile: 'realm-public-profile-v2', expectedHead: null, actingSubject: manager.actor,
    publication: {
      name: { original: 'en', labels: { en: realm.name, 'zh-Hans': realm.name, 'zh-Hant': realm.name, ja: realm.name } },
      description: { original: 'en', labels: { en: 'A circle for conversation.', 'zh-Hans': '交流读者的社区。',
        'zh-Hant': '交流讀者的社群。', ja: '読者の会話の場です。' } },
      iconSelection: null, bannerSelection: null, count: { kind: 'unknown', value: null },
      moderators: [member.actor],
    },
  }, 'PUT');

  await page.goto(localizedPath(manageHref(realm.id, 'roles'), 'en'));
  await expect(page.getByRole('heading', { name: 'Roles', exact: true })).toBeVisible();
  const newRole = page.getByRole('button', { name: 'New role', exact: true });
  await waitForReactHandler(newRole);
  await newRole.click();
  const roleDialog = page.getByRole('dialog');
  await expect(roleDialog.getByRole('heading', { name: 'New role', exact: true })).toBeVisible();
  await roleDialog.getByRole('textbox', { name: 'Role name' }).fill(roleName);
  await roleDialog.getByRole('checkbox', { name: 'Moderate the queue' }).click();
  await roleDialog.getByRole('textbox', { name: 'Reason' }).fill('Share moderation with a trusted member.');
  await roleDialog.getByRole('button', { name: 'Create role', exact: true }).click();
  await expect(page.getByRole('heading', { name: roleName, exact: true })).toBeVisible();

  await page.goto(localizedPath(manageHref(realm.id, 'members'), 'en'));
  const memberSearch = page.getByRole('search', { name: 'Search members' });
  await memberSearch.getByRole('searchbox').fill(member.publicName);
  await memberSearch.getByRole('button', { name: 'Search', exact: true }).click();
  const members = page.getByRole('list', { name: 'Members' });
  const row = members.getByRole('listitem').filter({ hasText: member.publicName });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: `Actions for ${member.publicName}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Give a role…', exact: true }).click();
  const assignDialog = page.getByRole('dialog');
  await expect(assignDialog.getByRole('heading', { name: `Give ${member.publicName} a role`, exact: true })).toBeVisible();
  await assignDialog.getByRole('combobox', { name: 'Role' }).click();
  await page.getByRole('option', { name: roleName, exact: true }).click();
  await assignDialog.getByRole('textbox', { name: 'Reason' }).fill('Assign the new moderation role.');
  await assignDialog.getByRole('button', { name: 'Give role', exact: true }).click();
  await expect(row.getByText(roleName, { exact: true })).toBeVisible();

  await page.reload();
  await memberSearch.getByRole('searchbox').fill(member.publicName);
  await memberSearch.getByRole('button', { name: 'Search', exact: true }).click();
  const afterReload = page.getByRole('list', { name: 'Members' }).getByRole('listitem').filter({ hasText: member.publicName });
  await expect(afterReload.getByText(roleName, { exact: true })).toBeVisible();

  await member.page.reload();
  await member.page.goto(communityHref('en', realm.realm, 'about'));
  const team = member.page.getByRole('region', { name: 'Moderators' });
  await expect(team.getByRole('link', { name: member.publicName, exact: true })).toBeVisible();
});

test('a member opens a thread and nested replies that another person sees after reload', async ({ page, browser }, info) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  const manager = await managerSession(page);
  const finishDiagnostics = await realmNavigationDiagnostics(page, info, 'thread-fixture');
  try {
    const realm = await createRealm(manager.api, manager.actor, manager.principalId, `Thread Circle ${randomUUID().slice(0, 8)}`);
    const work = await createPublicWork(manager.api, manager.actor, manager.principalId, `Conversation Work ${randomUUID().slice(0, 8)}`);
    await waitForWorkTypeahead(manager.api, work);
    const writer = await participantFor(browser, info);
    await grant(`work:read:${work.work}`, 'work.read', writer.principalId, writer.actor);
    await grant(`reply:create:${work.work}`, 'reply.create', writer.principalId, writer.actor);
    await grant(`reply:place:${realm.realm}`, 'reply.place', writer.principalId, writer.actor);
    await letMemberDraft(writer.page, writer.actor, writer.principalId);
    await joinRealm(writer.page, realm.realm);
    await writer.page.goto(communityHref('en', realm.realm, 'discussions'));
    await writer.page.getByRole('link', { name: 'Create post', exact: true }).click();
    const workSearch = writer.page.getByRole('searchbox', { name: 'Search for a Work' });
    await waitForReactHandler(workSearch);
    await workSearch.fill(work.title);
    await expect(workSearch).toHaveValue(work.title);
    const workChoice = writer.page.getByRole('button', { name: work.title, exact: true });
    await expect(workChoice).toBeVisible();
    await workChoice.click();
    const title = `First conversation ${randomUUID().slice(0, 6)}`;
    const body = 'A member starts this discussion from the Realm.';
    await writer.page.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
    await writer.page.getByRole('textbox', { name: 'Your post', exact: true }).fill(body);
    await writer.page.getByRole('button', { name: 'Post', exact: true }).click();
    await expect(writer.page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible({ timeout: 60_000 });
    const threadUrl = writer.page.url();

    const firstReply = `A reader replies ${randomUUID().slice(0, 6)}.`;
    await writer.page.getByRole('textbox', { name: 'Add a comment' }).fill(firstReply);
    await writer.page.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(writer.page.getByText(firstReply, { exact: true })).toBeVisible();
    const firstArticle = writer.page.getByRole('article').filter({ hasText: firstReply });
    await firstArticle.getByRole('button', { name: 'Reply', exact: true }).click();
    const nested = `A nested reply ${randomUUID().slice(0, 6)}.`;
    const nestedBox = firstArticle.getByRole('textbox', { name: `Reply to ${writer.publicName}`, exact: true });
    await nestedBox.fill(nested);
    await firstArticle.getByRole('button', { name: 'Reply', exact: true }).last().click();
    await expect(writer.page.getByText(nested, { exact: true })).toBeVisible();

    await page.goto(threadUrl);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
    await expect(page.getByText(body, { exact: true })).toBeVisible();
    await expect(page.getByText(firstReply, { exact: true })).toBeVisible();
    await expect(page.getByText(nested, { exact: true })).toBeVisible();
  } finally { await finishDiagnostics(); }
});

test('Best, Top and New reorder every Realm discussion after a reader votes', async ({ page, browser }, info) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  const manager = await managerSession(page);
  const realm = await createRealm(manager.api, manager.actor, manager.principalId, `Ranking Circle ${randomUUID().slice(0, 8)}`);
  const work = await createPublicWork(manager.api, manager.actor, manager.principalId, `Ranking Work ${randomUUID().slice(0, 8)}`);
  const titles = {
    oldest: `Earlier post ${randomUUID().slice(0, 6)}`,
    voted: `Popular post ${randomUUID().slice(0, 6)}`,
    newest: `Latest post ${randomUUID().slice(0, 6)}`,
  };
  await seedThread(manager.api, realm.realm, work, manager.actor, manager.principalId, titles.oldest, 'An older API-seeded thread.');
  await new Promise(resolve => setTimeout(resolve, 120));
  await seedThread(manager.api, realm.realm, work, manager.actor, manager.principalId, titles.voted, 'This thread will receive a vote.');
  await new Promise(resolve => setTimeout(resolve, 120));
  await seedThread(manager.api, realm.realm, work, manager.actor, manager.principalId, titles.newest, 'A newer API-seeded thread.');
  await waitForThreads(manager.api, realm.realm, manager.actor, Object.values(titles));

  const voter = await participantFor(browser, info);
  const finishDiagnostics = await realmNavigationDiagnostics(voter.page, info, 'realm-sort');
  try {
    await grant(`work:read:${work.work}`, 'work.read', voter.principalId, voter.actor);
    await voter.page.goto(communityHref('en', realm.realm, 'discussions'));
    const feed = voter.page.getByRole('feed', { name: 'Discussions' });
    await expect(feed).toBeVisible();
    const votedCard = feed.getByRole('article').filter({ has: voter.page.getByRole('heading', { name: titles.voted, exact: true }) });
    const upvote = votedCard.getByRole('button', { name: 'Upvote', exact: true });
    await expect(upvote).toBeVisible();
    await waitForReactHandler(upvote);
    const savedVote = voter.page.waitForResponse(response =>
      new URL(response.url()).pathname.endsWith(`/feed/${idOf(realm.realm)}/vote`)
      || new URL(response.url()).pathname.match(/\/api\/main\/v1\/feed\/[0-9a-f-]{36}\/vote$/) !== null);
    await upvote.click();
    await expect(upvote).toHaveAttribute('aria-pressed', 'true');
    expect((await savedVote).status()).toBe(200);
    await voter.page.reload();

    const best = [titles.voted, titles.newest, titles.oldest];
    const newerFirst = [titles.newest, titles.voted, titles.oldest];
    await expect.poll(() => visibleThreadTitles(voter.page)).toEqual(best);
    await chooseSort(voter.page, 'Best', 'New');
    await expect.poll(() => visibleThreadTitles(voter.page)).toEqual(newerFirst);
    await chooseSort(voter.page, 'New', 'Top');
    await expect.poll(() => visibleThreadTitles(voter.page)).toEqual(best);
    expect(await visibleThreadTitles(voter.page)).toEqual(best);
  } finally { await finishDiagnostics(); }
});
