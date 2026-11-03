import { bundledDigest } from '@rezics/definitions/bundled';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { subjectHref } from '../../src/subject/subject-href.ts';
import { startAuthStack, type AuthJourney, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

export type NativeClassificationSubject = { id: string; type: string; label: string; path: string };

export type NativeClassificationFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  alice: AuthJourney;
  concept: NativeClassificationSubject;
  manga: NativeClassificationSubject;
  album: NativeClassificationSubject;
  screen: NativeClassificationSubject;
  citation: string;
  close(): Promise<void>;
};

const writeRateOverrides = JSON.stringify({
  'new-account': { write: { maximum: 1000, seconds: 60 } },
  member: { write: { maximum: 1000, seconds: 60 } },
  trusted: { write: { maximum: 1000, seconds: 60 } },
  service: { write: { maximum: 1000, seconds: 60 } },
});

async function json<T>(response: Response, status: number, action: string): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`${action}: HTTP ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

async function createSubject(stack: NativeWebStack, type: string, label: string): Promise<NativeClassificationSubject> {
  const created = await json<{ subject: { id: string; type: string } }>(
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
  const view =
    type === 'schema:ComicSeries'
      ? 'manga'
      : type === 'schema:MusicAlbum'
        ? 'album'
        : type === 'schema:Movie'
          ? 'screen'
          : '';
  return {
    id: created.subject.id,
    type: created.subject.type,
    label,
    path: view ? `${subjectHref({ id: created.subject.id, label }, 'en').href}/${view}` : '',
  };
}

async function waitForSuggestion(stack: NativeWebStack, subject: NativeClassificationSubject): Promise<void> {
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

export async function startCatalogueClassificationFixture(): Promise<NativeClassificationFixture> {
  const stack = await startNativeWebStack({ writeRateOverrides });
  let auth: NativeAuthStack | undefined;
  try {
    const active = await json<{ digest: string }>(
      await stack.kernel('/v1/definitions/active'),
      200,
      'GET /v1/definitions/active',
    );
    if (active.digest !== bundledDigest)
      throw new Error(`Native stack activated ${active.digest}; expected bundled release ${bundledDigest}`);

    const aliceIdentity = await stack.authPersona('alice');
    const grant = await stack.kernel(
      '/v1/grants',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
        body: JSON.stringify({
          resource: { route: 0, id: GLOBAL_CONTEXT },
          subject: { kind: 'account', id: aliceIdentity.accountId },
          actions: ['statement:propose', 'context:accept', 'context:adopt'],
          valid: '(,)',
        }),
      },
      'governor',
    );
    if (grant.status !== 201 && grant.status !== 409)
      throw new Error(`Granting classification authority to Alice: HTTP ${grant.status} ${await grant.text()}`);

    const marker = crypto.randomUUID().slice(0, 8);
    const concept = await createSubject(stack, 'skos:Concept', `Native genre concept ${marker}`);
    const manga = await createSubject(stack, 'schema:ComicSeries', `Native manga classification ${marker}`);
    const album = await createSubject(stack, 'schema:MusicAlbum', `Native album classification ${marker}`);
    const screen = await createSubject(stack, 'schema:Movie', `Native screen classification ${marker}`);
    await waitForSuggestion(stack, concept);

    auth = await startAuthStack(stack);
    const alice = await auth.signIn('alice');
    if ((await alice.response()).status() !== 200) throw new Error('Alice must sign in through the served Auth forms');
    return {
      stack,
      auth,
      alice,
      concept,
      manga,
      album,
      screen,
      citation: `https://example.org/catalogue-classification/${marker}`,
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
