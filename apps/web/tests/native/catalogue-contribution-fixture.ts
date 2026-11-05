import { subjectHref } from '../../src/subject/subject-href.ts';
import { startAuthStack, type AuthJourney, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';
const globalResource = { route: 0, id: globalContext };
const requestKey = () => JSON.stringify(crypto.randomUUID());

export type CatalogueContributionRecord = {
  subject: string;
  candidate: string;
  payload: string;
  href: string;
  label: string;
};

export type NativeCatalogueContributionFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  alice: AuthJourney;
  bob: AuthJourney;
  aliceId: string;
  bobId: string;
  provision(): Promise<CatalogueContributionRecord>;
  current(subject: string, persona: 'alice' | 'bob'): Promise<unknown>;
  candidates(subject: string, persona: 'alice' | 'bob'): Promise<{ id: string; deleted?: true }[]>;
  close(): Promise<void>;
};

async function expectStatus(response: Response, expected: number, action: string): Promise<string> {
  const text = await response.text();
  if (response.status !== expected)
    throw new Error(`${action}: expected HTTP ${expected}, got ${response.status}: ${text}`);
  return text;
}

async function kernelJson<T>(response: Response, expected: number, action: string): Promise<T> {
  const text = await expectStatus(response, expected, action);
  return JSON.parse(text) as T;
}

function cited(property: string, content: string) {
  return {
    property: { id: property },
    value: { type: 'value', content },
    references: [
      {
        parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/evidence' } }],
      },
    ],
  };
}

async function grant(stack: NativeWebStack, accountId: string, actions: string[]): Promise<void> {
  await expectStatus(
    await stack.kernel(
      '/v1/grants',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': requestKey() },
        body: JSON.stringify({
          resource: globalResource,
          subject: { kind: 'account', id: accountId },
          actions,
          valid: '(,)',
        }),
      },
      'governor',
    ),
    201,
    `Grant ${actions.join(', ')} to ${accountId}`,
  );
}

export async function startCatalogueContributionFixture(): Promise<NativeCatalogueContributionFixture> {
  const stack = await startNativeWebStack();
  let auth: NativeAuthStack | undefined;
  try {
    auth = await startAuthStack(stack);
    const [aliceIdentity, bobIdentity] = await Promise.all([stack.authPersona('alice'), stack.authPersona('bob')]);
    await grant(stack, aliceIdentity.accountId, ['statement:propose', 'statement:delete', 'statement:restore']);
    await grant(stack, bobIdentity.accountId, [
      'subject:create',
      'statement:propose',
      'context:accept',
      'context:adopt',
      'statement:delete',
      'statement:restore',
    ]);
    const [alice, bob] = await Promise.all([auth.signIn('alice'), auth.signIn('bob')]);
    if ((await alice.response()).status() !== 200 || (await bob.response()).status() !== 200)
      throw new Error('Alice and Bob must sign in through the served Auth forms');

    const candidates = async (subject: string, persona: 'alice' | 'bob') => {
      const page = await kernelJson<{ candidates: { id: string; deleted?: true }[] }>(
        await stack.kernel(
          `/v1/subjects/${encodeURIComponent(subject)}/candidates?property=${encodeURIComponent('schema:url')}&context=${globalContext}&limit=20`,
          {},
          persona,
        ),
        200,
        `Read candidates as ${persona}`,
      );
      return page.candidates;
    };

    const current = async (subject: string, persona: 'alice' | 'bob') => {
      const body = await kernelJson<{ subject: unknown }>(
        await stack.kernel(`/v1/subjects/${encodeURIComponent(subject)}`, {}, persona),
        200,
        `Read current subject as ${persona}`,
      );
      return body.subject;
    };

    return {
      stack,
      auth,
      alice,
      bob,
      aliceId: aliceIdentity.accountId,
      bobId: bobIdentity.accountId,
      async provision() {
        const label = `Contribution person ${crypto.randomUUID()}`;
        const created = await kernelJson<{ subject: { id: string } }>(
          await stack.kernel(
            '/v1/subjects',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'idempotency-key': requestKey() },
              body: JSON.stringify({ type: 'schema:Person', labels: { en: label } }),
            },
            'bob',
          ),
          201,
          `Create subject ${label}`,
        );
        const subject = created.subject.id;
        const payload = `https://example.test/contribution/${crypto.randomUUID()}`;
        const proposed = await kernelJson<{ candidate: string }>(
          await stack.kernel(
            `/v1/subjects/${encodeURIComponent(subject)}/candidates`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'idempotency-key': requestKey() },
              body: JSON.stringify({ statement: cited('schema:url', payload) }),
            },
            'alice',
          ),
          201,
          'Propose Alice contribution',
        );
        await expectStatus(
          await stack.kernel(
            `/v1/subjects/${encodeURIComponent(subject)}/candidates/${encodeURIComponent(proposed.candidate)}:accept`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'idempotency-key': requestKey() },
              body: JSON.stringify({ context: globalContext, expected_head: null }),
            },
            'bob',
          ),
          200,
          'Accept Alice contribution',
        );
        await expectStatus(
          await stack.kernel(
            `/v1/subjects/${encodeURIComponent(subject)}:adopt`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'idempotency-key': requestKey() },
              body: JSON.stringify({
                context: globalContext,
                property: 'schema:url',
                mode: 'replace',
                selection: [{ candidate: proposed.candidate, rank: 'normal' }],
                expected_head: null,
              }),
            },
            'bob',
          ),
          200,
          'Adopt Alice contribution',
        );
        return {
          subject,
          candidate: proposed.candidate,
          payload,
          href: subjectHref({ id: subject, label }, 'en').href,
          label,
        };
      },
      current,
      candidates,
      async close() {
        const errors: unknown[] = [];
        try {
          await auth?.stop();
        } catch (error) {
          errors.push(error);
        }
        try {
          await stack.stop();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length) throw new AggregateError(errors, 'Native catalogue contribution fixture cleanup failed');
      },
    };
  } catch (error) {
    await auth?.stop().catch(() => {});
    await stack.stop().catch(() => {});
    throw error;
  }
}
