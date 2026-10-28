import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import data from './fixtures/web-personal.json';
import type {
  AuthVisit,
  PersonalFixture,
  Persona,
  Surface,
  Target,
  Visit,
  WebPersonalDriver,
} from './web-personal-driver';

setDefaultTimeout(180_000);
let driver: WebPersonalDriver;
let fixture: PersonalFixture;
let current: WebPersonalDriver | undefined;
beforeEach(async () => {
  const location = process.env.WEB_PERSONAL_DRIVER;
  if (!location) throw new Error('Web personal driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:')) {
    throw new Error('WEB_PERSONAL_DRIVER must be an absolute path or file URL');
  }
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('Web personal driver must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createWebPersonalDriver !== 'function') {
    throw new Error('Web personal driver must export createWebPersonalDriver');
  }
  current = driver = await binding.createWebPersonalDriver();
  fixture = await driver.provision(data);
  expect(fixture.definitionsVersion.length).toBeGreaterThan(0);
});
afterEach(async () => {
  const closing = current;
  current = undefined;
  await closing?.close();
});

const subject = (key: string) => {
  const value = fixture.subjects[key];
  if (!value) throw new Error(`Missing native fixture subject: ${key}`);
  return value;
};
const book = () => subject(data.personal.book).id;
const recipe = () => subject(data.personal.recipe).id;
const target = (surface: Surface): Target => ({
  kind: 'members',
  surface,
  limit: data.members.pageLimit,
  ...(surface === 'state' ? { state: fixture.choices.bookState } : {}),
});
const ids = (keys: string[]) => keys.map((key) => subject(key).id).sort();
const sorted = (values: string[]) => [...values].sort();
const success = (response: Response) => expect([200, 201, 202, 204, 303]).toContain(response.status);
function useful(visit: Visit) {
  expect(visit.response.status).toBe(200);
  expect(visit.page.preparing).toBe(false);
  expect(visit.page.heading.length).toBeGreaterThan(0);
}
async function problem(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  expect(await response.clone().json()).toMatchObject({ status, code, effect_status: 'not_applied' });
}
function authReturn(result: AuthVisit, accountId: string | null) {
  useful(result);
  expect(new URL(result.page.url).origin).toBe(driver.origins.web);
  expect(result.page.signedInAccountId).toBe(accountId);
  expect(result.session.accountId).toBe(accountId);
  expect(result.visitedUrls.some((url) => new URL(url).origin === driver.origins.auth)).toBe(true);
  expect(new URL(result.visitedUrls.at(-1)!).origin).toBe(driver.origins.web);
  expect(result.responses.length).toBeGreaterThan(0);
  for (const response of result.responses) expect(response.status).toBeLessThan(400);
}
async function login(persona: 'alice' | 'bob' = 'alice') {
  const result = await driver.auth(persona, 'sign-in', target('library'));
  authReturn(result, fixture.accounts[persona]);
  expect(result.session.websiteConsent).toBe(true);
  return result;
}
async function track(key: string, state = fixture.choices.bookState) {
  await driver.visit('alice', { kind: 'subject', subjectId: subject(key).id });
  success((await driver.act('alice', { kind: 'track', subjectId: subject(key).id, state })).response);
}
async function personal() {
  await login();
  await track(data.personal.book);
  await track(data.personal.recipe, fixture.choices.recipeState);
  await driver.visit('alice', { kind: 'subject', subjectId: book() });
  success((await driver.act('alice', { kind: 'label', subjectId: book(), name: data.personal.privateLabel })).response);
  success(
    (
      await driver.act('alice', {
        kind: 'copy',
        subjectId: book(),
        copyKind: fixture.choices.copyKind,
        status: fixture.choices.copyStatus,
        note: data.personal.copyNote,
      })
    ).response,
  );
  success(
    (
      await driver.act('alice', {
        kind: 'progress',
        subjectId: book(),
        unit: fixture.choices.progressUnit,
        value: data.personal.progressValue,
        note: data.personal.progressNote,
      })
    ).response,
  );
}
async function populate() {
  await login();
  for (const key of data.members.keys) {
    await track(key, key === data.personal.recipe ? fixture.choices.recipeState : fixture.choices.bookState);
  }
}
async function publish() {
  await driver.visit('alice', target('collection'));
  success((await driver.act('alice', { kind: 'publish-collection' })).response);
  await driver.settle();
}
/** Follow only actual page links. A 200 empty prefix with a next link is a failure. */
async function members(persona: Persona, first: Visit, requireFilter = false) {
  const found: string[] = [];
  const visited = new Set<string>();
  let visit = first;
  let preparations = 0;
  let pages = 0;
  for (;;) {
    if (requireFilter) expect(visit.page.filterBarVisible).toBe(true);
    if (visit.page.preparing) {
      expect(visit.response.status).toBe(202);
      expect(visit.page.memberSubjectIds).toEqual([]);
      expect(visit.page.text).toMatch(/prepar|updat/i);
      expect(++preparations).toBeLessThanOrEqual(data.members.maxPreparingPolls);
      await driver.settle();
      visit = await driver.follow(persona, visit.page.url);
      continue;
    }
    useful(visit);
    expect(++pages).toBeLessThanOrEqual(data.members.maxPages);
    expect(visit.page.memberSubjectIds.length).toBeLessThanOrEqual(data.members.pageLimit);
    if (visit.page.nextHref) expect(visit.page.memberSubjectIds).toHaveLength(data.members.pageLimit);
    for (const id of visit.page.memberSubjectIds) {
      expect(found).not.toContain(id);
      found.push(id);
    }
    if (!visit.page.nextHref) break;
    expect(visited.has(visit.page.nextHref)).toBe(false);
    visited.add(visit.page.nextHref);
    visit = await driver.follow(persona, visit.page.nextHref);
  }
  return { ids: sorted(found), pages };
}
async function filtered(surface: Surface, persona: Persona) {
  const first = await driver.visit(persona, target(surface));
  expect(first.page.filterBarVisible).toBe(true);
  const result = await driver.act(persona, {
    kind: 'filter',
    type: 'schema:Book',
    wordCountGreaterThan: data.filter.wordCountGreaterThan,
    tagSubjectId: subject(data.filter.tag).id,
  });
  const page = await members(persona, result, true);
  expect(page.ids).toEqual(ids(data.filter.expectedKeys));
  expect(page.ids.length).toBeGreaterThan(0);
}
async function checkout() {
  await login();
  const offer = await driver.visit('alice', { kind: 'offer', offerId: fixture.offerId });
  useful(offer);
  expect(offer.page.text).toContain(data.commerce.title);
  expect((await driver.facts('alice')).orders).toEqual([]);
  success((await driver.act('alice', { kind: 'start-checkout' })).response);
  const orders = (await driver.facts('alice')).orders;
  expect(orders).toHaveLength(1);
  expect(orders[0]).toMatchObject({ offerId: fixture.offerId, settlement: 'pending', receiptId: null });
  return orders[0]!.id;
}

