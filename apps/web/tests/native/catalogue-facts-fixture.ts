import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { subjectHref } from '../../src/subject/subject-href.ts';
import { startAuthStack, type AuthJourney, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

const gregorian = 'http://www.wikidata.org/entity/Q1985727';
const published = {
  time: '+1946-04-06T00:00:00Z',
  precision: 11,
  calendarmodel: gregorian,
} as const;

export type CatalogueFactsStatement = {
  id: string;
  value: { type: string; content: unknown };
  qualifiers: unknown[];
  references: { parts: { property: { id: string }; value: unknown }[] }[];
  rezics: { release: string; revision: number };
};
export type CatalogueFactsSubject = {
  id: string;
  type: string;
  release: string;
  statements: Record<string, CatalogueFactsStatement[]>;
};
export type CatalogueFactsFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  alice: AuthJourney;
  aliceAccountId: string;
  digest: string;
  type: string;
  label: string;
  path: string;
  identifiersPath: string;
  published: typeof published;
  language: string;
  url: string;
  citations: { date: string; language: string; url: string };
  current(): Promise<CatalogueFactsSubject>;
  close(): Promise<void>;
};

async function json<T>(response: Response, status: number, action: string): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`${action}: HTTP ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

function cited(property: string, content: unknown, citation: string) {
  return {
    property: { id: property },
    value: { type: 'value', content },
    references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: citation } }] }],
  };
}

/** Provision an emitted Type through admitted APIs; Alice owns the later user action. */
export async function startCatalogueFactsFixture(type = 'schema:Book'): Promise<CatalogueFactsFixture> {
  const stack = await startNativeWebStack();
  let auth: NativeAuthStack | undefined;
  try {
    const active = await json<{ digest: string }>(
      await stack.kernel('/v1/definitions/active'),
      200,
      'GET /v1/definitions/active',
    );
    if (active.digest !== bundledDigest)
      throw new Error(`Native stack is not using bundled definitions ${bundledDigest}`);
    const subjectType = bundledRelease.types[type];
    if (!subjectType) throw new Error(`Bundled release has no ${type}`);
    for (const property of ['schema:datePublished', 'schema:inLanguage', 'schema:url'] as const)
      if (!subjectType.properties.includes(property)) throw new Error(`${type} does not emit ${property}`);

    auth = await startAuthStack(stack);
    const aliceIdentity = await stack.authPersona('alice');
    const grant = await stack.kernel(
      '/v1/grants',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
        body: JSON.stringify({
          resource: { route: 0, id: GLOBAL_CONTEXT },
          subject: { kind: 'account', id: aliceIdentity.accountId },
          actions: ['statement:propose'],
          valid: '(,)',
        }),
      },
      'governor',
    );
    if (grant.status !== 201 && grant.status !== 409)
      throw new Error(`Granting statement:propose to Alice: HTTP ${grant.status} ${await grant.text()}`);

    const citations = {
      date: 'https://example.org/catalogue-facts/date',
      language: 'https://example.org/catalogue-facts/language',
      url: 'https://example.org/catalogue-facts/url',
    };
    const label = `Catalogue facts ${crypto.randomUUID()}`;
    const created = await json<{ subject: { id: string } }>(
      await stack.kernel(
        '/v1/subjects',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
          body: JSON.stringify({
            type,
            labels: { en: label },
            statements: {
              'schema:datePublished': [cited('schema:datePublished', published, citations.date)],
              'schema:inLanguage': [cited('schema:inLanguage', 'en', citations.language)],
              'schema:url': [cited('schema:url', 'https://example.org/catalogue-facts/book', citations.url)],
            },
          }),
        },
        'editor',
      ),
      201,
      'POST /v1/subjects',
    );
    const alice = await auth.signIn('alice');
    if ((await alice.response()).status() !== 200) throw new Error('Alice must sign in through the served Auth forms');

    const current = async (): Promise<CatalogueFactsSubject> => {
      const body = await json<{ subject: CatalogueFactsSubject }>(
        await stack.kernel(`/v1/subjects/${created.subject.id}`),
        200,
        `GET /v1/subjects/${created.subject.id}`,
      );
      if (body.subject.id !== created.subject.id || body.subject.type !== type)
        throw new Error('Public subject identity drifted from the provisioned Type');
      return body.subject;
    };
    const subject = await current();
    if (subject.release !== bundledDigest) throw new Error('Provisioned Book is not pinned to the active release');

    return {
      stack,
      auth,
      alice,
      aliceAccountId: aliceIdentity.accountId,
      digest: bundledDigest,
      type,
      label,
      path: `${subjectHref({ id: created.subject.id, label }, 'en').href}/edit`,
      identifiersPath: `${subjectHref({ id: created.subject.id, label }, 'en').href}/identifiers`,
      published,
      language: 'en',
      url: 'https://example.org/catalogue-facts/book',
      citations,
      current,
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
