import type { Page, Response as PlaywrightResponse } from 'playwright';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

export type NativeAgentIdentityFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  aliceId: string;
  aliceEmail: string;
  bobId: string;
  bobEmail: string;
  governorId: string;
  governorEmail: string;
  alice: Page;
  bob: Page;
  governor: Page;
  anonymous: Page;
  createAutomatedActor(operator: 'alice' | 'bob', handle: string): Promise<{ accountId: string }>;
  close(): Promise<void>;
};

function pageFor(auth: NativeAuthStack, persona: 'alice' | 'bob' | 'governor' | 'anonymous'): Promise<Page> {
  return auth.context(persona).then(async (context) => {
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(20_000);
    return page;
  });
}

async function postKernel(stack: NativeWebStack, path: string, body: unknown, persona: string): Promise<Response> {
  return stack.kernel(
    path,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
      },
      body: JSON.stringify(body),
    },
    persona,
  );
}

async function requireStatus(response: Response, status: number, operation: string): Promise<unknown> {
  const body = await response.text();
  if (response.status !== status)
    throw new Error(`Native identity fixture ${operation} returned ${response.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

export async function createNativeAgentIdentityFixture(): Promise<NativeAgentIdentityFixture> {
  const stack = await startNativeWebStack();
  let auth: NativeAuthStack | undefined;
  try {
    auth = await startAuthStack(stack);
    await auth.signIn('alice');
    await auth.signIn('bob');
    await auth.signIn('governor');
    await stack.enableAccountOperations();
    const aliceIdentity = await stack.authPersona('alice');
    const bobIdentity = await stack.authPersona('bob');
    const governorIdentity = await stack.authPersona('governor');

    const openOrganizations = await postKernel(stack, '/v1/platform/exposure/organizations:open', {}, 'governor');
    await requireStatus(openOrganizations, 200, 'open organization operations');
    const openVerification = await postKernel(stack, '/v1/platform/exposure/agent_verification:open', {}, 'governor');
    await requireStatus(openVerification, 200, 'open agent verification');

    const globalContext = '00000000-0000-8000-8000-000000000000';
    const grant = await postKernel(
      stack,
      '/v1/grants',
      {
        resource: { route: 0, id: globalContext },
        subject: { kind: 'account', id: aliceIdentity.accountId },
        actions: ['subject:create'],
        valid: '(,)',
      },
      'governor',
    );
    await requireStatus(grant, 201, 'grant Alice catalogue creation');

    const anonymous = await pageFor(auth, 'anonymous');
    return {
      stack,
      auth,
      aliceId: aliceIdentity.accountId,
      aliceEmail: aliceIdentity.email,
      bobId: bobIdentity.accountId,
      bobEmail: bobIdentity.email,
      governorId: governorIdentity.accountId,
      governorEmail: governorIdentity.email,
      alice: await pageFor(auth, 'alice'),
      bob: await pageFor(auth, 'bob'),
      governor: await pageFor(auth, 'governor'),
      anonymous,
      async createAutomatedActor(operator, handle) {
        const cookies = await (await auth!.context(operator)).cookies(stack.issuerOrigin);
        const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
        if (!cookie) throw new Error(`Native ${operator} has no served Auth session cookie`);
        return stack.createAutomatedActor(operator, handle, cookie);
      },
      async close() {
        await auth!.stop();
        await stack.stop();
      },
    };
  } catch (error) {
    await auth?.stop().catch(() => {});
    await stack.stop().catch(() => {});
    throw error;
  }
}

export async function settledPage(page: Page, url: string): Promise<PlaywrightResponse | null> {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  return response;
}

export async function submitAccountOperation(
  page: Page,
  issuerOrigin: string,
  operation: Record<string, unknown>,
): Promise<{ approval: { status: number; body: unknown }; execution?: { status: number; body: unknown } }> {
  await page.goto(`${issuerOrigin}/security`, { waitUntil: 'domcontentloaded' });
  return page.evaluate(
    async ({ operation, operationKey }) => {
      const request = async (path: string, body: unknown) => {
        const response = await fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      };
      const approval = await request('/account-operations/approve', { operationKey, operation });
      if (approval.status !== 200) return { approval };
      const reference =
        approval.body && typeof approval.body === 'object' && 'reference' in approval.body
          ? approval.body.reference
          : null;
      const execution = await request('/account-operations/execute', { operationKey, operation, reference });
      return { approval, execution };
    },
    { operation, operationKey: crypto.randomUUID() },
  );
}