describe('library-surfaces', () => {
  test('Alice tracks a Book and a Recipe, sets a state, adds labels and a copy, and records progress through served pages', async () => {
    await personal();
    const facts = await driver.facts('alice');
    expect(facts.entries).toHaveLength(2);
    expect(facts.entries).toContainEqual({ subjectId: book(), state: fixture.choices.bookState });
    expect(facts.entries).toContainEqual({ subjectId: recipe(), state: fixture.choices.recipeState });
    expect(facts.labels).toEqual([{ subjectId: book(), name: data.personal.privateLabel }]);
    expect(facts.copies).toEqual([
      {
        subjectId: book(),
        kind: fixture.choices.copyKind,
        status: fixture.choices.copyStatus,
        note: data.personal.copyNote,
      },
    ]);
    expect(facts.progress).toEqual([
      {
        subjectId: book(),
        unit: fixture.choices.progressUnit,
        value: data.personal.progressValue,
        note: data.personal.progressNote,
      },
    ]);
    const page = await driver.visit('alice', { kind: 'subject', subjectId: book() });
    useful(page);
    expect(page.page.personal).toEqual({
      state: fixture.choices.bookState,
      labels: [data.personal.privateLabel],
      copies: 1,
      progress: data.personal.progressValue,
    });
  });

  test('Alice library page lists exactly the native entries across real pagination', async () => {
    await populate();
    const native = (await driver.facts('alice')).entries.map((entry) => entry.subjectId);
    expect(sorted(native)).toEqual(ids(data.members.keys));
    const result = await members('alice', await driver.visit('alice', target('library')));
    expect(result.ids).toEqual(sorted(native));
    expect(result.pages).toBeGreaterThan(1);
  });

  test('Alice state filter lists exactly the native entries in the selected state', async () => {
    await personal();
    expect(fixture.choices.otherBookState).not.toBe(fixture.choices.bookState);
    await track('B-edge', fixture.choices.otherBookState);
    const expected = (await driver.facts('alice')).entries
      .filter((entry) => entry.state === fixture.choices.bookState)
      .map((entry) => entry.subjectId);
    expect(expected).toContain(book());
    const result = await members('alice', await driver.visit('alice', target('state')));
    expect(result.ids).toEqual(sorted(expected));
    expect(result.ids).not.toContain(subject('B-edge').id);
  });

  test('Alice curated Collection page shows exactly its native members to her and once public to anonymous', async () => {
    await login();
    const native = (await driver.facts('alice')).collectionMembers;
    expect(sorted(native)).toEqual(ids(data.members.keys));
    expect((await members('alice', await driver.visit('alice', target('collection')))).ids).toEqual(sorted(native));
    const hidden = await driver.visit('anonymous', target('collection'));
    expect([403, 404]).toContain(hidden.response.status);
    expect(hidden.page.memberSubjectIds).toEqual([]);
    await publish();
    expect((await members('anonymous', await driver.visit('anonymous', target('collection')))).ids).toEqual(
      sorted(native),
    );
  });

  test('a member of a mounted Zone Collection appears on the served Zone page', async () => {
    const native = (await driver.facts('alice')).zoneMembers;
    expect(sorted(native)).toEqual(ids(data.members.keys));
    const result = await members('anonymous', await driver.visit('anonymous', target('zone')));
    expect(result.ids).toEqual(sorted(native));
    expect(result.ids).toContain(book());
  });

  test('the library members filter bar returns exactly books over 1,000,000 words tagged harem', async () => {
    await populate();
    await filtered('library', 'alice');
  });

  test('the state members filter bar returns exactly books over 1,000,000 words tagged harem', async () => {
    await populate();
    await filtered('state', 'alice');
  });

  test('the curated Collection members filter bar returns exactly books over 1,000,000 words tagged harem for owner and public reader', async () => {
    await login();
    await filtered('collection', 'alice');
    await publish();
    await filtered('collection', 'anonymous');
  });

  test('the mounted Zone members filter bar returns exactly books over 1,000,000 words tagged harem', async () => {
    await filtered('zone', 'anonymous');
  });

  test('Bob sees none of Alice private library state labels copies or progress', async () => {
    await personal();
    await login('bob');
    await driver.visit('bob', { kind: 'subject', subjectId: recipe() });
    success((await driver.act('bob', { kind: 'label', subjectId: recipe(), name: data.personal.bobLabel })).response);
    for (const key of [data.personal.book, data.personal.recipe]) {
      const page = await driver.visit('bob', { kind: 'subject', subjectId: subject(key).id });
      useful(page);
      expect(page.page.personal).toEqual({
        state: null,
        labels: key === data.personal.recipe ? [data.personal.bobLabel] : [],
        copies: 0,
        progress: null,
      });
      for (const secret of [data.personal.privateLabel, data.personal.copyNote, data.personal.progressNote]) {
        expect(page.page.text).not.toContain(secret);
        expect(await page.response.clone().text()).not.toContain(secret);
      }
    }
    const bob = await driver.facts('bob');
    expect(bob.entries).toEqual([]);
    expect(bob.copies).toEqual([]);
    expect(bob.progress).toEqual([]);
    expect((await members('bob', await driver.visit('bob', target('library')))).ids).toEqual([recipe()]);
    const hidden = await driver.visit('bob', target('collection'));
    expect([403, 404]).toContain(hidden.response.status);
    expect(hidden.page.memberSubjectIds).toEqual([]);
  });
});

