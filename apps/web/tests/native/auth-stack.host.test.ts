import { afterAll, afterEach, describe, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { prepareNativeAuthMessages, startAuthStack } from './auth-stack.ts';
import { sampleNativeMemory } from './native-memory.ts';
import { startNativeWebStack } from './stack.ts';
import {
  NativeTestLifecycle,
  inspectNativeProcessGroup,
  nativeProcessGroupIsGone,
  nativeAfterAll,
  nativeBeforeAll,
  nativeTest,
  type NativeProcessIdentity,
} from './lifecycle.ts';

const stacks: Awaited<ReturnType<typeof startNativeWebStack>>[] = [];
const authStacks: Awaited<ReturnType<typeof startAuthStack>>[] = [];
const lifecycle = new NativeTestLifecycle('native Auth and web stack suite');
const controlPath = resolve(import.meta.dir, '../../../../.temp/native-auth-page-lifetime/control.json');
async function writeControl(control: Record<string, unknown>) {
  await mkdir(dirname(controlPath), { recursive: true, mode: 0o700 });
  await writeFile(controlPath + '.pending', JSON.stringify(control, null, 2) + '\n', { mode: 0o600 });
  await rename(controlPath + '.pending', controlPath);
}

// Kernel creation and the first Worker compilation are suite fixtures. Reuse
// their owned stack while each Auth app/browser gets fresh cookies and cleanup.
nativeBeforeAll(lifecycle, 300_000, async () => {
  await writeControl({ outcome: 'incomplete', phase: 'setup' });
  await prepareNativeAuthMessages();
  stacks.push(await startNativeWebStack());
  // Native setup includes its own 150s Worker startup budget plus database
  // migration and SQL compilation. Browser journey deadlines remain below.
});

afterEach(async () => {
  for (const auth of authStacks.splice(0).reverse()) await auth.stop();
}, 180_000);

afterAll(async () => {
  for (const stack of stacks.splice(0).reverse()) await stack.stop();
}, 180_000);
nativeAfterAll(lifecycle, 180_000);

function pageAppMemory(identity: NativeProcessIdentity) {
  const group = inspectNativeProcessGroup(identity);
  if (group.status !== 'observed') throw new Error(group.detail);
  const bytes = (name: string) =>
    group.identities.reduce((total, { pid }) => {
      const memory = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
      const value = memory.match(new RegExp(`^${name}:\\s+(\\d+)`, 'mu'))?.[1];
      if (value === undefined) throw new Error(`Missing ${name} for native Auth page process ${pid}`);
      return total + Number(value) * 1024;
    }, 0);
  return { processes: group.identities.length, pssBytes: bytes('Pss'), privateDirtyBytes: bytes('Private_Dirty') };
}

async function groupExited(identity: NativeProcessIdentity) {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    if (nativeProcessGroupIsGone(identity)) return true;
    await Bun.sleep(25);
  }
  return nativeProcessGroupIsGone(identity);
}

