import { existsSync, readlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { expect } from 'bun:test';
import { resolve } from 'node:path';
import {
  currentNativeLifecycle,
  inspectNativeProcess,
  inspectNativeProcessGroup,
  nativeProcessGroupIsGone,
  nativeProcessIsSame,
  nativeTest,
  processGroupObservationIsGone,
  settledWithin,
  type NativeProcessIdentity,
  type ProcessGroupObservation,
} from './native/lifecycle.ts';

const worktreeRoot = resolve(import.meta.dir, '../../..');
const injectionRunner = resolve(import.meta.dir, 'native/lifecycle-injection.ts');

type LifecycleReceipt = {
  listenerPort: number;
  devServerPort?: number;
  bridgeDirectory?: string;
  devServer?: NativeProcessIdentity;
  browser?: NativeProcessIdentity;
  browserNetworkNamespace?: string;
  resistantLeader?: NativeProcessIdentity;
  resistantDescendant?: NativeProcessIdentity;
  browserGroup?: ProcessGroupObservation;
  devServerGroup?: ProcessGroupObservation;
  resistantGroup?: ProcessGroupObservation;
  child?: NativeProcessIdentity;
  childGroup?: ProcessGroupObservation;
  pageVisited?: boolean;
  receivedTimeout?: boolean;
  expectedFailure?: boolean;
};

async function eventuallyGone(identity: NativeProcessIdentity | undefined, timeoutMs = 3_000): Promise<boolean> {
  if (!identity) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!nativeProcessIsSame(identity)) return true;
    await Bun.sleep(25);
  }
  return !nativeProcessIsSame(identity);
}

async function eventuallyGroupGone(identity: NativeProcessIdentity | undefined, timeoutMs = 3_000): Promise<boolean> {
  if (!identity) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (nativeProcessGroupIsGone(identity)) return true;
    await Bun.sleep(25);
  }
  return nativeProcessGroupIsGone(identity);
}

function receipt(output: string, name: string): LifecycleReceipt {
  const line = output.split('\n').find((entry) => entry.startsWith(`${name} `));
  if (!line) throw new Error(`Native lifecycle injection did not report ${name}`);
  return JSON.parse(line.slice(name.length + 1)) as LifecycleReceipt;
}

async function listenerIsClosed(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    await response.body?.cancel();
    return false;
  } catch {
    return true;
  }
}

