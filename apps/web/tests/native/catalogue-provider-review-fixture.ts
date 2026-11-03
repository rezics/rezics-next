import { bundledDigest } from '@rezics/definitions/bundled';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { currentNativeLifecycle } from './lifecycle.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

export const providerReviewSource = 'open-library';
const digest = 'a'.repeat(64);

export type ProviderReviewBook = {
  id: string;
  title: string;
  candidate: string;
  language: string;
  externalId: string;
};

export type CatalogueProviderReviewFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  alice: { accountId: string; email: string };
  context: { id: string; label: string };
  books: ProviderReviewBook[];
  stop(): Promise<void>;
};

async function nativeJson<T>(
  stack: NativeWebStack,
  persona: string,
  path: string,
  options: { method?: string; body?: unknown; key?: string; status?: number } = {},
): Promise<T> {
  const headers = new Headers();
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.key) headers.set('idempotency-key', JSON.stringify(options.key));
  const response = await stack.kernel(
    path,
    {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    persona,
  );
  const text = await response.text();
  const expected = options.status ?? (response.ok ? response.status : 0);
  if (response.status !== expected && expected !== 0)
    throw new Error(`${options.method ?? 'GET'} ${path} as ${persona} returned ${response.status}: ${text}`);
  if (!response.ok && expected === 0)
    throw new Error(`${options.method ?? 'GET'} ${path} as ${persona} returned ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function source(externalId: string) {
  return {
    source: providerReviewSource,
    external_id: externalId,
    record_revision: '1',
    digest,
    converter_revision: 'open-library@1',
    field_group: 'facts',
  };
}

async function waitForContextDirectory(
  stack: NativeWebStack,
  persona: string,
  query: string,
  id: string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  const path = `/v1/contexts?query=${encodeURIComponent(query)}&limit=20&deleted=false`;
  while (Date.now() < deadline) {
    const response = await stack.kernel(path, {}, persona);
    if (response.ok) {
      const body = (await response.json()) as { contexts: { id: string }[] };
      if (body.contexts.some((entry) => entry.id === id)) return;
    }
    await Bun.sleep(250);
  }
  throw new Error(`Named Context ${id} did not appear in GET /v1/contexts`);
}

/** Ordinary imported candidates and a named Context through admitted kernel APIs. */
export async function createCatalogueProviderReviewFixture(
  options: { bookCount?: number } = {},
): Promise<CatalogueProviderReviewFixture> {
  const bookCount = options.bookCount ?? 4;
  if (!Number.isSafeInteger(bookCount) || bookCount < 1 || bookCount > 100)
    throw new Error('Provider review fixture book count must be between 1 and 100');
  const lifecycle = currentNativeLifecycle();
  if (!lifecycle) throw new Error('Catalogue provider review fixture requires an active native test lifecycle');
  lifecycle.assertOpen('start catalogue provider review fixture');
  let stack: NativeWebStack | undefined;
  let auth: NativeAuthStack | undefined;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await auth?.stop();
    } finally {
      await stack?.stop();
    }
  };
  try {
    stack = await startNativeWebStack();
    const active = await nativeJson<{ digest: string }>(stack, 'anonymous', '/v1/definitions/active');
    if (active.digest !== bundledDigest)
      throw new Error(`Native provider-review fixture expected bundled digest ${bundledDigest}`);
    const [alice, editor] = await Promise.all([stack.authPersona('alice'), stack.authPersona('editor')]);
    for (const accountId of [alice.accountId, editor.accountId]) {
      const rateTierKey = crypto.randomUUID();
      await nativeJson(stack, 'governor', `/v1/accounts/${encodeURIComponent(accountId)}:setRateTier`, {
        method: 'POST',
        key: rateTierKey,
        body: { key: rateTierKey, tier: 'trusted' },
      });
    }
    await nativeJson(stack, 'governor', '/v1/grants', {
      method: 'POST',
      key: crypto.randomUUID(),
      body: {
        resource: { route: 0, id: GLOBAL_CONTEXT },
        subject: { kind: 'account', id: alice.accountId },
        actions: ['context:create'],
        valid: '(,)',
      },
      status: 201,
    });
    await nativeJson(stack, 'governor', '/v1/grants', {
      method: 'POST',
      key: crypto.randomUUID(),
      body: {
        resource: { route: 0, id: GLOBAL_CONTEXT },
        subject: { kind: 'account', id: editor.accountId },
        actions: ['subject:batch_write', 'subject:create', 'statement:propose'],
        valid: '(,)',
      },
      status: 201,
    });
    const token = crypto.randomUUID().slice(0, 8);
    const label = `olrev${token} editors`;
    const createdContext = await nativeJson<{ context: { id: string } }>(stack, 'alice', '/v1/contexts', {
      method: 'POST',
      key: crypto.randomUUID(),
      body: { labels: { en: label } },
      status: 201,
    });
    await nativeJson(stack, 'governor', '/v1/grants', {
      method: 'POST',
      key: crypto.randomUUID(),
      body: {
        resource: { route: 0, id: createdContext.context.id },
        subject: { kind: 'account', id: alice.accountId },
        actions: ['context:accept', 'context:adopt'],
        valid: '(,)',
      },
      status: 201,
    });
    await waitForContextDirectory(stack, 'alice', `olrev${token}`, createdContext.context.id);
    const languages = ['en', 'ja', 'fr', 'de'] as const;
    const books: ProviderReviewBook[] = [];
    for (let index = 0; index < bookCount; index++) {
      const language = languages[index % languages.length]!;
      const title = `olrev${token} book ${index + 1}`;
      const externalId = `OL${token}${index}W`;
      const origin = source(externalId);
      const created = await nativeJson<{
        results: { status: number; value?: { id: string }; problem?: unknown }[];
      }>(stack, 'editor', '/v1/subjects:batchWrite', {
        method: 'POST',
        key: crypto.randomUUID(),
        body: {
          commands: [
            {
              op: 'create',
              key: crypto.randomUUID(),
              source: origin,
              subject: { type: 'schema:Book', labels: { en: title } },
            },
          ],
        },
        status: 200,
      });
      const createdRow = created.results[0];
      if (createdRow?.status !== 201 || !createdRow.value?.id)
        throw new Error(`Imported subject ${title} failed: ${JSON.stringify(createdRow)}`);
      const proposed = await nativeJson<{
        results: { status: number; value?: { candidate: string }; problem?: unknown }[];
      }>(stack, 'editor', '/v1/subjects:batchWrite', {
        method: 'POST',
        key: crypto.randomUUID(),
        body: {
          commands: [
            {
              op: 'propose',
              key: crypto.randomUUID(),
              subject: createdRow.value.id,
              source: origin,
              statement: {
                property: { id: 'schema:inLanguage' },
                value: { type: 'value', content: language },
                references: [
                  {
                    parts: [
                      {
                        property: { id: 'schema:url' },
                        value: { type: 'value', content: `https://openlibrary.org/works/${externalId}` },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
        status: 200,
      });
      const proposedRow = proposed.results[0];
      if (proposedRow?.status !== 201 || !proposedRow.value?.candidate)
        throw new Error(`Imported proposal ${title} failed: ${JSON.stringify(proposedRow)}`);
      books.push({
        id: createdRow.value.id,
        title,
        candidate: proposedRow.value.candidate,
        language,
        externalId,
      });
    }
    auth = await startAuthStack(stack);
    return {
      stack,
      auth,
      alice: { accountId: alice.accountId, email: alice.email },
      context: { id: createdContext.context.id, label },
      books,
      stop,
    };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}

export async function readProviderReviewPage(
  stack: NativeWebStack,
  persona: string,
  context: string,
  status: 'pending' | 'accepted_unselected' = 'pending',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const query = new URLSearchParams({
    source: providerReviewSource,
    context,
    status,
    limit: '20',
  });
  const response = await stack.kernel(`/v1/review-candidates?${query}`, {}, persona);
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}
