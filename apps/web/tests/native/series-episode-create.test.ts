import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page } from 'playwright';
import { expect as playExpect } from 'playwright/test';
import { bundledDigest } from '@rezics/definitions/bundled';
import { subjectHref } from '../../src/subject/subject-href.ts';
import { m } from '../../src/paraglide/messages.js';
import { startAuthStack, type AuthJourney, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';
import { createSubject, hydrate } from './catalogue-relations-fixture.ts';

setDefaultTimeout(900_000);

const writeRateOverrides = JSON.stringify({
  'new-account': { write: { maximum: 1000, seconds: 60 } },
  member: { write: { maximum: 1000, seconds: 60 } },
  trusted: { write: { maximum: 1000, seconds: 60 } },
  service: { write: { maximum: 1000, seconds: 60 } },
});

let stack: NativeWebStack;
let auth: NativeAuthStack;
let alice: AuthJourney;
let series: { id: string; type: string; label: string };

beforeAll(async () => {
  stack = await startNativeWebStack({ writeRateOverrides });
  const active = await stack.kernel('/v1/definitions/active');
  expect(active.status).toBe(200);
  const digest = ((await active.json()) as { digest: string }).digest;
  if (digest !== bundledDigest) throw new Error(`Native stack activated ${digest}; expected ${bundledDigest}.`);
  series = await createSubject(
    stack,
    'schema:TVSeries',
    `Native series episode parent ${crypto.randomUUID().slice(0, 8)}`,
  );
  auth = await startAuthStack(stack);
  alice = await auth.signIn('alice');
}, 600_000);

afterAll(async () => {
  await auth?.stop();
  await stack?.stop();
}, 180_000);

function subjectPosts(label: string) {
  return stack.kernelRequests().filter((request) => {
    if (request.method !== 'POST' || request.url !== '/v1/subjects' || !request.body || request.fixtureRequest)
      return false;
    return (JSON.parse(request.body) as { labels?: { en?: string } }).labels?.en === label;
  });
}

function createdRead(after: number) {
  return stack
    .kernelRequests()
    .slice(after)
    .findLast(
      (request) =>
        request.method === 'GET' &&
        /^\/v1\/subjects\/[0-9a-f-]{36}$/i.test(request.url) &&
        request.url !== `/v1/subjects/${series.id}`,
    );
}

async function openCreate(page: Page) {
  const navigation = await page.goto(`${stack.web}${subjectHref(series, 'en').href}/work-parts`, {
    waitUntil: 'domcontentloaded',
  });
  expect(navigation?.status()).toBe(200);
  await hydrate(page);
  const create = page.getByRole('link', { name: m.work_parts_create_episode(), exact: true });
  await playExpect(create).toBeVisible();
  await create.click();
  await page.locator('#create-label-0').waitFor({ state: 'visible' });
}

describe('series contributor creates an episode and returns to parts', () => {
  test('confirmed membership uses one native create and returns to the series parts child', async () => {
    const page = await alice.context.newPage();
    page.setDefaultTimeout(60_000);
    try {
      await openCreate(page);
      const label = `Native series episode ${crypto.randomUUID().slice(0, 8)}`;
      const before = stack.kernelRequests().length;
      await page.locator('#create-label-0').fill(label);
      await page.getByRole('button', { name: m.screen_episode_membership_confirm(), exact: true }).click();
      await page.getByRole('button', { name: m.catalogue_create_submit(), exact: true }).click();
      await playExpect(page.getByText(m.screen_episode_created(), { exact: true })).toBeVisible();
      await stack.syncKernelRequests();
      const posts = subjectPosts(label);
      expect(posts).toHaveLength(1);
      expect(posts[0]?.responseStatus).toBe(201);
      const body = JSON.parse(posts[0]?.body ?? 'null') as {
        type: string;
        statements?: Record<string, { value: { content?: string } }[]>;
      };
      expect(body.type).toBe('schema:Episode');
      expect(body.statements?.['schema:isPartOf']?.[0]?.value.content).toBe(series.id);
      const createdId = createdRead(before)!.url.slice('/v1/subjects/'.length);
      await page.getByRole('link', { name: m.screen_episode_return_parts(), exact: true }).click();
      await page.waitForURL(
        (url) => url.pathname.endsWith('/work-parts') && url.searchParams.get('child') === createdId,
      );
      await hydrate(page);
      const located = page.getByRole('status').filter({ hasText: createdId });
      const onPage = page.locator('[data-created-child]');
      expect((await onPage.count()) + (await located.count())).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });

  test('omitted membership recovers created-but-unread without a second create', async () => {
    const page = await alice.context.newPage();
    page.setDefaultTimeout(60_000);
    try {
      await openCreate(page);
      const label = `Native series episode unread ${crypto.randomUUID().slice(0, 8)}`;
      const before = stack.kernelRequests().length;
      await page.locator('#create-label-0').fill(label);
      await stack.injectCreatedSubjectReadFailureOnce({
        status: 503,
        body: '{"title":"Created identity reader unavailable","status":503}',
      });
      await page.getByRole('button', { name: m.catalogue_create_submit(), exact: true }).click();
      await playExpect(page.getByText(m.screen_episode_unread(), { exact: true })).toBeVisible();
      await stack.syncKernelRequests();
      expect(subjectPosts(label)).toHaveLength(1);
      const body = JSON.parse(subjectPosts(label)[0]?.body ?? 'null') as { statements?: Record<string, unknown> };
      expect(body.statements?.['schema:isPartOf']).toBeUndefined();
      expect(createdRead(before)?.responseStatus).toBe(503);
      await page.getByRole('button', { name: m.catalogue_create_retry(), exact: true }).first().click();
      await playExpect(page.getByText(m.screen_episode_created(), { exact: true })).toBeVisible();
      await stack.syncKernelRequests();
      expect(subjectPosts(label)).toHaveLength(1);
      await playExpect(page.getByRole('link', { name: m.screen_episode_return_parts(), exact: true })).toBeVisible();
    } finally {
      await page.close();
    }
  });
});