describe('native Auth and web stack', () => {
  nativeTest(
    'serves production Auth and signs native personas into the Worker session store',
    180_000,
    async () => {
      const stack = stacks[0]!;
      const auth = await startAuthStack(stack, { preparedMessages: true, useHeadlessShell: true });
      authStacks.push(auth);

      const authPage = await fetch(`${auth.origin}/login`);
      expect(authPage.status).toBe(200);
      expect(await authPage.text()).toContain('Sign in');
      const discovery = (await (await fetch(`${auth.origin}/.well-known/openid-configuration`)).json()) as {
        issuer: string;
      };
      expect(discovery.issuer).toBe(auth.origin);

      const alice = await auth.signIn('alice');
      const firstApp = auth.pageAppProcess()!;
      expect(firstApp).toBeDefined();
      const before = pageAppMemory(firstApp);
      expect(before.processes).toBeGreaterThan(0);
      expect(before.pssBytes).toBeGreaterThan(0);
      const commandBefore = sampleNativeMemory([{ role: 'fixture-host', pid: process.pid }]).cgroup.command;
      const alicePage = alice.continueOnPage();
      await auth.settlePageApp();
      expect(await groupExited(firstApp)).toBe(true);
      expect(auth.pageAppProcess()).toBeUndefined();
      expect(alicePage.isClosed()).toBe(false);
      const after = pageAppMemory(firstApp);
      const commandAfter = sampleNativeMemory([{ role: 'fixture-host', pid: process.pid }]).cgroup.command;
      expect(after).toEqual({ processes: 0, pssBytes: 0, privateDirtyBytes: 0 });
      const idleSession = await alice.context.request.get(`${auth.origin}/session`);
      expect(idleSession.status()).toBe(200);
      expect((await idleSession.json()).account_id).toBe((await stack.authPersona('alice')).accountId);
      await writeControl({ outcome: 'incomplete', phase: 'alice-retired', before, after, commandBefore, commandAfter });
      const resumedPage = await fetch(`${auth.origin}/login`, { headers: { accept: 'text/html' } });
      expect(resumedPage.status).toBe(200);
      // The issuer's fallback login is plain text and also contains "Sign in".
      expect(resumedPage.headers.get('content-type')).toContain('text/html');
      expect(await resumedPage.text()).toContain('Sign in');
      await auth.settlePageApp();
      expect(auth.pageAppProcess()).toBeUndefined();
      const bob = await auth.signIn('bob');
      const secondApp = auth.pageAppProcess()!;
      expect(secondApp).toBeDefined();
      expect(secondApp).not.toEqual(firstApp);
      const bobPage = bob.continueOnPage();
      await auth.settlePageApp();
      expect(await groupExited(secondApp)).toBe(true);
      expect(alicePage.isClosed()).toBe(false);
      expect(bobPage.isClosed()).toBe(false);
      expect(alice.visitedUrls.some((url) => new URL(url).pathname === '/consent')).toBe(false);
      expect(bob.visitedUrls.some((url) => new URL(url).pathname === '/consent')).toBe(false);
      expect(alice.url).toStartWith(stack.web);
      expect((await alice.response()).status()).toBe(200);
      expect(bob.url).toStartWith(stack.web);
      expect((await bob.response()).status()).toBe(200);
      for (const journey of [alice, bob]) {
        const page = journey.context.pages().at(-1)!;
        await page.locator('#account-menu-button').waitFor({ state: 'visible' });
        await page.locator('#account-menu-button').click();
        expect(await page.getByRole('button', { name: 'Sign out', exact: true }).isVisible()).toBe(true);
      }
      const aliceSession = await alice.context.request.get(`${auth.origin}/session`);
      const bobSession = await bob.context.request.get(`${auth.origin}/session`);
      expect(aliceSession.status()).toBe(200);
      expect(bobSession.status()).toBe(200);
      const aliceActor = (await aliceSession.json()).account_id;
      const bobActor = (await bobSession.json()).account_id;
      expect(aliceActor).toBe((await stack.authPersona('alice')).accountId);
      expect(bobActor).toBe((await stack.authPersona('bob')).accountId);
      expect(aliceActor).not.toBe(bobActor);
      const context = await auth.context('alice');
      expect(context).toBe(alice.context);
      expect(context).not.toBe(await auth.context('bob'));
      expect((await context.cookies(stack.web)).some(({ name }) => name === '__Host-rezics_session')).toBe(true);
      expect(await (await auth.context('bob')).cookies(stack.web)).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: '__Host-rezics_session' })]),
      );
      const control = {
        outcome: 'passed',
        before,
        after,
        commandBefore,
        commandAfter,
        retainedPages: [alicePage, bobPage].map((page) => ({
          closed: page.isClosed(),
          origin: new URL(page.url()).origin,
        })),
        issuer: discovery.issuer,
        aliceActor,
        bobActor,
      };
      await writeControl(control);
      console.info('native-auth-page-lifetime', JSON.stringify(control));
    },
    lifecycle,
  );

  nativeTest(
    'signs up a newcomer through the served sign-up form and preserves a web destination',
    180_000,
    async () => {
      const stack = stacks[0]!;
      const auth = await startAuthStack(stack);
      authStacks.push(auth);

      const newcomer = await auth.signUp('newcomer');
      expect(newcomer.url).toStartWith(stack.web);
      expect(newcomer.visitedUrls.some((url) => new URL(url).pathname === '/signup')).toBe(true);
      expect(newcomer.visitedUrls.some((url) => new URL(url).pathname === '/consent')).toBe(false);
      await newcomer.context.pages().at(-1)!.locator('#account-menu-button').waitFor({ state: 'visible' });
      expect((await newcomer.response()).status()).toBe(200);
      expect(
        (await (await auth.context('newcomer')).cookies(stack.web)).some(
          ({ name }) => name === '__Host-rezics_session',
        ),
      ).toBe(true);
    },
    lifecycle,
  );

  nativeTest(
    'uses only browser cookies and refuses the suspended native persona without a session',
    180_000,
    async () => {
      const stack = stacks[0]!;
      const auth = await startAuthStack(stack);
      authStacks.push(auth);

      const alice = await auth.signIn('alice');
      expect((await alice.requestHeaders()).every((headers) => !headers.has('authorization'))).toBe(true);
      expect(
        (await (await auth.context('alice')).cookies(stack.web)).some(({ name }) => name === '__Host-rezics_session'),
      ).toBe(true);
      expect((await alice.response()).status()).toBe(200);

      const suspendedIdentity = await stack.authPersona('suspended');
      const revoked = await fetch(`${stack.kernelOrigin}/v1/libraryEntries`, {
        headers: { authorization: suspendedIdentity.authorization },
      });
      expect(revoked.status).toBe(401);
      expect(revoked.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
      expect(await revoked.text()).toContain('invalid_credentials');
      const suspended = await auth.signIn('suspended');
      expect((await suspended.response()).status()).toBe(403);
      expect(await (await suspended.response()).text()).toContain('account_suspended');
      expect((await suspended.response()).headers()['set-cookie']).toBeUndefined();
      expect((await suspended.context.request.get(`${auth.origin}/session`)).status()).toBe(401);
      expect(suspended.visitedUrls.some((url) => url.startsWith(`${stack.web}/auth/callback`))).toBe(false);
      expect(
        (await (await auth.context('suspended')).cookies(stack.web)).some(
          ({ name }) => name === '__Host-rezics_session',
        ),
      ).toBe(false);
    },
    lifecycle,
  );

  nativeTest(
    'stop closes contexts and Auth while leaving the native stack available to stop itself',
    180_000,
    async () => {
      const stack = stacks[0]!;
      const nativeLogin = await fetch(`${stack.issuerOrigin}/login`);
      const nativeLoginBody = await nativeLogin.text();
      const auth = await startAuthStack(stack);
      authStacks.push(auth);
      const [context, sameContext] = await Promise.all([auth.context('alice'), auth.context('alice')]);
      expect(context).toBe(sameContext);
      const alicePage = await context.newPage();
      const bobContext = await auth.context('bob');
      const bobPage = await bobContext.newPage();
      await auth.stop();
      authStacks.splice(authStacks.indexOf(auth), 1);
      expect(context.pages()).toHaveLength(0);
      expect(bobContext.pages()).toHaveLength(0);
      expect(alicePage.isClosed()).toBe(true);
      expect(bobPage.isClosed()).toBe(true);
      const restoredLogin = await fetch(`${auth.origin}/login`);
      expect(restoredLogin.status).toBe(nativeLogin.status);
      expect(await restoredLogin.text()).toBe(nativeLoginBody);
      expect((await stack.kernel('/v1/definitions/active')).status).toBe(200);
    },
    lifecycle,
  );
});

