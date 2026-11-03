import { bundledDigest } from '@rezics/definitions/bundled';
import type { Page } from 'playwright';
import { candidateContext } from '../../src/subject/candidates.ts';
import { startAuthStack, type AuthJourney, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

export type NativeCatalogueSubject = { id: string; type: string; label: string };

export type NativeCatalogueRelationsFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  alice: AuthJourney;
  movie: NativeCatalogueSubject;
  person: NativeCatalogueSubject;
  firstRole: NativeCatalogueSubject;
  secondRole: NativeCatalogueSubject;
  editorPath: string;
  close(): Promise<void>;
};

const writeRateOverrides = JSON.stringify({
  'new-account': { write: { maximum: 1000, seconds: 60 } },
  member: { write: { maximum: 1000, seconds: 60 } },
  trusted: { write: { maximum: 1000, seconds: 60 } },
  service: { write: { maximum: 1000, seconds: 60 } },
});

async function json<T>(response: Response, expectedStatus: number, label: string): Promise<T> {
  const body = await response.text();
  if (response.status !== expectedStatus)
    throw new Error(`${label} expected ${expectedStatus}, received ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

async function createSubject(stack: NativeWebStack, type: string, label: string): Promise<NativeCatalogueSubject> {
  const result = await json<{ subject: { id: string; type: string } }>(
    await stack.kernel(
      '/v1/subjects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` },
        body: JSON.stringify({ type, labels: { en: label } }),
      },
      'editor',
    ),
    201,
    `POST /v1/subjects ${type}`,
  );
  return { id: result.subject.id, type: result.subject.type, label };
}

async function waitForSuggestion(stack: NativeWebStack, subject: NativeCatalogueSubject): Promise<void> {
  const until = Date.now() + 60_000;
  const query = `/v1/subjects:suggest?q=${encodeURIComponent(subject.label)}&limit=10&languages=en`;
  while (Date.now() < until) {
    const response = await stack.kernel(query);
    if (response.status === 200) {
      const body = (await response.json()) as { subjects?: { id: string }[] };
      if (body.subjects?.some((item) => item.id === subject.id)) return;
    }
    await Bun.sleep(250);
  }
  throw new Error(`Native suggestions did not include ${subject.type} ${subject.id} for ${subject.label}`);
}

export async function createNativeCatalogueRelationsFixture(): Promise<NativeCatalogueRelationsFixture> {
  const stack = await startNativeWebStack({ writeRateOverrides });
  let auth: NativeAuthStack | undefined;
  try {
    const active = await json<{ digest: string }>(
      await stack.kernel('/v1/definitions/active'),
      200,
      'GET /v1/definitions/active',
    );
    if (active.digest !== bundledDigest)
      throw new Error(`Native stack activated ${active.digest}; expected bundled release ${bundledDigest}.`);

    const marker = crypto.randomUUID().slice(0, 8);
    const movie = await createSubject(stack, 'schema:Movie', `Native credit work ${marker}`);
    const person = await createSubject(stack, 'schema:Person', `Native credit actor ${marker}`);
    const firstRole = await createSubject(stack, 'wd:Q95074', `Native credit role ${marker} a`);
    const secondRole = await createSubject(stack, 'wd:Q95074', `Native credit role ${marker} b`);
    await Promise.all([
      waitForSuggestion(stack, person),
      waitForSuggestion(stack, firstRole),
      waitForSuggestion(stack, secondRole),
    ]);

    const { subjectHref } = await import('../../src/subject/subject-href.ts');
    auth = await startAuthStack(stack);
    const alice = await auth.signIn('alice');
    return {
      stack,
      auth,
      alice,
      movie,
      person,
      firstRole,
      secondRole,
      editorPath: `${subjectHref(movie, 'en').href}/relation-edit`,
      async close() {
        await auth?.stop();
        await stack.stop();
      },
    };
  } catch (error) {
    await auth?.stop().catch(() => {});
    await stack.stop().catch(() => {});
    throw error;
  }
}

export async function hydrate(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

export async function readPublicStatements(
  stack: NativeWebStack,
  id: string,
  property: string,
): Promise<{ id: string; value: unknown; qualifiers: { property: { id: string }; value: unknown }[] }[]> {
  const body = await json<{
    subject: {
      statements?: Record<
        string,
        { id: string; value: unknown; qualifiers: { property: { id: string }; value: unknown }[] }[]
      >;
    };
  }>(await stack.kernel(`/v1/subjects/${id}`), 200, `GET /v1/subjects/${id}`);
  return body.subject.statements?.[property] ?? [];
}

export async function readSlotCandidates(
  stack: NativeWebStack,
  id: string,
  slot: { property: string; target: string; key: string },
): Promise<{ id: string }[]> {
  const query = new URLSearchParams({
    property: slot.property,
    target: slot.target,
    key: slot.key,
    context: candidateContext,
    limit: '20',
  });
  const body = await json<{ candidates: { id: string; deleted?: true }[] }>(
    await stack.kernel(`/v1/subjects/${id}/candidates?${query}`, undefined, 'alice'),
    200,
    `GET /v1/subjects/${id}/candidates`,
  );
  return body.candidates.filter((candidate) => !('deleted' in candidate && candidate.deleted));
}
