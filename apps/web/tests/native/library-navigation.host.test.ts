import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startAuthStack } from './auth-stack.ts';
import { createLibraryEntry, createLibraryNavigationFixture } from './library-navigation-fixture.ts';
import { startNativeWebStack } from './stack.ts';

let stack: Awaited<ReturnType<typeof startNativeWebStack>> | undefined;
let auth: Awaited<ReturnType<typeof startAuthStack>> | undefined;

beforeAll(async () => {
  stack = await startNativeWebStack();
  auth = await startAuthStack(stack);
}, 300_000);

afterAll(async () => {
  await auth?.stop();
  await stack?.stop();
}, 180_000);

test('Library follows a curated and real built-in Collection, and reloads the exact emitted destinations', async () => {
  const native = stack!;
  const authStack = auth!;
  const fixture = await createLibraryNavigationFixture(native);
  const journey = await authStack.signIn('bob');
  const page = journey.context.pages().at(-1)!;
  await page.goto(`${native.web}/en/library`, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor();
  await page.getByRole('link', { name: 'All Collections', exact: true }).waitFor();

  const ownerCollections = await native.kernel(
    `/v1/collections?curatorAccountId=${fixture.reader.accountId}&limit=100`,
    { headers: { authorization: fixture.reader.authorization } },
    'bob',
  );
  expect(ownerCollections.status).toBe(200);
  const body = (await ownerCollections.json()) as {
    collections: { id: string; title: string; builtinKind?: string }[];
  };
  const builtin = body.collections.find((item) => item.builtinKind === 'everything');
  expect(builtin, 'the activated native Collection read must return a real Everything record').toBeDefined();

  const memberPath = `/v1/collections/${builtin!.id}/members?limit=20`;
  const preparing = await native.kernel(
    memberPath,
    { headers: { authorization: fixture.reader.authorization } },
    'bob',
  );
  expect(preparing.status, 'a cold dynamic result reports retained preparation before it becomes ready').toBe(202);
  expect(preparing.headers.get('content-type')).toContain('application/json');
  expect(preparing.headers.get('cache-control')).toContain('private');
  expect(preparing.headers.get('cache-control')).toContain('no-store');
  expect(await preparing.json()).toEqual({ preparing: true });
  const retryAfter = Number(preparing.headers.get('retry-after'));
  expect(Number.isFinite(retryAfter) && retryAfter > 0, 'preparation gives a positive Retry-After').toBe(true);
  let dynamicMembers:
    | { members: { kind: string; subjectId: string; subject?: { label?: string } | null }[]; next: string | null }
    | undefined;
  const preparedBy = Date.now() + 60_000;
  while (Date.now() < preparedBy) {
    await Bun.sleep(Math.max(1, retryAfter * 1000));
    const response = await native.kernel(
      memberPath,
      { headers: { authorization: fixture.reader.authorization } },
      'bob',
    );
    if (response.status === 202) {
      expect(await response.json()).toEqual({ preparing: true });
      continue;
    }
    expect(response.status, 'retained preparation eventually serves its complete page').toBe(200);
    dynamicMembers = (await response.json()) as typeof dynamicMembers;
    break;
  }
  expect(dynamicMembers, 'the dynamic page becomes available within the bounded native receipt').toBeDefined();
  expect(dynamicMembers!.members).toContainEqual(
    expect.objectContaining({ kind: 'dynamic', subjectId: fixture.memberSubject.id }),
  );
  expect(dynamicMembers!.members.find((member) => member.subjectId === fixture.memberSubject.id)?.subject?.label).toBe(
    'Native library member',
  );
  const dynamicText = JSON.stringify(dynamicMembers);
  expect(dynamicText).not.toMatch(/"(?:state|profileId|predicate|releaseDigest)"/);

  const curatedLink = page.getByRole('link', { name: 'Native navigation list', exact: true });
  await curatedLink.waitFor();
  const curatedHref = await curatedLink.getAttribute('href');
  expect(curatedHref).toBe(`/en/collections/${fixture.collection.id}`);
  const builtinLink = page.getByRole('link', { name: builtin!.title ?? 'Everything', exact: true });
  await builtinLink.waitFor();
  const builtinHref = await builtinLink.getAttribute('href');
  expect(builtinHref).toBe(`/en/collections/${builtin!.id}`);

  await curatedLink.click();
  const followCurated = page.getByRole('button', { name: 'Follow', exact: true });
  await followCurated.waitFor();
  await followCurated.click();
  await page.getByText('Following', { exact: true }).waitFor();

  await page.goto(`${native.web}/en/library`, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor();
  await page.getByRole('link', { name: builtin!.title ?? 'Everything', exact: true }).click();
  expect(new URL(page.url()).pathname).toBe(builtinHref);
  const followBuiltin = page.getByRole('button', { name: 'Follow', exact: true });
  await followBuiltin.waitFor();
  await followBuiltin.click();
  await page.getByText('Following', { exact: true }).waitFor();

  for (const href of [curatedHref!, builtinHref!]) {
    await page.goto(new URL(href, native.web).href, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('html[data-hydrated]').waitFor();
    expect(new URL(page.url()).pathname).toBe(href);
    await page.getByRole('main').waitFor();
  }

  const calls = native.kernelRequests();
  expect(calls.some(({ url, method }) => method === 'GET' && url.startsWith('/v1/libraryPins?limit=8'))).toBe(true);
  expect(calls.filter(({ url }) => url.startsWith('/v1/collections?curatorAccountId=')).length).toBeGreaterThan(0);
  expect(calls.filter(({ url, method }) => method === 'PUT' && url.startsWith('/v1/follows/'))).toHaveLength(2);
});

test('native dynamic Collection pages preserve preparing, empty and denied states without leaking private facts', async () => {
  const native = stack!;
  const owner = await native.authPersona('alice');
  const visitor = await native.authPersona('bob');
  const privateMember = await createLibraryEntry(native, 'bob', visitor.authorization);
  const collections = await native.kernel(
    `/v1/collections?curatorAccountId=${owner.accountId}&limit=100`,
    { headers: { authorization: owner.authorization } },
    'alice',
  );
  expect(collections.status).toBe(200);
  const rows = (await collections.json()) as {
    collections: { id: string; builtinKind?: string; title?: string | null }[];
  };
  const everything = rows.collections.find((item) => item.builtinKind === 'everything');
  expect(everything, 'a missing built-in runtime is not an Everything response').toBeDefined();
  const members = await native.kernel(
    `/v1/collections/${everything!.id}/members?limit=20`,
    {
      headers: { authorization: owner.authorization },
    },
    'alice',
  );
  let emptyResponse = members;
  if (emptyResponse.status === 202) {
    expect(emptyResponse.headers.get('cache-control')).toContain('no-store');
    expect(await emptyResponse.json()).toEqual({ preparing: true });
    const retryAfter = Number(emptyResponse.headers.get('retry-after'));
    expect(Number.isFinite(retryAfter) && retryAfter > 0).toBe(true);
    const readyBy = Date.now() + 60_000;
    while (Date.now() < readyBy) {
      await Bun.sleep(Math.max(1, retryAfter * 1000));
      emptyResponse = await native.kernel(
        `/v1/collections/${everything!.id}/members?limit=20`,
        {
          headers: { authorization: owner.authorization },
        },
        'alice',
      );
      if (emptyResponse.status !== 202) break;
      expect(await emptyResponse.json()).toEqual({ preparing: true });
    }
  }
  expect(emptyResponse.status).toBe(200);
  const empty = (await emptyResponse.json()) as { members: unknown[]; next: string | null };
  expect(empty).toEqual({ members: [], next: null });

  const denied = await native.kernel(
    `/v1/collections/${everything!.id}/members?limit=20`,
    {
      headers: { authorization: visitor.authorization },
    },
    'bob',
  );
  expect(denied.status).toBe(404);
  const deniedText = await denied.text();
  expect(deniedText).not.toContain(everything!.id);
  expect(deniedText.toLowerCase()).not.toContain('private');
  expect(deniedText).not.toContain(privateMember.id);
  expect(deniedText).not.toContain('Native library member');
});
