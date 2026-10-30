import { bundledDigest } from '@rezics/definitions/bundled';
import { slug } from '@rezics/definitions/slug';
import { expect } from 'bun:test';
import type { BrowserContext, Page } from 'playwright';
import { startAuthStack, type AuthJourney, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

const globalResource = { route: 0, id: '00000000-0000-8000-8000-000000000000' };
const requestKey = () => JSON.stringify(crypto.randomUUID());

export type NativeCuratedSubject = { id: string; label: string; href: string };
export type NativeCuratedPersona = 'alice' | 'bob' | 'anonymous';

export type NativeCuratedCollectionsFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  alice: AuthJourney;
  bob: AuthJourney;
  page(persona: NativeCuratedPersona): Promise<Page>;
  context(persona: NativeCuratedPersona): Promise<BrowserContext>;
  createSubject(label: string): Promise<NativeCuratedSubject>;
  createPrivateCollection(title: string): Promise<Record<string, unknown>>;
  hideSubject(subjectId: string): Promise<void>;
  close(): Promise<void>;
};

async function expectStatus(response: Response, expected: number, action: string): Promise<void> {
  if (response.status === expected) return;
  throw new Error(`${action}: expected HTTP ${expected}, got ${response.status}: ${await response.text()}`);
}

async function grant(
  stack: NativeWebStack,
  accountId: string,
  actions: string[],
  idempotencyKey = requestKey(),
): Promise<void> {
  const response = await stack.kernel(
    '/v1/grants',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({
        resource: globalResource,
        subject: { kind: 'account', id: accountId },
        actions,
        valid: '(,)',
      }),
    },
    'governor',
  );
  await expectStatus(response, 201, `Granting ${actions.join(', ')} to ${accountId}`);
}

async function kernelJson<T>(response: Response, expected: number, action: string): Promise<T> {
  await expectStatus(response, expected, action);
  return (await response.json()) as T;
}

export async function startNativeCuratedCollectionsFixture(): Promise<NativeCuratedCollectionsFixture> {
  const stack = await startNativeWebStack();
  let auth: NativeAuthStack | undefined;
  let closed = false;
  try {
    const active = await kernelJson<{ digest: string }>(
      await stack.kernel('/v1/definitions/active'),
      200,
      'Read active catalogue definitions',
    );
    if (active.digest !== bundledDigest)
      throw new Error(`Expected activated bundled definitions ${bundledDigest}, received ${active.digest}`);

    auth = await startAuthStack(stack);
    await Promise.all([
      stack.authPersona('alice'),
      stack.authPersona('bob'),
      stack.authPersona('editor'),
      stack.authPersona('steward'),
    ]);
    await kernelJson<Record<string, unknown>>(
      await stack.kernel(
        '/v1/platform/exposure/collections:open',
        { method: 'POST', headers: { 'idempotency-key': requestKey() } },
        'governor',
      ),
      200,
      'Open native Collections exposure',
    );
    await grant(stack, (await stack.authPersona('steward')).accountId, ['moderation:hide']);

    const alice = await auth.signIn('alice');
    const bob = await auth.signIn('bob');
    expect((await alice.response()).status(), 'Sign Alice in through the served Auth form').toBe(200);
    expect((await bob.response()).status(), 'Sign Bob in through the served Auth form').toBe(200);

    const context = async (persona: NativeCuratedPersona): Promise<BrowserContext> =>
      persona === 'alice' ? alice.context : persona === 'bob' ? bob.context : auth!.context('anonymous');

    const createSubject = async (label: string): Promise<NativeCuratedSubject> => {
      const created = await kernelJson<{ subject: { id: string } }>(
        await stack.kernel(
          '/v1/subjects',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': requestKey(),
            },
            body: JSON.stringify({
              type: 'schema:Book',
              labels: { en: label },
            }),
          },
          'editor',
        ),
        201,
        `Create native subject ${label}`,
      );
      return {
        id: created.subject.id,
        label,
        href: `/en/subjects/${encodeURIComponent(created.subject.id)}/${slug(label)}`,
      };
    };

    const fixture: NativeCuratedCollectionsFixture = {
      stack,
      auth,
      alice,
      bob,
      async context(persona) {
        return context(persona);
      },
      async page(persona) {
        const page = await (await context(persona)).newPage();
        page.setDefaultTimeout(15_000);
        return page;
      },
      createSubject,
      async createPrivateCollection(title) {
        return kernelJson<Record<string, unknown>>(
          await stack.kernel(
            '/v1/collections',
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'idempotency-key': requestKey(),
              },
              body: JSON.stringify({ title, visibility: 'private' }),
            },
            'alice',
          ),
          201,
          `Create unrelated private Collection ${title}`,
        );
      },
      async hideSubject(subjectId) {
        await expectStatus(
          await stack.kernel(
            `/v1/subjects/${encodeURIComponent(subjectId)}:hide`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'idempotency-key': requestKey(),
              },
              body: JSON.stringify({
                reason: 'Native Collection disclosure fixture',
              }),
            },
            'steward',
          ),
          200,
          `Hide native subject ${subjectId}`,
        );
      },
      async close() {
        if (closed) return;
        closed = true;
        const errors: unknown[] = [];
        try {
          await auth!.stop();
        } catch (error) {
          errors.push(error);
        }
        try {
          await stack.stop();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length) throw new AggregateError(errors, 'Native curated Collection fixture cleanup failed');
      },
    };
    return fixture;
  } catch (error) {
    await auth?.stop().catch(() => {});
    await stack.stop().catch(() => {});
    throw error;
  }
}