nativeTest(
  'native lifecycle bounds a real browser timeout and partial setup failure without affecting a live sibling',
  45_000,
  async () => {
    const startedAt = performance.now();
    const lifecycle = currentNativeLifecycle();
    if (!lifecycle) throw new Error('Native lifecycle acceptance is missing its supervisor scope');
    expect(
      processGroupObservationIsGone({ status: 'unavailable', detail: 'ps could not observe the owned session' }),
    ).toBe(false);
    const hostNetworkNamespace = readlinkSync('/proc/self/ns/net');
    let siblingState = 0;
    const sibling = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(`live sibling ${++siblingState}`),
    });
    lifecycle.register({
      label: 'independent live sibling listener',
      close: () => sibling.stop(true),
      force: () => sibling.stop(true),
    });
    expect(await (await fetch(sibling.url)).text()).toBe('live sibling 1');

    const runner = spawn(process.execPath, [injectionRunner], {
      cwd: worktreeRoot,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const runnerOwner = lifecycle.ownProcessGroup('supervised native lifecycle injection command', runner);
    let output = '';
    let errorOutput = '';
    runner.stdout?.on('data', (chunk: Buffer) => (output = (output + chunk.toString()).slice(-32_000)));
    runner.stderr?.on('data', (chunk: Buffer) => (errorOutput = (errorOutput + chunk.toString()).slice(-8_000)));
    const result = await settledWithin(
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) =>
        runner.once('exit', (code, signal) => resolveExit({ code, signal })),
      ),
      28_000,
    );
    if (!result) {
      await runnerOwner.force();
      throw new Error(
        `Native lifecycle injection command exceeded 28000ms; stdout: ${output.slice(-3_000)}; stderr: ${errorOutput}`,
      );
    }
    await runnerOwner.close();
    runnerOwner.release();

    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
    const timedOut = receipt(output, 'NATIVE_TIMEOUT_READY');
    const timedOutCleanup = receipt(output, 'NATIVE_TIMEOUT_CLEANED');
    const partial = receipt(output, 'NATIVE_PARTIAL_READY');
    const partialCleanup = receipt(output, 'NATIVE_PARTIAL_CLEANED');
    expect(timedOut.pageVisited).toBe(true);
    expect(timedOut.browserNetworkNamespace).toBeDefined();
    expect(timedOut.browserNetworkNamespace).not.toBe(hostNetworkNamespace);
    expect(timedOut.browser?.sid).toBe(timedOut.browser?.pgid);
    expect(timedOut.devServer?.sid).toBe(timedOut.devServer?.pgid);
    expect(timedOut.resistantLeader?.sid).toBe(timedOut.resistantLeader?.pgid);
    expect(timedOut.resistantDescendant?.sid).toBe(timedOut.resistantLeader?.sid);
    expect(partial.child?.sid).toBe(partial.child?.pgid);
    expect(timedOutCleanup.browserNetworkNamespace).toBe(timedOut.browserNetworkNamespace);
    expect(timedOutCleanup.receivedTimeout).toBe(true);
    expect(partialCleanup.expectedFailure).toBe(true);
    expect(timedOut.listenerPort).toBe(timedOutCleanup.listenerPort);
    expect(timedOut.devServerPort).toBe(timedOutCleanup.devServerPort);
    expect(timedOut.devServer).toEqual(timedOutCleanup.devServer);
    expect(timedOut.bridgeDirectory).toBe(timedOutCleanup.bridgeDirectory);
    expect(timedOut.browser).toEqual(timedOutCleanup.browser);
    expect(timedOut.resistantLeader).toEqual(timedOutCleanup.resistantLeader);
    expect(timedOut.resistantDescendant).toEqual(timedOutCleanup.resistantDescendant);
    expect(partial.listenerPort).toBe(partialCleanup.listenerPort);
    expect(partial.child).toEqual(partialCleanup.child);
    expect(existsSync(timedOut.bridgeDirectory!)).toBe(false);
    expect(await listenerIsClosed(timedOut.listenerPort)).toBe(true);
    expect(await listenerIsClosed(timedOut.devServerPort!)).toBe(true);
    expect(await listenerIsClosed(partial.listenerPort)).toBe(true);
    expect(await eventuallyGone(timedOut.browser)).toBe(true);
    const browserGroupGone = await eventuallyGroupGone(timedOut.browser);
    if (!browserGroupGone)
      throw new Error(
        `Owned browser process group remained: ${JSON.stringify(inspectNativeProcessGroup(timedOut.browser!))}`,
      );
    expect(browserGroupGone).toBe(true);
    expect(await eventuallyGone(timedOut.devServer)).toBe(true);
    const devServerGroupGone = await eventuallyGroupGone(timedOut.devServer);
    if (!devServerGroupGone)
      throw new Error(
        `Owned dev server process group remained: ${JSON.stringify(inspectNativeProcessGroup(timedOut.devServer!))}`,
      );
    expect(devServerGroupGone).toBe(true);
    expect(await eventuallyGone(timedOut.resistantLeader)).toBe(true);
    expect(await eventuallyGone(timedOut.resistantDescendant)).toBe(true);
    expect(await eventuallyGone(partial.child)).toBe(true);
    expect(await (await fetch(sibling.url)).text()).toBe('live sibling 2');
    expect(await (await fetch(sibling.url)).text()).toBe('live sibling 3');
    expect(performance.now() - startedAt).toBeLessThan(28_000);
  },
  undefined,
  { cleanupGraceMs: 2_000, forceGraceMs: 3_000 },
);

// Account lifecycle presentation/transport fixtures. These do not start a native stack.
// Kept unrun in this slice; the controller owns the deferred acceptance campaign.
import { test as accountLifecycleFixture } from 'bun:test';