// The routing addition remains opt-in and never replaces issuer responses.
nativeTest(
  'routes Auth pages and assets at the issuer and restores the original listener',
  180_000,
  async () => {
    const stack = stacks[0]!;
    const issuer = stack.issuerOrigin;
    const original = await fetch(`${issuer}/login`);
    expect(original.status).toBe(200);
    const originalBody = await original.text();
    expect(originalBody).toContain('Sign in at /signin');
    const visited: string[] = [];
    const routed = await stack.routeAuthPages((request) => {
      visited.push(request.url);
      return new Response(request.method === 'HEAD' ? null : 'page handler', {
        status: 203,
        headers: { 'x-page-handler': 'kept' },
      });
    });
    expect(routed).toBe(issuer);
    for (const path of [
      '/login?kept=yes',
      '/signup',
      '/consent',
      '/recovery',
      '/security',
      '/step-up',
      '/auth-assets/example.js',
    ]) {
      const response = await fetch(`${issuer}${path}`);
      expect(response.status).toBe(203);
      expect(response.headers.get('x-page-handler')).toBe('kept');
      expect(await response.text()).toBe('page handler');
      expect(visited.at(-1)).toBe(`${issuer}${path}`);
    }
    expect((await fetch(`${issuer}/login`, { method: 'HEAD' })).status).toBe(203);
    const pageCalls = visited.length;
    expect((await fetch(`${issuer}/.well-known/openid-configuration`)).status).toBe(200);
    const signup = await fetch(`${issuer}/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: issuer },
      body: '{}',
    });
    expect(signup.status).toBe(400);
    expect(await signup.json()).toEqual({ error: 'registration_denied' });
    expect(visited.length).toBe(pageCalls);
    await stack.routeAuthPages();
    const restored = await fetch(`${issuer}/login`);
    expect(restored.status).toBe(original.status);
    expect(await restored.text()).toBe(originalBody);
    expect((await stack.kernel('/v1/definitions/active')).status).toBe(200);
  },
  lifecycle,
);
