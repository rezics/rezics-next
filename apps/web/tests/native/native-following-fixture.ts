import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { PLATFORM_RESOURCE } from '../../../../services/kernel/src/access/bootstrap-governance.ts';
import type { NativeWebStack } from './stack.ts';

type JsonRecord = Record<string, unknown>;

async function nativeJson<T>(
  stack: NativeWebStack,
  persona: string,
  path: string,
  options: { method?: string; body?: unknown; key?: string; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers = new Headers(options.headers);
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
  if (!response.ok)
    throw new Error(`${options.method ?? 'GET'} ${path} as ${persona} returned ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function key(): string {
  return crypto.randomUUID();
}

export type NativeFollowingFixture = {
  aliceAccountId: string;
  bobAccountId: string;
  subject: { id: string; title: string; href: string };
  collection: { id: string; title: string; revision: number };
  space: { id: string; title: string; address: string; realmId: string };
  fillerSubjects: { id: string; title: string }[];
  releaseDigest: string;
};

/**
 * Builds only native resources through the running Worker. The stack owns the isolated database, so closing it removes
 * this fixture without touching another process or account.
 */
export async function createNativeFollowingFixture(stack: NativeWebStack): Promise<NativeFollowingFixture> {
  const [{ accountId: aliceAccountId }, { accountId: bobAccountId }, { accountId: editorAccountId }] =
    await Promise.all([stack.authPersona('alice'), stack.authPersona('bob'), stack.authPersona('editor')]);

  const active = await nativeJson<{ digest: string }>(stack, 'anonymous', '/v1/definitions/active');
  if (active.digest !== bundledDigest)
    throw new Error(`Native Following fixture expected bundled digest ${bundledDigest}, received ${active.digest}`);
  if (!bundledRelease.types['schema:Book']) throw new Error('The bundled release has no schema:Book definition');

  // The cursor scenario creates 99 Books and 101 Alice edges through production APIs; raise only fixture accounts'
  // native request tier so it can cross the real list boundary without exhausting the default write budget.
  for (const accountId of [aliceAccountId, editorAccountId]) {
    const rateTierKey = key();
    await nativeJson(stack, 'governor', `/v1/accounts/${encodeURIComponent(accountId)}:setRateTier`, {
      method: 'POST',
      key: rateTierKey,
      body: { key: rateTierKey, tier: 'trusted' },
    });
  }

  await nativeJson(stack, 'governor', '/v1/platform/exposure/collections:open', { method: 'POST', key: key() });
  await nativeJson(stack, 'governor', '/v1/platform/exposure/personal_library:open', {
    method: 'POST',
    key: key(),
  });

  const grant = (actions: string[]) =>
    nativeJson(stack, 'governor', '/v1/grants', {
      method: 'POST',
      key: key(),
      body: {
        resource: PLATFORM_RESOURCE,
        subject: { kind: 'account', id: bobAccountId },
        actions,
        valid: '(,)',
      },
    });
  await grant(['context:create', 'realm:create', 'space:create']);

  const context = await nativeJson<{ context: { id: string } }>(stack, 'bob', '/v1/contexts', {
    method: 'POST',
    key: key(),
    body: { labels: { en: 'Following fixture context' } },
  });
  const createdSpace = await nativeJson<{ space: { spaceId: string } }>(stack, 'bob', '/v1/spaces', {
    method: 'POST',
    key: key(),
    body: { title: 'Following space', summary: 'A native Space followed through its Realm control.' },
  });
  const spaceId = createdSpace.space.spaceId;
  const createdRealm = await nativeJson<{ realm: { realmId: string } }>(stack, 'bob', '/v1/realms', {
    method: 'POST',
    key: key(),
    body: {
      spaceId,
      title: 'Following community',
      summary: 'Public community for the native Following fixture.',
      visibility: 'public',
      contextId: context.context.id,
    },
  });
  const currentSpace = await nativeJson<{ space: { headRevisionId: string } }>(
    stack,
    'bob',
    `/v1/spaces/${encodeURIComponent(spaceId)}`,
  );
  const address = `following-${key().slice(0, 8)}`;
  await nativeJson(stack, 'bob', `/v1/spaces/${encodeURIComponent(spaceId)}/address`, {
    method: 'PUT',
    key: key(),
    headers: { 'if-match': JSON.stringify(currentSpace.space.headRevisionId) },
    body: { address },
  });

  const collectionTitle = 'Alice follows this Collection';
  const createdCollection = await nativeJson<{
    collection: { id: string; revision: number };
  }>(stack, 'bob', '/v1/collections', {
    method: 'POST',
    key: key(),
    body: { title: collectionTitle, description: 'A public fixture Collection.', visibility: 'public' },
  });

  const subjectTitle = 'Alice follows this subject';
  const createdSubject = await nativeJson<{ subject: { id: string; labels: Record<string, string> } }>(
    stack,
    'editor',
    '/v1/subjects',
    { method: 'POST', key: key(), body: { type: 'schema:Book', labels: { en: subjectTitle } } },
  );
  const { subjectHref } = await import('../../src/subject/subject-href.ts');

  const fillerSubjects: { id: string; title: string }[] = [];
  for (let index = 0; index < 98; index++) {
    const title = `Following cursor subject ${String(index + 1).padStart(2, '0')}`;
    const result = await nativeJson<{ subject: { id: string } }>(stack, 'editor', '/v1/subjects', {
      method: 'POST',
      key: key(),
      body: { type: 'schema:Book', labels: { en: title } },
    });
    fillerSubjects.push({ id: result.subject.id, title });
  }

  return {
    aliceAccountId,
    bobAccountId,
    subject: {
      id: createdSubject.subject.id,
      title: subjectTitle,
      href: subjectHref({ id: createdSubject.subject.id, label: subjectTitle }, 'en').href,
    },
    collection: {
      id: createdCollection.collection.id,
      title: collectionTitle,
      revision: createdCollection.collection.revision,
    },
    space: {
      id: spaceId,
      title: 'Following space',
      address,
      realmId: createdRealm.realm.realmId,
    },
    fillerSubjects,
    releaseDigest: active.digest,
  };
}

export async function nativeFollowingJson<T>(
  stack: NativeWebStack,
  persona: string,
  path: string,
  options: { method?: string; body?: unknown; key?: string; headers?: Record<string, string> } = {},
): Promise<T> {
  return nativeJson<T>(stack, persona, path, options);
}

export type NativeFollowingRecord = {
  targetId: string;
  targetType: 'subject' | 'collection' | 'space';
  state: 'following' | 'unfollowed';
  reason: 'explicit' | 'library' | 'membership';
  target: JsonRecord | null;
};

export type NativeFollowingPage = { follows: NativeFollowingRecord[]; next: string | null };

export async function readAllNativeFollows(stack: NativeWebStack, persona: string): Promise<NativeFollowingPage[]> {
  const pages: NativeFollowingPage[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: '100', view: 'FULL' });
    if (cursor) query.set('cursor', cursor);
    const page = await nativeFollowingJson<NativeFollowingPage>(stack, persona, `/v1/follows?${query}`);
    pages.push(page);
    cursor = page.next;
    if (pages.length > 10) throw new Error('Native Following cursor did not terminate within ten pages');
  } while (cursor);
  return pages;
}

export function fixtureKey(): string {
  return key();
}