describe('session-transport', () => {
  test('every personal BFF read and write carries Alice identity and current authority', async () => {
    await login();
    await driver.transport();
    await personal();
    const page = await driver.visit('alice', { kind: 'subject', subjectId: book() });
    useful(page);
    expect(page.page.personal.state).toBe(fixture.choices.bookState);
    const requests = (await driver.transport()).requests;
    const personalRequests = requests.filter((request) => /library|progress|copies/i.test(request.path));
    expect(personalRequests.some((request) => request.method === 'GET')).toBe(true);
    expect(personalRequests.some((request) => request.method !== 'GET')).toBe(true);
    for (const request of personalRequests) {
      expect(request).toMatchObject({ actorId: fixture.accounts.alice, authenticated: true, authorized: true });
    }
    expect((await driver.facts('alice')).entries).toContainEqual({
      subjectId: book(),
      state: fixture.choices.bookState,
    });
    expect((await driver.facts('bob')).entries).toEqual([]);
  });

  test('a revoked session stops personal access at the next BFF request', async () => {
    await personal();
    const before = await driver.facts('alice');
    success(await driver.revokeSession('alice'));
    await driver.transport();
    const page = await driver.visit('alice', target('library'));
    expect(page.page.signedInAccountId).toBeNull();
    expect(page.page.memberSubjectIds).toEqual([]);
    expect([200, 302, 303, 401]).toContain(page.response.status);
    if (page.response.status === 200) expect(page.page.text).toMatch(/sign in/i);
    const write = await driver.act('alice', { kind: 'label', subjectId: book(), name: 'revoked write' });
    expect([302, 303, 401]).toContain(write.response.status);
    expect(await driver.facts('alice')).toEqual(before);
    for (const request of (await driver.transport()).requests) expect(request.authorized).toBe(false);
  });

  test('a valid suspended session gets 403 account_suspended on the next personal read and write', async () => {
    await personal();
    const before = await driver.facts('alice');
    success(await driver.suspend('alice'));
    await problem((await driver.visit('alice', target('library'))).response, 403, 'account_suspended');
    await problem(
      (await driver.act('alice', { kind: 'label', subjectId: book(), name: 'suspended write' })).response,
      403,
      'account_suspended',
    );
    expect(await driver.facts('alice')).toEqual(before);
  });

  test('an image upload completes through the BFF and is attached to the native thread', async () => {
    await login();
    await driver.visit('alice', { kind: 'thread', threadId: fixture.protected.threadId });
    const result = await driver.act('alice', {
      kind: 'upload-and-attach',
      threadId: fixture.protected.threadId,
      image: fixture.image,
      text: data.media.body,
    });
    success(result.response);
    const media = (await driver.facts('alice')).media;
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({
      complete: true,
      attachedThreadId: fixture.protected.threadId,
      sha256: createHash('sha256').update(fixture.image.bytes).digest('hex'),
    });
    const page = await driver.visit('alice', { kind: 'thread', threadId: fixture.protected.threadId });
    useful(page);
    expect(page.page.text).toContain(data.media.body);
    const download = await driver.download('alice', media[0]!.downloadHref);
    expect(download.status).toBe(200);
    expect([...new Uint8Array(await download.arrayBuffer())]).toEqual([...fixture.image.bytes]);
  });

  test('a private media download is refused to Bob even when he knows the exact URL', async () => {
    await login();
    await driver.visit('alice', { kind: 'thread', threadId: fixture.protected.threadId });
    success(
      (
        await driver.act('alice', {
          kind: 'upload-and-attach',
          threadId: fixture.protected.threadId,
          image: fixture.image,
          text: data.media.body,
        })
      ).response,
    );
    const media = (await driver.facts('alice')).media;
    expect(media).toHaveLength(1);
    expect((await driver.download('alice', media[0]!.downloadHref)).status).toBe(200);
    await login('bob');
    const denied = await driver.download('bob', media[0]!.downloadHref);
    expect([403, 404]).toContain(denied.status);
    expect(denied.headers.get('content-type')).not.toContain('image/');
    expect([...new Uint8Array(await denied.clone().arrayBuffer())]).not.toEqual([...fixture.image.bytes]);
  });

  test('a banned author write is refused even with an independent read grant', async () => {
    await login();
    success(await driver.grantIndependentRead('alice'));
    useful(await driver.visit('alice', { kind: 'thread', threadId: fixture.protected.threadId }));
    const before = (await driver.facts('alice')).posts;
    success(await driver.ban('alice'));
    // No settle: the ban wins immediately, including while membership removal is queued.
    const result = await driver.act('alice', {
      kind: 'reply',
      threadId: fixture.protected.threadId,
      text: data.ban.reply,
    });
    expect([403, 404]).toContain(result.response.status);
    expect((await driver.facts('alice')).posts).toEqual(before);
    const read = await driver.visit('alice', { kind: 'thread', threadId: fixture.protected.threadId });
    expect([403, 404]).toContain(read.response.status);
    expect(read.page.text).not.toContain(data.ban.reply);
  });
});