accountLifecycleFixture(
  'Existing lifecycle command security and uncertainty semantics preserved; human review and exact technical details remain accessible',
  async () => {
    const { createKernelClient } = await import('@rezics/client');
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { AccountLifecyclePage } = await import('../src/accounts/lifecycle-controls/page');
    const { commandLifecycle, loadLifecycle, parseIntent } = await import('../src/accounts/lifecycle-controls/data');
    const { m } = await import('../src/paraglide/messages.js');
    const account = {
      id: '01a1a000-0000-7000-8000-000000000101',
      kind: 'actor' as const,
      displayName: 'Avery Reader',
      handle: 'avery',
    };
    for (const identity of [
      account,
      { ...account, displayName: null },
      { ...account, displayName: null, handle: null },
    ]) {
      const initial = {
        status: 'ready' as const,
        account: identity,
        offered: [],
        currentState: 'unavailable' as const,
      };
      const html = renderToStaticMarkup(
        createElement(AccountLifecyclePage, {
          initial,
          io: {
            read: async () => initial,
            change: async () => {
              throw new Error('Rendering cannot send a lifecycle request');
            },
          },
        }),
      );
      const label = identity.displayName || (identity.handle ? `@${identity.handle}` : m.lifecycle_unnamed_account());
      expect(html).toContain(label);
      expect(html.indexOf(label)).toBeLessThan(html.indexOf(account.id));
      expect(html).toMatch(new RegExp(`<details>[\\s\\S]*?${account.id}[\\s\\S]*?</details>`));
      expect(html).toContain(m.lifecycle_account_id());
      expect(html).toContain(m.lifecycle_state_unavailable());
      expect(html).toContain(m.lifecycle_capability_unavailable());
      expect(html).toContain(m.lifecycle_technical_details());
      expect(html).toContain(m.lifecycle_protocol_help());
      expect(html).toContain(m.lifecycle_availability_help());
    }

    const reason = '  Exact private reason\nKeep whitespace.  ';
    const intent = parseIntent({ accountId: account.id, action: 'suspend', key: crypto.randomUUID(), reason });
    expect(Object.isFrozen(intent)).toBe(true);
    expect(() => parseIntent({ ...intent, identity: account })).toThrow();
    expect(() => parseIntent({ ...intent, reason: 'x'.repeat(2001) })).toThrow();
    let advertised = true;
    let denied = false;
    let readFailure = false;
    let failAfterCommand = false;
    let response: 'recorded' | 'not_applied' | 'unknown' | 'lost' = 'recorded';
    let recorded = false;
    let activeIntent = intent;
    let effectState: 'unknown' | 'pending' = 'unknown';
    const receiptId = '01a1a000-0000-7000-8000-000000000102';
    const effects: Request[] = [];
    const reads: Request[] = [];
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        expect(new URL(request.url).search).toBe('');
        if (path === '/v1/viewerActions')
          throw new Error('Generic public viewerActions cannot authorize private lifecycle commands');
        expect(path).not.toContain('/management');
        if (path === `/v1/accounts/${account.id}/lifecycleReview`) {
          reads.push(request);
          expect(request.method).toBe('POST');
          expect(request.headers.get('cache-control')).toBe('no-store');
          expect(request.headers.get('idempotency-key')).toBeNull();
          expect(request.headers.get('x-csrf-token')).toBeNull(); // Healthy authenticated read needs no CSRF credential.
          if (denied) return Response.json({ code: 'not_found' }, { status: 404 });
          if (readFailure) return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
          const body = await request.json();
          const original = body.original;
          const matches =
            original?.operationId === 'account.suspend' &&
            original.key === activeIntent.key &&
            original.reason === activeIntent.reason &&
            request.headers.get('authorization') === 'Bearer fixture-only';
          if (original && matches)
            expect(original).toEqual({ operationId: 'account.suspend', key: activeIntent.key, reason });
          return Response.json(
            {
              account,
              current: {
                state: recorded ? 'suspended' : 'active',
                minimumAuthnEpoch: recorded ? '2' : '1',
                fenced: recorded,
              },
              actions: recorded
                ? []
                : [{ action: 'account:suspend', operationId: advertised ? 'account.suspend' : 'account.reinstate' }],
              ...(original
                ? {
                    original:
                      recorded && matches
                        ? {
                            status: 'recorded',
                            receiptId,
                            effects: {
                              state: effectState,
                              operator: effectState,
                              sessionRevocation: 'unknown',
                              accountAgentSynchronization: 'unknown',
                              sessionRevocationAuthorization: 'unknown',
                              inspectedPages: 0,
                              terminalSubjects: 0,
                            },
                          }
                        : { status: 'unknown' },
                  }
                : {}),
            },
            { headers: { 'cache-control': 'private, no-store' } },
          );
        }
        expect(request.headers.get('authorization')).toBe('Bearer fixture-only');
        expect(path).toBe(`/v1/accounts/${account.id}:suspend`);
        expect(request.headers.get('idempotency-key')).toBe(activeIntent.key);
        expect(await request.clone().json()).toEqual({ reason });
        effects.push(request);
        if (response === 'unknown' || response === 'not_applied')
          return Response.json(
            { code: 'conflict', ...(response === 'not_applied' ? { effect_status: 'not_applied' } : {}) },
            { status: 409 },
          );
        recorded = true;
        if (failAfterCommand) readFailure = true;
        if (response === 'lost') throw new Error('Native response lost after commit');
        return Response.json({
          suspension: { accountId: account.id, state: 'suspended', minimumAuthnEpoch: '2', receiptId },
        });
      }) as typeof fetch,
    });
    const { prepareSession, viewerCredential, requestCsrfToken } = await import('../src/session/request');
    const healthyRead = new Request('https://site.example.test/en/platform/accounts/' + account.id, {
      headers: { cookie: '__Host-rezics_session=' + 'a'.repeat(43) },
    });
    const sessionEnv = {
      AUTH_ISSUER: 'https://auth.example.test',
      API_RESOURCE: 'https://kernel.example.test',
      WEBSITE_SCOPES: 'account:suspend',
      WEBSITE_CLIENT_ID: 'web',
      WEBSITE_CLIENT_KEY: 'fixture-only',
      SESSIONS: {
        idFromName: (id: string) => id,
        get: () => ({
          credential: async () => ({
            status: 'active',
            accessToken: 'fixture-only',
            subject: account.id,
            csrfToken: null,
          }),
        }),
      },
    } as unknown as import('../src/session/client').SessionEnv;
    expect(await prepareSession(healthyRead, sessionEnv)).toBe(false);
    expect(requestCsrfToken(healthyRead)).toBeNull();
    expect(viewerCredential(healthyRead)).toBe('Bearer fixture-only');
    expect(await loadLifecycle(client, viewerCredential(healthyRead)!, account.id)).toMatchObject({ status: 'ready' });
    expect(await loadLifecycle(client, 'Bearer fixture-only', account.id)).toMatchObject({
      currentState: 'active',
      offered: ['suspend'],
    });
    expect(await loadLifecycle(client, '', account.id)).toEqual({ status: 'signed-out' });
    expect((await commandLifecycle(client, '', activeIntent)).status).toBe('signed-out');
    expect(effects).toHaveLength(0);
    expect((await commandLifecycle(client, 'Bearer fixture-only', activeIntent)).status).toBe('recorded');
    expect(effects).toHaveLength(1);
    expect(await loadLifecycle(client, 'Bearer fixture-only', account.id)).toMatchObject({
      currentState: 'suspended',
      offered: [],
    });
    for (const state of ['pending', 'unknown'] as const) {
      effectState = state;
      const replay = await commandLifecycle(client, 'Bearer fixture-only', activeIntent);
      expect(replay).toMatchObject({ status: 'recorded', effects: { state } });
      expect(effects).toHaveLength(1); // Receipt/pending/unknown reads never execute a second effect.
    }
    denied = true;
    expect((await commandLifecycle(client, 'Bearer fixture-only', activeIntent)).status).toBe('missing');
    expect(effects).toHaveLength(1); // Current exact authority is checked before native receipt disclosure.
    denied = false;
    advertised = false;
    recorded = false;
    expect(await loadLifecycle(client, 'Bearer fixture-only', account.id)).toMatchObject({ offered: [] });
    expect((await commandLifecycle(client, 'Bearer fixture-only', activeIntent)).status).toBe('unavailable');
    expect(effects).toHaveLength(1);
    advertised = true;
    response = 'unknown';
    activeIntent = parseIntent({ ...intent, key: crypto.randomUUID() });
    expect((await commandLifecycle(client, 'Bearer fixture-only', activeIntent)).status).toBe('uncertain');
    response = 'not_applied';
    activeIntent = parseIntent({ ...intent, key: crypto.randomUUID() });
    expect((await commandLifecycle(client, 'Bearer fixture-only', activeIntent)).status).toBe('conflict');
    expect(effects).toHaveLength(3);
    response = 'lost';
    activeIntent = parseIntent({ ...intent, key: crypto.randomUUID() });
    expect((await commandLifecycle(client, 'Bearer fixture-only', activeIntent)).status).toBe('recorded');
    expect(effects).toHaveLength(4); // Original-intent readback is read-only, even after response loss.
    for (const wrong of [
      { ...activeIntent, reason: reason.trim() },
      { ...activeIntent, key: crypto.randomUUID() },
    ])
      expect(await loadLifecycle(client, 'Bearer fixture-only', account.id, wrong)).toMatchObject({
        original: { status: 'unknown' },
      });
    expect(await loadLifecycle(client, 'Bearer another-principal', account.id, activeIntent)).toMatchObject({
      original: { status: 'unknown' },
    });
    expect(effects).toHaveLength(4);
    response = 'recorded';
    recorded = false;
    failAfterCommand = true;
    activeIntent = parseIntent({ ...intent, key: crypto.randomUUID() });
    expect(await commandLifecycle(client, 'Bearer fixture-only', activeIntent)).toMatchObject({
      status: 'recorded',
      receiptId,
      current: { status: 'unavailable' },
    });
    expect(effects).toHaveLength(5); // Current read failure never erases a received recorded outcome.
    expect(reads.length).toBeGreaterThan(effects.length);
  },
);
