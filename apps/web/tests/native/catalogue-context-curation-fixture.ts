import { bundledDigest } from '@rezics/definitions/bundled';
import { subjectHref } from '../../src/subject/subject-href.ts';
import { routeOf } from '../../../../services/kernel/src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

const citation = {
  parts: [
    { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/context-curation' } },
  ],
};

export type CatalogueContextSubject = {
  id: string;
  label: string;
  href: string;
  authorId: string;
  languageCandidate: string;
  contextId: string;
  contextLabel: string;
};

export type CatalogueContextCurationFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  aliceAccountId: string;
  bobAccountId: string;
  journey: CatalogueContextSubject;
  seams: CatalogueContextSubject;
  close(): Promise<void>;
};

async function json<T>(response: Response, label: string, status?: number): Promise<T> {
  const text = await response.text();
  if (status !== undefined ? response.status !== status : !response.ok)
    throw new Error(`${label} returned ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function headers(): HeadersInit {
  return { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) };
}

async function grant(
  stack: NativeWebStack,
  accountId: string,
  resourceId: string,
  actions: string[],
  persona = 'governor',
) {
  const route = resourceId === GLOBAL_CONTEXT ? 0 : routeOf(resourceId);
  if (route === null) throw new Error(`Cannot grant on unroutable ${resourceId}`);
  await json(
    await stack.kernel(
      '/v1/grants',
      {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          resource: { route, id: resourceId },
          subject: { kind: 'account', id: accountId },
          actions,
          valid: '(,)',
        }),
      },
      persona,
    ),
    `grant ${actions.join(',')}`,
  );
}

async function write<T>(stack: NativeWebStack, persona: string, path: string, body: unknown, status = 201): Promise<T> {
  return json(
    await stack.kernel(path, { method: 'POST', headers: headers(), body: JSON.stringify(body) }, persona),
    `POST ${path}`,
    status,
  );
}

async function createSubject(stack: NativeWebStack, label: string, authorId: string): Promise<CatalogueContextSubject> {
  const created = await write<{ subject: { id: string } }>(stack, 'editor', '/v1/subjects', {
    type: 'schema:Book',
    labels: { en: label },
    statements: {
      'schema:inLanguage': [{ property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'ja' } }],
      'schema:author': [
        {
          property: { id: 'schema:author' },
          value: { type: 'value', content: authorId },
          references: [citation],
        },
      ],
    },
  });
  const proposed = await write<{ candidate: string }>(
    stack,
    'editor',
    `/v1/subjects/${created.subject.id}/candidates`,
    {
      statement: {
        property: { id: 'schema:inLanguage' },
        value: { type: 'value', content: 'en' },
        references: [citation],
      },
    },
  );
  const contextLabel = `${label} readers`;
  const context = await write<{ context: { id: string } }>(stack, 'alice', '/v1/contexts', {
    labels: { en: contextLabel },
  });
  return {
    id: created.subject.id,
    label,
    href: subjectHref({ id: created.subject.id, label }, 'en').href,
    authorId,
    languageCandidate: proposed.candidate,
    contextId: context.context.id,
    contextLabel,
  };
}

/** Named community Contexts, a real Book, and competing language evidence through admitted APIs. */
export async function createCatalogueContextCurationFixture(): Promise<CatalogueContextCurationFixture> {
  const stack = await startNativeWebStack();
  let auth: NativeAuthStack | undefined;
  try {
    auth = await startAuthStack(stack);
    const active = await json<{ digest: string }>(await stack.kernel('/v1/definitions/active'), 'active definitions');
    if (active.digest !== bundledDigest)
      throw new Error(`Native stack digest ${active.digest} is not the bundled release`);
    const [alice, bob] = await Promise.all([stack.authPersona('alice'), stack.authPersona('bob')]);
    await grant(stack, alice.accountId, GLOBAL_CONTEXT, ['context:create']);
    const person = await write<{ subject: { id: string } }>(stack, 'editor', '/v1/subjects', {
      type: 'schema:Person',
      labels: { en: 'Native context author' },
    });
    const journey = await createSubject(stack, `Context journey ${crypto.randomUUID().slice(0, 8)}`, person.subject.id);
    const seams = await createSubject(stack, `Context seams ${crypto.randomUUID().slice(0, 8)}`, person.subject.id);
    return {
      stack,
      auth,
      aliceAccountId: alice.accountId,
      bobAccountId: bob.accountId,
      journey,
      seams,
      async close() {
        await auth?.stop();
        await stack.stop();
      },
    };
  } catch (error) {
    await auth?.stop().catch(() => {});
    await stack.stop();
    throw error;
  }
}