describe('auth-journeys', () => {
  test('sign-up through the served Auth app returns to the requested web page with a new session', async () => {
    const result = await driver.auth('newcomer', 'sign-up', target('library'));
    useful(result);
    expect(result.session.accountId).toBeTruthy();
    expect([fixture.accounts.alice, fixture.accounts.bob]).not.toContain(result.session.accountId);
    authReturn(result, result.session.accountId);
    expect(result.session.websiteConsent).toBe(true);
    expect(new URL(result.page.url).pathname).toMatch(/library/);
    expect(result.page.memberSubjectIds).toEqual([]);
    expect((await driver.facts('newcomer')).entries).toEqual([]);
  });

  test('sign-in through the served Auth app returns to the requested web page with Alice session', async () => {
    const result = await login();
    expect(new URL(result.page.url).pathname).toMatch(/library/);
    const again = await driver.visit('alice', target('library'));
    useful(again);
    expect(again.page.signedInAccountId).toBe(fixture.accounts.alice);
  });

  test('website client consent through the served Auth app returns to web with the consented session', async () => {
    // Review the website client explicitly, preserving its standing first-party consent.
    const result = await driver.auth('alice', 'consent', target('library'));
    authReturn(result, fixture.accounts.alice);
    expect(
      result.visitedUrls.some(
        (url) => new URL(url).origin === driver.origins.auth && /consent/.test(new URL(url).pathname),
      ),
    ).toBe(true);
    expect(result.session.websiteConsent).toBe(true);
    expect(new URL(result.page.url).pathname).toMatch(/library/);
    await track(data.personal.book);
    expect((await driver.facts('alice')).entries).toContainEqual({
      subjectId: book(),
      state: fixture.choices.bookState,
    });
  });

  test('step-up through the served Auth app returns to the web security setting with fresh authentication', async () => {
    await login();
    await driver.ageAuthentication(601);
    const security: Target = { kind: 'security' };
    await driver.visit('alice', security);
    const blocked = await driver.act('alice', { kind: 'change-security-setting' });
    expect(blocked.page.security.stepUpRequired).toBe(true);
    expect((await driver.facts('alice')).securitySettingChanged).toBe(false);
    const stepped = await driver.auth('alice', 'step-up', security);
    authReturn(stepped, fixture.accounts.alice);
    expect(new URL(stepped.page.url).pathname).toMatch(/security/);
    expect(stepped.session.freshAuthentication).toBe(true);
    const changed = await driver.act('alice', { kind: 'change-security-setting' });
    success(changed.response);
    expect(changed.page.security.changed).toBe(true);
    expect((await driver.facts('alice')).securitySettingChanged).toBe(true);
  });

  test('sign-out through the served Auth app returns to web with no personal session', async () => {
    await personal();
    const result = await driver.auth('alice', 'sign-out', { kind: 'subject', subjectId: book() });
    authReturn(result, null);
    expect(new URL(result.page.url).pathname).toContain(book());
    const page = await driver.visit('alice', { kind: 'subject', subjectId: book() });
    useful(page);
    expect(page.page.signedInAccountId).toBeNull();
    expect(page.page.personal).toEqual({ state: null, labels: [], copies: 0, progress: null });
    expect(page.page.text).not.toContain(data.personal.privateLabel);
  });
});

