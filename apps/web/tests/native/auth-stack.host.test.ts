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
    const bob = await auth.signIn('bob');
    expect(alice.visitedUrls.some((url) => new URL(url).pathname === '/consent')).toBe(false);
    expect(bob.visitedUrls.some((url) => new URL(url).pathname === '/consent')).toBe(false);
    expect(alice.url).toStartWith(stack.web);
    expect((await alice.response()).status()).toBe(200);
    expect(bob.url).toStartWith(stack.web);
    expect((await bob.response()).status()).toBe(200);
    const context = await auth.context('alice');
    expect(context).toBe(alice.context);
    expect(context).not.toBe(await auth.context('bob'));
    expect((await context.cookies(stack.web)).some(({ name }) => name === '__Host-rezics_session')).toBe(true);
    expect(await (await auth.context('bob')).cookies(stack.web)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: '__Host-rezics_session' })]),
    );
  }, 180_000);

  test('signs up a newcomer through the served sign-up form and preserves a web destination', async () => {
    const stack = await startNativeWebStack();
    stacks.push(stack);
    const auth = await startAuthStack(stack);
    authStacks.push(auth);

    const newcomer = await auth.signUp('newcomer');
    expect(newcomer.url).toStartWith(stack.web);
    expect((await newcomer.response()).status()).toBe(200);
    expect((await (await auth.context('newcomer')).cookies(stack.web)).some(({ name }) => name === '__Host-rezics_session')).toBe(
      true,
    );
  }, 180_000);

  test('uses only browser cookies and refuses the suspended native persona without a session', async () => {
    const stack = await startNativeWebStack();
    stacks.push(stack);
    const auth = await startAuthStack(stack);
    authStacks.push(auth);

    const alice = await auth.signIn('alice');
    expect((await alice.requestHeaders()).every((headers) => !headers.has('authorization'))).toBe(true);
    expect((await (await auth.context('alice')).cookies(stack.web)).some(({ name }) => name === '__Host-rezics_session')).toBe(
      true,
    );
    expect((await alice.response()).status()).toBe(200);

    const suspended = await auth.signIn('suspended');
    expect((await suspended.response()).status()).toBe(403);
    expect(await (await suspended.response()).text()).toContain('account_suspended');
    expect((await (await auth.context('suspended')).cookies(stack.web)).some(({ name }) => name === '__Host-rezics_session')).toBe(
      false,
    );
  }, 180_000);

  test('stop closes contexts and Auth while leaving the native stack available to stop itself', async () => {
    const stack = await startNativeWebStack();
    stacks.push(stack);
    const auth = await startAuthStack(stack);
    authStacks.push(auth);
    const context = await auth.context('alice');
    await auth.stop();
    authStacks.splice(authStacks.indexOf(auth), 1);
    expect(context.pages()).toHaveLength(0);
    let authStatus = 0;
    try {
      authStatus = (await fetch(`${auth.origin}/login`)).status;
    } catch {}
    expect(authStatus).not.toBe(200);
    expect((await stack.kernel('/v1/definitions/active')).status).toBe(200);
  }, 180_000);
});
