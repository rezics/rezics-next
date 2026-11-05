import { bundledDigest } from '@rezics/definitions/bundled';
import type { Page } from 'playwright';
import { startAuthStack, type AuthJourney, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

export type NativeLibrarySubject = { id: string; type: string; label: string };

export type NativeHoldingsHistoryFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  alice: AuthJourney;
  bob: AuthJourney;
  alicePage: Page;
  bobPage: Page;
  book: NativeLibrarySubject;
  recipe: NativeLibrarySubject;
  person: NativeLibrarySubject;
  close(): Promise<void>;
};

const historyFixtureRateOverrides = JSON.stringify({
  'new-account': { write: { maximum: 1000, seconds: 60 } },
  member: { write: { maximum: 1000, seconds: 60 } },
  trusted: { write: { maximum: 1000, seconds: 60 } },
  service: { write: { maximum: 1000, seconds: 60 } },
});

async function json<T>(response: Response, expectedStatus: number): Promise<T> {
  const body = await response.text();
  if (response.status !== expectedStatus)
    throw new Error(`Expected native API status ${expectedStatus}, received ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

async function openFeature(stack: NativeWebStack, feature: 'personal_library' | 'reading_progress') {
  const response = await stack.kernel(
    `/v1/platform/exposure/${feature}:open`,
    { method: 'POST', headers: { 'idempotency-key': `"${crypto.randomUUID()}"` } },
    'governor',
  );
  await json(response, 200);
}

async function createSubject(stack: NativeWebStack, type: string, label: string): Promise<NativeLibrarySubject> {
  const response = await stack.kernel(
    '/v1/subjects',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` },
      body: JSON.stringify({ type, labels: { en: label } }),
    },
    'editor',
  );
  const result = await json<{ subject: { id: string; type: string } }>(response, 201);
  return { id: result.subject.id, type: result.subject.type, label };
}

function signedInPage(journey: AuthJourney): Page {
  const page = journey.context.pages().at(-1);
  if (!page) throw new Error('The served Auth form did not retain a signed-in browser page.');
  return page;
}

export async function createNativeHoldingsHistoryFixture(): Promise<NativeHoldingsHistoryFixture> {
  const stack = await startNativeWebStack({ writeRateOverrides: historyFixtureRateOverrides });
  let auth: NativeAuthStack | undefined;
  try {
    const activeResponse = await stack.kernel('/v1/definitions/active');
    const active = await json<{ digest: string }>(activeResponse, 200);
    if (active.digest !== bundledDigest)
      throw new Error(`Native stack activated ${active.digest}; expected bundled release ${bundledDigest}.`);

    await openFeature(stack, 'personal_library');
    await openFeature(stack, 'reading_progress');
    const suffix = crypto.randomUUID().slice(0, 8);
    const book = await createSubject(stack, 'schema:Book', `Native history book ${suffix}`);
    const recipe = await createSubject(stack, 'schema:Recipe', `Native history recipe ${suffix}`);
    const person = await createSubject(stack, 'schema:Person', `Native unsupported person ${suffix}`);

    auth = await startAuthStack(stack);
    const alice = await auth.signIn('alice');
    const bob = await auth.signIn('bob');
    let closed: Promise<void> | undefined;
    return {
      stack,
      auth,
      alice,
      bob,
      alicePage: signedInPage(alice),
      bobPage: signedInPage(bob),
      book,
      recipe,
      person,
      close() {
        return (closed ??= (async () => {
          await auth?.stop();
          await stack.stop();
        })());
      },
    };
  } catch (error) {
    await auth?.stop().catch(() => {});
    await stack.stop().catch(() => {});
    throw error;
  }
}

export async function nativeJson<T>(response: Response, expectedStatus: number): Promise<T> {
  return json<T>(response, expectedStatus);
}