describe('checkout-journey', () => {
  test('Alice returns before settlement to a pending order then sees the paid order receipt and entitlement after native settlement', async () => {
    const orderId = await checkout();
    const returnTo: Target = { kind: 'order', orderId, checkoutReturn: true };
    const pending = await driver.visit('alice', returnTo);
    useful(pending);
    expect(pending.page.order).toEqual({
      id: orderId,
      settlement: 'pending',
      receiptHref: null,
      entitlementVisible: false,
    });
    expect(pending.page.text).toMatch(/pending|processing|awaiting/i);
    expect(pending.page.text).not.toMatch(/fulfilled|payment received/i);
    expect((await driver.facts('alice')).entitlements).toEqual([]);
    // A forged success query/return visit cannot create a receipt or grant.
    const again = await driver.visit('alice', returnTo);
    expect(again.page.order?.settlement).toBe('pending');
    expect((await driver.facts('alice')).orders[0]?.receiptId).toBeNull();
    await driver.payment(orderId, 'paid');
    await driver.settle();
    const paid = await driver.visit('alice', returnTo);
    useful(paid);
    expect(paid.page.order).toMatchObject({ id: orderId, settlement: 'paid', entitlementVisible: true });
    expect(paid.page.order?.receiptHref).toBeTruthy();
    const receipt = await driver.download('alice', paid.page.order!.receiptHref!);
    expect(receipt.status).toBe(200);
    expect((await receipt.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const facts = await driver.facts('alice');
    expect(facts.orders).toHaveLength(1);
    expect(facts.orders[0]).toMatchObject({ id: orderId, settlement: 'paid' });
    expect(facts.orders[0]?.receiptId).toBeTruthy();
    expect(facts.entitlements).toEqual([{ targetId: fixture.entitlementTarget, orderId }]);
    expect((await driver.facts('bob')).entitlements).toEqual([]);
  });

  test('a failed payment shows a failed order and grants nothing', async () => {
    const orderId = await checkout();
    await driver.payment(orderId, 'failed');
    await driver.settle();
    const page = await driver.visit('alice', { kind: 'order', orderId, checkoutReturn: true });
    useful(page);
    expect(page.page.order).toEqual({
      id: orderId,
      settlement: 'failed',
      receiptHref: null,
      entitlementVisible: false,
    });
    expect(page.page.text).toMatch(/failed|declined|unsuccessful/i);
    const facts = await driver.facts('alice');
    expect(facts.orders).toHaveLength(1);
    expect(facts.orders[0]).toMatchObject({ id: orderId, settlement: 'failed', receiptId: null });
    expect(facts.entitlements).toEqual([]);
  });
});
