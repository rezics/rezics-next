import { afterEach, describe, expect, test } from 'bun:test';
import { startAuthStack } from './auth-stack.ts';
import { startNativeWebStack } from './stack.ts';

const stacks: Awaited<ReturnType<typeof startNativeWebStack>>[] = [];
const authStacks: Awaited<ReturnType<typeof startAuthStack>>[] = [];

afterEach(async () => {
  for (const auth of authStacks.splice(0).reverse()) await auth.stop();
  for (const stack of stacks.splice(0).reverse()) await stack.stop();
}, 180_000);

describe('native Auth and web stack', () => {
  test('serves production Auth and signs native personas into the Worker session store', async () => {
    const stack = await startNativeWebStack();
    stacks.push(stack);
    const auth = await startAuthStack(stack);
    authStacks.push(auth);

    const authPage = await fetch(`${auth.origin}/login`);
    expect(authPage.status).toBe(200);
    expect(await authPage.text()).toContain('Sign in');

    const alice = await auth.signIn('alice');
    expect(alice.url).toStartWith(stack.web);
    expect((await alice.response()).status()).toBe(200);
    const context = auth.context('alice');
    expect(context).toBe(alice.context);
    const cookies = await context.cookies(stack.web);
    expect(cookies.some(({ name }) => name === '__Host-rezics_session')).toBe(true);
    expect(stack.kernelRequests().some(({ authorization }) => authorization?.startsWith('Bearer '))).toBe(true);
  });

  test('signs up a newcomer through the served sign-up form and preserves a web destination', async () => {
    const stack = await startNativeWebStack();
    stacks.push(stack);
    const auth = await startAuthStack(stack);
    authStacks.push(auth);

    const newcomer = await auth.signUp('newcomer');
    expect(newcomer.url).toStartWith(stack.web);
    expect((await newcomer.response()).status()).toBe(200);
    expect((await auth.context('newcomer').cookies(stack.web)).some(({ name }) => name === '__Host-rezics_session')).toBe(
      true,
    );
  });

  test('uses only browser cookies and refuses the suspended native persona without a session', async () => {
    const stack = await startNativeWebStack();
    stacks.push(stack);
    const auth = await startAuthStack(stack);
    authStacks.push(auth);

    const alice = await auth.signIn('alice');
    const aliceRequests = stack.kernelRequests();
    expect(aliceRequests.every(({ authorization }) => authorization === null)).toBe(true);
    expect((await auth.context('alice').cookies(stack.web)).some(({ name }) => name === '__Host-rezics_session')).toBe(
      true,
    );
    expect((await alice.response()).status()).toBe(200);

    const suspended = await auth.signIn('suspended');
    expect((await suspended.response()).status()).toBe(403);
    expect((await suspended.response()).text()).toContain('ACCOUNT_SUSPENDED');
    expect((await auth.context('suspended').cookies(stack.web)).some(({ name }) => name === '__Host-rezics_session')).toBe(
      false,
    );
  });

  test('stop closes contexts and Auth while leaving the native stack available to stop itself', async () => {
    const stack = await startNativeWebStack();
    stacks.push(stack);
    const auth = await startAuthStack(stack);
    authStacks.push(auth);
    const context = auth.context('alice');
    await auth.stop();
    authStacks.splice(authStacks.indexOf(auth), 1);
    expect(context.pages()).toHaveLength(0);
    expect((await stack.kernel('/v1/definitions/active')).status).toBe(200);
  });
});
